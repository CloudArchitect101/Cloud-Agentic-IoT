#!/usr/bin/env node
'use strict';

/*
 * agent-spec.js - turn a test spec in test/agents into the one the org gets.
 *
 *   node scripts/lib/agent-spec.js <spec.yaml> <out.yaml> KEY=value ... [--topic name=apiName ...]
 *
 * Replaces each {{KEY}} with its value, and each "expectedTopic: <name>" or
 * conversationHistory "topic: <name>" whose name has a --topic mapping with
 * the org's API name for that subagent. Fails if a {{KEY}} is left: a spec
 * with a placeholder in it would test nothing useful. Plain text in, plain
 * text out, so it needs no YAML library.
 */

const fs = require('node:fs');

function render(text, values = {}, topics = {}) {
  let out = text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (key in values ? values[key] : whole));
  out = out.replace(/^(\s*(?:expectedTopic|topic):\s*)([A-Za-z0-9_]+)\s*$/gm,
    (whole, lead, name) => (topics[name] ? `${lead}${topics[name]}` : whole));
  const left = [...new Set((out.match(/\{\{[A-Z_]+\}\}/g) || []))];
  return { text: out, missing: left };
}

/** The subagent names a spec expects, in order of first use. */
function topicsOf(text) {
  const names = [...text.matchAll(/^\s*(?:expectedTopic|topic):\s*([A-Za-z0-9_]+)\s*$/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

/** The action names a spec expects. */
function actionsOf(text) {
  const names = [];
  const re = /^(\s*)expectedActions:\s*(\[\])?\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m[2]) continue;
    const rest = text.slice(re.lastIndex).split('\n');
    for (const line of rest.slice(1)) {
      const item = line.match(/^\s*-\s+([A-Za-z0-9_]+)\s*$/);
      if (!item) break;
      names.push(item[1]);
    }
  }
  return [...new Set(names)];
}

function main(argv) {
  const [inFile, outFile, ...rest] = argv;
  if (!inFile || !outFile) {
    console.error('usage: agent-spec.js <spec.yaml> <out.yaml> KEY=value ... [--topic name=apiName ...]');
    return 2;
  }
  const values = {};
  const topics = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--topic') {
      const [name, api] = rest[++i].split('=');
      if (api) topics[name] = api;
    } else {
      const at = rest[i].indexOf('=');
      values[rest[i].slice(0, at)] = rest[i].slice(at + 1);
    }
  }
  const { text, missing } = render(fs.readFileSync(inFile, 'utf8'), values, topics);
  if (missing.length) {
    console.error(`${inFile} still has ${missing.join(', ')} after filling it in.`);
    return 1;
  }
  fs.writeFileSync(outFile, text);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { render, topicsOf, actionsOf };
