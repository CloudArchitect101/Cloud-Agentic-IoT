'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadWithFakes, fakeSsm, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const root = path.join(__dirname, '../..');
const HANDLER = path.join(root, 'lambda/device-command-ack/index.js');
const VITALS = 'lambda/patient-vitals/cloudformation.yaml';
const RELAY = 'lambda/queue-relay/cloudformation.yaml';
const KEY_PARAMETER = '/cloud-agentic-iot/salesforce/jwt-private-key';
const INSTANCE = 'https://example.my.salesforce.com';
const ACTION_URL = `${INSTANCE}/services/data/v64.0/actions/custom/apex/DeviceCommandAckService`;

const ENV = {
  SALESFORCE_CLIENT_ID: 'consumer-key',
  SALESFORCE_USERNAME: 'integration@example.com',
  SALESFORCE_LOGIN_URL: 'https://login.salesforce.com',
  SALESFORCE_JWT_KEY_PARAMETER: KEY_PARAMETER,
  SALESFORCE_API_VERSION: '64.0',
  SALESFORCE_TOKEN_CACHE_MINUTES: '30',
  CONFIG_CACHE_SECONDS: '300',
  DEVICE_COMMAND_ACK_ACTION: 'DeviceCommandAckService',
};

const T = Date.parse('2026-11-06T06:30:00.000Z');
// A Device Command record's Id, which DeviceCommandSendJob sends as the commandId.
const ID = 'a0Bbm00000AbCdEFGH';

// What DeviceCommandAckIoTRule puts on the answer queue: what the board sent
// (commandId, operation, outcome and, when it has one, detail), the Thing
// name from the topic, and AWS IoT's clock.
const answer = (fields = {}) => ({
  commandId: ID, operation: 'DISPENSE_MEDICATION', outcome: 'done', thingName: 'Test7', answeredAtMillis: T, ...fields,
});

const queueBatch = (bodies) => ({
  Records: bodies.map((body, i) => ({
    messageId: `m-${i}`, body: typeof body === 'string' ? body : JSON.stringify(body), eventSource: 'aws:sqs',
  })),
});

// One result of the invocable action per input, as the REST API returns them.
const recorded = (input) => ({
  actionName: 'DeviceCommandAckService', isSuccess: true, errors: null,
  outputValues: { commandId: input.commandId, applied: true, skipped: null },
});
const skipped = (input, reason) => ({
  actionName: 'DeviceCommandAckService', isSuccess: true, errors: null,
  outputValues: { commandId: input.commandId, applied: false, skipped: reason },
});
const refused = (statusCode, message) => ({
  actionName: 'DeviceCommandAckService', isSuccess: false, errors: [{ statusCode, message }], outputValues: null,
});

/**
 * Loads the handler against a fake Salesforce. `respond(inputs, request)`
 * answers each call of the action; by default every answer is recorded.
 */
function load(t, { respond = (inputs) => jsonResponse(200, inputs.map(recorded)), env = {} } = {}) {
  withEnv(t, { ...ENV, ...env });
  const ssm = fakeSsm({ [KEY_PARAMETER]: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----' });
  const requests = fakeFetch(t, (request) => {
    if (request.url.endsWith('/services/oauth2/token')) {
      return jsonResponse(200, { access_token: 'token-1', instance_url: INSTANCE });
    }
    return respond(JSON.parse(request.body).inputs, request);
  });
  const { handler, COMMAND_ID } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-ssm': ssm.sdk,
    jsonwebtoken: { sign: () => 'signed-assertion' },
  });
  // The action's calls, without the token request.
  const calls = () => requests.filter((r) => !r.url.endsWith('/services/oauth2/token'));
  const inputs = () => calls().flatMap((r) => JSON.parse(r.body).inputs);
  return {
    handler, requests, calls, inputs, COMMAND_ID,
  };
}

const failedIds = (result) => result.batchItemFailures.map((failure) => failure.itemIdentifier);
const ids = (from, to) => Array.from({ length: to - from }, (_, n) => `m-${from + n}`);
const fields = (line) => JSON.parse(line.slice(line.indexOf('{')));

/** The invocation's one summary line, parsed. */
function summary(lines) {
  const found = lines.filter((line) => line.startsWith('Command answers sent to Salesforce '));
  assert.equal(found.length, 1, `one summary line per invocation, not ${found.length}`);
  return fields(found[0]);
}

const NOTHING = {
  sent: 0, applied: 0, skipped: 0, skippedReasons: {}, failed: 0, returned: 0,
};

/* ------------------------------------------------------------ what is sent */

