'use strict';

/*
 * salesforce-sync/index.js
 *
 * Writes the readings patient-vitals decided Salesforce should see (state
 * changes, and re-alerts while a patient stays AT_RISK or CRITICAL) into
 * Patient_Vitals__c. Records pass through unchanged, including the
 * room-temperature flag.
 *
 *   sync queue (SQS) --batches--> this function --sObject Collections upsert--> Salesforce
 *
 * Salesforce is the most limited system in the path, so it has a queue and a
 * concurrency of its own (SyncMaxConcurrency on the event source mapping). An
 * outage or a burst of alerts backs up here while telemetry keeps flowing, and
 * the org is never asked for more parallel requests than it was sized for.
 * Each request carries up to 200 records: a million syncs a day is 5,000 API
 * calls, where one record per call was a million.
 *
 * The upsert is keyed on Device_Reading_Id__c, so a redelivered message
 * updates the record it already wrote instead of creating a second one. A
 * record Salesforce refuses goes back to SQS on its own (batchItemFailures)
 * and, after the queue's maxReceiveCount, to the dead-letter queue, whose
 * alarm brings it to a person. Logs carry reading ids and Salesforce's error
 * codes, never the vitals themselves.
 */

const { upsertCollection, COLLECTION_LIMIT } = require('@cloud-agentic-iot/shared/salesforce');

// The data model's contract, not settings: the object patient-vitals builds
// records for, and the external ID both it and Apex DataIngestionService key on.
const SOBJECT = 'Patient_Vitals__c';
const EXTERNAL_ID = 'Device_Reading_Id__c';

exports.handler = async (event) => {
  const failures = new Set();
  const byReading = new Map();      // Device_Reading_Id__c -> { record, messageIds }

  for (const message of (event && event.Records) || []) {
    const record = parse(message.body);
    if (!record || typeof record[EXTERNAL_ID] !== 'string' || !record[EXTERNAL_ID]) {
      // patient-vitals wrote it, so this is a defect: keep it for a person
      // to look at, by way of the retries and the dead-letter queue.
      console.error(`Not a sync message: no ${EXTERNAL_ID}`, { messageId: message.messageId });
      failures.add(message.messageId);
      continue;
    }
    // The same reading twice (SQS delivers at least once, and patient-vitals
    // may enqueue it again on a retry) is one record, and both messages share
    // its result. Salesforce refuses a request that names an external ID twice.
    const key = record[EXTERNAL_ID];
    const entry = byReading.get(key) || { record, messageIds: [] };
    entry.messageIds.push(message.messageId);
    byReading.set(key, entry);
  }

  const entries = [...byReading.values()];
  let written = 0;
  for (let i = 0; i < entries.length; i += COLLECTION_LIMIT) {
    const chunk = entries.slice(i, i + COLLECTION_LIMIT);
    let results;
    try {
      results = await upsertCollection(SOBJECT, EXTERNAL_ID, chunk.map((entry) => entry.record));
    } catch (err) {
      // Down, out of API calls, or refusing the integration user: the rest of
      // the batch would only meet the same answer. All of it goes back to SQS.
      console.error('Salesforce did not take the request; returning the rest of the batch to the queue', {
        error: err.message, status: err.status, records: entries.length - i,
      });
      entries.slice(i).forEach((entry) => entry.messageIds.forEach((id) => failures.add(id)));
      break;
    }
    chunk.forEach((entry, n) => {
      const result = results[n];
      if (result && result.success) {
        written += 1;
        return;
      }
      console.error('Salesforce refused a record', {
        readingId: entry.record[EXTERNAL_ID],
        errors: ((result && result.errors) || []).map(({ statusCode, message, fields }) => ({ statusCode, message, fields })),
      });
      entry.messageIds.forEach((id) => failures.add(id));
    });
  }

  console.log('Synced to Salesforce', { records: written, returned: failures.size });
  return { batchItemFailures: [...failures].map((itemIdentifier) => ({ itemIdentifier })) };
};

function parse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
