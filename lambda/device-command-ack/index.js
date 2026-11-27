'use strict';

/*
 * device-command-ack/index.js
 *
 * Records on each Device Command (Device_Command__c) what its board said
 * about it: Acked when the board carried it out, Failed, with why, when the
 * board could not or does not take that command.
 *
 *   device/<thing>/ack --IoT rule--> answer queue (SQS) --batches--> this function
 *       --DeviceCommandAckService (invocable Apex), up to 200 answers a call--> Device_Command__c
 *
 * A board answers a command that carried a
 * commandId (DeviceCommandSendJob sends the record's Id as one), once per
 * command. Answers are few, so the queue hands them over at once, at most 10
 * at a time: Salesforce hears one REST API call per batch of at most 10
 * answers, and nothing while no command is sent.
 *
 * The same answer can reach the queue twice: the rule's SQS action may
 * deliver it twice, and a board that is sent one command twice answers the
 * second time with the outcome it remembers and the detail "already carried
 * out". Within a batch, the earliest answer of each board for each command is
 * the one sent, the one with the board's own detail; across batches,
 * DeviceCommandAckService records the first answer a command gets and skips
 * the rest, so a retry or a repeated answer never changes a command twice.
 *
 * An answer this function cannot use is dropped with a log line and never
 * retried: no retry would make it usable. A call Salesforce does not take
 * (down, out of API calls, refusing the integration user) sends the messages
 * behind it back to SQS, which retries them and, after the queue's
 * maxReceiveCount, moves them to the dead-letter queue, whose alarm brings
 * them to a person. An input Salesforce answers with isSuccess false is
 * logged with its errors and not retried: Salesforce took the call and judged
 * that input. Logs carry command ids, Thing names, operations, reasons and
 * counts, never a whole answer: its detail is the board's own text.
 */

const { invokeAction } = require('@cloud-agentic-iot/shared/salesforce');
const { chunk, isThingName } = require('@cloud-agentic-iot/shared/api');
const { requiredEnv } = require('@cloud-agentic-iot/shared/env');

// A command's id: 1 to 40 letters, digits, _ or -. The device-command API
// sends no other, and the board (DeviceCommands.h) answers no other;
// test/firmware/contract.test.js checks that all three agree.
const COMMAND_ID = /^[A-Za-z0-9_-]{1,40}$/;
exports.COMMAND_ID = COMMAND_ID;

// Inputs per DeviceCommandAckService call. The class takes a call's inputs
// together, with one query and one update, and 200 keeps each call that small
// whatever the batch size.
const INPUTS_PER_CALL = 200;

// What a board says it did: done (carried out), failed (it knows the
// operation but could not carry it out) or refused (it does not know it).
const OUTCOMES = new Set(['done', 'failed', 'refused']);

// Status_Detail__c holds 255 characters. The board sends at most 120.
const DETAIL_LENGTH = 255;

// An operation is only ever logged, and a client that sends a long one
// should not fill the log line.
const OPERATION_LENGTH = 64;

// Why an answer is dropped: the end of its log line, and its key in the
// summary's counts.
const DROPPED = {
  malformed: 'not JSON, or not a JSON object',
  commandId: 'its commandId is not 1 to 40 letters, digits, _ or -',
  thingName: 'its thingName, the second level of its topic, is not an AWS IoT Thing name, so no board sent it',
  outcome: 'its outcome is not done, failed or refused',
  answeredAt: 'its answeredAtMillis is not a whole number of epoch milliseconds, as the rule\'s timestamp() is',
};

