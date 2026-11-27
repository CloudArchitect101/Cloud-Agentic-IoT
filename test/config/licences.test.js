'use strict';

// Code is MIT; docs, media and the 3D case designs are CC BY 4.0 (README, License).
// GitHub reads the repo's licence with Licensee, which reports NOASSERTION
// ("Other") as soon as it finds two different licences in the root LICENSE
// files, a LICENSES/ folder, or the README's License section. These tests keep
// the badge and the sidebar on MIT while the second licence stays published.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const REPO = 'https://github.com/CloudArchitect101/Cloud-Agentic-IoT';

test('the root LICENSE is MIT with the author copyright', () => {
  const text = read('LICENSE');
  assert.match(text, /^MIT License\n\nCopyright \(c\) 2026 Vitaly Makarkin\n/);
});

test('no second licence file where GitHub looks for the repo licence', () => {
  const extra = fs.readdirSync(root).filter((f) => /^(licen[cs]e|copying|unlicense)/i.test(f) && f !== 'LICENSE');
  assert.deepEqual(extra, [], 'only the MIT LICENSE may sit at the root');
  assert.equal(fs.existsSync(path.join(root, 'LICENSES')), false, 'a LICENSES/ folder makes GitHub report NOASSERTION');
});

test('the CC BY 4.0 text is the unmodified Creative Commons legal code', () => {
  const text = read('docs/LICENSE-CC-BY-4.0.txt');
  assert.match(text, /^Attribution 4\.0 International\n/);
  assert.match(text, /Creative Commons may be contacted at creativecommons\.org\.\n$/);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(sha, 'f5b745ef98087f531e719ee8ca6a96809444573ecc7173c6fa68eaad39b3cc3f', 'do not edit the licence text');
});

test("the README License section names only MIT before its first subheading", () => {
  const readme = read('README.md');
  const m = readme.match(/^## License\n([\s\S]*?)(?=^#)/m);
  assert.ok(m, 'README has a ## License section');
  assert.match(m[1], /\[MIT\]\(LICENSE\)/);
  assert.doesNotMatch(m[1], /creative commons|cc[ -]by|attribution/i,
    'naming a second licence here makes GitHub read the README as that licence');
});

test('the README says what each licence covers, with a credit line and third-party exceptions', () => {
  const readme = read('README.md');
  assert.match(readme, /\[CC BY 4\.0\]\(docs\/LICENSE-CC-BY-4\.0\.txt\)/);
  assert.ok(readme.includes(`by Vitaly Makarkin (${REPO}), CC BY 4.0. Changes:`), 'copyable credit line');
  assert.match(readme, /docs\/images\/parts\/CREDITS\.md/);
  assert.match(readme, /docs\/images\/platforms\/CREDITS\.md/);
});

test('the docs home, the cases README and the credits pages state the content licence', () => {
  assert.match(read('docs/index.md'), /\[CC BY 4\.0\]\(LICENSE-CC-BY-4\.0\.txt\)/);
  assert.match(read('hardware/cases/README.md'), /\[CC BY 4\.0\]\(\.\.\/\.\.\/docs\/LICENSE-CC-BY-4\.0\.txt\)/);
  for (const f of ['docs/images/parts/CREDITS.md', 'docs/images/platforms/CREDITS.md']) {
    const text = read(f);
    assert.doesNotMatch(text, /Same licence as the repo/, `${f}: name the licence, the repo has two`);
    assert.match(text, /\[CC BY 4\.0\]\(\.\.\/\.\.\/LICENSE-CC-BY-4\.0\.txt\)/, f);
  }
});

test('third-party photos keep their own licences, not the project one', () => {
  const rows = read('docs/images/parts/CREDITS.md').split('\n').filter((l) => /^\| `[^`]+\.jpg`/.test(l));
  assert.ok(rows.length >= 10);
  for (const row of rows) {
    if (/this project/i.test(row)) continue;
    assert.match(row, /commons\.wikimedia\.org/, row);
    assert.doesNotMatch(row, /Vitaly Makarkin/, row);
  }
});
