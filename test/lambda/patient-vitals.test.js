'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const {
  loadWithFakes, fakeAwsSdk, fakeDynamoDb, fakeSqs, fakeSsm, awsError, captureConsole, withEnv,
} = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/patient-vitals/index.js');
const THRESHOLDS = require('../../config/vital-thresholds.json');
const THRESHOLDS_PARAMETER = '/cloud-agentic-iot/config/vital-thresholds';
const TABLE = 'patient-vitals';
const RECEIVED_AT = 1761580800000;                // what timestamp() adds in the IoT rule
const RECEIVED_ISO = '2025-10-27T16:00:00.000Z';
const HALF_A_MINUTE_EARLIER = '2025-10-27T15:59:30.000Z';

// What the template sets. Every test starts from these.
const ENV = {
  DYNAMODB_TABLE: TABLE,
  SYNC_QUEUE_URL: 'https://sqs.ca-central-1.amazonaws.com/123456789012/cloud-agentic-iot-sync',
  ARCHIVE_BUCKET: 'patient-vitals-archive',
  THRESHOLDS_PARAMETER,
  REALERT_INTERVAL_MINUTES: '15',
  KEEP_READINGS_IN_DYNAMODB: 'true',
  READING_RETENTION_DAYS: '30',
  CONFIG_CACHE_SECONDS: '300',
  ROOM_TEMP_ALERT: 'false',
  ROOM_TEMP_ALERT_CELSIUS: '30',
};

// What the IoT rule puts on the telemetry queue: exactly what the patient
// monitor publishes, plus topic(2) as thingName and timestamp() as receivedAt.
const dht11Message = (overrides = {}) => ({
  deviceId: 'pm-1', temperature: 23.4, humidity: 41, thingName: 'pm-1', receivedAt: RECEIVED_AT, ...overrides,
});
// 30 + 35 + 25 points with the deployed bands: 90, CRITICAL.
const criticalMessage = (overrides = {}) => dht11Message({ heartRate: 130, spo2: 85, temperature: 39.5, ...overrides });
const device = (n) => ({ deviceId: `pm-${n}`, thingName: `pm-${n}` });

/** An SQS event as the event source mapping delivers it. */
const queueBatch = (...bodies) => ({
  Records: bodies.map((body, i) => ({ messageId: `m-${i}`, body: JSON.stringify(body), eventSource: 'aws:sqs' })),
});

const stateItem = (deviceId, PatientState, UpdatedAt, LastSyncedAt = UpdatedAt) => ({
  PK: `PATIENT#${deviceId}`, SK: 'STATE', PatientState, RiskScore: 0, UpdatedAt, LastSyncedAt,
});

/**
 * Loads the handler against a fake DynamoDB table, a fake sync queue, a fake
 * archive bucket and the deployed thresholds in a fake Parameter Store.
 */
function load(t, {
  items = [], env = {}, thresholds = THRESHOLDS, dynamo: dynamoOptions, sqs: sqsOptions, s3Error = null,
} = {}) {
  withEnv(t, { ...ENV, ...env });
  t.mock.method(Math, 'random', () => 0);         // DynamoDB retries back off for 0 ms
  const dynamo = fakeDynamoDb(items, dynamoOptions);
  const sqs = fakeSqs(sqsOptions);
  // s3Error fails every write, or, as a function of the write's input, the
  // writes it returns an error for.
  const s3 = fakeAwsSdk('S3Client', ['PutObjectCommand'], (command, input) => {
    const error = typeof s3Error === 'function' ? s3Error(input) : s3Error;
    if (error) throw error;
    return {};
  });
  const ssm = fakeSsm({ [THRESHOLDS_PARAMETER]: JSON.stringify(thresholds) });
  const { handler } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': dynamo.sdk,
    '@aws-sdk/client-sqs': sqs.sdk,
    '@aws-sdk/client-s3': s3.sdk,
    '@aws-sdk/client-ssm': ssm.sdk,
  });
  return {
    handler,
    dynamo,
    sqs,
    s3,
    ssm,
    syncs: () => sqs.messages.map((message) => message.body),
    state: (deviceId = 'pm-1') => dynamo.table.get(`PATIENT#${deviceId}|STATE`),
    readings: (deviceId = 'pm-1') => [...dynamo.table.values()]
      .filter((item) => item.PK === `PATIENT#${deviceId}` && item.SK.startsWith('VITAL#')),
    writtenKeys: () => dynamo.calls
      .filter((call) => call.command === 'BatchWriteCommand')
      .flatMap((call) => call.input.RequestItems[TABLE].map((request) => request.PutRequest.Item.SK)),
  };
}

