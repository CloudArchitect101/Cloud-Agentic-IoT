'use strict';

/*
 * Slack slash commands, answered from Salesforce as the integration user.
 *
 * Slack waits 3 seconds for an answer and then tells the person "the app did
 * not respond". Reading the signing secret, signing in to Salesforce with the
 * JWT Bearer Flow and running the query can take longer than that on a cold
 * start, so a command is handled in two halves by the same function:
 *
 *   1. From API Gateway: check Slack's signature, check the device name,
 *      start the second half asynchronously, and answer "Working on it" at
 *      once.
 *   2. Invoked asynchronously with { slackCommand }: do the work and post
 *      the answer to the command's response_url, which Slack keeps open for
 *      30 minutes.
 *
 * /patient-status answers from two places. The live reading comes from AWS
 * (the patient-vitals table, the same items the MCP server's get_room_status
 * reads), because Salesforce keeps only the readings someone must act on:
 * state changes and re-alerts. The last of those comes from Salesforce. The
 * live part costs one DynamoDB query and no Salesforce API call.
 *
 * Slack never signs in to Salesforce: the signature check is the only
 * identity check on this path, and every Salesforce call runs as the one
 * integration user, as every other function here does.
 */

const crypto = require('node:crypto');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { getParameter } = require('@cloud-agentic-iot/shared/config');
const { requiredEnv, numberEnv } = require('@cloud-agentic-iot/shared/env');
const salesforce = require('@cloud-agentic-iot/shared/salesforce');

const lambda = new LambdaClient({});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// An AWS IoT Thing name, which is what a device is called everywhere here.
// Checked before it goes anywhere near SOQL.
const DEVICE_NAME = /^[A-Za-z0-9_:-]{1,100}$/;
// /dispense-medication was retired on Nov 10: the device is a temperature
// alert now and takes no dose commands.
const COMMANDS = new Set(['/patient-status']);
const SLACK_HOOKS = /^https:\/\/hooks\.slack\.com\//;

/**
 * API Gateway HTTP APIs hand a form-encoded body over base64-encoded. Slack
 * signs the body it sent, so the signature is checked against the decoded
 * text.
 */
function rawBody(event) {
  const body = event.body || '';
  return event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}

/**
 * Verifies the request came from Slack (HMAC over the timestamp and raw
 * body) and rejects anything older than 5 minutes, so it cannot be replayed.
 */
function verifySlackSignature(headers, body, signingSecret) {
  const lower = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const timestamp = lower['x-slack-request-timestamp'];
  const signature = lower['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const computed = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  // timingSafeEqual throws on buffers of different lengths.
  const expected = Buffer.from(computed);
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function slackResponse(text) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  };
}

/** The first half: answer Slack within its 3 seconds. */
async function acknowledge(event) {
  const body = rawBody(event);
  const signingSecret = await getParameter(requiredEnv('SLACK_SIGNING_SECRET_PARAMETER'), { decrypt: true });
  if (!verifySlackSignature(event.headers, body, signingSecret)) {
    console.warn('refused: the Slack signature did not match');
    return { statusCode: 401, body: 'Invalid Slack signature' };
  }

  const params = new URLSearchParams(body);
  const command = params.get('command');
  const deviceId = (params.get('text') || '').trim();
  const responseUrl = params.get('response_url') || '';

  if (!COMMANDS.has(command)) return slackResponse(`Unknown command: ${command}`);
  if (!DEVICE_NAME.test(deviceId)) {
    return slackResponse(`Name one device, for example \`${command} Test8\`.`);
  }
  if (!SLACK_HOOKS.test(responseUrl)) {
    console.warn('refused: no Slack response_url', { command });
    return slackResponse('Slack sent no address to answer on; try again.');
  }

  await lambda.send(new InvokeCommand({
    FunctionName: requiredEnv('AWS_LAMBDA_FUNCTION_NAME'),
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ slackCommand: { command, deviceId, responseUrl } })),
  }));
  console.log('accepted', { command, deviceId });
  return slackResponse(`Looking up \`${deviceId}\`…`);
}

/**
 * The newest reading AWS holds for the device, as the MCP server reads it:
 * the newest VITAL# item under PATIENT#<device>. Null when there is none
 * (a device that never reported, or Prod, which keeps no readings in
 * DynamoDB).
 */