test('each answer goes to DeviceCommandAckService as one input, in one call', async (t) => {
  const lines = captureConsole(t);
  const { handler, calls } = load(t);

  const result = await handler(queueBatch([
    answer({ detail: 'dispensed' }),
    answer({
      commandId: 'a0Bbm00000AbCdEFGI', operation: 'SET_TELEMETRY_INTERVAL', outcome: 'failed',
      detail: 'seconds must be 5-86400', thingName: 'Test8', answeredAtMillis: T + 1000,
    }),
    answer({
      commandId: 'a0Bbm00000AbCdEFGJ', operation: 'CALIBRATE', outcome: 'refused',
      detail: 'unknown operation CALIBRATE', thingName: 'Test9', answeredAtMillis: T + 2000,
    }),
  ]));

  assert.deepEqual(result, { batchItemFailures: [] });
  const [request] = calls();
  assert.equal(calls().length, 1);
  assert.equal(request.url, ACTION_URL);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer token-1');
  // No operation: the command has its own.
  assert.deepEqual(JSON.parse(request.body), {
    inputs: [
      { commandId: ID, thingName: 'Test7', outcome: 'done', detail: 'dispensed', answeredAtMillis: T },
      {
        commandId: 'a0Bbm00000AbCdEFGI', thingName: 'Test8', outcome: 'failed',
        detail: 'seconds must be 5-86400', answeredAtMillis: T + 1000,
      },
      {
        commandId: 'a0Bbm00000AbCdEFGJ', thingName: 'Test9', outcome: 'refused',
        detail: 'unknown operation CALIBRATE', answeredAtMillis: T + 2000,
      },
    ],
  });
  assert.deepEqual(summary(lines), {
    answers: 3, dropped: {}, commands: 3, ...NOTHING, sent: 3, applied: 3,
  });
});

test('a detail goes on as text of at most 255 characters, and anything else as no detail', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);
  const DETAILS = [
    [undefined, null],    // the board had none, and the rule leaves it out
    [null, null],
    [42, null],
    [true, null],
    [['stored'], null],
    [{ text: 'stored' }, null],
    ['', ''],
    ['every 60 s for 15 min', 'every 60 s for 15 min'],
    ['x'.repeat(255), 'x'.repeat(255)],
    // Within the limit, a detail goes on as it came, whatever it ends with.
    [`${'x'.repeat(254)}\uD83D`, `${'x'.repeat(254)}\uD83D`],
    ['x'.repeat(300), 'x'.repeat(255)],
    // Never half a character: this emoji is two UTF-16 units, here the 255th and 256th.
    [`${'x'.repeat(254)}😀`, 'x'.repeat(254)],
    [`${'x'.repeat(253)}😀`, `${'x'.repeat(253)}😀`],
    [`${'x'.repeat(253)}😀yy`, `${'x'.repeat(253)}😀`],
  ];

  await handler(queueBatch(DETAILS.map(([detail], n) => answer({ commandId: `c-${n}`, detail }))));

  assert.deepEqual(inputs().map((input) => input.detail), DETAILS.map(([, sent]) => sent));
});

/* ------------------------------------------------------------- drop rules */

// Each is dropped with a log line and never retried: no retry makes it usable.
const DROPS = [
  ['a body that is not JSON', 'not json at all', 'malformed'],
  ['JSON that is not an object', '"done"', 'malformed'],
  ['a null body', 'null', 'malformed'],
  ['a JSON list', JSON.stringify([answer()]), 'malformed'],
  ['an answer without a commandId', answer({ commandId: undefined }), 'commandId'],
  ['an empty commandId', answer({ commandId: '' }), 'commandId'],
  ['a commandId longer than 40 characters', answer({ commandId: 'x'.repeat(41) }), 'commandId'],
  ['a commandId with a space', answer({ commandId: 'a0B m' }), 'commandId'],
  ['a commandId with a slash', answer({ commandId: 'a0B/m' }), 'commandId'],
  ['a commandId that is not a string', answer({ commandId: 7 }), 'commandId'],
  ['an answer without a thingName', answer({ thingName: undefined }), 'thingName'],
  ['a thingName with a space', answer({ thingName: 'Test 7' }), 'thingName'],
  ['a thingName longer than 128 characters', answer({ thingName: 'x'.repeat(129) }), 'thingName'],
  ['a thingName that is not a string', answer({ thingName: 7 }), 'thingName'],
  ['an answer without an outcome', answer({ outcome: undefined }), 'outcome'],
  ['an outcome the board never sends', answer({ outcome: 'acked' }), 'outcome'],
  ['an outcome in capitals', answer({ outcome: 'DONE' }), 'outcome'],
  ['a result where the outcome should be', answer({ outcome: undefined, result: 'done' }), 'outcome'],
  ['an answer without answeredAtMillis', answer({ answeredAtMillis: undefined }), 'answeredAt'],
  ['answeredAtMillis as text', answer({ answeredAtMillis: String(T) }), 'answeredAt'],
  ['answeredAtMillis that is not a whole number', answer({ answeredAtMillis: T + 0.5 }), 'answeredAt'],
  ['answeredAtMillis of 0', answer({ answeredAtMillis: 0 }), 'answeredAt'],
  ['negative answeredAtMillis', answer({ answeredAtMillis: -T }), 'answeredAt'],
];