test('stores and scores the reading the IoT rule puts on the queue', async (t) => {
  captureConsole(t);
  const { handler, readings, syncs, state } = load(t);

  const result = await handler(queueBatch(dht11Message()));

  assert.deepEqual(result, { batchItemFailures: [] });
  const [reading] = readings();
  assert.equal(reading.SK, `VITAL#${RECEIVED_ISO}`);
  assert.equal(reading.Temperature, 23.4);
  assert.equal(reading.Humidity, 41);
  // Deleted by the table's TTL after READING_RETENTION_DAYS.
  assert.ok(reading.ExpiresAt >= Math.floor(Date.now() / 1000) + 30 * 86_400 - 5);

  // First reading from a new device: unknown -> STABLE is a transition.
  const [sync] = syncs();
  assert.equal(sync.Device_Reading_Id__c, `pm-1-${RECEIVED_ISO}`);
  assert.equal(sync.Device__c, 'pm-1');
  assert.equal(sync.Temperature__c, 23.4);
  assert.equal(sync.Humidity__c, 41);
  assert.equal(sync.Timestamp__c, RECEIVED_ISO);
  assert.equal(sync.Patient_State__c, 'STABLE');
  assert.equal(sync.Previous_State__c, null);
  assert.equal(state().PatientState, 'STABLE');
  assert.equal(state().LastSyncedAt, RECEIVED_ISO);
});

test('the device is the one whose topic the reading came in on, whatever the body says', async (t) => {
  captureConsole(t);
  const { handler, syncs } = load(t);
  // The policy lets a device publish only to its own topic, so thingName
  // (topic(2) in the rule) cannot be spoofed. A deviceId in the body can.
  await handler(queueBatch(dht11Message({ deviceId: 'another-patient' })));
  assert.equal(syncs()[0].Device__c, 'pm-1');
});

test('values the sensor did not send stay empty instead of looking normal', async (t) => {
  captureConsole(t);
  const { handler, readings, syncs } = load(t);
  await handler(queueBatch(dht11Message()));

  // These used to be filled in as SpO2 98, BP 120/80 and heart rate 0.
  const [sync] = syncs();
  for (const field of ['Heart_Rate__c', 'SpO2__c', 'BP_Systolic__c', 'BP_Diastolic__c']) {
    assert.equal(sync[field], null, field);
  }
  const [reading] = readings();
  for (const field of ['HeartRate', 'SpO2', 'BP_Systolic', 'BP_Diastolic']) {
    assert.equal(reading[field], null, field);
  }
});

test('a retried batch sends the same record, whatever the clock says', async (t) => {
  captureConsole(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  let calls = 0;
  const { handler, sqs } = load(t, { sqs: { outage: () => ++calls === 1 } });
  const batch = queueBatch(dht11Message());

  assert.deepEqual((await handler(batch)).batchItemFailures, [{ itemIdentifier: 'm-0' }]);
  t.mock.timers.tick(60_000);                     // SQS hands the message back later
  assert.deepEqual((await handler(batch)).batchItemFailures, []);

  const [first, retry] = sqs.calls.map((call) => call.input.Entries[0].MessageBody);
  assert.equal(first, retry);
});

test('a sync the queue does not take sends the reading back, with its state unsaved', async (t) => {
  const lines = captureConsole(t);
  const { handler, state, syncs } = load(t, { sqs: { reject: () => 'InternalError' } });

  const result = await handler(queueBatch(dht11Message()));

  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'm-0' }]);
  assert.equal(syncs().length, 0);
  // Saved anyway, the retry would see "no change" and never sync the transition.
  assert.equal(state(), undefined);
  assert.ok(lines.some((line) => line.includes('Readings to retry')));
});

test('the retry after a failed enqueue still syncs the transition', async (t) => {
  captureConsole(t);
  let calls = 0;
  const { handler, state, syncs } = load(t, { sqs: { outage: () => ++calls === 1 } });
  const batch = queueBatch(dht11Message());

  await handler(batch);
  const result = await handler(batch);

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(syncs().length, 1);
  assert.equal(state().PatientState, 'STABLE');
});

test('an unchanged stable reading stays out of Salesforce and leaves the state item alone', async (t) => {
  captureConsole(t);
  const { handler, dynamo, readings, syncs } = load(t, { items: [stateItem('pm-1', 'STABLE', HALF_A_MINUTE_EARLIER)] });

  await handler(queueBatch(dht11Message()));

  assert.equal(syncs().length, 0);
  assert.equal(readings().length, 1);
  // Nothing changed, so nothing is written: at a million devices, rewriting
  // every STATE item every 30 seconds would be 33,000 writes a second.
  assert.equal(dynamo.count('UpdateCommand'), 0);
});

