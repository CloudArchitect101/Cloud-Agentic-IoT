'use strict';

const { createHash, createHmac, randomBytes } = require('node:crypto');
const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');
const { IoTClient, DescribeEndpointCommand } = require('@aws-sdk/client-iot');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  BadRequest, parseBody, respond, isThingName,
} = require('@cloud-agentic-iot/shared/api');
const { requiredEnv, numberEnv } = require('@cloud-agentic-iot/shared/env');

const iotData = new IoTDataPlaneClient({});
const iot = new IoTClient({});
const sts = new STSClient({});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The link and its credentials last 15 minutes, the shortest session STS
// gives. The card asks for a new link every 10 minutes while it is open, so
// the one it holds is always good for its next reconnect.
const LINK_SECONDS = 900;
// What the board accepts in a LIVE command (DeviceTiming.h). The template's
// parameters keep to it too; a value outside it would be refused by every
// board, and the card would wait for readings that never come.
const MAX_LIVE_SECONDS = 60;
const MAX_LIVE_MINUTES = 30;
// AWS IoT refuses a client id longer than 128 bytes; STS a session name
// longer than 64 characters.
const MAX_CLIENT_ID = 128;
const MAX_SESSION_NAME = 64;
// What AWS IoT's MQTT over WebSocket is signed as.
const SIGNING_SERVICE = 'iotdevicegateway';
const ALGORITHM = 'AWS4-HMAC-SHA256';

// The account's IoT data endpoint never changes, so it is asked for once per
// container, as in device-provisioning.
let endpoint = null;

class NoLiveLink extends Error {}

/**
 * The live view of one board, for its card on the Asset in Salesforce.
 *
 *   { thingName, mode: 'start' | 'latest' | 'rearm' }
 *     -> 200 { thingName,
 *              live: { url, clientId, topic, expiresAt, seconds, minutes, commandPublished },
 *              latest: { temperature, humidity, at, heartRate?, spo2? } | null,
 *              state: { patientState, riskScore, updatedAt, temperatureAlert } | null }
 *
 * mode "start", the default, tells the board to send a reading every
 * LIVE_READING_SECONDS for the next LIVE_MINUTES on device/<thing>/live, and
 * returns a link the browser opens to subscribe to that topic itself. So the
 * live readings go from AWS IoT straight to the browser: they never pass
 * through Salesforce (no API calls, no records, no Apex) or through a
 * function, and nothing stores them. The board keeps storing a reading every
 * telemetry interval as before, and goes back to only that when the window
 * ends, so a card that is closed costs nothing once its last window is over.
 * The card sends "start" again every 10 minutes while it is open, which
 * restarts the window and gets it a fresh link.
 *
 * mode "rearm" is sent by Salesforce when it closes a device's temperature
 * alert Case: it stamps RearmRequestedAt on the board's STATE item, and
 * patient-vitals then treats the board's next hot reading as a new crossing
 * (a new Case) instead of waiting hours for its safety repeat. It answers
 * 200 { thingName, rearmed } and touches nothing else; rearmed is false for a
 * board with no STATE yet, which has no episode to end.
 *
 * mode "latest" only reads what is stored: the newest reading and the
 * patient's state, for a card whose browser cannot open the link. Prod keeps
 * no readings in DynamoDB (KeepReadingsInDynamoDB), so there latest is null.
 *
 * The link carries its own credentials: a 15-minute session of
 * LiveViewerRole, narrowed by a session policy to one client id and this
 * board's live topic. Whoever holds it can watch this one board until it
 * expires, and nothing else: not publish, not subscribe to another board, not
 * connect as a board. It is never logged.
 */
