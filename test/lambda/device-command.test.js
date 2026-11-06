'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, awsError, captureConsole, withEnv } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/device-command/index.js');

function load(t, respond) {
  withEnv(t, { IOT_PARALLEL_REQUESTS: '8' });
  const iot = fakeAwsSdk('IoTDataPlaneClient', ['PublishCommand'], respond);
  const { handler, COMMAND_ID } = loadWithFakes(HANDLER, { '@aws-sdk/client-iot-data-plane': iot.sdk });
  return { handler, calls: iot.calls, COMMAND_ID };
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

/* -------------------------------------------------------------- commandId */

// What DeviceCommandSendJob sends for one Device Command: the record's Id is
// the commandId, and the board answers with it on device/<thing>/ack.
const RECORD_ID = 'a0Bbm00000AbCdEFGH';
const recordCommand = (fields = {}) => ({
  body: JSON.stringify({ thingName: 'pm-1', operation: 'DISPENSE_MEDICATION', commandId: RECORD_ID, ...fields }),
});

test('a commandId reaches the board in the payload, with the other fields', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);

  const res = await handler(recordCommand());

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { published: true, thingName: 'pm-1', operation: 'DISPENSE_MEDICATION' });
  assert.deepEqual(calls.map((c) => c.input.topic), ['device/pm-1/command']);
  assert.deepEqual(JSON.parse(calls[0].input.payload.toString()), { operation: 'DISPENSE_MEDICATION', commandId: RECORD_ID });

  // A command with settings of its own keeps them all, in the batch shape too.
  const batch = await handler({
    body: JSON.stringify({ thingNames: ['pm-2'], operation: 'SET_TELEMETRY_INTERVAL', seconds: 60, commandId: 'run-7_b' }),
  });
  assert.equal(batch.statusCode, 200);
  assert.deepEqual(JSON.parse(batch.body).results, [{ thingName: 'pm-2', published: true }]);
  assert.equal(calls[1].input.topic, 'device/pm-2/command');
  assert.deepEqual(JSON.parse(calls[1].input.payload.toString()), { operation: 'SET_TELEMETRY_INTERVAL', seconds: 60, commandId: 'run-7_b' });
});

test('a commandId may be 1 to 40 letters, digits, _ and -', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  for (const commandId of ['A', 'x'.repeat(40), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789_-']) {
    const res = await handler(recordCommand({ commandId }));
    assert.equal(res.statusCode, 200, commandId);
  }
  assert.equal(calls.length, 5);
  assert.equal(JSON.parse(calls[1].input.payload.toString()).commandId, 'x'.repeat(40));
});

test('any other commandId refuses the request, saying which rule it broke, before anything is published', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const BAD = ['', 'x'.repeat(41), 'a0B m', 'a0B/m', 'a0B+m', '#', 'a0B.m', 'a0B\nm', 'Bäder', null, 123, true, ['a0B'], { id: 'a0B' }];
  for (const commandId of BAD) {
    const res = await handler(recordCommand({ commandId }));
    assert.equal(res.statusCode, 400, JSON.stringify(commandId));
    assert.match(JSON.parse(res.body).error, /^commandId must be 1 to 40 letters, digits, _ or -/, JSON.stringify(commandId));
  }
  assert.equal(calls.length, 0);
});

test('a command with a commandId goes to one device only', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);

  const two = await handler(recordCommand({ thingName: undefined, thingNames: ['pm-1', 'pm-2'] }));

  assert.equal(two.statusCode, 400);
  assert.equal(JSON.parse(two.body).error,
    'A command with a commandId goes to one device: send thingName, or thingNames with one entry (this request names 2).');
  assert.equal(calls.length, 0);
  // Many devices without a commandId stay one request, as a Wi-Fi change is.
  assert.equal((await handler(wifiUpdate(['pm-1', 'pm-2']))).statusCode, 200);
  // A commandId and one device, either way it is named.
  assert.equal((await handler(recordCommand({ thingName: undefined, thingNames: ['pm-1'] }))).statusCode, 200);
  assert.equal((await handler(recordCommand())).statusCode, 200);
});

test('the commandId is logged with the publish, and the payload never is', async (t) => {
  const logs = captureConsole(t);
  const { handler } = load(t, (command, input) => {
    if (input.topic === 'device/pm-2/command') throw awsError('ForbiddenException', 'Not allowed');
    return {};
  });
  const wifi = (thingName) => recordCommand({ thingName, operation: 'WIFI_UPDATE', ssid: 'clinic', passphrase: 'hunter2' });

  assert.equal((await handler(wifi('pm-1'))).statusCode, 200);
  assert.equal((await handler(wifi('pm-2'))).statusCode, 502);

  assert.deepEqual(logs.filter((line) => line.startsWith('command published ')), [
    `command published {"operation":"WIFI_UPDATE","commandId":"${RECORD_ID}","devices":1,"published":1}`,
    `command published {"operation":"WIFI_UPDATE","commandId":"${RECORD_ID}","devices":1,"published":0}`,
  ]);
  assert.deepEqual(logs.filter((line) => line.startsWith('publish failed ')), [
    `publish failed {"thingName":"pm-2","operation":"WIFI_UPDATE","commandId":"${RECORD_ID}","error":"Not allowed"}`,
  ]);
  assert.ok(!logs.some((line) => /hunter2|clinic/.test(line)), logs.join('\n'));
});

test('COMMAND_ID is exported, for the check that the board and both functions agree', (t) => {
  const { COMMAND_ID } = load(t);
  assert.ok(COMMAND_ID instanceof RegExp);
  assert.equal(COMMAND_ID.source, '^[A-Za-z0-9_-]{1,40}$');
  assert.equal(COMMAND_ID.flags, '');
});
