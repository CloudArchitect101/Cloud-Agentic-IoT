'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadWithFakes, fakeBedrockEmbeddings, fakeS3, captureConsole, withEnv, awsError,
} = require('../helpers/fakes');
const { payload } = require('../../scripts/lib/sop-payload');

const HANDLER = path.join(__dirname, '../../lambda/knowledge-indexer/index.js');
const MAX_CHARS = 1200;
const OVERLAP = 200;

const BUCKET = 'index-bucket';
const KEY = 'sops/index.json';

function load({ objects = {}, bedrockFail, s3Fail } = {}) {
  const bedrock = fakeBedrockEmbeddings({ fail: bedrockFail });
  const s3 = fakeS3(objects, { fail: s3Fail });
  const mod = loadWithFakes(HANDLER, {
    '@aws-sdk/client-bedrock-runtime': bedrock.sdk,
    '@aws-sdk/client-s3': s3.sdk,
  });
  return { ...mod, calls: bedrock.calls, s3 };
}

const { chunk } = load();

const sentence = (n) => `Sentence ${n} explains a clinical step for the care team in plain words here.`;
const paragraphOf = (count) => Array.from({ length: count }, (_, i) => sentence(i)).join(' ');
const longSentence = (n) => `Step ${n}: ${'administer the dose and record it in the chart '.repeat(22)}.`;

/** Every word of the input appears in the output, in order. Overlap may repeat words. */
function assertNoTextLost(input, chunks) {
  const want = input.split(/\s+/).filter(Boolean);
  const have = chunks.join(' ').split(/\s+/).filter(Boolean);
  let i = 0;
  for (const word of have) if (word === want[i]) i++;
  assert.equal(i, want.length, `lost text after "${want.slice(Math.max(0, i - 3), i).join(' ')}"`);
}

test('no chunk exceeds the cap, whatever the input', () => {
  const inputs = {
    'many short sentences': paragraphOf(60),
    // Used to produce 1,243-character chunks: overlap plus a long sentence.
    'sentences close to the cap': [1, 2, 3].map(longSentence).join(' '),
    'one sentence of 3,500 characters': 'word '.repeat(700).trim(),
    'mixed paragraphs': [paragraphOf(3), longSentence(1), paragraphOf(20), 'Short closing note.'].join('\n\n'),
  };
  for (const [name, input] of Object.entries(inputs)) {
    const chunks = chunk(input);
    assert.ok(chunks.length > 0, name);
    for (const c of chunks) assert.ok(c.length <= MAX_CHARS, `${name}: chunk of ${c.length}`);
    assertNoTextLost(input, chunks);
  }

  // With no whitespace there is no word boundary to cut at or overlap from.
  const unbroken = 'x'.repeat(3000);
  const pieces = chunk(unbroken);
  for (const c of pieces) assert.ok(c.length <= MAX_CHARS);
  assert.equal(pieces.join(''), unbroken);
});

test('every chunk starts at the start of a sentence', () => {
  // Used to start mid-word, e.g. "ical step for the care team".
  const chunks = chunk(paragraphOf(60));
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.match(c, /^Sentence \d+ explains/);
});

test('the overlap is the previous chunk\'s last whole sentences, within OVERLAP', () => {
  const chunks = chunk(paragraphOf(60));
  for (let i = 1; i < chunks.length; i++) {
    // Sentences here are unique, so the overlap is the leading run of the
    // current chunk's sentences that also appear in the previous chunk.
    const previous = chunks[i - 1].split(/(?<=\.) /);
    const current = chunks[i].split(/(?<=\.) /);
    const overlap = current.slice(0, current.findIndex((s) => !previous.includes(s)));
    assert.ok(overlap.length >= 1, `chunk ${i} carries no overlap`);
    assert.deepEqual(overlap, previous.slice(previous.length - overlap.length), `chunk ${i}`);
    assert.ok(overlap.join(' ').length <= OVERLAP, `chunk ${i} overlap of ${overlap.join(' ').length}`);
  }
});

test('text after the last full stop is kept', () => {
  // The old sentence pattern kept only the final word, "unsure". The
  // paragraph is over the cap, so it goes through sentence splitting.
  const text = `${paragraphOf(20)} Call the pharmacist if unsure`;
  const chunks = chunk(text);
  assert.ok(chunks.at(-1).endsWith('Call the pharmacist if unsure'));
  assertNoTextLost(text, chunks);
});

