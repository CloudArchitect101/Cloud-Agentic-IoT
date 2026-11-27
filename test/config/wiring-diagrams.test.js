'use strict';

// Nov 20: Vitaly asked for wiring diagrams that look like the real board and
// parts, with every wire visibly ending on its pin. scripts/draw-wiring.js
// draws them; these checks keep the drawings, the firmware and the docs in step.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const draw = require(path.join(root, 'scripts/draw-wiring.js'));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const define = (src, name) => Number((src.match(new RegExp(`#define\\s+${name}\\s+(\\d+)`)) || [])[1]);
const pinName = ([row, i]) => (row === 'L' ? draw.LEFT_ROW : draw.RIGHT_ROW)[i];

test('the committed SVGs are what scripts/draw-wiring.js draws', () => {
  for (const [rel, fn] of Object.entries(draw.OUTPUTS)) {
    assert.equal(read(rel), fn(), `${rel} is out of date: run node scripts/draw-wiring.js`);
  }
});

test('the board has 38 pins in DevKitC order, 3.3V and 5V at the ends of one row', () => {
  assert.equal(draw.LEFT_ROW.length + draw.RIGHT_ROW.length, 38);
  assert.equal(draw.RIGHT_ROW[0], '3.3V');
  assert.equal(draw.RIGHT_ROW[18], '5V');
  assert.equal(draw.LEFT_ROW[0], 'GND');
  assert.equal(draw.LEFT_ROW[18], 'CLK');
});

test('the sensor and servo pins match the sketch', () => {
  const monitor = read('firmware/patient-monitor/patient-monitor.ino');
  assert.equal(pinName(draw.WIRES.dhtData.pin), `P${define(monitor, 'DHT_PIN')}`);
  assert.equal(pinName(draw.WIRES.servoSig.pin), `P${define(monitor, 'SERVO_PIN')}`);
});

test('each wire lands on the pin its label names, and no two share a pin', () => {
  const seen = new Set();
  for (const [id, w] of Object.entries(draw.WIRES)) {
    assert.equal(pinName(w.pin), w.to, id);
    const key = w.pin.join(':');
    assert.ok(!seen.has(key), `${id} shares a pin`);
    seen.add(key);
  }
  assert.equal(draw.WIRES.dhtVcc.to, '3.3V', 'the DHT11 runs on 3.3V, never 5V');
  assert.equal(draw.WIRES.servoVcc.to, '5V');
});

test('each drawing has every wire and plug it needs, and the resistor', () => {
  const mon = draw.monitoredDevice();
  for (const id of Object.keys(draw.WIRES)) {
    assert.match(mon, new RegExp(`data-wire="${id}"`));
    assert.match(mon, new RegExp(`data-plug="${id}"`));
  }
  assert.match(mon, /id="resistor-10k"/);
  const gauge = draw.corpGauge();
  for (const id of ['servoSig', 'servoVcc', 'servoGnd']) assert.match(gauge, new RegExp(`data-wire="${id}"`));
  assert.doesNotMatch(gauge, /data-wire="dht/);
});

test('the docs show the drawings, not the old PNGs', () => {
  for (const rel of ['docs/START-HERE.md', 'docs/INSTALL.md', 'docs/PATH-DEVICE.md', 'firmware/README.md', 'hardware/cases/README.md']) {
    const src = read(rel);
    assert.match(src, /wiring-monitored-device\.svg/, rel);
    assert.doesNotMatch(src, /wiring-monitored-device\.png|wiring-and-bell\.png/, rel);
  }
});
