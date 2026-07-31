const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');

const iot = new IoTDataPlaneClient({});

const COMMAND_TOPIC = process.env.COMMAND_TOPIC || 'device/queue/command';

/**
 * Receives a queue-depth change from Salesforce (Apex Queueable -> API Gateway,
 * authenticated with SigV4 via a Named Credential) and republishes it to the
 * device's MQTT command topic on AWS IoT Core.
 *
 * Deliberately thin: all business logic — which queue drives which device, how
 * depth scales to intensity — lives in Salesforce custom metadata. This is a
 * transport hop, and keeping it that way is what makes adding a second device
 * a metadata change rather than a redeploy.
 */
exports.handler = async (event) => {
  let payload;
  try {
    payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (err) {
    return respond(400, { error: 'Body is not valid JSON' });
  }

  const { deviceId, queueDeveloperName, openCaseCount, intensity, motorState } = payload || {};

  if (!deviceId || typeof intensity !== 'number') {
    return respond(400, { error: 'deviceId and numeric intensity are required' });
  }

  const message = {
    deviceId,
    queueDeveloperName,
    openCaseCount: openCaseCount ?? 0,
    intensity: Math.max(0, Math.min(100, intensity)),
    motorState: motorState || (intensity > 0 ? 'ACTIVE' : 'IDLE'),
    sentAt: new Date.toISOString,
  };

  try {
    await iot.send(new PublishCommand({
      topic: COMMAND_TOPIC,
      qos: 1,
      payload: Buffer.from(JSON.stringify(message)),
    }));
  } catch (err) {
    console.error('IoT publish failed', { deviceId, error: err.message });
    return respond(502, { error: 'Failed to publish to IoT Core' });
  }

  console.log('Queue depth relayed', message);
  return respond(200, { published: true, ...message });
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
