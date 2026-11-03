'use strict';

/*
 * alert-dispatcher/index.js
 *
 * Consumes patient.vitals.update events from EventBridge, judges them against
 * the clinical bands, and raises an alert in Salesforce through the
 * StreamingAlertService invocable action, which publishes the Platform Event
 * the Agentforce agents act on.
 *
 * The bands are the ones patient-vitals scores with (SSM, from
 * config/vital-thresholds.json), and StreamingAlertService decides the alert
 * type the same way from the same numbers in Vital_Sign_Threshold__mdt: any
 * vital in its critical band is CRITICAL_VITALS, otherwise any vital in its
 * warning band is ABNORMAL_TREND. Nothing clinical is written in this file.
 *
 * Salesforce is reached with the shared JWT session (one token per
 * container), not a long-lived token in an environment variable.
 */

const { loadThresholds, assess } = require('@cloud-agentic-iot/shared/vitals');
const { invokeAction } = require('@cloud-agentic-iot/shared/salesforce');

exports.handler = async (event) => {
  const detail = (event && event.detail) || {};
  try {
    const alertType = alertTypeFor(detail, await loadThresholds());

    if (alertType) {
      await dispatchToSalesforce(detail);
      console.log('Alert dispatched to Salesforce', { deviceId: detail.deviceId, alertType });
    } else {
      console.log('No alert for device', { deviceId: detail.deviceId });
    }

    return createResponse(200, {
      message: 'Alert evaluation complete',
      deviceId: detail.deviceId,
      alertType: alertType || 'NONE',
    });
  } catch (error) {
    console.error('Error dispatching alert', { deviceId: detail.deviceId, error: error.message });
    // Rethrown: EventBridge invokes this function asynchronously, so a
    // returned 500 counts as delivered and the alert is lost. A thrown
    // error is retried, then dead-lettered.
    throw error;
  }
};

/** CRITICAL_VITALS, ABNORMAL_TREND, or null; a vital that was not measured counts for nothing. */
function alertTypeFor(detail, thresholds) {
  const { critical, warning } = assess({
    heartRate: detail.heartRate,
    spo2: detail.spo2,
    temperature: detail.temperature,
    bpSystolic: detail.bpSystolic,
  }, thresholds);
  if (critical.length) return 'CRITICAL_VITALS';
  if (warning.length) return 'ABNORMAL_TREND';
  return null;
}

/**
 * An invocable method is exposed at /services/data/vXX.X/actions/custom/apex/
 * <ClassName>, with one object per call under "inputs". The call as a whole
 * succeeds even when an input fails; each result carries its own isSuccess.
 */
async function dispatchToSalesforce(detail) {
  const results = await invokeAction('StreamingAlertService', [{
    deviceId: detail.deviceId,
    heartRate: detail.heartRate,
    spo2: detail.spo2,
    temperature: detail.temperature,
    bpSystolic: detail.bpSystolic,
    bpDiastolic: detail.bpDiastolic,
    sourceSystem: detail.sourceSystem,
  }]);
  const failed = results.find((result) => !result.isSuccess);
  if (failed) {
    throw new Error(`StreamingAlertService failed: ${JSON.stringify(failed.errors)}`);
  }
  return results;
}

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
