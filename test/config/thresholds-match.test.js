'use strict';

// The clinical bands live twice, once per platform: config/vital-thresholds.json
// for the AWS side (copied to SSM by scripts/deploy-aws.sh) and the
// Vital_Sign_Threshold__mdt records plus the score fields of
// Device_Platform_Setting__mdt.Default for Salesforce. Each side scores
// readings on its own, so a change made on one side only would make AWS and
// Salesforce disagree about which patient is critical. This fails the checks
// instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const metadataDir = path.join(root, 'force-app/main/default/customMetadata');
const thresholds = JSON.parse(fs.readFileSync(path.join(root, 'config/vital-thresholds.json'), 'utf8'));

/** A Custom Metadata record's field values; xsi:nil fields come back as null. */
function record(file) {
  const xml = fs.readFileSync(path.join(metadataDir, file), 'utf8');
  const values = {};
  for (const [, field, body] of xml.matchAll(/<field>([^<]+)<\/field>\s*(<value[^>]*\/>|<value[^>]*>[^<]*<\/value>)/g)) {
    if (/xsi:nil="true"/.test(body)) {
      values[field] = null;
      continue;
    }
    const [, type, text] = body.match(/xsi:type="xsd:(\w+)">([^<]*)</);
    values[field] = type === 'double' || type === 'int' ? Number(text) : type === 'boolean' ? text === 'true' : text;
  }
  return values;
}

const salesforce = fs.readdirSync(metadataDir)
  .filter((file) => file.startsWith('Vital_Sign_Threshold.'))
  .map(record)
  .filter((values) => values.Active__c);

test('both platforms score the same vitals', () => {
  assert.deepEqual(
    salesforce.map((values) => values.Payload_Field__c).sort(),
    thresholds.vitals.map((vital) => vital.field).sort(),
  );
});

for (const vital of thresholds.vitals) {
  test(`${vital.field}: the same limits and points on both platforms`, () => {
    const values = salesforce.find((candidate) => candidate.Payload_Field__c === vital.field);
    const limit = (band, side) => (vital[band][side] === undefined ? null : vital[band][side]);
    assert.deepEqual(
      {
        unit: values.Unit__c,
        criticalBelow: values.Critical_Below__c ?? null,
        criticalAbove: values.Critical_Above__c ?? null,
        criticalPoints: values.Critical_Points__c,
        warningBelow: values.Warning_Below__c ?? null,
        warningAbove: values.Warning_Above__c ?? null,
        warningPoints: values.Warning_Points__c,
      },
      {
        unit: vital.unit,
        criticalBelow: limit('critical', 'below'),
        criticalAbove: limit('critical', 'above'),
        criticalPoints: vital.critical.points,
        warningBelow: limit('warning', 'below'),
        warningAbove: limit('warning', 'above'),
        warningPoints: vital.warning.points,
      },
    );
  });
}

test('both platforms turn a score into a state at the same points', () => {
  const settings = record('Device_Platform_Setting.Default.md-meta.xml');
  assert.deepEqual(
    { critical: settings.Critical_Score__c, atRisk: settings.At_Risk_Score__c, max: settings.Max_Risk_Score__c },
    { critical: thresholds.states.CRITICAL, atRisk: thresholds.states.AT_RISK, max: thresholds.maxScore },
  );
});
