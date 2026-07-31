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

const { EventBridgeClient, EventBridgeSubscriptionClient, SubscribeEventHandlerCommand } = require('@aws-sdk/client-eventbridge');
const { EventBridgeSubscriptionClient: EventBusSubClient } = require('@aws-sdk/client-eventbridge');

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
        return createResponse(500, {
            message: 'Failed to dispatch alert',
            error: error.message
        });
    }
};

/**
 * Evaluate vitals against clinical thresholds
 * Mirrors the same logic in StreamingAlertService.cls for consistency
 *
 * @param {Object} detail - Event detail with patient vitals
 * @returns {string|null} Alert type if critical condition detected
 */
function evaluateAlerts(detail) {
    // Critical heart rate
    if (detail.heartRate < 50 || detail.heartRate > 120) {
        return 'CRITICAL_VITALS';
    }

    // Critical SpO2
    if (detail.spo2 < 90) {
        return 'CRITICAL_VITALS';
    }

    // Critical temperature
    if (detail.temperature > 39.0 || detail.temperature < 35.0) {
        return 'CRITICAL_VITALS';
    }

    // Critical blood pressure
    if (detail.bpSystolic > 160) {
        return 'CRITICAL_VITALS';
    }

    // Abnormal trend (non-critical but concerning)
    if (detail.heartRate < 60 || detail.heartRate > 100) {
        return 'ABNORMAL_TREND';
    }

    if (detail.spo2 < 95) {
        return 'ABNORMAL_TREND';
    }

    return null;
}

/**
 * Dispatch alert to Salesforce via REST API
 * Calls the StreamingAlertService @InvocableMethod endpoint
 *
 * @param {Object} detail - Event detail with vitals
 * @param {string} alertType - Type of alert detected
 * @returns {Promise} Salesforce API response
 */
async function dispatchToSalesforce(detail, alertType) {
    const response = await fetch(
        `${SALESFORCE_ENDPOINT}/services/apexrest/streaming-alerts/process`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SALESFORCE_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                payloads: [{
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
        const error = await response.text;
        console.error('Salesforce API error:', error);
    }

    return response;
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