exports.handler = async (event) => {
  // Read first, so a template defect fails the batch by name before any call.
  const action = requiredEnv('DEVICE_COMMAND_ACK_ACTION');
  const records = event && Array.isArray(event.Records) ? event.Records : [];

  const dropped = {};
  const byKey = new Map();        // "<commandId> <thingName>" -> { answer, messageIds }
  for (const message of records) {
    const { answer, reason, known } = read(message.body);
    if (reason) {
      dropped[reason] = (dropped[reason] || 0) + 1;
      // None is routine: each means a client publishing on an ack topic, or
      // the rule, is not what this function expects.
      console.warn(`Dropped a command answer: ${DROPPED[reason]}`, { messageId: message.messageId, ...known });
      continue;
    }
    // One input per command and board, the earliest answer: a repeat carries
    // the same outcome, and "already carried out" as its detail. Keyed by
    // board as well as command, so an answer from the wrong board never
    // stands in for the right one: DeviceCommandAckService skips the one
    // whose board is not the command's device. Every message of a key feeds
    // its one input, the later ones too, so a call that fails sends all of
    // them back and the retry sees them all again.
    const key = `${answer.commandId} ${answer.thingName}`;
    const entry = byKey.get(key);
    if (!entry) {
      byKey.set(key, { answer, messageIds: [message.messageId] });
      continue;
    }
    entry.messageIds.push(message.messageId);
    if (answer.answeredAtMillis < entry.answer.answeredAtMillis) entry.answer = answer;
  }

  const entries = [...byKey.values()];
  const returned = new Set();
  const tally = {
    sent: 0, applied: 0, skipped: 0, skippedReasons: {}, failed: 0,
  };
  // One call at a time: CommandAckEventSourceMapping already bounds how many
  // invocations, and so requests, the org sees at once.
  for (const part of chunk(entries, INPUTS_PER_CALL)) {
    let results;
    try {
      results = await invokeAction(action, part.map((entry) => toInput(entry.answer)));
    } catch (err) {
      // Down, out of API calls, or refusing the integration user. This
      // call's messages go back to SQS. The other calls stand on their own,
      // since no answer is in two of them.
      console.error('Salesforce did not take a call; its messages go back to the queue', {
        error: err.message, status: err.status, commands: part.length,
      });
      part.forEach((entry) => entry.messageIds.forEach((id) => returned.add(id)));
      continue;
    }
    tally.sent += part.length;
    part.forEach((entry, n) => count(entry.answer, Array.isArray(results) ? results[n] : undefined, tally));
  }

  console.log('Command answers sent to Salesforce', {
    answers: records.length, dropped, commands: entries.length, ...tally, returned: returned.size,
  });
  return { batchItemFailures: [...returned].map((itemIdentifier) => ({ itemIdentifier })) };
};

/**
 * The answer in a message, or why it is dropped, with what of it may be
 * logged either way. The rule adds thingName (from the topic) and
 * answeredAtMillis (AWS IoT's clock) to whatever the board sent.
 */
function read(body) {
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    return { reason: 'malformed', known: {} };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { reason: 'malformed', known: {} };

  const { commandId, thingName, outcome, detail, answeredAtMillis } = message;
  const known = {};
  if (isCommandId(commandId)) known.commandId = commandId;
  if (isThingName(thingName)) known.thingName = thingName;
  if (typeof message.operation === 'string') known.operation = cut(message.operation, OPERATION_LENGTH);

  if (!known.commandId) return { reason: 'commandId', known };
  if (!known.thingName) return { reason: 'thingName', known };
  if (!OUTCOMES.has(outcome)) return { reason: 'outcome', known };
  if (!Number.isSafeInteger(answeredAtMillis) || answeredAtMillis <= 0) return { reason: 'answeredAt', known };
  return {
    answer: {
      commandId,
      thingName,
      outcome,
      // Anything but text is no detail at all.
      detail: typeof detail === 'string' ? cut(detail, DETAIL_LENGTH) : null,
      answeredAtMillis,
      operation: known.operation,
    },
  };
}

function isCommandId(value) {
  return typeof value === 'string' && COMMAND_ID.test(value);
}

/** text, cut to at most max UTF-16 units without cutting a character in two. */
function cut(text, max) {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
}

/** DeviceCommandAckService's input for one answer. The operation stays out: the command has its own. */
function toInput(answer) {
  return {
    commandId: answer.commandId,
    thingName: answer.thingName,
    outcome: answer.outcome,
    detail: answer.detail,
    answeredAtMillis: answer.answeredAtMillis,
  };
}

/** Counts one answer's result, and logs it when it failed or changed no command. */
function count(answer, result, tally) {
  const { commandId, thingName, operation } = answer;
  if (!result || !result.isSuccess) {
    tally.failed += 1;
    console.error('Salesforce did not record a command answer', {
      commandId, thingName, operation, errors: errorsOf(result),
    });
    return;
  }
  const recorded = result.outputValues || {};
  if (recorded.applied === true) {
    tally.applied += 1;
    return;
  }
  // DeviceCommandAckService says why nothing changed: no command has this
  // Id, it is another device's, or it was answered already. Worth a line: it
  // is what to look for when a command stays Sent.
  const reason = recorded.skipped ? String(recorded.skipped) : 'DeviceCommandAckService gave no reason';
  tally.skipped += 1;
  tally.skippedReasons[reason] = (tally.skippedReasons[reason] || 0) + 1;
  console.log('An answer changed no Device Command', {
    commandId, thingName, operation, reason,
  });
}

/** Salesforce's error codes and messages for one input, whatever shape they came in. */
function errorsOf(result) {
  const errors = result && Array.isArray(result.errors) ? result.errors : [];
  return errors.map((error) => ({ statusCode: error && error.statusCode, message: error && error.message }));
}