exports.handler = async (event) => {
  let body;
  try {
    body = parseBody(event);
  } catch (err) {
    if (err instanceof BadRequest) return respond(400, { error: err.message });
    throw err;
  }
  const { thingName, mode = 'start' } = body || {};
  if (!isThingName(thingName)) {
    // Checked before it goes into a topic, a client id or a policy.
    return respond(400, { error: 'thingName must be an AWS IoT Thing name: letters, digits, : _ and -, up to 128 characters.' });
  }
  if (mode !== 'start' && mode !== 'latest' && mode !== 'rearm') {
    return respond(400, { error: 'mode must be "start" (the default), "latest" or "rearm".' });
  }

  // Read before anything is sent, so a missing setting fails by name and
  // leaves the board as it was.
  const table = requiredEnv('TABLE_NAME');
  if (mode === 'rearm') {
    const rearmed = await rearm(table, thingName);
    console.log('re-arm', { thingName, rearmed });
    return respond(200, { thingName, rearmed });
  }
  const settings = mode === 'start' ? liveSettings() : null;

  // Neither read ever fails the request: each answers null instead.
  const stored = Promise.all([newestReading(table, thingName), patientState(table, thingName)]);
  let live = null;
  try {
    live = settings && await startLive(thingName, settings);
  } catch (err) {
    if (!(err instanceof NoLiveLink)) throw err;
    // Lambda freezes the container once this answers: a read still running
    // would finish, and log, inside the next request.
    await stored;
    return respond(502, { error: err.message });
  }
  const [latest, state] = await stored;

  // The clientId is no credential: connecting needs the link's signature too.
  console.log('live view', {
    thingName,
    mode,
    ...(live && { clientId: live.clientId, commandPublished: live.commandPublished }),
    reading: latest !== null,
    state: state !== null,
  });
  return respond(200, live ? { thingName, live, latest, state } : { thingName, latest, state });
};

/** What mode "start" needs from the template, or the error that names what is wrong. */
function liveSettings() {
  const roleArn = requiredEnv('LIVE_VIEWER_ROLE_ARN');
  const role = roleArn.match(/^arn:([\w-]+):iam::(\d{12}):role\/\S+$/);
  if (!role) {
    throw new Error(`LIVE_VIEWER_ROLE_ARN must be an IAM role ARN, not "${roleArn}". It comes from this function's CloudFormation template.`);
  }
  const region = process.env.AWS_REGION;
  if (!region) {
    throw new Error('AWS_REGION is not set. Lambda sets it; set it yourself to run this function anywhere else.');
  }
  const [, partition, account] = role;
  return {
    roleArn,
    region,
    // The viewer's IoT resources are in this account and Region: the role is
    // in this stack, and the endpoint is the one this function looks up.
    iotArn: `arn:${partition}:iot:${region}:${account}`,
    seconds: boardSetting('LIVE_READING_SECONDS', MAX_LIVE_SECONDS),
    minutes: boardSetting('LIVE_MINUTES', MAX_LIVE_MINUTES),
  };
}

