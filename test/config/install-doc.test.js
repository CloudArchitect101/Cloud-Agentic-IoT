'use strict';

// Nov 19: Vitaly found the Quick install unclear about what to paste into the
// terminal: a block mixed a fill-in value with a loop, and some sf commands
// named no org, so a new terminal could send them to the wrong one. These
// checks keep every command block in docs/INSTALL.md (also the Pages site's
// Quick install) labelled, its fill-in values quoted, and every org named.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '../../docs/INSTALL.md');
const lines = fs.readFileSync(file, 'utf8').split('\n');
// "> " for a block inside a callout, spaces for one inside a list item.
const bare = (line) => line.replace(/^(\s*>\s?)+/, '').trim();

function blocks() {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (bare(lines[i]) !== '```bash') continue;
    const start = i;
    const body = [];
    for (i++; i < lines.length && bare(lines[i]) !== '```'; i++) body.push(bare(lines[i]));
    found.push({ line: start + 1, body });
  }
  return found;
}

// Lines joined across a trailing backslash, comments dropped.
function commands(body) {
  const joined = body.join('\n').replace(/\\\n/g, ' ');
  return joined.split('\n').map((l) => l.replace(/\s+#.*$/, '')).filter((l) => l.trim());
}

test('the Quick install has command blocks to check', () => {
  assert.ok(blocks().length >= 20, `only ${blocks().length} bash blocks found`);
});

test('every command block says it goes into the terminal, just above it', () => {
  for (const { line } of blocks()) {
    const before = [];
    for (let j = line - 2; j >= 0 && before.length < 3; j--) {
      if (bare(lines[j])) before.push(bare(lines[j]));
    }
    assert.ok(before.some((l) => /into your terminal/i.test(l)),
      `docs/INSTALL.md:${line}: no "Paste into your terminal" line above this block`);
  }
});

test('every sf command that talks to an org names it', () => {
  for (const { line, body } of blocks()) {
    for (const command of commands(body)) {
      for (const part of command.split('|')) {
        const sf = part.trim();
        if (!/^sf\s/.test(sf) || /^sf org login\b/.test(sf)) continue;
        assert.match(sf, /--target-org\s/, `docs/INSTALL.md:${line}: ${sf}`);
      }
    }
  }
});

test('a value to fill in sits between quotes, so the shell never reads its < > as a redirect', () => {
  for (const { line, body } of blocks()) {
    for (const command of commands(body)) {
      const unquoted = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
      assert.doesNotMatch(unquoted, /<[A-Za-z][^>]*>/, `docs/INSTALL.md:${line}: ${command}`);
    }
  }
});

test('no command block loops over permission sets: one line each is easier to read and rerun', () => {
  for (const { line, body } of blocks()) {
    assert.ok(!body.some((l) => /^for\s/.test(l)), `docs/INSTALL.md:${line}: a for loop`);
  }
});

// Vitaly, Nov 27: the Quick install is one straight path that deploys
// everything, with no choices and no failure branches. Recovery notes live in
// docs/TROUBLESHOOTING.md (#install-steps), the why in docs/INSTALL-GUIDE.md.
test('the Quick install reads as one straight path: no optional steps, choices or failure branches', () => {
  const text = fs.readFileSync(file, 'utf8');
  const banned = [
    /\boptional\b/i, /(?<!\*\*)\bskip (this|it|if|without)\b/i, /\(skip /i, /\bif you (want|wish|plan|prefer)\b/i,
    /\bBy hand instead\b/, /\bif (it|this|a step|a command|that) fails\b/i, /\bSKIP_[A-Z_]+=yes\b/,
    /test-yourname/,
  ];
  const lines = text.split('\n');
  for (const re of banned) {
    const hit = lines.findIndex((l) => re.test(l));
    assert.equal(hit, -1, `docs/INSTALL.md:${hit + 1}: ${re} - ${lines[hit] || ''}`);
  }
  assert.match(text, /NAME='test-cloud-agentic-iot'/);
  assert.ok(text.indexOf('<a id="resume"></a>') < text.indexOf('<a id="step-1"></a>'), 'the resume lines come before step 1');
  assert.match(fs.readFileSync(path.join(__dirname, '../../docs/TROUBLESHOOTING.md'), 'utf8'), /<a id="install-steps"><\/a>/);
  assert.match(fs.readFileSync(path.join(__dirname, '../../docs/INSTALL-GUIDE.md'), 'utf8'), /<a id="quick-install-explained"><\/a>/);
});
