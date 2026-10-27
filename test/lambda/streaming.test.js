'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadWithFakes, fakeAwsSdk, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const ROUTER = path.join(__dirname, '../../lambda/streaming/event-router/index.js');
const DISPATCHER = path.join(__dirname, '../../lambda/streaming/alert-dispatcher/index.js');

/* ------------------------------------------------------------ event router */

function loadRouter(respond = () => ({ FailedEntryCount: 0, Entries: [{ EventId: 'e-1' }] })) {
  const eventbridge = fakeAwsSdk('EventBridgeClient', ['PutEventsCommand'], respond);
  const { handler } = loadWithFakes(ROUTER, { '@aws-sdk/client-eventbridge': eventbridge.sdk });
  return { handler, calls: eventbridge.calls };
}

test('router: publishes the reading to the bus as Entries', async (t) => {
  captureConsole(t);
  const { handler, calls } = loadRouter();

  const res = await handler({ deviceId: 'pm-1', temperature: 23.4, humidity: 41 });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  // Sent as "events", the request carried no entries and never reached the bus.
  const { Entries } = calls[0].input;
  assert.equal(Entries.length, 1);
  assert.equal(Entries[0].Source, 'patient.iot.wearable');
  assert.equal(Entries[0].DetailType, 'patient.vitals.update');
  assert.equal(Entries[0].EventBusName, 'patient-vitals-event-bus');

  const detail = JSON.parse(Entries[0].Detail);
  assert.equal(detail.deviceId, 'pm-1');
  assert.equal(detail.temperature, 23.4);
  // Not invented: heart rate 0 used to read as critical bradycardia downstream.
  assert.equal(detail.heartRate, null);
  assert.equal(detail.spo2, null);
  assert.equal(detail.bpSystolic, null);
});

test('router: an entry EventBridge rejects fails the invocation', async (t) => {
  captureConsole(t);
  const { handler } = loadRouter(() => ({
    FailedEntryCount: 1,
    Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'try again' }],
  }));
  await assert.rejects(handler({ detail: { deviceId: 'pm-1', temperature: 23.4 } }), /InternalFailure try again/);
});

test('router: a reading without a device id is not published', async (t) => {
  captureConsole(t);
  const { handler, calls } = loadRouter();
  const res = await handler({ temperature: 23.4 });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

/* -------------------------------------------------------- alert dispatcher */

function loadDispatcher(t, respond) {
  withEnv(t, { SALESFORCE_ENDPOINT: 'https://example.my.salesforce.com', SALESFORCE_ACCESS_TOKEN: 'token-123' });
  const requests = fakeFetch(t, respond);
  const { handler } = loadWithFakes(DISPATCHER);
  return { handler, requests };
}

const succeeded = () => jsonResponse(200, [{
  actionName: 'StreamingAlertService', isSuccess: true, errors: null,
  outputValues: { deviceId: 'pm-1', alertPublished: true, alertType: 'CRITICAL_VITALS' },
}]);

const alertTypeFor = async (t, detail) => {
  const { handler } = loadDispatcher(t, succeeded);
  return JSON.parse((await handler({ detail })).body).alertType;
};

test('dispatcher: a vital that was not reported raises no alert', async (t) => {
  captureConsole(t);
  // null < 50 is true in JavaScript; unchecked, a missing heart rate was critical.
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1', heartRate: null, spo2: null, temperature: 36.9 }), 'NONE');
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1' }), 'NONE');
});

test('dispatcher: reported vitals are judged against the thresholds', async (t) => {
  captureConsole(t);
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1', spo2: 85 }), 'CRITICAL_VITALS');
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1', heartRate: 130 }), 'CRITICAL_VITALS');
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1', bpSystolic: 170 }), 'CRITICAL_VITALS');
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1', heartRate: 55 }), 'ABNORMAL_TREND');
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1', spo2: 93 }), 'ABNORMAL_TREND');
  assert.equal(await alertTypeFor(t, { deviceId: 'pm-1', heartRate: 72, spo2: 98 }), 'NONE');
});

test('dispatcher: calls the invocable action endpoint with one input', async (t) => {
  captureConsole(t);
  const { handler, requests } = loadDispatcher(t, succeeded);

  await handler({ detail: { deviceId: 'pm-1', heartRate: 130, spo2: 97, sourceSystem: 'AWS_IoT' } });

  assert.equal(requests.length, 1);
  // There is no @RestResource behind /services/apexrest/streaming-alerts/process.
  assert.equal(
    requests[0].url,
    'https://example.my.salesforce.com/services/data/v64.0/actions/custom/apex/StreamingAlertService',
  );
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.Authorization, 'Bearer token-123');
  assert.deepEqual(JSON.parse(requests[0].body), {
    inputs: [{ deviceId: 'pm-1', heartRate: 130, spo2: 97, sourceSystem: 'AWS_IoT' }],
  });
});

test('dispatcher: no alert, no call to Salesforce', async (t) => {
  captureConsole(t);
  const { handler, requests } = loadDispatcher(t, succeeded);
  await handler({ detail: { deviceId: 'pm-1', heartRate: 72 } });
  assert.equal(requests.length, 0);
});

test('dispatcher: an error from Salesforce fails the invocation with its text', async (t) => {
  captureConsole(t);
  const { handler } = loadDispatcher(t, () => new Response('Session expired or invalid', { status: 401 }));
  // response.text without () used to log the function's source instead, and
  // the alert was dropped with a 500 that counted as delivered.
  await assert.rejects(handler({ detail: { deviceId: 'pm-1', spo2: 85 } }), /401: Session expired or invalid/);
});

test('dispatcher: a failed action result fails the invocation', async (t) => {
  captureConsole(t);
  const { handler } = loadDispatcher(t, () => jsonResponse(200, [{
    actionName: 'StreamingAlertService', isSuccess: false,
    errors: [{ statusCode: 'UNKNOWN_EXCEPTION', message: 'boom' }],
  }]));
  await assert.rejects(handler({ detail: { deviceId: 'pm-1', spo2: 85 } }), /StreamingAlertService failed.*boom/);
});
