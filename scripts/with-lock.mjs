#!/usr/bin/env node
/**
 * Run a command while holding one slot of a machine-wide semaphore.
 *
 * The big push runs a dozen agents in a dozen worktrees on one 24 GB Mac
 * (deliverables/research/PLAN.md §4.3). Without a shared limit they all build
 * and all launch hidden app instances at once. Every lane wraps its heavy
 * steps in this:
 *
 *   node scripts/with-lock.mjs build -- npm run build
 *   node scripts/with-lock.mjs probe -- node tests/e2e/some-probe.mjs
 *   node scripts/with-lock.mjs heavy -- <anything that loads a model>   (BENCH only;
 *        prefer scripts/bench-run.sh, which adds caffeinate, a memory trace,
 *        a watchdog and orphan sweeps)
 *
 * Classes and caps: heavy 1, probe 3, build 2, test 6. While a HEAVY job runs,
 * probe and build drop to 1 slot each. A heavy job also waits for AC power,
 * for the user's own Bobble to have no model loaded, for no orphaned model server,
 * and for at most one probe and one build already running.
 *
 * The slots, their layout and every rule live in
 * apps/desktop/tests/e2e/_locks.mjs — this file is only the command line over
 * it, so a probe that takes a slot from JavaScript and a build that takes one
 * from here are counted against the same caps. The command's child gets
 * BOBBLE_LOCK_HELD=<class>, so a wrapped probe does not take a second probe
 * slot inside the first.
 *
 * Waits (polling every 2 s) up to LOCK_WAIT_MS (default 45 min; heavy 12 h),
 * then gives up with exit code 75. The command's own exit code passes through.
 */
import { spawn } from 'node:child_process';
import { acquire, LOCK_CAPS, LockTimeoutError } from '../apps/desktop/tests/e2e/_locks.mjs';

const [cls, sep, ...cmd] = process.argv.slice(2);
if (!Object.hasOwn(LOCK_CAPS, cls ?? '') || sep !== '--' || cmd.length === 0) {
  console.error('usage: with-lock.mjs <heavy|probe|build|test> -- <command…>');
  process.exit(64);
}

let lease;
try {
  lease = await acquire(cls, { command: cmd.join(' '), cwd: process.cwd() });
} catch (e) {
  if (e instanceof LockTimeoutError) {
    console.error(`with-lock: ${e.message}`);
    process.exit(75);
  }
  throw e;
}

const child = spawn(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, ...lease.env() },
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
child.on('exit', (code, signal) => {
  lease.release();
  process.exit(code ?? (signal !== null ? 1 : 0));
});
child.on('error', (err) => {
  lease.release();
  console.error(`with-lock: ${err.message}`);
  process.exit(127);
});
