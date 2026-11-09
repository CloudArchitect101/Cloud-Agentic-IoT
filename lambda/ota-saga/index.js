'use strict';

/**
 * Saga orchestrator for an over-the-air firmware update of one board.
 *
 * A firmware update is the textbook case for a saga rather than a transaction:
 * the steps span S3, the device registry, AWS IoT Jobs and a physical board,
 * they cannot share a lock, and the board may vanish mid-flight. Each step
 * therefore has an explicit compensating action, and a failure at step 4
 * undoes steps 3, 2 and 1 in reverse order.
 *
 *   stage_firmware        copy the published build to firmware/saga/<run>.bin
 *                         compensated by deleting that copy
 *   mark_device_updating  the Thing's otaState attribute -> UPDATING
 *                         compensated by otaState -> ACTIVE (its old firmware)
 *   create_iot_job        one IoT Job for this Thing, the same document
 *                         scripts/ota.sh sends; compensated by cancelling it
 *   await_device_ack      the job execution's status: SUCCEEDED completes,
 *                         QUEUED or IN_PROGRESS is "not ready", anything else
 *                         fails the saga. Compensated by nothing on AWS: an
 *                         ESP32 boots the new image only once it is written
 *                         and verified, so a failed install leaves the old
 *                         firmware running.
 *
 * The message on the queue is the saga's whole state: { deviceId, sketch,
 * version, runId[, firmwareKey] }. scripts/ota-saga.sh sends it. Every
 * delivery runs the steps again from the top, so each one is idempotent by
 * contract: SQS delivers at least once, and here a redelivery is routine, it
 * is how the saga polls the board. A copy that exists is copied again, a job
 * that exists is kept, an attribute is set to the same value.
 */

const s3Sdk = require('@aws-sdk/client-s3');
const iotSdk = require('@aws-sdk/client-iot');
const { requiredEnv, numberEnv } = require('@cloud-agentic-iot/shared/env');

const s3 = new s3Sdk.S3Client({});
const iot = new iotSdk.IoTClient({});

const STEPS = [
  { name: 'stage_firmware',       compensate: 'delete_staged_firmware' },
  { name: 'mark_device_updating', compensate: 'mark_device_active' },
  { name: 'create_iot_job',       compensate: 'cancel_iot_job' },
  { name: 'await_device_ack',     compensate: 'rollback_device_firmware' },
];

const WAITING = new Set(['QUEUED', 'IN_PROGRESS']);
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const THING = /^[A-Za-z0-9_:-]{1,128}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

/** The saga's input, checked before any step runs: a bad message never touches AWS. */
function validate(context) {
  if (!context || typeof context !== 'object') throw new Error('The message is not a JSON object.');
  const { deviceId, sketch, version, runId, firmwareKey } = context;
  if (!THING.test(deviceId || '')) throw new Error(`deviceId "${deviceId}" is not a Thing name.`);
  if (!NAME.test(sketch || '')) throw new Error(`sketch "${sketch}" is not a sketch name.`);
  if (!VERSION.test(version || '')) throw new Error(`version "${version}" is not a firmware version.`);
  if (!NAME.test(runId || '')) throw new Error(`runId "${runId}" must be 1-40 letters, digits, - or _.`);
  if (firmwareKey !== undefined && !(typeof firmwareKey === 'string'
      && firmwareKey.startsWith(`firmware/${sketch}/`) && firmwareKey.endsWith('.bin') && !firmwareKey.includes('..'))) {
    throw new Error(`firmwareKey must be a .bin under firmware/${sketch}/.`);
  }
}

