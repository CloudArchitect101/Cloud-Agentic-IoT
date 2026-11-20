'use strict';

// Once the repository is public, anyone can open a pull request from a fork.
// These tests fail the checks if a workflow change would hand the project's
// AWS or Salesforce credentials to code from a pull request, or if the files
// that route every change through the maintainer's review go missing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const WORKFLOWS = path.join(root, '.github/workflows');

const workflows = fs.readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(WORKFLOWS, f), 'utf8') }));

// The trigger names under the top-level `on:` key.
function triggers(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.notEqual(start, -1, 'workflow has a block-style on: key');
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    const m = line.match(/^ {2}([a-z_]+):/);
    if (m) names.push(m[1]);
  }
  return names;
}

test('there are workflows to check', () => {
  assert.ok(workflows.length > 0);
});

for (const { file, text } of workflows) {
  test(`${file}: never runs on pull_request_target`, () => {
    // pull_request_target runs with the base repository's secrets and write
    // token, so checking out a fork's code there hands it the credentials.
    assert.ok(!triggers(text).includes('pull_request_target'));
    assert.doesNotMatch(text, /pull_request_target/);
  });

  test(`${file}: a workflow that uses secrets or OIDC never runs on a pull request`, () => {
    const usesCredentials = /secrets\.|id-token:\s*write/.test(text);
    if (!usesCredentials) return;
    assert.ok(!triggers(text).includes('pull_request'),
      'credentials stay with push, workflow_dispatch and workflow_call triggers');
  });
}

test('checks.yml, the pull request workflow, is read-only and secret-free', () => {
  const { text } = workflows.find((w) => w.file === 'checks.yml');
  assert.ok(triggers(text).includes('pull_request'));
  assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /id-token/);
});

test('deploy.yml deploys through a GitHub environment, so Prod can require approval', () => {
  const { text } = workflows.find((w) => w.file === 'deploy.yml');
  assert.match(text, /environment:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
});

test('CODEOWNERS sends every change and the workflows to the maintainer', () => {
  const owners = fs.readFileSync(path.join(root, '.github/CODEOWNERS'), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => l.trim().split(/\s+/));
  const ownerOf = (p) => owners.find(([pattern]) => pattern === p)?.slice(1) ?? [];
  // CODEOWNERS is the one place that names the maintainer, so a fork changes
  // one file. Whoever owns `*` must also own the paths that decide what runs
  // with the project's credentials.
  const [maintainer] = ownerOf('*');
  assert.match(maintainer ?? '', /^@[\w-]+(\/[\w-]+)?$/, 'CODEOWNERS gives `*` to a GitHub login or team');
  for (const guarded of ['/.github/', '/infra/', '/scripts/']) {
    assert.ok(ownerOf(guarded).includes(maintainer), `${guarded} goes to ${maintainer}`);
  }
});

test('the community files exist', () => {
  for (const f of ['LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
    '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
  }
});