test('a patient who stays critical is sent again once the re-alert interval has passed', async (t) => {
  captureConsole(t);
  const lastSent = '2025-10-27T15:45:00.000Z';    // exactly 15 minutes earlier
  const { handler, syncs, state } = load(t, { items: [stateItem('pm-1', 'CRITICAL', HALF_A_MINUTE_EARLIER, lastSent)] });

  await handler(queueBatch(criticalMessage()));

  const [sync] = syncs();
  assert.equal(sync.Risk_Score__c, 90);
  assert.equal(sync.Patient_State__c, 'CRITICAL');
  assert.equal(sync.Previous_State__c, 'CRITICAL');
  assert.equal(state().LastSyncedAt, RECEIVED_ISO);
});

test('but not before the interval has passed', async (t) => {
  captureConsole(t);
  const lastSent = '2025-10-27T15:50:00.000Z';    // 10 minutes earlier
  const { handler, syncs } = load(t, { items: [stateItem('pm-1', 'CRITICAL', HALF_A_MINUTE_EARLIER, lastSent)] });
  await handler(queueBatch(criticalMessage()));
  assert.equal(syncs().length, 0);
});

test("a device's readings in one batch are taken in time order", async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t);
  const at = (seconds) => RECEIVED_AT + seconds * 1000;

  // SQS does not keep order: the batch holds them newest first.
  await handler(queueBatch(
    dht11Message({ temperature: 37, receivedAt: at(60) }),
    criticalMessage({ receivedAt: at(30) }),
    dht11Message({ temperature: 37, receivedAt: at(0) }),
  ));

  assert.deepEqual(
    syncs().map((sync) => [sync.Previous_State__c, sync.Patient_State__c]),
    [[null, 'STABLE'], ['STABLE', 'CRITICAL'], ['CRITICAL', 'STABLE']],
  );
  assert.equal(state().PatientState, 'STABLE');
  assert.equal(state().UpdatedAt, new Date(at(60)).toISOString());
});

test('a reading older than the saved state is kept but decides nothing', async (t) => {
  captureConsole(t);
  const later = '2025-10-27T16:05:00.000Z';
  const { handler, syncs, readings, state } = load(t, { items: [stateItem('pm-1', 'STABLE', later)] });

  // Arrived late, or a retry: acting on it would report a transition that is already history.
  await handler(queueBatch(criticalMessage()));

  assert.equal(readings().length, 1);
  assert.equal(syncs().length, 0);
  assert.equal(state().UpdatedAt, later);
});

test('an older batch cannot overwrite the state a newer one saved', async (t) => {
  captureConsole(t);
  const newer = '2025-10-27T16:10:00.000Z';
  const { handler, state } = load(t, {
    items: [stateItem('pm-1', 'STABLE', HALF_A_MINUTE_EARLIER)],
    dynamo: {
      // Another batch, holding a later reading, saves first.
      beforeUpdate: (table) => table.set('PATIENT#pm-1|STATE', stateItem('pm-1', 'AT_RISK', newer)),
    },
  });

  const result = await handler(queueBatch(criticalMessage()));

  assert.deepEqual(result.batchItemFailures, []);   // lost the race, which is not an error
  assert.equal(state().PatientState, 'AT_RISK');
  assert.equal(state().UpdatedAt, newer);
});

test('DynamoDB throttling is retried, and only a device it never takes goes back to SQS', async (t) => {
  captureConsole(t);
  let gets = 0;
  const { handler, dynamo, syncs, state } = load(t, {
    dynamo: {
      unprocessed: (command, entries) => {
        if (command === 'BatchGetCommand') return gets++ === 0 ? entries.slice(0, 1) : [];
        return entries.filter((request) => request.PutRequest.Item.PK === 'PATIENT#pm-2');
      },
    },
  });

  const result = await handler(queueBatch(dht11Message(), dht11Message(device(2))));

  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'm-1' }]);
  assert.equal(dynamo.count('BatchGetCommand'), 2);    // the key it left, read again
  assert.equal(dynamo.count('BatchWriteCommand'), 5);  // the call, then 4 retries for pm-2
  assert.deepEqual(syncs().map((sync) => sync.Device__c), ['pm-1']);
  assert.equal(state('pm-2'), undefined);
});

