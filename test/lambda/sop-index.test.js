'use strict';

// lambda/shared/sop-index.js reads the ward's SOP files and ranks their
// passages, and knowledge/sops holds the SOPs themselves. These tests check
// the rules, and that the SOPs say what the system actually does: the
// room-temperature numbers in SOP-WARD-001 are the ones config/<env>.json
// gives AWS.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sops = require('../../lambda/shared/sop-index');
const { payload } = require('../../scripts/lib/sop-payload');
const { maskPii } = require('../../lambda/shared/guardrails');

const root = path.join(__dirname, '../..');

const doc = (front, body = '## Steps\n\n1. Do the thing.\n') => `---\n${front}\n---\n\n> Notice.\n\n${body}`;
const FRONT = 'id: SOP-WARD-001\ntitle: Room temperature excursion\nversion: 1.2\nowner: Ward charge nurse\nreviewed: 2026-10-15';

test('an SOP file reads as its front matter and one passage per "## " section', () => {
  const sop = sops.parseSop(doc(FRONT, '## When\n\nA room is hot.\n\n## Steps\n\n1. Go.\n2. Check.\n\n## Empty\n\n'), 'a.md');
  assert.deepEqual(sop, {
    id: 'SOP-WARD-001', title: 'Room temperature excursion', version: '1.2', owner: 'Ward charge nurse',
    reviewed: '2026-10-15', file: 'a.md',
    sections: [{ heading: 'When', text: 'A room is hot.' }, { heading: 'Steps', text: '1. Go.\n2. Check.' }],
  });
  // Windows line endings read the same.
  assert.deepEqual(sops.parseSop(doc(FRONT).replace(/\n/g, '\r\n'), 'a.md').sections, [{ heading: 'Steps', text: '1. Do the thing.' }]);
});

test('an SOP file with a missing or malformed field is refused, naming the file and the field', () => {
  const cases = {
    'has no front matter': 'just text',
    'front matter has no owner': doc(FRONT.replace(/owner: .*\n/, '')),
    'id SOP-1 is not like SOP-WARD-001': doc(FRONT.replace('SOP-WARD-001', 'SOP-1')),
    'version v1 is not like 1.0': doc(FRONT.replace('1.2', 'v1')),
    'reviewed last week is not a date': doc(FRONT.replace('2026-10-15', 'last week')),
    'is not "key: value"': doc(`${FRONT}\njust words`),
    'title is longer than 120 characters': doc(FRONT.replace('Room temperature excursion', 'x'.repeat(121))),
    'has no "## " section with text in it': doc(FRONT, 'No headings here.\n'),
  };
  for (const [message, markdown] of Object.entries(cases)) {
    assert.throws(() => sops.parseSop(markdown, 'knowledge/sops/x.md'), (err) => {
      assert.ok(err.message.startsWith('knowledge/sops/x.md: '), err.message);
      assert.ok(err.message.includes(message), `${err.message} should say ${message}`);
      return true;
    });
  }
  assert.throws(() => sops.parseSop(undefined, 'y.md'), /y\.md: is empty/);
});

test('the source hash changes with any file, its name, the model or the size, and not with their order', () => {
  const a = { file: 'a.md', markdown: 'one' };
  const b = { file: 'b.md', markdown: 'two' };
  const base = sops.sourceHash([a, b]);
  assert.equal(sops.sourceHash([b, a]), base);
  assert.notEqual(sops.sourceHash([a, { ...b, markdown: 'two!' }]), base);
  assert.notEqual(sops.sourceHash([a, { ...b, file: 'c.md' }]), base);
  assert.notEqual(sops.sourceHash([a]), base);
  assert.notEqual(sops.sourceHash([a, b], 'other-model'), base);
  assert.notEqual(sops.sourceHash([a, b], sops.EMBED_MODEL, 1024), base);
});

test('embedding requests and answers are checked for the size the index uses', () => {
  assert.deepEqual(JSON.parse(sops.embeddingRequest('hi')), { inputText: 'hi', dimensions: 512, normalize: true });
  const body = new TextEncoder().encode(JSON.stringify({ embedding: new Array(512).fill(0.1) }));
  assert.equal(sops.embeddingFrom(body).length, 512);
  assert.throws(() => sops.embeddingFrom(JSON.stringify({ embedding: [1, 2] })), /2 numbers, not 512/);
  assert.throws(() => sops.embeddingFrom(JSON.stringify({})), /no numbers/);
});

