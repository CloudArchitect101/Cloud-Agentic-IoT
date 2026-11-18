const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');

const iot = new IoTDataPlaneClient({});

// AWS IoT Thing names: letters, digits, colon, underscore and hyphen, up to
// 128 characters. Checking this keeps a malformed deviceId from addressing
// any topic other than one device's own command topic.
const THING_NAME = /^[a-zA-Z0-9:_-]{1,128}$/;

/**
 * Receives a queue-depth change from Salesforce (Apex Queueable -> API Gateway,
 * authenticated with SigV4 via a Named Credential) and republishes it to the
 * device's own command topic, device/<thing>/command - the only command topic
 * the CloudAgenticDevice library subscribes to.
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

  if (typeof deviceId !== 'string' || !THING_NAME.test(deviceId) || !Number.isFinite(intensity)) {
    return respond(400, { error: 'deviceId (an IoT Thing name) and numeric intensity are required' });
  }

  const message = {
    operation: 'QUEUE_DEPTH',
    deviceId,
    queueDeveloperName,
    openCaseCount: openCaseCount ?? 0,
    intensity: Math.max(0, Math.min(100, intensity)),
    motorState: motorState || (intensity > 0 ? 'ACTIVE' : 'IDLE'),
    sentAt: new Date().toISOString(),
  };

  try {
    await iot.send(new PublishCommand({
      topic: `device/${deviceId}/command`,
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
