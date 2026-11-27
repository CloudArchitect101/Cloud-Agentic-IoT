'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadWithFakes, fakeSsm, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const root = path.join(__dirname, '../..');
const HANDLER = path.join(root, 'lambda/device-presence/index.js');
const TEMPLATE = 'lambda/patient-vitals/cloudformation.yaml';
const KEY_PARAMETER = '/cloud-agentic-iot/salesforce/jwt-private-key';
const INSTANCE = 'https://example.my.salesforce.com';
const ACTION_URL = `${INSTANCE}/services/data/v64.0/actions/custom/apex/DeviceConnectionService`;
const PREFIX = 'arn:aws:iot:us-east-2:123456789012:thing/';

const ENV = {
  SALESFORCE_CLIENT_ID: 'consumer-key',
  SALESFORCE_USERNAME: 'integration@example.com',
  SALESFORCE_LOGIN_URL: 'https://login.salesforce.com',
  SALESFORCE_JWT_KEY_PARAMETER: KEY_PARAMETER,
  SALESFORCE_API_VERSION: '64.0',
  SALESFORCE_TOKEN_CACHE_MINUTES: '30',
  CONFIG_CACHE_SECONDS: '300',
  THING_ARN_PREFIX: PREFIX,
  DEVICE_CONNECTION_ACTION: 'DeviceConnectionService',
};

const T = Date.parse('2026-11-06T05:00:00.000Z');

// What DevicePresenceIoTRule puts on the presence queue: the five fields its
// SQL selects from an AWS IoT lifecycle event.
const connected = (clientId, timestamp = T, versionNumber = 1) => ({
  clientId, eventType: 'connected', timestamp, versionNumber,
});
const disconnected = (clientId, timestamp = T, versionNumber = 1, disconnectReason = 'CONNECTION_LOST') => ({
  clientId, eventType: 'disconnected', timestamp, disconnectReason, versionNumber,
});

const queueBatch = (bodies) => ({
  Records: bodies.map((body, i) => ({
    messageId: `m-${i}`, body: typeof body === 'string' ? body : JSON.stringify(body), eventSource: 'aws:sqs',
  })),
});

// One result of the invocable action per input, as the REST API returns them.
const recorded = (input) => ({
  actionName: 'DeviceConnectionService', isSuccess: true, errors: null,
  outputValues: { thingArn: input.thingArn, assetsUpdated: 1, skipped: null },
});
const refused = (statusCode, message) => ({
  actionName: 'DeviceConnectionService', isSuccess: false, errors: [{ statusCode, message }], outputValues: null,
});

/**
 * Loads the handler against a fake Salesforce. `answer(inputs, request)`
 * answers each call of the action; by default every input updates one Asset.
 */
function load(t, { answer = (inputs) => jsonResponse(200, inputs.map(recorded)), env = {} } = {}) {
  withEnv(t, { ...ENV, ...env });
  const ssm = fakeSsm({ [KEY_PARAMETER]: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----' });
  const requests = fakeFetch(t, (request) => {
    if (request.url.endsWith('/services/oauth2/token')) {
      return jsonResponse(200, { access_token: 'token-1', instance_url: INSTANCE });
    }
    return answer(JSON.parse(request.body).inputs, request);
  });
  const { handler } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-ssm': ssm.sdk,
    jsonwebtoken: { sign: () => 'signed-assertion' },
  });
  // The action's calls, without the token request.
  const calls = () => requests.filter((r) => !r.url.endsWith('/services/oauth2/token'));
  const inputs = () => calls().flatMap((r) => JSON.parse(r.body).inputs);
  return { handler, requests, calls, inputs };
}

const failedIds = (result) => result.batchItemFailures.map((failure) => failure.itemIdentifier);
const ids = (from, to) => Array.from({ length: to - from }, (_, n) => `m-${from + n}`);

/** The invocation's one summary line, parsed. */
function summary(lines) {
  const found = lines.filter((line) => line.startsWith('Connection changes sent to Salesforce '));
  assert.equal(found.length, 1, `one summary line per invocation, not ${found.length}`);
  return JSON.parse(found[0].slice(found[0].indexOf('{')));
}

/* ------------------------------------------------------------ what is sent */

