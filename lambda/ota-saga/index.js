/**
 * Saga orchestrator for an over-the-air firmware rollout.
 *
 * A firmware update is the textbook case for a saga rather than a transaction:
 * the steps span AWS and a physical device, they cannot share a lock, and the
 * device may vanish mid-flight. Each step therefore has an explicit
 * compensating action, and the orchestrator records where it got to so a
 * failure at step 3 undoes steps 2 and 1 in reverse order.
 */

const STEPS = [
  { name: 'stage_firmware',   compensate: 'delete_staged_firmware' },
  { name: 'mark_device_updating', compensate: 'mark_device_active' },
  { name: 'create_iot_job',   compensate: 'cancel_iot_job' },
  { name: 'await_device_ack', compensate: 'rollback_device_firmware' },
];

/**
 * Steps are idempotent by contract: SQS delivers at least once, so every
 * handler must tolerate being run twice with the same input. This is the
 * single most common thing people get wrong with queue-driven sagas - the
 * retry is not the exception, it is routine.
 *
 * The step bodies are still simulated: each returns what the real AWS call
 * would, without making it.
 */
async function runStep(step, context) {
  console.log(`step ${step.name}`, { deviceId: context.deviceId, attempt: context.attempt });
  switch (step.name) {
    case 'stage_firmware':
      return { firmwareKey: `firmware/${context.deviceId}/${context.version}.bin` };
    case 'mark_device_updating':
      return { previousStatus: context.currentStatus || 'ACTIVE' };
    case 'create_iot_job':
      // Targeting is Thing Group membership, not a device list held here:
      // arn:aws:iot:<region>:<acct>:thinggroup/<group> for a fleet rollout, or
      // .../thing/<name> for a single device. Batch by moving devices between
      // groups (canary-patient-monitor -> fleet-patient-monitor), which is what makes
      // migration-runbook phase 4 batched rather than all-at-once.
      return {
        jobId: `ota-${context.deviceId}-${context.version}`,
        target: context.thingGroup
          ? `thinggroup/${context.thingGroup}`
          : `thing/${context.deviceId}`,
      };
    case 'await_device_ack':
      if (!context.deviceAcked) {
        // Not an error - the device simply has not reported yet. Distinguishing
        // "still waiting" from "failed" is what stops a slow device triggering
        // an unnecessary rollback.
        const e = new Error('Device has not acknowledged yet');
        e.retryable = true;
        throw e;
      }
      return { acked: true };
    default:
      throw new Error(`Unknown step ${step.name}`);
  }
}

async function compensate(step, context) {
  console.log(`compensating ${step.compensate}`, { deviceId: context.deviceId });
  return { compensated: step.compensate };
}

async function runSaga(context) {
  const completed = [];

  for (const step of STEPS) {
    try {
      const result = await runStep(step, context);
      completed.push(step);
      Object.assign(context, result);
    } catch (err) {
      if (err.retryable) {
        // Do NOT compensate - the saga has not failed, it is still in flight.
        console.log(`step ${step.name} not ready, will retry`);
        return { status: 'IN_PROGRESS', step: step.name };
      }

      console.error(`step ${step.name} failed, compensating ${completed.length} completed step(s)`);
      // Reverse order: undo the most recent side effect first.
      for (const done of [...completed].reverse()) {
        try {
          await compensate(done, context);
        } catch (compErr) {
          // A failed compensation needs a human. Losing this signal is how
          // devices end up stranded in UPDATING forever.
          console.error(`COMPENSATION FAILED for ${done.compensate}: ${compErr.message}`);
        }
      }
      return { status: 'ROLLED_BACK', failedStep: step.name, error: err.message };
    }
  }

  return { status: 'COMPLETE', deviceId: context.deviceId };
}

const STATUS_CODES = { COMPLETE: 200, IN_PROGRESS: 202, ROLLED_BACK: 500 };

exports.handler = async (event) => {
  // From SQS, the only way to leave a message on the queue is to report it as
  // a batch item failure; the visibility timeout then brings it back. Any
  // successful return deletes the whole batch, so a saga that is still waiting
  // must be reported, not returned as a 202. The event source mapping needs
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
        // A malformed message is kept, not dropped, so that it reaches the
        // dead-letter queue where someone can see it.
        console.error('saga message failed', { messageId: record.messageId, error: err.message });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }

  // Direct invocation (console, tests, API Gateway).
  const context = typeof event.body === 'string' ? JSON.parse(event.body) : event;
  const outcome = await runSaga(context);
  return { statusCode: STATUS_CODES[outcome.status], body: JSON.stringify(outcome) };
};

exports.STEPS = STEPS;
