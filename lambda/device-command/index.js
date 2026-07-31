const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');

const iot = new IoTDataPlaneClient({});

/**
 * Publishes a command to one device's own command topic.
 *
 * Per-device topic rather than a broadcast: the IoT policy scopes each device
 * to device/${iot:Connection.Thing.ThingName}/command, so a device physically
 * cannot subscribe to another device's credentials.
 */
exports.handler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event;
  const { thingName, operation, ...rest } = body;

  if (!thingName || !operation) {
    return respond(400, { error: 'thingName and operation are required' });
  }

  try {
    await iot.send(new PublishCommand({
      topic: `device/${thingName}/command`,
      qos: 1,
      payload: Buffer.from(JSON.stringify({ operation, ...rest })),
    }));
  } catch (err) {
    console.error('publish failed', { thingName, operation, error: err.message });
    return respond(502, { error: 'Failed to publish command' });
  }

  // Never log the payload: a WIFI_UPDATE carries a passphrase.
  console.log('command published', { thingName, operation });
  return respond(200, { published: true, thingName, operation });
};

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
