'use strict';

/*
 * patient-vitals/index.js
 *
 * Scores every reading from the patient monitors, keeps it, and hands the
 * readings Salesforce should act on to the sync queue.
 *
 *   device/+/telemetry --IoT rule--> telemetry queue (SQS) --batches--> this function
 *       -> S3 archive        every reading, one object per batch
 *       -> S3 Data Cloud copy the same readings as flat CSV rows, one file
 *                            per batch, when DATA_CLOUD_EXPORT_PREFIX is set
 *                            (docs/DATA-CLOUD.md)
 *       -> DynamoDB          one STATE item per device (and every reading, if
 *                            KEEP_READINGS_IN_DYNAMODB is true)
 *       -> sync queue (SQS)  state changes, due re-alerts and (demo rule)
 *                            flagged high temperature reports only
 *                            --> salesforce-sync --> Patient_Vitals__c
 *
 * Why it is shaped like this, at a million devices sending every 30 seconds
 * (about 33,000 readings a second):
 *
 *   - The IoT rule used to invoke this function once per reading. Now it drops
 *     readings on a queue and the function takes them in batches of
 *     INGEST_BATCH_SIZE (the event source mapping), so 33,000 readings a
 *     second is a few dozen invocations, not 33,000.
 *   - DynamoDB is read and written in batches (100 keys, 25 items per call),
 *     and a device's STATE item is written only when something changed.
 *   - Salesforce never sees raw telemetry: 2,880 readings per device per day
 *     would exhaust any org's storage and API limits. It gets transitions,
 *     and a reminder every REALERT_INTERVAL_MINUTES while a patient stays
 *     AT_RISK or CRITICAL. With the temperature alert demo rule on
 *     (ROOM_TEMP_ALERT), it also gets a reading flagged
 *     Room_Temperature_Alert__c when a device first reaches
 *     ROOM_TEMP_ALERT_CELSIUS; Salesforce decides whether that opens a Case.
 *     While the device stays hot it is reported again only every
 *     ROOM_TEMP_REALERT_MINUTES (hours, not minutes: a safety net for a Case
 *     that failed to open), because the open Case already says it. When that
 *     Case is closed, Salesforce re-arms the device through device-live
 *     (RearmRequestedAt on STATE), so a device still hot gets a new Case at
 *     its next reading. A device worn all day is about 2 records a day, not
 *     96 (docs/SCALING.md, "Salesforce API calls per device"). The
 *     write itself happens in salesforce-sync, at a concurrency Salesforce
 *     can take, so a Salesforce outage backs up the sync queue instead of
 *     telemetry.
 *   - Every number here (batch sizes, retention, re-alert interval, the
 *     clinical thresholds) comes from config/<env>.json through the template,
 *     or from SSM, not from this file.
 *
 * A failure is reported per message (batchItemFailures), so SQS retries just
 * the readings that need it. Everything is idempotent on retry: a reading's
 * key is its device and timestamp, and a sync is an upsert on that same key.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, BatchGetCommand, BatchWriteCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { gzipSync } = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { loadThresholds, assess } = require('@cloud-agentic-iot/shared/vitals');
const { requiredEnv, numberEnv, booleanEnv } = require('@cloud-agentic-iot/shared/config');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sqs = new SQSClient({});
const s3 = new S3Client({});

// Service limits, not settings: BatchGetItem takes 100 keys, BatchWriteItem
// 25 items, SendMessageBatch 10 messages.
const BATCH_GET_LIMIT = 100;
const BATCH_WRITE_LIMIT = 25;
const SQS_BATCH_LIMIT = 10;
// Items DynamoDB leaves unprocessed (throttling) are retried this many times
// with backoff. Whatever is still left goes back to SQS as a failed message,
// and SQS retries it on its own schedule (maxReceiveCount, in the template).
const UNPROCESSED_RETRIES = 4;
const PARALLEL_REQUESTS = 8;
// Temperature alert episodes end only 1 C below the threshold. Readings are
// floats and a warming or cooling sensor wanders around the line; without
// the margin each wobble would count as a new crossing and a new report.
const ROOM_TEMP_REARM_MARGIN_C = 1;
// The Data Cloud copy's columns, in file order. Data Cloud's Amazon S3
// connector reads CSV or Parquet, not NDJSON, so the archive alone cannot
// feed a data stream. datacloud/room-readings.columns.json lists the same
// columns with their Data Cloud types, and a test keeps the two in step.
const ROOM_READING_COLUMNS = [
  'reading_id', 'device_id', 'serial_number', 'reading_ts', 'received_ts',
  'temperature_c', 'humidity_pct', 'room', 'source_system',
];
// A room or location label a board may send. Kept short and on one line: a
// line break inside a value is a shape Data Cloud's CSV reader refuses.
const ROOM_LABEL_MAX = 64;

exports.handler = async (event) => {
  if (Array.isArray(event && event.Records)) {
    return handleQueueBatch(event.Records);
  }
  return handleSingleReading(event);
};

/**
 * This invocation's settings, all from the environment the template sets.
 * Read before anything is written, so a missing one fails cleanly, by name.
 */
