'use strict';

// The Cloud Agentic IoT app's branding lives in metadata, so a deploy never
// undoes it: the "101" cloud logo, the #0B5CAB header colour, and the
// "Use the app's image and color instead of the org's custom theme" box.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = path.join(__dirname, '../../force-app/main/default');
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8');
const brand = read('applications/Cloud_Agentic_IoT.app-meta.xml').match(/<brand>([\s\S]*?)<\/brand>/)[1];
const tag = (xml, name) => (xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1];

test('the app uses its own image and colour instead of the org theme', () => {
  assert.equal(tag(brand, 'shouldOverrideOrgTheme'), 'true');
  assert.equal(tag(brand, 'headerColor'), '#0B5CAB');
});

test('the logo is the CloudAgenticIoTLogo ContentAsset at its latest version', () => {
  const name = tag(brand, 'logo');
  assert.equal(name, 'CloudAgenticIoTLogo');
  const assetMeta = read(`contentassets/${name}.asset-meta.xml`);
  const versions = [...assetMeta.matchAll(/<number>(\d+)<\/number>/g)].map(([, n]) => Number(n));
  assert.equal(Number(tag(brand, 'logoVersion')), Math.max(...versions));
});

test('the logo file is a square PNG no bigger than Salesforce allows', () => {
  const png = fs.readFileSync(path.join(base, 'contentassets/CloudAgenticIoTLogo.asset'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, height);
  assert.ok(width >= 128, 'big enough to stay sharp in the App Launcher');
  assert.ok(png.length < 5 * 1024 * 1024, 'App Manager images must be under 5 MB');
});
