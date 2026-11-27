'use strict';

// One current version of everything. Someone who clones this repo to build
// it on their side must find exactly one sketch per device type, one script
// per agent and one model per case part, never an older copy next to the
// current one that they could build, flash, print or deploy by mistake.
// Older versions live in Git history, which is where they belong.
//
// These checks fail when a second version appears:
//   1. A tracked file or folder named like an old copy (v2, old, legacy,
//      backup, copy, retired, spare, earlier...).
//   2. Old-builder agent metadata (Bot, GenAiPlanner, GenAiPlugin) in
//      force-app: agents are Agent Script bundles only.
//   3. An agent bundle holding more than one .agent file, or two bundles
//      that build the same agent.
//   4. A firmware sketch folder holding more than one .ino, or a sketch
//      that defines its FIRMWARE_VERSION more than once.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '../..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && fs.existsSync(path.join(root, f)));

// A path segment that reads like an older or duplicate copy.
const OLD_COPY = /(?:^|[-_. ])(v\d+|old|legacy|deprecated|archived?|backup|bak|orig|copy|retired|superseded|spare|earlier|previous|unused)(?:[-_. ]|$)/i;

// Names that match the pattern but are not old copies. Add one only with
// the reason next to it.
const NOT_OLD_COPIES = new Set([
  // A reading's previous alert state, a live field.
  'force-app/main/default/objects/Patient_Vitals__c/fields/Previous_State__c.field-meta.xml',
  // The portal's "copy to clipboard" icon.
  'force-app/main/default/uiBundles/patientPortal/src/assets/icons/copy.svg',
]);

test('no tracked file or folder is named like an older or duplicate copy', () => {
  const found = tracked.filter((f) => !f.startsWith('test/') && !NOT_OLD_COPIES.has(f)
    && f.split('/').some((seg) => OLD_COPY.test(seg)));
  assert.deepEqual(found, [], 'Keep only the current version; the old one stays in Git history');
});

test('agents are Agent Script bundles only, with no old-builder metadata', () => {
  const legacy = tracked.filter((f) => /^force-app\/main\/default\/(bots|genAiPlannerBundles|genAiPlanners|genAiPlugins)\//.test(f));
  assert.deepEqual(legacy, [], 'Old-builder Bot/GenAiPlanner/GenAiPlugin metadata; agents live in aiAuthoringBundles/');
});

test('each agent has exactly one script, and no two bundles build the same agent', () => {
  const dir = path.join(root, 'force-app/main/default/aiAuthoringBundles');
  const bundles = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  assert.ok(bundles.length > 0, 'expected at least one agent bundle');
  const names = new Map();
  for (const bundle of bundles) {
    const scripts = fs.readdirSync(path.join(dir, bundle)).filter((f) => f.endsWith('.agent'));
    assert.deepEqual(scripts, [`${bundle}.agent`], `${bundle} must hold exactly ${bundle}.agent`);
    const text = fs.readFileSync(path.join(dir, bundle, scripts[0]), 'utf8');
    const devName = (text.match(/^\s*developer_name:\s*"([^"]+)"/m) || [])[1];
    assert.equal(devName, bundle, `${bundle}.agent's developer_name must be ${bundle}`);
    const label = (text.match(/^\s*agent_label:\s*"([^"]+)"/m) || [])[1];
    if (label) {
      assert.ok(!names.has(label), `${bundle} and ${names.get(label)} both build "${label}"`);
      names.set(label, bundle);
    }
  }
});

test('each firmware sketch has one .ino and one FIRMWARE_VERSION', () => {
  const dir = path.join(root, 'firmware');
  const sketches = fs.readdirSync(dir).filter((d) => d !== 'libraries' && fs.statSync(path.join(dir, d)).isDirectory());
  assert.ok(sketches.length > 0, 'expected at least one sketch');
  for (const sketch of sketches) {
    const inos = fs.readdirSync(path.join(dir, sketch)).filter((f) => f.endsWith('.ino'));
    assert.deepEqual(inos, [`${sketch}.ino`], `firmware/${sketch} must hold exactly ${sketch}.ino`);
    const text = fs.readFileSync(path.join(dir, sketch, inos[0]), 'utf8');
    const versions = text.match(/^#define FIRMWARE_VERSION\s+"[^"]+"/gm) || [];
    assert.equal(versions.length, 1, `firmware/${sketch} must define FIRMWARE_VERSION once`);
  }
});
