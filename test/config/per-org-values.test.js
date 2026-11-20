'use strict';

// A Salesforce deploy sets every field a metadata file names. A value that
// differs per org (a site URL, a host) must therefore stay out of force-app:
// committed there, one org's value lands in every other org and replaces
// whatever an admin typed in Setup. These tests fail the checks when one
// comes back.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const metadata = path.join(root, 'force-app/main/default');

// Field names of a custom metadata record, read from its <field> elements
// (comments are dropped first, so a note that mentions a field does not count).
function namedFields(file) {
  const xml = fs.readFileSync(path.join(metadata, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return [...xml.matchAll(/<field>([^<]+)<\/field>/g)].map((m) => m[1]);
}

test('the portal setting record leaves the per-org chat URLs to the org', () => {
  const fields = namedFields('customMetadata/Patient_Portal_Setting.Default.md-meta.xml');
  for (const perOrg of ['Chat_Site_Url__c', 'Scrt_Url__c']) {
    assert.ok(!fields.includes(perOrg),
      `${perOrg} is typed once in Setup (docs/INSTALL.md, step 10); naming it here would reset it on every deploy`);
  }
  // The settings that are the same in every org still ship.
  assert.ok(fields.includes('Deployment_Name__c'));
});

test('no custom metadata record carries an org-specific Salesforce host', () => {
  const dir = path.join(metadata, 'customMetadata');
  for (const file of fs.readdirSync(dir)) {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(xml, /https?:\/\/[\w.-]+\.(my\.site\.com|my\.salesforce\.com|my\.salesforce-scrt\.com|lightning\.force\.com)/,
      `${file} holds one org's URL`);
  }
});
