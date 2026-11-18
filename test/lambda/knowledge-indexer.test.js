'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, captureConsole } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/knowledge-indexer/index.js');
const MAX_CHARS = 1200;
const OVERLAP = 200;

function load() {
  const bedrock = fakeAwsSdk('BedrockRuntimeClient', ['InvokeModelCommand'], () => ({
    body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2, 0.3] })),
  }));
  const mod = loadWithFakes(HANDLER, { '@aws-sdk/client-bedrock-runtime': bedrock.sdk });
  return { ...mod, calls: bedrock.calls };
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

test('the handler embeds each chunk with the article title prepended', async (t) => {
  captureConsole(t);
  const { handler, calls } = load();
  const res = await handler({
    body: JSON.stringify({ id: 'KA-1', title: 'Insulin dosing', content: paragraphOf(40) }),
  });

  assert.equal(res.statusCode, 200);
  const { chunks } = JSON.parse(res.body);
  assert.equal(calls.length, chunks);
  for (const call of calls) {
    assert.ok(JSON.parse(call.input.body).inputText.startsWith('Insulin dosing\n\n'));
  }
});

test('the handler requires a title and content', async (t) => {
  captureConsole(t);
  const { handler } = load();
  const res = await handler({ body: JSON.stringify({ title: 'Empty' }) });
  assert.equal(res.statusCode, 400);
});
