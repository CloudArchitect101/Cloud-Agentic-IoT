'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadWithFakes, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/patient-vitals/index.js');
const RECEIVED_AT = 1761580800000;                // what timestamp() adds in the IoT rule
const RECEIVED_ISO = '2025-10-27T16:00:00.000Z';

// Exactly what the patient monitor publishes, plus the rule's receivedAt.
const dht11Message = () => ({ deviceId: 'pm-1', temperature: 23.4, humidity: 41, receivedAt: RECEIVED_AT });

/**
 * Loads the handler against a fake DynamoDB table holding one STATE item, a
 * fake JWT signer, and a fake Salesforce. `timeline` records DynamoDB writes
 * and Salesforce upserts in the order they happen.
 */
function load(t, { state = null, upsert = () => new Response(null, { status: 204 }) } = {}) {
  withEnv(t, {
    DYNAMODB_TABLE: 'patient-vitals',
    SALESFORCE_ENDPOINT: 'https://example.my.salesforce.com',
    SALESFORCE_CLIENT_ID: 'consumer-key',
    SALESFORCE_USERNAME: 'integration@example.com',
    SALESFORCE_JWT_PRIVATE_KEY: 'unused: the signer is faked',
    SALESFORCE_LOGIN_URL: 'https://login.salesforce.com',
  });

  const table = { state };
  const timeline = [];
  const writes = [];
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  const docClient = {
    async send(command) {
      if (command instanceof GetCommand) {
        return table.state ? { Item: { PatientState: table.state } } : {};
      }
      const item = command.input.Item;
      writes.push(item);
      timeline.push(`dynamodb ${item.SK.split('#')[0]}`);
      if (item.SK === 'STATE') table.state = item.PatientState;
      return {};
    },
  };

  const requests = fakeFetch(t, (request) => {
    if (request.url.endsWith('/services/oauth2/token')) {
      return jsonResponse(200, { access_token: 'token-123', instance_url: 'https://example.my.salesforce.com' });
    }
    timeline.push(`salesforce ${request.method}`);
    return upsert(request);
  });

  const { handler } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': { DynamoDBDocumentClient: { create: () => docClient }, GetCommand, PutCommand },
    jsonwebtoken: { sign: () => 'signed-assertion' },
  });

  const upserts = () => requests.filter((r) => r.method === 'PATCH');
  return { handler, table, timeline, writes, upserts };
}

test('processes the message the IoT rule delivers, as it arrives', async (t) => {
  captureConsole(t);
  const { handler, writes, upserts } = load(t);

  // The rule passes the device's message itself as the event. Reading only
  // event.detail or event.payload, every real reading was rejected with 400.
  const res = await handler(dht11Message());

  assert.equal(res.statusCode, 200);
  const reading = writes.find((item) => item.SK.startsWith('VITAL#'));
  assert.equal(reading.SK, `VITAL#${RECEIVED_ISO}`);
  assert.equal(reading.Temperature, 23.4);
  assert.equal(reading.Humidity, 41);

  // First reading from a new device: unknown -> STABLE is a transition.
  assert.equal(upserts().length, 1);
  const [upsert] = upserts();
  assert.equal(
    upsert.url,
    `https://example.my.salesforce.com/services/data/v59.0/sobjects/Patient_Vitals__c/Device_Reading_Id__c/${encodeURIComponent(`pm-1-${RECEIVED_ISO}`)}`,
  );
  assert.equal(upsert.headers.Authorization, 'Bearer token-123');
  const record = JSON.parse(upsert.body);
  assert.equal(record.Device__c, 'pm-1');
  assert.equal(record.Temperature__c, 23.4);
  assert.equal(record.Timestamp__c, RECEIVED_ISO);
  assert.equal(record.Patient_State__c, 'STABLE');
  assert.equal(record.Previous_State__c, null);
});

test('values the sensor did not send stay empty instead of looking normal', async (t) => {
  captureConsole(t);
  const { handler, writes, upserts } = load(t);
  await handler(dht11Message());

  // These used to be filled in as SpO2 98, BP 120/80 and heart rate 0.
  const record = JSON.parse(upserts()[0].body);
  for (const field of ['Heart_Rate__c', 'SpO2__c', 'BP_Systolic__c', 'BP_Diastolic__c']) {
    assert.equal(record[field], null, field);
  }
  const reading = writes.find((item) => item.SK.startsWith('VITAL#'));
  for (const field of ['HeartRate', 'SpO2', 'BP_Systolic', 'BP_Diastolic']) {
    assert.equal(reading[field], null, field);
  }
});