/** A whole number from 1 to max, the range the board accepts, or the error that names it. */
function boardSetting(name, max) {
  const value = numberEnv(name);
  if (!Number.isInteger(value) || value > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}, which is what the board accepts, not "${process.env[name]}".`);
  }
  return value;
}

/**
 * Puts the board in live mode and signs a link to its live topic. Throws
 * NoLiveLink when no link can be made. A command IoT Core did not take only
 * shows in commandPublished: the board may still be live from the card's
 * last request, and the card says so when no reading comes.
 */
async function startLive(thingName, settings) {
  const clientId = clientIdFor(thingName);
  const [commandPublished, credentials, host] = await Promise.all([
    askForLiveReadings(thingName, settings),
    viewerCredentials(thingName, clientId, settings),
    viewerEndpoint(),
  ]);
  const signedAt = new Date();
  const url = presignMqttUrl({
    host, region: settings.region, credentials, signedAt, expiresSeconds: LINK_SECONDS,
  });
  // The link works until its signature or its credentials expire, whichever
  // is first. The credentials were issued a moment before the signature.
  const signatureEnds = signedAt.getTime() + LINK_SECONDS * 1000;
  const credentialsEnd = new Date(credentials.expiration).getTime();
  const expiresAt = new Date(Number.isFinite(credentialsEnd) ? Math.min(signatureEnds, credentialsEnd) : signatureEnds);
  return {
    url,
    clientId,
    topic: `device/${thingName}/live`,
    expiresAt: expiresAt.toISOString(),
    seconds: settings.seconds,
    minutes: settings.minutes,
    commandPublished,
  };
}

/**
 * "live-<thing>-<8 random hex>". The prefix is what the presence rule leaves
 * out, so a viewer coming and going never marks the board Online or Offline;
 * the random part lets two people watch one board at once. A Thing name may
 * be 128 characters itself, so a long one is cut to fit the 128 bytes AWS IoT
 * allows. Salesforce's serial numbers, at most 80 characters, always fit.
 */
function clientIdFor(thingName) {
  const random = randomBytes(4).toString('hex');
  return `live-${thingName.slice(0, MAX_CLIENT_ID - 'live--'.length - random.length)}-${random}`;
}

/** Asks the board for live readings. False when IoT Core did not take the command. */
async function askForLiveReadings(thingName, { seconds, minutes }) {
  try {
    await iotData.send(new PublishCommand({
      topic: `device/${thingName}/command`,
      qos: 1,
      payload: Buffer.from(JSON.stringify({ operation: 'LIVE', seconds, minutes })),
    }));
    return true;
  } catch (err) {
    console.error('LIVE command not published', { thingName, error: err.message, name: err.name });
    return false;
  }
}

/** A 15-minute session of LiveViewerRole that can watch this board's live topic as clientId, and do nothing else. */
async function viewerCredentials(thingName, clientId, { roleArn, iotArn }) {
  try {
    const { Credentials } = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      // STS takes letters, digits and _+=,.@- in a session name. A Thing name
      // may also hold ':', as a MAC address used as a serial number does.
      RoleSessionName: clientId.slice(0, MAX_SESSION_NAME).replace(/[^\w+=,.@-]/g, '.'),
      DurationSeconds: LINK_SECONDS,
      Policy: viewerPolicy(iotArn, clientId, thingName),
    }));
    return {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    };
  } catch (err) {
    console.error('Could not assume the live viewer role', { thingName, error: err.message, name: err.name });
    // Short: Salesforce shows 200 characters of the answer.
    throw new NoLiveLink(`Could not get credentials for the live view (${err.name}). Try again; if it keeps `
      + "failing, check that the queue-relay stack's DeviceLiveRole may assume LiveViewerRole.");
  }
}

/**
 * The session policy. A session can do only what both its role and this
 * allow: LiveViewerRole allows any live-* client and any board's live topic,
 * and this narrows it to one client id and one board.
 */
function viewerPolicy(iotArn, clientId, thingName) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'iot:Connect', Resource: `${iotArn}:client/${clientId}` },
      { Effect: 'Allow', Action: 'iot:Subscribe', Resource: `${iotArn}:topicfilter/device/${thingName}/live` },
      { Effect: 'Allow', Action: 'iot:Receive', Resource: `${iotArn}:topic/device/${thingName}/live` },
    ],
  });
}

async function viewerEndpoint() {
  try {
    return await dataEndpoint();
  } catch (err) {
    console.error('Could not look up the AWS IoT data endpoint', { error: err.message, name: err.name });
    throw new NoLiveLink(`No AWS IoT endpoint for the live view (${err.name}). Try again; if it keeps failing, `
      + "check that the queue-relay stack's DeviceLiveRole may call iot:DescribeEndpoint.");
  }
}

// The promise is kept, not the value, as in device-provisioning; a failed
// lookup is asked again by the next request.
function dataEndpoint() {
  if (!endpoint) {
    endpoint = iot.send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }))
      .then((result) => result.endpointAddress)
      .catch((err) => {
        endpoint = null;
        throw err;
      });
  }
  return endpoint;
}

/**
 * A wss:// link to AWS IoT's MQTT endpoint, signed with Signature Version 4
 * in its query string: a browser cannot set headers on a WebSocket, so the
 * signature travels in the link. It follows AWS IoT's recipe for MQTT over
 * WebSocket: GET /mqtt, the host the only signed header, the hash of an empty
 * payload, and the session token appended after signing, outside the
 * signature. Written out with node:crypto rather than taken from a package:
 * the function depends on nothing but its SDK clients.
 *
 * Until it expires the link is a credential. Never log it.
 */
function presignMqttUrl({
  host, region, credentials, signedAt, expiresSeconds,
}) {
  const hostname = host.toLowerCase();
  const amzDate = signedAt.toISOString().replace(/[-:]|\.\d{3}/g, '');   // 20261106T053000Z
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${SIGNING_SERVICE}/aws4_request`;
  const query = canonicalQuery({
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  });
  const canonicalRequest = ['GET', '/mqtt', query, `host:${hostname}`, '', 'host', sha256('')].join('\n');
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = [day, region, SIGNING_SERVICE, 'aws4_request']
    .reduce((key, part) => hmac(key, part), `AWS4${credentials.secretAccessKey}`);
  const signature = hmac(signingKey, stringToSign).toString('hex');
  const token = credentials.sessionToken
    ? `&X-Amz-Security-Token=${encodeURIComponent(credentials.sessionToken)}`
    : '';
  return `wss://${hostname}/mqtt?${query}&X-Amz-Signature=${signature}${token}`;
}

