const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrock = new BedrockRuntimeClient({});
const EMBED_MODEL = process.env.EMBED_MODEL || 'amazon.titan-embed-text-v2:0';

/**
 * Chunks care-team knowledge articles and embeds them for retrieval.
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

async function embed(text) {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: EMBED_MODEL,
    contentType: 'application/json',
    body: JSON.stringify({ inputText: text }),
  }));
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

exports.handler = async (event) => {
  const article = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

  if (!article?.title || !article?.content) {
    return { statusCode: 400, body: JSON.stringify({ error: 'title and content are required' }) };
  }

  const chunks = chunk(article.content);

  // Titles carry meaning that body chunks lose once split, so prepend it.
  // Without this, a chunk reading "administer 5mg" retrieves for the wrong drug.
  const records = [];
  for (let i = 0; i < chunks.length; i++) {
    const withContext = `${article.title}\n\n${chunks[i]}`;
    records.push({
      articleId: article.id,
      chunkIndex: i,
      text: chunks[i],
      embedding: await embed(withContext),
    });
  }

  console.log(`Indexed ${records.length} chunk(s) from "${article.title}"`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId: article.id, chunks: records.length }),
  };
};

exports.chunk = chunk;