const jobIdOf = (context) => `saga-${context.deviceId}-${context.runId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
const stagedKeyOf = (context) => `firmware/saga/${context.deviceId}/${context.runId}.bin`;
const sourceKeyOf = (context) => context.firmwareKey || `firmware/${context.sketch}/${context.version}.bin`;

function thingArn(deviceId) {
  return `arn:aws:iot:${requiredEnv('AWS_REGION')}:${requiredEnv('ACCOUNT_ID')}:thing/${deviceId}`;
}

async function setOtaState(deviceId, otaState, otaVersion) {
  const attributes = { otaState };
  if (otaVersion) attributes.otaVersion = otaVersion;
  await iot.send(new iotSdk.UpdateThingCommand({
    thingName: deviceId,
    attributePayload: { attributes, merge: true },
  }));
}

function notReady(message) {
  const e = new Error(message);
  e.retryable = true;
  return e;
}

async function runStep(step, context) {
  console.log(`step ${step.name}`, { deviceId: context.deviceId, runId: context.runId, attempt: context.attempt });
  const bucket = requiredEnv('FIRMWARE_BUCKET');
  switch (step.name) {
    case 'stage_firmware': {
      const source = sourceKeyOf(context);
      try {
        await s3.send(new s3Sdk.HeadObjectCommand({ Bucket: bucket, Key: source }));
      } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
          throw new Error(`No published firmware at ${source}. Publish it first (scripts/ota.sh).`);
        }
        throw err;
      }
      const staged = stagedKeyOf(context);
      await s3.send(new s3Sdk.CopyObjectCommand({
        Bucket: bucket, Key: staged, CopySource: `${bucket}/${source}`, ServerSideEncryption: 'AES256',
      }));
      return { stagedKey: staged };
    }
    case 'mark_device_updating':
      // DescribeThing first: a Thing that does not exist fails here, before a
      // job is made for it.
      await iot.send(new iotSdk.DescribeThingCommand({ thingName: context.deviceId }));
      await setOtaState(context.deviceId, 'UPDATING');
      return {};
    case 'create_iot_job': {
      const jobId = jobIdOf(context);
      const document = {
        operation: 'ota',
        sketch: context.sketch,
        version: context.version,
        url: `\${aws:iot:s3-presigned-url:https://s3.${requiredEnv('AWS_REGION')}.amazonaws.com/${bucket}/${context.stagedKey}}`,
      };
      try {
        await iot.send(new iotSdk.CreateJobCommand({
          jobId,
          targets: [thingArn(context.deviceId)],
          targetSelection: 'SNAPSHOT',
          document: JSON.stringify(document),
          description: `Saga ${context.runId}: ${context.sketch} ${context.version} to ${context.deviceId}`,
          presignedUrlConfig: {
            roleArn: requiredEnv('PRESIGN_ROLE_ARN'),
            expiresInSec: numberEnv('PRESIGN_EXPIRES_SECONDS'),
          },
          timeoutConfig: { inProgressTimeoutInMinutes: numberEnv('JOB_TIMEOUT_MINUTES') },
        }));
      } catch (err) {
        // The redelivery of a message whose job was made last time.
        if (err.name !== 'ResourceAlreadyExistsException') throw err;
      }
      return { jobId };
    }
    case 'await_device_ack': {
      let status;
      try {
        const { execution } = await iot.send(new iotSdk.DescribeJobExecutionCommand({
          jobId: context.jobId, thingName: context.deviceId,
        }));
        status = execution && execution.status;
      } catch (err) {
        // Right after CreateJob the execution may not be listed yet.
        if (err.name === 'ResourceNotFoundException') throw notReady('The job execution is not listed yet');
        throw err;
      }
      if (status === 'SUCCEEDED') return { acked: true };
      if (WAITING.has(status)) {
        // Not an error - the board simply has not reported yet. Telling
        // "still waiting" from "failed" is what stops a slow board triggering
        // an unnecessary rollback. Past the attempt budget it is a failure,
        // so the board is never left marked UPDATING by a message that went
        // to the dead-letter queue.
        if (context.attempt >= numberEnv('MAX_ATTEMPTS')) {
          throw new Error(`The board did not finish in ${context.attempt} attempts (job ${status})`);
        }
        throw notReady(`Job execution is ${status}`);
      }
      throw new Error(`The board reported the job ${status || 'with no status'}`);
    }
    default:
      throw new Error(`Unknown step ${step.name}`);
  }
}

