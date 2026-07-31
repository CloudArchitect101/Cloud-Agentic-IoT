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
      // groups (canary-ring-1 -> patient-monitors), which is what makes
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

exports.handler = async (event) => {
  const context = typeof event.body === 'string' ? JSON.parse(event.body) : event;
  const completed = [];

  for (const step of STEPS) {
    try {
      const result = await runStep(step, context);
      completed.push(step);
      Object.assign(context, result);
    } catch (err) {
      if (err.retryable) {
        // Leave the message on the queue; visibility timeout brings it back.
        // Do NOT compensate - the saga has not failed, it is still in flight.
        console.log(`step ${step.name} not ready, will retry`);
        return { statusCode: 202, body: JSON.stringify({ status: 'IN_PROGRESS', step: step.name }) };
      }

      console.error(`step ${step.name} failed, compensating ${completed.length} completed step(s)`);
      // Reverse order: undo the most recent side effect first.
      for (const done of completed.reverse) {
        try {
          await compensate(done, context);
        } catch (compErr) {
          // A failed compensation needs a human. Losing this signal is how
          // devices end up stranded in UPDATING forever.
          console.error(`COMPENSATION FAILED for ${done.compensate}: ${compErr.message}`);
        }
      }
      return {
        statusCode: 500,
        body: JSON.stringify({ status: 'ROLLED_BACK', failedStep: step.name, error: err.message }),
      };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ status: 'COMPLETE', deviceId: context.deviceId }) };
};

exports.STEPS = STEPS;
