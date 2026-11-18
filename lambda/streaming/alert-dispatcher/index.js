/*
 * alert-dispatcher/index.js
 *
 * AWS Lambda function that consumes EventBridge events, evaluates clinical thresholds,
 * and dispatches alerts to Salesforce via REST API.
 *
 * This is the second consumer in the EventBridge fan-out pattern:
 * 1. Subscribes to EventBridge events (detailType: patient.vitals.update)
 * 2. Evaluates vitals against clinical thresholds
 * 3. Calls Salesforce StreamingAlertService via REST API
 * 4. Platform Events fire in Salesforce, triggering Agentforce agents
 *
 * Demonstrates: Real-time streams, Platform Events, event-driven architecture, async
 */

const SALESFORCE_ENDPOINT = process.env.SALESFORCE_ENDPOINT || 'https://instance.salesforce.com';
const SALESFORCE_ACCESS_TOKEN = process.env.SALESFORCE_ACCESS_TOKEN;

/**
 * Main Lambda handler - subscribes to EventBridge and dispatches alerts
 * This function runs as an EventBridge target (not a traditional Lambda handler)
 *
 * @param {Object} event - EventBridge event with patient vitals
 * @param {Object} context - Lambda context
 * @returns {Object} Dispatch result
 */
exports.handler = async (event, context) => {
    console.log('Received EventBridge event:', JSON.stringify(event));

    try {
        const detail = event.detail;

        // Evaluate clinical thresholds
        const alertType = evaluateAlerts(detail);

        if (alertType) {
            // Dispatch alert to Salesforce
            const result = await dispatchToSalesforce(detail, alertType);
            console.log('Alert dispatched to Salesforce:', result);
        } else {
            console.log('No critical alerts for device:', detail.deviceId);
        }

        return createResponse(200, {
            message: 'Alert evaluation complete',
            deviceId: detail.deviceId,
            alertType: alertType || 'NONE'
        });

    } catch (error) {
        console.error('Error dispatching alert:', error);
        // Rethrown: EventBridge invokes this function asynchronously, so a
        // returned 500 counts as delivered and the alert is lost. A thrown
        // error is retried.
        throw error;
    }
};

/**
 * Evaluate vitals against clinical thresholds
 * Mirrors the same logic in StreamingAlertService.cls for consistency,
 * including its null checks: a vital the device did not report is skipped.
 * Compared directly, null < 50 is true in JavaScript, so a missing heart rate
 * would raise a critical alert.
 *
 * @param {Object} detail - Event detail with patient vitals
 * @returns {string|null} Alert type if critical condition detected
 */
function evaluateAlerts(detail) {
    const has = (value) => typeof value === 'number' && Number.isFinite(value);
    const { heartRate, spo2, temperature, bpSystolic } = detail;

    // Critical heart rate
    if (has(heartRate) && (heartRate < 50 || heartRate > 120)) {
        return 'CRITICAL_VITALS';
    }

    // Critical SpO2
    if (has(spo2) && spo2 < 90) {
        return 'CRITICAL_VITALS';
    }

    // Critical temperature
    if (has(temperature) && (temperature > 39.0 || temperature < 35.0)) {
        return 'CRITICAL_VITALS';
    }

    // Critical blood pressure
    if (has(bpSystolic) && bpSystolic > 160) {
        return 'CRITICAL_VITALS';
    }

    // Abnormal trend (non-critical but concerning)
    if (has(heartRate) && (heartRate < 60 || heartRate > 100)) {
        return 'ABNORMAL_TREND';
    }

    if (has(spo2) && spo2 < 95) {
        return 'ABNORMAL_TREND';
    }

    return null;
}

/**
 * Dispatch alert to Salesforce via REST API
 * Calls the StreamingAlertService @InvocableMethod endpoint
 *
 * An invocable method is exposed at /services/data/vXX.X/actions/custom/apex/
 * <ClassName>, with one object per call under "inputs". There is no
 * @RestResource in this repo, so the /services/apexrest/ path it used to call
 * does not exist.
 *
 * @param {Object} detail - Event detail with vitals
 * @param {string} alertType - Type of alert detected
 * @returns {Promise<Array>} One result per input
 */
async function dispatchToSalesforce(detail, alertType) {
    const response = await fetch(
        `${SALESFORCE_ENDPOINT}/services/data/v64.0/actions/custom/apex/StreamingAlertService`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SALESFORCE_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                inputs: [{
                    deviceId: detail.deviceId,
                    heartRate: detail.heartRate,
                    spo2: detail.spo2,
                    temperature: detail.temperature,
                    bpSystolic: detail.bpSystolic,
                    bpDiastolic: detail.bpDiastolic,
                    sourceSystem: detail.sourceSystem
                }]
            })
        }
    );

    if (!response.ok) {
        throw new Error(`Salesforce returned ${response.status}: ${await response.text()}`);
    }

    // The call as a whole succeeds even when an input fails; each result
    // carries its own isSuccess.
    const results = await response.json();
    const failed = results.find((result) => !result.isSuccess);
    if (failed) {
        throw new Error(`StreamingAlertService failed: ${JSON.stringify(failed.errors)}`);
    }
    return results;
}

/**
 * Create standardized API response
 */
function createResponse(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(body)
    };
}
