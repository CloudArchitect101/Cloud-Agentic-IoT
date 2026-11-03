'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, awsError, captureConsole, withEnv } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/queue-relay/index.js');

function load(t, respond) {
  withEnv(t, { IOT_PARALLEL_REQUESTS: '8' });
  const iot = fakeAwsSdk('IoTDataPlaneClient', ['PublishCommand'], respond);
  const { handler } = loadWithFakes(HANDLER, { '@aws-sdk/client-iot-data-plane': iot.sdk });
  return { handler, calls: iot.calls };
}

const request = (body) => ({ body: JSON.stringify(body) });

test('relays a valid request to the device\'s own command topic', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);

  // Used to throw "Date.toISOString is not a constructor" on every valid call.
  const res = await handler(request({
    deviceId: 'queue-indicator-01', queueDeveloperName: 'Triage', openCaseCount: 3, intensity: 40,
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'PublishCommand');
  // The device subscribes to device/<thing>/command, not device/queue/command.
  assert.equal(calls[0].input.topic, 'device/queue-indicator-01/command');
  assert.equal(calls[0].input.qos, 1);

  const message = JSON.parse(calls[0].input.payload.toString());
  assert.equal(message.operation, 'QUEUE_DEPTH');
  assert.equal(message.deviceId, 'queue-indicator-01');
  assert.equal(message.queueDeveloperName, 'Triage');
  assert.equal(message.openCaseCount, 3);
  assert.equal(message.intensity, 40);
  assert.equal(message.motorState, 'ACTIVE');
  assert.equal(new Date(message.sentAt).toISOString(), message.sentAt);
});

test('clamps intensity to 0-100 and parks the motor at zero', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);

  await handler(request({ deviceId: 'qi-1', intensity: 250 }));
  await handler(request({ deviceId: 'qi-1', intensity: 0 }));

  const [high, idle] = calls.map((c) => JSON.parse(c.input.payload.toString()));
  assert.equal(high.intensity, 100);
  assert.equal(idle.intensity, 0);
  assert.equal(idle.motorState, 'IDLE');
  assert.equal(idle.openCaseCount, 0);
});

test('accepts an already-parsed body', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const res = await handler({ body: { deviceId: 'qi-1', intensity: 10 } });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
});

test('rejects a deviceId that is not a Thing name, without publishing', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);

  for (const deviceId of [undefined, '', 'a/b', 'qi-1/telemetry', '#', 'qi+1', 'x'.repeat(129), 42]) {
    const res = await handler(request({ deviceId, intensity: 10 }));
    assert.equal(res.statusCode, 400, `deviceId ${JSON.stringify(deviceId)}`);
  }
  assert.equal(calls.length, 0);
});

test('rejects a missing or non-numeric intensity', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);

  for (const intensity of [undefined, '40', null]) {
    const res = await handler(request({ deviceId: 'qi-1', intensity }));
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('returns 400 for a body that is not JSON', async (t) => {
  captureConsole(t);
  const { handler } = load(t);
  const res = await handler({ body: '{not json' });
  assert.equal(res.statusCode, 400);
});

test('returns 502 when IoT Core refuses the publish', async (t) => {
  captureConsole(t);
  const { handler } = load(t, () => { throw awsError('ForbiddenException'); });
  const res = await handler(request({ deviceId: 'qi-1', intensity: 10 }));
  assert.equal(res.statusCode, 502);
});

test('relays a batch of commands, one publish per device, with a result for each', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const commands = Array.from({ length: 3 }, (_, i) => ({ deviceId: `qi-${i}`, queueDeveloperName: 'Triage', intensity: 20 * i }));

  const res = await handler(request({ commands }));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((c) => c.input.topic), ['device/qi-0/command', 'device/qi-1/command', 'device/qi-2/command']);
  assert.deepEqual(JSON.parse(res.body).results, commands.map((c) => ({ deviceId: c.deviceId, published: true })));
});

test('in a batch, a bad or refused command fails alone and says whether to retry', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, (command, input) => {
    if (input.topic === 'device/qi-2/command') throw awsError('ThrottlingException', 'Rate exceeded');
    return {};
  });

  const res = await handler(request({
    commands: [{ deviceId: 'qi-1', intensity: 10 }, { deviceId: 'qi-2', intensity: 10 }, { deviceId: 'a/b', intensity: 10 }],
  }));

  assert.equal(res.statusCode, 207);
  const results = JSON.parse(res.body).results;
  assert.deepEqual(results.map((r) => [r.deviceId, r.published, r.retryable]), [
    ['qi-1', true, undefined], ['qi-2', false, true], ['a/b', false, false],
  ]);
  // The malformed name never reached IoT Core.
  assert.ok(calls.every((c) => !c.input.topic.includes('a/b')));
});
