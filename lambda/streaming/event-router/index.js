/*
 * event-router/index.js
 *
 * AWS Lambda function that routes patient telemetry events via EventBridge
 * to multiple consumers (alert dispatcher, data sink, analytics).
 *
 * This is the core of the real-time streaming architecture:
 * 1. Receives telemetry from IoT Core
 * 2. Validates and enriches the event
 * 3. Routes to multiple targets via EventBridge
 * 4. Enables fan-out pattern for independent consumers
 *
 * Demonstrates: Event-driven architecture, real-time streams, distributed systems
 */

const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');

const ebClient = new EventBridgeClient({ region: process.env.AWS_REGION });

/**
 * Main Lambda handler - receives IoT telemetry and routes via EventBridge
 *
 * @param {Object} event - IoT event from AWS IoT Core
 * @param {Object} context - Lambda context
 * @returns {Object} Routing result
 */
exports.handler = async (event, context) => {
    console.log('Received IoT telemetry event:', JSON.stringify(event));

    try {
        // Extract and validate telemetry payload. An IoT rule's Lambda action
        // passes the device's message itself as the event.
        const payload = event.detail || event.payload || event;
        const telemetry = parseTelemetry(payload);

        if (!telemetry) {
            return createResponse(400, { message: 'Invalid telemetry payload' });
        }

        // Enrich event with metadata
        const enrichedEvent = enrichEvent(telemetry, event);

        // Route to EventBridge (fan-out to multiple consumers)
        await routeToEventBus(enrichedEvent);

        return createResponse(200, {
            message: 'Event routed successfully',
            eventId: enrichedEvent.id,
            deviceId: enrichedEvent.deviceId
        });

    } catch (error) {
        console.error('Error routing event:', error);
        // Rethrown: invoked asynchronously, a returned 500 counts as success
        // and the event is lost. A thrown error is retried.
        throw error;
    }
};

/**
 * Parse raw IoT telemetry into structured format
 *
 * @param {Object} rawPayload - Raw telemetry from IoT device
 * @returns {Object} Structured telemetry
 */
function parseTelemetry(rawPayload) {
    try {
        const data = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
        const deviceId = data && (data.deviceId || data.device_id);
        if (!deviceId) return null;

        // Missing values stay null, as in patient-vitals. A heart rate
        // defaulted to 0 read as critical bradycardia downstream, and a
        // defaulted SpO2 of 98 hid a sensor that had stopped reporting.
        return {
            deviceId,
            heartRate: firstNumber(data.heartRate, data.hr),
            spo2: firstNumber(data.spo2, data.o2_saturation),
            temperature: firstNumber(data.temperature, data.temp),
            bpSystolic: firstNumber(data.bpSystolic, data.bp_sys),
            bpDiastolic: firstNumber(data.bpDiastolic, data.bp_dia),
            timestamp: data.timestamp || data.receivedAt || new Date().toISOString(),
            sourceSystem: typeof data.sourceSystem === 'string' && data.sourceSystem ? data.sourceSystem.slice(0, 40) : 'AWS_IoT'
        };
    } catch (error) {
        console.error('Failed to parse telemetry:', error);
        return null;
    }
}

/**
 * The first value that parses as a finite number, or null.
 */
function firstNumber(...values) {
    for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const n = typeof value === 'number' ? value : parseFloat(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Enrich event with metadata for EventBridge routing
 *
 * @param {Object} telemetry - Structured telemetry data
 * @param {Object} originalEvent - Original IoT event
 * @returns {Object} Enriched event
 */
function enrichEvent(telemetry, originalEvent) {
    return {
        id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        source: 'patient.iot.wearable',
        detailType: 'patient.vitals.update',
        detail: {
            ...telemetry,
            enrichedAt: new Date().toISOString(),
            version: '1.0'
        },
        eventSource: 'aws-iot-core',
        deviceId: telemetry.deviceId
    };
}

/**
 * Route enriched event to EventBridge
 * EventBridge fans out to multiple consumers:
 * - Alert Dispatcher (Branch 02): evaluates critical vitals
 * - Data Sink (Branch 01): stores in DynamoDB
 * - Analytics (future): real-time dashboards
 *
 * @param {Object} enrichedEvent - Enriched event to route
 * @returns {Promise} EventBridge PutEvents result
 */
async function routeToEventBus(enrichedEvent) {
    const params = {
        Source: enrichedEvent.source,
        DetailType: enrichedEvent.detailType,
        Detail: JSON.stringify(enrichedEvent.detail),
        // Set by lambda/streaming/cloudformation.yaml from the bus it creates.
        EventBusName: requiredEnv('EVENT_BUS_NAME')
    };

    // The SDK's field is Entries; under any other name the request carries
    // no events at all.
    const result = await ebClient.send(new PutEventsCommand({ Entries: [params] }));

    // PutEvents succeeds as a call even when entries are rejected, so a
    // failure only shows up here.
    if (result.FailedEntryCount) {
        const failed = result.Entries.find((entry) => entry.ErrorCode) || {};
        throw new Error(`EventBridge rejected the event: ${failed.ErrorCode} ${failed.ErrorMessage}`);
    }
    return result;
}

function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set. It comes from this function's CloudFormation template.`);
    return value;
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