function settings() {
  const keepReadings = booleanEnv('KEEP_READINGS_IN_DYNAMODB');
  const roomTempAlert = booleanEnv('ROOM_TEMP_ALERT');
  return {
    table: requiredEnv('DYNAMODB_TABLE'),
    queueUrl: requiredEnv('SYNC_QUEUE_URL'),
    archiveBucket: requiredEnv('ARCHIVE_BUCKET'),
    realertMs: numberEnv('REALERT_INTERVAL_MINUTES') * 60_000,
    keepReadings,
    retentionSeconds: keepReadings ? numberEnv('READING_RETENTION_DAYS') * 86_400 : null,
    roomTempAlert,
    roomTempCelsius: roomTempAlert ? numberEnv('ROOM_TEMP_ALERT_CELSIUS') : null,
    // 0: a hot device is reported once per episode, and again only after a re-arm.
    roomTempRealertMs: roomTempAlert ? minutesOrZero('ROOM_TEMP_REALERT_MINUTES') * 60_000 : null,
    // Empty or unset: no Data Cloud copy, and the archive is all there is.
    dataCloudPrefix: process.env.DATA_CLOUD_EXPORT_PREFIX || '',
  };
}

/** Zero or a positive number of minutes; 0 is a setting here, not a mistake. */
function minutesOrZero(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be 0 or a positive number of minutes, not "${process.env[name]}".`);
  }
  return value;
}

/** The telemetry queue's batch: one result for the whole batch, failures by message. */
async function handleQueueBatch(records) {
  const config = settings();
  const thresholds = await loadThresholds();
  const readings = [];
  for (const record of records) {
    const vitals = parseVitals(record.body);
    if (!vitals) {
      // No device id: retrying cannot fix it, so it is dropped, loudly.
      console.warn('Dropping a message without a device id', { messageId: record.messageId });
      continue;
    }
    readings.push({ id: record.messageId, vitals: score(vitals, thresholds) });
  }
  const failed = await ingest(readings, config);
  if (failed.size) {
    console.error('Readings to retry', { count: failed.size, of: records.length });
  }
  return { batchItemFailures: [...failed].map((itemIdentifier) => ({ itemIdentifier })) };
}

/**
 * One reading, invoked directly: the shape the IoT rule's Lambda action used
 * to send (the message itself), an EventBridge event (detail), or a wrapped
 * payload. Kept so a reading can still be pushed through by hand.
 */
async function handleSingleReading(event) {
  const config = settings();
  const vitals = parseVitals(event && (event.detail || event.payload || event));
  if (!vitals) {
    return createResponse(400, { message: 'Invalid vitals payload' });
  }
  // The id names the archive object, so it must not repeat.
  const reading = { id: `direct-${randomUUID()}`, vitals: score(vitals, await loadThresholds()) };
  const failed = await ingest([reading], config);
  if (failed.size) {
    // Thrown, not returned as a 500: an asynchronous invocation counts any
    // return value as success, and the reading would be dropped.
    throw new Error(`Reading from ${vitals.deviceId} was not stored; see the errors above.`);
  }
  return createResponse(200, {
    message: 'Patient vitals processed successfully',
    deviceId: vitals.deviceId,
    riskScore: reading.vitals.riskScore,
    patientState: reading.vitals.patientState,
  });
}

function score(vitals, thresholds) {
  const { riskScore, patientState } = assess({
    heartRate: vitals.heartRate,
    spo2: vitals.spo2,
    temperature: vitals.temperature,
    bpSystolic: vitals.bloodPressureSystolic,
  }, thresholds);
  return { ...vitals, riskScore, patientState };
}

/**
 * Stores, decides and enqueues for a set of scored readings. Returns the ids
 * of readings that must be retried. A device's readings succeed or fail
 * together, so a retry always sees a consistent STATE item.
 */
async function ingest(readings, config) {
  const failed = new Set();
  if (!readings.length) return failed;

  // Throws: the archive is the one complete record of every reading, so a
  // batch it cannot take is retried whole rather than half kept.
  await archive(readings, config);

  const byDevice = groupByDevice(readings);
  const states = await loadStates([...byDevice.keys()], config.table);

  const plans = [];
  for (const [deviceId, deviceReadings] of byDevice) {
    plans.push(planDevice(deviceId, deviceReadings, states.get(deviceId), config));
  }

  if (config.keepReadings) {
    const unwritten = await writeReadings(readings, config);
    failDevices(plans, (plan) => plan.readings.some((r) => unwritten.has(r)));
  }

  const notQueued = await enqueueSyncs(plans.filter((plan) => !plan.failed), config.queueUrl);
  failDevices(plans, (plan) => plan.syncs.some((sync) => notQueued.has(sync)));

  await mapLimit(
    plans.filter((plan) => !plan.failed && plan.stateChanged),
    PARALLEL_REQUESTS,
    (plan) => saveState(plan, config.table),
  );

  for (const plan of plans) {
    if (plan.failed) plan.readings.forEach((r) => failed.add(r.id));
  }
  return failed;
}

function groupByDevice(readings) {
  const byDevice = new Map();
  for (const reading of readings) {
    const list = byDevice.get(reading.vitals.deviceId) || [];
    list.push(reading);
    byDevice.set(reading.vitals.deviceId, list);
  }
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.vitals.timestamp.localeCompare(b.vitals.timestamp));
  }
  return byDevice;
}

/**
 * Walks one device's readings in time order against its STATE item and
 * decides which ones Salesforce gets, for one of three reasons:
 *   - a change of state;
 *   - a reminder while the patient is not STABLE and the last sync went out
 *     REALERT_INTERVAL_MINUTES ago or more;
 *   - (temperature alert demo rule, ROOM_TEMP_ALERT on) hotDue: the reading is
 *     at or above ROOM_TEMP_ALERT_CELSIUS and either the device was not hot
 *     before (a crossing) or ROOM_TEMP_REALERT_MINUTES have passed (never,
 *     when that is 0). The record is flagged Room_Temperature_Alert__c. An
 *     episode ends only when a reading drops below the threshold minus
 *     ROOM_TEMP_REARM_MARGIN_C; readings in between, and readings without a
 *     temperature, leave it as it is.
 *   A re-arm (RearmRequestedAt newer than LastSyncedAt, written by
 *   device-live when Salesforce closes the device's Case) ends the episode
 *   too, so the next hot reading is a crossing. A sync afterwards makes
 *   LastSyncedAt newer, which uses the re-arm up. It is never written here,
 *   so a STATE save racing the re-arm cannot undo it.
 * Still at most one sync per reading: a hot reading synced for a clinical
 * reason carries the flag too. All share the LastSyncedAt clock, so any sync
 * resets LastSyncedAt.
 *
 * A reading no newer than the state already recorded is stored but decides
 * nothing: it is a retry, or it arrived late, and acting on it would report a
 * transition that is already history.
 */
function planDevice(deviceId, readings, state, config) {
  const { realertMs } = config;
  const ruleOn = config.roomTempAlert === true;
  const roomRealertMs = config.roomTempRealertMs || 0;
  let patientState = state ? state.PatientState : null;
  let updatedAt = state ? state.UpdatedAt : null;
  let lastSyncedAt = state ? state.LastSyncedAt || null : null;
  // A stored true with the rule off would keep re-syncing: force it off.
  let hot = ruleOn && state ? state.RoomTempHot === true && !rearmPending(state) : false;
  const wasHotAtStart = hot;
  let latest = null;
  const syncs = [];

  for (const reading of readings) {
    const { vitals } = reading;
    if (updatedAt && vitals.timestamp <= updatedAt) continue;

    const t = vitals.temperature;
    const measured = ruleOn && Number.isFinite(t);
    const isHot = measured && t >= config.roomTempCelsius;
    const cooled = measured && t < config.roomTempCelsius - ROOM_TEMP_REARM_MARGIN_C;
    const intervalPassed = !lastSyncedAt
      || Date.parse(vitals.timestamp) - Date.parse(lastSyncedAt) >= realertMs;

    const changed = vitals.patientState !== patientState;
    const reminderDue = vitals.patientState !== 'STABLE' && intervalPassed;
    const hotRepeatDue = roomRealertMs > 0 && (!lastSyncedAt
      || Date.parse(vitals.timestamp) - Date.parse(lastSyncedAt) >= roomRealertMs);
    const hotDue = isHot && (!hot || hotRepeatDue);
    if (changed || reminderDue || hotDue) {
      syncs.push(toSalesforceRecord(vitals, patientState, isHot));
      lastSyncedAt = vitals.timestamp;
    }
    // A null temperature, or one inside the margin band, leaves it unchanged.
    if (isHot) hot = true; else if (cooled) hot = false;
    patientState = vitals.patientState;
    updatedAt = vitals.timestamp;
    latest = vitals;
  }

  const stateChanged = latest !== null
    && (!state || state.PatientState !== latest.patientState || syncs.length > 0
      || hot !== wasHotAtStart || (state && state.RoomTempHot === true && !ruleOn));
  return {
    deviceId, readings, syncs, failed: false, stateChanged,
    next: latest && {
      PatientState: latest.patientState,
      RiskScore: latest.riskScore,
      UpdatedAt: updatedAt,
      LastSyncedAt: lastSyncedAt,
      RoomTempHot: hot,
    },
  };
}

function failDevices(plans, predicate) {
  for (const plan of plans) {
    if (!plan.failed && predicate(plan)) plan.failed = true;
  }
}

/**
 * Every reading in the batch as one gzipped NDJSON object: the full-fidelity
 * history. With DATA_CLOUD_EXPORT_PREFIX set, the same readings also go out as
 * one CSV file under that prefix, for Data Cloud. Both must land, or the batch
 * is retried: a reading missing from either would be missing for good.
 */
async function archive(readings, { archiveBucket, dataCloudPrefix }) {
  const first = readings[0].vitals.receivedAt || readings[0].vitals.timestamp;
  const day = first.slice(0, 10);
  const hour = first.slice(11, 13);
  const body = gzipSync(readings.map((r) => JSON.stringify(r.vitals)).join('\n') + '\n');
  const writes = [s3.send(new PutObjectCommand({
    Bucket: archiveBucket,
    // Partitioned by day and hour for Athena. At-least-once: a retried batch
    // writes a second object, so readers dedupe on (deviceId, timestamp),
    // the same key DynamoDB and Salesforce use.
    Key: `readings/date=${day}/hour=${hour}/${readings[0].id}-${readings.length}.ndjson.gz`,
    Body: body,
    ContentType: 'application/x-ndjson',
    ContentEncoding: 'gzip',
  }))];
  if (dataCloudPrefix) {
    writes.push(s3.send(new PutObjectCommand({
      Bucket: archiveBucket,
      // One flat folder: a Data Cloud data stream ignores files in
      // subfolders, so the day and hour go in the name instead. No colons:
      // Data Cloud refuses them in file names.
      Key: `${dataCloudPrefix}room-readings-${day}-${hour}-${readings[0].id}-${readings.length}.csv`,
      Body: roomReadingsCsv(readings.map((r) => r.vitals)),
      ContentType: 'text/csv; charset=utf-8',
    })));
  }
  await Promise.all(writes);
}

/**
 * The Data Cloud copy: a header, then one flat row per reading, deduplicated
 * on reading_id, the key the data stream upserts on. reading_id is the
 * Salesforce Device_Reading_Id__c, deviceId-timestamp, so a reading in both
 * places has one id. serial_number is the Thing name too: it is the Asset's
 * SerialNumber, which is how a row finds its device's Asset in Data Cloud.
 */
function roomReadingsCsv(vitalsList) {
  const seen = new Set();
  const lines = [ROOM_READING_COLUMNS.join(',')];
  for (const vitals of vitalsList) {
    const row = roomReadingRow(vitals);
    if (seen.has(row.reading_id)) continue;
    seen.add(row.reading_id);
    lines.push(ROOM_READING_COLUMNS.map((column) => csvValue(row[column])).join(','));
  }
  return lines.join('\n') + '\n';
}

function roomReadingRow(vitals) {
  return {
    reading_id: `${vitals.deviceId}-${vitals.timestamp}`,
    device_id: vitals.deviceId,
    serial_number: vitals.deviceId,
    reading_ts: vitals.timestamp,
    received_ts: vitals.receivedAt,
    temperature_c: vitals.temperature,
    humidity_pct: vitals.humidity,
    room: vitals.room,
    source_system: vitals.sourceSystem,
  };
}

/**
 * Text in double quotes, which also helps Data Cloud detect the delimiter;
 * numbers bare; a missing value as nothing at all, so it loads as null
 * rather than as an empty string or a zero.
 */
function csvValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return `"${String(value).replace(/[\r\n]+/g, ' ').replace(/"/g, '""')}"`;
}