test('one input per Thing goes to DeviceConnectionService, in one call', async (t) => {
  const lines = captureConsole(t);
  const { handler, calls } = load(t);

  const result = await handler(queueBatch([
    connected('CompanyInternalESP32', T + 1000, 4),
    disconnected('PatientExternalESP32', T + 2000, 9, 'MQTT_KEEP_ALIVE_TIMEOUT'),
  ]));

  assert.deepEqual(result, { batchItemFailures: [] });
  const [request] = calls();
  assert.equal(calls().length, 1);
  assert.equal(request.url, ACTION_URL);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer token-1');
  assert.deepEqual(JSON.parse(request.body), {
    inputs: [
      { thingArn: `${PREFIX}CompanyInternalESP32`, status: 'Online', changedAtMillis: T + 1000, disconnectReason: null },
      { thingArn: `${PREFIX}PatientExternalESP32`, status: 'Offline', changedAtMillis: T + 2000, disconnectReason: 'MQTT_KEEP_ALIVE_TIMEOUT' },
    ],
  });
  assert.deepEqual(summary(lines), {
    events: 2, dropped: {}, things: 2, sent: 2, assetsUpdated: 2, unchanged: 0, failed: 0, returned: 0,
  });
});

test('an Online input never carries a reason: the Asset keeps the one it has', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);
  // AWS IoT puts no reason on a connect; one that did would still send none.
  await handler(queueBatch([{ ...connected('CompanyInternalESP32'), disconnectReason: 'CONNECTION_LOST' }]));
  assert.deepEqual(inputs(), [{ thingArn: `${PREFIX}CompanyInternalESP32`, status: 'Online', changedAtMillis: T, disconnectReason: null }]);
});

test('a disconnect without a reason sends a null reason', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);
  await handler(queueBatch([{ clientId: 'CompanyInternalESP32', eventType: 'disconnected', timestamp: T, versionNumber: 1 }]));
  assert.deepEqual(inputs(), [{ thingArn: `${PREFIX}CompanyInternalESP32`, status: 'Offline', changedAtMillis: T, disconnectReason: null }]);
});

/* ------------------------------------------------------------- drop rules */

// Each is dropped with a log line and never retried: no retry makes it usable.
const DROPS = [
  ['a body that is not JSON', 'not json at all', 'malformed'],
  ['JSON that is not an object', '"connected"', 'malformed'],
  ['a null body', 'null', 'malformed'],
  ['an event without a clientId', { eventType: 'connected', timestamp: T, versionNumber: 1 }, 'malformed'],
  ['an event with an empty clientId', connected(''), 'malformed'],
  ['an event without an eventType', { clientId: 'CompanyInternalESP32', timestamp: T, versionNumber: 1 }, 'malformed'],
  ['an event without a timestamp', { clientId: 'CompanyInternalESP32', eventType: 'connected', versionNumber: 1 }, 'malformed'],
  ['an event whose timestamp is not epoch milliseconds', connected('CompanyInternalESP32', '2026-11-06T05:00:00.000Z'), 'malformed'],
  ['a subscribe event', { clientId: 'CompanyInternalESP32', eventType: 'subscribed', timestamp: T, versionNumber: 1 }, 'otherEvent'],
  ['an event type that is not a string', { clientId: 'CompanyInternalESP32', eventType: 1, timestamp: T, versionNumber: 1 }, 'otherEvent'],
  ['a live viewer connecting', connected('live-CompanyInternalESP32-1a2b3c4d'), 'liveViewer'],
  ['a live viewer disconnecting', disconnected('live-CompanyInternalESP32-1a2b3c4d'), 'liveViewer'],
  ['a client ID with a slash', connected('CompanyInternalESP32/telemetry'), 'notThingName'],
  ['a client ID with a space', connected('Test 7'), 'notThingName'],
  ['a client ID longer than 128 characters', connected('x'.repeat(129)), 'notThingName'],
  ['a client ID that is not a string', connected(7), 'notThingName'],
  ['a DUPLICATE_CLIENTID disconnect', disconnected('CompanyInternalESP32', T, 1, 'DUPLICATE_CLIENTID'), 'duplicateClientId'],
];

for (const [name, body, reason] of DROPS) {
  test(`drops ${name}, with a log line, and never retries it`, async (t) => {
    const lines = captureConsole(t);
    const { handler, requests } = load(t);

    const result = await handler(queueBatch([body]));

    assert.deepEqual(result, { batchItemFailures: [] });
    // Nothing to send is no call at all, not even for a token.
    assert.equal(requests.length, 0);
    const line = lines.find((l) => l.startsWith('Dropped a presence event: '));
    assert.ok(line, `no drop line in ${JSON.stringify(lines)}`);
    assert.match(line, /"messageId":"m-0"/);
    assert.deepEqual(summary(lines), {
      events: 1, dropped: { [reason]: 1 }, things: 0, sent: 0, assetsUpdated: 0, unchanged: 0, failed: 0, returned: 0,
    });
  });
}

