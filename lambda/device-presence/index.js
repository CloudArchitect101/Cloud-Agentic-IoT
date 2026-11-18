'use strict';

/*
 * device-presence/index.js
 *
 * Shows on each device's Asset whether its board is connected to AWS IoT now
 * (Connection_Status__c Online or Offline, Connection_Since__c and
 * Last_Disconnect_Reason__c), from the events AWS IoT publishes whenever a
 * client connects or disconnects.
 *
 *   $aws/events/presence/+/+ --IoT rule--> presence queue (SQS) --batches--> this function
 *       --DeviceConnectionService (invocable Apex), up to 200 Things a call--> Asset
 *
 * Salesforce hears one call per batch (one per 200 boards in it, when
 * PresenceBatchSize is larger than that), however often each board connected
 * or disconnected in it, and nothing at all while boards stay connected. The
 * board sends nothing for any of this: AWS IoT publishes the events itself.
 *
 * Lifecycle events can arrive out of order and more than once. Within a
 * batch, the latest event of each Thing wins: the greatest timestamp, then
 * the greater version number (each connection has its own, and its connect
 * and disconnect share it), then the disconnect over the connect, since a
 * connection's disconnect follows its connect. Across batches,
 * DeviceConnectionService applies a change only when it is no older than the
 * one the Asset shows, so a retry or a late event never turns a board back to
 * a state it has left.
 *
 * An event this function cannot use is dropped with a log line and never
 * retried: no retry would make it usable. A call Salesforce does not take
 * (down, out of API calls, refusing the integration user) sends the messages
 * behind it back to SQS, which retries them and, after the queue's
 * maxReceiveCount, moves them to the dead-letter queue, whose alarm brings
 * them to a person. An input Salesforce answers with isSuccess false is
 * logged with its errors and not retried: Salesforce took the call and
 * judged that input, and the board's next connect or disconnect sets the
 * Asset again. Logs carry Thing names, reasons and counts, never a whole
 * event.
 */

const { invokeAction } = require('@cloud-agentic-iot/shared/salesforce');
const { chunk, isThingName } = require('@cloud-agentic-iot/shared/api');
const { requiredEnv } = require('@cloud-agentic-iot/shared/env');

// Inputs per DeviceConnectionService call. The class takes a call's inputs
// together, with one query and one update, and 200 keeps each call that
// small whatever PresenceBatchSize is.
const INPUTS_PER_CALL = 200;

// What each event makes of a board on its Asset.
const STATUS = { connected: 'Online', disconnected: 'Offline' };

// Why an event is dropped: the end of its log line, and its key in the
// summary's counts.
const DROPPED = {
  malformed: 'not JSON, or no clientId, eventType or timestamp (epoch milliseconds)',
  otherEvent: 'neither a connect nor a disconnect',
  liveViewer: 'a browser watching live readings (client ID live-...), not a board',
  notThingName: 'its client ID is not an AWS IoT Thing name, so it is not a board',
  duplicateClientId: 'DUPLICATE_CLIENTID, the board has just connected again under the same name',
};

// arn:<partition>:iot:<region>:<account>:thing/, as the template builds it.
// Any other value would match no Asset, and every change would go nowhere
// without a word.
const THING_ARN_PREFIX = /^arn:[a-z-]+:iot:[a-z0-9-]+:\d{12}:thing\/$/;

exports.handler = async (event) => {
  // Read first, so a template defect fails the batch by name before any call.
  const action = requiredEnv('DEVICE_CONNECTION_ACTION');
  const thingArnPrefix = requiredEnv('THING_ARN_PREFIX');
  if (!THING_ARN_PREFIX.test(thingArnPrefix)) {
    throw new Error(`THING_ARN_PREFIX must be arn:<partition>:iot:<region>:<account>:thing/, not "${thingArnPrefix}". `
      + 'It comes from this function\'s CloudFormation template.');
  }
  const records = event && Array.isArray(event.Records) ? event.Records : [];

  const dropped = {};
  const byThing = new Map();      // client ID -> { presence, messageIds }
  for (const message of records) {
    const { presence, reason, thingName } = read(message.body);
    if (reason) {
      dropped[reason] = (dropped[reason] || 0) + 1;
      // A board that reconnected under its own name is routine. Anything
      // else means a client, or the rule, is not what this function expects.
      const level = reason === 'duplicateClientId' ? 'log' : 'warn';
      console[level](`Dropped a presence event: ${DROPPED[reason]}`, thingName
        ? { messageId: message.messageId, thingName }
        : { messageId: message.messageId });
      continue;
    }
    // Every message of a Thing feeds its one input, the superseded ones too,
    // so a call that fails sends all of them back and the retry sees them
    // all again.
    const entry = byThing.get(presence.clientId);
    if (!entry) {
      byThing.set(presence.clientId, { presence, messageIds: [message.messageId] });
      continue;
    }
    entry.messageIds.push(message.messageId);
    if (supersedes(presence, entry.presence)) entry.presence = presence;
  }

  const entries = [...byThing.values()];
  const returned = new Set();
  const tally = { sent: 0, assetsUpdated: 0, unchanged: 0, failed: 0 };
  // One call at a time: PresenceEventSourceMapping already bounds how many
  // invocations, and so requests, the org sees at once.
  for (const part of chunk(entries, INPUTS_PER_CALL)) {
    let results;
    try {
      results = await invokeAction(action, part.map((entry) => toInput(entry.presence, thingArnPrefix)));
    } catch (err) {
      // Down, out of API calls, or refusing the integration user. This
      // call's messages go back to SQS. The other calls stand on their own,
      // since no Thing is in two of them.
      console.error('Salesforce did not take a call; its messages go back to the queue', {
        error: err.message, status: err.status, things: part.length,
      });
      part.forEach((entry) => entry.messageIds.forEach((id) => returned.add(id)));
      continue;
    }
    tally.sent += part.length;
    part.forEach((entry, n) => count(entry.presence.clientId, Array.isArray(results) ? results[n] : undefined, tally));
  }

  console.log('Connection changes sent to Salesforce', {
    events: records.length, dropped, things: entries.length, ...tally, returned: returned.size,
  });
  return { batchItemFailures: [...returned].map((itemIdentifier) => ({ itemIdentifier })) };
};

