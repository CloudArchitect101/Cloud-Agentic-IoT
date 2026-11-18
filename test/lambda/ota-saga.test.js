'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, captureConsole } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/ota-saga/index.js');
const load = () => loadWithFakes(HANDLER);

const body = (res) => JSON.parse(res.body);

test('completes when the device has acknowledged', async (t) => {
  captureConsole(t);
  const { handler } = load();
  const res = await handler({ deviceId: 'pm-1', version: '2.1.0', deviceAcked: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res), { status: 'COMPLETE', deviceId: 'pm-1' });
});

test('reports "not ready" as in progress, without compensating', async (t) => {
  const logs = captureConsole(t);
  const { handler } = load();
  const res = await handler({ deviceId: 'pm-1', version: '2.1.0' });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(body(res), { status: 'IN_PROGRESS', step: 'await_device_ack' });
  assert.equal(logs.filter((l) => l.startsWith('compensating')).length, 0);
});

test('a failed step compensates every completed step, most recent first', async (t) => {
  const logs = captureConsole(t);
  const { handler } = load();

  // The steps are simulated, so the failure is injected: reading thingGroup
  // is the first thing create_iot_job (step 3) does.
  const context = { deviceId: 'pm-1', version: '2.1.0' };
  Object.defineProperty(context, 'thingGroup', {
    get() { throw new Error('CreateJob failed'); },
  });

  // Used to throw "completed.reverse is not iterable" here, so nothing was undone.
  const res = await handler(context);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(body(res), { status: 'ROLLED_BACK', failedStep: 'create_iot_job', error: 'CreateJob failed' });
  const compensations = logs.filter((l) => l.startsWith('compensating')).map((l) => l.split(' ')[1]);
  assert.deepEqual(compensations, ['mark_device_active', 'delete_staged_firmware']);
});

test('from SQS, a saga still waiting is reported so the message stays queued', async (t) => {
  captureConsole(t);
  const { handler } = load();

  const res = await handler({
    Records: [
      { messageId: 'waiting', body: JSON.stringify({ deviceId: 'pm-1', version: '2.1.0' }) },
      { messageId: 'done', body: JSON.stringify({ deviceId: 'pm-2', version: '2.1.0', deviceAcked: true }) },
    ],
  });

  // A plain success here would delete both messages, the waiting one included.
  assert.deepEqual(res, { batchItemFailures: [{ itemIdentifier: 'waiting' }] });
});

test('from SQS, a malformed message is reported rather than dropped', async (t) => {
  captureConsole(t);
  const { handler } = load();
  const res = await handler({ Records: [{ messageId: 'bad', body: '{not json' }] });
  assert.deepEqual(res, { batchItemFailures: [{ itemIdentifier: 'bad' }] });
});

test('from SQS, the receive count is logged as the attempt number', async (t) => {
  const logs = captureConsole(t);
  const { handler } = load();
  await handler({
    Records: [{
      messageId: 'm1',
      attributes: { ApproximateReceiveCount: '3' },
      body: JSON.stringify({ deviceId: 'pm-1', version: '2.1.0', deviceAcked: true }),
    }],
  });
  assert.ok(logs.some((l) => l.startsWith('step stage_firmware') && l.includes('"attempt":3')));
});
