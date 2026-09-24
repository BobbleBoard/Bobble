/**
 * DO THE LOCKS ACTUALLY SERIALIZE? — W0-B's acceptance for _locks.mjs.
 *
 * Unit tests prove the rules on one process's view of the slots. This proves
 * the thing that matters on a machine a dozen agents share: two SEPARATE
 * scripts that both want a one-slot class run one after the other, through the
 * real `scripts/with-lock.mjs`, and the JavaScript API and the command line
 * count against the same slots.
 *
 * Everything runs in a PRIVATE lock root (a temp BOBBLE_LOCK_DIR), never the
 * shared /tmp/bobble-locks the other worktrees are using right now.
 *
 *   1. probe under heavy — a held heavy slot shrinks probes to one; two
 *      wrapped scripts compete for it and their critical sections must not
 *      overlap.
 *   2. JS and CLI share the slots — this process holds the one probe slot via
 *      acquire(); a wrapped script must wait until it is released.
 *   3. a dead owner — a wrapper SIGKILLed mid-run leaves its slot behind; the
 *      next script takes it over within a poll or two instead of waiting
 *      forever.
 *   4. two heavy scripts — the literal case, when this machine allows a heavy
 *      job right now (AC, the user's app idle, no orphans); otherwise recorded as
 *      skipped with the reason.
 *   5. no starvation — a heavy job waiting for two running probes to drain
 *      leaves its pending marker, a new probe is held back even though a slot
 *      is free, the heavy job starts once the probes drain, and the held-back
 *      probe runs after it.
 *
 *   node tests/e2e/locks-smoke-probe.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquire, heavyBlockers, heavyPending, tryAcquire } from './_locks.mjs';
import { focusComplaint, frontmostApp, REPO_ROOT } from './harness.mjs';

const WITH_LOCK = path.join(REPO_ROOT, 'scripts', 'with-lock.mjs');
const ROOT = mkdtempSync(path.join(tmpdir(), 'locks-smoke-'));
const LOCK_DIR = path.join(ROOT, 'locks');
mkdirSync(LOCK_DIR);
const HOLD_MS = 1500;

const failures = [];
const check = (ok, message) => {
  if (!ok) {
    failures.push(message);
    console.error(`locks-smoke FAILED: ${message}`);
  }
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The critical section: stamp in, hold, stamp out. */
const WORKER = path.join(ROOT, 'worker.mjs');
writeFileSync(
  WORKER,
  `import { appendFileSync } from 'node:fs';
const [id, log, hold] = process.argv.slice(2);
appendFileSync(log, \`start \${id} \${Date.now()}\\n\`);
await new Promise((r) => setTimeout(r, Number(hold)));
appendFileSync(log, \`end \${id} \${Date.now()}\\n\`);
`,
);