test('a reading SQS delivered twice in one batch is written and synced once', async (t) => {
  captureConsole(t);
  const { handler, writtenKeys, syncs } = load(t);
  // Two copies of one item in a BatchWriteItem fail the whole request.
  const result = await handler(queueBatch(dht11Message(), dht11Message()));
  assert.deepEqual(result.batchItemFailures, []);
  assert.deepEqual(writtenKeys(), [`VITAL#${RECEIVED_ISO}`]);
  assert.equal(syncs().length, 1);
});

test('every reading in a batch is archived in one gzipped object, by day and hour', async (t) => {
  captureConsole(t);
  const { handler, s3 } = load(t);

  await handler(queueBatch(dht11Message(), dht11Message({ receivedAt: RECEIVED_AT + 30_000 }), criticalMessage(device(2))));

  assert.equal(s3.calls.length, 1);
  const { input } = s3.calls[0];
  assert.equal(input.Bucket, 'patient-vitals-archive');
  assert.equal(input.Key, 'readings/date=2025-10-27/hour=16/m-0-3.ndjson.gz');
  assert.equal(input.ContentEncoding, 'gzip');
  const lines = gunzipSync(input.Body).toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.deviceId), ['pm-1', 'pm-1', 'pm-2']);
  assert.equal(lines[2].riskScore, 90);
});

test('a batch the archive cannot take is retried whole, before anything else is written', async (t) => {
  captureConsole(t);
  const { handler, dynamo, sqs } = load(t, { s3Error: awsError('ServiceUnavailable') });
  await assert.rejects(handler(queueBatch(dht11Message())), /ServiceUnavailable/);
  assert.equal(dynamo.calls.length, 0);
  assert.equal(sqs.calls.length, 0);
});

// The Data Cloud copy (docs/DATA-CLOUD.md). Data Cloud's Amazon S3 connector
// reads CSV or Parquet from one flat folder, so with DATA_CLOUD_EXPORT_PREFIX
// set each batch also lands as one CSV file there.
const DATA_CLOUD = { DATA_CLOUD_EXPORT_PREFIX: 'datacloud/room-readings/' };
const csvRows = (body) => {
  const [header, ...rows] = body.trimEnd().split('\n');
  return { header: header.split(','), rows };
};

test('the CSV columns are the ones datacloud/room-readings.columns.json tells Data Cloud to expect', (t) => {
  withEnv(t, ENV);
  const { _internal } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': fakeDynamoDb().sdk,
    '@aws-sdk/client-sqs': fakeSqs().sdk,
    '@aws-sdk/client-s3': fakeAwsSdk('S3Client', ['PutObjectCommand']).sdk,
    '@aws-sdk/client-ssm': fakeSsm().sdk,
  });
  const spec = require('../../datacloud/room-readings.columns.json');
  assert.deepEqual(_internal.ROOM_READING_COLUMNS, spec.columns.map((column) => column.name));
  assert.deepEqual(spec.columns.filter((column) => column.primaryKey).map((column) => column.name), [spec.dataStream.primaryKey]);
  // Data Cloud asks for ASCII in field names, and turns each into a DMO field name with __c.
  for (const column of spec.columns) {
    assert.match(column.name, /^[a-z][a-z0-9_]*$/, column.name);
    assert.equal(column.dmoField, `${column.name}__c`);
    assert.ok(['Text', 'Number', 'DateTime'].includes(column.type), `${column.name}: ${column.type}`);
  }
  // The file name pattern matches what the function writes, in the folder the template names.
  const pattern = new RegExp(`^${spec.file.fileNamePattern.replace('.', '\\.').replace('*', '.*')}$`);
  assert.match('room-readings-2025-10-27-16-m-0-3.csv', pattern);
  assert.match(_internal.roomReadingsCsv([]), /^reading_id,device_id,/);
});

test('without DATA_CLOUD_EXPORT_PREFIX, only the archive is written, as before', async (t) => {
  captureConsole(t);
  const { handler, s3 } = load(t);
  await handler(queueBatch(dht11Message()));
  assert.deepEqual(s3.calls.map((call) => call.input.Key), ['readings/date=2025-10-27/hour=16/m-0-1.ndjson.gz']);
});