test('a disconnect for any other reason is kept', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);
  await handler(queueBatch([
    disconnected('CompanyInternalESP32', T, 1, 'CLIENT_INITIATED_DISCONNECT'),
    disconnected('PatientExternalESP32', T, 1, 'CONNECTION_LOST'),
  ]));
  assert.deepEqual(inputs().map((input) => input.disconnectReason), ['CLIENT_INITIATED_DISCONNECT', 'CONNECTION_LOST']);
});

test('a dropped event plays no part in its Thing\'s state, and the rest of the batch goes on', async (t) => {
  const lines = captureConsole(t);
  const { handler, inputs } = load(t);

  // The new connection's connect, then the old connection's disconnect,
  // which AWS IoT may stamp later.
  const result = await handler(queueBatch([
    connected('CompanyInternalESP32', T, 8),
    disconnected('CompanyInternalESP32', T + 40, 7, 'DUPLICATE_CLIENTID'),
    'not json',
    connected('live-CompanyInternalESP32-1a2b3c4d', T + 50),
    connected('PatientExternalESP32', T + 60, 2),
  ]));

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(inputs(), [
    { thingArn: `${PREFIX}CompanyInternalESP32`, status: 'Online', changedAtMillis: T, disconnectReason: null },
    { thingArn: `${PREFIX}PatientExternalESP32`, status: 'Online', changedAtMillis: T + 60, disconnectReason: null },
  ]);
  assert.deepEqual(summary(lines).dropped, { duplicateClientId: 1, malformed: 1, liveViewer: 1 });
});

test('an empty batch is no call', async (t) => {
  const lines = captureConsole(t);
  const { handler, requests } = load(t);
  assert.deepEqual(await handler({ Records: [] }), { batchItemFailures: [] });
  assert.equal(requests.length, 0);
  assert.equal(summary(lines).events, 0);
});

/* ------------------------------------------------------- one event per Thing */

test('per Thing, the latest event wins, in whatever order the events arrive', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);

  await handler(queueBatch([
    // The greatest timestamp wins, even over a greater version number.
    disconnected('CompanyInternalESP32', T + 1000, 5),
    connected('CompanyInternalESP32', T + 3000, 2),
    connected('CompanyInternalESP32', T, 1),
    // And the same three the other way round.
    connected('PatientExternalESP32', T, 1),
    connected('PatientExternalESP32', T + 3000, 2),
    disconnected('PatientExternalESP32', T + 1000, 5),
    // A disconnect last.
    connected('Test9', T, 3),
    disconnected('Test9', T + 5000, 3, 'CONNECTION_LOST'),
  ]));

  assert.deepEqual(inputs(), [
    { thingArn: `${PREFIX}CompanyInternalESP32`, status: 'Online', changedAtMillis: T + 3000, disconnectReason: null },
    { thingArn: `${PREFIX}PatientExternalESP32`, status: 'Online', changedAtMillis: T + 3000, disconnectReason: null },
    { thingArn: `${PREFIX}Test9`, status: 'Offline', changedAtMillis: T + 5000, disconnectReason: 'CONNECTION_LOST' },
  ]);
});

test('on the same millisecond, the greater version number wins', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);

  // The old connection (7) ends as the new one (8) starts: the board is online.
  await handler(queueBatch([
    connected('CompanyInternalESP32', T, 8),
    disconnected('CompanyInternalESP32', T, 7),
    disconnected('PatientExternalESP32', T, 7),
    connected('PatientExternalESP32', T, 8),
    // The other way: the newer connection is the one that ended.
    disconnected('Test9', T, 8),
    connected('Test9', T, 7),
  ]));

  assert.deepEqual(inputs().map(({ thingArn, status }) => [thingArn.slice(PREFIX.length), status]), [
    ['CompanyInternalESP32', 'Online'], ['PatientExternalESP32', 'Online'], ['Test9', 'Offline'],
  ]);
});

