'use strict';

// The docs site (GitHub Pages, kramdown) renders Markdown more strictly than
// github.com. Each pattern below rendered fine on github.com but broke the
// published page, so these tests catch it on every pull request:
//   - a <details> block without markdown="1": kramdown leaves its body as raw
//     HTML, and an <URL>-style placeholder inside it opens a tag that never
//     closes, so the rest of the page shows as raw Markdown;
//   - text after a closing ``` on the same line: the fence never closes;
//   - an inline code span wrapped so the next line starts with <word>: that
//     line is taken as an HTML block and the paragraph after it is raw;
//   - a numbered list broken by unindented text or code between items: the
//     docs site restarts the numbering at 1 where github.com keeps it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const DOCS = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
const lines = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');

// Index of every line inside a fenced code block (fence lines included).
function fenced(L) {
  const out = new Set();
  let open = null;
  L.forEach((l, i) => {
    const m = l.match(/^\s*(?:>\s*)?(`{3,}|~{3,})/);
    if (!m) { if (open) out.add(i); return; }
    if (!open) { open = m[1]; out.add(i); } else if (m[1][0] === open[0] && m[1].length >= open.length) { out.add(i); open = null; } else out.add(i);
  });
  return out;
}

test('every <details> on a docs page lets kramdown render its Markdown', () => {
  const bad = [];
  for (const f of DOCS) {
    lines(f).forEach((l, i) => {
      if (/<details(\s|>)/.test(l) && !/markdown="1"/.test(l)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], 'add markdown="1" to these <details> tags');
});

test('no text follows a closing code fence on the same line', () => {
  const bad = [];
  for (const f of DOCS) {
    lines(f).forEach((l, i) => { if (/^\s*```\s+\S/.test(l) && !/^\s*```\s*[\w-]+\s*$/.test(l)) bad.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(bad, []);
});

test('no inline code span wraps onto a line that starts with <word>', () => {
  const bad = [];
  for (const f of DOCS) {
    const L = lines(f);
    const code = fenced(L);
    L.forEach((l, i) => {
      if (code.has(i) || i + 1 >= L.length) return;
      if ((l.match(/`/g) || []).length % 2 === 1 && /^\s*<[A-Za-z]/.test(L[i + 1])) bad.push(`${f}:${i + 2}`);
    });
  }
  assert.deepEqual(bad, [], 'keep the whole code span on one line');
});

test('numbered lists are not broken by unindented content between items', () => {
  const bad = [];
  for (const f of DOCS) {
    const L = lines(f);
    const code = fenced(L);
    L.forEach((l, i) => {
      const m = !code.has(i) && l.match(/^(\d+)\. /);
      if (!m || Number(m[1]) < 2) return;
      // The item before it in the same list, at the left margin.
      let j = i - 1;
      for (; j >= 0; j--) {
        if (/^\d+\. /.test(L[j])) break;
        if (code.has(j)) continue;
        if (/^#/.test(L[j])) break;
      }
      if (j < 0 || !/^\d+\. /.test(L[j]) || Number(L[j].match(/^(\d+)/)[1]) !== Number(m[1]) - 1) return;
      for (let k = j + 1; k < i; k++) {
        if (L[k].trim() && !/^\s/.test(L[k])) { bad.push(`${f}:${i + 1}`); return; }
      }
    });
  }
  assert.deepEqual(bad, [], 'indent the text and code between these items under the item above');
});
