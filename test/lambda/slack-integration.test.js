'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  loadWithFakes, fakeAwsSdk, fakeSsm, fakeDynamoDb, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/slack-integration/index.js');
const SECRET = 'test-signing-secret';
const HOOK = 'https://hooks.slack.com/commands/T1/2/abc';
const INSTANCE = 'https://acme.my.salesforce.com';

function load(t, {
  salesforce = () => jsonResponse(200, { records: [] }), slack = () => new Response('ok'), readings = [], dynamoFails = false,
} = {}) {
  withEnv(t, {
    AWS_LAMBDA_FUNCTION_NAME: 'cloud-agentic-iot-slack-integration',
    SLACK_SIGNING_SECRET_PARAMETER: '/slack/secret',
    SALESFORCE_CLIENT_ID: 'consumer-key',
    SALESFORCE_USERNAME: 'integration@example.com',
    SALESFORCE_LOGIN_URL: 'https://test.salesforce.com',
    SALESFORCE_JWT_KEY_PARAMETER: '/key',
    SALESFORCE_API_VERSION: '64.0',
    SALESFORCE_TOKEN_CACHE_MINUTES: '30',
    CONFIG_CACHE_SECONDS: '300',
    TABLE_NAME: 'patient-vitals',
    OFFLINE_AFTER_MINUTES: '5',
  });
  const requests = fakeFetch(t, (request) => {
    if (request.url.endsWith('/services/oauth2/token')) {
      return jsonResponse(200, { access_token: 'token', instance_url: INSTANCE });
    }
    if (request.url.startsWith(HOOK)) return slack(request);
    return salesforce(request);
  });
  const lambda = fakeAwsSdk('LambdaClient', ['InvokeCommand']);
  const db = fakeDynamoDb(readings, {
    fail: () => { if (dynamoFails) throw new Error('ProvisionedThroughputExceededException'); },
  });
  const { handler } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': db.sdk,
    '@aws-sdk/client-lambda': lambda.sdk,
    '@aws-sdk/client-ssm': fakeSsm({ '/slack/secret': SECRET, '/key': 'pem' }).sdk,
    jsonwebtoken: { sign: () => 'assertion' },
  });
  return { handler, requests, invokes: lambda.calls };
}

/** A request as API Gateway's HTTP API delivers it: the form body base64-encoded. */
function slackRequest(fields, { secret = SECRET, at = Math.floor(Date.now() / 1000), base64 = true } = {}) {
  const body = new URLSearchParams({ response_url: HOOK, ...fields }).toString();
  const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${at}:${body}`).digest('hex')}`;
  return {
    headers: { 'x-slack-request-timestamp': String(at), 'x-slack-signature': signature },
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
  };
}

const text = (res) => JSON.parse(res.body).text;
const asyncPayload = (invokes) => JSON.parse(Buffer.from(invokes[0].input.Payload).toString());

test('a signed command is answered at once and handed to an asynchronous call', async (t) => {
  captureConsole(t);
  const { handler, requests, invokes } = load(t);
  const res = await handler(slackRequest({ command: '/patient-status', text: ' PatientExternalESP32 ' }));

  assert.equal(res.statusCode, 200);
  assert.match(text(res), /Looking up `PatientExternalESP32`/);
  // Nothing slow before the answer: no Salesforce sign-in, no query.
  assert.equal(requests.length, 0);
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].input.InvocationType, 'Event');
  assert.equal(invokes[0].input.FunctionName, 'cloud-agentic-iot-slack-integration');
  assert.deepEqual(asyncPayload(invokes), {
    slackCommand: { command: '/patient-status', deviceId: 'PatientExternalESP32', responseUrl: HOOK },
  });
});

test('the signature is checked against the decoded body, whether or not API Gateway encoded it', async (t) => {
  captureConsole(t);
  for (const base64 of [true, false]) {
    const { handler } = load(t);
    const res = await handler(slackRequest({ command: '/patient-status', text: 'PatientExternalESP32' }, { base64 }));
    assert.equal(res.statusCode, 200, `base64 ${base64}`);
  }
});

test('a wrong signature, a stale request or a missing header is refused before anything runs', async (t) => {
  captureConsole(t);
  const stale = Math.floor(Date.now() / 1000) - 600;
  for (const request of [
    slackRequest({ command: '/patient-status', text: 'PatientExternalESP32' }, { secret: 'not-the-secret' }),
    slackRequest({ command: '/patient-status', text: 'PatientExternalESP32' }, { at: stale }),
    { ...slackRequest({ command: '/patient-status', text: 'PatientExternalESP32' }), headers: {} },
  ]) {
    const { handler, invokes } = load(t);
    const res = await handler(request);
    assert.equal(res.statusCode, 401);
    assert.equal(invokes.length, 0);
  }
});

test('a missing or unsafe device name gets a usage hint and never reaches Salesforce', async (t) => {
  captureConsole(t);
  for (const name of ['', "PatientExternalESP32' OR Name != '", 'two words']) {
    const { handler, invokes } = load(t);
    const res = await handler(slackRequest({ command: '/patient-status', text: name }));
    assert.match(text(res), /Name one device/, name);
    assert.equal(invokes.length, 0, name);
  }
});

