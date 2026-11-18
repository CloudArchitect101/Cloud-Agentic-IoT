#!/usr/bin/env node
'use strict';

/*
 * fleet-simulation.js - a fleet's readings through the real ingest and sync code.
 *
 *   npm run simulate                                   1,000,000 boards, Prod settings
 *   node test/load/fleet-simulation.js --devices 200000 --env Dev --changes-per-day 4
 *
 * Runs lambda/patient-vitals and lambda/salesforce-sync, unchanged, against
 * stand-ins for DynamoDB, SQS, S3, Parameter Store and Salesforce that count
 * every request and what it carried. Batch sizes, the re-alert interval and
 * whether readings are kept in DynamoDB come from config/<env>.json, the
 * same values the deploy gives the stacks; the reading interval from its
 * devices section.
 *
 * Three rounds, each one reading from every board:
 *   first contact  the table is empty: every board gets a STATE item and a
 *                  first record in Salesforce. Once in a fleet's life.
 *   steady         one interval later; boards change state at
 *                  `changesPerDay` per board per day.
 *   reminders      one re-alert interval after first contact: every board
 *                  still AT_RISK or CRITICAL is due a reminder.
 * A month is then (seconds in a month / interval) steady rounds plus
 * (seconds in a month / re-alert interval) rounds of reminders.
 *
 * Not modelled: network latency, throttling (the unit tests cover the retry
 * paths), and IoT Core itself (its quotas and prices are in docs/SCALING.md).
 * CPU is measured around each handler call, so it includes the stand-ins'
 * own bookkeeping: an upper bound for the handler alone.
 */

const path = require('node:path');
const { loadWithFakes } = require('../helpers/fakes');
const { loadConfig } = require('../../scripts/lib/stack-parameters');

const ROOT = path.join(__dirname, '../..');
const THRESHOLDS = require('../../config/vital-thresholds.json');
const THRESHOLDS_PARAMETER = '/cloud-agentic-iot/config/vital-thresholds';
const MONTH_SECONDS = 30 * 24 * 3600;
const T0 = Date.parse('2026-11-02T08:00:00.000Z');

// Readings that score as each state with the deployed bands, varied a little
// per board and round inside their band (an archive of identical readings
// would compress unrealistically well).
const VITALS = {
  STABLE: { heartRate: 72, spo2: 98, temperature: 36.8, bloodPressureSystolic: 118 },
  AT_RISK: { heartRate: 105, spo2: 93, temperature: 38.7, bloodPressureSystolic: 135 },   // 15 + 20 + 15 = 50
  CRITICAL: { heartRate: 130, spo2: 85, temperature: 39.5, bloodPressureSystolic: 165 },  // 30 + 35 + 25 + 20 = 110
};
function vitalsFor(condition, n, roundIndex) {
  const r = (((n + 1) * 2246822519 + roundIndex * 3266489917) >>> 0) / 2 ** 32;
  const base = VITALS[condition];
  return {
    heartRate: base.heartRate + Math.floor(r * 8) - 4,
    spo2: base.spo2 + (r > 0.5 ? 1 : 0),
    temperature: Math.round((base.temperature + (r - 0.5) * 0.2) * 10) / 10,
    bloodPressureSystolic: base.bloodPressureSystolic + Math.floor(r * 10) - 5,
    humidity: 35 + Math.floor(r * 20),
  };
}

