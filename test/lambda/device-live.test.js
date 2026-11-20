'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadWithFakes, fakeAwsSdk, fakeDynamoDb, awsError, captureConsole, withEnv,
} = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/device-live/index.js');
const ACCOUNT = '111122223333';
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/cloud-agentic-iot-queue-relay-Dev-LiveViewerRole-1A2B3C4D5E6F`;
const ENDPOINT = 'a1b2c3d4e5f6g7-ats.iot.us-east-2.amazonaws.com';
const TABLE = 'patient-vitals';
const NOW = Date.parse('2026-11-06T05:30:00Z');

// What the template sets, and the Region Lambda sets. The pace and the
// window are not the template's defaults, so a number written into the
// function instead of read from its environment shows.
const ENV = {
  AWS_REGION: 'us-east-2',
  TABLE_NAME: TABLE,
  LIVE_VIEWER_ROLE_ARN: ROLE_ARN,
  LIVE_READING_SECONDS: '3',
  LIVE_MINUTES: '20',
};

// What STS answers. The session ends a second before the link's signature
// would: STS issues it just before the function signs.
const CREDENTIALS = {
  AccessKeyId: 'ASIAVIEWEREXAMPLE7Q2',
  SecretAccessKey: 'viewer/SECRET+example/KEY0123456789abcdef',
  SessionToken: 'IQoJviewerSESSION/token+with=chars',
  Expiration: new Date('2026-11-06T05:44:59Z'),
};

// The items patient-vitals writes (readingItem and saveState there). The
// patient monitor's DHT11 measures no heart rate or SpO2, stored as null.
const reading = (thing, at, values = {}) => ({
  PK: `PATIENT#${thing}`,
  SK: `VITAL#${at}`,
  HeartRate: null,
  SpO2: null,
  Temperature: 22.5,
  Humidity: 41,
  BP_Systolic: null,
  BP_Diastolic: null,
  RiskScore: 0,
  PatientState: 'STABLE',
  SourceSystem: 'AWS_IoT',
  CreatedAt: at,
  ExpiresAt: 1765000000,
  ...values,
});
const STATE = {
  PK: 'PATIENT#Test7',
  SK: 'STATE',
  PatientState: 'AT_RISK',
  RiskScore: 25,
  UpdatedAt: '2026-11-06T05:29:30.000Z',
  LastSyncedAt: '2026-11-06T05:00:00.000Z',
};
const ITEMS = [
  reading('Test7', '2026-11-06T05:29:00.000Z', { Temperature: 22.1, Humidity: 40 }),
  reading('Test7', '2026-11-06T05:29:30.000Z', { Temperature: 22.5, Humidity: 41 }),
  // Another board, whose name starts with this one's, and a newer reading.
  reading('Test70', '2026-11-06T05:29:45.000Z', { Temperature: 30, Humidity: 90 }),
  STATE,
];

/**
 * Loads the handler against fake IoT, STS and DynamoDB. `publish`,
 * `assumeRole` and `describeEndpoint` answer the command's input, or throw.
 */
function load(t, {
  items = ITEMS,
  env = {},
  publish = () => ({}),
  assumeRole = () => ({ Credentials: CREDENTIALS }),
  describeEndpoint = () => ({ endpointAddress: ENDPOINT }),
  dynamo = {},
} = {}) {
  withEnv(t, { ...ENV, ...env });
  const iotData = fakeAwsSdk('IoTDataPlaneClient', ['PublishCommand'], (command, input) => publish(input));
  const iot = fakeAwsSdk('IoTClient', ['DescribeEndpointCommand'], (command, input) => describeEndpoint(input));
  const sts = fakeAwsSdk('STSClient', ['AssumeRoleCommand'], (command, input) => assumeRole(input));
  const table = fakeDynamoDb(items, dynamo);
  const { handler, presignMqttUrl } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-iot-data-plane': iotData.sdk,
    '@aws-sdk/client-iot': iot.sdk,
    '@aws-sdk/client-sts': sts.sdk,
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': table.sdk,
  });
  return {
    handler, presignMqttUrl, publishes: iotData.calls, lookups: iot.calls, assumed: sts.calls, reads: table.calls,
  };
}

const request = (body) => ({ body: JSON.stringify(body) });   // as API Gateway delivers it
const answer = (res) => JSON.parse(res.body);