/** STATE items for these devices, by device id. Throws if DynamoDB cannot answer at all. */
async function loadStates(deviceIds, table) {
  const states = new Map();
  const chunks = chunk(deviceIds, BATCH_GET_LIMIT);
  await mapLimit(chunks, PARALLEL_REQUESTS, async (ids) => {
    let keys = ids.map((id) => ({ PK: `PATIENT#${id}`, SK: 'STATE' }));
    for (let attempt = 0; keys.length; attempt++) {
      if (attempt > UNPROCESSED_RETRIES) {
        throw new Error(`DynamoDB left ${keys.length} STATE reads unprocessed after ${UNPROCESSED_RETRIES} retries`);
      }
      if (attempt) await backoff(attempt);
      const result = await dynamodb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
      for (const item of (result.Responses && result.Responses[table]) || []) {
        states.set(item.PK.slice('PATIENT#'.length), item);
      }
      keys = (result.UnprocessedKeys && result.UnprocessedKeys[table] && result.UnprocessedKeys[table].Keys) || [];
    }
  });
  return states;
}

/** Writes every reading; returns the ones DynamoDB would not take. */
async function writeReadings(readings, { table, retentionSeconds }) {
  const expiresAt = Math.floor(Date.now() / 1000) + retentionSeconds;
  const unwritten = new Set();
  await mapLimit(chunk(readings, BATCH_WRITE_LIMIT), PARALLEL_REQUESTS, async (group) => {
    const byKey = new Map(group.map((r) => [`${r.vitals.deviceId}|${r.vitals.timestamp}`, r]));
    let requests = [...byKey.values()].map((r) => ({ PutRequest: { Item: readingItem(r.vitals, expiresAt) } }));
    for (let attempt = 0; requests.length && attempt <= UNPROCESSED_RETRIES; attempt++) {
      if (attempt) await backoff(attempt);
      try {
        const result = await dynamodb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
        requests = (result.UnprocessedItems && result.UnprocessedItems[table]) || [];
      } catch (err) {
        console.error('DynamoDB BatchWriteItem failed', { error: err.message, items: requests.length });
        break;
      }
    }
    for (const request of requests) {
      const item = request.PutRequest.Item;
      const deviceId = item.PK.slice('PATIENT#'.length);
      const timestamp = item.SK.slice('VITAL#'.length);
      for (const r of group) {
        if (r.vitals.deviceId === deviceId && r.vitals.timestamp === timestamp) unwritten.add(r);
      }
    }
  });
  return unwritten;
}