test('on the same millisecond and version number, the disconnect wins', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);

  // A connection's disconnect follows its connect, and both carry its version.
  await handler(queueBatch([
    connected('CompanyInternalESP32', T, 6),
    disconnected('CompanyInternalESP32', T, 6, 'CLIENT_INITIATED_DISCONNECT'),
    disconnected('PatientExternalESP32', T, 6, 'CLIENT_INITIATED_DISCONNECT'),
    connected('PatientExternalESP32', T, 6),
  ]));

  assert.deepEqual(inputs(), [
    { thingArn: `${PREFIX}CompanyInternalESP32`, status: 'Offline', changedAtMillis: T, disconnectReason: 'CLIENT_INITIATED_DISCONNECT' },
    { thingArn: `${PREFIX}PatientExternalESP32`, status: 'Offline', changedAtMillis: T, disconnectReason: 'CLIENT_INITIATED_DISCONNECT' },
  ]);
});

test('an event without a version number loses a tie to one with', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);
  const unversioned = { clientId: 'CompanyInternalESP32', eventType: 'disconnected', timestamp: T, disconnectReason: 'CONNECTION_LOST' };
  await handler(queueBatch([unversioned, connected('CompanyInternalESP32', T, 0)]));
  assert.deepEqual(inputs().map((input) => input.status), ['Online']);
});

test('an event delivered twice is one input', async (t) => {
  const lines = captureConsole(t);
  const { handler, inputs } = load(t);
  await handler(queueBatch([connected('CompanyInternalESP32'), connected('CompanyInternalESP32')]));
  assert.equal(inputs().length, 1);
  assert.deepEqual(summary(lines), {
    events: 2, dropped: {}, things: 1, sent: 1, assetsUpdated: 1, unchanged: 0, failed: 0, returned: 0,
  });
});

/* ---------------------------------------------------------------- chunks */

test('450 Things go in three calls of at most 200', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const result = await handler(queueBatch(Array.from({ length: 450 }, (_, n) => connected(`pm-${n}`))));
  assert.deepEqual(result.batchItemFailures, []);
  assert.deepEqual(calls().map((r) => JSON.parse(r.body).inputs.length), [200, 200, 50]);
});

test('Things are counted after their events are collapsed: 600 events of 200 Things are one call', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const events = [];
  for (let n = 0; n < 200; n++) {
    events.push(connected(`pm-${n}`, T, 1), disconnected(`pm-${n}`, T + 10, 1), connected(`pm-${n}`, T + 20, 2));
  }
  await handler(queueBatch(events));
  assert.equal(calls().length, 1);
  assert.deepEqual(new Set(JSON.parse(calls()[0].body).inputs.map((input) => input.status)), new Set(['Online']));
});

/* --------------------------------------------------------------- failures */

/**
 * 450 Things, one connect each (m-0 to m-449), so the calls are pm-0..199,
 * pm-200..399 and pm-400..449. Then an older event of pm-250 (m-450), in the
 * second call; a DUPLICATE_CLIENTID disconnect of pm-300 (m-451), which is
 * dropped; and an older event of pm-10 (m-452), in the first call.
 */
const threeCalls = () => queueBatch([
  ...Array.from({ length: 450 }, (_, n) => connected(`pm-${n}`, T + 1000, 2)),
  disconnected('pm-250', T, 1),
  disconnected('pm-300', T + 2000, 1, 'DUPLICATE_CLIENTID'),
  disconnected('pm-10', T, 1),
]);

test('a call Salesforce fails returns exactly the messages that fed it, and the other calls go on', async (t) => {
  const lines = captureConsole(t);
  let n = 0;
  const { handler, calls } = load(t, {
    answer: (inputs) => (++n === 2
      ? jsonResponse(503, [{ errorCode: 'SERVER_UNAVAILABLE', message: 'Try again later' }])
      : jsonResponse(200, inputs.map(recorded))),
  });

  const result = await handler(threeCalls());

  assert.equal(calls().length, 3);
  // The second call's 200 Things, with the superseded event of pm-250; not
  // the dropped event, and nothing of the first or third call.
  assert.deepEqual(failedIds(result).sort(), [...ids(200, 400), 'm-450'].sort());
  const logged = lines.find((line) => line.startsWith('Salesforce did not take a call'));
  assert.match(logged, /"status":503/);
  assert.match(logged, /"things":200/);
  assert.deepEqual(summary(lines), {
    events: 453, dropped: { duplicateClientId: 1 }, things: 450, sent: 250, assetsUpdated: 250, unchanged: 0, failed: 0, returned: 201,
  });
});

