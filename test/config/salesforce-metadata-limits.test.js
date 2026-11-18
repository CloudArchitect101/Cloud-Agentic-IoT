'use strict';

// Salesforce checks some field lengths only at deploy time, after the deploy
// has already started. These checks catch them on every pull request instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const metadata = path.join(root, 'force-app/main/default');

function filesUnder(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, suffix);
    return entry.name.endsWith(suffix) ? [full] : [];
  });
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

test('every permission set description fits in 255 characters', () => {
  const files = filesUnder(path.join(metadata, 'permissionsets'), '.permissionset-meta.xml');
  assert.ok(files.length > 0, 'no permission sets found');
  for (const file of files) {
    const match = fs.readFileSync(file, 'utf8').match(/<description>([\s\S]*?)<\/description>/);
    if (!match) continue;
    const length = unescapeXml(match[1]).length;
    assert.ok(length <= 255, `${path.relative(root, file)}: description is ${length} characters, the maximum is 255`);
  }
});