function readingItem(vitals, expiresAt) {
  return {
    PK: `PATIENT#${vitals.deviceId}`,
    SK: `VITAL#${vitals.timestamp}`,
    HeartRate: vitals.heartRate,
    SpO2: vitals.spo2,
    Temperature: vitals.temperature,
    Humidity: vitals.humidity,
    BP_Systolic: vitals.bloodPressureSystolic,
    BP_Diastolic: vitals.bloodPressureDiastolic,
    RiskScore: vitals.riskScore,
    PatientState: vitals.patientState,
    SourceSystem: vitals.sourceSystem,
    CreatedAt: vitals.timestamp,
    // DynamoDB deletes the row after READING_RETENTION_DAYS (the table's TTL).
    ExpiresAt: expiresAt,
  };
}

/** Sends every planned sync to the sync queue; returns the syncs SQS did not accept. */
async function enqueueSyncs(plans, queueUrl) {
  const syncs = plans.flatMap((plan) => plan.syncs);
  const notQueued = new Set();
  await mapLimit(chunk(syncs, SQS_BATCH_LIMIT), PARALLEL_REQUESTS, async (group) => {
    try {
      const result = await sqs.send(new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: group.map((record, i) => ({ Id: String(i), MessageBody: JSON.stringify(record) })),
      }));
      for (const failure of result.Failed || []) notQueued.add(group[Number(failure.Id)]);
    } catch (err) {
      console.error('SQS SendMessageBatch failed', { error: err.message, messages: group.length });
      group.forEach((record) => notQueued.add(record));
    }
  });
  return notQueued;
}