/**
 * The connect or disconnect in a message, or why it is dropped. A timestamp
 * that is not a whole number of epoch milliseconds counts as none: it could
 * neither be compared nor stored.
 */
function read(body) {
  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return { reason: 'malformed' };
  }
  if (!event || typeof event !== 'object' || !present(event.clientId) || !present(event.eventType)
      || !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0) {
    return { reason: 'malformed' };
  }
  const { clientId, eventType } = event;
  if (!Object.hasOwn(STATUS, eventType)) return { reason: 'otherEvent' };
  // Before the name check, which a live viewer's client ID passes.
  if (typeof clientId === 'string' && clientId.startsWith('live-')) return { reason: 'liveViewer' };
  if (!isThingName(clientId)) return { reason: 'notThingName' };

  const disconnectReason = typeof event.disconnectReason === 'string' && event.disconnectReason
    ? event.disconnectReason
    : null;
  // AWS IoT closes a connection with DUPLICATE_CLIENTID when the same client
  // ID connects again, and that disconnect can carry a later timestamp than
  // the new connect. The board is online, not offline.
  if (eventType === 'disconnected' && disconnectReason === 'DUPLICATE_CLIENTID') {
    return { reason: 'duplicateClientId', thingName: clientId };
  }
  return {
    presence: {
      clientId,
      eventType,
      timestamp: event.timestamp,
      // Lifecycle events always carry one; an event without loses a tie.
      version: Number.isFinite(event.versionNumber) ? event.versionNumber : -Infinity,
      disconnectReason,
    },
  };
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

/** Whether event a, rather than b, is the Thing's state now. */
function supersedes(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp;
  if (a.version !== b.version) return a.version > b.version;
  // The same connection at the same millisecond: its disconnect follows its connect.
  return a.eventType === 'disconnected' && b.eventType === 'connected';
}

/** DeviceConnectionService's input for one Thing. */
function toInput(presence, thingArnPrefix) {
  const status = STATUS[presence.eventType];
  return {
    // A board connects with its Thing name as its client ID, and its Asset
    // holds the Thing ARN that AWS IoT built from that name.
    thingArn: thingArnPrefix + presence.clientId,
    status,
    changedAtMillis: presence.timestamp,
    // Null when Online: the Asset keeps the reason the board last went offline.
    disconnectReason: status === 'Online' ? null : presence.disconnectReason,
  };
}

/** Counts one Thing's result, and logs it when it failed or changed no Asset. */
function count(thingName, result, tally) {
  if (!result || !result.isSuccess) {
    tally.failed += 1;
    console.error('Salesforce did not record a connection change', { thingName, errors: errorsOf(result) });
    return;
  }
  const outcome = result.outputValues || {};
  if (Number.isInteger(outcome.assetsUpdated)) tally.assetsUpdated += outcome.assetsUpdated;
  if (outcome.skipped) {
    // DeviceConnectionService says why nothing changed: no Asset has this
    // Thing ARN, the event is older than the Asset's, or a bad status. Worth
    // a line: it is what to look for when an Asset does not show a board
    // that is online.
    tally.unchanged += 1;
    console.log('No Asset changed for a Thing', { thingName, reason: String(outcome.skipped) });
  }
}

/** Salesforce's error codes and messages for one input, whatever shape they came in. */
function errorsOf(result) {
  const errors = result && Array.isArray(result.errors) ? result.errors : [];
  return errors.map((error) => ({ statusCode: error && error.statusCode, message: error && error.message }));
}
