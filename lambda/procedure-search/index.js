'use strict';

/*
 * POST /find-procedure: the ward procedure passages that best answer a
 * question, for the Patient Care Agent's Find Procedure action
 * (ProcedureSearchAgentAction in Salesforce, through the AWS_IoT_Relay Named
 * Credential, like every other route of the device API).
 *
 *   { "query": "room is 31 degrees, what do I do", "maxResults": 3 }
 *     -> 200 { passages: [{ sopId, title, version, owner, reviewed, section, score, matchedBy, text }],
 *              masked, blocked, indexBuiltAt, notice }
 *
 * The index is one S3 object the knowledge-indexer writes on every deploy
 * (scripts/index-sops.sh). It is read once and kept for CACHE_SECONDS, so a
 * warm function answers with one Bedrock call: the question's embedding.
 *
 * Guardrails (lambda/shared/guardrails.js): the question is masked before it
 * is embedded, so a name or number typed into it never reaches the model,
 * and is screened as a tripwire (logged, not refused). Every passage is
 * masked on its way out, and one that still carries what an answer must
 * never carry is dropped. The question itself is never logged.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const sops = require('@cloud-agentic-iot/shared/sop-index');
const { maskPii, checkInput, checkOutput } = require('@cloud-agentic-iot/shared/guardrails');

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});

const MIN_QUERY_CHARS = 3;
const MAX_QUERY_CHARS = 500;
const DEFAULT_RESULTS = 3;
const MAX_RESULTS = 5;

const NOTICE = 'Sample procedures for the Smart Ward demo: fictional, not clinical advice. '
  + 'Cite the SOP ID and version of each passage you use.';

let cached = null;   // { index, readAt }

function setting(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

const answer = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const refuse = (statusCode, reason, error) => answer(statusCode, { reason, error });

async function loadIndex() {
  const maxAge = setting('CACHE_SECONDS', 300) * 1000;
  if (cached && Date.now() - cached.readAt < maxAge) return cached.index;
  const res = await s3.send(new GetObjectCommand({ Bucket: process.env.INDEX_BUCKET, Key: process.env.INDEX_KEY }));
  const index = JSON.parse(await res.Body.transformToString());
  if (!sops.isIndex(index)) throw Object.assign(new Error('not an index'), { name: 'NotAnIndex' });
  cached = { index, readAt: Date.now() };
  return index;
}

async function embed(text, index) {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: index.model,
    contentType: 'application/json',
    accept: 'application/json',
    body: sops.embeddingRequest(text, index.dimensions),
  }));
  return sops.embeddingFrom(res.body, index.dimensions);
}

function readBody(event) {
  if (event && typeof event.body === 'string') {
    const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(text);
  }
  return event && event.body && typeof event.body === 'object' ? event.body : event;
}

exports.handler = async (event) => {
  let body;
  try {
    body = readBody(event);
  } catch {
    return refuse(400, 'bad-request', 'The body is not JSON.');
  }
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (query.length < MIN_QUERY_CHARS || query.length > MAX_QUERY_CHARS) {
    return refuse(400, 'bad-request', `query must be ${MIN_QUERY_CHARS} to ${MAX_QUERY_CHARS} characters of text.`);
  }
  const asked = body.maxResults;
  if (asked !== undefined && asked !== null && !Number.isInteger(asked)) {
    return refuse(400, 'bad-request', 'maxResults must be a whole number.');
  }
  const limit = Math.min(Math.max(asked || DEFAULT_RESULTS, 1), MAX_RESULTS);

  const screened = checkInput(query);
  if (screened.flagged) console.warn('find-procedure question flagged for review', { signals: screened.signals });
  const question = maskPii(query);

  let index;
  try {
    index = await loadIndex();
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.name === 'NotAnIndex' || err instanceof SyntaxError) {
      return refuse(503, 'no-index', 'No procedures are indexed yet. Run scripts/index-sops.sh for this environment.');
    }
    console.error('find-procedure could not read the index', { name: err.name, message: err.message });
    return refuse(502, 'index-unreadable', 'The procedure index could not be read.');
  }

  let vector;
  try {
    vector = await embed(question.text, index);
  } catch (err) {
    console.error('find-procedure could not embed the question', { name: err.name, message: err.message });
    if (err.name === 'AccessDeniedException') {
      return refuse(502, 'bedrock-denied', `Bedrock refused ${index.model}. Check that the model is available in this Region.`);
    }
    if (err.name === 'ThrottlingException') return refuse(429, 'bedrock-busy', 'Bedrock is busy. Try again in a minute.');
    return refuse(502, 'embedding-failed', 'The question could not be embedded.');
  }

  const hits = sops.rank(index, vector, { limit, minScore: setting('MIN_SCORE', 0.25), question: question.text });
  let masked = question.masked;
  let blocked = 0;
  const passages = [];
  for (const { chunk, score, matchedBy } of hits) {
    const text = maskPii(chunk.text);
    masked += text.masked;
    if (!checkOutput(text.text).allowed) {
      blocked++;
      continue;
    }
    passages.push({
      sopId: chunk.sopId,
      title: chunk.title,
      version: chunk.version,
      owner: chunk.owner,
      reviewed: chunk.reviewed,
      section: chunk.section,
      score: Math.round(score * 1000) / 1000,
      matchedBy,
      text: text.text,
    });
  }
  if (masked) console.log('find-procedure masked', { masked });
  if (blocked) console.warn('find-procedure blocked passages', { blocked });

  return answer(200, {
    passages,
    masked,
    blocked,
    inputFlagged: Boolean(screened.flagged),
    indexBuiltAt: index.builtAt,
    notice: NOTICE,
  });
};