test('with DATA_CLOUD_EXPORT_PREFIX, each batch is also one flat CSV file for Data Cloud', async (t) => {
  captureConsole(t);
  const { handler, s3 } = load(t, { env: DATA_CLOUD });

  const result = await handler(queueBatch(
    dht11Message(),
    dht11Message({ receivedAt: RECEIVED_AT + 30_000, temperature: 30.5, humidity: 38.2 }),
    dht11Message({ ...device(2), receivedAt: RECEIVED_AT + 1000, temperature: undefined, humidity: undefined }),
  ));
  assert.deepEqual(result.batchItemFailures, []);

  const keys = s3.calls.map((call) => call.input.Key).sort();
  assert.deepEqual(keys, [
    'datacloud/room-readings/room-readings-2025-10-27-16-m-0-3.csv',
    'readings/date=2025-10-27/hour=16/m-0-3.ndjson.gz',
  ]);
  const csv = s3.calls.find((call) => call.input.Key.endsWith('.csv')).input;
  assert.equal(csv.Bucket, 'patient-vitals-archive');
  assert.equal(csv.ContentType, 'text/csv; charset=utf-8');
  assert.equal(csv.ContentEncoding, undefined);
  // No colon and no subfolder: Data Cloud refuses the first and ignores the second.
  const name = csv.Key.slice(DATA_CLOUD.DATA_CLOUD_EXPORT_PREFIX.length);
  assert.doesNotMatch(name, /[:/']/);

  const { header, rows } = csvRows(csv.Body);
  assert.deepEqual(header, [
    'reading_id', 'device_id', 'serial_number', 'reading_ts', 'received_ts',
    'temperature_c', 'humidity_pct', 'room', 'source_system',
  ]);
  assert.deepEqual(rows, [
    `"pm-1-${RECEIVED_ISO}","pm-1","pm-1","${RECEIVED_ISO}","${RECEIVED_ISO}",23.4,41,,"AWS_IoT"`,
    '"pm-1-2025-10-27T16:00:30.000Z","pm-1","pm-1","2025-10-27T16:00:30.000Z","2025-10-27T16:00:30.000Z",30.5,38.2,,"AWS_IoT"',
    // A failed sensor read: empty, so Data Cloud loads null, not 0.
    '"pm-2-2025-10-27T16:00:01.000Z","pm-2","pm-2","2025-10-27T16:00:01.000Z","2025-10-27T16:00:01.000Z",,,,"AWS_IoT"',
  ]);
});

test('the CSV row id is the Salesforce reading id, and a reading delivered twice is one row', async (t) => {
  captureConsole(t);
  const { handler, s3, syncs } = load(t, { env: DATA_CLOUD });
  await handler(queueBatch(dht11Message(), dht11Message()));
  const { rows } = csvRows(s3.calls.find((call) => call.input.Key.endsWith('.csv')).input.Body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].split(',')[0], `"${syncs()[0].Device_Reading_Id__c}"`);
});

test('a room or location label, when a board sends one, reaches the CSV on one line and quoted', async (t) => {
  captureConsole(t);
  const { handler, s3 } = load(t, { env: DATA_CLOUD });
  await handler(queueBatch(
    dht11Message({ room: 'Ward 3, "Bay" 2\nnorth' }),
    dht11Message({ ...device(2), location: 'Ward 4' }),
    dht11Message({ ...device(3), room: '   ' }),
  ));
  const csv = s3.calls.find((call) => call.input.Key.endsWith('.csv')).input.Body;
  const { rows } = csvRows(csv);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /,"Ward 3, ""Bay"" 2 north","AWS_IoT"$/);
  assert.match(rows[1], /,"Ward 4","AWS_IoT"$/);
  assert.match(rows[2], /,,"AWS_IoT"$/);

  // The archive keeps the label too, and has no room key for a board that sent none.
  const ndjson = s3.calls.find((call) => call.input.Key.endsWith('.ndjson.gz')).input.Body;
  const lines = gunzipSync(ndjson).toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].room, 'Ward 3, "Bay" 2 north');
  assert.equal(lines[1].room, 'Ward 4');
  assert.equal(Object.hasOwn(lines[2], 'room'), false);
});

test('a long room label is cut to 64 characters', async (t) => {
  captureConsole(t);
  const { handler, s3 } = load(t, { env: DATA_CLOUD });
  await handler(queueBatch(dht11Message({ room: 'x'.repeat(200) })));
  const csv = s3.calls.find((call) => call.input.Key.endsWith('.csv')).input.Body;
  assert.match(csv, new RegExp(`,"${'x'.repeat(64)}","AWS_IoT"\n$`));
});

test('a batch the Data Cloud copy cannot take is retried whole, before anything else is written', async (t) => {
  captureConsole(t);
  const { handler, dynamo, sqs } = load(t, {
    env: DATA_CLOUD,
    s3Error: (input) => (input.Key.endsWith('.csv') ? awsError('SlowDown') : null),
  });
  await assert.rejects(handler(queueBatch(dht11Message())), /SlowDown/);
  assert.equal(dynamo.calls.length, 0);
  assert.equal(sqs.calls.length, 0);
});

