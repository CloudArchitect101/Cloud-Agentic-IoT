'use strict';

// Salesforce checks some field lengths only at deploy time, after the deploy
// has already started. These checks catch them on every pull request instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const metadata = path.join(root, 'force-app/main/default');

function filesUnder(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, suffix);
    return entry.name.endsWith(suffix) ? [full] : [];
  });
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

test('every permission set description fits in 255 characters', () => {
  const files = filesUnder(path.join(metadata, 'permissionsets'), '.permissionset-meta.xml');
  assert.ok(files.length > 0, 'no permission sets found');
  for (const file of files) {
    const match = fs.readFileSync(file, 'utf8').match(/<description>([\s\S]*?)<\/description>/);
    if (!match) continue;
    const length = unescapeXml(match[1]).length;
    assert.ok(length <= 255, `${path.relative(root, file)}: description is ${length} characters, the maximum is 255`);
  }
});

test('every record type description fits in 255 characters, and both device roles are visible where Assets are made', () => {
  const files = filesUnder(path.join(metadata, 'objects'), '.recordType-meta.xml');
  assert.ok(files.length >= 2, 'no record types found');
  for (const file of files) {
    const match = fs.readFileSync(file, 'utf8').match(/<description>([\s\S]*?)<\/description>/);
    if (!match) continue;
    const length = unescapeXml(match[1]).length;
    assert.ok(length <= 255, `${path.relative(root, file)}: description is ${length} characters, the maximum is 255`);
  }
  for (const set of ['Device_Platform_Admin', 'Device_Integration']) {
    const text = fs.readFileSync(path.join(metadata, `permissionsets/${set}.permissionset-meta.xml`), 'utf8');
    for (const recordType of ['Asset.Internal_Device', 'Asset.Patient_Device']) {
      assert.match(text, new RegExp(`<recordType>${recordType}</recordType>\\s*<visible>true</visible>`), `${set}: ${recordType}`);
    }
  }
});

// The queue binding used to name ESP32-Patient-Monitor-01, a board that never
// existed, so the queue moved no motor. Internal Device boards follow the
// queue now; a binding names a board only when one is meant.
test('the shipped Care_Team_Queue binding names no board of its own', () => {
  const binding = fs.readFileSync(path.join(metadata, 'customMetadata/Device_Queue_Binding.Care_Team_Queue.md-meta.xml'), 'utf8');
  assert.match(binding, /<field>Device_Id__c<\/field>\s*<value xsi:nil="true"\s*\/>/);
});

// The staff agent's metadata refers to itself by name in four places: a
// topic names its actions, each action names an Apex class, and a permission
// set opens those classes to whoever runs them (Patient_Care_Agent). A broken
// name fails the deploy, or worse, deploys an action nobody may run.
const TOPIC_PERMISSION_SET = {
  Patient_Device_Monitoring: 'Patient_Care_Agent',
};

test('every action a topic names exists, invokes a class that exists, and the topic\'s permission set opens it', () => {
  const plugins = filesUnder(path.join(metadata, 'genAiPlugins'), '.genAiPlugin-meta.xml');
  for (const plugin of plugins) {
    const topic = path.basename(plugin, '.genAiPlugin-meta.xml');
    assert.ok(TOPIC_PERMISSION_SET[topic], `${topic}: say which permission set opens its actions`);
    const permissionSet = fs.readFileSync(path.join(metadata, `permissionsets/${TOPIC_PERMISSION_SET[topic]}.permissionset-meta.xml`), 'utf8');
    const opened = new Set([...permissionSet.matchAll(/<apexClass>(\w+)<\/apexClass>/g)].map(([, name]) => name));
    const named = [...fs.readFileSync(plugin, 'utf8').matchAll(/<functionName>(\w+)<\/functionName>/g)].map(([, n]) => n);
    if (topic === 'Patient_Device_Monitoring') {
      assert.ok(named.includes('Find_Procedure'), 'the topic has no Find Procedure action');
    }
    for (const name of named) {
      const file = path.join(metadata, 'genAiFunctions', name, `${name}.genAiFunction-meta.xml`);
      assert.ok(fs.existsSync(file), `${name} is named by a topic but has no ${path.relative(root, file)}`);
      const target = fs.readFileSync(file, 'utf8').match(/<invocationTarget>(\w+)<\/invocationTarget>/)[1];
      const apex = path.join(metadata, 'classes', `${target}.cls`);
      assert.ok(fs.existsSync(apex), `${name} invokes ${target}, which has no class`);
      assert.match(fs.readFileSync(apex, 'utf8'), /@InvocableMethod/, `${target} has no @InvocableMethod`);
      assert.ok(opened.has(target), `${TOPIC_PERMISSION_SET[topic]} does not open ${target}, so ${name} fails for whoever runs ${topic}`);
    }
  }
});

