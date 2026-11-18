'use strict';

const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');
const {
  BadRequest, parseBody, respond, batchResponse, mapLimit, isTransient, isThingName,
} = require('@cloud-agentic-iot/shared/api');
const { numberEnv } = require('@cloud-agentic-iot/shared/env');

const iot = new IoTDataPlaneClient({});

/**
 * Receives queue-depth changes from Salesforce (Apex Queueable -> API Gateway,
 * signed with SigV4 by a Named Credential) and republishes each to its
 * device's own command topic, device/<thing>/command - the only command topic
 * the CloudAgenticDevice library subscribes to.
 *
 *   { commands: [{ deviceId, queueDeveloperName, openCaseCount, intensity, motorState }] }
 *     -> 200 or 207 { results: [{ deviceId, published, retryable, error }] }
 *
 * Salesforce sends Commands_Per_Callout__c commands per request; the older
 * one-command shape (the command itself as the body) still works.
 *
 * Deliberately thin: all business logic - which queue drives which device,
 * how depth scales to intensity - lives in Salesforce custom metadata. This
 * is a transport hop, and keeping it that way is what makes adding a device a
 * metadata change rather than a redeploy.
 */
exports.handler = async (event) => {
  let payload;
  try {
    payload = parseBody(event);
  } catch (err) {
    if (err instanceof BadRequest) return respond(400, { error: err.message });
    throw err;
  }
  const batch = payload && Array.isArray(payload.commands);
  const commands = batch ? payload.commands : [payload];
  if (!commands.length) {
    return respond(400, { error: 'commands is required' });
  }

  const results = await mapLimit(commands, numberEnv('IOT_PARALLEL_REQUESTS'), relay);

  if (!batch) {
    // The one-command shape keeps its one-command answers.
    const [result] = results;
    if (result.published) return respond(200, { published: true, ...result.message });
    return result.retryable === false && result.invalid
      ? respond(400, { error: result.error })
      : respond(502, { error: 'Failed to publish to IoT Core' });
  }
  return batchResponse(results.map(({ message, invalid, ...rest }) => rest), (result) => result.published);
};

async function relay(command) {
  const { deviceId, queueDeveloperName, openCaseCount, intensity, motorState } = command || {};
  if (!isThingName(deviceId) || !Number.isFinite(intensity)) {
    return {
      deviceId,
      published: false,
      retryable: false,
      invalid: true,
      error: 'deviceId (an IoT Thing name) and numeric intensity are required',
    };
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
    return { deviceId, published: false, retryable: isTransient(err), error: err.message };
  }
  console.log('Queue depth relayed', message);
  return { deviceId, published: true, message };
}