test('a reading pushed through by hand reaches the Data Cloud copy too', async (t) => {
  captureConsole(t);
  const { handler, s3 } = load(t, { env: DATA_CLOUD });
  const response = await handler(dht11Message());
  assert.equal(response.statusCode, 200);
  const csv = s3.calls.find((call) => call.input.Key.endsWith('.csv'));
  assert.match(csv.input.Key, /^datacloud\/room-readings\/room-readings-2025-10-27-16-direct-[0-9a-f-]+-1\.csv$/);
});

test('with KEEP_READINGS_IN_DYNAMODB false, DynamoDB holds only the state', async (t) => {
  captureConsole(t);
  const { handler, dynamo, state, s3 } = load(t, {
    env: { KEEP_READINGS_IN_DYNAMODB: 'false', READING_RETENTION_DAYS: undefined },
  });
  await handler(queueBatch(dht11Message()));
  assert.equal(dynamo.count('BatchWriteCommand'), 0);
  assert.equal(state().PatientState, 'STABLE');
  assert.equal(s3.calls.length, 1);               // the archive still has the reading
});

test('the bands come from Parameter Store, read once per container', async (t) => {
  captureConsole(t);
  const stricter = structuredClone(THRESHOLDS);
  stricter.vitals = [{ field: 'temperature', unit: 'C', critical: { above: 40, points: 30 }, warning: { above: 22, points: 45 } }];
  const { handler, syncs, ssm } = load(t, { thresholds: stricter });

  await handler(queueBatch(dht11Message()));
  await handler(queueBatch(dht11Message(device(2))));

  // 23.4 C is above the new warning limit: 45 points, AT_RISK. No code changed.
  assert.deepEqual(syncs().map((sync) => [sync.Patient_State__c, sync.Risk_Score__c]), [['AT_RISK', 45], ['AT_RISK', 45]]);
  assert.equal(ssm.calls.length, 1);
});

test('a message without a device id is dropped, and the rest of the batch goes through', async (t) => {
  const lines = captureConsole(t);
  const { handler, readings } = load(t);
  const result = await handler(queueBatch({ temperature: 23.4 }, dht11Message()));
  // Retrying cannot give it a device, so it is not sent back.
  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(readings().length, 1);
  assert.ok(lines.some((line) => line.includes('Dropping a message without a device id')));
});

test('a missing setting fails before anything is written, and names itself', async (t) => {
  captureConsole(t);
  const { handler, s3, dynamo } = load(t, { env: { SYNC_QUEUE_URL: undefined } });
  await assert.rejects(handler(queueBatch(dht11Message())), /SYNC_QUEUE_URL is not set/);
  assert.equal(s3.calls.length + dynamo.calls.length, 0);
});

test('1,000 readings from 1,000 devices: batched calls, and Salesforce hears only the changes', async (t) => {
  captureConsole(t);
  const ids = Array.from({ length: 1000 }, (_, n) => n);
  const { handler, dynamo, sqs, s3, syncs } = load(t, {
    items: ids.map((n) => stateItem(`pm-${n}`, 'STABLE', HALF_A_MINUTE_EARLIER)),
  });

  // One in ten patients turns critical.
  const result = await handler(queueBatch(...ids.map((n) => (n % 10 ? dht11Message : criticalMessage)(device(n)))));

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(s3.calls.length, 1);
  assert.equal(dynamo.count('BatchGetCommand'), 10);     // 100 keys a call
  assert.equal(dynamo.count('BatchWriteCommand'), 40);   // 25 readings a call
  assert.equal(dynamo.count('UpdateCommand'), 100);      // only the states that changed
  assert.equal(syncs().length, 100);
  assert.equal(sqs.calls.length, 10);                    // 10 messages a call
});

// Invoked directly, by hand or from a test event: the shapes the IoT rule's
// old Lambda action and EventBridge send.

test('a reading invoked directly is processed and answered', async (t) => {
  captureConsole(t);
  const { handler, syncs } = load(t);
  const res = await handler(criticalMessage());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    message: 'Patient vitals processed successfully', deviceId: 'pm-1', riskScore: 90, patientState: 'CRITICAL',
  });
  assert.equal(syncs().length, 1);
});

test('still accepts the EventBridge and wrapped shapes', async (t) => {
  captureConsole(t);
  const { handler } = load(t, { items: [stateItem('pm-1', 'STABLE', HALF_A_MINUTE_EARLIER)] });
  assert.equal((await handler({ detail: dht11Message() })).statusCode, 200);
  assert.equal((await handler({ payload: JSON.stringify(dht11Message()) })).statusCode, 200);
});

