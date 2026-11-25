'use strict';

// bootstrap/ holds one-time setup with placeholder values: an admin applies
// it once (scripts/bootstrap-salesforce.sh) and then types the real values in
// Setup. A deploy sets every value a file names, so if the pipeline ever
// deployed these files it would put the placeholders back over a working
// org's role ARN and URL, and every Salesforce -> AWS call would fail. These
// tests keep bootstrap/ out of everything the pipeline deploys, and keep real
// values and secrets out of bootstrap/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const noComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');
const SRC = 'bootstrap/salesforce';
const EXTERNAL = `${SRC}/externalCredentials/AWS_IoT_Relay.externalCredential-meta.xml`;
const NAMED = `${SRC}/namedCredentials/AWS_IoT_Relay.namedCredential-meta.xml`;
const CALLERS = `${SRC}/permissionsets/AWS_IoT_Relay_Callers.permissionset-meta.xml`;

function walk(dir) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

test('bootstrap/ is not a package directory, so no sf deploy of the project includes it', () => {
  const project = JSON.parse(read('sfdx-project.json'));
  for (const dir of project.packageDirectories) {
    const p = path.normalize(dir.path);
    assert.ok(p !== '.' && !p.startsWith('bootstrap') && !'bootstrap'.startsWith(p),
      `package directory "${dir.path}" would make the pipeline deploy bootstrap/`);
  }
});

test('nothing the pipeline runs mentions bootstrap/salesforce or its script', () => {
  const pipeline = [
    ...walk('.github/workflows'),
    'scripts/deploy-salesforce.sh',
    'scripts/deploy-aws.sh',
    'scripts/seed-ssm.sh',
    'scripts/index-sops.sh',
    'scripts/ota.sh',
    'scripts/lib/common.sh',
  ];
  for (const file of pipeline) {
    // Comments may explain the rule; commands may not break it.
    const code = read(file).split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    assert.doesNotMatch(code, /bootstrap\/salesforce|bootstrap-salesforce/,
      `${file} must not deploy the one-time setup`);
  }
});

test('the one-time script refuses to run in the pipeline, before it asks the org anything', () => {
  const script = read('scripts/bootstrap-salesforce.sh');
  const refusal = script.indexOf('in_ci && die');
  assert.ok(refusal > 0, 'no in_ci refusal');
  assert.ok(refusal < script.indexOf('sf data query'), 'the refusal comes after the first org call');
  assert.ok(refusal < script.indexOf('sf project deploy'), 'the refusal comes after the deploy');
});

test('the credential pieces live in bootstrap/ only, never in force-app/ or the manifests', () => {
  const metadata = walk('force-app');
  assert.deepEqual(metadata.filter((f) => /\/(externalCredentials|namedCredentials)\//.test(f)), [],
    'a credential in force-app/ is redeployed, placeholders and all, on every merge');
  assert.deepEqual(metadata.filter((f) => f.includes('AWS_IoT_Relay_Callers.permissionset')), [],
    'AWS_IoT_Relay_Callers in force-app/ would be replaced whole on every deploy');
  for (const file of walk('manifest')) {
    assert.doesNotMatch(noComments(read(file)), /AWS_IoT_Relay(_Callers)?<|<name>(ExternalCredential|NamedCredential)</,
      `${file} would deploy or delete the credential`);
  }
});

test('the files hold the placeholders the script replaces, and nothing real', () => {
  const script = read('scripts/bootstrap-salesforce.sh');
  const dummy = (name) => script.match(new RegExp(`^${name}='([^']+)'`, 'm'))[1];
  const external = noComments(read(EXTERNAL));
  const named = noComments(read(NAMED));
  assert.ok(external.includes(`>${dummy('DUMMY_REGION')}<`), 'Region placeholder');
  assert.ok(named.includes(`>${dummy('DUMMY_URL')}<`), 'URL placeholder');

  for (const file of walk(SRC)) {
    const text = read(file);
    // An access key ID, a real account in an ARN, a real API host.
    assert.doesNotMatch(text, /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, `${file} holds an access key ID`);
    for (const [, account] of text.matchAll(/arn:aws[a-z-]*:iam::(\d{12}):/g)) {
      assert.equal(account, '000000000000', `${file} names a real AWS account`);
    }
    assert.doesNotMatch(text, /[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com/, `${file} holds a real API host`);
  }
});

test('the access key and its secret are never in the files: a person types them in Setup', () => {
  const external = noComments(read(EXTERNAL));
  // The STS switch may ship; a value for the key or the secret may not.
  for (const [, name, value] of external.matchAll(
    /<parameterName>([^<]*)<\/parameterName>[\s\S]*?<parameterValue>([^<]*)<\/parameterValue>/g)) {
    if (/Key|Secret|Password/i.test(name)) {
      assert.fail(`${name} carries a value (${value.length} characters); leave it to Setup`);
    }
  }
  // Nor an ARN: the role's is a stored credential of the principal, typed in Setup.
  assert.doesNotMatch(external, /arn:aws/);
  assert.doesNotMatch(read('scripts/bootstrap-salesforce.sh'), /--(access-key|secret)\b/,
    'the script takes no secret as an option');
});

test('the permission set grants the principal the external credential defines, and nothing else', () => {
  const external = noComments(read(EXTERNAL));
  const callers = noComments(read(CALLERS));
  const principal = external.match(
    /<parameterGroup>([^<]+)<\/parameterGroup>\s*<parameterName>[^<]+<\/parameterName>\s*<parameterType>NamedPrincipal<\/parameterType>/);
  assert.ok(principal, 'the external credential has no named principal');
  const granted = [...callers.matchAll(/<externalCredentialPrincipal>([^<]+)<\/externalCredentialPrincipal>/g)].map((m) => m[1]);
  assert.deepEqual(granted, [`AWS_IoT_Relay-${principal[1]}`]);
  // Read on User External Credentials is not here: the Customer Community
  // licence refuses it, and portal patients hold this set (TROUBLESHOOTING).
  assert.doesNotMatch(callers, /<objectPermissions>|<userPermissions>|<classAccesses>/);
  // The named credential points at the external credential by its name.
  assert.match(noComments(read(NAMED)), />AWS_IoT_Relay</);
});

test('the name Apex calls matches the named credential in bootstrap/', () => {
  const setting = read('force-app/main/default/customMetadata/Device_Platform_Setting.Default.md-meta.xml');
  assert.match(setting, /<field>Named_Credential__c<\/field>\s*<value[^>]*>AWS_IoT_Relay<\/value>/);
  assert.ok(fs.existsSync(path.join(root, NAMED)));
});
