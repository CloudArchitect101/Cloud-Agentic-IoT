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
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'patient-vitals-event-bus';

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
        // Extract and validate telemetry payload
        const payload = event.detail || event.payload;
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
        return createResponse(500, {
            message: 'Failed to route event',
            error: error.message
        });
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
        return {
            deviceId: data.deviceId || data.device_id,
            heartRate: parseFloat(data.heartRate || data.hr || 0),
            spo2: parseFloat(data.spo2 || data.o2_saturation || 98),
            temperature: parseFloat(data.temperature || data.temp || 36.8),
            bpSystolic: parseFloat(data.bpSystolic || data.bp_sys || 120),
            bpDiastolic: parseFloat(data.bpDiastolic || data.bp_dia || 80),
            timestamp: data.timestamp || new Date().toISOString(),
            sourceSystem: 'AWS_IoT'
        };
    } catch (error) {
        console.error('Failed to parse telemetry:', error);
        return null;
    }
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
        EventBusName: EVENT_BUS_NAME
    };

    await ebClient.send(new PutEventsCommand({ events: [params] }));
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
