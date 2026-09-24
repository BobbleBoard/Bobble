#!/usr/bin/env node
/**
 * Run a command while holding one slot of a machine-wide semaphore.
 *
 * The big push runs a dozen agents in a dozen worktrees on one 24 GB Mac
 * (deliverables/research/PLAN.md §4.3). Without a shared limit they all build
 * and all launch hidden app instances at once. This is the interim lock every
 * lane uses until W0-B's `tests/e2e/_locks.mjs` lands (which may wrap it):
 *
 *   node scripts/with-lock.mjs build -- npm run build
 *   node scripts/with-lock.mjs probe -- node tests/e2e/some-probe.mjs
 *   node scripts/with-lock.mjs heavy -- <anything that loads a model>   (BENCH only)
 *
 * Classes and caps: heavy 1, probe 3, build 2, test 6. While a HEAVY job runs,
 * probe and build drop to 1 slot each (PLAN.md §4.3). A heavy job also waits
 * for AC power and for the user's own /Applications/Bobble.app to have no model
 * server running. A slot is a directory `/tmp/bobble-locks/<class>-<n>`
 * holding the owner's pid; a slot whose pid is gone is stale and taken over.
 * Waits (polling every 2 s) up to LOCK_WAIT_MS (default 45 min; heavy 12 h),
 * then gives up with exit code 75. The command's own exit code passes through.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CAPS = { heavy: 1, probe: 3, build: 2, test: 6 };
const ROOT = process.env.BOBBLE_LOCK_DIR ?? '/tmp/bobble-locks';

const [cls, sep, ...cmd] = process.argv.slice(2);
if (!(cls in CAPS) || sep !== '--' || cmd.length === 0) {
  console.error('usage: with-lock.mjs <heavy|probe|build|test> -- <command…>');
  process.exit(64);
}
const WAIT_MS = Number(
  process.env.LOCK_WAIT_MS ?? (cls === 'heavy' ? 12 * 60 * 60_000 : 45 * 60_000),
);

/** Is any slot of `c` held by a live process? */
function held(c) {
  for (let i = 0; i < CAPS[c]; i++) {
    try {
      const owner = Number(readFileSync(path.join(ROOT, `${c}-${i}`, 'pid'), 'utf8'));
      if (owner > 0 && alive(owner)) return true;
    } catch {
      /* free */
    }
  }
  return false;
}

/** The cap right now: probes and builds shrink to one while a heavy job runs. */
function capNow() {
  if ((cls === 'probe' || cls === 'build') && held('heavy')) return 1;
  return CAPS[cls];
}

/** Heavy work only on AC, and never while the user's own Bobble has a model up. */
function heavyBlocked() {
  if (cls !== 'heavy' || process.platform !== 'darwin') return null;
  try {
    const batt = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' });
    if (!batt.includes("'AC Power'")) return 'on battery';
  } catch {
    /* no pmset: nothing to check */
  }
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
    const rows = ps.split('\n').map((l) => l.trim().split(/\s+/));
    const byPid = new Map(rows.map((r) => [r[0], r]));
    for (const r of rows) {
      const line = r.slice(2).join(' ');
      if (!/llama-server|rapid-mlx|mlx_lm\.server/.test(line)) continue;
      const parent = byPid.get(r[1])?.slice(2).join(' ') ?? '';
      if (parent.includes('/Applications/Bobble.app/')) return "the user's Bobble has a model loaded";
    }
  } catch {
    /* ps unavailable: nothing to check */
  }
  return null;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

function tryTake() {
  mkdirSync(ROOT, { recursive: true });
  if (heavyBlocked() !== null) return null;
  for (let i = 0; i < capNow(); i++) {
    const slot = path.join(ROOT, `${cls}-${i}`);
    try {
      mkdirSync(slot);
    } catch {
      // Held — unless its owner is gone.
      let owner = 0;
      try {
        owner = Number(readFileSync(path.join(slot, 'pid'), 'utf8'));
      } catch {
        /* being written, or half-cleaned: leave it this round */
        continue;
      }
      if (owner > 0 && !alive(owner)) {
        rmSync(slot, { recursive: true, force: true });
        try {
          mkdirSync(slot);
        } catch {
          continue;
        }
      } else continue;
    }
    writeFileSync(path.join(slot, 'pid'), String(process.pid));
    writeFileSync(path.join(slot, 'cmd'), `${cmd.join(' ')}\n${process.cwd()}\n`);
    return slot;
  }
  return null;
}

const started = Date.now();
let slot = tryTake();
while (slot === null) {
  if (Date.now() - started > WAIT_MS) {
    const why = heavyBlocked();
    console.error(
      `with-lock: no ${cls} slot free after ${Math.round(WAIT_MS / 60000)} min${why ? ` (${why})` : ''}`,
    );
    process.exit(75);
  }
  await new Promise((r) => setTimeout(r, 2000));
  slot = tryTake();
}

const release = () => rmSync(slot, { recursive: true, force: true });
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
child.on('exit', (code, signal) => {
  release();
  process.exit(code ?? (signal !== null ? 1 : 0));
});
child.on('error', (err) => {
  release();
  console.error(`with-lock: ${err.message}`);
  process.exit(127);
});