/** Counting stand-ins for every AWS service the two functions call. */
function counters() {
  const count = {
    s3Puts: 0, s3Bytes: 0,
    batchGets: 0, stateKeysRead: 0,
    batchWrites: 0, readingItemsWritten: 0,
    stateUpdates: 0,
    sqsSendBatches: 0, syncsQueued: 0, syncBytes: 0,
    salesforceUpserts: 0, salesforceRecords: 0,
    ssmReads: 0,
  };
  const table = new Map();     // STATE items only: what the next round reads back
  const syncQueue = [];

  const commands = (names) => Object.fromEntries(names.map((name) => [name, { [name]: class { constructor(input) { this.input = input; } } }[name]]));

  const dynamodb = {
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (command) => {
          const { input } = command;
          switch (command.constructor.name) {
            case 'BatchGetCommand': {
              const [[name, { Keys }]] = Object.entries(input.RequestItems);
              count.batchGets++;
              count.stateKeysRead += Keys.length;
              const found = Keys.map((key) => table.get(key.PK)).filter(Boolean).map((item) => ({ ...item }));
              return { Responses: { [name]: found }, UnprocessedKeys: {} };
            }
            case 'BatchWriteCommand': {
              const [[, requests]] = Object.entries(input.RequestItems);
              count.batchWrites++;
              count.readingItemsWritten += requests.length;
              return { UnprocessedItems: {} };
            }
            case 'UpdateCommand': {
              count.stateUpdates++;
              const values = input.ExpressionAttributeValues || {};
              // As DynamoDB (and test/helpers/fakes.js) does: a placeholder
              // with no value, or an undefined one, is refused.
              const used = [input.UpdateExpression, input.ConditionExpression]
                .filter(Boolean).flatMap((expression) => expression.match(/:\w+/g) || []);
              const missing = used.find((p) => !Object.hasOwn(values, p) || values[p] === undefined);
              if (missing) {
                const err = new Error(`An expression attribute value used in expression is not defined; attribute value: ${missing}`);
                err.name = 'ValidationException';
                throw err;
              }
              const next = { ...input.Key };
              for (const assignment of input.UpdateExpression.replace(/^SET\s+/, '').split(',')) {
                const [attribute, placeholder] = assignment.split('=').map((part) => part.trim());
                next[attribute] = values[placeholder];
              }
              table.set(input.Key.PK, next);
              return {};
            }
            default:
              throw new Error(`not simulated: ${command.constructor.name}`);
          }
        },
      }),
    },
    ...commands(['BatchGetCommand', 'BatchWriteCommand', 'UpdateCommand']),
  };

  const sqs = {
    SQSClient: class {
      async send(command) {
        count.sqsSendBatches++;
        for (const entry of command.input.Entries) {
          count.syncsQueued++;
          count.syncBytes += Buffer.byteLength(entry.MessageBody);
          syncQueue.push(entry.MessageBody);
        }
        return { Successful: command.input.Entries.map((entry) => ({ Id: entry.Id })), Failed: [] };
      }
    },
    ...commands(['SendMessageBatchCommand']),
  };

  const s3 = {
    S3Client: class {
      async send(command) {
        count.s3Puts++;
        count.s3Bytes += command.input.Body.length;
        return {};
      }
    },
    ...commands(['PutObjectCommand']),
  };

  const ssm = {
    SSMClient: class {
      async send() {
        count.ssmReads++;
        return { Parameter: { Value: JSON.stringify(THRESHOLDS) } };
      }
    },
    ...commands(['GetParameterCommand']),
  };

  const salesforce = {
    COLLECTION_LIMIT: 200,
    upsertCollection: async (sobject, externalId, records) => {
      count.salesforceUpserts++;
      count.salesforceRecords += records.length;
      return records.map(() => ({ success: true, errors: [] }));
    },
  };

  return { count, table, syncQueue, fakes: { dynamodb, sqs, s3, ssm, salesforce } };
}

function cpuMicros(start) {
  const used = process.cpuUsage(start);
  return used.user + used.system;
}

/**
 * Runs the rounds; returns the counts of each and the CPU time per batch.
 * options: devices, env, atRisk and critical (shares of the fleet), and
 * changesPerDay (how often a board's state changes, per board per day).
 */
