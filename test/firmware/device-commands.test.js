'use strict';

// Compiles and runs device_commands_test.cpp: the commandId rule, the outcome
// names, the text a board repeats in its answers, and the memory that keeps
// one command sent twice from being carried out twice. The header it tests is
// plain C++, so any host compiler will do; without one (a bare laptop) the
// test is skipped, and CI always has one.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const source = path.join(__dirname, 'device_commands_test.cpp');

function compiler() {
  for (const name of [process.env.CXX, 'c++', 'g++', 'clang++'].filter(Boolean)) {
    if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  }
  return null;
}

test('firmware commands: commandId rule, outcomes, answer text, a command sent twice', (t) => {
  const cxx = compiler();
  if (!cxx) {
    t.skip('no C++ compiler on this machine');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-commands-'));
  try {
    const binary = path.join(dir, 'device_commands_test');
    const build = spawnSync(cxx, ['-std=c++11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, source], { encoding: 'utf8' });
    assert.strictEqual(build.status, 0, `compile failed:\n${build.stderr}`);

    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 120000 });
    for (const line of run.stdout.trim().split('\n')) t.diagnostic(line);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
