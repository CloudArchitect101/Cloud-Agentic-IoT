#!/usr/bin/env node
'use strict';

/*
 * sop-retrieval-eval.js - score the SOP index against a golden set.
 *
 *   node scripts/lib/sop-retrieval-eval.js <cases.json> <answers dir> [--junit <file>] [--summary <file>]
 *
 * <answers dir> holds one <case id>.json per case: the body procedure-search
 * answered ({ passages: [{ sopId, score, ... }] }), as scripts/eval-agents.sh
 * writes them. A case with "expect": null passes when no passage comes back
 * (nothing in the ward procedures covers it).
 *
 * Prints a table, writes JUnit XML (one testcase per question) and a Markdown
 * summary when asked, and exits 1 when hit@1 or hit@3 is under the
 * thresholds in the cases file. It makes no AWS call itself.
 */

const fs = require('node:fs');
const path = require('node:path');

function readAnswer(dir, id) {
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return { error: 'no answer file' };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // aws lambda invoke writes the function's return value: an API Gateway
    // style { statusCode, body } whose body is a JSON string.
    if (raw && typeof raw.body === 'string') {
      if (raw.statusCode !== 200) return { error: `status ${raw.statusCode}: ${raw.body}` };
      return JSON.parse(raw.body);
    }
    return raw;
  } catch (err) {
    return { error: `unreadable: ${err.message}` };
  }
}

/** Scores every case. Pure: answers is { [caseId]: body }. */
function score(spec, answers) {
  const results = spec.cases.map((c) => {
    const answer = answers[c.id] || { error: 'no answer' };
    if (answer.error) return { ...c, ok: false, rank: null, got: [], error: answer.error };
    const got = (answer.passages || []).map((p) => p.sopId);
    const top = (answer.passages || [])[0];
    if (c.expect === null) {
      return { ...c, ok: got.length === 0, rank: null, got, topScore: top?.score ?? null };
    }
    const at = got.indexOf(c.expect);
    const rank = at === -1 ? null : at + 1;
    return { ...c, ok: rank !== null && rank <= (spec.maxResults || 3), rank, got, topScore: top?.score ?? null };
  });
  const ranked = results.filter((r) => r.expect !== null);
  const n = ranked.length || 1;
  const metrics = {
    cases: results.length,
    passed: results.filter((r) => r.ok).length,
    hitAt1: ranked.filter((r) => r.rank === 1).length / n,
    hitAt3: ranked.filter((r) => r.rank !== null && r.rank <= 3).length / n,
    mrr: ranked.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n,
    outOfScopeRefused: results.filter((r) => r.expect === null && r.ok).length,
    outOfScope: results.filter((r) => r.expect === null).length,
  };
  const t = spec.thresholds || {};
  const failures = [];
  if (t.hitAt1 !== undefined && metrics.hitAt1 < t.hitAt1) failures.push(`hit@1 ${pct(metrics.hitAt1)} is under ${pct(t.hitAt1)}`);
  if (t.hitAt3 !== undefined && metrics.hitAt3 < t.hitAt3) failures.push(`hit@3 ${pct(metrics.hitAt3)} is under ${pct(t.hitAt3)}`);
  return { results, metrics, failures, pass: failures.length === 0 };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function junit(report) {
  const cases = report.results.map((r) => {
    const name = xml(`${r.id}: ${r.query}`);
    if (r.ok) return `    <testcase classname="sop-retrieval" name="${name}"/>`;
    const why = r.error || `expected ${r.expect ?? 'no passage'}, got ${r.got.join(', ') || 'no passage'}`;
    return `    <testcase classname="sop-retrieval" name="${name}"><failure message="${xml(why)}"/></testcase>`;
  });
  const failed = report.results.filter((r) => !r.ok).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="SOP retrieval (Bedrock Titan V2)" tests="${report.results.length}" failures="${failed}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
}

function markdown(report) {
  const m = report.metrics;
  const rows = report.results.map((r) => `| ${r.ok ? 'pass' : 'FAIL'} | ${r.query.replace(/\|/g, '/')} | ${r.expect ?? 'none'} | ${r.got.join(', ') || 'none'} | ${r.topScore ?? ''} |`);
  return [
    '### SOP retrieval eval',
    '',
    `hit@1 **${pct(m.hitAt1)}**, hit@3 **${pct(m.hitAt3)}**, MRR **${m.mrr.toFixed(2)}**, out-of-scope refused ${m.outOfScopeRefused}/${m.outOfScope}, ${m.passed}/${m.cases} cases pass.`,
    report.pass ? '' : `\n**Below threshold:** ${report.failures.join('; ')}.`,
    '',
    '| Result | Question | Expected | Got (best first) | Top score |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function main(argv) {
  const [casesFile, dir, ...rest] = argv;
  if (!casesFile || !dir) {
    console.error('usage: sop-retrieval-eval.js <cases.json> <answers dir> [--junit <file>] [--summary <file>]');
    return 2;
  }
  const opt = (name) => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1]; };
  const spec = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const answers = Object.fromEntries(spec.cases.map((c) => [c.id, readAnswer(dir, c.id)]));
  const report = score(spec, answers);
  const md = markdown(report);
  console.log(md);
  if (opt('--junit')) fs.writeFileSync(opt('--junit'), junit(report));
  if (opt('--summary')) fs.appendFileSync(opt('--summary'), md);
  return report.pass ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { score, junit, markdown, readAnswer };