test('a direct reading without a device id is rejected before anything is written', async (t) => {
  captureConsole(t);
  const { handler, dynamo, sqs, s3 } = load(t);
  const res = await handler({ temperature: 23.4 });
  assert.equal(res.statusCode, 400);
  assert.equal(dynamo.calls.length + sqs.calls.length + s3.calls.length, 0);
});

test('a direct reading that could not be stored throws, so Lambda retries it', async (t) => {
  captureConsole(t);
  const { handler } = load(t, { sqs: { outage: () => true } });
  // Invoked asynchronously, a returned 500 would count as delivered.
  await assert.rejects(handler(dht11Message()), /Reading from pm-1 was not stored/);
});

test('timestamps from the device are normalised to ISO 8601', async (t) => {
  captureConsole(t);
  const { handler, writtenKeys } = load(t);
  await handler({ deviceId: 'pm-1', temperature: 23.4, timestamp: RECEIVED_AT / 1000 });
  await handler({ deviceId: 'pm-1', temperature: 23.4, timestamp: RECEIVED_ISO });
  assert.deepEqual(writtenKeys(), [`VITAL#${RECEIVED_ISO}`, `VITAL#${RECEIVED_ISO}`]);
});

// The room-temperature demo rule (ROOM_TEMP_ALERT). The patient monitor's
// DHT11 measures room air, so 30 C on it is a warm room, scored STABLE by the
// clinical bands; the rule flags it for Salesforce, which opens the Case.

const ROOM_RULE_ON = { env: { ROOM_TEMP_ALERT: 'true' } };
const ONE_MINUTE_EARLIER = '2025-10-27T15:59:00.000Z';
const FIFTEEN_MINUTES_EARLIER = '2025-10-27T15:45:00.000Z';
/** A STABLE device whose last reading was half a minute ago, hot or not. */
const roomState = (RoomTempHot, LastSyncedAt = ONE_MINUTE_EARLIER) => ({
  ...stateItem('pm-1', 'STABLE', HALF_A_MINUTE_EARLIER, LastSyncedAt), RoomTempHot,
});
const flagged = (syncs) => syncs.filter((sync) => sync.Room_Temperature_Alert__c === true);

test('room rule: 29.9 C is below the line, so nothing is flagged', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, ROOM_RULE_ON);
  await handler(queueBatch(dht11Message({ temperature: 29.9 })));
  // The first reading of a new device is still synced, as a state change.
  assert.equal(syncs().length, 1);
  assert.ok(!('Room_Temperature_Alert__c' in syncs()[0]));
  assert.equal(state().RoomTempHot, false);
});

test('room rule: 30.0 C counts (the threshold is inclusive) and marks the device hot', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, ROOM_RULE_ON);
  await handler(queueBatch(dht11Message({ temperature: 30.0 })));
  assert.equal(syncs().length, 1);
  assert.equal(syncs()[0].Room_Temperature_Alert__c, true);
  assert.equal(syncs()[0].Temperature__c, 30);
  assert.equal(syncs()[0].Patient_State__c, 'STABLE');   // clinical bands unchanged
  assert.equal(state().RoomTempHot, true);
});

test('room rule: while hot, nothing more until the re-alert interval has passed', async (t) => {
  captureConsole(t);
  const { handler, syncs, dynamo } = load(t, { ...ROOM_RULE_ON, items: [roomState(true, ONE_MINUTE_EARLIER)] });
  await handler(queueBatch(dht11Message({ temperature: 31 })));
  assert.equal(syncs().length, 0);
  assert.equal(dynamo.count('UpdateCommand'), 0);        // nothing changed
});

test('room rule: while hot, reported again once the re-alert interval has passed', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, { ...ROOM_RULE_ON, items: [roomState(true, FIFTEEN_MINUTES_EARLIER)] });
  await handler(queueBatch(dht11Message({ temperature: 31 })));
  assert.equal(flagged(syncs()).length, 1);
  assert.equal(syncs().length, 1);
  assert.equal(state().LastSyncedAt, RECEIVED_ISO);
  assert.equal(state().RoomTempHot, true);
});

test('room rule: just below the line the episode goes on, silently (the 1 C margin)', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, { ...ROOM_RULE_ON, items: [roomState(true, FIFTEEN_MINUTES_EARLIER)] });
  await handler(queueBatch(dht11Message({ temperature: 29 })));
  assert.equal(syncs().length, 0);
  assert.equal(state().RoomTempHot, true);
});

