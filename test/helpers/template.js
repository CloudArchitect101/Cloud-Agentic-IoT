'use strict';

/*
 * Reads a CloudFormation template's resources into plain objects, for the
 * tests that pin roles and routes. The repo has no YAML parser, and one would
 * have to be taught the templates' tags anyway. Taken from
 * test/lambda/device-command-ack.test.js, which reads the same shapes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const indent = (line) => line.search(/\S/);
const isContent = (line) => line.trim() !== '' && !line.trim().startsWith('#');

/** Each resource's lines in a template, by its name, without comments or blank lines. */
function resources(file) {
  const found = new Map();
  let section = null;
  let body = null;
  for (const line of source(file).split(/\r?\n/)) {
    if (!isContent(line)) continue;
    if (indent(line) === 0) {
      section = line;
      continue;
    }
    if (section !== 'Resources:') continue;
    const name = line.match(/^ {2}(\w+):$/);
    if (name) {
      body = [];
      found.set(name[1], body);
    } else {
      assert.ok(body && indent(line) > 2, `${file} has a line in Resources this test cannot read: ${line.trim()}`);
      body.push(line);
    }
  }
  return found;
}

/**
 * One resource, read into plain objects, as test/lambda/live-viewer-role.test.js
 * reads them: the repo has no YAML parser, and one would have to be taught the
 * template's tags anyway. It reads the block style the templates are written
 * in: "Key: value", "Key:" over a block, "- " lists, a { Key: value } pair, a
 * [flow, list] of plain values, a quoted value, text after >- or |, and
 * comments on lines of their own. A tag stays in its value as text
 * ("!GetAtt CommandAckQueue.Arn"). Anything else fails the test, so it
 * cannot pass on a shape it misread.
 */
function resource(file, name) {
  const body = resources(file).get(name);
  assert.ok(body, `${file} declares no resource ${name}`);
  const entries = body.map((line) => ({ depth: indent(line), text: line.trim() }));
  const [value, next] = block(entries, 0, name);
  assert.equal(next, entries.length, `${name} has a line this test cannot read: ${(entries[next] || {}).text}`);
  return value;
}

const KEY = /^([A-Za-z][\w.:-]*):(?: (.+))?$/;

/** The list or mapping that starts at entries[at], and the index after it. */
function block(entries, at, where) {
  const { depth } = entries[at];
  if (!entries[at].text.startsWith('- ')) return mapping(entries, at, depth, where);
  const items = [];
  while (at < entries.length && entries[at].depth === depth && entries[at].text.startsWith('- ')) {
    // The item's first line, read as though it began two columns in, where the rest of the item is.
    const item = [{ depth: depth + 2, text: entries[at].text.slice(2) }];
    for (at += 1; at < entries.length && entries[at].depth > depth; at += 1) item.push(entries[at]);
    if (item.length === 1 && !KEY.test(item[0].text)) {
      items.push(scalar(item[0].text, where));
    } else {
      const [value, next] = block(item, 0, where);
      assert.equal(next, item.length, `${where} has a line this test cannot read: ${(item[next] || {}).text}`);
      items.push(value);
    }
  }
  return [items, at];
}

function mapping(entries, at, depth, where) {
  const map = {};
  while (at < entries.length && entries[at].depth === depth) {
    const pair = entries[at].text.match(KEY);
    assert.ok(pair, `${where} has a line this test cannot read: ${entries[at].text}`);
    const [, key, value] = pair;
    assert.ok(!Object.hasOwn(map, key), `${where} sets ${key} twice`);
    at += 1;
    if (value === undefined) {
      assert.ok(at < entries.length && entries[at].depth > depth, `${where}: ${key} has no value`);
      [map[key], at] = block(entries, at, where);
    } else if (/^[>|]-?$/.test(value)) {
      const text = [];
      for (; at < entries.length && entries[at].depth > depth; at += 1) text.push(entries[at].text);
      map[key] = text.join(value.startsWith('>') ? ' ' : '\n');
    } else {
      map[key] = scalar(value, where);
    }
  }
  return [map, at];
}

function scalar(text, where) {
  const tagged = text.match(/^(![A-Za-z]+) (.+)$/);
  if (tagged) return `${tagged[1]} ${scalar(tagged[2], where)}`;
  const quoted = text.match(/^'((?:[^']|'')*)'$/);
  if (quoted) return quoted[1].replace(/''/g, "'");
  // A double-quoted value without escapes, as the rules' Sql is written.
  const doubleQuoted = text.match(/^"([^"\\]*)"$/);
  if (doubleQuoted) return doubleQuoted[1];
  const pair = text.match(/^\{ *([A-Za-z][\w.:-]*): ([^{}]+?) *\}$/);
  if (pair) return { [pair[1]]: scalar(pair[2], where) };
  // A flow list of plain values, as FunctionResponseTypes is written.
  const flow = text.match(/^\[([^[\]{}'"]+)\]$/);
  if (flow) return flow[1].split(',').map((item) => scalar(item.trim(), where));
  // Another quote, a nested [flow list], an anchor, or a comment after the
  // value is a shape this reader does not take apart.
  assert.ok(/^[^'"[\]{}&*!|>%@`#]/.test(text) && !/\s#|: /.test(text), `${where} has a value this test cannot read: ${text}`);
  return text;
}

const listOf = (value) => (Array.isArray(value) ? value : [value]);

/** Every "action on resource" a policy document allows, with the condition it is allowed under. */
function grants(document, where) {
  assert.equal(document.Version, '2012-10-17', `${where}: Version`);
  assert.ok(Array.isArray(document.Statement) && document.Statement.length, `${where} has no statements`);
  return document.Statement.flatMap(({
    Effect, Action, Resource, Condition, ...other
  }) => {
    // A Deny or a NotAction would change what "exactly" means here.
    assert.deepEqual(Object.keys(other), [], `${where} has a statement with ${Object.keys(other).join(', ')}, which this test does not read`);
    assert.equal(Effect, 'Allow', `${where} has a statement that is not an Allow`);
    const when = Condition === undefined ? '' : ` when ${JSON.stringify(Condition)}`;
    return listOf(Action).flatMap((action) => listOf(Resource).map((on) => `${action} on ${on}${when}`));
  });
}

module.exports = {
  resources, resource, listOf, grants, source,
};
