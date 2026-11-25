'use strict';

// The device-live function hands a browser credentials: a 15-minute session
// of LiveViewerRole in lambda/queue-relay/cloudformation.yaml, narrowed by a
// session policy to one client id and one board's live topic. A session can
// never do more than its role allows, so the role is the ceiling on what a
// link that leaked from a browser could do: connect as a live-* client and
// receive boards' live readings. These tests read the template and pin that
// ceiling, who may assume the role, and that DeviceLiveRole may make every
// call the function makes and no other. The function's unit tests fake the
// AWS SDK, so none of this would fail anywhere but in AWS.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const lines = (file) => read(file).split(/\r?\n/);

const TEMPLATE = 'lambda/queue-relay/cloudformation.yaml';
const SOURCE = 'lambda/device-live/index.js';

const IOT = '!Sub arn:${AWS::Partition}:iot:${AWS::Region}:${AWS::AccountId}:';
const TABLE = '!Sub arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${PatientVitalsTableName}';

// What AWS checks each call of the function against, by the name of its SDK
// command, as "action on resource". GetCommand is the document client's
// GetItem. DescribeEndpoint takes no resource, so only '*' allows it.
const NEEDS = {
  Publish: `iot:Publish on ${IOT}topic/device/*/command`,
  DescribeEndpoint: 'iot:DescribeEndpoint on *',
  AssumeRole: 'sts:AssumeRole on !GetAtt LiveViewerRole.Arn',
  Query: `dynamodb:Query on ${TABLE}`,
  Get: `dynamodb:GetItem on ${TABLE}`,
  Update: `dynamodb:UpdateItem on ${TABLE}`,
};

const indent = (line) => line.search(/\S/);
const isContent = (line) => line.trim() !== '' && !line.trim().startsWith('#');

/** Each resource's lines by its name, without comments or blank lines. */
function resources() {
  const found = new Map();
  let section = null;
  let body = null;
  for (const line of lines(TEMPLATE)) {
    if (!isContent(line)) continue;
    if (indent(line) === 0) {
      section = line;
      continue;
    }
    if (section !== 'Resources:') continue;
    const name = line.match(/^ {2}(\w+):$/);
    if (name) {
      body = [];
      found.set(name[1], body);
    } else {
      assert.ok(body && indent(line) > 2, `${TEMPLATE} has a line in Resources this test cannot read: ${line.trim()}`);
      body.push(line);
    }
  }
  return found;
}

/**
 * One resource, read into plain objects: the repo has no YAML parser, and one
 * would have to be taught the template's tags anyway. It reads the block
 * style the template is written in: "Key: value", "Key:" over a block, "- "
 * lists, a { Key: value } pair, text after >- or |, and comments on lines of
 * their own. A tag stays in its value as text ("!GetAtt DeviceLiveRole.Arn")
 * and quotes come off. Anything else fails the test, so it cannot pass on a
 * shape it misread.
 */
function resource(name) {
  const body = resources().get(name);
  assert.ok(body, `${TEMPLATE} declares no resource ${name}`);
  const entries = body.map((line) => ({ depth: indent(line), text: line.trim() }));
  const [value, next] = block(entries, 0, name);
  assert.equal(next, entries.length, `${name} has a line this test cannot read: ${(entries[next] || {}).text}`);
  return value;
}

const KEY = /^([A-Za-z][\w.:-]*):(?: (.+))?$/;

/** The list or mapping that starts at entries[at], and the index after it. */
function block(entries, at, where) {
  const { depth } = entries[at];
  if (!entries[at].text.startsWith('- ')) return mapping(entries, at, depth, where);
  const items = [];
  while (at < entries.length && entries[at].depth === depth && entries[at].text.startsWith('- ')) {
    // The item's first line, read as though it began two columns in, where the rest of the item is.
    const item = [{ depth: depth + 2, text: entries[at].text.slice(2) }];
    for (at += 1; at < entries.length && entries[at].depth > depth; at += 1) item.push(entries[at]);
    if (item.length === 1 && !KEY.test(item[0].text)) {
      items.push(scalar(item[0].text, where));
    } else {
      const [value, next] = block(item, 0, where);
      assert.equal(next, item.length, `${where} has a line this test cannot read: ${(item[next] || {}).text}`);
      items.push(value);
    }
  }
  return [items, at];
}

