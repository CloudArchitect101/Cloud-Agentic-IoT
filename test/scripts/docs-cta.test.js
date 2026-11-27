'use strict';

// Where a reader finishes installing (the end of step 13 and step 14 in both
// install guides), a big "Test every feature" button hands them to the use
// case scenarios. It is a Markdown image link inside a markdown="1" block, so
// it works on github.com and on the docs site (kramdown converts TRY-IT.md to
// the page's URL only in Markdown links, not in raw <a href>).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BUTTON = '[![Test every feature: After install, use case scenarios](images/test-every-feature-button.svg)](TRY-IT.md)';

function section(s, from, to) {
  const a = s.indexOf(`<a id="${from}"></a>`);
  const b = to ? s.indexOf(`<a id="${to}"></a>`, a + 1) : s.length;
  assert.ok(a >= 0 && b > a, `${from} section found`);
  return s.slice(a, b);
}

for (const f of ['docs/INSTALL.md', 'docs/INSTALL-GUIDE.md']) {
  test(`${f} shows the Test every feature button at the end of steps 13 and 14`, () => {
    const s = read(f);
    for (const [from, to] of [['step-13', 'step-14'], ['step-14', null]]) {
      const sec = section(s, from, to);
      const i = sec.indexOf(BUTTON);
      assert.ok(i >= 0, `${f} ${from} has the button`);
      const before = sec.slice(0, i);
      assert.match(before.slice(before.lastIndexOf('<div')), /^<div align="center" class="cta" markdown="1">\n\n$/, 'wrapped in a markdown="1" block with blank lines');
    }
  });
}

test('the button image exists and the docs site styles it to fit a phone', () => {
  const svg = read('docs/images/test-every-feature-button.svg');
  assert.match(svg, /<title id="t">Test every feature/);
  assert.match(read('docs/_includes/head-custom.html'), /\.markdown-body \.cta img\{[^}]*max-width:100%/);
});
