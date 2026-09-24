/**
 * DOES bench-run.sh PROTECT THE MACHINE? — the smoke probe for scripts/bench-run.sh.
 *
 * Harmless commands only (sleep, echo): nothing here is a heavy job, and the
 * heavy lock it takes is in a PRIVATE lock root, so no lane's caps shrink
 * while this runs. Free memory is simulated through bench-run's
 * BENCH_MEMLEVEL_CMD seam.
 *
 *   1. a normal run: the job's exit code passes through; meta, trace, output,
 *      summary and the run index are written; the heavy slot is released.
 *   2. the watchdog: "free memory" drops below the floor mid-run; the job and
 *      EVERY descendant — including one that moved to its own process group —
 *      are stopped, the exit code is 137, the summary says so.
 *   3. an interrupt: SIGTERM to the wrapper stops the job (143), and the slot
 *      is released.
 *
 *   node tests/e2e/bench-run-smoke-probe.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { heavyBlockers } from './_locks.mjs';
import { focusComplaint, frontmostApp, REPO_ROOT } from './harness.mjs';

const BENCH = path.join(REPO_ROOT, 'scripts', 'bench-run.sh');
const ROOT = mkdtempSync(path.join(tmpdir(), 'bench-run-smoke-'));
const LOCKS = path.join(ROOT, 'locks');
const failures = [];
const check = (ok, message) => {
  if (!ok) {
    failures.push(message);
    console.error(`bench-run-smoke FAILED: ${message}`);
  }
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strays = (tag) => {
  try {
    return execFileSync('pgrep', ['-f', tag], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

function bench(name, args, env = {}) {
  const child = spawn(
    'bash',
    [
      BENCH,
      '--name',
      name,
      '--interval',
      '1',
      '--no-sweep',
      '--log-dir',
      path.join(ROOT, name),
      ...args,
    ],
    {
      env: {
        ...process.env,
        BOBBLE_LOCK_DIR: LOCKS,
        LOCK_WAIT_MS: '60000',
        BOBBLE_LOCK_HELD: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
  return { child, done };
}
const summary = (name) => JSON.parse(readFileSync(path.join(ROOT, name, 'summary.json'), 'utf8'));
const locksEmpty = () =>
  !existsSync(LOCKS) || readdirSync(LOCKS).filter((f) => !f.startsWith('.')).length === 0;

const before = frontmostApp();
const results = {};
try {
  const blocked = heavyBlockers({ root: LOCKS });
  if (blocked.length > 0) {
    results.skipped = blocked.map((b) => b.detail).join('; ');
    console.log(`bench-run-smoke skipped: a heavy job may not start now (${results.skipped})`);
  } else {
    // 1. normal
    const one = await bench('normal', ['--', 'sh', '-c', 'echo bench-hello; sleep 2; exit 3']).done;
    const s1 = summary('normal');
    results.normal = { code: one.code, summary: s1 };
    check(one.code === 3 && s1.exitCode === 3, `exit code did not pass through: ${one.code}`);
    check(
      readFileSync(path.join(ROOT, 'normal', 'output.log'), 'utf8').includes('bench-hello'),
      'output not logged',
    );
    check(
      readFileSync(path.join(ROOT, 'normal', 'memory.csv'), 'utf8')
        .trim()
        .split('\n').length >= 2,
      'no memory trace',
    );
    check(
      readFileSync(path.join(ROOT, 'index.tsv'), 'utf8').includes('\tnormal\t3\t0\t'),
      'run index line missing',
    );
    check(locksEmpty(), 'the heavy slot was not released');

    // 2. watchdog
    const level = path.join(ROOT, 'level');
    writeFileSync(level, '80\n');
    const tag = `sleep 3${process.pid % 100}1`;
    const run2 = bench(
      'watchdog',
      [
        '--',
        'sh',
        '-c',
        `${tag} & perl -e 'setpgrp(0,0); exec("sleep", "3${process.pid % 100}2")' & wait`,
      ],
      {
        BENCH_MEMLEVEL_CMD: `cat ${level}`,
      },
    );
    await sleep(3000);
    writeFileSync(level, '21\n');
    const two = await run2.done;
    await sleep(500);
    const s2 = summary('watchdog');
    results.watchdog = { code: two.code, summary: s2 };
    check(
      two.code === 137 && s2.watchdogKilled === true,
      `watchdog did not stop the job: ${two.code}`,
    );
    check(s2.minFreePct === 21, `min free recorded ${s2.minFreePct}`);
    check(
      strays(tag) === '' && strays(`sleep 3${process.pid % 100}2`) === '',
      'the watchdog left processes behind',
    );
    check(locksEmpty(), 'the heavy slot was not released after the watchdog');

    // 3. interrupt
    const run3 = bench('interrupt', ['--', 'sh', '-c', `sleep 3${process.pid % 100}3 & wait`]);
    await sleep(3000);
    run3.child.kill('SIGTERM');
    const three = await run3.done;
    const s3 = summary('interrupt');
    results.interrupt = { code: three.code, summary: s3 };
    check(
      s3.interrupted === true && three.code === 143,
      `interrupt: exit ${three.code}, ${JSON.stringify(s3)}`,
    );
    await sleep(500);
    check(
      strays(`sleep 3${process.pid % 100}3`) === '',
      'the interrupted job left processes behind',
    );
    check(locksEmpty(), 'the heavy slot was not released after an interrupt');
  }
} catch (e) {
  check(false, `probe threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  const complaint = focusComplaint(before, frontmostApp());
  if (complaint !== null) check(false, complaint);
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(results).map(([k, v]) => [
        k,
        typeof v === 'string'
          ? v
          : {
              code: v.code,
              watchdogKilled: v.summary?.watchdogKilled,
              interrupted: v.summary?.interrupted,
              minFreePct: v.summary?.minFreePct,
            },
      ]),
    ),
    null,
    2,
  ),
);
if (failures.length > 0) {
  console.error(`bench-run-smoke: ${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('bench-run-smoke OK');
}
