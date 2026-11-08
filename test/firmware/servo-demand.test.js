'use strict';

// Compiles and runs servo_demand_test.cpp: why the one firmware every board
// runs turns its servo (a patient device's own Case, CASE_ALERT; the whole
// queue on an internal board, QUEUE_DEPTH; or both, at the faster), and how a
// board without a DHT11 stays quiet. The headers it tests are plain C++, so
// any host compiler will do; without one (a bare laptop) the test is skipped,
// and CI always has one.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const source = path.join(__dirname, 'servo_demand_test.cpp');

function compiler() {
  for (const name of [process.env.CXX, 'c++', 'g++', 'clang++'].filter(Boolean)) {
    if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  }
  return null;
}

test('firmware servo demand: case alert, queue depth, both; a board without a sensor', (t) => {
  const cxx = compiler();
  if (!cxx) {
    t.skip('no C++ compiler on this machine');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servo-demand-'));
  try {
    const binary = path.join(dir, 'servo_demand_test');
    const build = spawnSync(cxx, ['-std=c++11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, source], { encoding: 'utf8' });
    assert.strictEqual(build.status, 0, `compile failed:\n${build.stderr}`);

    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 120000 });
    for (const line of run.stdout.trim().split('\n')) t.diagnostic(line);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
