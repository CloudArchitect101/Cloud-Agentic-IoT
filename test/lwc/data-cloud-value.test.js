'use strict';

/*
 * The Data Cloud value card on the Cloud Agentic IoT app's Home page
 * (force-app/main/default/lwc/dataCloudValueCard).
 *
 * value.js holds everything the card works out: the trend bars, the 7-day
 * totals, each monitored device's status, and Data Cloud's cost against the
 * manual checks it replaces. Like usage.js it has no imports, so Node loads
 * the bytes the card ships. The last tests pin the card's metadata: on this
 * app's Home page, cached for 10 minutes, and reading only the two insights
 * datacloud/calculated-insights.json defines.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const app = (file) => fs.readFileSync(path.join(root, 'force-app/main/default', file), 'utf8');
const manifest = require('../../datacloud/calculated-insights.json');

let value;
before(async () => {
  value = await import(`data:text/javascript,${encodeURIComponent(app('lwc/dataCloudValueCard/value.js'))}`);
});

const NOW = Date.parse('2026-11-19T20:30:00Z');
const EN = ['en-US', 'UTC'];
const ASSUMPTIONS = {
  manualCheckMinutes: 3, manualChecksPerDeviceDay: 12, baselineMinutesToRespond: 60,
  staffHourlyRate: 55, dataCloudCreditsPerMonth: 2000, dataCloudPricePerCredit: 0.005
};
const answer = () => ({
  asOf: '2026-11-19T20:30:00.000Z',
  outOfRange: {
    error: null,
    rows: [
      { device_id__c: 'PatientExternalESP32', reading_day__c: '2026-11-19T00:00:00.000Z', readings_out_of_range__c: 40, minutes_out_of_range__c: 20, max_temperature_c__c: 34.5 },
      { device_id__c: 'CompanyInternalESP32', reading_day__c: '2026-11-18T00:00:00.000Z', readings_out_of_range__c: 10, minutes_out_of_range__c: 5, max_temperature_c__c: 31 },
      // Outside the 7-day window, inside the 14-day trend.
      { device_id__c: 'PatientExternalESP32', reading_day__c: '2026-11-10T00:00:00.000Z', readings_out_of_range__c: 100, minutes_out_of_range__c: 50, max_temperature_c__c: 40 },
      // Outside both.
      { device_id__c: 'PatientExternalESP32', reading_day__c: '2026-10-01T00:00:00.000Z', readings_out_of_range__c: 9, minutes_out_of_range__c: 999, max_temperature_c__c: 50 }
    ]
  },
  silence: {
    error: null,
    rows: [
      { device_id__c: 'PatientExternalESP32', last_reading_ts__c: '2026-11-19T20:05:00.000Z', readings__c: 1200 },
      { device_id__c: 'CompanyInternalESP32', last_reading_ts__c: '2026-11-19T16:00:00.000Z', readings__c: 300 }
    ]
  },
  assumptions: ASSUMPTIONS
});

test('the trend is 14 days to today, minutes summed over devices, bars scaled to the highest day', () => {
  const trend = value.trendOf(answer().outOfRange.rows, NOW);
  assert.equal(trend.length, value.TREND_DAYS);
  assert.equal(trend[0].day, '2026-11-06');
  assert.equal(trend.at(-1).day, '2026-11-19');
  const byDay = Object.fromEntries(trend.map((b) => [b.day, b]));
  assert.equal(byDay['2026-11-10'].minutes, 50);
  assert.equal(byDay['2026-11-10'].style, 'height: 100%');
  assert.equal(byDay['2026-11-19'].style, 'height: 40%');
  assert.equal(byDay['2026-11-12'].style, 'height: 0%');
  assert.ok(!trend.some((b) => b.minutes === 999), 'a day before the trend is left out');
});

test('the 7-day totals count only the last 7 days', () => {
  const w = value.windowOf(answer().outOfRange.rows, NOW);
  assert.equal(w.minutes, 25);
  assert.equal(w.readings, 50);
  assert.equal(w.highest, 34.5);
  assert.deepEqual(w.perDevice.get('PatientExternalESP32'), { minutes: 20, highest: 34.5 });
});

test('a device is silent when its last reading in Data Cloud is over 2 hours old, and silent ones come first', () => {
  const w = value.windowOf(answer().outOfRange.rows, NOW);
  const devices = value.devicesOf(answer().silence.rows, w.perDevice, NOW, ...EN);
  assert.deepEqual(devices.map((d) => [d.id, d.status]), [['CompanyInternalESP32', 'Silent'], ['PatientExternalESP32', 'Reporting']]);
  assert.equal(devices[1].ago, '25 min ago');
  assert.equal(devices[0].ago, '4 h 30 min ago');
  assert.equal(devices[1].highest, '34.5 °C');
  assert.equal(value.SILENT_AFTER_MINUTES, 120);
});

test('a device whose last reading cannot be read counts as silent, not reporting', () => {
  const devices = value.devicesOf([{ device_id__c: 'X', last_reading_ts__c: null }], new Map(), NOW, ...EN);
  assert.equal(devices[0].status, 'Silent');
  assert.equal(devices[0].lastReading, 'Unknown');
});

test('return on Data Cloud: manual checks replaced a month against credits x price', () => {
  // 2 devices x 12 checks x 3 min x 30 days = 36 h; 36 x 55 = 1980. 2000 x 0.005 = 10.
  assert.deepEqual(value.roiOf(2, ASSUMPTIONS), { hours: 36, value: 1980, cost: 10, net: 1970, multiple: 198 });
  assert.equal(value.roiOf(2, { ...ASSUMPTIONS, dataCloudCreditsPerMonth: null }).multiple, null, 'no cost, no multiple');
  assert.equal(value.roiOf(0, ASSUMPTIONS).value, 0);
});

test('the view: six tiles, the errors per insight, and the no-data note when both are empty', () => {
  const view = value.viewOf(answer(), NOW, ...EN);
  assert.deepEqual(view.tiles.map((t) => t.key), ['minutes', 'highest', 'devices', 'value', 'cost', 'roi']);
  assert.equal(view.tiles.find((t) => t.key === 'roi').value, '198x');
  assert.equal(view.tiles.find((t) => t.key === 'devices').hint, '1 silent for over 2 h');
  assert.equal(view.hasData, true);

  const empty = value.viewOf({ outOfRange: { rows: [], error: 'X' }, silence: { rows: [], error: null }, assumptions: ASSUMPTIONS }, NOW, ...EN);
  assert.equal(empty.hasData, false);
  assert.equal(empty.outOfRangeError, 'X');
  assert.equal(empty.silenceError, null);
});

test('a cached answer is used for 10 minutes and no longer', () => {
  assert.equal(value.isFresh(NOW - 9 * 60000, NOW), true);
  assert.equal(value.isFresh(NOW - 10 * 60000, NOW), false);
  assert.equal(value.isFresh(NOW + 60000, NOW), false, 'a time in the future is not trusted');
  assert.equal(value.isFresh(undefined, NOW), false);
});

test('labels are generic: no patient or room wording on the card', () => {
  const text = app('lwc/dataCloudValueCard/dataCloudValueCard.html') + app('lwc/dataCloudValueCard/value.js');
  assert.doesNotMatch(text, /patient|fever|medication|dose/i);
});

test('the Apex reads exactly the insights the manifest defines, with a bounded query each', () => {
  const apex = app('classes/DataCloudValueController.cls');
  for (const insight of manifest.insights) assert.ok(apex.includes(`'${insight.apiName}'`), insight.apiName);
  assert.match(apex, /' LIMIT ' \+ MAX_ROWS/);
  assert.match(apex, /public with sharing class/);
});

test("the card is on this app's Home page, and Business Value Viewer may run its Apex", () => {
  const home = app('flexipages/Cloud_Agentic_IoT_Home.flexipage-meta.xml');
  assert.match(home, /<componentName>dataCloudValueCard<\/componentName>/);
  assert.ok(home.indexOf('businessValueDashboard') < home.indexOf('dataCloudValueCard'), 'under the dashboard');
  const viewer = app('permissionsets/Business_Value_Viewer.permissionset-meta.xml');
  assert.match(viewer, /<apexClass>DataCloudValueController<\/apexClass>\s*<enabled>true<\/enabled>/);
  const js = app('lwc/dataCloudValueCard/dataCloudValueCard.js');
  assert.match(js, /sessionStorage/);
  assert.doesNotMatch(js, /setInterval|setTimeout/, 'never polls');
});

test('the Default assumptions price Data Cloud', () => {
  const mdt = app('customMetadata/Value_Assumption.Default.md-meta.xml');
  assert.match(mdt, /<field>Data_Cloud_Credits_Per_Month__c<\/field>\s*<value xsi:type="xsd:double">\d+<\/value>/);
  assert.match(mdt, /<field>Data_Cloud_Price_Per_Credit__c<\/field>\s*<value xsi:type="xsd:double">[\d.]+<\/value>/);
});