test('an unknown command is named back', async (t) => {
  captureConsole(t);
  const { handler, invokes } = load(t);
  const res = await handler(slackRequest({ command: '/reboot', text: 'PatientExternalESP32' }));
  assert.equal(text(res), 'Unknown command: /reboot');
  assert.equal(invokes.length, 0);
});

const reading = (minutesAgo, temperature, humidity) => {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { PK: 'PATIENT#PatientExternalESP32', SK: `VITAL#${at}`, CreatedAt: at, Temperature: temperature, Humidity: humidity };
};
const SAVED = {
  Temperature__c: 35.5, Humidity__c: 33, Patient_State__c: 'NORMAL', Room_Temperature_Alert__c: true,
  CreatedDate: '2026-11-09T03:01:08.000+0000',
};
const STATUS = { slackCommand: { command: '/patient-status', deviceId: 'PatientExternalESP32', responseUrl: HOOK } };
const replyText = (requests) => JSON.parse(requests.find((r) => r.url === HOOK).body).text;

test('patient status: the live reading from AWS and the last saved event from Salesforce', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t, {
    readings: [reading(30, 22.0, 40), reading(0.2, 24.1, 46), { PK: 'PATIENT#CompanyInternalESP32', SK: 'VITAL#2099-01-01T00:00:00Z', Temperature: 99 }],
    salesforce: () => jsonResponse(200, { records: [SAVED] }),
  });
  const res = await handler(STATUS);

  assert.deepEqual(res, { answered: true });
  const queryCall = requests.find((r) => r.url.startsWith(`${INSTANCE}/services/data/v64.0/query`));
  assert.match(decodeURIComponent(queryCall.url), /WHERE Device__c = 'PatientExternalESP32' ORDER BY CreatedDate DESC LIMIT 1/);
  const reply = JSON.parse(requests.find((r) => r.url === HOOK).body);
  assert.equal(reply.response_type, 'ephemeral');
  assert.equal(reply.replace_original, true);
  assert.equal(reply.text, [
    '*PatientExternalESP32*',
    'Live: 24.1°C, 46% humidity, 12 s ago (online).',
    'Last saved event: 35.5°C, 33% humidity, temperature alert, state NORMAL, at 2026-11-09 03:01 UTC.',
  ].join('\n'));
});

test('patient status: a reading older than OFFLINE_AFTER_MINUTES says offline since when', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t, { readings: [reading(180, 23, 41)] });
  await handler(STATUS);
  const text = replyText(requests);
  assert.match(text, /Live: offline since \d{4}-\d\d-\d\d \d\d:\d\d UTC; last reading 23°C, 41% humidity, 3 h ago\./);
  assert.match(text, /Last saved event: none in Salesforce\./);
});

test('patient status: AWS unreachable still answers from Salesforce, and says so', async (t) => {
  const logs = captureConsole(t);
  const { handler, requests } = load(t, { dynamoFails: true, salesforce: () => jsonResponse(200, { records: [SAVED] }) });
  await handler(STATUS);
  const text = replyText(requests);
  assert.match(text, /Live: unavailable, AWS could not be read just now\./);
  assert.match(text, /Last saved event: 35.5°C/);
  assert.ok(logs.some((l) => l.includes('live reading failed')));
});

test('patient status: Salesforce unreachable still shows the live reading', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t, { readings: [reading(1, 24, 45)], salesforce: () => jsonResponse(503, 'down') });
  await handler(STATUS);
  const text = replyText(requests);
  assert.match(text, /Live: 24°C, 45% humidity, 60 s ago \(online\)\./);
  assert.match(text, /Last saved event: unavailable, Salesforce could not be read just now\./);
});

test('patient status: a device with no readings anywhere is named back', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t);
  await handler(STATUS);
  assert.match(replyText(requests), /No readings for device `PatientExternalESP32` in AWS or Salesforce/);
});

test('the retired /dispense-medication is an unknown command and creates nothing', async (t) => {
  captureConsole(t);
  const { handler, invokes, requests } = load(t);
  const res = await handler(slackRequest({ command: '/dispense-medication', text: 'PatientExternalESP32' }));
  assert.equal(text(res), 'Unknown command: /dispense-medication');
  assert.equal(invokes.length, 0);
  assert.equal(requests.length, 0);
});

test('AWS and Salesforce both failing is reported to the person and logged, not thrown into a retry', async (t) => {
  const logs = captureConsole(t);
  const { handler, requests } = load(t, { salesforce: () => jsonResponse(400, [{ errorCode: 'INVALID_FIELD' }]), dynamoFails: true });
  const res = await handler(STATUS);

  assert.deepEqual(res, { answered: true });
  assert.match(replyText(requests), /neither AWS nor Salesforce could be read/);
  assert.ok(logs.some((l) => l.includes('Slack command failed')));
});

test('the asynchronous half answers only on a Slack address', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t);
  await assert.rejects(handler({
    slackCommand: { command: '/patient-status', deviceId: 'PatientExternalESP32', responseUrl: 'https://evil.example.com/' },
  }));
  assert.equal(requests.length, 0);
});