// The vector comes from the design, computed apart from this code, and again
// with Python's hmac and hashlib. A signing slip shared by the function and
// a test that signs the same way would pass every other test here and fail
// only in the browser, as a connection AWS IoT refuses.
test('the link is signed exactly as the independently computed vector', (t) => {
  const { presignMqttUrl } = load(t);
  const url = presignMqttUrl({
    host: 'a1b2c3d4e5f6g7-ats.iot.us-east-2.amazonaws.com',
    region: 'us-east-2',
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLE/token+with=chars',
    },
    signedAt: new Date('2026-11-06T05:30:00Z'),
    expiresSeconds: 900,
  });
  assert.equal(url, 'wss://a1b2c3d4e5f6g7-ats.iot.us-east-2.amazonaws.com/mqtt'
    + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
    + '&X-Amz-Credential=AKIDEXAMPLE%2F20261106%2Fus-east-2%2Fiotdevicegateway%2Faws4_request'
    + '&X-Amz-Date=20261106T053000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host'
    + '&X-Amz-Signature=25021b995abed247a3385958086719f685cfec03ab43a6ac137f27a8f8c18a3a'
    + '&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEXAMPLE%2Ftoken%2Bwith%3Dchars');
});

test('start tells the board to go live on its own command topic, at the pace and for the time the template sets', async (t) => {
  captureConsole(t);
  const { handler, publishes } = load(t);

  const res = await handler(request({ thingName: 'Test7', mode: 'start' }));

  assert.equal(res.statusCode, 200);
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].input.topic, 'device/Test7/command');
  assert.equal(publishes[0].input.qos, 1);
  assert.deepEqual(JSON.parse(publishes[0].input.payload.toString()), { operation: 'LIVE', seconds: 3, minutes: 20 });
  const { thingName, live } = answer(res);
  assert.equal(thingName, 'Test7');
  assert.deepEqual(Object.keys(live).sort(), ['clientId', 'commandPublished', 'expiresAt', 'minutes', 'seconds', 'topic', 'url']);
  assert.equal(live.commandPublished, true);
  assert.equal(live.seconds, 3);
  assert.equal(live.minutes, 20);
  assert.equal(live.topic, 'device/Test7/live');
  // The presence rule leaves out live-* clients, so a viewer never marks the board Online.
  assert.match(live.clientId, /^live-Test7-[0-9a-f]{8}$/);
  assert.ok(live.url.startsWith(`wss://${ENDPOINT}/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&`), live.url);
});

test('a request that names no mode starts the live view, in either request shape', async (t) => {
  captureConsole(t);
  const { handler, publishes } = load(t);
  for (const event of [request({ thingName: 'Test7' }), { thingName: 'Test7' }]) {
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
    assert.ok(answer(res).live.url);
  }
  assert.equal(publishes.length, 2);
});

test('a bad Thing name or mode is refused before anything is sent or read', async (t) => {
  captureConsole(t);
  const { handler, publishes, lookups, assumed, reads } = load(t);
  const bodies = [
    ...[undefined, '', 'Test7/../Test8', 'Test7/live', '#', 'pm+1', 'x'.repeat(129), 42, null].map((thingName) => ({ thingName })),
    ...['stop', 'START', 'live', '', null, 1, ['start']].map((mode) => ({ thingName: 'Test7', mode })),
  ];
  for (const body of bodies) {
    const res = await handler(request(body));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(typeof answer(res).error, 'string');
  }
  const notJson = await handler({ body: '{not json' });
  assert.equal(notJson.statusCode, 400);
  assert.equal(answer(notJson).error, 'Body is not valid JSON');
  assert.deepEqual([publishes.length, lookups.length, assumed.length, reads.length], [0, 0, 0, 0]);
});

test('a LIVE command IoT Core does not take is logged and answered as commandPublished false, not as a failure', async (t) => {
  const logs = captureConsole(t);
  const { handler } = load(t, { publish: () => { throw awsError('ThrottlingException', 'Rate exceeded'); } });

  const res = await handler(request({ thingName: 'Test7' }));

  assert.equal(res.statusCode, 200);
  const { live, latest, state } = answer(res);
  assert.equal(live.commandPublished, false);
  assert.ok(live.url.startsWith('wss://'));
  assert.ok(latest && state);
  assert.ok(logs.some((line) => line.includes('LIVE command not published') && line.includes('Rate exceeded')), logs.join('\n'));
});