test('a retried invocation upserts the same record', async (t) => {
  captureConsole(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { handler, upserts } = load(t, { upsert: () => jsonResponse(500, [{ message: 'busy' }]) });

  await assert.rejects(handler(dht11Message()));
  t.mock.timers.tick(60_000);                      // Lambda retries a minute later
  await assert.rejects(handler(dht11Message()));

  const [first, retry] = upserts();
  assert.equal(first.url, retry.url);
});

test('a rejected upsert fails the invocation and leaves the state unsaved', async (t) => {
  captureConsole(t);
  const { handler, table, timeline } = load(t, {
    upsert: () => jsonResponse(400, [{ message: 'No such column', errorCode: 'INVALID_FIELD' }]),
  });

  // Used to log the error and return 200, so the reading was simply lost.
  await assert.rejects(handler(dht11Message()), /Salesforce upsert failed \(400\).*No such column/);
  assert.equal(table.state, null);
  assert.deepEqual(timeline, ['dynamodb VITAL', 'salesforce PATCH']);
});

test('the retry after a failed sync still reaches Salesforce', async (t) => {
  captureConsole(t);
  let attempts = 0;
  const { handler, table, timeline, upserts } = load(t, {
    upsert: () => (++attempts === 1 ? jsonResponse(503, []) : new Response(null, { status: 204 })),
  });

  await assert.rejects(handler(dht11Message()));
  const res = await handler(dht11Message());

  // With the state saved before the sync, the retry saw "no change" and
  // never synced the transition.
  assert.equal(res.statusCode, 200);
  assert.equal(upserts().length, 2);
  assert.equal(table.state, 'STABLE');
  assert.deepEqual(timeline.slice(-3), ['dynamodb VITAL', 'salesforce PATCH', 'dynamodb STATE']);
});

test('an unchanged stable reading stays out of Salesforce', async (t) => {
  captureConsole(t);
  const { handler, upserts, writes } = load(t, { state: 'STABLE' });
  const res = await handler(dht11Message());
  assert.equal(res.statusCode, 200);
  assert.equal(upserts().length, 0);
  assert.ok(writes.some((item) => item.SK.startsWith('VITAL#')));
});

test('a critical reading is synced even when the state has not changed', async (t) => {
  captureConsole(t);
  const { handler, upserts } = load(t, { state: 'CRITICAL' });
  const res = await handler({
    deviceId: 'pm-1', heartRate: 130, spo2: 85, temperature: 39.5, receivedAt: RECEIVED_AT,
  });

  assert.equal(JSON.parse(res.body).patientState, 'CRITICAL');
  const record = JSON.parse(upserts()[0].body);
  assert.equal(record.Risk_Score__c, 90);
  assert.equal(record.Previous_State__c, 'CRITICAL');
});

test('still accepts the EventBridge and wrapped shapes', async (t) => {
  captureConsole(t);
  const { handler } = load(t, { state: 'STABLE' });
  assert.equal((await handler({ detail: dht11Message() })).statusCode, 200);
  assert.equal((await handler({ payload: JSON.stringify(dht11Message()) })).statusCode, 200);
});

test('a message without a device id is rejected before anything is written', async (t) => {
  captureConsole(t);
  const { handler, writes, upserts } = load(t);
  const res = await handler({ temperature: 23.4 });
  assert.equal(res.statusCode, 400);
  assert.equal(writes.length, 0);
  assert.equal(upserts().length, 0);
});

test('timestamps from the device are normalised to ISO 8601', async (t) => {
  captureConsole(t);
  const { handler, writes } = load(t, { state: 'STABLE' });
  await handler({ deviceId: 'pm-1', temperature: 23.4, timestamp: RECEIVED_AT / 1000 });
  await handler({ deviceId: 'pm-1', temperature: 23.4, timestamp: RECEIVED_ISO });
  const keys = writes.filter((item) => item.SK.startsWith('VITAL#')).map((item) => item.SK);
  assert.deepEqual(keys, [`VITAL#${RECEIVED_ISO}`, `VITAL#${RECEIVED_ISO}`]);
});