function mapping(entries, at, depth, where) {
  const map = {};
  while (at < entries.length && entries[at].depth === depth) {
    const pair = entries[at].text.match(KEY);
    assert.ok(pair, `${where} has a line this test cannot read: ${entries[at].text}`);
    const [, key, value] = pair;
    assert.ok(!Object.hasOwn(map, key), `${where} sets ${key} twice`);
    at += 1;
    if (value === undefined) {
      assert.ok(at < entries.length && entries[at].depth > depth, `${where}: ${key} has no value`);
      [map[key], at] = block(entries, at, where);
    } else if (/^[>|]-?$/.test(value)) {
      const text = [];
      for (; at < entries.length && entries[at].depth > depth; at += 1) text.push(entries[at].text);
      map[key] = text.join(value.startsWith('>') ? ' ' : '\n');
    } else {
      map[key] = scalar(value, where);
    }
  }
  return [map, at];
}

function scalar(text, where) {
  const tagged = text.match(/^(![A-Za-z]+) (.+)$/);
  if (tagged) return `${tagged[1]} ${scalar(tagged[2], where)}`;
  const quoted = text.match(/^'((?:[^']|'')*)'$/);
  if (quoted) return quoted[1].replace(/''/g, "'");
  const pair = text.match(/^\{ *([A-Za-z][\w.:-]*): ([^{}]+?) *\}$/);
  if (pair) return { [pair[1]]: scalar(pair[2], where) };
  // Another quote, a [flow list], an anchor, or a comment after the value is
  // a shape this reader does not take apart.
  assert.ok(/^[^'"[\]{}&*!|>%@`#]/.test(text) && !/\s#|: /.test(text), `${where} has a value this test cannot read: ${text}`);
  return text;
}

const listOf = (value) => (Array.isArray(value) ? value : [value]);

/** Every "action on resource" a policy document allows. */
function grants(document, where) {
  assert.equal(document.Version, '2012-10-17', `${where}: Version`);
  assert.ok(Array.isArray(document.Statement) && document.Statement.length, `${where} has no statements`);
  return document.Statement.flatMap(({
    Effect, Action, Resource, ...other
  }) => {
    // A Deny, a NotAction or a Condition would change what "exactly" means here.
    assert.deepEqual(Object.keys(other), [], `${where} has a statement with ${Object.keys(other).join(', ')}, which this test does not read`);
    assert.equal(Effect, 'Allow', `${where} has a statement that is not an Allow`);
    return listOf(Action).flatMap((action) => listOf(Resource).map((resource) => `${action} on ${resource}`));
  });
}

test("the live viewer role lets a live-* client receive boards' live topics, and nothing else", () => {
  const role = resource('LiveViewerRole');
  assert.equal(role.Type, 'AWS::IAM::Role');
  const { AssumeRolePolicyDocument, Policies, ...other } = role.Properties;
  // A managed policy would grant what this test cannot see; these grant nothing.
  const harmless = ['Description', 'MaxSessionDuration', 'Path', 'RoleName', 'Tags'];
  assert.deepEqual(Object.keys(other).filter((key) => !harmless.includes(key)), [],
    'LiveViewerRole may have no properties beyond its trust, its one policy and those that grant nothing');
  assert.ok(AssumeRolePolicyDocument, 'LiveViewerRole has no trust policy');
  assert.equal(listOf(Policies).length, 1, 'LiveViewerRole must have exactly one policy');

  assert.deepEqual(grants(Policies[0].PolicyDocument, 'LiveViewerRole').sort(), [
    `iot:Connect on ${IOT}client/live-*`,
    `iot:Receive on ${IOT}topic/device/*/live`,
    `iot:Subscribe on ${IOT}topicfilter/device/*/live`,
  ]);
});

test('only DeviceLiveRole may assume the live viewer role, and only the device-live function runs as DeviceLiveRole', () => {
  const trust = resource('LiveViewerRole').Properties.AssumeRolePolicyDocument;
  assert.equal(trust.Version, '2012-10-17');
  assert.equal(listOf(trust.Statement).length, 1, 'LiveViewerRole must trust one principal, in one statement');
  const [{
    Effect, Principal, Action, ...other
  }] = listOf(trust.Statement);
  // A Condition, or a principal of another kind, is a widening this test should be changed for on purpose.
  assert.deepEqual(Object.keys(other), [], `LiveViewerRole's trust has ${Object.keys(other).join(', ')}`);
  assert.equal(Effect, 'Allow');
  assert.deepEqual(Object.keys(Principal), ['AWS']);
  assert.deepEqual(listOf(Principal.AWS), ['!GetAtt DeviceLiveRole.Arn']);
  assert.deepEqual(listOf(Action), ['sts:AssumeRole']);

  // Whatever runs as DeviceLiveRole can make viewer credentials. Any mention
  // counts, however it is written.
  const naming = [...resources()]
    .filter(([name, body]) => name !== 'DeviceLiveRole' && body.some((line) => /\bDeviceLiveRole\b/.test(line)))
    .map(([name]) => name);
  assert.deepEqual(naming.sort(), ['DeviceLiveAssumesViewer', 'DeviceLiveFunction', 'LiveViewerRole'],
    `resources that name DeviceLiveRole in ${TEMPLATE}`);
  const fn = resource('DeviceLiveFunction');
  assert.equal(fn.Properties.FunctionName, 'cloud-agentic-iot-device-live');
  assert.equal(fn.Properties.Role, '!GetAtt DeviceLiveRole.Arn');
});

test('no other resource gives the live viewer role anything', () => {
  // A policy attaches to a role by its name, !Ref LiveViewerRole. Its ARN may
  // appear only where DeviceLiveRole is let assume it, and in the
  // function's environment.
  const mentions = [];
  for (const [name, body] of resources()) {
    if (name === 'LiveViewerRole') continue;
    for (const line of body) {
      if (/\bLiveViewerRole\b/.test(line)) mentions.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(mentions.sort(), [
    'DeviceLiveAssumesViewer: Resource: !GetAtt LiveViewerRole.Arn',
    'DeviceLiveFunction: LIVE_VIEWER_ROLE_ARN: !GetAtt LiveViewerRole.Arn',
  ]);
});

test('DeviceLiveRole may make every call the device-live function makes, and no other', () => {
  const role = resource('DeviceLiveRole');
  assert.deepEqual(listOf(role.Properties.ManagedPolicyArns), ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']);
  const assumes = resource('DeviceLiveAssumesViewer');
  assert.equal(assumes.Type, 'AWS::IAM::Policy');
  assert.deepEqual(listOf(assumes.Properties.Roles), ['!Ref DeviceLiveRole']);
  const allowed = [
    ...listOf(role.Properties.Policies).flatMap((policy) => grants(policy.PolicyDocument, `DeviceLiveRole ${policy.PolicyName}`)),
    ...grants(assumes.Properties.PolicyDocument, 'DeviceLiveAssumesViewer'),
  ];

  // Every name ending in Command counts, however it is used. A scan that
  // found none would let this test pass on nothing.
  const calls = [...new Set([...read(SOURCE).matchAll(/\b(\w+)Command\b/g)].map(([, operation]) => operation))];
  assert.deepEqual(calls.sort(), Object.keys(NEEDS).sort(), `${SOURCE} makes calls this test does not list. Add each to `
    + 'NEEDS, with what AWS checks it against, allow it in DeviceLiveRole, and drop from both what it no longer calls.');
  assert.deepEqual(allowed.sort(), Object.values(NEEDS).sort());
});

// AWS IoT disconnects a board that publishes where its policy does not
// allow, so a board on firmware 2.2.0 or later without this line would drop
// off every time its card is opened.
test('each board may publish live readings to its own live topic, and to no other', () => {
  const statements = listOf(resource('DevicePolicy').Properties.PolicyDocument.Statement);
  const live = statements
    .filter((statement) => listOf(statement.Action).includes('iot:Publish'))
    .flatMap((statement) => listOf(statement.Resource))
    .filter((topic) => /\/live\b/.test(topic));
  // ${!...} keeps AWS IoT's own policy variable away from !Sub; IoT resolves it per connection.
  assert.deepEqual(live, [`${IOT}topic/device/\${!iot:Connection.Thing.ThingName}/live`]);
});

test('Salesforce reaches the function as POST /device-live, signed with SigV4', () => {
  const route = resource('LiveRoute').Properties;
  assert.equal(route.RouteKey, 'POST /device-live');
  assert.equal(route.AuthorizationType, 'AWS_IAM');
  assert.equal(route.Target, '!Sub integrations/${LiveIntegration}');
  const integration = resource('LiveIntegration').Properties;
  assert.equal(integration.IntegrationUri, '!GetAtt DeviceLiveFunction.Arn');
  assert.equal(integration.IntegrationType, 'AWS_PROXY');
  assert.equal(integration.PayloadFormatVersion, '2.0');
  const permission = resource('LivePermission').Properties;
  assert.equal(permission.FunctionName, '!Ref DeviceLiveFunction');
  assert.equal(permission.SourceArn, '!Sub arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${QueueRelayApi}/*');
});
