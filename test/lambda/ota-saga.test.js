'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, captureConsole, withEnv } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/ota-saga/index.js');
const BUCKET = 'cloud-agentic-iot-ota-dev-firmwarebucket-abc123';
const ROLE = 'arn:aws:iam::111122223333:role/cloud-agentic-iot-ota-Dev-OtaPresignRole-XYZ';

const SAGA = { deviceId: 'PatientExternalESP32', sketch: 'patient-monitor', version: '2.5.0', runId: '20261109010000' };

function awsError(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}

/**
 * The saga against fake S3 and IoT. `execution` is the job execution status
 * the board reports; `fail` maps a command name to the error it throws.
 */
function load(t, { execution = 'SUCCEEDED', fail = {}, attempts = '20' } = {}) {
  withEnv(t, {
    AWS_REGION: 'us-east-2',
    ACCOUNT_ID: '111122223333',
    FIRMWARE_BUCKET: BUCKET,
    PRESIGN_ROLE_ARN: ROLE,
    PRESIGN_EXPIRES_SECONDS: '3600',
    JOB_TIMEOUT_MINUTES: '10',
    MAX_ATTEMPTS: attempts,
  });
  const calls = [];
  const respond = (command, input) => {
    calls.push({ command, input });
    if (fail[command]) throw fail[command];
    if (command === 'DescribeJobExecutionCommand') return { execution: { status: execution } };
    return {};
  };
  const s3 = fakeAwsSdk('S3Client', ['HeadObjectCommand', 'CopyObjectCommand', 'DeleteObjectCommand'], respond);
  const iot = fakeAwsSdk('IoTClient', ['DescribeThingCommand', 'UpdateThingCommand', 'CreateJobCommand',
    'CancelJobCommand', 'DescribeJobExecutionCommand'], respond);
  const { handler } = loadWithFakes(HANDLER, { '@aws-sdk/client-s3': s3.sdk, '@aws-sdk/client-iot': iot.sdk });
  return { handler, calls, names: () => calls.map((c) => c.command.replace(/Command$/, '')) };
}

const body = (res) => JSON.parse(res.body);
const otaStates = (calls) => calls.filter((c) => c.command === 'UpdateThingCommand')
  .map((c) => c.input.attributePayload.attributes);

test('a board that installs completes the saga: staged, marked, one job, then ACTIVE at the new version', async (t) => {
  captureConsole(t);
  const { handler, calls, names } = load(t);

  const res = await handler({ ...SAGA });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res), { status: 'COMPLETE', deviceId: 'PatientExternalESP32', version: '2.5.0' });
  assert.deepEqual(names(), ['HeadObject', 'CopyObject', 'DescribeThing', 'UpdateThing', 'CreateJob',
    'DescribeJobExecution', 'UpdateThing', 'DeleteObject']);

  const copy = calls.find((c) => c.command === 'CopyObjectCommand').input;
  assert.equal(copy.CopySource, `${BUCKET}/firmware/patient-monitor/2.5.0.bin`);
  assert.equal(copy.Key, 'firmware/saga/PatientExternalESP32/20261109010000.bin');

  const job = calls.find((c) => c.command === 'CreateJobCommand').input;
  assert.equal(job.jobId, 'saga-PatientExternalESP32-20261109010000');
  assert.deepEqual(job.targets, ['arn:aws:iot:us-east-2:111122223333:thing/PatientExternalESP32']);
  assert.deepEqual(job.presignedUrlConfig, { roleArn: ROLE, expiresInSec: 3600 });
  // The same document scripts/ota.sh sends, so the board needs nothing new.
  assert.deepEqual(JSON.parse(job.document), {
    operation: 'ota',
    sketch: 'patient-monitor',
    version: '2.5.0',
    url: `\${aws:iot:s3-presigned-url:https://s3.us-east-2.amazonaws.com/${BUCKET}/firmware/saga/PatientExternalESP32/20261109010000.bin}`,
  });
  assert.deepEqual(otaStates(calls), [{ otaState: 'UPDATING' }, { otaState: 'ACTIVE', otaVersion: '2.5.0' }]);
});

test('a board that has not answered yet is "not ready": in progress, nothing compensated', async (t) => {
  const logs = captureConsole(t);
  for (const status of ['QUEUED', 'IN_PROGRESS']) {
    const { handler, names } = load(t, { execution: status });
    const res = await handler({ ...SAGA, attempt: 3 });
    assert.equal(res.statusCode, 202, status);
    assert.deepEqual(body(res), { status: 'IN_PROGRESS', step: 'await_device_ack' });
    assert.ok(!names().includes('CancelJob'), status);
  }
  assert.equal(logs.filter((l) => l.startsWith('compensating')).length, 0);
});

