'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadWithFakes, fakeSsm, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/salesforce-sync/index.js');
const KEY_PARAMETER = '/cloud-agentic-iot/salesforce/jwt-private-key';
const INSTANCE = 'https://example.my.salesforce.com';
const UPSERT_URL = `${INSTANCE}/services/data/v62.0/composite/sobjects/Patient_Vitals__c/Device_Reading_Id__c`;

const ENV = {
  SALESFORCE_CLIENT_ID: 'consumer-key',
  SALESFORCE_USERNAME: 'integration@example.com',
  SALESFORCE_LOGIN_URL: 'https://login.salesforce.com',
  SALESFORCE_JWT_KEY_PARAMETER: KEY_PARAMETER,
  SALESFORCE_API_VERSION: '62.0',
  SALESFORCE_TOKEN_CACHE_MINUTES: '30',
  CONFIG_CACHE_SECONDS: '300',
};

// The record patient-vitals puts on the sync queue.
const sync = (n, overrides = {}) => ({
  Device_Reading_Id__c: `pm-${n}-2025-10-27T16:00:00.000Z`,
  Device__c: `pm-${n}`,
  Previous_State__c: 'STABLE',
  Heart_Rate__c: 130,
  SpO2__c: 85,
  Temperature__c: 39.5,
  Humidity__c: null,
  BP_Systolic__c: null,
  BP_Diastolic__c: null,
  Timestamp__c: '2025-10-27T16:00:00.000Z',
  Risk_Score__c: 90,
  Patient_State__c: 'CRITICAL',
  Source_System__c: 'AWS_IoT',
  ...overrides,
});

const queueBatch = (bodies) => ({
  Records: bodies.map((body, i) => ({
    messageId: `m-${i}`, body: typeof body === 'string' ? body : JSON.stringify(body), eventSource: 'aws:sqs',
  })),
});

/**
 * Loads the handler against a fake Salesforce. `upsert(records, request)`
 * answers each collection request; by default every record succeeds.
 */
function load(t, { upsert = (records) => jsonResponse(200, records.map(ok)) } = {}) {
  withEnv(t, ENV);
  const ssm = fakeSsm({ [KEY_PARAMETER]: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----' });
  const requests = fakeFetch(t, (request) => {
    if (request.url.endsWith('/services/oauth2/token')) {
      return jsonResponse(200, { access_token: `token-${tokens().length}`, instance_url: INSTANCE });
    }
    return upsert(JSON.parse(request.body).records, request);
  });
  const tokens = () => requests.filter((r) => r.url.endsWith('/services/oauth2/token'));
  const upserts = () => requests.filter((r) => r.method === 'PATCH');
  const { handler } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-ssm': ssm.sdk,
    jsonwebtoken: { sign: () => 'signed-assertion' },
  });
  return { handler, ssm, requests, tokens, upserts };
}

const ok = (record) => ({ id: `a0X${record.Device__c}`, success: true, created: true, errors: [] });
const refused = (statusCode, message) => ({ success: false, errors: [{ statusCode, message, fields: [] }] });

test('upserts the queued records on Device_Reading_Id__c, in one request', async (t) => {
  captureConsole(t);
  const { handler, upserts } = load(t);

  const result = await handler(queueBatch([sync(1), sync(2), sync(3)]));

  assert.deepEqual(result, { batchItemFailures: [] });
  const [request] = upserts();
  assert.equal(request.url, UPSERT_URL);
  assert.equal(request.headers.Authorization, 'Bearer token-1');
  const body = JSON.parse(request.body);
  assert.equal(body.allOrNone, false);           // one bad record must not fail the others
  assert.deepEqual(body.records.map((r) => r.attributes.type), ['Patient_Vitals__c', 'Patient_Vitals__c', 'Patient_Vitals__c']);
  assert.deepEqual(body.records[0], { attributes: { type: 'Patient_Vitals__c' }, ...sync(1) });
});

test('450 records go in three requests of at most 200', async (t) => {
  captureConsole(t);
  const { handler, upserts } = load(t);
  const result = await handler(queueBatch(Array.from({ length: 450 }, (_, n) => sync(n))));
  assert.deepEqual(result.batchItemFailures, []);
  assert.deepEqual(upserts().map((r) => JSON.parse(r.body).records.length), [200, 200, 50]);
});

