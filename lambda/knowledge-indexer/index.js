const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const sops = require('@cloud-agentic-iot/shared/sop-index');

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});

/**
 * Chunks the ward's standard operating procedures (knowledge/sops), embeds
 * them, and writes the search index procedure-search reads. Invoked by
 * scripts/index-sops.sh, which scripts/deploy-aws.sh runs on every deploy;
 * nothing else calls it. docs/SOP-GROUNDING.md explains the design.
 *
 * The chunking strategy is the whole ballgame. Fixed-size chunks split
 * sentences and produce retrievals that start mid-thought; the agent then
 * quotes half a clinical instruction, which in a healthcare context is worse
 * than returning nothing.
 */
const MAX_CHARS = 1200;
const OVERLAP = 200;

/**
 * Splits on paragraph boundaries first, falling back to sentence boundaries,
 * and only hard-splits when a single sentence exceeds the window. Overlap
 * carries context across the seam so a fact spanning two chunks is still
 * retrievable from either.
 */
function chunk(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > MAX_CHARS) {
      flush();
      // A single sentence can exceed the window on its own (tables, long
      // dosage lists). Left unsplit it silently overflows the embedding
      // model's input and the tail is dropped without any error.
      const pieces = splitSentences(para)
        .flatMap((s) => (s.length > MAX_CHARS ? hardSplit(s) : [s]));
      chunks.push(...packSentences(pieces));
    } else if ((current + '\n\n' + para).length > MAX_CHARS) {
      flush();
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  flush();
  return chunks;
}

/**
 * A sentence ends at . ! or ? (and any closing quote or bracket) followed by
 * whitespace or the end of the text. Requiring the whitespace is what keeps
 * "2.5 mg" in one piece, and text after the last full stop is kept as a
 * sentence of its own rather than dropped.
 */
function splitSentences(text) {
  return text.split(/(?<=[.!?]["'\u201D\u2019)\]]*)\s+/).filter(Boolean);
}

/**
 * Packs whole sentences into chunks of at most MAX_CHARS. The overlap is the
 * trailing whole sentences of the previous chunk, up to OVERLAP characters,
 * so a chunk never starts mid-sentence and the overlap can never push a chunk
 * past the cap.
 */
function packSentences(sentences) {
  const chunks = [];
  let buf = [];
  let len = 0;
  const joined = (a, b) => (a ? a + 1 + b : b);   // length after joining with a space

  for (const s of sentences) {
    if (joined(len, s.length) <= MAX_CHARS) {
      buf.push(s);
      len = joined(len, s.length);
      continue;
    }
    if (buf.length) chunks.push(buf.join(' '));

    const carry = [];
    let carryLen = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const next = joined(carryLen, buf[i].length);
      if (next > OVERLAP || joined(next, s.length) > MAX_CHARS) break;
      carry.unshift(buf[i]);
      carryLen = next;
    }
    buf = [...carry, s];
    len = joined(carryLen, s.length);
  }
  if (buf.length) chunks.push(buf.join(' '));
  return chunks;
}

/**
 * Splits one over-long sentence into windows of at most MAX_CHARS that end
 * at whitespace where there is any. Each window after the first starts up to
 * OVERLAP characters back, also at whitespace, and the last window ends at
 * the end of the text, so no window repeats only overlap.
 */
function hardSplit(text) {
  const pieces = [];
  let start = 0;
  for (;;) {
    let end = Math.min(start + MAX_CHARS, text.length);
    if (end < text.length) {
      const cut = lastWhitespace(text, start + 1, end);
      if (cut !== -1) end = cut;
    }
    const piece = text.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (end >= text.length) return pieces;

    const back = firstWhitespace(text, Math.max(start + 1, end - OVERLAP), end);
    start = back === -1 ? end : back + 1;
  }
}

function lastWhitespace(text, from, to) {
  for (let i = to; i >= from; i--) if (/\s/.test(text[i])) return i;
  return -1;
}

function firstWhitespace(text, from, to) {
  for (let i = from; i < to; i++) if (/\s/.test(text[i])) return i;
  return -1;
}

// What one run may be asked to index. The ward has seven; this bounds what a
// mistaken invoke costs, and keeps the index one small S3 object.
const MAX_DOCUMENTS = 50;
const MAX_CHUNKS = 400;

async function embed(text) {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: sops.EMBED_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: sops.embeddingRequest(text, sops.DIMENSIONS),
  }));
  return sops.embeddingFrom(res.body, sops.DIMENSIONS);
}

