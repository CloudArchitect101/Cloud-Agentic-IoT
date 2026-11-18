'use strict';

// Provisioning, re-provisioning and teardown run as DeviceLifecycleRole in
// lambda/queue-relay/cloudformation.yaml. Their unit tests fake the AWS SDK,
// so a call the role may not make passes them and fails only in AWS, halfway
// through setting up a device. On 2026-11-05 the first real provisioning
// stopped with:
//   .../cloud-agentic-iot-device-provisioning is not authorized to perform:
//   iot:AttachThingPrincipal on resource: arn:aws:iot:<region>:<account>:cert/<id>
// because the role allowed that action on thing/* only. These tests read the
// role's policy and check it against every AWS call those functions make.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const lines = (file) => read(file).split(/\r?\n/);

const TEMPLATE = 'lambda/queue-relay/cloudformation.yaml';

// The functions that run as the role. The tests read each one's index.js and
// every file of this repo it requires, directly or not: a call made from a
// helper runs as the role too.
const FUNCTIONS = ['device-provisioning', 'device-reprovision', 'device-teardown'];

/** The file and every file of this repo it requires, directly or through another. */
function sourcesOf(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const requires = read(file).matchAll(/require\((['"])(\.{1,2}\/[^'"]+|@cloud-agentic-iot\/shared\/[^'"]+)\1\)/g);
  for (const [, , spec] of requires) {
    const target = spec.startsWith('.')
      ? path.posix.join(path.posix.dirname(file), spec)
      : path.posix.join('lambda/shared', spec.slice('@cloud-agentic-iot/shared/'.length));
    if (!target.endsWith('.json')) sourcesOf(target.endsWith('.js') ? target : `${target}.js`, seen);
  }
  return seen;
}
const SOURCES = [...new Set(FUNCTIONS.flatMap((name) => [...sourcesOf(`lambda/${name}/index.js`)]))];

// The resource type AWS checks each IoT action against, from AWS's service
// reference for IoT, https://servicereference.us-east-1.amazonaws.com/v1/iot/iot.json
// (version v1.5, read 2026-11-05). An empty list means the action takes no
// resource, so only Resource '*' allows it. AttachThingPrincipal and
// DetachThingPrincipal are checked against the certificate; the Thing is only
// their iot:thingArn condition key. ListAttachedPolicies takes no resource,
// although the IoT Developer Guide lists cert for it.
const CHECKED_AGAINST = {
  CreateThing: ['thing'],         // and billinggroup, when a request names one
  DeleteThing: ['thing'],
  ListThingPrincipals: ['thing'],
  ListThingGroupsForThing: ['thing'],
  AddThingToThingGroup: ['thing', 'thinggroup'],
  RemoveThingFromThingGroup: ['thing', 'thinggroup'],
  AttachThingPrincipal: ['cert'],
  DetachThingPrincipal: ['cert'],
  AttachPolicy: ['cert'],         // and thinggroup, which these functions never target
  DetachPolicy: ['cert'],         // and thinggroup, likewise
  ListAttachedPolicies: [],
  UpdateCertificate: ['cert'],
  DeleteCertificate: ['cert'],
  CreateKeysAndCertificate: [],
  DescribeEndpoint: [],
};

// The S3 calls, which AWS checks against the object. The functions write each
// bundle under provisioning/ in the bundle bucket, and sign its download link
// for GetObject with the role's own credentials.
const S3_COMMANDS = new Set(['PutObject', 'GetObject']);
const BUNDLES = '${BundleBucket.Arn}/provisioning/*';

const arnPattern = (type) => 'arn:${AWS::Partition}:iot:${AWS::Region}:${AWS::AccountId}:' + type + '/*';

const indent = (line) => line.search(/\S/);
const isContent = (line) => line.trim() !== '' && !line.trim().startsWith('#');

/**
 * The statements of the role's ManageDeviceIdentities policy, read as text:
 * the repo has no YAML parser, and one would have to be taught !Sub anyway.
 * Statements are read in the shape the template writes them: "- Effect: Allow",
 * then an Action and a Resource, each one value on its line or a "- " list
 * under it, with comments on lines of their own. Anything else fails the test,
 * so it cannot pass on a statement it misread.
 */
