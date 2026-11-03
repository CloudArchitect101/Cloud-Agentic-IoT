'use strict';

/*
 * What the functions behind the device API share: reading a request,
 * answering it, and working through a batch of devices.
 *
 * Salesforce sends devices in batches (Devices_Per_Callout__c and
 * Commands_Per_Callout__c in Device_Platform_Setting__mdt). A batch gets one
 * answer: 200 when every device succeeded, 207 when some did not, with a
 * result per device that says whether trying again later can help. That is
 * what lets Salesforce retry one throttled device without failing the other
 * nine, or provisioning them all a second time.
 */

class BadRequest extends Error {}

/**
 * The request body: a JSON string from API Gateway, an object when invoked
 * through a test event, or the event itself when invoked directly.
 */
function parseBody(event) {
  if (!event) throw new BadRequest('The request is empty.');
  if (typeof event.body === 'string') {
    try {
      return JSON.parse(event.body);
    } catch {
      throw new BadRequest('Body is not valid JSON');
    }
  }
  if (event.body && typeof event.body === 'object') return event.body;
  return event;
}

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** 200 when every result passes `succeeded`, 207 when any does not. */
function batchResponse(results, succeeded, extra = {}) {
  return respond(results.every(succeeded) ? 200 : 207, { results, ...extra });
}

/** Runs fn over items, at most `limit` at a time, and returns the results in input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// Errors that say "not now" rather than "not this": AWS throttled the call,
// it timed out, or the fault was on AWS's side.
const TRANSIENT = new Set([
  'ThrottlingException', 'TooManyRequestsException', 'ServiceUnavailableException',
  'InternalFailureException', 'InternalServerException', 'InternalException',
  'RequestTimeout', 'RequestTimeoutException', 'TimeoutError',
]);

/** Whether trying again later can help. */
function isTransient(err) {
  if (!err) return false;
  if (err.$retryable || TRANSIENT.has(err.name)) return true;
  const status = err.$metadata && err.$metadata.httpStatusCode;
  return Number.isInteger(status) && (status === 429 || status >= 500);
}

// AWS IoT Thing names: letters, digits, colon, underscore and hyphen, up to
// 128 characters. Checked before a name goes into a topic, so a malformed one
// can never address any topic but one device's own.
const THING_NAME = /^[a-zA-Z0-9:_-]{1,128}$/;

function isThingName(value) {
  return typeof value === 'string' && THING_NAME.test(value);
}

/**
 * A deadline for one request: stop starting work once too little time is
 * left to finish it and still answer. A device not reached is reported as
 * retryable, and Salesforce sends it again in its next job.
 */
function deadline(context, reserveMillis) {
  const remaining = () => (context && typeof context.getRemainingTimeInMillis === 'function'
    ? context.getRemainingTimeInMillis()
    : Infinity);
  return { passed: () => remaining() < reserveMillis };
}

module.exports = {
  BadRequest, parseBody, respond, batchResponse, mapLimit, chunk, isTransient, isThingName, deadline,
};
