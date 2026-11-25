'use strict';

// Portal patients hold the hand-made AWS_IoT_Relay_Callers permission set, and
// their Customer Community licence refuses Read on User External Credentials
// ("The user license doesn't allow the permission: Read ExternalDataConnector").
// So that Read lives in repo sets for internal users only, and the docs must
// never tell an admin to put it in AWS_IoT_Relay_Callers (Nov 25).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sets = 'force-app/main/default/permissionsets';
const readsCredentials = (xml) => [...xml.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g)]
  .some(([, body]) => body.includes('<object>UserExternalCredential</object>') && /<allowRead>true<\/allowRead>/.test(body));

test('AWS_IoT_Relay_Credential_Reader grants Read on User External Credentials', () => {
  assert.ok(readsCredentials(read(`${sets}/AWS_IoT_Relay_Credential_Reader.permissionset-meta.xml`)));
});

test('sets for Customer Community users never grant that Read', () => {
  assert.ok(!readsCredentials(read(`${sets}/Patient_Portal_User.permissionset-meta.xml`)));
});

test('the install docs never put that Read in AWS_IoT_Relay_Callers', () => {
  for (const doc of ['docs/INSTALL.md', 'docs/INSTALL-GUIDE.md']) {
    const part = read(doc).match(/d\. Who may use it\.[\s\S]*?(?=\n\n)/)[0];
    assert.doesNotMatch(part, /Also give it \*\*Read\*\*|, and \*\*Read\*\* on \*\*User External Credentials\*\*/, doc);
    assert.match(part, /AWS_IoT_Relay_Credential_Reader/, doc);
  }
});

test('the deploy hands out the reader and strips the Read before assigning portal users', () => {
  const script = read('scripts/deploy-salesforce.sh');
  const giveReader = script.indexOf("Name = 'AWS_IoT_Relay_Credential_Reader'");
  const strip = script.indexOf('op.PermissionsRead = false');
  const portal = script.indexOf("PermissionSet.Name IN ('Patient_Portal_User', 'Patient_Portal_Agent')");
  assert.ok(giveReader > 0 && strip > giveReader && portal > strip, 'reader, then strip, then portal users');
});

// A set made in Setup stores the Read as ExternalDataConnector, metadata as
// UserExternalCredential: matching only one removed nothing (Nov 25).
test('the deploy strips the Read under both of its object names', () => {
  const script = read('scripts/deploy-salesforce.sh');
  assert.match(script, /SobjectType IN \('UserExternalCredential', 'ExternalDataConnector'\)/);
});