// What each drop's log line says.
const SAYS = {
  malformed: /: not JSON, or not a JSON object \{/,
  commandId: /: its commandId is not 1 to 40 letters, digits, _ or - \{/,
  thingName: /: its thingName, the second level of its topic, is not an AWS IoT Thing name/,
  outcome: /: its outcome is not done, failed or refused \{/,
  answeredAt: /: its answeredAtMillis is not a whole number of epoch milliseconds/,
};

for (const [name, body, reason] of DROPS) {
  test(`drops ${name}, with a log line, and never retries it`, async (t) => {
    const lines = captureConsole(t);
    const { handler, requests } = load(t);

    const result = await handler(queueBatch([body]));

    assert.deepEqual(result, { batchItemFailures: [] });
    // Nothing to send is no call at all, not even for a token.
    assert.equal(requests.length, 0);
    const line = lines.find((l) => l.startsWith('Dropped a command answer: '));
    assert.ok(line, `no drop line in ${JSON.stringify(lines)}`);
    assert.match(line, SAYS[reason]);
    assert.match(line, /"messageId":"m-0"/);
    assert.deepEqual(summary(lines), {
      answers: 1, dropped: { [reason]: 1 }, commands: 0, ...NOTHING,
    });
  });
}

test('the first rule an answer breaks is the one counted', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t);
  await handler(queueBatch([
    answer({ commandId: '', thingName: '', outcome: 'acked', answeredAtMillis: 0 }),
    answer({ thingName: '', outcome: 'acked', answeredAtMillis: 0 }),
    answer({ outcome: 'acked', answeredAtMillis: 0 }),
  ]));
  assert.deepEqual(summary(lines).dropped, { commandId: 1, thingName: 1, outcome: 1 });
});

test('a drop line says what it safely can of the answer, and never its detail', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t);

  await handler(queueBatch([
    answer({ outcome: 'acked', detail: 'private-c0ffee' }),
    // An operation is cut to 64 characters, and a name or id that breaks its rule is left out.
    answer({
      commandId: 'not an id', thingName: 'Test 7', operation: 'x'.repeat(100), detail: 'private-c0ffee',
    }),
    answer({ commandId: undefined, operation: 7 }),
  ]));

  const drops = lines.filter((line) => line.startsWith('Dropped a command answer: '));
  assert.deepEqual(drops.map(fields), [
    {
      messageId: 'm-0', commandId: ID, thingName: 'Test7', operation: 'DISPENSE_MEDICATION',
    },
    { messageId: 'm-1', operation: 'x'.repeat(64) },
    { messageId: 'm-2', thingName: 'Test7' },
  ]);
  assert.ok(!lines.some((line) => line.includes('c0ffee')), lines.join('\n'));
});

test('a dropped answer plays no part, and the rest of the batch goes on', async (t) => {
  const lines = captureConsole(t);
  const { handler, inputs } = load(t);

  const result = await handler(queueBatch([
    answer({ commandId: 'c-1' }),
    'not json',
    answer({ commandId: 'c-2', outcome: 'acked' }),
    answer({
      commandId: 'c-3', thingName: 'Test8', outcome: 'refused', detail: 'unknown operation PING',
    }),
    '[]',
  ]));

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(inputs(), [
    {
      commandId: 'c-1', thingName: 'Test7', outcome: 'done', detail: null, answeredAtMillis: T,
    },
    {
      commandId: 'c-3', thingName: 'Test8', outcome: 'refused', detail: 'unknown operation PING', answeredAtMillis: T,
    },
  ]);
  assert.deepEqual(summary(lines).dropped, { malformed: 2, outcome: 1 });
});

test('an empty batch is no call', async (t) => {
  const lines = captureConsole(t);
  const { handler, requests } = load(t);
  assert.deepEqual(await handler({ Records: [] }), { batchItemFailures: [] });
  assert.deepEqual(await handler({}), { batchItemFailures: [] });
  assert.equal(requests.length, 0);
  const summaries = lines.filter((line) => line.startsWith('Command answers sent to Salesforce '));
  assert.deepEqual(summaries.map((line) => fields(line).answers), [0, 0]);
});

/* ------------------------------------------- one input per command and board */

test('an answer delivered twice is one input', async (t) => {
  const lines = captureConsole(t);
  const { handler, inputs } = load(t);
  await handler(queueBatch([answer({ detail: 'dispensed' }), answer({ detail: 'dispensed' })]));
  assert.equal(inputs().length, 1);
  assert.deepEqual(summary(lines), {
    answers: 2, dropped: {}, commands: 1, ...NOTHING, sent: 1, applied: 1,
  });
});

test('a command its board answered twice goes on with the earliest answer, the one with the board\'s own detail', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);

  // A board sent one command twice answers the second time with the outcome
  // it remembers. SQS keeps no order, so the repeat may come first.
  await handler(queueBatch([
    answer({ detail: 'already carried out', answeredAtMillis: T + 4000 }),
    answer({ detail: 'dispensed', answeredAtMillis: T }),
    answer({ detail: 'already carried out', answeredAtMillis: T + 9000 }),
    answer({
      commandId: 'c-2', outcome: 'failed', detail: 'seconds must be 5-86400', answeredAtMillis: T + 100,
    }),
    answer({
      commandId: 'c-2', outcome: 'failed', detail: 'already carried out', answeredAtMillis: T + 200,
    }),
  ]));

  assert.deepEqual(inputs(), [
    {
      commandId: ID, thingName: 'Test7', outcome: 'done', detail: 'dispensed', answeredAtMillis: T,
    },
    {
      commandId: 'c-2', thingName: 'Test7', outcome: 'failed', detail: 'seconds must be 5-86400', answeredAtMillis: T + 100,
    },
  ]);
});

test('on the same millisecond, the first answer in the batch goes on', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);
  await handler(queueBatch([answer({ detail: 'first' }), answer({ detail: 'second' })]));
  assert.deepEqual(inputs().map((input) => input.detail), ['first']);
});

