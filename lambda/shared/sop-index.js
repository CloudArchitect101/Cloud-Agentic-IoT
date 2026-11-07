'use strict';

/*
 * The ward's standard operating procedures as a search index: reading an SOP
 * file (knowledge/sops/*.md), the shape of the index the knowledge-indexer
 * writes to S3, and ranking its passages against a question for
 * procedure-search. Plain code with no AWS calls, so both functions and
 * scripts/index-sops.sh use the same rules, and test/lambda/sop-index.test.js
 * tests them directly. docs/SOP-GROUNDING.md explains the design.
 *
 * Why an index in one S3 object and the ranking here, rather than a vector
 * database: the ward has a handful of procedures, a few dozen passages. One
 * GetObject and a few dozen dot products take less time than a call to any
 * vector store would, cost nothing while idle, and need no service the AWS
 * project's policy does not already allow.
 */

const crypto = require('node:crypto');

// The embedding model and size the index is built with. A question must be
// embedded with the same model and size as the passages it is compared to,
// so the index records both and procedure-search uses what it records.
const EMBED_MODEL = 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 512;   // Titan Text Embeddings V2 takes 256, 512 or 1024
const INDEX_FORMAT = 1;

const SOP_ID = /^SOP-[A-Z]{2,10}-\d{3}$/;
const SOP_ID_IN_TEXT = /\bSOP-[A-Z]{2,10}-\d{3}\b/gi;
const REQUIRED = ['id', 'title', 'version', 'owner', 'reviewed'];
const MAX_FIELD_CHARS = { id: 20, title: 120, version: 10, owner: 80, reviewed: 10 };

/**
 * One SOP file: front matter between two --- lines, then the body. The body's
 * "## " headings are its sections, and each section is a passage the agent
 * may quote. Text before the first heading (the sample notice) is not a
 * passage: it is the same in every SOP, so it would match every question.
 *
 *   parseSop(markdown, file) -> { id, title, version, owner, reviewed, file, sections: [{ heading, text }] }
 *
 * Throws an Error naming the file and what is wrong.
 */
function parseSop(markdown, file = '(unnamed)') {
  const problem = (what) => new Error(`${file}: ${what}`);
  if (typeof markdown !== 'string' || !markdown.trim()) throw problem('is empty');
  const text = markdown.replace(/\r\n?/g, '\n');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!front) throw problem('has no front matter: start the file with ---, the id, title, version, owner and reviewed lines, then ---');

  const fields = {};
  for (const line of front[1].split('\n')) {
    if (!line.trim()) continue;
    const pair = line.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (!pair) throw problem(`front matter line "${line.slice(0, 40)}" is not "key: value"`);
    fields[pair[1]] = pair[2];
  }
  for (const key of REQUIRED) {
    if (!fields[key]) throw problem(`front matter has no ${key}`);
    if (fields[key].length > MAX_FIELD_CHARS[key]) throw problem(`${key} is longer than ${MAX_FIELD_CHARS[key]} characters`);
  }
  if (!SOP_ID.test(fields.id)) throw problem(`id ${fields.id} is not like SOP-WARD-001`);
  if (!/^\d+\.\d+$/.test(fields.version)) throw problem(`version ${fields.version} is not like 1.0`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.reviewed)) throw problem(`reviewed ${fields.reviewed} is not a date like 2026-10-15`);

  const sections = [];
  let current = null;
  for (const line of text.slice(front[0].length).split('\n')) {
    const heading = line.match(/^## (.+?)\s*$/);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const kept = sections
    .map(({ heading, lines }) => ({ heading, text: lines.join('\n').trim() }))
    .filter((section) => section.text);
  if (!kept.length) throw problem('has no "## " section with text in it');
  return {
    id: fields.id, title: fields.title, version: fields.version, owner: fields.owner, reviewed: fields.reviewed,
    file, sections: kept,
  };
}

/**
 * What the index was built from, as one hash: every SOP file's name and text,
 * and the model and size. The indexer skips the work when it matches the
 * index already in S3, so a deploy that changed no SOP embeds nothing.
 */
function sourceHash(documents, model = EMBED_MODEL, dimensions = DIMENSIONS) {
  const hash = crypto.createHash('sha256');
  hash.update(`${INDEX_FORMAT}\n${model}\n${dimensions}\n`);
  for (const { file, markdown } of [...documents].sort((a, b) => (a.file < b.file ? -1 : Number(a.file > b.file)))) {
    hash.update(`${file}\n${markdown.length}\n${markdown}\n`);
  }
  return hash.digest('hex');
}

/** The text a passage is embedded as: the SOP's ID, title and section carry meaning its body alone loses. */
function embeddingText(sop, heading, text) {
  return `${sop.id} ${sop.title}\n${heading}\n\n${text}`;
}

/** The InvokeModel body for one text. normalize makes the cosine a dot product. */
function embeddingRequest(text, dimensions = DIMENSIONS) {
  return JSON.stringify({ inputText: text, dimensions, normalize: true });
}

/** The vector out of an InvokeModel response body (bytes or text). */
function embeddingFrom(body, dimensions = DIMENSIONS) {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  const { embedding } = JSON.parse(text);
  if (!Array.isArray(embedding) || embedding.length !== dimensions || !embedding.every(Number.isFinite)) {
    throw new Error(`The embedding model returned ${Array.isArray(embedding) ? embedding.length : 'no'} numbers, not ${dimensions}.`);
  }
  return embedding;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** SOP IDs a question names, upper-cased: "what does sop-ward-003 say" names SOP-WARD-003. */
function idsIn(text) {
  return [...new Set((String(text).match(SOP_ID_IN_TEXT) || []).map((id) => id.toUpperCase()))];
}

/**
 * The passages that best answer a question, best first.
 *
 *   rank(index, vector, { limit, minScore, question })
 *     -> [{ chunk, score, matchedBy: 'id' | 'meaning' }]
 *
 * A passage of an SOP the question names by ID comes first, whatever its
 * score: someone asking for SOP-WARD-003 wants that one. Otherwise a passage
 * scoring below minScore is left out, so a question no procedure covers gets
 * no passages instead of the least bad one, and the agent says so.
 */
function rank(index, vector, { limit = 3, minScore = 0.25, question = '' } = {}) {
  const named = new Set(idsIn(question));
  return index.chunks
    .map((chunk) => ({ chunk, score: cosine(vector, chunk.embedding), matchedBy: named.has(chunk.sopId) ? 'id' : 'meaning' }))
    .filter((hit) => hit.matchedBy === 'id' || hit.score >= minScore)
    .sort((a, b) => (a.matchedBy === b.matchedBy ? b.score - a.score : a.matchedBy === 'id' ? -1 : 1))
    .slice(0, limit);
}

/** Whether an object read from S3 is an index this code can search. */
function isIndex(value) {
  return Boolean(value) && value.format === INDEX_FORMAT && typeof value.model === 'string'
    && Number.isInteger(value.dimensions) && Array.isArray(value.chunks);
}

module.exports = {
  EMBED_MODEL,
  DIMENSIONS,
  INDEX_FORMAT,
  SOP_ID,
  parseSop,
  sourceHash,
  embeddingText,
  embeddingRequest,
  embeddingFrom,
  cosine,
  idsIn,
  rank,
  isIndex,
};