test("the viewer's credentials last 15 minutes and reach only this client id and this board's live topic", async (t) => {
  captureConsole(t);
  const { handler, assumed } = load(t);

  const { live } = answer(await handler(request({ thingName: 'Test7' })));

  assert.equal(assumed.length, 1);
  const {
    RoleArn, RoleSessionName, DurationSeconds, Policy, ...other
  } = assumed[0].input;
  assert.deepEqual(other, {});
  assert.equal(RoleArn, ROLE_ARN);
  assert.equal(DurationSeconds, 900);
  assert.equal(RoleSessionName, live.clientId);
  assert.ok(RoleSessionName.length <= 64);
  // Account from the role's ARN, Region from Lambda's environment.
  assert.deepEqual(JSON.parse(Policy), {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'iot:Connect', Resource: `arn:aws:iot:us-east-2:${ACCOUNT}:client/${live.clientId}` },
      { Effect: 'Allow', Action: 'iot:Subscribe', Resource: `arn:aws:iot:us-east-2:${ACCOUNT}:topicfilter/device/Test7/live` },
      { Effect: 'Allow', Action: 'iot:Receive', Resource: `arn:aws:iot:us-east-2:${ACCOUNT}:topic/device/Test7/live` },
    ],
  });
});

test('two people watching one board connect as two clients', async (t) => {
  captureConsole(t);
  const { handler } = load(t);
  const [first, second] = await Promise.all([1, 2].map(async () => answer(await handler(request({ thingName: 'Test7' }))).live));
  assert.notEqual(first.clientId, second.clientId);
});

test('a long Thing name, or one with a colon, still gets a client id AWS IoT takes and a session name STS takes', async (t) => {
  captureConsole(t);
  const { handler, assumed } = load(t);
  // 128 characters, the longest Thing name; a MAC address as a serial number.
  for (const thingName of ['x'.repeat(128), 'pm-1_a:b'.repeat(16), 'AA:BB:CC:DD:EE:FF']) {
    const res = await handler(request({ thingName }));
    assert.equal(res.statusCode, 200, thingName);
    const { live } = answer(res);
    const { RoleSessionName, Policy } = assumed.at(-1).input;

    assert.ok(Buffer.byteLength(live.clientId) <= 128, live.clientId);
    assert.match(live.clientId, /^live-[\w:-]+-[0-9a-f]{8}$/);
    assert.ok(live.clientId.startsWith(`live-${thingName.slice(0, 20)}`));
    assert.match(RoleSessionName, /^[\w+=,.@-]{2,64}$/);
    assert.equal(RoleSessionName, live.clientId.slice(0, 64).replace(/:/g, '.'));
    // The policy lets the session connect as exactly the client id the card is given.
    assert.equal(JSON.parse(Policy).Statement[0].Resource, `arn:aws:iot:us-east-2:${ACCOUNT}:client/${live.clientId}`);
    assert.equal(live.topic, `device/${thingName}/live`);
  }
});

test('the link is signed for the endpoint, the Region and the viewer credentials, and ends when they do', async (t) => {
  captureConsole(t);
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { handler, presignMqttUrl } = load(t);

  const { live } = answer(await handler(request({ thingName: 'Test7' })));

  assert.equal(live.url, presignMqttUrl({
    host: ENDPOINT,
    region: 'us-east-2',
    credentials: {
      accessKeyId: CREDENTIALS.AccessKeyId,
      secretAccessKey: CREDENTIALS.SecretAccessKey,
      sessionToken: CREDENTIALS.SessionToken,
    },
    signedAt: new Date(NOW),
    expiresSeconds: 900,
  }));
  assert.ok(live.url.includes(`&X-Amz-Security-Token=${encodeURIComponent(CREDENTIALS.SessionToken)}`));
  // The credentials end a second before the signature, so the link ends with them.
  assert.equal(live.expiresAt, '2026-11-06T05:44:59.000Z');

  const later = load(t, { assumeRole: () => ({ Credentials: { ...CREDENTIALS, Expiration: new Date('2026-11-06T05:50:00Z') } }) });
  assert.equal(answer(await later.handler(request({ thingName: 'Test7' }))).live.expiresAt, '2026-11-06T05:45:00.000Z');
});

test('when STS refuses the viewer credentials, the answer is a 502 that says what to check', async (t) => {
  const logs = captureConsole(t);
  const { handler, presignMqttUrl } = load(t, {
    assumeRole: () => {
      throw awsError('AccessDenied', `User: arn:aws:sts::${ACCOUNT}:assumed-role/DeviceLiveRole/cloud-agentic-iot-device-live `
        + 'is not authorized to perform: sts:AssumeRole');
    },
  });
  assert.equal(typeof presignMqttUrl, 'function');

  const res = await handler(request({ thingName: 'Test7' }));

  assert.equal(res.statusCode, 502);
  const body = answer(res);
  assert.deepEqual(Object.keys(body), ['error']);
  assert.match(body.error, /\(AccessDenied\)/);
  assert.match(body.error, /DeviceLiveRole may assume LiveViewerRole\.$/);
  // Salesforce keeps 200 characters of an answer it shows: the advice must be in them.
  assert.ok(res.body.length <= 200, `${res.body.length} characters`);
  assert.ok(logs.some((line) => line.includes('not authorized to perform: sts:AssumeRole')), logs.join('\n'));
});