/**
 * True when Salesforce asked for a re-arm (its Case for this device closed)
 * after the last sync went out. ISO 8601 UTC strings compare in time order.
 */
function rearmPending(state) {
  return typeof state.RearmRequestedAt === 'string'
    && state.RearmRequestedAt > (typeof state.LastSyncedAt === 'string' ? state.LastSyncedAt : '');
}

/**
 * Saves a device's new STATE, unless a newer reading already did: two batches
 * can hold readings of the same device, and the older one must not win.
 */
async function saveState(plan, table) {
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: table,
      Key: { PK: `PATIENT#${plan.deviceId}`, SK: 'STATE' },
      UpdateExpression: 'SET PatientState = :state, RiskScore = :score, UpdatedAt = :at, LastSyncedAt = :synced, RoomTempHot = :hot',
      ConditionExpression: 'attribute_not_exists(UpdatedAt) OR UpdatedAt < :at',
      ExpressionAttributeValues: {
        ':state': plan.next.PatientState,
        ':score': plan.next.RiskScore,
        ':at': plan.next.UpdatedAt,
        ':synced': plan.next.LastSyncedAt,
        // Never undefined: removeUndefinedValues would drop it and DynamoDB
        // would reject the expression.
        ':hot': plan.next.RoomTempHot === true,
      },
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return;   // a newer reading got there first
    console.error('STATE update failed', { deviceId: plan.deviceId, error: err.message });
    plan.failed = true;
  }
}