/** The index in S3 now, or null when there is none (or it cannot be read as one). */
async function currentIndex() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: process.env.INDEX_BUCKET, Key: process.env.INDEX_KEY }));
    const index = JSON.parse(await res.Body.transformToString());
    return sops.isIndex(index) ? index : null;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Passages of one SOP: a section each, split further only when a section is over the cap. */
function chunksOf(sop) {
  return sop.sections.flatMap(({ heading, text }) => chunk(text).map((piece) => ({ heading, text: piece })));
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/**
 *   { documents: [{ file, markdown }], force? }
 *     -> { ok, unchanged, documents, chunks, sourceHash } or { ok: false, problems }
 *
 * The whole index is rebuilt and replaced in one PutObject, so an SOP
 * removed from the repo is removed from the index, and a reader never sees
 * half of a new index. When the SOP files are what the current index was
 * built from, nothing is embedded or written (force: true rebuilds anyway).
 */
exports.handler = async (event = {}) => {
  const documents = event.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    return { ok: false, problems: ['documents must be a list of { file, markdown }, one per SOP file'] };
  }
  if (documents.length > MAX_DOCUMENTS) {
    return { ok: false, problems: [`at most ${MAX_DOCUMENTS} SOP files are indexed at once, not ${documents.length}`] };
  }

  const problems = [];
  const parsed = [];
  const seen = new Map();
  for (const doc of documents) {
    const file = typeof doc?.file === 'string' && doc.file ? doc.file : '(unnamed)';
    try {
      const sop = sops.parseSop(doc?.markdown, file);
      if (seen.has(sop.id)) problems.push(`${file}: ${sop.id} is also the id of ${seen.get(sop.id)}`);
      seen.set(sop.id, file);
      parsed.push(sop);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (problems.length) return { ok: false, problems };

  const hash = sops.sourceHash(documents.map(({ file, markdown }) => ({ file, markdown })));
  const existing = await currentIndex();
  if (!event.force && existing && existing.sourceHash === hash) {
    console.log(`Index unchanged: ${existing.documents.length} SOP(s), ${existing.chunks.length} passage(s)`);
    return { ok: true, unchanged: true, documents: existing.documents.length, chunks: existing.chunks.length, sourceHash: hash };
  }

  const pending = parsed.flatMap((sop) => chunksOf(sop).map((piece, i) => ({ sop, piece, i })));
  if (pending.length > MAX_CHUNKS) {
    return { ok: false, problems: [`the SOPs make ${pending.length} passages, more than the ${MAX_CHUNKS} one index holds`] };
  }

  // One at a time: a few dozen calls, and Bedrock's on-demand quota for a
  // new account can be low, so a burst would only be throttled.
  const chunks = [];
  for (const { sop, piece, i } of pending) {
    const embedding = await embed(sops.embeddingText(sop, piece.heading, piece.text));
    chunks.push({
      sopId: sop.id, title: sop.title, version: sop.version, owner: sop.owner, reviewed: sop.reviewed,
      section: piece.heading, chunkIndex: i, text: piece.text, embedding: embedding.map(round),
    });
  }

  const index = {
    format: sops.INDEX_FORMAT,
    model: sops.EMBED_MODEL,
    dimensions: sops.DIMENSIONS,
    builtAt: new Date().toISOString(),
    sourceHash: hash,
    documents: parsed.map(({ id, title, version, owner, reviewed, file }) => ({ id, title, version, owner, reviewed, file })),
    chunks,
  };
  await s3.send(new PutObjectCommand({
    Bucket: process.env.INDEX_BUCKET,
    Key: process.env.INDEX_KEY,
    Body: JSON.stringify(index),
    ContentType: 'application/json',
  }));

  console.log(`Indexed ${chunks.length} passage(s) from ${parsed.length} SOP(s)`);
  return { ok: true, unchanged: false, documents: parsed.length, chunks: chunks.length, sourceHash: hash };
};

exports.chunk = chunk;