test('ranking: best first, below the floor left out, and an SOP named by ID first whatever its score', () => {
  const chunk = (sopId, embedding) => ({ sopId, embedding });
  const index = { chunks: [chunk('SOP-WARD-001', [1, 0]), chunk('SOP-WARD-002', [0.8, 0.6]), chunk('SOP-WARD-003', [0, 1])] };
  const best = sops.rank(index, [1, 0], { limit: 3, minScore: 0.5 });
  assert.deepEqual(best.map((h) => h.chunk.sopId), ['SOP-WARD-001', 'SOP-WARD-002']);
  assert.deepEqual(best.map((h) => h.matchedBy), ['meaning', 'meaning']);
  assert.equal(best[0].score, 1);

  const named = sops.rank(index, [1, 0], { limit: 2, minScore: 0.5, question: 'what does sop-ward-003 say?' });
  assert.deepEqual(named.map((h) => [h.chunk.sopId, h.matchedBy]), [['SOP-WARD-003', 'id'], ['SOP-WARD-001', 'meaning']]);

  assert.deepEqual(sops.rank(index, [-1, 0], { minScore: 0.25 }), []);
  assert.deepEqual(sops.idsIn('SOP-WARD-001 and sop-ward-001, SOP-PHARM-010'), ['SOP-WARD-001', 'SOP-PHARM-010']);
  assert.equal(sops.cosine([0, 0], [1, 1]), 0);
});

test('an object is searched only when it is an index of this format', () => {
  assert.equal(sops.isIndex({ format: 1, model: 'm', dimensions: 512, chunks: [] }), true);
  for (const bad of [null, {}, { format: 2, model: 'm', dimensions: 512, chunks: [] }, { format: 1, model: 'm', dimensions: '512', chunks: [] }]) {
    assert.equal(sops.isIndex(bad), false, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------ the SOPs

const ward = () => payload().documents.map(({ file, markdown }) => ({ ...sops.parseSop(markdown, file), markdown }));

test('every SOP in knowledge/sops reads, has its own ID, matches its file name, and says it is a sample', () => {
  const all = ward();
  assert.ok(all.length >= 5 && all.length <= 8, `${all.length} SOPs`);
  assert.equal(new Set(all.map((s) => s.id)).size, all.length);
  for (const sop of all) {
    assert.ok(path.basename(sop.file).startsWith(`${sop.id}-`), `${sop.file} should start with ${sop.id}-`);
    assert.match(sop.markdown, /Sample procedure for the Smart Ward demo\. Fictional, not clinical advice/, sop.file);
    assert.ok(sop.sections.some((s) => /steps|levels/i.test(s.heading)), `${sop.file} has no steps`);
    // An SOP is quoted to the care team as it is: nothing in it may need masking.
    assert.equal(maskPii(sop.markdown).masked, 0, `${sop.file} holds something that looks like personal data`);
  }
});

test('every SOP an SOP refers to exists', () => {
  const all = ward();
  const ids = new Set(all.map((s) => s.id));
  for (const sop of all) {
    for (const named of sops.idsIn(sop.markdown)) assert.ok(ids.has(named), `${sop.file} refers to ${named}, which no SOP is`);
  }
});

// Dev's numbers: the rule runs in Dev only (RoomTempAlert is "false" in
// Prod's config), and the demo SOPs describe the demo ward.
test('SOP-WARD-001 gives the room-temperature rule the numbers AWS runs it with in Dev', () => {
  const sop = ward().find((s) => s.id === 'SOP-WARD-001');
  const marginLine = fs.readFileSync(path.join(root, 'lambda/patient-vitals/index.js'), 'utf8').match(/ROOM_TEMP_REARM_MARGIN_C = (\d+(?:\.\d+)?)/);
  assert.ok(marginLine, 'patient-vitals no longer declares ROOM_TEMP_REARM_MARGIN_C');
  for (const env of ['Dev']) {
    const vitals = JSON.parse(fs.readFileSync(path.join(root, `config/${env}.json`), 'utf8')).stacks['patient-vitals'];
    const threshold = Number(vitals.RoomTempAlertCelsius).toFixed(1);
    assert.equal(vitals.RoomTempAlert, 'true');
    const rearm = (vitals.RoomTempAlertCelsius - Number(marginLine[1])).toFixed(1);
    assert.match(sop.markdown, new RegExp(`${threshold.replace('.', '\\.')} C or higher`), `${env}: threshold`);
    assert.match(sop.markdown, new RegExp(`below ${rearm.replace('.', '\\.')} C`), `${env}: re-arm`);
    assert.match(sop.markdown, new RegExp(`at most every ${vitals.RealertIntervalMinutes} minutes`), `${env}: re-report`);
  }
});