/**
 * The Patient_Vitals__c record salesforce-sync upserts. roomTempAlert adds
 * Room_Temperature_Alert__c = true; otherwise the key is left out, so records
 * from a stack with the rule off are exactly what they were before it.
 */
function toSalesforceRecord(vitals, previousState, roomTempAlert) {
  const record = {
    // Upsert on a deterministic external ID (deviceId + timestamp), not
    // create: deliveries retry, and a retried create duplicates the record.
    // Apex DataIngestionService builds the same key.
    Device_Reading_Id__c: `${vitals.deviceId}-${vitals.timestamp}`,
    Device__c: vitals.deviceId,
    Previous_State__c: previousState,
    Heart_Rate__c: vitals.heartRate,
    SpO2__c: vitals.spo2,
    Temperature__c: vitals.temperature,
    Humidity__c: vitals.humidity,
    BP_Systolic__c: vitals.bloodPressureSystolic,
    BP_Diastolic__c: vitals.bloodPressureDiastolic,
    Timestamp__c: vitals.timestamp,
    Risk_Score__c: vitals.riskScore,
    Patient_State__c: vitals.patientState,
    Source_System__c: vitals.sourceSystem,
  };
  if (roomTempAlert) record.Room_Temperature_Alert__c = true;
  return record;
}