/** Each name and value encoded as SigV4 requires, sorted by name. */
function canonicalQuery(params) {
  return Object.entries(params)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** RFC 3986 encoding, as SigV4 wants it. encodeURIComponent leaves ! ' ( ) * as they are. */
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

/**
 * The board's newest stored reading, or null: it has none (Prod keeps none in
 * DynamoDB), or DynamoDB could not say. The patient-vitals function keys
 * readings PATIENT#<thing> / VITAL#<timestamp>, so the newest is the first in
 * reverse key order.
 */
/**
 * Stamps the re-arm on the board's STATE item. Only that attribute: the
 * episode flag belongs to patient-vitals, whose next save would undo a
 * change to it. Throws on a DynamoDB failure, so Salesforce hears a 5xx and
 * logs it; the safety repeat still reports a device that stays hot.
 */
async function rearm(table, thingName) {
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: table,
      Key: { PK: `PATIENT#${thingName}`, SK: 'STATE' },
      UpdateExpression: 'SET RearmRequestedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function newestReading(table, thingName) {
  try {
    const { Items = [] } = await dynamodb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :device AND begins_with(SK, :reading)',
      ExpressionAttributeValues: { ':device': `PATIENT#${thingName}`, ':reading': 'VITAL#' },
      ScanIndexForward: false,
      Limit: 1,
    }));
    return Items.length ? toReading(Items[0]) : null;
  } catch (err) {
    console.error('Could not read the newest stored reading', { thingName, error: err.message, name: err.name });
    return null;
  }
}

/** The patient's state from the board's STATE item, or null when it has none or DynamoDB could not say. */
async function patientState(table, thingName) {
  try {
    const { Item } = await dynamodb.send(new GetCommand({
      TableName: table,
      Key: { PK: `PATIENT#${thingName}`, SK: 'STATE' },
    }));
    return Item ? toState(Item) : null;
  } catch (err) {
    console.error('Could not read the patient state', { thingName, error: err.message, name: err.name });
    return null;
  }
}

function toReading(item) {
  const reading = {
    temperature: numberOrNull(item.Temperature),
    humidity: numberOrNull(item.Humidity),
    at: isoOrNull(item.CreatedAt),
  };
  // Only some monitors measure these; the patient monitor's DHT11 does not.
  if (numberOrNull(item.HeartRate) !== null) reading.heartRate = item.HeartRate;
  if (numberOrNull(item.SpO2) !== null) reading.spo2 = item.SpO2;
  return reading;
}

function toState(item) {
  return {
    patientState: typeof item.PatientState === 'string' ? item.PatientState : null,
    riskScore: numberOrNull(item.RiskScore),
    updatedAt: isoOrNull(item.UpdatedAt),
    // patient-vitals keeps RoomTempHot: true from a reading at or above the
    // temperature alert level until one drops 1 C below it. It is the
    // episode, which no single reading can tell.
    // A re-arm newer than the last sync has ended the episode too.
    temperatureAlert: item.RoomTempHot === true && !(typeof item.RearmRequestedAt === 'string'
      && item.RearmRequestedAt > (typeof item.LastSyncedAt === 'string' ? item.LastSyncedAt : '')),
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// For the tests, which check it against a vector computed apart from this code.
exports.presignMqttUrl = presignMqttUrl;