test('a decimal point is not a sentence boundary', () => {
  // Slide the dose across the point where a chunk fills up. Splitting at the
  // decimal used to let a chunk end on "Give 2." with the "5 mg" in the next.
  for (let pad = 0; pad < 60; pad++) {
    const text = `${paragraphOf(15)} ${'word '.repeat(pad)}Give 2.5 mg twice daily. ${paragraphOf(5)}`;
    for (const c of chunk(text)) {
      if (c.includes('Give 2')) assert.ok(c.includes('Give 2.5 mg twice daily.'), `pad ${pad}: ${c.slice(-40)}`);
    }
  }
});

test('short paragraphs are grouped up to the cap', () => {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. ${'detail '.repeat(60).trim()}.`);
  const chunks = chunk(paragraphs.join('\n\n'));
  assert.ok(chunks.length < paragraphs.length);
  assert.equal(chunks.join('\n\n'), paragraphs.join('\n\n'));
});

test('a sentence longer than the cap is split at whitespace', () => {
  const text = 'dose '.repeat(700).trim();
  const chunks = chunk(text);
  assert.ok(chunks.length > 2);
  for (const c of chunks) assert.match(c, /^dose( dose)*$/);
});

const sop = (id, extra = '') => ({
  file: `knowledge/sops/${id}.md`,
  markdown: `---\nid: ${id}\ntitle: Title of ${id}\nversion: 1.0\nowner: Ward charge nurse\nreviewed: 2026-10-15\n---\n\n`
    + `> Sample notice.\n\n## When this applies\n\nA room reads hot.${extra}\n\n## Steps\n\n1. Go to the room.\n2. Call facilities.\n`,
});

function setup(t) {
  captureConsole(t);
  withEnv(t, { INDEX_BUCKET: BUCKET, INDEX_KEY: KEY });
}

test('the handler embeds a passage per section, with the SOP ID, title and section, and writes one index', async (t) => {
  setup(t);
  const { handler, calls, s3 } = load();
  const res = await handler({ documents: [sop('SOP-WARD-001'), sop('SOP-WARD-002')] });

  assert.deepEqual({ ok: res.ok, unchanged: res.unchanged, documents: res.documents, chunks: res.chunks },
    { ok: true, unchanged: false, documents: 2, chunks: 4 });
  assert.equal(calls.length, 4);
  const first = JSON.parse(calls[0].input.body);
  assert.equal(calls[0].input.modelId, 'amazon.titan-embed-text-v2:0');
  assert.deepEqual({ dimensions: first.dimensions, normalize: first.normalize }, { dimensions: 512, normalize: true });
  assert.ok(first.inputText.startsWith('SOP-WARD-001 Title of SOP-WARD-001\nWhen this applies\n\n'), first.inputText);
  // The sample notice is in every SOP, so it is never a passage.
  for (const call of calls) assert.doesNotMatch(JSON.parse(call.input.body).inputText, /Sample notice/);

  const puts = s3.calls.filter((c) => c.command === 'PutObjectCommand');
  assert.equal(puts.length, 1);
  assert.deepEqual([puts[0].input.Bucket, puts[0].input.Key, puts[0].input.ContentType], [BUCKET, KEY, 'application/json']);
  const index = JSON.parse(s3.store.get(`${BUCKET}/${KEY}`));
  assert.equal(index.format, 1);
  assert.equal(index.model, 'amazon.titan-embed-text-v2:0');
  assert.equal(index.dimensions, 512);
  assert.deepEqual(index.documents.map((d) => d.id), ['SOP-WARD-001', 'SOP-WARD-002']);
  assert.deepEqual(index.chunks.map((c) => `${c.sopId} ${c.section}`), [
    'SOP-WARD-001 When this applies', 'SOP-WARD-001 Steps', 'SOP-WARD-002 When this applies', 'SOP-WARD-002 Steps',
  ]);
  for (const c of index.chunks) {
    assert.equal(c.embedding.length, 512);
    assert.deepEqual([c.version, c.owner, c.reviewed], ['1.0', 'Ward charge nurse', '2026-10-15']);
  }
  assert.equal(index.chunks[1].text, '1. Go to the room.\n2. Call facilities.');
});

