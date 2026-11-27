'use strict';

// The docs are the product for a newcomer: a Salesforce admin following the
// Quick install should never hit a dead link or a page with no way back.
// These tests keep that true on every pull request:
//   - every relative link in the docs, the README and CONTRIBUTING points to
//     a file that exists, and every #anchor to a heading or <a id> on it;
//   - every page in docs/ links back to the docs home;
//   - every Quick install step has its anchor, a row in the step map, and
//     Previous / Next links, so the step map on the docs site can find it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DOCS = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
const PAGES = [...DOCS, 'hardware/cases/README.md', 'docs/images/platforms/CREDITS.md', 'README.md', 'CONTRIBUTING.md', 'firmware/README.md', 'force-app/main/default/uiBundles/patientPortal/README.md'];

// Fenced code and HTML comments are not rendered as links.
const prose = (s) => s.replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '');

// GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes,
// and -1, -2 on repeats.
function anchorsOf(file) {
  const s = read(file);
  const seen = new Map();
  const out = new Set();
  for (const m of prose(s).matchAll(/^#{1,6}\s+(.*?)\s*#*$/gm)) {
    const slug = m[1].trim().toLowerCase().replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
    const n = seen.get(slug) || 0;
    out.add(n ? `${slug}-${n}` : slug);
    seen.set(slug, n + 1);
  }
  for (const m of s.matchAll(/<a (?:name|id)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

function linksOf(file) {
  const text = prose(read(file));
  // Markdown links, plus href and src in the landing pages' HTML.
  return [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g), ...text.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|mailto:)/.test(u))
    // GitHub-relative links (issues, security advisories) resolve only on github.com.
    .filter((u) => !/^\.\.\/\.\.\/(issues|security)\//.test(u));
}

test('every relative link in the docs points to a file and anchor that exist', () => {
  const broken = [];
  for (const file of PAGES) {
    for (const url of linksOf(file)) {
      const [p, anchor] = url.split('#');
      const target = p ? path.normalize(path.join(path.dirname(file), p)) : file;
      if (p && !fs.existsSync(path.join(ROOT, target))) { broken.push(`${file}: ${url} (no such file)`); continue; }
      if (anchor && target.endsWith('.md') && !anchorsOf(target).has(anchor.toLowerCase())) {
        broken.push(`${file}: ${url} (no such anchor)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('every docs page links back to the docs home', () => {
  const missing = DOCS.filter((f) => f !== 'docs/index.md')
    .filter((f) => !linksOf(f).some((u) => u.split('#')[0] === 'index.md'));
  assert.deepEqual(missing, []);
});

test('every Quick install step has its anchor, a step map row and Previous / Next links', () => {
  const s = read('docs/INSTALL.md');
  const steps = [...s.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
  assert.ok(steps.length >= 10, 'the Quick install has its numbered steps');
  assert.match(s, /<a id="step-map"><\/a>/);
  for (const n of steps) {
    assert.match(s, new RegExp(`<a id="step-${n}"></a>\\s*\\n## ${n}\\. `), `step ${n} anchor sits right above its heading`);
    assert.match(s, new RegExp(`^\\| \\[${n}\\]\\(#step-${n}\\) \\|`, 'm'), `step ${n} has a step map row`);
    if (n < Math.max(...steps)) assert.ok(s.includes(`](#step-${n + 1})`), `step ${n} links on to step ${n + 1}`);
  }
});

test('every audience path is linked from Start here and the docs home', () => {
  for (const p of ['ADMIN', 'DEVICE', 'DEVELOPER', 'PIPELINES']) {
    assert.ok(fs.existsSync(path.join(ROOT, `docs/PATH-${p}.md`)), `docs/PATH-${p}.md exists`);
    assert.ok(read('docs/START-HERE.md').includes(`href="PATH-${p}.md"`), `Start here links PATH-${p}`);
    assert.ok(read('docs/index.md').includes(`href="PATH-${p}.md"`), `the docs home links PATH-${p}`);
  }
});

test('Start here is linked from the README and the docs home', () => {
  assert.ok(read('README.md').includes('](docs/START-HERE.md)'));
  assert.ok(read('docs/index.md').includes('](START-HERE.md)'));
});
