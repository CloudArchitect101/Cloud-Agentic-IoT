'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  loadWithFakes, fakeAwsSdk, fakeSsm, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/slack-integration/index.js');
const SECRET = 'test-signing-secret';
const HOOK = 'https://hooks.slack.com/commands/T1/2/abc';
const INSTANCE = 'https://acme.my.salesforce.com';

function load(t, { salesforce = () => jsonResponse(200, { records: [] }), slack = () => new Response('ok') } = {}) {
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
  });
  const requests = fakeFetch(t, (request) => {
    if (request.url.endsWith('/services/oauth2/token')) {
      return jsonResponse(200, { access_token: 'token', instance_url: INSTANCE });
    }
    if (request.url.startsWith(HOOK)) return slack(request);
    return salesforce(request);
  });
  const lambda = fakeAwsSdk('LambdaClient', ['InvokeCommand']);
  const { handler } = loadWithFakes(HANDLER, {
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
  const res = await handler(slackRequest({ command: '/patient-status', text: ' Test8 ' }));

  assert.equal(res.statusCode, 200);
  assert.match(text(res), /Looking up `Test8`/);
  // Nothing slow before the answer: no Salesforce sign-in, no query.
  assert.equal(requests.length, 0);
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].input.InvocationType, 'Event');
  assert.equal(invokes[0].input.FunctionName, 'cloud-agentic-iot-slack-integration');
  assert.deepEqual(asyncPayload(invokes), {
    slackCommand: { command: '/patient-status', deviceId: 'Test8', responseUrl: HOOK },
  });
});

test('the signature is checked against the decoded body, whether or not API Gateway encoded it', async (t) => {
  captureConsole(t);
  for (const base64 of [true, false]) {
    const { handler } = load(t);
    const res = await handler(slackRequest({ command: '/patient-status', text: 'Test8' }, { base64 }));
    assert.equal(res.statusCode, 200, `base64 ${base64}`);
  }
});

test('a wrong signature, a stale request or a missing header is refused before anything runs', async (t) => {
  captureConsole(t);
  const stale = Math.floor(Date.now() / 1000) - 600;
  for (const request of [
    slackRequest({ command: '/patient-status', text: 'Test8' }, { secret: 'not-the-secret' }),
    slackRequest({ command: '/patient-status', text: 'Test8' }, { at: stale }),
    { ...slackRequest({ command: '/patient-status', text: 'Test8' }), headers: {} },
  ]) {
    const { handler, invokes } = load(t);
    const res = await handler(request);
    assert.equal(res.statusCode, 401);
    assert.equal(invokes.length, 0);
  }
});

test('a missing or unsafe device name gets a usage hint and never reaches Salesforce', async (t) => {
  captureConsole(t);
  for (const name of ['', "Test8' OR Name != '", 'two words']) {
    const { handler, invokes } = load(t);
    const res = await handler(slackRequest({ command: '/patient-status', text: name }));
    assert.match(text(res), /Name one device/, name);
    assert.equal(invokes.length, 0, name);
  }
});

test('an unknown command is named back', async (t) => {
  captureConsole(t);
  const { handler, invokes } = load(t);
  const res = await handler(slackRequest({ command: '/reboot', text: 'Test8' }));
  assert.equal(text(res), 'Unknown command: /reboot');
  assert.equal(invokes.length, 0);
});

test('patient status: the latest reading is posted back to Slack', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t, {
    salesforce: () => jsonResponse(200, {
      records: [{ Temperature__c: 24.5, Humidity__c: 41, CreatedDate: '2026-11-09T20:40:00.000+0000' }],
    }),
  });
  const res = await handler({ slackCommand: { command: '/patient-status', deviceId: 'Test8', responseUrl: HOOK } });

  assert.deepEqual(res, { answered: true });
  const queryCall = requests.find((r) => r.url.startsWith(`${INSTANCE}/services/data/v64.0/query`));
  assert.match(decodeURIComponent(queryCall.url), /WHERE Device__c = 'Test8' ORDER BY CreatedDate DESC LIMIT 1/);
  const reply = JSON.parse(requests.find((r) => r.url === HOOK).body);
  assert.equal(reply.response_type, 'ephemeral');
  assert.equal(reply.replace_original, true);
  assert.match(reply.text, /Device Test8\*: 24.5°C, 41% humidity/);
});

test('dispense: one Pending Device Command from Slack, and the reply says it was queued', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t, { salesforce: () => jsonResponse(201, { id: 'a0X1', success: true }) });
  await handler({ slackCommand: { command: '/dispense-medication', deviceId: 'Test8', responseUrl: HOOK } });

  const creates = requests.filter((r) => r.url === `${INSTANCE}/services/data/v64.0/sobjects/Device_Command__c`);
  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(creates[0].body), {
    Device__c: 'Test8', Command__c: 'DISPENSE_MEDICATION', Requested_By__c: 'Slack', Status__c: 'Pending',
  });
  assert.match(JSON.parse(requests.find((r) => r.url === HOOK).body).text, /queued for `Test8` \(Device Command a0X1\)/);
});

test('a Salesforce failure is reported to the person and logged, not thrown into a retry', async (t) => {
  const logs = captureConsole(t);
  const { handler, requests } = load(t, { salesforce: () => jsonResponse(400, [{ errorCode: 'INVALID_FIELD' }]) });
  const res = await handler({ slackCommand: { command: '/patient-status', deviceId: 'Test8', responseUrl: HOOK } });

  assert.deepEqual(res, { answered: true });
  assert.match(JSON.parse(requests.find((r) => r.url === HOOK).body).text, /failed in Salesforce/);
  assert.ok(logs.some((l) => l.includes('Slack command failed')));
});

test('the asynchronous half answers only on a Slack address', async (t) => {
  captureConsole(t);
  const { handler, requests } = load(t);
  await assert.rejects(handler({
    slackCommand: { command: '/patient-status', deviceId: 'Test8', responseUrl: 'https://evil.example.com/' },
  }));
  assert.equal(requests.length, 0);
});