test('an unchanged set of SOPs embeds nothing and writes nothing; force rebuilds it', async (t) => {
  setup(t);
  const first = load();
  await first.handler({ documents: [sop('SOP-WARD-001')] });
  const built = first.s3.store.get(`${BUCKET}/${KEY}`);

  const again = load({ objects: { [`${BUCKET}/${KEY}`]: built } });
  const res = await again.handler({ documents: [sop('SOP-WARD-001')] });
  assert.equal(res.unchanged, true);
  assert.equal(res.chunks, 2);
  assert.equal(again.calls.length, 0);
  assert.ok(!again.s3.calls.some((c) => c.command === 'PutObjectCommand'));

  const forced = load({ objects: { [`${BUCKET}/${KEY}`]: built } });
  assert.equal((await forced.handler({ documents: [sop('SOP-WARD-001')], force: true })).unchanged, false);
  assert.equal(forced.calls.length, 2);

  // A changed SOP, or one removed, is a different set.
  const edited = load({ objects: { [`${BUCKET}/${KEY}`]: built } });
  assert.equal((await edited.handler({ documents: [sop('SOP-WARD-001', ' Edited.')] })).unchanged, false);
  const index = JSON.parse(edited.s3.store.get(`${BUCKET}/${KEY}`));
  assert.match(index.chunks[0].text, /Edited\./);
});

test('an index in S3 that cannot be read is rebuilt; any other S3 failure fails the run', async (t) => {
  setup(t);
  const garbled = load({ objects: { [`${BUCKET}/${KEY}`]: 'not json' } });
  assert.equal((await garbled.handler({ documents: [sop('SOP-WARD-001')] })).ok, true);

  const denied = load({ s3Fail: () => { throw awsError('AccessDenied', 'Access Denied'); } });
  await assert.rejects(denied.handler({ documents: [sop('SOP-WARD-001')] }), /Access Denied/);
});

test('a Bedrock failure fails the run and writes no index', async (t) => {
  setup(t);
  const { handler, s3 } = load({ bedrockFail: () => { throw awsError('AccessDeniedException', 'no access to the model'); } });
  await assert.rejects(handler({ documents: [sop('SOP-WARD-001')] }), /no access to the model/);
  assert.ok(!s3.calls.some((c) => c.command === 'PutObjectCommand'));
});

test('bad SOPs are refused together, by file, before anything is embedded', async (t) => {
  setup(t);
  const { handler, calls, s3 } = load();
  const res = await handler({
    documents: [
      sop('SOP-WARD-001'),
      { file: 'knowledge/sops/copy.md', markdown: sop('SOP-WARD-001').markdown },
      { file: 'knowledge/sops/blank.md', markdown: '' },
      { markdown: 'no front matter' },
    ],
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.problems, [
    'knowledge/sops/copy.md: SOP-WARD-001 is also the id of knowledge/sops/SOP-WARD-001.md',
    'knowledge/sops/blank.md: is empty',
    '(unnamed): has no front matter: start the file with ---, the id, title, version, owner and reviewed lines, then ---',
  ]);
  assert.equal(calls.length, 0);
  assert.equal(s3.calls.length, 0);

  assert.equal((await handler({})).ok, false);
  assert.equal((await handler({ documents: [] })).ok, false);
  const many = Array.from({ length: 51 }, (_, i) => sop(`SOP-WARD-${String(i).padStart(3, '0')}`));
  assert.match((await handler({ documents: many })).problems[0], /at most 50/);
});

test('a section over the cap is split into passages that each keep the section name', async (t) => {
  setup(t);
  const { handler, s3 } = load();
  const long = sop('SOP-WARD-001', ` ${paragraphOf(40)}`);
  const res = await handler({ documents: [long] });
  assert.ok(res.chunks > 2);
  const index = JSON.parse(s3.store.get(`${BUCKET}/${KEY}`));
  const first = index.chunks.filter((c) => c.section === 'When this applies');
  assert.ok(first.length > 1);
  assert.deepEqual(first.map((c) => c.chunkIndex), first.map((_, i) => i));
  for (const c of index.chunks) assert.ok(c.text.length <= MAX_CHARS);
});

test('the repository\'s own SOPs index, as scripts/index-sops.sh sends them', async (t) => {
  setup(t);
  const { handler, s3 } = load();
  const res = await handler(payload());
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  const index = JSON.parse(s3.store.get(`${BUCKET}/${KEY}`));
  assert.ok(index.documents.length >= 5 && index.documents.length <= 8, `${index.documents.length} SOPs`);
  assert.equal(JSON.stringify(index).length < 1024 * 1024, true, 'the index stays a small object');
});
