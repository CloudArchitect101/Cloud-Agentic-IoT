'use strict';

// The patient portal (React) and the device live card (LWC) speak the same
// little MQTT. The portal keeps a copy, since a UI bundle cannot import an
// LWC module; this keeps the copy from drifting. device-live-mqtt.test.js
// tests the LWC file, so it tests both.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test("the portal's mqtt.js is the live card's, byte for byte", () => {
  assert.equal(
    read('force-app/main/default/uiBundles/patientPortal/src/features/live/mqtt.js'),
    read('force-app/main/default/lwc/deviceLiveCard/mqtt.js'),
    'Copy lwc/deviceLiveCard/mqtt.js over the portal\'s src/features/live/mqtt.js (and update mqtt.d.ts if an export changed).',
  );
});