test('a call that never reaches Salesforce returns its messages too', async (t) => {
  captureConsole(t);
  let n = 0;
  const { handler } = load(t, {
    answer: (inputs) => {
      if (++n === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, inputs.map(recorded));
    },
  });

  const result = await handler(threeCalls());

  assert.deepEqual(failedIds(result).sort(), [...ids(0, 200), 'm-452'].sort());
});

test('an input Salesforce answers with isSuccess false is logged with its errors, and not retried', async (t) => {
  const lines = captureConsole(t);
  const { handler, calls } = load(t, {
    answer: (inputs) => jsonResponse(200, inputs.map((input) => (input.thingArn.endsWith(':thing/PatientExternalESP32')
      ? refused('UNKNOWN_EXCEPTION', 'Something went wrong in DeviceConnectionService')
      : recorded(input)))),
  });

  const result = await handler(queueBatch([connected('CompanyInternalESP32'), connected('PatientExternalESP32'), connected('Test9')]));

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(calls().length, 1);
  const logged = lines.filter((line) => line.startsWith('Salesforce did not record a connection change'));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /"thingName":"PatientExternalESP32"/);
  assert.match(logged[0], /UNKNOWN_EXCEPTION/);
  assert.match(logged[0], /Something went wrong in DeviceConnectionService/);
  assert.deepEqual(summary(lines), {
    events: 3, dropped: {}, things: 3, sent: 3, assetsUpdated: 2, unchanged: 0, failed: 1, returned: 0,
  });
});

test('a result missing from the answer counts as not recorded, and is not retried', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, { answer: (inputs) => jsonResponse(200, inputs.slice(1).map(recorded)) });
  const result = await handler(queueBatch([connected('CompanyInternalESP32'), connected('PatientExternalESP32')]));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(summary(lines).failed, 1);
});

test('an outcome that changed no Asset is logged with its reason, and not retried', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, {
    answer: (inputs) => jsonResponse(200, inputs.map((input) => ({
      ...recorded(input),
      outputValues: { thingArn: input.thingArn, assetsUpdated: 0, skipped: 'No Asset has this Thing ARN.' },
    }))),
  });

  const result = await handler(queueBatch([connected('iotconsole-1730869200000-0')]));

  assert.deepEqual(result, { batchItemFailures: [] });
  const logged = lines.find((line) => line.startsWith('No Asset changed for a Thing'));
  assert.match(logged, /"thingName":"iotconsole-1730869200000-0"/);
  assert.match(logged, /No Asset has this Thing ARN/);
  assert.equal(summary(lines).unchanged, 1);
});

/* ------------------------------------------------------- THING_ARN_PREFIX */

test('the Thing ARN is THING_ARN_PREFIX and the client ID, in any partition', async (t) => {
  captureConsole(t);
  const prefix = 'arn:aws-us-gov:iot:us-gov-west-1:210987654321:thing/';
  const { handler, inputs } = load(t, { env: { THING_ARN_PREFIX: prefix } });
  await handler(queueBatch([connected('CompanyInternalESP32')]));
  assert.equal(inputs()[0].thingArn, 'arn:aws-us-gov:iot:us-gov-west-1:210987654321:thing/CompanyInternalESP32');
});

test('a missing THING_ARN_PREFIX fails the batch by name, before any call', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t, { env: { THING_ARN_PREFIX: undefined } });
  await assert.rejects(handler(queueBatch([connected('CompanyInternalESP32')])), /THING_ARN_PREFIX is not set/);
  assert.equal(requests.length, 0);
});

test('a THING_ARN_PREFIX that does not end in :thing/ fails the batch, before any call', async (t) => {
  captureConsole(t);
  // Without the slash, every ARN would be one no Asset holds, and no error
  // would ever say so.
  const { handler, requests } = load(t, { env: { THING_ARN_PREFIX: 'arn:aws:iot:us-east-2:123456789012:thing' } });
  await assert.rejects(handler(queueBatch([connected('CompanyInternalESP32')])), /THING_ARN_PREFIX must be arn:<partition>:iot:/);
  assert.equal(requests.length, 0);
});

test('the action is the one DEVICE_CONNECTION_ACTION names', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, { env: { DEVICE_CONNECTION_ACTION: 'DeviceConnectionServiceV2' } });
  await handler(queueBatch([connected('CompanyInternalESP32')]));
  assert.equal(calls()[0].url, `${INSTANCE}/services/data/v64.0/actions/custom/apex/DeviceConnectionServiceV2`);
});

