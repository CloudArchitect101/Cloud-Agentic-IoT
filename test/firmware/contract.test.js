'use strict';

// The firmware, the IoT rule, the device policy and the scripts each name the
// same few things: the rule readings go to, the topic it reads, the interval
// range a board accepts. Nothing at run time would say they drifted apart: a
// board publishing to a rule that does not exist loses every reading in
// silence, and one publishing where its policy does not allow is disconnected.
// So the build checks they agree.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const header = read('firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.h');
const timing = read('firmware/libraries/CloudAgenticDevice/src/DeviceTiming.h');
const vitalsTemplate = read('lambda/patient-vitals/cloudformation.yaml');
const relayTemplate = read('lambda/queue-relay/cloudformation.yaml');
const ota = read('scripts/ota.sh');

const rule = header.match(/#define TELEMETRY_RULE "([^"]+)"/)[1];

test('readings go to a rule that exists', () => {
  assert.equal(vitalsTemplate.match(/RuleName: (\S+)/)[1], rule);
});

test('the device policy lets each board publish readings through Basic Ingest, as itself only', () => {
  assert.ok(
    relayTemplate.includes(`topic/$aws/rules/${rule}/device/\${!iot:Connection.Thing.ThingName}/telemetry`),
    'device policy must allow $aws/rules/<rule>/device/<own thing>/telemetry',
  );
});

test('the rule reads the thing name from the topic in a way Basic Ingest keeps', () => {
  // AWS hides the $aws/rules/<rule> prefix from topic(), so topic(2) is the
  // Thing name for firmware on either path, and FROM still matches boards
  // that publish to device/<thing>/telemetry directly (older firmware).
  const sql = vitalsTemplate.match(/Sql: "([^"]+)"/)[1];
  assert.match(sql, /topic\(2\) AS thingName/);
  assert.match(sql, /FROM 'device\/\+\/telemetry'/);
});

test('the firmware publishes readings on the Basic Ingest topic', () => {
  const library = read('firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.cpp');
  assert.match(library, /"\$aws\/rules\/" TELEMETRY_RULE "\/device\/" \+ _thingName \+ "\/telemetry"/);
  assert.match(read('firmware/patient-monitor/patient-monitor.ino'), /device\.publishTelemetry\(/);
});

test('ota.sh interval offers exactly the range the firmware accepts', () => {
  const bound = (text, pattern) => Number(text.match(pattern)[1]);
  assert.equal(bound(ota, /^MIN_TELEMETRY_SECONDS=(\d+)$/m), bound(timing, /MIN_TELEMETRY_SECONDS = (\d+);/));
  assert.equal(bound(ota, /^MAX_TELEMETRY_SECONDS=(\d+)$/m), bound(timing, /MAX_TELEMETRY_SECONDS = (\d+);/));
});

test('each environment sets an interval the firmware accepts', () => {
  const min = Number(timing.match(/MIN_TELEMETRY_SECONDS = (\d+);/)[1]);
  const max = Number(timing.match(/MAX_TELEMETRY_SECONDS = (\d+);/)[1]);
  for (const env of ['Dev', 'Prod']) {
    const config = JSON.parse(read(`config/${env}.json`));
    for (const [sketch, settings] of Object.entries(config.devices || {})) {
      assert.ok(fs.existsSync(path.join(root, 'firmware', sketch, `${sketch}.ino`)), `${env}: no sketch named ${sketch}`);
      const seconds = settings.telemetrySeconds;
      assert.ok(Number.isInteger(seconds) && seconds >= min && seconds <= max, `${env}: ${sketch} telemetrySeconds ${seconds}`);
    }
  }
});

// Live mode. The board, the device-live API, its template and each
// environment's config all hold the live interval and window limits. A value
// the board refuses only prints "live: refused" on its serial console, and the
// card waits for readings that never come.
const liveLambda = read('lambda/device-live/index.js');
const presenceLambda = read('lambda/device-presence/index.js');
const timingBound = (name) => Number(timing.match(new RegExp(`const uint32_t ${name} = (\\d+);`))[1]);
const parameter = (template, name) => {
  const block = template.match(new RegExp(`\\n  ${name}:\\n((?: {4}.*\\n)+)`))[1];
  const number = (key) => Number(block.match(new RegExp(`${key}: (\\d+)`))[1]);
  return { min: number('MinValue'), max: number('MaxValue'), byDefault: number('Default') };
};

test('live mode: the API, its template and each environment stay inside what the board accepts', () => {
  const minSeconds = timingBound('MIN_LIVE_SECONDS');
  const maxSeconds = timingBound('MAX_LIVE_SECONDS');
  const maxMinutes = timingBound('MAX_LIVE_MINUTES');
  assert.equal(Number(liveLambda.match(/const MAX_LIVE_SECONDS = (\d+);/)[1]), maxSeconds);
  assert.equal(Number(liveLambda.match(/const MAX_LIVE_MINUTES = (\d+);/)[1]), maxMinutes);

  const seconds = parameter(relayTemplate, 'LiveReadingSeconds');
  const minutes = parameter(relayTemplate, 'LiveMinutes');
  assert.ok(seconds.min >= minSeconds && seconds.max <= maxSeconds, `LiveReadingSeconds ${seconds.min}-${seconds.max}`);
  // 0 minutes means "off" to the board, so the API must never send it.
  assert.ok(minutes.min >= 1 && minutes.max <= maxMinutes, `LiveMinutes ${minutes.min}-${minutes.max}`);

  for (const env of ['Dev', 'Prod']) {
    const relay = JSON.parse(read(`config/${env}.json`)).stacks['queue-relay'];
    for (const [name, bounds] of [['LiveReadingSeconds', seconds], ['LiveMinutes', minutes]]) {
      const value = relay[name] === undefined ? bounds.byDefault : relay[name];
      assert.ok(Number.isInteger(value) && value >= bounds.min && value <= bounds.max, `${env}: ${name} ${value}`);
    }
  }
});

test('live readings go where the device policy lets the board publish and the card listens', () => {
  const library = read('firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.cpp');
  assert.match(library, /publishTo\("device\/" \+ _thingName \+ "\/live", doc\)/);
  assert.ok(relayTemplate.includes('topic/device/${!iot:Connection.Thing.ThingName}/live'),
    'device policy must allow device/<own thing>/live');
  assert.ok(liveLambda.includes('topic: `device/${thingName}/live`'), 'the card must be told the same topic');
  // The LIVE command the API sends is the one the library listens for.
  assert.match(library, /strcmp\(doc\["operation"\] \| "", "LIVE"\) == 0/);
  assert.match(liveLambda, /operation: 'LIVE'/);
});

test('presence leaves out the browsers that watch live readings', () => {
  // A viewer connects to AWS IoT too. Counted as a board, it would turn the
  // Asset Online whenever someone opened the card.
  const rule = vitalsTemplate.match(/RuleName: cloud_agentic_iot_device_presence\n[\s\S]*?Sql: "([^"]+)"/);
  assert.ok(rule, 'patient-vitals template must declare the cloud_agentic_iot_device_presence rule');
  assert.match(rule[1], /WHERE NOT startswith\(clientId, 'live-'\)/);
  assert.match(liveLambda, /return `live-\$\{/);
  assert.match(presenceLambda, /clientId\.startsWith\('live-'\)/);
});
