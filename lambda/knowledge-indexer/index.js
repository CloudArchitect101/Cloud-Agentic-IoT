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
      const sentences = para.match(/[^.!?]+[.!?]+|\S+$/g) || [para];
      let buf = '';
      for (const s of sentences) {
        // A single sentence can exceed the window on its own (tables, long
        // dosage lists). Left unsplit it silently overflows the embedding
        // model's input and the tail is dropped without any error.
        if (s.length > MAX_CHARS) {
          if (buf.trim()) chunks.push(buf.trim());
          buf = '';
          for (let i = 0; i < s.length; i += MAX_CHARS - OVERLAP) {
            chunks.push(s.slice(i, i + MAX_CHARS).trim());
          }
          continue;
        }
        if ((buf + s).length > MAX_CHARS) {
          if (buf) chunks.push(buf.trim());
          buf = buf.slice(-OVERLAP) + s;
        } else {
          buf += s;
        }
      }
      if (buf.trim()) chunks.push(buf.trim());
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
