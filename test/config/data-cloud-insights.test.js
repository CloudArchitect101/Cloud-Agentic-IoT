'use strict';

// The calculated insights in datacloud/ are SQL that Data Cloud checks only
// when someone creates them in an org. These checks catch, before that, the
// mistakes that would still pass Data Cloud's own check: a threshold that no
// longer matches the room-temperature rule, minutes counted at an interval the
// boards no longer send at, or a field the Room_Readings object does not have.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const manifest = require('../../datacloud/calculated-insights.json');
const spec = require('../../datacloud/room-readings.columns.json');
const configs = ['Dev', 'Prod'].map((env) => ({ env, config: require(`../../config/${env}.json`) }));
const sql = (insight) => fs.readFileSync(path.join(root, 'datacloud', insight.sql), 'utf8');
const insight = (apiName) => {
  const found = manifest.insights.find((i) => i.apiName === apiName);
  assert.ok(found, `datacloud/calculated-insights.json has no ${apiName}`);
  return found;
};
const DMO = `${spec.dataModelObject}__dlm`;

test('each insight has a unique API name ending __cio and a SQL file', () => {
  const names = manifest.insights.map((i) => i.apiName);
  assert.equal(new Set(names).size, names.length);
  for (const i of manifest.insights) {
    assert.match(i.apiName, /^[A-Za-z][A-Za-z0-9_]*__cio$/);
    assert.ok(i.displayName && i.description, `${i.apiName}: displayName and description`);
    // Data Cloud refuses a longer one: "Description can not be over length limit" (Nov 19).
    assert.ok(i.description.length <= 255, `${i.apiName}: description is ${i.description.length} characters, over 255`);
    assert.ok(fs.existsSync(path.join(root, 'datacloud', i.sql)), `${i.apiName}: ${i.sql}`);
  }
});

test('the SQL reads only Room_Readings, and only fields it has', () => {
  const fields = new Set(spec.columns.map((c) => c.dmoField));
  for (const i of manifest.insights) {
    const text = sql(i);
    assert.match(text, new RegExp(`\\bFROM ${DMO}\\b`), i.apiName);
    assert.deepEqual([...text.matchAll(/\bFROM (\w+)/g)].map((m) => m[1]), [DMO], `${i.apiName}: one source`);
    for (const [, field] of text.matchAll(new RegExp(`${DMO}\\.(\\w+)`, 'g'))) {
      assert.ok(fields.has(field), `${i.apiName} reads ${field}, which Room_Readings does not have`);
    }
    // Sent as one API field: no statement separator, no comment that could swallow the rest.
    assert.doesNotMatch(text, /;|--|\/\*/, i.apiName);
  }
});

test('every result column is named __c, and every grouped name is one of them', () => {
  for (const i of manifest.insights) {
    const text = sql(i);
    const aliases = [...text.matchAll(/\bAS (\w+)/g)].map((m) => m[1]);
    assert.ok(aliases.length >= 2, `${i.apiName}: a dimension and a measure at least`);
    for (const alias of aliases) assert.match(alias, /^[a-z][a-z0-9_]*__c$/, `${i.apiName}: ${alias}`);
    const groupBy = text.match(/GROUP BY (.+)$/m);
    assert.ok(groupBy, `${i.apiName}: GROUP BY`);
    for (const name of groupBy[1].split(',').map((n) => n.trim())) {
      assert.ok(aliases.includes(name), `${i.apiName} groups by ${name}, which it does not select`);
    }
  }
});

test("out of range means what the room-temperature rule means: at or above its threshold", () => {
  const daily = insight('Room_Out_Of_Range_Daily__cio');
  const text = sql(daily);
  const threshold = Number(text.match(new RegExp(`WHERE ${DMO}\\.temperature_c__c >= (\\d+(?:\\.\\d+)?)\\n`))[1]);
  assert.equal(threshold, daily.roomTempAlertCelsius);
  for (const { env, config } of configs) {
    assert.equal(config.stacks['patient-vitals'].RoomTempAlertCelsius, threshold, `${env}: RoomTempAlertCelsius`);
  }
  // The template's own default too, for a stack config/<env>.json says nothing about.
  const template = fs.readFileSync(path.join(root, 'lambda/patient-vitals/cloudformation.yaml'), 'utf8');
  assert.match(template, new RegExp(`\\n  RoomTempAlertCelsius:\\n(?: {4}.*\\n)*? {4}Default: ${threshold}\\n`));
});

test('minutes out of range are readings times the interval the boards send at', () => {
  const daily = insight('Room_Out_Of_Range_Daily__cio');
  const text = sql(daily);
  const perReading = Number(text.match(/COUNT\(\w+\.reading_id__c\) \* (\d+(?:\.\d+)?) AS minutes_out_of_range__c/)[1]);
  assert.equal(perReading, daily.telemetrySeconds / 60);
  for (const { env, config } of configs) {
    assert.equal(config.devices['patient-monitor'].telemetrySeconds, daily.telemetrySeconds, `${env}: telemetrySeconds`);
  }
  const firmware = fs.readFileSync(path.join(root, 'firmware/patient-monitor/patient-monitor.ino'), 'utf8');
  assert.match(firmware, new RegExp(`#define DEFAULT_TELEMETRY_SECONDS ${daily.telemetrySeconds}\\b`));
});

// Data Cloud refuses the current time after an aggregate in a calculated
// insight (UNIX_TIMESTAMP not supported; DATEDIFF takes two dates and counts
// days; NOW() after MAX: "Formatting non-inlined parameter current_timestamp
// is not supported", Nov 19). So the silence insight gives the last reading's
// time, and minutes since and offline are worked out where it is read.
test('the silence insight gives each device its last reading time, with no current time in the SQL', () => {
  const text = sql(insight('Room_Device_Silence__cio'));
  assert.match(text, /MAX\(\w+\.reading_ts__c\) AS last_reading_ts__c/);
  assert.doesNotMatch(text, /UNIX_TIMESTAMP|DATEDIFF|NOW\(|CURRENT_(TIMESTAMP|DATE)/i);
});

// Data Cloud refuses to create an insight without a publish schedule
// (REQUIRED_FIELD_MISSING publishScheduleInterval, Nov 19). Each run costs
// Data Cloud credits, so only the last-reading check runs hourly.
test('each insight has a publish schedule, hourly only where freshness needs it', () => {
  for (const i of manifest.insights) {
    assert.ok(['One', 'Six', 'Twelve', 'TwentyFour'].includes(i.publishScheduleInterval),
      `${i.apiName}: publishScheduleInterval`);
  }
  assert.equal(insight('Room_Device_Silence__cio').publishScheduleInterval, 'One');
  assert.notEqual(insight('Room_Out_Of_Range_Daily__cio').publishScheduleInterval, 'One');
});
