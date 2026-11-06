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
const { loadWithFakes, fakeAwsSdk, fakeSsm } = require('../helpers/fakes');

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

// Device commands (firmware 2.2.0). A command from Salesforce carries its
// record's Id as commandId, and the board answers it on device/<thing>/ack;
// the record shows Acked or Failed only once that answer reaches it. Nothing
// at run time says the pieces drifted apart: an answer the device policy does
// not allow disconnects the board, one no rule reads is lost, and a commandId
// one side takes and another drops leaves its record Sent for good.
const commands = read('firmware/libraries/CloudAgenticDevice/src/DeviceCommands.h');

// The resources of the device policy's Publish statement, comments and all.
function devicePublishList() {
  const policy = relayTemplate.match(/\n  DevicePolicy:\n((?: {4,}.*\n|\s*\n)+)/);
  assert.ok(policy, 'queue-relay template must declare DevicePolicy');
  const publish = policy[1].match(/Action: iot:Publish\n +Resource:\n((?: {14,}.*\n)+)/);
  assert.ok(publish, 'DevicePolicy must have a statement for iot:Publish');
  return publish[1];
}

// What a Lambda exports as COMMAND_ID, the RegExp a commandId must match there.
function commandIdRule(file) {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} does not exist`);
  const exported = loadWithFakes(path.join(root, file), {
    '@aws-sdk/client-iot-data-plane': fakeAwsSdk('IoTDataPlaneClient', ['PublishCommand']).sdk,
    '@aws-sdk/client-ssm': fakeSsm().sdk,
    jsonwebtoken: { sign: () => 'signed-assertion' },
  });
  assert.ok(exported.COMMAND_ID instanceof RegExp, `${file} must export COMMAND_ID, the RegExp a commandId must match`);
  // Without g or y, test() keeps no state from one call to the next.
  return new RegExp(exported.COMMAND_ID.source, exported.COMMAND_ID.flags.replace(/[gy]/g, ''));
}

test('answers go where the device policy lets each board publish, as itself only', () => {
  const library = read('firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.cpp');
  assert.match(library, /publishTo\("device\/" \+ _thingName \+ "\/ack", answer\)/);
  assert.ok(devicePublishList().includes('topic/device/${!iot:Connection.Thing.ThingName}/ack'),
    'device policy must allow publishing to device/<own thing>/ack');
});

test('the answer rule reads every answer, and every field the board puts in one', () => {
  const rule = vitalsTemplate.match(/RuleName: cloud_agentic_iot_device_command_ack\n[\s\S]*?Sql: "([^"]+)"/);
  assert.ok(rule, 'patient-vitals template must declare the cloud_agentic_iot_device_command_ack rule');
  const sql = rule[1];
  assert.match(sql, /FROM 'device\/\+\/ack'$/);
  assert.match(sql, /topic\(2\) AS thingName/);

  // A field the board sends that the rule does not select never reaches
  // Salesforce, and one the rule selects that the board never sends is
  // always empty. Neither says so, so the two lists must be the same.
  const selected = sql.match(/^SELECT (.+) FROM /)[1].split(',').map((field) => field.trim())
    .filter((field) => /^\w+$/.test(field));
  const library = read('firmware/libraries/CloudAgenticDevice/src/CloudAgenticDevice.cpp');
  const sent = [...new Set([...library.matchAll(/answer\["(\w+)"\]/g)].map((match) => match[1]))];
  assert.deepEqual(sent.sort(), selected.sort());
  assert.deepEqual(selected.sort(), ['commandId', 'detail', 'operation', 'outcome']);
});

test('a commandId the board answers is one both command Lambdas take, and no other', () => {
  const maxLength = Number(commands.match(/const size_t MAX_COMMAND_ID_LENGTH = (\d+);/)[1]);
  const characters = commands.match(/const char COMMAND_ID_CHARACTERS\[\] =\s*"([^"]+)";/)[1];
  for (const file of ['lambda/device-command/index.js', 'lambda/device-command-ack/index.js']) {
    const rule = commandIdRule(file);
    for (let code = 1; code < 0x180; code++) {
      const character = String.fromCharCode(code);
      assert.equal(rule.test(character), characters.includes(character),
        `${file}: COMMAND_ID and DeviceCommands.h disagree on ${JSON.stringify(character)}`);
    }
    assert.ok(rule.test('a'.repeat(maxLength)), `${file}: COMMAND_ID must take ${maxLength} characters, as the board does`);
    assert.ok(!rule.test('a'.repeat(maxLength + 1)), `${file}: COMMAND_ID must refuse ${maxLength + 1} characters, as the board does`);
    assert.ok(!rule.test(''), `${file}: COMMAND_ID must refuse an empty commandId`);
    assert.ok(!rule.test('a0Bbm00000AbCdEFGH/x') && !rule.test('a0Bbm00000AbCdEFGH\n'),
      `${file}: COMMAND_ID must match the whole commandId, not part of it`);
    // What Salesforce sends: a Device Command record's 18-character Id.
    assert.ok(rule.test('a0Bbm00000AbCdEFGH'), `${file}: COMMAND_ID must take a Salesforce record Id`);
  }
});
