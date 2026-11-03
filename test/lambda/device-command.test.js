'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, awsError, captureConsole, withEnv } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/device-command/index.js');

function load(t, respond) {
  withEnv(t, { IOT_PARALLEL_REQUESTS: '8' });
  const iot = fakeAwsSdk('IoTDataPlaneClient', ['PublishCommand'], respond);
  const { handler } = loadWithFakes(HANDLER, { '@aws-sdk/client-iot-data-plane': iot.sdk });
  return { handler, calls: iot.calls };
}

// What WiFiCredentialPushJob sends: every device on one network, one request.
const wifiUpdate = (thingNames) => ({
  body: JSON.stringify({ thingNames, operation: 'WIFI_UPDATE', ssid: 'clinic', passphrase: 'hunter2' }),
});

test("publishes the command to each device's own topic, and never logs the passphrase", async (t) => {
  const logs = captureConsole(t);
  const { handler, calls } = load(t);
  const thingNames = Array.from({ length: 200 }, (_, i) => `pm-${i}`);

  const res = await handler(wifiUpdate(thingNames));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 200);
  assert.deepEqual(calls.slice(0, 2).map((c) => c.input.topic), ['device/pm-0/command', 'device/pm-1/command']);
  assert.ok(calls.every((c) => c.input.qos === 1));
  assert.deepEqual(JSON.parse(calls[0].input.payload.toString()), { operation: 'WIFI_UPDATE', ssid: 'clinic', passphrase: 'hunter2' });
  assert.equal(JSON.parse(res.body).results.length, 200);
  assert.ok(!logs.some((line) => line.includes('hunter2')));
  assert.ok(!res.body.includes('hunter2'));
});

test('a name that is not a Thing name refuses the request before anything is published', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  for (const bad of ['pm-1/../pm-2', '#', 'pm+1', '', 'x'.repeat(129)]) {
    const res = await handler(wifiUpdate(['pm-1', bad]));
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);
});

test('a device IoT Core did not take is reported, retryable when it was throttled', async (t) => {
  captureConsole(t);
  const { handler } = load(t, (command, input) => {
    if (input.topic === 'device/pm-1/command') throw awsError('ThrottlingException', 'Rate exceeded');
    if (input.topic === 'device/pm-2/command') throw awsError('ForbiddenException', 'Not allowed');
    return {};
  });
  const res = await handler(wifiUpdate(['pm-0', 'pm-1', 'pm-2']));
  assert.equal(res.statusCode, 207);
  assert.deepEqual(JSON.parse(res.body).results.map((r) => [r.thingName, r.published, r.retryable]), [
    ['pm-0', true, undefined], ['pm-1', false, true], ['pm-2', false, false],
  ]);
});

test('the one-device shape keeps its one-device answers', async (t) => {
  captureConsole(t);
  const ok = load(t);
  assert.equal((await ok.handler({ thingName: 'pm-1', operation: 'REBOOT' })).statusCode, 200);
  assert.equal((await ok.handler({ thingName: 'pm-1' })).statusCode, 400);
  const refused = load(t, () => { throw awsError('ForbiddenException'); });
  assert.equal((await refused.handler({ thingName: 'pm-1', operation: 'REBOOT' })).statusCode, 502);
});