test('a board that fails the install unwinds every step, most recent first', async (t) => {
  const logs = captureConsole(t);
  const { handler, calls, names } = load(t, { execution: 'FAILED' });

  const res = await handler({ ...SAGA });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(body(res), { status: 'ROLLED_BACK', failedStep: 'await_device_ack', error: 'The board reported the job FAILED' });
  const compensations = logs.filter((l) => l.startsWith('compensating')).map((l) => l.split(' ')[1]);
  assert.deepEqual(compensations, ['cancel_iot_job', 'mark_device_active', 'delete_staged_firmware']);
  assert.deepEqual(names().slice(-3), ['CancelJob', 'UpdateThing', 'DeleteObject']);
  assert.equal(calls.find((c) => c.command === 'CancelJobCommand').input.jobId, 'saga-PatientExternalESP32-20261109010000');
  assert.deepEqual(otaStates(calls), [{ otaState: 'UPDATING' }, { otaState: 'ACTIVE' }]);
});

test('a board still waiting when the attempts run out is a failure, so it is never left UPDATING', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, { execution: 'QUEUED', attempts: '20' });
  const res = await handler({ ...SAGA, attempt: 20 });
  assert.equal(body(res).status, 'ROLLED_BACK');
  assert.deepEqual(otaStates(calls).at(-1), { otaState: 'ACTIVE' });
});

test('a redelivered message keeps the job it already made', async (t) => {
  captureConsole(t);
  const { handler } = load(t, { fail: { CreateJobCommand: awsError('ResourceAlreadyExistsException') } });
  const res = await handler({ ...SAGA });
  assert.equal(body(res).status, 'COMPLETE');
});

test('a throttled call is retried, not rolled back', async (t) => {
  const logs = captureConsole(t);
  const throttled = awsError('ThrottlingException');
  throttled.$retryable = { throttling: true };
  const { handler } = load(t, { fail: { DescribeJobExecutionCommand: throttled } });
  const res = await handler({ ...SAGA });
  assert.equal(body(res).status, 'IN_PROGRESS');
  assert.equal(logs.filter((l) => l.startsWith('compensating')).length, 0);
});

test('a build that is not published fails before anything changes', async (t) => {
  captureConsole(t);
  const { handler, names } = load(t, { fail: { HeadObjectCommand: awsError('NotFound') } });
  const res = await handler({ ...SAGA });
  assert.equal(body(res).failedStep, 'stage_firmware');
  assert.match(body(res).error, /No published firmware at firmware\/patient-monitor\/2\.5\.0\.bin/);
  assert.deepEqual(names(), ['HeadObject']);
});

test('a failed compensation is logged loudly and the unwind goes on', async (t) => {
  const logs = captureConsole(t);
  const { handler, names } = load(t, {
    execution: 'TIMED_OUT',
    fail: { CancelJobCommand: awsError('AccessDeniedException') },
  });
  const res = await handler({ ...SAGA });
  assert.equal(body(res).status, 'ROLLED_BACK');
  assert.ok(logs.some((l) => l.includes('COMPENSATION FAILED for cancel_iot_job')));
  assert.deepEqual(names().slice(-2), ['UpdateThing', 'DeleteObject']);
});

test('a firmware key outside the sketch, or a bad name, is refused before any AWS call', async (t) => {
  captureConsole(t);
  for (const bad of [
    { firmwareKey: 'firmware/queue-indicator/1.0.0.bin' },
    { firmwareKey: 'firmware/patient-monitor/../../secret.bin' },
    { deviceId: 'PatientExternalESP32/../x' },
    { runId: '' },
  ]) {
    const { handler, names } = load(t);
    await assert.rejects(handler({ ...SAGA, ...bad }), Error, JSON.stringify(bad));
    assert.deepEqual(names(), [], JSON.stringify(bad));
  }
});

test('from SQS, a saga still waiting is reported so the message stays queued', async (t) => {
  captureConsole(t);
  const { handler } = load(t, { execution: 'IN_PROGRESS' });
  const res = await handler({
    Records: [{ messageId: 'waiting', attributes: { ApproximateReceiveCount: '2' }, body: JSON.stringify(SAGA) }],
  });
  // A plain success here would delete the message, and the saga with it.
  assert.deepEqual(res, { batchItemFailures: [{ itemIdentifier: 'waiting' }] });
});

test('from SQS, a finished saga is deleted from the queue', async (t) => {
  captureConsole(t);
  const { handler } = load(t);
  const res = await handler({ Records: [{ messageId: 'done', body: JSON.stringify(SAGA) }] });
  assert.deepEqual(res, { batchItemFailures: [] });
});

test('from SQS, a malformed message is reported rather than dropped', async (t) => {
  captureConsole(t);
  const { handler } = load(t);
  const res = await handler({ Records: [{ messageId: 'bad', body: '{not json' }] });
  assert.deepEqual(res, { batchItemFailures: [{ itemIdentifier: 'bad' }] });
});

test('from SQS, the receive count is the attempt number', async (t) => {
  const logs = captureConsole(t);
  const { handler } = load(t);
  await handler({ Records: [{ messageId: 'm1', attributes: { ApproximateReceiveCount: '3' }, body: JSON.stringify(SAGA) }] });
  assert.ok(logs.some((l) => l.startsWith('step stage_firmware') && l.includes('"attempt":3')));
});