/** `node with-lock.mjs <cls> -- node worker.mjs <id> <log>` in the private root. */
function wrapped(cls, id, log, hold = HOLD_MS) {
  const child = spawn(
    process.execPath,
    [WITH_LOCK, cls, '--', process.execPath, WORKER, id, log, String(hold)],
    {
      env: {
        ...process.env,
        BOBBLE_LOCK_DIR: LOCK_DIR,
        LOCK_WAIT_MS: '60000',
        BOBBLE_LOCK_HELD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const done = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  return { child, done };
}

/** start/end per id from a worker log. */
function intervals(log) {
  const out = {};
  for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
    const [what, id, at] = line.split(' ');
    out[id] ??= {};
    out[id][what] = Number(at);
  }
  return out;
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

async function waitForLine(log, text, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (readFileSync(log, 'utf8').includes(text)) return true;
    } catch {
      /* not written yet */
    }
    await sleep(50);
  }
  return false;
}

const before = frontmostApp();
const results = {};
try {
  // ── 1. two wrapped scripts, one probe slot (a heavy job holds) ──────────────
  const heavy = tryAcquire('heavy', {
    root: LOCK_DIR,
    command: 'locks-smoke (stand-in heavy job)',
  });
  check(heavy !== null, 'could not plant the stand-in heavy slot');
  {
    const log = path.join(ROOT, 'one.log');
    const a = wrapped('probe', 'A', log);
    await sleep(150);
    const b = wrapped('probe', 'B', log);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    const iv = intervals(log);
    check(ra.code === 0 && rb.code === 0, `scripts exited ${ra.code}/${rb.code}`);
    check(iv.A?.end && iv.B?.end, `both critical sections ran: ${JSON.stringify(iv)}`);
    check(!overlaps(iv.A, iv.B), `probe critical sections overlapped: ${JSON.stringify(iv)}`);
    check(
      /\[locks\] waiting for a probe slot/.test(ra.stderr + rb.stderr),
      'the second script never said it was waiting',
    );
    results.probeUnderHeavy = {
      A: iv.A,
      B: iv.B,
      gapMs: Math.max(iv.B.start - iv.A.end, iv.A.start - iv.B.end),
    };
  }

  // ── 2. JS API and CLI count against the same slot ──────────────────────────
  {
    const log = path.join(ROOT, 'two.log');
    const lease = await acquire('probe', { root: LOCK_DIR, command: 'locks-smoke (JS lease)' });
    const c = wrapped('probe', 'C', log, 200);
    await sleep(2500);
    let startedEarly = false;
    try {
      startedEarly = readFileSync(log, 'utf8').includes('start C');
    } catch {
      /* nothing written: correct */
    }
    check(!startedEarly, 'a wrapped script ran while a JS lease held the only probe slot');
    const releasedAt = Date.now();
    lease.release();
    const rc = await c.done;
    const iv = intervals(log);
    check(rc.code === 0, `script C exited ${rc.code}`);
    check(iv.C?.start >= releasedAt, 'script C started before the JS lease was released');
    results.jsAndCli = { releasedAt, cStart: iv.C?.start, waitedMs: iv.C?.start - releasedAt };
  }

  // ── 3. a SIGKILLed owner does not hold its slot forever ────────────────────
  {
    const log = path.join(ROOT, 'three.log');
    const d = wrapped('probe', 'D', log, 30_000);
    check(await waitForLine(log, 'start D'), 'script D never started');
    // Kill the owner (the wrapper) AND its worker, the way a crash does.
    const ownerPid = Number(readFileSync(path.join(LOCK_DIR, 'probe-0', 'pid'), 'utf8'));
    check(ownerPid === d.child.pid, 'the slot is not owned by the wrapper that took it');
    const workers = execFileSync('pgrep', ['-P', String(d.child.pid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
    process.kill(d.child.pid, 'SIGKILL');
    for (const pid of workers) process.kill(pid, 'SIGKILL');
    const killedAt = Date.now();
    await d.done;
    const e = wrapped('probe', 'E', log, 100);
    const re = await e.done;
    const iv = intervals(log);
    check(re.code === 0, `script E exited ${re.code}`);
    check(iv.E?.start !== undefined, 'script E never got the dead owner’s slot');
    check(iv.E?.start - killedAt < 10_000, `takeover took ${iv.E?.start - killedAt} ms`);
    results.deadOwner = { takeoverMs: iv.E?.start - killedAt };
  }
  rmSync(heavy, { recursive: true, force: true });

  // ── 4. two heavy scripts, when the machine allows a heavy job now ───────────
  {
    const blockers = heavyBlockers({ root: LOCK_DIR });
    if (blockers.length > 0) {
      results.heavy = { skipped: blockers.map((b) => b.detail).join('; ') };
      console.log(`heavy scenario skipped: ${results.heavy.skipped}`);
    } else {
      const log = path.join(ROOT, 'four.log');
      const f = wrapped('heavy', 'F', log);
      await sleep(150);
      const g = wrapped('heavy', 'G', log);
      const [rf, rg] = await Promise.all([f.done, g.done]);
      const iv = intervals(log);
      check(rf.code === 0 && rg.code === 0, `heavy scripts exited ${rf.code}/${rg.code}`);
      check(!overlaps(iv.F, iv.G), `heavy critical sections overlapped: ${JSON.stringify(iv)}`);
      results.heavy = { F: iv.F, G: iv.G };
    }
  }

  // ── 5. a waiting heavy job holds new probes to one slot, so probes drain ────
  {
    const blockers = heavyBlockers({ root: LOCK_DIR }).filter((b) => b.kind !== 'busy');
    if (blockers.length > 0) {
      results.pending = { skipped: blockers.map((b) => b.detail).join('; ') };
    } else {
      // Two probes are running (slots 0 and 1); slot 2 is free.
      const p0 = tryAcquire('probe', { root: LOCK_DIR, command: 'locks-smoke (probe 0)' });
      const p1 = tryAcquire('probe', { root: LOCK_DIR, command: 'locks-smoke (probe 1)' });
      const log = path.join(ROOT, 'five.log');
      const h = wrapped('heavy', 'H', log, 300);
      await sleep(1500);
      const pendingSeen = heavyPending({ root: LOCK_DIR });
      check(pendingSeen, 'the waiting heavy job left no pending marker');
      // Without the marker this probe would take the free slot 2 at once.
      const q = wrapped('probe', 'Q', log, 200);
      await sleep(2500);
      let qEarly = false;
      try {
        qEarly = readFileSync(log, 'utf8').includes('start Q');
      } catch {
        /* nothing yet: correct */
      }
      check(!qEarly, 'a new probe started beside two others while a heavy job waited for them');
      const releasedAt = Date.now();
      rmSync(p1, { recursive: true, force: true }); // one probe finishes: one left
      await h.done;
      rmSync(p0, { recursive: true, force: true }); // the other finishes too
      await q.done;
      const iv = intervals(log);
      check(iv.H?.start >= releasedAt, 'the heavy job started before the probes drained');
      check(iv.Q?.start >= iv.H?.start, 'the held-back probe ran before the heavy job');
      check(!heavyPending({ root: LOCK_DIR }), 'the pending marker outlived the heavy job');
      results.pending = {
        pendingSeen,
        heavyStartAfterDrainMs: iv.H?.start - releasedAt,
        probeAfterHeavy: iv.Q?.start - iv.H?.start,
      };
    }
  }
} finally {
  const during = frontmostApp();
  const complaint = focusComplaint(before, during);
  if (complaint !== null) check(false, complaint);
  appendFileSync(path.join(ROOT, 'results.json'), JSON.stringify(results, null, 2));
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
if (failures.length > 0) {
  console.error(`locks-smoke: ${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('locks-smoke OK');
}
