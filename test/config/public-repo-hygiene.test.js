'use strict';

// The repository is public. These checks keep two things out of every
// tracked text file:
//   1. A real AWS account ID. Only the placeholder IDs from the AWS docs are
//      allowed in examples, tests and Troubleshooting rows.
//   2. Links into a branch other than Dev. Feature branches are deleted after
//      their pull request merges, so a link to one turns into a 404 for anyone
//      reading the docs, the README or the talk material later.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '../..');

// AWS documentation's example account IDs, plus the all-zero filler.
const EXAMPLE_ACCOUNT_IDS = new Set(['111122223333', '123456789012', '210987654321', '000000000000']);
const TEXT = /\.(md|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|py|sh|html|css|cls|trigger|xml|txt|ino|cpp|h|c|toml|agent|csv|env\.example)$/i;

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter((f) => f && TEXT.test(f) && !f.startsWith('node_modules/'));
}

const files = trackedTextFiles().map((f) => {
  const full = path.join(root, f);
  // Skip large generated files (lockfiles, bundles): they hold no prose.
  if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) return null;
  return { file: f, text: fs.readFileSync(full, 'utf8') };
}).filter(Boolean);

test('there are tracked files to check', () => {
  assert.ok(files.length > 50);
});

test('no real AWS account ID in a tracked file (only the AWS docs placeholders)', () => {
  const found = [];
  for (const { file, text } of files) {
    // A 12-digit number that is not part of a longer number or word.
    for (const m of text.matchAll(/(?<![\w.-])(\d{12})(?![\w-])/g)) {
      if (!EXAMPLE_ACCOUNT_IDS.has(m[1])) found.push(`${file}: ${m[1].slice(0, 4)}********`);
    }
  }
  assert.deepEqual(found, [], 'use 111122223333 (or another AWS docs placeholder) instead');
});

test('links into this repository on github.com point to Dev, not a feature branch', () => {
  const repo = /(?:github\.com\/CloudArchitect101\/cloud-agentic-iot\/(?:tree|blob|raw|commits)|raw\.githubusercontent\.com\/CloudArchitect101\/cloud-agentic-iot)\/([^/\s)"'<>#?]+)/gi;
  const found = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(repo)) {
      if (m[1] !== 'Dev') found.push(`${file}: …/${m[1]}`);
    }
  }
  assert.deepEqual(found, [], 'link to Dev (or a file on Dev); feature branches are deleted after merge');
});