/**
 * Parse raw IoT telemetry into structured patient vitals.
 * Handles multiple device formats and data sources.
 */
function parseVitals(rawPayload) {
  try {
    const data = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    // thingName is the topic the IoT rule read the message from (topic(2)):
    // the policy lets a device publish only to its own topic, so unlike the
    // deviceId in the body, it cannot be another patient's.
    const deviceId = data && (data.thingName || data.deviceId || data.device_id);
    if (!deviceId) return null;

    // A value the device did not send stays null. Defaulting it to a
    // normal reading wrote measurements no sensor took (SpO2 98, BP
    // 120/80) into the patient's record: the patient monitor's DHT11
    // sends only temperature and humidity.
    return {
      deviceId,
      heartRate: firstNumber(data.heartRate, data.hr),
      spo2: firstNumber(data.spo2, data.o2_saturation),
      temperature: firstNumber(data.temperature, data.temp),
      humidity: firstNumber(data.humidity),
      bloodPressureSystolic: firstNumber(data.bpSystolic, data.bp_sys),
      bloodPressureDiastolic: firstNumber(data.bpDiastolic, data.bp_dia),
      // receivedAt is the IoT rule's timestamp(). Unlike this Lambda's
      // clock it is the same on every retry, which is what keeps the
      // upsert key stable.
      timestamp: toIsoTimestamp(data.timestamp)
        || toIsoTimestamp(data.receivedAt)
        || new Date().toISOString(),
      receivedAt: toIsoTimestamp(data.receivedAt),
      sourceSystem: 'AWS_IoT',
      // Only when the board sent one, so the archive of a board that sends
      // none (the patient monitor today) is exactly what it was.
      ...roomLabel(data.room, data.location),
    };
  } catch (error) {
    console.error('Failed to parse vitals:', error.message);
    return null;
  }
}

/** { room } from the first non-empty label given, on one line and at most ROOM_LABEL_MAX long; {} without one. */
function roomLabel(...values) {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    // Control characters (line breaks among them) become spaces.
    const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, ROOM_LABEL_MAX).trim();
    if (text) return { room: text };
  }
  return {};
}

/**
 * The first value that parses as a finite number, or null. Zero counts as a
 * reading; only absent values are skipped.
 */
function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * ISO 8601 from an ISO string or an epoch time in seconds or milliseconds;
 * null when absent or unparseable.
 */
function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number'
    ? new Date(value < 1e12 ? value * 1000 : value)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Runs fn over items, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function backoff(attempt) {
  // Full jitter: random between 0 and 50 ms x 2^attempt.
  return new Promise((resolve) => setTimeout(resolve, Math.random() * 50 * 2 ** attempt));
}

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Exposed for direct unit tests; nothing imports it today.
exports._internal = {
  parseVitals, planDevice, toSalesforceRecord, roomReadingsCsv, ROOM_READING_COLUMNS,
};
