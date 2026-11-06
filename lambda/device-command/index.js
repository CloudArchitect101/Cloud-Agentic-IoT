'use strict';

const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');
const {
  BadRequest, parseBody, respond, batchResponse, mapLimit, isTransient, isThingName,
} = require('@cloud-agentic-iot/shared/api');
const { numberEnv } = require('@cloud-agentic-iot/shared/env');

const iot = new IoTDataPlaneClient({});

// A command's id: 1 to 40 letters, digits, _ or -, such as the 18-character
// Id of the Device Command record DeviceCommandSendJob sends. A board on
// firmware 2.2.0 or later answers a command that carries one on
// device/<thing>/ack, and device-command-ack records the answer on the command
// it names. The board (DeviceCommands.h) and device-command-ack hold the same
// limits, and test/firmware/contract.test.js checks that all three agree.
const COMMAND_ID = /^[A-Za-z0-9_-]{1,40}$/;
exports.COMMAND_ID = COMMAND_ID;

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
 * A command that should be answered carries a commandId, and goes to one
 * device only ({ thingName, operation, commandId }), since its answer is
 * recorded on the one command that id names. The commandId travels to the
 * board with the other fields.
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
  const { commandId } = fields;
  if (commandId !== undefined) {
    // A board carries out a command whose commandId it cannot use, and does
    // not answer it, so its record would wait for an answer forever. Refused
    // here instead, before it reaches the board.
    if (typeof commandId !== 'string' || !COMMAND_ID.test(commandId)) {
      return respond(400, { error: 'commandId must be 1 to 40 letters, digits, _ or -, such as a Device Command record\'s Id.' });
    }
    // Each board that took it would answer for the same command, and all
    // but one answer would be skipped as another device's.
    if (names.length !== 1) {
      return respond(400, {
        error: `A command with a commandId goes to one device: send thingName, or thingNames with one entry (this request names ${names.length}).`,
      });
    }
  }

  const payload = Buffer.from(JSON.stringify({ operation, ...fields }));
  // What the logs may say about the command: never the payload, since a
  // WIFI_UPDATE carries a passphrase. The commandId is the record's Id, and
  // lets a person find a command's publish in the logs.
  const about = commandId === undefined ? { operation } : { operation, commandId };
  const results = await mapLimit(names, numberEnv('IOT_PARALLEL_REQUESTS'), async (name) => {
    try {
      await iot.send(new PublishCommand({ topic: `device/${name}/command`, qos: 1, payload }));
      return { thingName: name, published: true };
    } catch (err) {
      console.error('publish failed', { thingName: name, ...about, error: err.message });
      return { thingName: name, published: false, retryable: isTransient(err), error: err.message };
    }
  });

  const published = results.filter((result) => result.published).length;
  console.log('command published', { ...about, devices: names.length, published });

  if (!Array.isArray(thingNames)) {
    // The one-device shape keeps its one-device answer.
    return published
      ? respond(200, { published: true, thingName: names[0], operation })
      : respond(502, { error: 'Failed to publish command' });
  }
  return batchResponse(results, (result) => result.published, { operation });
};