async function simulate({ devices = 1_000_000, env = 'Prod', atRisk = 0.02, critical = 0.01, changesPerDay = 2 } = {}) {
  const config = loadConfig(env);
  const stack = config.stacks['patient-vitals'];
  const intervalSeconds = config.devices['patient-monitor'].telemetrySeconds;
  const settings = {
    ingestBatch: Number(stack.IngestBatchSize),
    syncBatch: Number(stack.SyncBatchSize),
    realertMinutes: Number(stack.RealertIntervalMinutes),
    keepReadings: String(stack.KeepReadingsInDynamoDB) === 'true',
    intervalSeconds,
  };
  const churn = (changesPerDay * intervalSeconds) / 86_400;   // share of boards changing state per round

  const saved = { ...process.env };
  Object.assign(process.env, {
    DYNAMODB_TABLE: 'patient-vitals',
    SYNC_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/111122223333/cloud-agentic-iot-sync',
    ARCHIVE_BUCKET: 'patient-vitals-archive',
    THRESHOLDS_PARAMETER,
    REALERT_INTERVAL_MINUTES: String(settings.realertMinutes),
    KEEP_READINGS_IN_DYNAMODB: String(settings.keepReadings),
    READING_RETENTION_DAYS: String(stack.ReadingRetentionDays || 7),
    CONFIG_CACHE_SECONDS: '300',
    // The room-temperature demo rule stays off: every simulated body
    // temperature is above 30 C, so with it on every board would be "hot".
    ROOM_TEMP_ALERT: 'false',
  });

  const { count, syncQueue, fakes } = counters();
  const ingest = loadWithFakes(path.join(ROOT, 'lambda/patient-vitals/index.js'), {
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': fakes.dynamodb,
    '@aws-sdk/client-sqs': fakes.sqs,
    '@aws-sdk/client-s3': fakes.s3,
    '@aws-sdk/client-ssm': fakes.ssm,
  }).handler;
  const sync = loadWithFakes(path.join(ROOT, 'lambda/salesforce-sync/index.js'), {
    '@cloud-agentic-iot/shared/salesforce': fakes.salesforce,
  }).handler;

  // Each board's condition. A deterministic spread, so runs compare.
  const conditionOf = (n) => {
    const r = ((n * 2654435761) >>> 0) / 2 ** 32;
    if (r < critical) return 'CRITICAL';
    if (r < critical + atRisk) return 'AT_RISK';
    return 'STABLE';
  };
  const conditions = Array.from({ length: devices }, (_, n) => conditionOf(n));

  const batchCpu = [];
  const quiet = { log: console.log, warn: console.warn, error: console.error };

  let roundIndex = 0;
  async function round(name, at, changeShare) {
    roundIndex++;
    const before = { ...count };
    if (changeShare) {
      // A deterministic `changeShare` of the boards move to another state.
      const step = Math.max(1, Math.round(1 / changeShare));
      for (let n = 0; n < devices; n += step) {
        conditions[n] = conditions[n] === 'STABLE' ? 'AT_RISK' : 'STABLE';
      }
    }
    // Boards report at their own offsets inside the interval, as they do
    // once the firmware spreads them out.
    const spreadMs = settings.intervalSeconds * 1000;
    console.log = console.warn = () => {};
    try {
      for (let start = 0; start < devices; start += settings.ingestBatch) {
        const Records = [];
        for (let n = start; n < Math.min(devices, start + settings.ingestBatch); n++) {
          const thingName = `pm-${n}`;
          const receivedAt = at + ((n * 7919) % spreadMs);
          const timestamp = new Date(receivedAt).toISOString();
          Records.push({
            messageId: `${name}-${n}`,
            body: JSON.stringify({ deviceId: thingName, thingName, timestamp, receivedAt, ...vitalsFor(conditions[n], n, roundIndex) }),
          });
        }
        const cpu = process.cpuUsage();
        const result = await ingest({ Records });
        batchCpu.push(cpuMicros(cpu));
        if (result.batchItemFailures.length) throw new Error(`${name}: ${result.batchItemFailures.length} readings failed`);
      }
      // The sync queue drains into Salesforce in its own batches.
      while (syncQueue.length) {
        const bodies = syncQueue.splice(0, settings.syncBatch);
        const result = await sync({ Records: bodies.map((body, i) => ({ messageId: `s-${i}`, body })) });
        if (result.batchItemFailures.length) throw new Error(`${name}: ${result.batchItemFailures.length} syncs failed`);
      }
    } finally {
      Object.assign(console, quiet);
    }
    return Object.fromEntries(Object.keys(count).map((key) => [key, count[key] - before[key]]));
  }

  try {
    const firstContact = await round('first', T0, 0);
    const steady = await round('steady', T0 + intervalSeconds * 1000, churn);
    const reminders = await round('reminders', T0 + settings.realertMinutes * 60_000, 0);
    batchCpu.sort((a, b) => a - b);
    return {
      devices, env, settings, shares: { atRisk, critical, changesPerDay, churn },
      rounds: { firstContact, steady, reminders },
      cpu: {
        batches: batchCpu.length,
        meanMicros: batchCpu.reduce((sum, value) => sum + value, 0) / batchCpu.length,
        p95Micros: batchCpu[Math.floor(batchCpu.length * 0.95)],
      },
    };
  } finally {
    process.env = saved;
  }
}