test('room rule: more than 1 C below the line the episode ends, and that is saved', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, { ...ROOM_RULE_ON, items: [roomState(true)] });
  await handler(queueBatch(dht11Message({ temperature: 28.9 })));
  assert.equal(syncs().length, 0);
  assert.equal(state().RoomTempHot, false);
  assert.equal(state().UpdatedAt, RECEIVED_ISO);
});

test('room rule: crossing again after cooling is reported at once, interval or not', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, { ...ROOM_RULE_ON, items: [roomState(false, ONE_MINUTE_EARLIER)] });
  await handler(queueBatch(dht11Message({ temperature: 30 })));
  assert.equal(flagged(syncs()).length, 1);
  assert.equal(state().RoomTempHot, true);
});

test('room rule: a sensor wobbling around the line is one report, not four', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, {
    ...ROOM_RULE_ON, items: [roomState(false, HALF_A_MINUTE_EARLIER)],
  });
  const at = (seconds) => RECEIVED_AT + seconds * 1000;
  await handler(queueBatch(
    dht11Message({ temperature: 30, receivedAt: at(0) }),
    dht11Message({ temperature: 29.5, receivedAt: at(30) }),
    dht11Message({ temperature: 30.1, receivedAt: at(60) }),
    dht11Message({ temperature: 29.2, receivedAt: at(90) }),
  ));
  assert.equal(syncs().length, 1);
  assert.equal(syncs()[0].Temperature__c, 30);
  assert.equal(state().RoomTempHot, true);
});

test('room rule: a reading without a temperature leaves the episode as it is', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, { ...ROOM_RULE_ON, items: [roomState(true)] });
  await handler(queueBatch(dht11Message({ temperature: undefined, humidity: 40 })));
  assert.equal(syncs().length, 0);
  assert.equal(state().RoomTempHot, true);
});

test('room rule: a hot reading synced for a clinical change carries the flag, in one sync', async (t) => {
  captureConsole(t);
  const { handler, syncs, state } = load(t, { ...ROOM_RULE_ON, items: [roomState(false)] });
  await handler(queueBatch(criticalMessage()));            // 39.5 C, STABLE -> CRITICAL
  assert.equal(syncs().length, 1);
  assert.equal(syncs()[0].Patient_State__c, 'CRITICAL');
  assert.equal(syncs()[0].Room_Temperature_Alert__c, true);
  assert.equal(state().RoomTempHot, true);
});

test('room rule off: a hot flag left in STATE is cleared, and nothing is flagged', async (t) => {
  captureConsole(t);
  const { handler, syncs, state, dynamo } = load(t, { items: [roomState(true, FIFTEEN_MINUTES_EARLIER)] });
  await handler(queueBatch(dht11Message({ temperature: 35 })));
  assert.equal(flagged(syncs()).length, 0);
  assert.equal(syncs().length, 0);
  assert.equal(dynamo.count('UpdateCommand'), 1);
  assert.equal(state().RoomTempHot, false);
});

test('room rule off: the record has no flag key at all', async (t) => {
  captureConsole(t);
  const { handler, syncs } = load(t);
  await handler(queueBatch(dht11Message({ temperature: 35 })));
  const [record] = syncs();
  assert.ok(!('Room_Temperature_Alert__c' in record));
});

test('room rule: STATE is saved with RoomTempHot as a boolean, never undefined', async (t) => {
  captureConsole(t);
  // The fake refuses an expression placeholder with no value, as DynamoDB does.
  for (const env of [{}, ROOM_RULE_ON.env]) {
    await t.test(`ROOM_TEMP_ALERT ${env.ROOM_TEMP_ALERT || 'false'}`, async (t2) => {
      const { handler, state, dynamo } = load(t2, { env });
      const result = await handler(queueBatch(dht11Message({ temperature: 30 })));
      assert.deepEqual(result.batchItemFailures, []);
      assert.equal(dynamo.count('UpdateCommand'), 1);
      assert.equal(typeof state().RoomTempHot, 'boolean');
      assert.equal(state().RoomTempHot, env.ROOM_TEMP_ALERT === 'true');
    });
  }
});

test('the fake DynamoDB refuses an update whose placeholder has no value', async (t) => {
  const dynamo = fakeDynamoDb();
  const client = dynamo.sdk.DynamoDBDocumentClient.from();
  await assert.rejects(
    client.send(new dynamo.sdk.UpdateCommand({
      TableName: TABLE,
      Key: { PK: 'PATIENT#pm-1', SK: 'STATE' },
      UpdateExpression: 'SET RoomTempHot = :hot',
      ExpressionAttributeValues: { ':hot': undefined },
    })),
    /attribute value: :hot/,
  );
});