test('the IoT endpoint is looked up once per container', async (t) => {
  captureConsole(t);
  const { handler, lookups } = load(t);
  for (const thingName of ['Test7', 'Test8', 'Test7']) {
    const res = await handler(request({ thingName }));
    assert.ok(answer(res).live.url.startsWith(`wss://${ENDPOINT}/mqtt?`));
  }
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].input, { endpointType: 'iot:Data-ATS' });
});

test('a failed endpoint lookup answers 502 and is asked again by the next request', async (t) => {
  captureConsole(t);
  let failures = 1;
  const { handler, lookups } = load(t, {
    describeEndpoint: () => {
      if (failures-- > 0) throw awsError('ThrottlingException', 'Rate exceeded');
      return { endpointAddress: ENDPOINT };
    },
  });

  const failed = await handler(request({ thingName: 'Test7' }));
  assert.equal(failed.statusCode, 502);
  assert.match(answer(failed).error, /^No AWS IoT endpoint for the live view \(ThrottlingException\)\. Try again/);
  assert.equal((await handler(request({ thingName: 'Test7' }))).statusCode, 200);
  assert.equal((await handler(request({ thingName: 'Test7' }))).statusCode, 200);
  assert.equal(lookups.length, 2);
});

test('both modes read the newest stored reading and the patient state, as numbers and ISO times', async (t) => {
  captureConsole(t);
  for (const mode of ['start', 'latest']) {
    const { handler, reads } = load(t);

    const res = await handler(request({ thingName: 'Test7', mode }));

    assert.equal(res.statusCode, 200, mode);
    assert.deepEqual(reads.map((call) => call.command).sort(), ['GetCommand', 'QueryCommand']);
    assert.deepEqual(reads.find((call) => call.command === 'QueryCommand').input, {
      TableName: TABLE,
      KeyConditionExpression: 'PK = :device AND begins_with(SK, :reading)',
      ExpressionAttributeValues: { ':device': 'PATIENT#Test7', ':reading': 'VITAL#' },
      ScanIndexForward: false,
      Limit: 1,
    });
    assert.deepEqual(reads.find((call) => call.command === 'GetCommand').input, {
      TableName: TABLE,
      Key: { PK: 'PATIENT#Test7', SK: 'STATE' },
    });
    const { latest, state } = answer(res);
    // The newest of this board's readings, not Test70's; no heart rate or SpO2 from a DHT11.
    assert.deepEqual(latest, { temperature: 22.5, humidity: 41, at: '2026-11-06T05:29:30.000Z' });
    assert.deepEqual(state, { patientState: 'AT_RISK', riskScore: 25, updatedAt: '2026-11-06T05:29:30.000Z', temperatureAlert: false });
  }
});

test('a reading with heart rate and SpO2 answers them too', async (t) => {
  captureConsole(t);
  const { handler } = load(t, {
    items: [reading('Test7', '2026-11-06T05:29:30.000Z', { HeartRate: 72, SpO2: 97, Temperature: 36.8, Humidity: 0 })],
  });
  const { latest, state } = answer(await handler(request({ thingName: 'Test7', mode: 'latest' })));
  assert.deepEqual(latest, {
    temperature: 36.8, humidity: 0, at: '2026-11-06T05:29:30.000Z', heartRate: 72, spo2: 97,
  });
  assert.equal(state, null);
});

test('a board with nothing stored answers null, as every board does for latest in Prod', async (t) => {
  captureConsole(t);
  // Prod keeps no readings in DynamoDB (KeepReadingsInDynamoDB false), only STATE.
  const prod = load(t, { items: [STATE] });
  const inProd = answer(await prod.handler(request({ thingName: 'Test7' })));
  assert.equal(inProd.latest, null);
  assert.equal(inProd.state.patientState, 'AT_RISK');
  assert.ok(inProd.live.url);

  const empty = load(t, { items: [] });
  const fresh = answer(await empty.handler(request({ thingName: 'Test7', mode: 'latest' })));
  assert.deepEqual(fresh, { thingName: 'Test7', latest: null, state: null });
});

