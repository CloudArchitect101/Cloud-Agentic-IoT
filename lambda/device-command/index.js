'use strict';

const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');
const {
  BadRequest, parseBody, respond, batchResponse, mapLimit, isTransient, isThingName,
} = require('@cloud-agentic-iot/shared/api');
const { numberEnv } = require('@cloud-agentic-iot/shared/env');

const iot = new IoTDataPlaneClient({});

/**
 * Publishes one command to each device's own command topic.
 *
 *   { thingNames: [...], operation, ...fields }
 *     -> 200 or 207 { results: [{ thingName, published, retryable, error }] }
 *
 * Salesforce sends Commands_Per_Callout__c devices per request: a Wi-Fi change
 * on a network of 5,000 devices is 25 requests, not 5,000. The older
 * one-device shape ({ thingName, operation, ... }) still works.
 *
 * Per-device topic rather than a broadcast: the IoT policy scopes each device
 * to device/${iot:Connection.Thing.ThingName}/command, so a device cannot
 * subscribe to another device's commands, or to the credentials in them.
 */
exports.handler = async (event) => {
  let body;
  try {
    body = parseBody(event);
  } catch (err) {
    if (err instanceof BadRequest) return respond(400, { error: err.message });
    throw err;
  }
  const { thingNames, thingName, operation, ...fields } = body || {};
  const names = Array.isArray(thingNames) ? thingNames : (thingName ? [thingName] : []);

  if (!names.length || typeof operation !== 'string' || !operation) {
    return respond(400, { error: 'thingNames and operation are required' });
  }
  const invalid = names.filter((name) => !isThingName(name));
  if (invalid.length) {
    // Checked before anything is published: a name with / or + in it would
    // address a topic other than one device's own.
    return respond(400, { error: `Not AWS IoT Thing names: ${invalid.slice(0, 5).map(String).join(', ')}` });
  }

  const payload = Buffer.from(JSON.stringify({ operation, ...fields }));
  const results = await mapLimit(names, numberEnv('IOT_PARALLEL_REQUESTS'), async (name) => {
    try {
      await iot.send(new PublishCommand({ topic: `device/${name}/command`, qos: 1, payload }));
      return { thingName: name, published: true };
    } catch (err) {
      console.error('publish failed', { thingName: name, operation, error: err.message });
      return { thingName: name, published: false, retryable: isTransient(err), error: err.message };
    }
  });

  // Never log the payload: a WIFI_UPDATE carries a passphrase.
  const published = results.filter((result) => result.published).length;
  console.log('command published', { operation, devices: names.length, published });

  if (!Array.isArray(thingNames)) {
    // The one-device shape keeps its one-device answer.
    return published
      ? respond(200, { published: true, thingName: names[0], operation })
      : respond(502, { error: 'Failed to publish command' });
  }
  return batchResponse(results, (result) => result.published, { operation });
};