// The patient agent is Agent Script (new Agentforce Builder). It runs as its
// own agent user, so with sharing would not stop it reading another patient's
// data. Each action must take the patient from the verified chat: the Apex
// resolves the MessagingSession, and the script binds that input to the
// RoutableId variable itself, so the model never fills it.
const PORTAL_AGENT = path.join(metadata, 'aiAuthoringBundles/Patient_Portal_Agent/Patient_Portal_Agent.agent');

test('the patient portal agent is an Agent Script bundle with a placeholder agent user', () => {
  const script = fs.readFileSync(PORTAL_AGENT, 'utf8');
  assert.ok(fs.existsSync(PORTAL_AGENT.replace(/\.agent$/, '.bundle-meta.xml')), 'the bundle has no bundle-meta.xml');
  assert.match(script, /^config:\n(?:\s{4}.*\n)*?\s{4}developer_name: "Patient_Portal_Agent"/m);
  assert.match(script, /default_agent_user: "PORTAL_AGENT_USER"/, 'the agent user is org-specific: scripts/publish-portal-agent.sh fills it in');
  assert.match(script, /RoutableId: linked string\n\s+source: @MessagingSession\.Id/);
  assert.ok(!fs.existsSync(path.join(metadata, 'genAiPlugins/Patient_Portal_Self_Service.genAiPlugin-meta.xml')), 'the old-builder portal topic is back');
});