test('two boards answering one command are two inputs, so the wrong one never stands in for the right one', async (t) => {
  captureConsole(t);
  const { handler, inputs } = load(t);
  // DeviceCommandAckService records the answer from the command's own device and skips the other.
  await handler(queueBatch([answer({ thingName: 'Test8', answeredAtMillis: T - 50 }), answer()]));
  assert.deepEqual(inputs().map(({ commandId, thingName }) => [commandId, thingName]), [[ID, 'Test8'], [ID, 'Test7']]);
});

/* ---------------------------------------------------------------- chunks */

test('450 answers go in three calls of at most 200', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const result = await handler(queueBatch(Array.from({ length: 450 }, (_, n) => answer({ commandId: `c-${n}` }))));
  assert.deepEqual(result.batchItemFailures, []);
  assert.deepEqual(calls().map((r) => JSON.parse(r.body).inputs.length), [200, 200, 50]);
});

/* --------------------------------------------------------------- failures */

/**
 * 450 commands, one answer each (m-0 to m-449), so the calls are c-0..199,
 * c-200..399 and c-400..449. Then a repeat of c-250's answer (m-450), in the
 * second call; an answer without an outcome (m-451), which is dropped; and a
 * repeat of c-10's (m-452), in the first call.
 */
const threeCalls = () => queueBatch([
  ...Array.from({ length: 450 }, (_, n) => answer({ commandId: `c-${n}` })),
  answer({ commandId: 'c-250', detail: 'already carried out', answeredAtMillis: T + 1000 }),
  answer({ commandId: 'c-300', outcome: undefined }),
  answer({ commandId: 'c-10', detail: 'already carried out', answeredAtMillis: T + 1000 }),
]);

test('a call Salesforce fails returns exactly the messages that fed it, and the other calls go on', async (t) => {
  const lines = captureConsole(t);
  let n = 0;
  const { handler, calls } = load(t, {
    respond: (inputs) => (++n === 2
      ? jsonResponse(503, [{ errorCode: 'SERVER_UNAVAILABLE', message: 'Try again later' }])
      : jsonResponse(200, inputs.map(recorded))),
  });

  const result = await handler(threeCalls());

  assert.equal(calls().length, 3);
  // The second call's 200 commands, with the repeat of c-250; not the
  // dropped answer, and nothing of the first or third call.
  assert.deepEqual(failedIds(result).sort(), [...ids(200, 400), 'm-450'].sort());
  const logged = lines.find((line) => line.startsWith('Salesforce did not take a call'));
  assert.match(logged, /"status":503/);
  assert.match(logged, /"commands":200/);
  assert.deepEqual(summary(lines), {
    answers: 453, dropped: { outcome: 1 }, commands: 450, ...NOTHING, sent: 250, applied: 250, returned: 201,
  });
});

test('a call that never reaches Salesforce returns its messages too', async (t) => {
  captureConsole(t);
  let n = 0;
  const { handler } = load(t, {
    respond: (inputs) => {
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
    respond: (inputs) => jsonResponse(200, inputs.map((input) => (input.commandId === 'c-8'
      ? refused('UNKNOWN_EXCEPTION', 'Something went wrong in DeviceCommandAckService')
      : recorded(input)))),
  });

  const result = await handler(queueBatch([
    answer({ commandId: 'c-7' }), answer({ commandId: 'c-8', thingName: 'Test8' }), answer({ commandId: 'c-9' }),
  ]));

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(calls().length, 1);
  const logged = lines.filter((line) => line.startsWith('Salesforce did not record a command answer'));
  assert.equal(logged.length, 1);
  assert.deepEqual(fields(logged[0]), {
    commandId: 'c-8',
    thingName: 'Test8',
    operation: 'DISPENSE_MEDICATION',
    errors: [{ statusCode: 'UNKNOWN_EXCEPTION', message: 'Something went wrong in DeviceCommandAckService' }],
  });
  assert.deepEqual(summary(lines), {
    answers: 3, dropped: {}, commands: 3, ...NOTHING, sent: 3, applied: 2, failed: 1,
  });
});

test('a result missing from the answer counts as not recorded, and is not retried', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, { respond: (inputs) => jsonResponse(200, inputs.slice(1).map(recorded)) });
  const result = await handler(queueBatch([answer({ commandId: 'c-7' }), answer({ commandId: 'c-8' })]));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(summary(lines).failed, 1);
});

test('an answer from Salesforce that is not a list of results counts every input as not recorded', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, { respond: () => jsonResponse(200, null) });
  const result = await handler(queueBatch([answer({ commandId: 'c-7' }), answer({ commandId: 'c-8' })]));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(summary(lines), {
    answers: 2, dropped: {}, commands: 2, ...NOTHING, sent: 2, failed: 2,
  });
});