async function compensate(step, context) {
  console.log(`compensating ${step.compensate}`, { deviceId: context.deviceId, runId: context.runId });
  switch (step.compensate) {
    case 'delete_staged_firmware':
      await s3.send(new s3Sdk.DeleteObjectCommand({ Bucket: requiredEnv('FIRMWARE_BUCKET'), Key: stagedKeyOf(context) }));
      return;
    case 'mark_device_active':
      await setOtaState(context.deviceId, 'ACTIVE');
      return;
    case 'cancel_iot_job':
      try {
        await iot.send(new iotSdk.CancelJobCommand({ jobId: jobIdOf(context), force: true, comment: 'Saga rolled back' }));
      } catch (err) {
        // A job that already ended cannot be cancelled, and need not be.
        if (err.name !== 'InvalidRequestException' && err.name !== 'ResourceNotFoundException') throw err;
      }
      return;
    case 'rollback_device_firmware':
      console.log('the board keeps the firmware it runs: it switches image only after a verified install');
      return;
    default:
      throw new Error(`Unknown compensation ${step.compensate}`);
  }
}

async function runSaga(context) {
  validate(context);
  const completed = [];

  for (const step of STEPS) {
    try {
      const result = await runStep(step, context);
      completed.push(step);
      Object.assign(context, result);
    } catch (err) {
      if (err.retryable || err.$retryable) {
        // Do NOT compensate - the saga has not failed, it is still in flight.
        // $retryable is the SDK's mark on throttling and transient faults.
        console.log(`step ${step.name} not ready, will retry: ${err.message}`);
        return { status: 'IN_PROGRESS', step: step.name };
      }

      console.error(`step ${step.name} failed, compensating ${completed.length} completed step(s): ${err.message}`);
      // Reverse order: undo the most recent side effect first.
      for (const done of [...completed].reverse()) {
        try {
          await compensate(done, context);
        } catch (compErr) {
          // A failed compensation needs a human. Losing this signal is how
          // devices end up stranded in UPDATING forever. It does not stop the
          // unwind: the steps before it are still undone.
          console.error(`COMPENSATION FAILED for ${done.compensate}: ${compErr.message}`);
        }
      }
      return { status: 'ROLLED_BACK', failedStep: step.name, error: err.message };
    }
  }

  await setOtaState(context.deviceId, 'ACTIVE', context.version);
  try {
    await s3.send(new s3Sdk.DeleteObjectCommand({ Bucket: requiredEnv('FIRMWARE_BUCKET'), Key: stagedKeyOf(context) }));
  } catch (err) {
    console.warn('staged copy not deleted', { key: stagedKeyOf(context), error: err.message });
  }
  console.log('saga complete', { deviceId: context.deviceId, version: context.version, runId: context.runId });
  return { status: 'COMPLETE', deviceId: context.deviceId, version: context.version };
}

const STATUS_CODES = { COMPLETE: 200, IN_PROGRESS: 202, ROLLED_BACK: 500 };

exports.handler = async (event) => {
  // From SQS, the only way to leave a message on the queue is to report it as
  // a batch item failure; the visibility timeout then brings it back. Any
  // successful return deletes the whole batch, so a saga that is still waiting
  // must be reported, not returned as a 202. The event source mapping has
  // FunctionResponseTypes: [ReportBatchItemFailures] for this to apply.
  if (Array.isArray(event.Records)) {
    const batchItemFailures = [];
    for (const record of event.Records) {
      try {
        const context = JSON.parse(record.body);
        context.attempt = Number(record.attributes?.ApproximateReceiveCount) || 1;
        const outcome = await runSaga(context);
        if (outcome.status === 'IN_PROGRESS') {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      } catch (err) {
        // A malformed message, or an AWS error outside any step, is kept,
        // not dropped, so that it reaches the dead-letter queue where someone
        // can see it.
        console.error('saga message failed', { messageId: record.messageId, error: err.message });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }

  // Direct invocation (console, tests).
  const context = typeof event.body === 'string' ? JSON.parse(event.body) : { ...event };
  context.attempt = context.attempt || 1;
  const outcome = await runSaga(context);
  return { statusCode: STATUS_CODES[outcome.status], body: JSON.stringify(outcome) };
};

exports.STEPS = STEPS;