test('every patient portal action finds the patient from the verified chat', () => {
  const script = fs.readFileSync(PORTAL_AGENT, 'utf8');
  const permissionSet = fs.readFileSync(path.join(metadata, 'permissionsets/Patient_Portal_Agent.permissionset-meta.xml'), 'utf8');
  const opened = new Set([...permissionSet.matchAll(/<apexClass>(\w+)<\/apexClass>/g)].map(([, name]) => name));
  const targets = [...script.matchAll(/^\s{8}(\w+):\n(?:\s{12}.*\n)*?\s{12}target: "apex:\/\/(\w+)"/gm)];
  assert.deepEqual(targets.map(([, name]) => name).sort(), ['get_my_devices', 'request_nurse']);
  for (const [, name, target] of targets) {
    const apex = fs.readFileSync(path.join(metadata, 'classes', `${target}.cls`), 'utf8');
    assert.match(apex, /@InvocableMethod/, `${target} has no @InvocableMethod`);
    assert.match(apex, /PortalIdentityService\.forMessagingSession\(/, `${target} must resolve the patient from the MessagingSession`);
    assert.doesNotMatch(apex, /accountId\s*;\s*$/m, `${target} must not take an account Id as input`);
    assert.ok(opened.has(target), `Patient_Portal_Agent does not open ${target}`);
    const call = script.match(new RegExp(`^\\s+${name}: @actions\\.${name}\\n((?:\\s{16}.*\\n)+)`, 'm'));
    assert.ok(call, `the my_room subagent does not offer ${name}`);
    assert.match(call[1], /with messagingSessionId = @variables\.RoutableId/, `${name}: the session must be bound to RoutableId, not left to the model`);
  }
});

test('the topic tells the agent to cite the procedure it used, by SOP ID and version', () => {
  const topic = fs.readFileSync(path.join(metadata, 'genAiPlugins/Patient_Device_Monitoring.genAiPlugin-meta.xml'), 'utf8');
  const cite = topic.match(/<developerName>instruction_cite_procedures<\/developerName>[\s\S]*?<description>([\s\S]*?)<\/description>/);
  assert.ok(cite, 'no instruction_cite_procedures');
  assert.match(cite[1], /Find Procedure/);
  assert.match(cite[1], /SOP ID and version/);
  assert.match(cite[1], /no ward procedure covers it/);
});

// Asked "Test8 reads 31 C, what do I do?" while the procedure index was
// unavailable, the agent answered only "I cannot access the procedure
// details" and never read Test8. A named device's readings must not depend
// on the procedure search.
test('the topic tells the agent to report a named device\'s readings even when Find Procedure fails', () => {
  const topic = fs.readFileSync(path.join(metadata, 'genAiPlugins/Patient_Device_Monitoring.genAiPlugin-meta.xml'), 'utf8');
  const cite = topic.match(/<developerName>instruction_cite_procedures<\/developerName>[\s\S]*?<description>([\s\S]*?)<\/description>/);
  assert.match(cite[1], /always get its latest readings/);
  assert.match(cite[1], /If Find Procedure fails/);
  assert.match(cite[1], /offer to escalate/);
});

// An agent action deployed without input/schema.json and output/schema.json
// deploys green, but the org drops it: the agent's topic showed "Actions 0"
// and the retrieve said "an input or output schema is missing". Each schema
// must also list exactly the Apex action's @InvocableVariable fields.
test('every agent action ships input and output schemas that match its Apex', () => {
  const dir = path.join(metadata, 'genAiFunctions');
  for (const name of fs.readdirSync(dir)) {
    const meta = fs.readFileSync(path.join(dir, name, `${name}.genAiFunction-meta.xml`), 'utf8');
    const target = meta.match(/<invocationTarget>(\w+)<\/invocationTarget>/)[1];
    const apex = fs.readFileSync(path.join(metadata, 'classes', `${target}.cls`), 'utf8');
    const classes = [...apex.matchAll(/public class (\w+)\s*\{([\s\S]*?)\n    \}/g)]
      .map(([, cls, body]) => ({ cls, fields: [...body.matchAll(/@InvocableVariable(?:\([\s\S]*?\))?\s*public\s+\w+\s+(\w+);/g)].map((m) => m[1]) }))
      .filter((c) => c.fields.length);
    assert.equal(classes.length, 2, `${target}: expected one request and one result class`);
    for (const [side, cls] of [['input', classes[0]], ['output', classes[1]]]) {
      const file = path.join(dir, name, side, 'schema.json');
      assert.ok(fs.existsSync(file), `${name} has no ${side}/schema.json, so the org drops the action`);
      const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(schema['lightning:type'], 'lightning__objectType', `${name} ${side}`);
      assert.deepEqual(Object.keys(schema.properties).sort(), [...cls.fields].sort(), `${name} ${side} schema vs ${cls.cls}`);
    }
  }
});

// The Metadata API at 64.0 refuses a BotVersion that carries
// staticPromptsEnabled ("Element ... invalid at this location"), and the
// whole deploy fails with it.
test('the agent\'s BotVersion carries no element API 64.0 refuses', () => {
  for (const file of filesUnder(path.join(metadata, 'bots'), '.botVersion-meta.xml')) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /<staticPromptsEnabled>/, path.relative(root, file));
  }
});

// With Person Accounts on, Read Account depends on Read Contact: Salesforce
// adds it in the org, and a permission set deployed without it fails the
// whole deploy ("Permission Read Account depends on permission(s): Read
// Contact"). Granting it keeps one copy right for orgs with and without them.
test('every permission set that reads Account also reads Contact', () => {
  const reads = (xml, object) => [...xml.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/g)]
    .some(([, body]) => body.includes(`<object>${object}</object>`) && /<allowRead>true<\/allowRead>/.test(body));
  for (const file of filesUnder(path.join(metadata, 'permissionsets'), '.permissionset-meta.xml')) {
    const xml = fs.readFileSync(file, 'utf8');
    if (reads(xml, 'Account')) assert.ok(reads(xml, 'Contact'), `${path.relative(root, file)} reads Account but not Contact`);
  }
});