test('an answer that changed no command is logged with its reason, counted by reason, and not retried', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, {
    respond: (inputs) => jsonResponse(200, inputs.map((input) => {
      if (input.commandId === 'c-1') return recorded(input);
      if (input.commandId === 'c-4') return skipped(input, 'No Device Command has this Id.');
      return skipped(input, 'The command was answered already.');
    })),
  });

  const result = await handler(queueBatch([
    answer({ commandId: 'c-1' }),
    answer({ commandId: 'c-2', operation: 'RESTART' }),
    answer({ commandId: 'c-3' }),
    answer({ commandId: 'c-4', thingName: 'Test8' }),
  ]));

  assert.deepEqual(result, { batchItemFailures: [] });
  const logged = lines.filter((line) => line.startsWith('An answer changed no Device Command '));
  assert.deepEqual(logged.map(fields), [
    {
      commandId: 'c-2', thingName: 'Test7', operation: 'RESTART', reason: 'The command was answered already.',
    },
    {
      commandId: 'c-3', thingName: 'Test7', operation: 'DISPENSE_MEDICATION', reason: 'The command was answered already.',
    },
    {
      commandId: 'c-4', thingName: 'Test8', operation: 'DISPENSE_MEDICATION', reason: 'No Device Command has this Id.',
    },
  ]);
  assert.deepEqual(summary(lines), {
    answers: 4,
    dropped: {},
    commands: 4,
    ...NOTHING,
    sent: 4,
    applied: 1,
    skipped: 3,
    skippedReasons: { 'The command was answered already.': 2, 'No Device Command has this Id.': 1 },
  });
});

test('a result that neither applied the answer nor says why counts as skipped, and is not retried', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, {
    respond: (inputs) => jsonResponse(200, inputs.map((input, n) => [
      { ...recorded(input), outputValues: { commandId: input.commandId, applied: false } },
      { ...recorded(input), outputValues: null },
      { ...recorded(input), outputValues: { commandId: input.commandId, applied: 'true', skipped: null } },
    ][n])),
  });

  const result = await handler(queueBatch([answer({ commandId: 'c-1' }), answer({ commandId: 'c-2' }), answer({ commandId: 'c-3' })]));

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(summary(lines), {
    answers: 3,
    dropped: {},
    commands: 3,
    ...NOTHING,
    sent: 3,
    skipped: 3,
    skippedReasons: { 'DeviceCommandAckService gave no reason': 3 },
  });
});

/* ------------------------------------------------------------ the action */

test('the action is the one DEVICE_COMMAND_ACK_ACTION names', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, { env: { DEVICE_COMMAND_ACK_ACTION: 'DeviceCommandAckServiceV2' } });
  await handler(queueBatch([answer()]));
  assert.equal(calls()[0].url, `${INSTANCE}/services/data/v64.0/actions/custom/apex/DeviceCommandAckServiceV2`);
});

test('a missing DEVICE_COMMAND_ACK_ACTION fails the batch by name, before any call', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t, { env: { DEVICE_COMMAND_ACK_ACTION: undefined } });
  await assert.rejects(handler(queueBatch([answer()])), /DEVICE_COMMAND_ACK_ACTION is not set/);
  assert.equal(requests.length, 0);
});

test('COMMAND_ID is exported, for the check that the board and both functions agree', (t) => {
  const { COMMAND_ID } = load(t);
  assert.ok(COMMAND_ID instanceof RegExp);
  assert.equal(COMMAND_ID.source, '^[A-Za-z0-9_-]{1,40}$');
  assert.equal(COMMAND_ID.flags, '');
});

/* ------------------------------------------------------------------ logs */

test('no whole answer is ever logged, nor any detail', async (t) => {
  const lines = captureConsole(t);
  let n = 0;
  const { handler } = load(t, {
    respond: (inputs) => {
      n += 1;
      if (n === 1) return jsonResponse(500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'boom' }]);
      return jsonResponse(200, inputs.map((input, i) => [
        refused('UNKNOWN_EXCEPTION', 'boom'), skipped(input, 'The command was answered already.'),
      ][i] || recorded(input)));
    },
  });
  // The board's own text, which only the command's Status_Detail__c may hold.
  const detail = 'private-c0ffee';
  const bodies = [
    ...Array.from({ length: 203 }, (_, i) => answer({ commandId: `c-${i}`, detail })),
    answer({ outcome: 'acked', detail }),
    answer({ commandId: 'not an id', detail }),
    'not json, but private-c0ffee all the same',
  ];

  await handler(queueBatch(bodies));

  assert.ok(lines.length > 0);
  const batch = queueBatch(bodies);
  for (const line of lines) {
    // A detail, a call's inputs, or an answer's own fields would mean an answer went into the logs.
    assert.doesNotMatch(line, /c0ffee|"(?:detail|answeredAtMillis|inputs)"/, line);
    for (const { body } of batch.Records) assert.ok(!line.includes(body), line);
  }
});

/* --------------------------------------------------------------- template */

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const IOT = '!Sub arn:${AWS::Partition}:iot:${AWS::Region}:${AWS::AccountId}:';
const SQL = "SELECT commandId, operation, outcome, detail, topic(2) AS thingName, timestamp() AS answeredAtMillis FROM 'device/+/ack'";

const indent = (line) => line.search(/\S/);
const isContent = (line) => line.trim() !== '' && !line.trim().startsWith('#');

/** Each resource's lines in a template, by its name, without comments or blank lines. */
function resources(file) {
  const found = new Map();
  let section = null;
  let body = null;
  for (const line of source(file).split(/\r?\n/)) {
    if (!isContent(line)) continue;
    if (indent(line) === 0) {
      section = line;
      continue;
    }
    if (section !== 'Resources:') continue;
    const name = line.match(/^ {2}(\w+):$/);
    if (name) {
      body = [];
      found.set(name[1], body);
    } else {
      assert.ok(body && indent(line) > 2, `${file} has a line in Resources this test cannot read: ${line.trim()}`);
      body.push(line);
    }
  }
  return found;
}

