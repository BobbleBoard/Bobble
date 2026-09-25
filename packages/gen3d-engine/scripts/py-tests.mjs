#!/usr/bin/env node
/**
 * Run the engine's Python tests (python/tests/run.py) on the Python the engine
 * runs on — uv's 3.12, SIDECAR_PYTHON in src/sidecar.ts — never on whichever
 * `python3` comes first on PATH. macOS's /usr/bin/python3 is 3.9: no `tomllib`,
 * no tarfile `filter=`, so two tests failed there on code that only ever runs
 * under 3.12.
 *
 *   node scripts/py-tests.mjs
 *
 * uv is found on PATH or at ~/.local/bin/uv (its installer's home). The env is
 * uv's own (numpy, scipy and Pillow are what the tests assume; a test that needs a
 * worker venv's packages skips). Offline first, like the sidecar's launch: a
 * cached env starts without the network, a missing one is fetched.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV = [
  '--no-project',
  '--python',
  '3.12',
  '--with',
  'numpy',
  '--with',
  'scipy',
  '--with',
  'pillow',
];
const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, '..', 'python', 'tests', 'run.py');
const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return r.error ? null : r;
}

const uv = [exe, join(homedir(), '.local', 'bin', exe)].find(
  (cmd) => run(cmd, ['--version'])?.status === 0,
);
if (uv === undefined) {
  console.error(
    "py-tests: uv not found. The engine runs on uv's Python 3.12; install uv (https://docs.astral.sh/uv/) and re-run.",
  );
  process.exit(1);
}

const cached = run(uv, ['run', '--offline', ...ENV, 'python', '-c', ''])?.status === 0;
const res = run(uv, ['run', ...(cached ? ['--offline'] : []), ...ENV, 'python', runner], {
  stdio: 'inherit',
});
process.exit(res?.status ?? 1);
