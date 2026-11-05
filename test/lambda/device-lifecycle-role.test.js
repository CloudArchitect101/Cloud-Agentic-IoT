'use strict';

// Provisioning, re-provisioning and teardown run as DeviceLifecycleRole in
// lambda/queue-relay/cloudformation.yaml. Their unit tests fake the IoT SDK,
// so a call the role may not make passes them and fails only in AWS, halfway
// through setting up a device. On 2026-11-05 the first real provisioning
// stopped with:
//   .../cloud-agentic-iot-device-provisioning is not authorized to perform:
//   iot:AttachThingPrincipal on resource: arn:aws:iot:<region>:<account>:cert/<id>
// because the role allowed that action on thing/* only. These tests read the
// role's policy and check it against every IoT call those functions make.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const TEMPLATE = 'lambda/queue-relay/cloudformation.yaml';
const ROLE = 'Role: !GetAtt DeviceLifecycleRole.Arn';

// The functions that run as the role, and the shared module they retire
// certificates through.
const FUNCTIONS = ['device-provisioning', 'device-reprovision', 'device-teardown'];
const SOURCES = [...FUNCTIONS.map((name) => `lambda/${name}/index.js`), 'lambda/shared/certificates.js'];

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
  AddThingToThingGroup: ['thing', 'thinggroup'],
  AttachThingPrincipal: ['cert'],
  DetachThingPrincipal: ['cert'],
  AttachPolicy: ['cert'],         // and thinggroup, which these functions never target
  DetachPolicy: ['cert'],
  ListAttachedPolicies: [],
  UpdateCertificate: ['cert'],
  DeleteCertificate: ['cert'],
  CreateKeysAndCertificate: [],
  DescribeEndpoint: [],
};
const S3_COMMANDS = new Set(['PutObject', 'GetObject']);

const arnPattern = (type) => 'arn:${AWS::Partition}:iot:${AWS::Region}:${AWS::AccountId}:' + type + '/*';

const indent = (line) => line.search(/\S/);
const isContent = (line) => line.trim() !== '' && !line.trim().startsWith('#');

/**
 * The statements of the ManageDeviceIdentities policy, read as text: the repo
 * has no YAML parser, and one would have to be taught !Sub anyway. Statements
 * are read in the shape the template writes them: "- Effect: Allow", then an
 * Action and a Resource, each one value on its line or a "- " list under it.
 * Anything else fails the test, so it cannot pass on a statement it misread.
 */
function policyStatements() {
  const lines = read(TEMPLATE).split('\n');
  const start = lines.findIndex((line) => line.trim() === '- PolicyName: ManageDeviceIdentities');
  assert.notEqual(start, -1, `${TEMPLATE} has no ManageDeviceIdentities policy`);

  const value = (text) => {
    const plain = text.replace(/^!Sub +/, '').replace(/^'(.*)'$/, '$1');
    // Another tag, a [flow list] or a stray quote is a shape this test doesn't read.
    assert.ok(/^[^!'"[{]/.test(plain) && !/['"]/.test(plain), `ManageDeviceIdentities has a value this test cannot read: ${text}`);
    return plain;
  };
  const statements = [];
  let key = null;
  for (const line of lines.slice(start + 1)) {
    if (!isContent(line)) continue;
    if (indent(line) <= indent(lines[start])) break;
    const text = line.trim();
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
      if (field[2]) statements.at(-1)[key].push(value(field[2]));
    } else if (item && key) {
      statements.at(-1)[key].push(value(item[1]));
    } else {
      assert.fail(`ManageDeviceIdentities has a line this test cannot read: ${text}`);
    }
  }
  assert.ok(statements.length, 'ManageDeviceIdentities has no statements');
  return statements;
}

/** Whether the policy allows the action on a resource of that type, or on any resource. */
function allows(statements, action, type) {
  const actionMatches = (pattern) => new RegExp(
    `^${pattern.split('*').map((part) => part.replace(/[.?+^$|()[\]{}\\]/g, '\\$&')).join('.*')}$`, 'i',
  ).test(action);
  return statements.some(({ Action, Resource }) => Action.some(actionMatches)
    && (Resource.includes('*') || (type !== undefined && Resource.includes(arnPattern(type)))));
}

/** The IoT operations the sources call, each with the files that call it. */
function iotCalls() {
  const calls = new Map();
  for (const file of SOURCES) {
    for (const [, operation] of read(file).matchAll(/new (?:\w+\.)?(\w+)Command\(/g)) {
      if (S3_COMMANDS.has(operation)) continue;
      if (!calls.has(operation)) calls.set(operation, new Set());
      calls.get(operation).add(file);
    }
  }
  return calls;
}

test('the files these tests read are every function that runs as the lifecycle role', () => {
  const lines = read(TEMPLATE).split('\n');
  const resources = [];
  for (const line of lines) {
    if (/^ {2}\w+:$/.test(line)) resources.push([]);
    else if (resources.length && (indent(line) > 2 || !isContent(line))) resources.at(-1).push(line);
  }
  const onRole = resources
    .filter((body) => body.some((line) => line.trim() === ROLE))
    .map((body) => (body.join('\n').match(/FunctionName: cloud-agentic-iot-(\S+)/) || [])[1]);
  assert.deepEqual(onRole.sort(), [...FUNCTIONS].sort(),
    `functions on DeviceLifecycleRole in ${TEMPLATE}; add a new one's files to FUNCTIONS here`);
});

test('the lifecycle role may attach a certificate to a Thing, and detach it', () => {
  const statements = policyStatements();
  for (const action of ['iot:AttachThingPrincipal', 'iot:DetachThingPrincipal']) {
    assert.ok(allows(statements, action, 'cert'),
      `ManageDeviceIdentities must allow ${action} on ${arnPattern('cert')}: AWS checks it against the certificate, not the Thing`);
  }
});

test('every IoT call the lifecycle functions make is allowed on what AWS checks it against', () => {
  const statements = policyStatements();
  const calls = iotCalls();
  // The handlers write `new AttachThingPrincipalCommand(`, certificates.js
  // `new sdk.DetachThingPrincipalCommand(`. A scan that missed either form
  // would let this test pass on nothing.
  assert.ok(calls.has('AttachThingPrincipal') && calls.has('DetachThingPrincipal'),
    `the scan found only ${[...calls.keys()].join(', ')}`);

  const missing = [];
  for (const [operation, files] of calls) {
    const where = [...files].join(', ');
    assert.ok(Object.hasOwn(CHECKED_AGAINST, operation),
      `${where} calls ${operation}Command. Add iot:${operation} to CHECKED_AGAINST with the resource types AWS's service reference gives it, and grant it in ManageDeviceIdentities.`);
    const types = CHECKED_AGAINST[operation];
    if (!types.length && !allows(statements, `iot:${operation}`)) {
      missing.push(`iot:${operation} on '*' (it takes no resource), for ${where}`);
    }
    for (const type of types) {
      if (!allows(statements, `iot:${operation}`, type)) missing.push(`iot:${operation} on ${arnPattern(type)}, for ${where}`);
    }
  }
  assert.deepEqual(missing, [], `ManageDeviceIdentities must allow:\n  ${missing.join('\n  ')}`);
});