/**
 * One resource, read into plain objects, as test/lambda/live-viewer-role.test.js
 * reads them: the repo has no YAML parser, and one would have to be taught the
 * template's tags anyway. It reads the block style the templates are written
 * in: "Key: value", "Key:" over a block, "- " lists, a { Key: value } pair, a
 * [flow, list] of plain values, a quoted value, text after >- or |, and
 * comments on lines of their own. A tag stays in its value as text
 * ("!GetAtt CommandAckQueue.Arn"). Anything else fails the test, so it
 * cannot pass on a shape it misread.
 */
function resource(file, name) {
  const body = resources(file).get(name);
  assert.ok(body, `${file} declares no resource ${name}`);
  const entries = body.map((line) => ({ depth: indent(line), text: line.trim() }));
  const [value, next] = block(entries, 0, name);
  assert.equal(next, entries.length, `${name} has a line this test cannot read: ${(entries[next] || {}).text}`);
  return value;
}

const KEY = /^([A-Za-z][\w.:-]*):(?: (.+))?$/;

/** The list or mapping that starts at entries[at], and the index after it. */
function block(entries, at, where) {
  const { depth } = entries[at];
  if (!entries[at].text.startsWith('- ')) return mapping(entries, at, depth, where);
  const items = [];
  while (at < entries.length && entries[at].depth === depth && entries[at].text.startsWith('- ')) {
    // The item's first line, read as though it began two columns in, where the rest of the item is.
    const item = [{ depth: depth + 2, text: entries[at].text.slice(2) }];
    for (at += 1; at < entries.length && entries[at].depth > depth; at += 1) item.push(entries[at]);
    if (item.length === 1 && !KEY.test(item[0].text)) {
      items.push(scalar(item[0].text, where));
    } else {
      const [value, next] = block(item, 0, where);
      assert.equal(next, item.length, `${where} has a line this test cannot read: ${(item[next] || {}).text}`);
      items.push(value);
    }
  }
  return [items, at];
}

function mapping(entries, at, depth, where) {
  const map = {};
  while (at < entries.length && entries[at].depth === depth) {
    const pair = entries[at].text.match(KEY);
    assert.ok(pair, `${where} has a line this test cannot read: ${entries[at].text}`);
    const [, key, value] = pair;
    assert.ok(!Object.hasOwn(map, key), `${where} sets ${key} twice`);
    at += 1;
    if (value === undefined) {
      assert.ok(at < entries.length && entries[at].depth > depth, `${where}: ${key} has no value`);
      [map[key], at] = block(entries, at, where);
    } else if (/^[>|]-?$/.test(value)) {
      const text = [];
      for (; at < entries.length && entries[at].depth > depth; at += 1) text.push(entries[at].text);
      map[key] = text.join(value.startsWith('>') ? ' ' : '\n');
    } else {
      map[key] = scalar(value, where);
    }
  }
  return [map, at];
}

