'use strict';

// The agent evals run against a real org and account (scripts/eval-agents.sh),
// so these tests keep their inputs honest without one: every spec names only
// subagents and actions its agent really has, every golden question expects
// an SOP that exists, the scorer counts correctly, and placeholders are
// filled. A renamed action or subagent fails here, on the pull request,
// instead of as a confusing Testing Center failure later.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, topicsOf, actionsOf } = require('../../scripts/lib/agent-spec');
const { score, junit, markdown } = require('../../scripts/lib/sop-retrieval-eval');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BUNDLES = 'force-app/main/default/aiAuthoringBundles';

/** Subagent and action names declared in an Agent Script file. */
function agentScript(name) {
  const text = read(`${BUNDLES}/${name}/${name}.agent`);
  const subagents = [...text.matchAll(/^subagent ([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  // Actions an agent can call are the ones a subagent's reasoning lists:
  // "            Name: @actions.Name"
  const actions = [...text.matchAll(/^\s+([A-Za-z0-9_]+): @actions\.[A-Za-z0-9_]+/gm)].map((m) => m[1]);
  return { subagents, actions };
}

const SPECS = {
  Patient_Care_Agent: 'test/agents/Patient_Care_Agent-testSpec.yaml',
  Patient_Portal_Agent: 'test/agents/Patient_Portal_Agent-testSpec.yaml',
};

for (const [agent, specPath] of Object.entries(SPECS)) {
  test(`${agent}: the spec names only subagents and actions the agent has`, () => {
    const spec = read(specPath);
    const have = agentScript(agent);
    assert.match(spec, new RegExp(`^subjectName: ${agent}$`, 'm'));
    for (const topic of topicsOf(spec)) {
      assert.ok(have.subagents.includes(topic), `${specPath} expects subagent ${topic}; ${agent} has ${have.subagents.join(', ')}`);
    }
    const actions = actionsOf(spec);
    assert.ok(actions.length > 0);
    for (const action of actions) {
      assert.ok(have.actions.includes(action), `${specPath} expects action ${action}; ${agent} has ${have.actions.join(', ')}`);
    }
  });

  test(`${agent}: every case has an utterance, a subagent and an expected outcome`, () => {
    const spec = read(specPath);
    const cases = spec.split(/^ {2}- utterance:/m).slice(1);
    assert.ok(cases.length >= 5, 'at least five cases');
    for (const c of cases) {
      assert.match(c, /^\s+expectedTopic: \S+/m, c);
      assert.match(c, /^\s+expectedActions:/m, c);
      assert.match(c, /^\s+expectedOutcome: \S+/m, c);
    }
  });
}

test('the staff agent spec checks SOP citations, confirmation before escalation, and refusals', () => {
  const spec = read(SPECS.Patient_Care_Agent);
  for (const sop of ['SOP-WARD-001', 'SOP-WARD-002', 'SOP-WARD-003']) assert.match(spec, new RegExp(`expected\\n\\s+value: ${sop}`));
  assert.match(spec, /asks the user to confirm\. Does not say a Case was created/);
  assert.match(spec, /- Escalate_Patient_Device_Condition/);
  assert.match(spec, /expectedTopic: off_topic/);
});

test('the patient agent spec runs as a verified chat, refuses other devices, and confirms nurse requests', () => {
  const spec = read(SPECS.Patient_Portal_Agent);
  assert.match(spec, /name: RoutableId\n\s+value: "\{\{VERIFIED_SESSION_ID\}\}"/);
  assert.match(spec, /can only see the patient's own devices/);
  assert.match(spec, /- request_nurse/);
  // One case runs without a verified chat and must see nothing.
  const unverified = spec.split(/^ {2}- utterance:/m).slice(1).filter((c) => !c.includes('RoutableId'));
  assert.equal(unverified.length, 1);
  assert.match(unverified[0], /shares no patient data/);
});

test('render fills placeholders and maps subagents to the org names, and reports what is left', () => {
  const spec = 'utterance: "{{DEVICE}} now"\nexpectedTopic: Patient_Device_Monitoring\n  topic: off_topic\n';
  const out = render(spec, { DEVICE: 'Test8' }, { Patient_Device_Monitoring: 'Patient_Device_Monitoring_16j' });
  assert.equal(out.text, 'utterance: "Test8 now"\nexpectedTopic: Patient_Device_Monitoring_16j\n  topic: off_topic\n');
  assert.deepEqual(out.missing, []);
  assert.deepEqual(render('a {{NOPE}} b', {}).missing, ['{{NOPE}}']);
  for (const specPath of Object.values(SPECS)) {
    const keys = [...new Set([...read(specPath).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];
    for (const k of keys) assert.ok(['DEVICE', 'OTHER_DEVICE', 'VERIFIED_SESSION_ID'].includes(k), `${specPath}: eval-agents.sh does not fill {{${k}}}`);
  }
});

test('every golden retrieval question expects an SOP that exists, and ids are unique', () => {
  const golden = JSON.parse(read('test/agents/sop-retrieval-cases.json'));
  const sops = fs.readdirSync(path.join(ROOT, 'knowledge/sops')).map((f) => f.match(/^(SOP-WARD-\d{3})/)?.[1]).filter(Boolean);
  const ids = golden.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of golden.cases) {
    if (c.expect !== null) assert.ok(sops.includes(c.expect), `${c.id} expects ${c.expect}`);
    assert.ok(c.query.length >= 3 && c.query.length <= 500);
  }
  // Every SOP has at least one question, and one question is out of scope.
  for (const sop of sops) assert.ok(golden.cases.some((c) => c.expect === sop), `no golden question for ${sop}`);
  assert.ok(golden.cases.some((c) => c.expect === null));
});

test('the retrieval scorer counts hit@1, hit@3 and MRR, and fails under the thresholds', () => {
  const spec = {
    maxResults: 3,
    thresholds: { hitAt1: 0.75, hitAt3: 0.9 },
    cases: [
      { id: 'a', query: 'first', expect: 'SOP-WARD-001' },
      { id: 'b', query: 'second', expect: 'SOP-WARD-002' },
      { id: 'c', query: 'missing', expect: 'SOP-WARD-003' },
      { id: 'd', query: 'out of scope', expect: null },
    ],
  };
  const p = (...ids) => ({ passages: ids.map((sopId, i) => ({ sopId, score: 0.9 - i / 10 })) });
  const report = score(spec, {
    a: p('SOP-WARD-001', 'SOP-WARD-006'),
    b: p('SOP-WARD-006', 'SOP-WARD-002'),
    c: p('SOP-WARD-004'),
    d: p(),
  });
  assert.equal(report.metrics.hitAt1, 1 / 3);
  assert.equal(report.metrics.hitAt3, 2 / 3);
  assert.ok(Math.abs(report.metrics.mrr - (1 + 0.5) / 3) < 1e-9);
  assert.equal(report.metrics.outOfScopeRefused, 1);
  assert.deepEqual(report.results.map((r) => r.ok), [true, true, false, true]);
  assert.equal(report.pass, false);
  assert.equal(report.failures.length, 2);

  const good = score(spec, { a: p('SOP-WARD-001'), b: p('SOP-WARD-002'), c: p('SOP-WARD-003'), d: p() });
  assert.equal(good.pass, true);

  const xml = junit(report);
  assert.match(xml, /tests="4" failures="1"/);
  assert.match(xml, /expected SOP-WARD-003, got SOP-WARD-004/);
  assert.match(markdown(report), /hit@1 \*\*33%\*\*/);
});

test('an error answer fails its case and says why', () => {
  const report = score({ cases: [{ id: 'a', query: 'x?', expect: 'SOP-WARD-001' }] }, { a: { error: 'status 503: no index' } });
  assert.equal(report.results[0].ok, false);
  assert.match(junit(report), /status 503: no index/);
});
