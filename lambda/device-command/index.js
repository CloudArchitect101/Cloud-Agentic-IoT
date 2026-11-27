'use strict';

const { IoTDataPlaneClient, PublishCommand } = require('@aws-sdk/client-iot-data-plane');
const {
  BadRequest, parseBody, respond, batchResponse, mapLimit, isTransient, isThingName,
} = require('@cloud-agentic-iot/shared/api');
const { numberEnv } = require('@cloud-agentic-iot/shared/env');
const { checkCommand } = require('@cloud-agentic-iot/shared/guardrails');

const iot = new IoTDataPlaneClient({});

// A command's id: 1 to 40 letters, digits, _ or -, such as the 18-character
// Id of the Device Command record DeviceCommandSendJob sends. A board
// answers a command that carries one on
// device/<thing>/ack, and device-command-ack records the answer on the command
// it names. The board (DeviceCommands.h) and device-command-ack hold the same
// limits, and test/firmware/contract.test.js checks that all three agree.
const COMMAND_ID = /^[A-Za-z0-9_-]{1,40}$/;
exports.COMMAND_ID = COMMAND_ID;

// { operation: 'CASE_ALERT', active: true | false }. Salesforce does not send
// it: a monitored board's motor follows its own sensor, and the board answers
// it as done and ignores it. firmware/patient-monitor holds the same names, and
// test/firmware/contract.test.js checks that they agree.
const CASE_ALERT = 'CASE_ALERT';
exports.CASE_ALERT = CASE_ALERT;

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
 * A CASE_ALERT must carry active, true or false: the one setting the board
 * needs to turn its motor on or off.
 *
 * Then the guardrails (lambda/shared/guardrails.js) decide whether the
 * command may go at all: an operation a board takes, only the settings that
 * operation has, each inside the range the board accepts, and no more rooms
 * than the operation allows. Every caller passes here - Salesforce through
 * API Gateway, the MCP server by invoking this function - so no path to a
 * board skips them. A refusal is a 400 that names what was wrong and never
 * repeats a value.
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

  if (operation === CASE_ALERT && typeof fields.active !== 'boolean') {
    // A board takes a missing or misspelt active as neither on nor off and
    // refuses the command, so the motor would stay as it was.
    return respond(400, { error: 'CASE_ALERT needs active, true to turn the motor on or false to turn it off.' });
  }

  // What the logs may say about the command: never the payload, since a
  // WIFI_UPDATE carries a passphrase. The commandId is the record's Id, and
  // lets a person find a command's publish in the logs.
  const about = commandId === undefined ? { operation } : { operation, commandId };

  const guardrail = checkCommand({ operation, fields, deviceCount: names.length });
  if (!guardrail.allowed) {
    // The failure codes name fields, never their values.
    console.warn('command refused by guardrails', { ...about, devices: names.length, failures: guardrail.failures });
    return respond(400, { error: guardrail.message, failures: guardrail.failures });
  }

  const payload = Buffer.from(JSON.stringify({ operation, ...fields }));
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