function scalar(text, where) {
  const tagged = text.match(/^(![A-Za-z]+) (.+)$/);
  if (tagged) return `${tagged[1]} ${scalar(tagged[2], where)}`;
  const quoted = text.match(/^'((?:[^']|'')*)'$/);
  if (quoted) return quoted[1].replace(/''/g, "'");
  // A double-quoted value without escapes, as the rules' Sql is written.
  const doubleQuoted = text.match(/^"([^"\\]*)"$/);
  if (doubleQuoted) return doubleQuoted[1];
  const pair = text.match(/^\{ *([A-Za-z][\w.:-]*): ([^{}]+?) *\}$/);
  if (pair) return { [pair[1]]: scalar(pair[2], where) };
  // A flow list of plain values, as FunctionResponseTypes is written.
  const flow = text.match(/^\[([^[\]{}'"]+)\]$/);
  if (flow) return flow[1].split(',').map((item) => scalar(item.trim(), where));
  // Another quote, a nested [flow list], an anchor, or a comment after the
  // value is a shape this reader does not take apart.
  assert.ok(/^[^'"[\]{}&*!|>%@`#]/.test(text) && !/\s#|: /.test(text), `${where} has a value this test cannot read: ${text}`);
  return text;
}

const listOf = (value) => (Array.isArray(value) ? value : [value]);

/** Every "action on resource" a policy document allows, with the condition it is allowed under. */
function grants(document, where) {
  assert.equal(document.Version, '2012-10-17', `${where}: Version`);
  assert.ok(Array.isArray(document.Statement) && document.Statement.length, `${where} has no statements`);
  return document.Statement.flatMap(({
    Effect, Action, Resource, Condition, ...other
  }) => {
    // A Deny or a NotAction would change what "exactly" means here.
    assert.deepEqual(Object.keys(other), [], `${where} has a statement with ${Object.keys(other).join(', ')}, which this test does not read`);
    assert.equal(Effect, 'Allow', `${where} has a statement that is not an Allow`);
    const when = Condition === undefined ? '' : ` when ${JSON.stringify(Condition)}`;
    return listOf(Action).flatMap((action) => listOf(Resource).map((on) => `${action} on ${on}${when}`));
  });
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
const SOURCES = [...sourcesOf('lambda/device-command-ack/index.js')];

test('the rule passes on what the function reads, from every board\'s ack topic, to the answer queue', () => {
  assert.deepEqual(resource(VITALS, 'DeviceCommandAckIoTRule'), {
    Type: 'AWS::IoT::TopicRule',
    Properties: {
      RuleName: 'cloud_agentic_iot_device_command_ack',
      TopicRulePayload: {
        Sql: SQL,
        AwsIotSqlVersion: '2016-03-23',
        RuleDisabled: 'false',
        Actions: [{ Sqs: { QueueUrl: '!Ref CommandAckQueue', RoleArn: '!GetAtt IoTRuleRole.Arn', UseBase64: 'false' } }],
        // An answer the rule cannot deliver is logged, not lost.
        ErrorAction: { CloudwatchLogs: { LogGroupName: '!Ref CommandAckRuleErrorLogGroup', RoleArn: '!GetAtt IoTRuleRole.Arn' } },
      },
    },
  });
  // The fields it passes on are the ones this test's answers carry.
  const selected = SQL.match(/^SELECT (.+) FROM /)[1].split(', ').map((field) => field.split(' AS ').pop());
  assert.deepEqual(selected.sort(), Object.keys(answer({ detail: 'stored' })).sort());

  assert.deepEqual(resource(VITALS, 'CommandAckRuleErrorLogGroup'), {
    Type: 'AWS::Logs::LogGroup',
    Properties: { LogGroupName: '/cloud-agentic-iot/iot-rule-errors/device-command-ack', RetentionInDays: '!Ref LogRetentionDays' },
  });
  const delivers = resource(VITALS, 'IoTRuleRole').Properties.Policies
    .flatMap((policy) => grants(policy.PolicyDocument, `IoTRuleRole ${policy.PolicyName}`));
  for (const grant of [
    'sqs:SendMessage on !GetAtt CommandAckQueue.Arn',
    'logs:CreateLogStream on !GetAtt CommandAckRuleErrorLogGroup.Arn',
    'logs:PutLogEvents on !GetAtt CommandAckRuleErrorLogGroup.Arn',
  ]) {
    assert.ok(delivers.includes(grant), `IoTRuleRole does not allow ${grant}`);
  }
});

test('answers wait in a queue of their own, which hands a message that failed every retry to a dead-letter queue', () => {
  const queue = resource(VITALS, 'CommandAckQueue');
  assert.deepEqual(queue, {
    Type: 'AWS::SQS::Queue',
    Properties: {
      QueueName: 'cloud-agentic-iot-device-command-ack',
      VisibilityTimeout: '360',
      MessageRetentionPeriod: '!Ref QueueRetentionSeconds',
      SqsManagedSseEnabled: 'true',
      RedrivePolicy: { deadLetterTargetArn: '!GetAtt CommandAckDeadLetterQueue.Arn', maxReceiveCount: '!Ref QueueMaxReceiveCount' },
    },
  });
  // Six times the function's timeout, as AWS advises for an SQS event source.
  assert.equal(Number(queue.Properties.VisibilityTimeout), 6 * Number(resource(VITALS, 'DeviceCommandAckFunction').Properties.Timeout));
  assert.deepEqual(resource(VITALS, 'CommandAckDeadLetterQueue'), {
    Type: 'AWS::SQS::Queue',
    Properties: { QueueName: 'cloud-agentic-iot-device-command-ack-dlq', MessageRetentionPeriod: '1209600', SqsManagedSseEnabled: 'true' },
  });
});

test('the function takes answers as they come, at most 10 at a time, and at most two calls at once', () => {
  assert.deepEqual(resource(VITALS, 'CommandAckEventSourceMapping'), {
    Type: 'AWS::Lambda::EventSourceMapping',
    Properties: {
      EventSourceArn: '!GetAtt CommandAckQueue.Arn',
      FunctionName: '!Ref DeviceCommandAckFunction',
      // Without a batching window, an SQS event source takes at most 10 a batch.
      BatchSize: '10',
      MaximumBatchingWindowInSeconds: '0',
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: '2' },
    },
  });
});

test('the function: the name deploy-aws.sh packages its source under, its runtime and limits, and the settings it reads', () => {
  const { Code, Environment, ...properties } = resource(VITALS, 'DeviceCommandAckFunction').Properties;
  assert.deepEqual(properties, {
    // cloud-agentic-iot-<its directory under lambda/>, or deploy-aws.sh leaves the placeholder running.
    FunctionName: 'cloud-agentic-iot-device-command-ack',
    Runtime: 'nodejs22.x',
    Handler: 'index.handler',
    Role: '!GetAtt DeviceCommandAckRole.Arn',
    Timeout: '60',
    MemorySize: '256',
  });
  assert.match(Code.ZipFile, /Placeholder - the deploy pipeline replaces this with the real bundle/);

  // device-presence's Salesforce settings, and the action.
  const presence = resource(VITALS, 'DevicePresenceFunction').Properties.Environment.Variables;
  const salesforce = Object.fromEntries(Object.entries(presence)
    .filter(([name]) => name.startsWith('SALESFORCE_') || name === 'CONFIG_CACHE_SECONDS'));
  assert.equal(Object.keys(salesforce).length, 7);
  assert.deepEqual(Environment.Variables, { ...salesforce, DEVICE_COMMAND_ACK_ACTION: 'DeviceCommandAckService' });

  // And every variable the function or the shared code it runs reads.
  const variables = new Set();
  for (const file of SOURCES) {
    const reads = source(file).matchAll(/\b(?:requiredEnv|numberEnv|booleanEnv)\('([A-Z0-9_]+)'\)|process\.env\.([A-Z0-9_]+)/g);
    for (const [, named, direct] of reads) variables.add(named || direct);
  }
  // A scan that found nothing would pass on nothing.
  assert.ok(variables.has('DEVICE_COMMAND_ACK_ACTION') && variables.has('SALESFORCE_LOGIN_URL'), `found only ${[...variables]}`);
  for (const name of variables) {
    assert.ok(Object.hasOwn(Environment.Variables, name), `DeviceCommandAckFunction does not set ${name}`);
  }
});

test('DeviceCommandAckRole may make every call the function makes, and no other, and only the function runs as it', () => {
  const role = resource(VITALS, 'DeviceCommandAckRole');
  assert.equal(role.Type, 'AWS::IAM::Role');
  const { AssumeRolePolicyDocument, ManagedPolicyArns, Policies, ...other } = role.Properties;
  assert.deepEqual(Object.keys(other), [], 'DeviceCommandAckRole may have no properties beyond its trust and its policies');
  assert.deepEqual(AssumeRolePolicyDocument, {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  });
  // Its own logs, and nothing else.
  assert.deepEqual(listOf(ManagedPolicyArns), ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']);

  // The AWS calls in the function's sources, the shared code it requires
  // included: every name ending in Command counts, however it is used. A
  // scan that found none would let this test pass on nothing.
  const NEEDS = {
    // The Salesforce key, a SecureString that SSM decrypts with KMS on the function's behalf.
    GetParameter: [
      'ssm:GetParameter on !Sub arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter${SalesforceJwtKeyParameterName}',
      'kms:Decrypt on * when {"StringEquals":{"kms:ViaService":"!Sub ssm.${AWS::Region}.amazonaws.com"}}',
    ],
  };
  const calls = [...new Set(SOURCES.flatMap((file) => [...source(file).matchAll(/\b(\w+)Command\b/g)].map(([, operation]) => operation)))];
  assert.deepEqual(calls.sort(), Object.keys(NEEDS).sort(), `${SOURCES.join(', ')} make calls this test does not list. Add each `
    + 'to NEEDS, with what AWS checks it against, allow it in DeviceCommandAckRole, and drop from both what they no longer call.');
  // What Lambda does as the role to hand the function the answer queue's messages.
  const QUEUE = ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes']
    .map((action) => `${action} on !GetAtt CommandAckQueue.Arn`);
  const allowed = listOf(Policies).flatMap((policy) => grants(policy.PolicyDocument, `DeviceCommandAckRole ${policy.PolicyName}`));
  assert.deepEqual(allowed.sort(), [...QUEUE, ...Object.values(NEEDS).flat()].sort());

  const naming = [...resources(VITALS)]
    .filter(([name, body]) => name !== 'DeviceCommandAckRole' && body.some((line) => /\bDeviceCommandAckRole\b/.test(line)))
    .map(([name]) => name);
  assert.deepEqual(naming, ['DeviceCommandAckFunction'], `resources that name DeviceCommandAckRole in ${VITALS}`);
});

test('an answer that failed every retry raises an alarm, as a connection change does', () => {
  // PresenceDeadLetterAlarm's, but for the answer dead-letter queue and in its own words.
  const text = (name) => resources(VITALS).get(name).join('\n');
  const general = (alarm) => alarm
    .replace(/^( +(?:AlarmName|AlarmDescription)): .*$/gm, '$1: ...')
    .replace(/!GetAtt \w+DeadLetterQueue\.QueueName/, '!GetAtt ...DeadLetterQueue.QueueName');
  const alarm = text('CommandAckDeadLetterAlarm');
  assert.equal(general(alarm), general(text('PresenceDeadLetterAlarm')));
  assert.match(alarm, /^ +AlarmName: cloud-agentic-iot-device-command-ack-dead-letters$/m);
  assert.match(alarm, /^ +Value: !GetAtt CommandAckDeadLetterQueue\.QueueName$/m);
  assert.match(alarm, /^ +AlarmDescription: .+ Inspect cloud-agentic-iot-device-command-ack-dlq and the device-command-ack logs\.$/m);
});

// AWS IoT disconnects a board that publishes where its policy does not
// allow, so a board on firmware 2.2.0 or later without this line would drop
// off each time it answered a command.
test('each board may publish answers to its own ack topic, the one the rule reads, and to no other', () => {
  const statements = listOf(resource(RELAY, 'DevicePolicy').Properties.PolicyDocument.Statement);
  const ack = statements.flatMap((statement) => listOf(statement.Resource)
    .filter((on) => /\/ack\b/.test(on))
    .map((on) => `${listOf(statement.Action).join(', ')} on ${on}`));
  // ${!...} keeps AWS IoT's own policy variable away from !Sub; IoT resolves it per connection.
  assert.deepEqual(ack, [`iot:Publish on ${IOT}topic/device/\${!iot:Connection.Thing.ThingName}/ack`]);
  // The rule reads that topic for every board: + where the policy has the board's own name.
  const from = SQL.match(/ FROM '([^']+)'$/)[1];
  assert.equal(`topic/${from.replace('/+/', '/${!iot:Connection.Thing.ThingName}/')}`, ack[0].slice(`iot:Publish on ${IOT}`.length));
});