test('a read DynamoDB refuses is logged and answered as null, never as a failed request', async (t) => {
  const logs = captureConsole(t);
  for (const refused of ['QueryCommand', 'GetCommand']) {
    const { handler } = load(t, {
      dynamo: {
        fail: (command) => {
          if (command === refused) throw awsError('AccessDeniedException', `not authorized to perform ${refused}`);
        },
      },
    });
    for (const mode of ['start', 'latest']) {
      const res = await handler(request({ thingName: 'Test7', mode }));
      assert.equal(res.statusCode, 200, `${refused} in ${mode}`);
      const { latest, state } = answer(res);
      assert.equal(latest === null, refused === 'QueryCommand', `latest when ${refused} fails`);
      assert.equal(state === null, refused === 'GetCommand', `state when ${refused} fails`);
    }
    assert.ok(logs.some((line) => line.includes(`not authorized to perform ${refused}`)), logs.join('\n'));
  }
});

test('latest only reads: no command to the board, no credentials, no endpoint, no link', async (t) => {
  captureConsole(t);
  // Its live settings are not even read.
  const { handler, publishes, assumed, lookups } = load(t, {
    env: { LIVE_VIEWER_ROLE_ARN: undefined, LIVE_READING_SECONDS: undefined, LIVE_MINUTES: undefined },
  });

  const res = await handler(request({ thingName: 'Test7', mode: 'latest' }));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(answer(res)).sort(), ['latest', 'state', 'thingName']);
  assert.deepEqual([publishes.length, assumed.length, lookups.length], [0, 0, 0]);
});

test('a missing or out-of-range setting fails by name before the board is told anything', async (t) => {
  captureConsole(t);
  const cases = [
    ['TABLE_NAME', undefined, /TABLE_NAME is not set/],
    ['LIVE_VIEWER_ROLE_ARN', undefined, /LIVE_VIEWER_ROLE_ARN is not set/],
    ['LIVE_VIEWER_ROLE_ARN', 'LiveViewerRole', /LIVE_VIEWER_ROLE_ARN must be an IAM role ARN/],
    ['AWS_REGION', undefined, /AWS_REGION is not set/],
    ['LIVE_READING_SECONDS', '61', /LIVE_READING_SECONDS must be a whole number from 1 to 60/],
    ['LIVE_READING_SECONDS', '1.5', /LIVE_READING_SECONDS must be a whole number from 1 to 60/],
    ['LIVE_MINUTES', '0', /LIVE_MINUTES must be a positive number/],
    ['LIVE_MINUTES', '31', /LIVE_MINUTES must be a whole number from 1 to 30/],
  ];
  for (const [name, value, message] of cases) {
    const { handler, publishes, assumed, reads } = load(t, { env: { [name]: value } });
    await assert.rejects(handler(request({ thingName: 'Test7' })), message, `${name}=${value}`);
    assert.deepEqual([publishes.length, assumed.length, reads.length], [0, 0, 0], `${name}=${value}`);
  }
});

test('no link, secret or token reaches the logs', async (t) => {
  const logs = captureConsole(t);
  const links = [];
  // A start that works, one whose command fails, and one STS refuses.
  const works = load(t);
  links.push(answer(await works.handler(request({ thingName: 'Test7' }))).live.url);
  const noCommand = load(t, { publish: () => { throw awsError('ForbiddenException', 'Not allowed'); } });
  links.push(answer(await noCommand.handler(request({ thingName: 'Test7' }))).live.url);
  const noCredentials = load(t, { assumeRole: () => { throw awsError('AccessDenied', 'Not allowed'); } });
  assert.equal((await noCredentials.handler(request({ thingName: 'Test7' }))).statusCode, 502);

  const signatures = links.map((url) => url.match(/X-Amz-Signature=([0-9a-f]{64})/)[1]);
  const text = logs.join('\n');
  for (const secret of [
    'wss://', 'X-Amz-', ...links, ...signatures, CREDENTIALS.AccessKeyId, CREDENTIALS.SecretAccessKey,
    CREDENTIALS.SessionToken, encodeURIComponent(CREDENTIALS.SessionToken),
  ]) {
    assert.ok(!text.includes(secret), `a log line holds ${secret}`);
  }
  // The check above looked at real lines: each request logged something.
  assert.ok(logs.filter((line) => line.startsWith('live view')).length === 2, text);
  assert.ok(logs.some((line) => line.includes('LIVE command not published')), text);
  assert.ok(logs.some((line) => line.includes('Could not assume the live viewer role')), text);
});