test('one token serves every request, across invocations of the container', async (t) => {
  captureConsole(t);
  const { handler, tokens, ssm } = load(t);
  await handler(queueBatch(Array.from({ length: 450 }, (_, n) => sync(n))));
  await handler(queueBatch([sync(1)]));
  assert.equal(tokens().length, 1);
  // The private key comes from Parameter Store, decrypted in memory; it is in
  // no environment variable.
  assert.deepEqual(ssm.calls.map((c) => c.input), [{ Name: KEY_PARAMETER, WithDecryption: true }]);
  assert.ok(!Object.values(process.env).some((value) => String(value).includes('PRIVATE KEY')));
});

test('a session Salesforce ended early is replaced once, and the request retried', async (t) => {
  captureConsole(t);
  let attempts = 0;
  const { handler, tokens, upserts } = load(t, {
    upsert: (records) => (++attempts === 1
      ? jsonResponse(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }])
      : jsonResponse(200, records.map(ok))),
  });

  const result = await handler(queueBatch([sync(1)]));

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(tokens().length, 2);
  assert.deepEqual(upserts().map((r) => r.headers.Authorization), ['Bearer token-1', 'Bearer token-2']);
});

test('a record Salesforce refuses goes back to the queue alone', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, {
    upsert: (records) => jsonResponse(200, records.map((r) => (r.Device__c === 'pm-2'
      ? refused('UNABLE_TO_LOCK_ROW', 'unable to obtain exclusive access to this record')
      : ok(r)))),
  });

  const result = await handler(queueBatch([sync(1), sync(2), sync(3)]));

  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'm-1' }]);
  const logged = lines.find((line) => line.includes('Salesforce refused a record'));
  assert.match(logged, /pm-2-2025-10-27T16:00:00.000Z/);
  assert.match(logged, /UNABLE_TO_LOCK_ROW/);
});

test('when Salesforce fails a request, that request and the rest of the batch go back', async (t) => {
  captureConsole(t);
  let requests = 0;
  const { handler, upserts } = load(t, {
    upsert: (records) => (++requests === 2
      ? jsonResponse(503, [{ errorCode: 'SERVER_UNAVAILABLE', message: 'Try again later' }])
      : jsonResponse(200, records.map(ok))),
  });

  const result = await handler(queueBatch(Array.from({ length: 450 }, (_, n) => sync(n))));

  // The first 200 are written. The rest would only meet the same answer.
  assert.equal(upserts().length, 2);
  assert.deepEqual(
    result.batchItemFailures.map((f) => f.itemIdentifier),
    Array.from({ length: 250 }, (_, n) => `m-${n + 200}`),
  );
});

test('a reading delivered twice is written once, and both messages share the result', async (t) => {
  captureConsole(t);
  const { handler, upserts } = load(t, {
    upsert: (records) => jsonResponse(200, records.map(() => refused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Rejected'))),
  });

  const result = await handler(queueBatch([sync(1), sync(1)]));

  // Two copies of one external ID in one request: Salesforce rejects both.
  assert.equal(JSON.parse(upserts()[0].body).records.length, 1);
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'm-0' }, { itemIdentifier: 'm-1' }]);
});

test('a message that is not a sync goes back to the queue, toward the dead-letter queue', async (t) => {
  captureConsole(t);
  const { handler, upserts } = load(t);
  const result = await handler(queueBatch(['not json', { Device__c: 'pm-1' }, sync(3)]));
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'm-0' }, { itemIdentifier: 'm-1' }]);
  assert.equal(JSON.parse(upserts()[0].body).records.length, 1);
});

test('the logs never carry the vitals', async (t) => {
  const lines = captureConsole(t);
  const { handler } = load(t, {
    upsert: (records) => jsonResponse(200, records.map(() => refused('INVALID_FIELD', 'No such column'))),
  });
  await handler(queueBatch([sync(1)]));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.doesNotMatch(line, /39\.5|Heart_Rate__c|SpO2__c/, line);
  }
});

test('a failed login sends the whole batch back without trying each request', async (t) => {
  captureConsole(t);
  withEnv(t, ENV);
  const ssm = fakeSsm({ [KEY_PARAMETER]: 'key' });
  const requests = fakeFetch(t, () => jsonResponse(400, { error: 'invalid_grant', error_description: 'user hasn\'t approved this consumer' }));
  const { handler } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-ssm': ssm.sdk,
    jsonwebtoken: { sign: () => 'signed-assertion' },
  });

  const result = await handler(queueBatch(Array.from({ length: 450 }, (_, n) => sync(n))));

  assert.equal(result.batchItemFailures.length, 450);
  assert.equal(requests.length, 1);
});