/** Requests and units a month at this fleet's pace, from the steady and reminder rounds. */
function perMonth(result) {
  const { settings, rounds: { steady, reminders } } = result;
  const steadyRounds = MONTH_SECONDS / settings.intervalSeconds;
  const reminderRounds = MONTH_SECONDS / (settings.realertMinutes * 60);
  // A reminder round costs the same reads and archive writes as any round;
  // only its syncs, STATE writes and Salesforce calls are extra.
  const extra = (key) => reminders[key] * reminderRounds;
  return {
    readings: result.devices * steadyRounds,
    s3Puts: steady.s3Puts * steadyRounds,
    s3Bytes: steady.s3Bytes * steadyRounds,
    stateKeysRead: steady.stateKeysRead * steadyRounds,
    readingItemsWritten: steady.readingItemsWritten * steadyRounds,
    stateUpdates: steady.stateUpdates * steadyRounds + extra('stateUpdates'),
    syncs: steady.syncsQueued * steadyRounds + extra('syncsQueued'),
    sqsSendBatches: steady.sqsSendBatches * steadyRounds + extra('sqsSendBatches'),
    salesforceUpserts: steady.salesforceUpserts * steadyRounds + extra('salesforceUpserts'),
    salesforceRecords: steady.salesforceRecords * steadyRounds + extra('salesforceRecords'),
    ingestInvocations: Math.ceil(result.devices / settings.ingestBatch) * steadyRounds,
  };
}

function report(result) {
  const { settings, rounds, cpu } = result;
  const month = perMonth(result);
  const n = (value) => Math.round(value).toLocaleString('en-US');
  const rows = [
    ['S3 PutObject (archive)', 's3Puts'],
    ['DynamoDB BatchGetItem', 'batchGets'],
    ['DynamoDB STATE keys read', 'stateKeysRead'],
    ['DynamoDB BatchWriteItem', 'batchWrites'],
    ['DynamoDB STATE updates', 'stateUpdates'],
    ['SQS SendMessageBatch (sync queue)', 'sqsSendBatches'],
    ['Syncs queued for Salesforce', 'syncsQueued'],
    ['Salesforce upsert calls (200 per call)', 'salesforceUpserts'],
    ['Salesforce records written', 'salesforceRecords'],
    ['Parameter Store reads', 'ssmReads'],
  ];
  const lines = [
    `${n(result.devices)} boards, ${result.env} settings: a reading every ${settings.intervalSeconds} s, batches of ${settings.ingestBatch}, `
      + `re-alert every ${settings.realertMinutes} min, readings ${settings.keepReadings ? '' : 'not '}kept in DynamoDB; `
      + `${result.shares.atRisk * 100}% at risk, ${result.shares.critical * 100}% critical, each board changing state ${result.shares.changesPerDay} times a day.`,
    '',
    '| Requests | First contact | Steady round | Reminder round |',
    '|---|---:|---:|---:|',
    ...rows.map(([label, key]) => `| ${label} | ${n(rounds.firstContact[key])} | ${n(rounds.steady[key])} | ${n(rounds.reminders[key])} |`),
    '',
    `Archive: ${(rounds.steady.s3Bytes / result.devices).toFixed(1)} bytes a reading, gzipped. `
      + `Handler CPU: ${(cpu.meanMicros / 1000).toFixed(1)} ms per batch on average, ${(cpu.p95Micros / 1000).toFixed(1)} ms p95, over ${n(cpu.batches)} batches.`,
    '',
    `A month: ${n(month.readings)} readings; ${n(month.ingestInvocations)} ingest invocations; ${n(month.s3Puts)} archive objects `
      + `(${(month.s3Bytes / 1e9).toFixed(0)} GB); ${n(month.stateKeysRead)} STATE reads; ${n(month.stateUpdates)} STATE writes; `
      + `${n(month.readingItemsWritten)} reading rows; ${n(month.syncs)} Salesforce records in ${n(month.salesforceUpserts)} API calls.`,
  ];
  return lines.join('\n');
}

module.exports = { simulate, perMonth, report };

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const started = Date.now();
  simulate({
    devices: Number(option('devices', 1_000_000)),
    env: option('env', 'Prod'),
    atRisk: Number(option('at-risk', 0.02)),
    critical: Number(option('critical', 0.01)),
    changesPerDay: Number(option('changes-per-day', 2)),
  }).then((result) => {
    console.log(report(result));
    console.log(`\n(${((Date.now() - started) / 1000).toFixed(0)} s to simulate)`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