function policyStatements() {
  const template = lines(TEMPLATE);
  const role = template.findIndex((line) => /^ {2}DeviceLifecycleRole:\s*(?:#.*)?$/.test(line));
  const start = template.findIndex((line, i) => i > role && line.trim() === '- PolicyName: ManageDeviceIdentities');
  assert.ok(role !== -1 && start !== -1 && !template.slice(role + 1, start).some((line) => /^ {2}\w+:/.test(line)),
    `${TEMPLATE} has no ManageDeviceIdentities policy on DeviceLifecycleRole`);

  const value = (text) => {
    const plain = text.replace(/^!Sub +/, '').replace(/^'(.*)'$/, '$1');
    // Another tag, a [flow list] or a stray quote is a shape this test doesn't read.
    assert.ok(/^[^!'"[{]/.test(plain) && !/['"]/.test(plain), `ManageDeviceIdentities has a value this test cannot read: ${text}`);
    return plain;
  };
  const statements = [];
  let key = null;
  let keyIndent = 0;
  for (const line of template.slice(start + 1)) {
    if (!isContent(line)) continue;
    if (indent(line) <= indent(template[start])) break;
    const text = line.trim();
    // A comment after a value would be read as part of it, and one after
    // "- Effect: Allow" would join that statement to the one before.
    assert.ok(!/\s#/.test(text), `ManageDeviceIdentities has a comment this test cannot read: ${text}`);
    if (['PolicyDocument:', "Version: '2012-10-17'", 'Statement:'].includes(text)) continue;
    const effect = text.match(/^- Effect: (\w+)$/);
    const field = text.match(/^(Action|Resource):(?: (.+))?$/);
    const item = text.match(/^- (.+)$/);
    if (effect) {
      assert.equal(effect[1], 'Allow', 'ManageDeviceIdentities has a statement that is not an Allow');
      statements.push({ Action: [], Resource: [] });
      key = null;
    } else if (field && statements.length) {
      [, key] = field;
      keyIndent = indent(line);
      if (field[2]) statements.at(-1)[key].push(value(field[2]));
    } else if (item && key && indent(line) >= keyIndent) {
      statements.at(-1)[key].push(value(item[1]));
    } else {
      assert.fail(`ManageDeviceIdentities has a line this test cannot read: ${text}`);
    }
  }
  assert.ok(statements.length, 'ManageDeviceIdentities has no statements');
  return statements;
}

/** Whether the policy allows the action on that resource, or on any resource. */
function allows(statements, action, resource) {
  const actionMatches = (pattern) => new RegExp(
    `^${pattern.split('*').map((part) => part.replace(/[.?+^$|()[\]{}\\]/g, '\\$&')).join('.*')}$`, 'i',
  ).test(action);
  return statements.some(({ Action, Resource }) => Action.some(actionMatches)
    && (Resource.includes('*') || Resource.includes(resource)));
}

/**
 * The AWS SDK commands the sources name, each with the files that name it.
 * Every name ending in Command counts, however it is used, so a command a
 * helper sends for the caller is not missed.
 */
function commands() {
  const found = new Map();
  for (const file of SOURCES) {
    for (const [, operation] of read(file).matchAll(/\b(\w+)Command\b/g)) {
      if (!found.has(operation)) found.set(operation, new Set());
      found.get(operation).add(file);
    }
  }
  return found;
}

test('the files these tests read are every function that runs as the lifecycle role', () => {
  const resources = [];
  for (const line of lines(TEMPLATE)) {
    if (/^ {2}\w+:\s*(?:#.*)?$/.test(line)) resources.push([]);
    else if (resources.length && (indent(line) > 2 || !isContent(line))) resources.at(-1).push(line);
  }
  // Any mention counts, however the role is written: !GetAtt, Fn::GetAtt or !Sub.
  const onRole = resources
    .filter((body) => body.some((line) => isContent(line) && /\bDeviceLifecycleRole\b/.test(line)))
    .map((body) => (body.join('\n').match(/FunctionName: cloud-agentic-iot-(\S+)/) || [])[1]);
  assert.deepEqual(onRole.sort(), [...FUNCTIONS].sort(),
    `functions on DeviceLifecycleRole in ${TEMPLATE}; add a new one to FUNCTIONS here`);
});

test('the lifecycle role may attach a certificate to a Thing, and detach it', () => {
  const statements = policyStatements();
  for (const action of ['iot:AttachThingPrincipal', 'iot:DetachThingPrincipal']) {
    assert.ok(allows(statements, action, arnPattern('cert')),
      `ManageDeviceIdentities must allow ${action} on ${arnPattern('cert')}: AWS checks it against the certificate, not the Thing`);
  }
});

test('every call the lifecycle functions make is allowed on what AWS checks it against', () => {
  const statements = policyStatements();
  const calls = commands();
  // The handlers call AttachThingPrincipal, and only lambda/shared/certificates.js,
  // which they require, calls DetachThingPrincipal. A scan that missed either
  // would let this test pass on nothing.
  assert.ok(calls.has('AttachThingPrincipal') && calls.has('DetachThingPrincipal'),
    `the scan found only ${[...calls.keys()].join(', ')}`);

  const missing = [];
  for (const [operation, files] of calls) {
    const where = [...files].join(', ');
    let needed;
    if (S3_COMMANDS.has(operation)) {
      needed = [[`s3:${operation}`, BUNDLES]];
    } else {
      assert.ok(Object.hasOwn(CHECKED_AGAINST, operation), `${where} uses ${operation}Command, which this test `
        + `doesn't know. Allow it in ManageDeviceIdentities and add it here: an IoT call to CHECKED_AGAINST, with `
        + `the resource types AWS's service reference gives it, or an S3 call to S3_COMMANDS.`);
      const types = CHECKED_AGAINST[operation];
      needed = types.length ? types.map((type) => [`iot:${operation}`, arnPattern(type)]) : [[`iot:${operation}`, '*']];
    }
    for (const [action, resource] of needed) {
      if (allows(statements, action, resource)) continue;
      missing.push(`${action} on ${resource === '*' ? "'*' (it takes no resource)" : resource}, for ${where}`);
    }
  }
  assert.deepEqual(missing, [], `ManageDeviceIdentities must allow:\n  ${missing.join('\n  ')}`);
});
