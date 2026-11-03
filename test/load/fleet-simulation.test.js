'use strict';

// The fleet simulation at a size that runs in a second, checking the
// properties that let the pipeline grow to a million boards: requests grow in
// step with the fleet, in batches; a board whose state did not change costs
// one STATE read and nothing else; Salesforce sees state changes and
// reminders, never routine readings. npm run simulate runs the full million.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulate } = require('./fleet-simulation');

test('requests grow in step with the fleet, in full batches', async () => {
  const small = await simulate({ devices: 4000 });
  const large = await simulate({ devices: 8000 });
  for (const key of ['s3Puts', 'batchGets', 'stateKeysRead']) {
    assert.equal(large.rounds.steady[key], 2 * small.rounds.steady[key], key);
  }
  const { steady } = large.rounds;
  assert.equal(steady.s3Puts, 8000 / large.settings.ingestBatch, 'one archive object per batch');
  assert.equal(steady.batchGets, 8000 / 100, 'one STATE read request per 100 boards');
});

test('a board whose state did not change costs one STATE read and nothing else', async () => {
  const result = await simulate({ devices: 10000, changesPerDay: 0 });
  const { steady } = result.rounds;
  assert.equal(steady.stateKeysRead, 10000);
  assert.equal(steady.stateUpdates, 0);
  assert.equal(steady.syncsQueued, 0);
  assert.equal(steady.salesforceUpserts, 0);
  assert.equal(steady.readingItemsWritten, 0, 'Prod keeps readings in the S3 archive only');
});

test('Salesforce gets changes and reminders, 200 records a call', async () => {
  const result = await simulate({ devices: 10000, atRisk: 0.02, critical: 0.01 });
  const { firstContact, reminders } = result.rounds;
  assert.equal(firstContact.salesforceRecords, 10000, 'every board reports once on first contact');
  assert.equal(firstContact.salesforceUpserts, 10000 / 200);
  // Every board not STABLE is reminded once per re-alert interval: 3% of them.
  assert.ok(reminders.salesforceRecords >= 280 && reminders.salesforceRecords <= 320, `${reminders.salesforceRecords} reminders`);
  assert.equal(reminders.salesforceUpserts, Math.ceil(reminders.salesforceRecords / 200));
});

test('Dev keeps readings in DynamoDB too, 25 to a request', async () => {
  const result = await simulate({ devices: 2000, env: 'Dev' });
  assert.equal(result.rounds.steady.readingItemsWritten, 2000);
  assert.equal(result.rounds.steady.batchWrites, 2000 / 25);
});