/* ------------------------------------------------------------------ logs */

test('no whole payload is ever logged', async (t) => {
  const lines = captureConsole(t);
  let n = 0;
  const { handler } = load(t, {
    answer: (inputs) => {
      n += 1;
      if (n === 1) return jsonResponse(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'boom' }]);
      return jsonResponse(200, inputs.map((input, i) => (i === 0 ? refused('UNKNOWN_EXCEPTION', 'boom') : recorded(input))));
    },
  });
  // Fields the rule never selects, in case a payload ever carries them.
  const extra = { ipAddress: '192.0.2.44', principalIdentifier: 'principal-c0ffee', sessionIdentifier: 'session-c0ffee' };
  const bodies = [
    ...Array.from({ length: 201 }, (_, i) => ({ ...connected(`pm-${i}`), ...extra })),
    { ...disconnected('CompanyInternalESP32', T, 1, 'DUPLICATE_CLIENTID'), ...extra },
    { ...connected('Test 7'), ...extra },
    'not json, but private-c0ffee all the same',
  ];

  await handler(queueBatch(bodies));

  assert.ok(lines.length > 0);
  const batch = queueBatch(bodies);
  for (const line of lines) {
    // An event's fields, a call's inputs, or a Thing ARN: each would mean a payload went into the logs.
    assert.doesNotMatch(line, /c0ffee|192\.0\.2\.44|"(?:clientId|eventType|versionNumber|inputs|thingArn|changedAtMillis)"|arn:aws:iot/, line);
    for (const { body } of batch.Records) assert.ok(!line.includes(body), line);
  }
});

/* --------------------------------------------------------------- template */

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** One resource of the template, as text: its lines up to the next resource or section. */
function resource(logicalId) {
  const lines = source(TEMPLATE).split(/\r?\n/);
  const start = lines.indexOf(`  ${logicalId}:`);
  assert.ok(start !== -1, `${TEMPLATE} has no ${logicalId}`);
  const end = lines.findIndex((line, i) => i > start && /^ {0,2}[^\s#]/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** The file and every file of this repo it requires, directly or not. */
function sourcesOf(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of source(file).matchAll(/require\('(\.{1,2}\/[^']+|@cloud-agentic-iot\/shared\/[^']+)'\)/g)) {
    const target = spec.startsWith('.')
      ? path.posix.join(path.posix.dirname(file), spec)
      : path.posix.join('lambda/shared', spec.slice('@cloud-agentic-iot/shared/'.length));
    sourcesOf(target.endsWith('.js') ? target : `${target}.js`, seen);
  }
  return seen;
}

test('the template sets every variable the function reads', () => {
  const variables = new Set();
  for (const file of sourcesOf('lambda/device-presence/index.js')) {
    const reads = source(file).matchAll(/\b(?:requiredEnv|numberEnv|booleanEnv)\('([A-Z0-9_]+)'\)|process\.env\.([A-Z0-9_]+)/g);
    for (const [, named, direct] of reads) variables.add(named || direct);
  }
  // A scan that found nothing would pass on nothing.
  assert.ok(variables.has('THING_ARN_PREFIX') && variables.has('SALESFORCE_LOGIN_URL'), `found only ${[...variables]}`);

  const fn = resource('DevicePresenceFunction');
  for (const name of variables) {
    assert.match(fn, new RegExp(`^ +${name}: \\S`, 'm'), `DevicePresenceFunction does not set ${name}`);
  }
  assert.match(fn, /^ +THING_ARN_PREFIX: !Sub 'arn:\$\{AWS::Partition\}:iot:\$\{AWS::Region\}:\$\{AWS::AccountId\}:thing\/'$/m);
  assert.match(fn, /^ +DEVICE_CONNECTION_ACTION: DeviceConnectionService$/m);
});

test('the rule passes on what the function reads, from both lifecycle topics, without live viewers', () => {
  const rule = resource('DevicePresenceIoTRule');
  const sql = rule.match(/Sql: "([^"]+)"/)[1];
  assert.equal(sql, "SELECT clientId, eventType, timestamp, disconnectReason, versionNumber FROM '$aws/events/presence/+/+' WHERE NOT startswith(clientId, 'live-')");
  assert.match(rule, /QueueUrl: !Ref PresenceQueue$/m);
  assert.match(resource('PresenceEventSourceMapping'), /FunctionResponseTypes: \[ReportBatchItemFailures\]/);
});