async function liveReading(deviceId) {
  const { Items = [] } = await dynamodb.send(new QueryCommand({
    TableName: requiredEnv('TABLE_NAME'),
    KeyConditionExpression: 'PK = :device AND begins_with(SK, :reading)',
    ExpressionAttributeValues: { ':device': `PATIENT#${deviceId}`, ':reading': 'VITAL#' },
    ScanIndexForward: false,
    Limit: 1,
  }));
  if (!Items.length) return null;
  const item = Items[0];
  const at = Date.parse(item.CreatedAt || item.SK.slice('VITAL#'.length));
  return { temperature: item.Temperature, humidity: item.Humidity, at: Number.isNaN(at) ? null : at };
}

/** "12 s", "4 min", "3 h", "2 d". */
function age(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const shown = (value, unit) => (typeof value === 'number' && Number.isFinite(value) ? `${value}${unit}` : '?');

function liveLine(reading, now) {
  if (!reading || reading.at === null) return 'Live: no reading stored in AWS for this device.';
  const values = `${shown(reading.temperature, '°C')}, ${shown(reading.humidity, '% humidity')}`;
  const stale = now - reading.at > numberEnv('OFFLINE_AFTER_MINUTES') * 60_000;
  return stale
    ? `Live: offline since ${utc(reading.at)}; last reading ${values}, ${age(now - reading.at)} ago.`
    : `Live: ${values}, ${age(now - reading.at)} ago (online).`;
}

function savedLine(record) {
  if (!record) return 'Last saved event: none in Salesforce.';
  const what = [
    `${shown(record.Temperature__c, '°C')}, ${shown(record.Humidity__c, '% humidity')}`,
    record.Room_Temperature_Alert__c ? 'temperature alert' : null,
    record.Patient_State__c ? `state ${record.Patient_State__c}` : null,
  ].filter(Boolean).join(', ');
  return `Last saved event: ${what}, at ${utc(Date.parse(record.CreatedDate))}.`;
}

async function patientStatus(deviceId) {
  // Both at once; either may fail without taking the other with it.
  const [live, saved] = await Promise.allSettled([
    liveReading(deviceId),
    salesforce.query(
      'SELECT Temperature__c, Humidity__c, Patient_State__c, Room_Temperature_Alert__c, CreatedDate '
      + `FROM Patient_Vitals__c WHERE Device__c = '${deviceId}' ORDER BY CreatedDate DESC LIMIT 1`,
    ),
  ]);
  if (live.status === 'rejected') console.error('live reading failed', { deviceId, error: live.reason.message });
  if (saved.status === 'rejected') console.error('Salesforce query failed', { deviceId, error: saved.reason.message });
  if (live.status === 'rejected' && saved.status === 'rejected') throw saved.reason;

  const record = saved.status === 'fulfilled' ? saved.value[0] : undefined;
  if (live.status === 'fulfilled' && !live.value && saved.status === 'fulfilled' && !record) {
    return `No readings for device \`${deviceId}\` in AWS or Salesforce. Check the name: it is the Asset's serial number.`;
  }
  return [
    `*${deviceId}*`,
    live.status === 'fulfilled' ? liveLine(live.value, Date.now()) : 'Live: unavailable, AWS could not be read just now.',
    saved.status === 'fulfilled' ? savedLine(record) : 'Last saved event: unavailable, Salesforce could not be read just now.',
  ].join('\n');
}

/** The second half: do the work and answer on response_url. */
async function respond({ command, deviceId, responseUrl }) {
  if (!SLACK_HOOKS.test(responseUrl) || !DEVICE_NAME.test(deviceId)) {
    throw new Error('refused: a Slack command with no valid response_url or device name');
  }
  let text;
  try {
    text = await patientStatus(deviceId);
  } catch (err) {
    // The person sees that it failed; the log keeps what Salesforce said.
    console.error('Slack command failed', { command, deviceId, error: err.message });
    text = `Sorry, \`${command} ${deviceId}\` failed: neither AWS nor Salesforce could be read. The function's log says why.`;
  }
  const reply = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: true, text }),
  });
  if (!reply.ok) console.error('Slack refused the answer', { status: reply.status });
  return { answered: reply.ok };
}

exports.handler = async (event) => (event && event.slackCommand
  ? respond(event.slackCommand)
  : acknowledge(event));
