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

// The agent's metadata refers to itself by name in four places: the topic
// names its actions, each action names an Apex class, and the permission set
// opens those classes to the people who talk to the agent. A broken name
// fails the deploy, or worse, deploys an action nobody may run.
test('every action the agent\'s topics name exists, invokes a class that exists, and Patient_Care_Agent opens it', () => {
  const plugins = filesUnder(path.join(metadata, 'genAiPlugins'), '.genAiPlugin-meta.xml');
  const permissionSet = fs.readFileSync(path.join(metadata, 'permissionsets/Patient_Care_Agent.permissionset-meta.xml'), 'utf8');
  const opened = new Set([...permissionSet.matchAll(/<apexClass>(\w+)<\/apexClass>/g)].map(([, name]) => name));
  const named = plugins.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/<functionName>(\w+)<\/functionName>/g)].map(([, n]) => n));
  assert.ok(named.includes('Find_Procedure'), 'the topic has no Find Procedure action');
  for (const name of named) {
    const file = path.join(metadata, 'genAiFunctions', name, `${name}.genAiFunction-meta.xml`);
    assert.ok(fs.existsSync(file), `${name} is named by a topic but has no ${path.relative(root, file)}`);
    const target = fs.readFileSync(file, 'utf8').match(/<invocationTarget>(\w+)<\/invocationTarget>/)[1];
    const apex = path.join(metadata, 'classes', `${target}.cls`);
    assert.ok(fs.existsSync(apex), `${name} invokes ${target}, which has no class`);
    assert.match(fs.readFileSync(apex, 'utf8'), /@InvocableMethod/, `${target} has no @InvocableMethod`);
    assert.ok(opened.has(target), `Patient_Care_Agent does not open ${target}, so ${name} fails for the people using the agent`);
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

// The Metadata API at 64.0 refuses a BotVersion that carries
// staticPromptsEnabled ("Element ... invalid at this location"), and the
// whole deploy fails with it.
test('the agent\'s BotVersion carries no element API 64.0 refuses', () => {
  for (const file of filesUnder(path.join(metadata, 'bots'), '.botVersion-meta.xml')) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /<staticPromptsEnabled>/, path.relative(root, file));
  }
});
