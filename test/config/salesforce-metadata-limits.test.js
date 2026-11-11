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

test('every Trusted URL description fits in 255 characters', () => {
  const files = filesUnder(path.join(metadata, 'cspTrustedSites'), '.cspTrustedSite-meta.xml');
  assert.ok(files.length > 0, 'no Trusted URLs found');
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

// The agent is built in the new Agentforce Builder: its Agent Script
// (aiAuthoringBundles/Patient_Care_Agent/Patient_Care_Agent.agent) is the
// source, and the org compiles the planner and bot version from it. The
// legacy builder's agents could not take a Slack connection, so no agent is
// shipped in the legacy shape (a Bot or a standalone GenAiPlugin topic).
const AGENT = path.join(metadata, 'aiAuthoringBundles/Patient_Care_Agent/Patient_Care_Agent.agent');
const agentScript = () => fs.readFileSync(AGENT, 'utf8');
const instructionsOf = (script, subagent) => {
  const block = script.split(/\n(?=subagent |start_agent |connection )/).find((b) => b.startsWith(`subagent ${subagent}:`));
  assert.ok(block, `no subagent ${subagent}`);
  return block;
};

test('agents ship as new-builder Agent Script, never in the legacy shape', () => {
  assert.ok(fs.existsSync(AGENT), 'Patient_Care_Agent has no Agent Script');
  assert.ok(fs.existsSync(AGENT.replace(/\.agent$/, '.bundle-meta.xml')), 'the authoring bundle has no -meta.xml');
  assert.ok(!fs.existsSync(path.join(metadata, 'bots/Patient_Care_Agent')), 'a legacy Bot for Patient_Care_Agent is back');
  assert.ok(!fs.existsSync(path.join(metadata, 'genAiPlugins/Patient_Device_Monitoring.genAiPlugin-meta.xml')), 'the legacy topic is back');
  const script = agentScript();
  assert.match(script, /agent_type: "AgentforceEmployeeAgent"/);
  assert.match(script, /\nconnection slack:\n/, 'the Slack connection is gone, so the agent leaves Slack on the next publish');
});

// Each action names its GenAiFunction (source) and Apex class (target), and
// the permission set opens those classes to the people who talk to the agent.
// A broken name fails the publish, or worse, publishes an action nobody may run.
test('every action the agent names exists, invokes a class that exists, and Patient_Care_Agent opens it', () => {
  const script = agentScript();
  const permissionSet = fs.readFileSync(path.join(metadata, 'permissionsets/Patient_Care_Agent.permissionset-meta.xml'), 'utf8');
  const opened = new Set([...permissionSet.matchAll(/<apexClass>(\w+)<\/apexClass>/g)].map(([, name]) => name));
  const actions = [...script.matchAll(/source: "(\w+)"\n\s+target: "apex:\/\/(\w+)"/g)].map(([, source, target]) => ({ source, target }));
  assert.deepEqual(actions.map((a) => a.source).sort(), ['Escalate_Patient_Device_Condition', 'Find_Procedure', 'Get_Device_Readings']);
  for (const { source, target } of actions) {
    const file = path.join(metadata, 'genAiFunctions', source, `${source}.genAiFunction-meta.xml`);
    assert.ok(fs.existsSync(file), `${source} is named by the agent but has no ${path.relative(root, file)}`);
    assert.equal(fs.readFileSync(file, 'utf8').match(/<invocationTarget>(\w+)<\/invocationTarget>/)[1], target, `${source}: the agent and the function name different classes`);
    const apex = path.join(metadata, 'classes', `${target}.cls`);
    assert.ok(fs.existsSync(apex), `${source} invokes ${target}, which has no class`);
    assert.match(fs.readFileSync(apex, 'utf8'), /@InvocableMethod/, `${target} has no @InvocableMethod`);
    assert.ok(opened.has(target), `Patient_Care_Agent does not open ${target}, so ${source} fails for the people using the agent`);
  }
});

test('escalating asks the user to confirm first', () => {
  assert.match(agentScript(), /require_user_confirmation: True\n\s+include_in_progress_indicator: False\n\s+source: "Escalate_Patient_Device_Condition"/);
});

test('the topic tells the agent to cite the procedure it used, by SOP ID and version', () => {
  const topic = instructionsOf(agentScript(), 'Patient_Device_Monitoring');
  assert.match(topic, /Find Procedure/);
  assert.match(topic, /SOP ID and version/);
  assert.match(topic, /no ward procedure covers it/);
});

// Asked "Test8 reads 31 C, what do I do?" while the procedure index was
// unavailable, the agent answered only "I cannot access the procedure
// details" and never read Test8. A named device's readings must not depend
// on the procedure search.
test('the topic tells the agent to report a named device\'s readings even when Find Procedure fails', () => {
  const topic = instructionsOf(agentScript(), 'Patient_Device_Monitoring');
  assert.match(topic, /always get its latest readings/);
  assert.match(topic, /If Find Procedure fails/);
  assert.match(topic, /offer to escalate/);
});

// Asked "What is Test8 reporting?" in Slack, the agent gave a day-old saved
// reading as the latest while calling the device online, and called 30.0 C
// "low" next to the other readings. It now gets the newest reading stored in
// AWS with its age, and must say a reading's age and judge it by thresholds.
test('the topic tells the agent to lead with the live reading, give a stale reading\'s age, and judge by thresholds', () => {
  const topic = instructionsOf(agentScript(), 'Patient_Device_Monitoring');
  assert.match(topic, /The live reading/);
  assert.match(topic, /more than 60 minutes old/);
  assert.match(topic, /Do not call a device online from its connection status alone/);
  assert.match(topic, /never as high or low compared with the device's other readings/);
});

test('the agent declares every output of Get Device Readings that its schema has', () => {
  const script = agentScript();
  const block = script.slice(script.indexOf('\n        Get_Device_Readings:\n'), script.indexOf('\n        Find_Procedure:\n'));
  const declared = [...block.slice(block.indexOf('outputs:')).matchAll(/^ {16}"(\w+)":/gm)].map(([, name]) => name).sort();
  const schema = JSON.parse(fs.readFileSync(path.join(metadata, 'genAiFunctions/Get_Device_Readings/output/schema.json'), 'utf8'));
  assert.deepEqual(declared, Object.keys(schema.properties).sort());
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

// Rules Salesforce enforced on the first Business Value deploy (Nov 11).
test('custom objects enable Sharing, Bulk API and Streaming API together', () => {
  for (const file of filesUnder(path.join(metadata, 'objects'), '.object-meta.xml')) {
    const xml = fs.readFileSync(file, 'utf8');
    const flags = ['enableSharing', 'enableBulkApi', 'enableStreamingApi']
      .map((tag) => (xml.match(new RegExp(`<${tag}>(\\w+)</${tag}>`)) || [])[1])
      .filter(Boolean);
    if (flags.length === 0) continue;
    assert.equal(new Set(flags).size, 1, `${path.basename(file)}: ${flags.join(', ')}`);
  }
});

test('metric and gauge dashboard components set indicator colours and no chart-only attributes', () => {
  for (const file of filesUnder(path.join(metadata, 'dashboards'), '.dashboard-meta.xml')) {
    const xml = fs.readFileSync(file, 'utf8');
    const components = xml.split('<dashboardComponent>').slice(1);
    for (const c of components) {
      if (!/<componentType>(Metric|Gauge)<\/componentType>/.test(c)) continue;
      const name = `${path.basename(file)}: ${(c.match(/<header>([^<]*)/) || [])[1]}`;
      assert.match(c, /<indicatorLowColor>/, name);
      for (const tag of ['sortBy', 'chartAxisRange', 'showPercentage', 'showValues', 'useReportChart', 'axisBinding']) {
        assert.doesNotMatch(c.split('</dashboardComponent>')[0], new RegExp(`<${tag}>`), `${name} uses ${tag}`);
      }
    }
  }
});

test('embedded dashboards use only the properties Salesforce accepts', () => {
  const allowed = new Set(['dashboardName', 'height', 'hideOnError']);
  for (const file of filesUnder(path.join(metadata, 'flexipages'), '.flexipage-meta.xml')) {
    const xml = fs.readFileSync(file, 'utf8');
    for (const inst of xml.split('<componentInstance>').slice(1)) {
      if (!inst.includes('desktopDashboards:embeddedDashboard')) continue;
      const names = [...inst.matchAll(/<name>(\w+)<\/name>/g)].map((m) => m[1]);
      for (const n of names) assert.ok(allowed.has(n), `${path.basename(file)}: ${n}`);
    }
  }
});
