#!/usr/bin/env node
'use strict';

/*
 * sop-payload.js [--force] - prints what scripts/index-sops.sh sends the
 * knowledge-indexer: every knowledge/sops/*.md as { file, markdown }.
 *
 * Each file is read with the same rules the indexer applies
 * (lambda/shared/sop-index.js), so a missing field or a repeated SOP ID fails
 * here, before anything is sent to AWS, naming the file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseSop } = require('../../lambda/shared/sop-index');

const REPO_ROOT = path.join(__dirname, '../..');
const SOP_DIR = 'knowledge/sops';

function payload({ force = false, root = REPO_ROOT } = {}) {
  const dir = path.join(root, SOP_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort() : [];
  if (!files.length) throw new Error(`${SOP_DIR} has no .md files to index.`);
  const ids = new Map();
  const documents = files.map((name) => {
    const file = `${SOP_DIR}/${name}`;
    const markdown = fs.readFileSync(path.join(dir, name), 'utf8');
    const { id } = parseSop(markdown, file);
    if (ids.has(id)) throw new Error(`${file}: ${id} is also the id of ${ids.get(id)}`);
    ids.set(id, file);
    return { file, markdown };
  });
  return force ? { documents, force: true } : { documents };
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(payload({ force: process.argv.includes('--force') })));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { payload, SOP_DIR };
