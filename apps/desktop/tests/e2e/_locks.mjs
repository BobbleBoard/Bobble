/**
 * ONE MAC, A DOZEN WORKTREES — the slots every lane takes before it builds,
 * launches a hidden app, or runs something heavy.
 *
 * The big push (deliverables/research/PLAN.md §4) runs about a dozen agents in
 * a dozen worktrees on one 24 GB Mac. Nothing about any single lane is heavy;
 * all of them at once is. Twelve vite builds, or a model server beside three
 * hidden app instances beside a training run, is how a machine that is fine
 * for each job on its own ends up frozen — and the battery hit 1% and the Mac
 * hibernated during engine benchmarks on the day this was written.
 *
 * ## The slots (PLAN.md §4.3)
 *
 *   heavy 1   model server, GPU generation, training, conversion, >200 MB download
 *   probe 3   a hidden app instance (drops to 1 while a heavy job runs)
 *   build 2   `npm run build` (drops to 1 while a heavy job runs)
 *   test  6   vitest / pytest
 *
 * A slot is a directory, `<root>/<class>-<n>`, made with `mkdir` (atomic: two
 * processes can never both create it) and holding the owner's `pid`. This is
 * the SAME layout `scripts/with-lock.mjs` has used since it landed on main, and
 * it must stay that way: every other lane runs its own copy of that script
 * until it rebases, and the two versions share `/tmp/bobble-locks`. What this
 * module adds on top is compatible with an old reader — extra files it ignores:
 *
 *   `started`   the owner's start time (`ps -o lstart=`), so a RECYCLED pid is
 *               not mistaken for a live owner. macOS wraps at 99999 and a day of
 *               builds spawns tens of thousands of processes, so a crashed
 *               owner's pid coming back as someone's shell is not hypothetical;
 *               without this, that slot would be held forever.
 *   `cmd`       what is running and where (the old script wrote this too).
 *
 * ## Extra conditions for a heavy job
 *
 * A heavy job also waits for (PLAN.md §4.3 and §4.5):
 *   - AC power. On battery nothing heavy starts, and a heavy job already
 *     running under `scripts/with-lock.mjs` is paused until AC (paceHeavy).
 *   - The user's own Bobble to have no model loaded and no generation running (a
 *     model server or a Python worker descended from /Applications/Bobble.app,
 *     or from a dev `electron .` in the main checkout).
 *   - no ORPHANED model server — `ppid == 1` and running out of the app's own
 *     cache root. An orphan holds a whole model resident and silently fakes
 *     "Compute error"/OOM in whatever is measured next (memory
 *     `pi-desktop-orphan-servers`). They are safe to kill: a server owned by a
 *     live app always has a live parent. `scripts/bench-run.sh` sweeps them.
 *   - at most one probe and one build already running, so "1 probe while a
 *     heavy job runs" is true from the moment it starts, not only for probes
 *     that start after it. While it waits for that alone, it leaves a
 *     `heavy-pending` marker and new probes and builds are held to one, so a
 *     busy afternoon of probes cannot starve it.
 *
 * ## Nesting
 *
 * A lease hands its child processes `BOBBLE_LOCK_HELD=<classes>`. The probe
 * harness reads it, so `with-lock.mjs probe -- node tests/e2e/x.mjs` does not
 * take a second probe slot inside the first (three wrapped probes would
 * otherwise each wait forever for a fourth), and a probe that is PART of a
 * heavy BENCH job does not count against the probe cap.
 *
 * CLI (run from anywhere):
 *
 *   node apps/desktop/tests/e2e/_locks.mjs status [--json]
 *   node apps/desktop/tests/e2e/_locks.mjs blockers          heavy-job blockers; exit 1 if any
 *   node apps/desktop/tests/e2e/_locks.mjs orphans [--kill]  list (or sweep) orphaned servers
 *   node apps/desktop/tests/e2e/_locks.mjs clean             remove slots whose owner is dead
 *
 * Plain Node ESM with no dependencies, on purpose: `scripts/with-lock.mjs`
 * wraps every build and probe of every lane, so this must never fail to load.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The caps, PLAN.md §4.3. */
export const LOCK_CAPS = Object.freeze({ heavy: 1, probe: 3, build: 2, test: 6 });

/** Classes a heavy job shrinks to one slot while it runs. */
const SHRINKS_UNDER_HEAVY = new Set(['probe', 'build']);

/** How long a waiter waits before giving up (LOCK_WAIT_MS overrides). */
export const DEFAULT_WAIT_MS = Object.freeze({
  heavy: 12 * 60 * 60_000,
  probe: 45 * 60_000,
  build: 45 * 60_000,
  test: 45 * 60_000,
});

/** The env var a lease hands its children: the classes an ancestor holds. */
export const HELD_ENV = 'BOBBLE_LOCK_HELD';

/**
 * A slot with no pid file is normally one being written (mkdir, then the pid,
 * microseconds apart). Past this age it is a writer that died in between.
 */
const HALF_WRITTEN_GRACE_MS = 30_000;

/** The reclaim mutex's critical section is milliseconds; this old means its holder died. */
const MUTEX_STALE_MS = 10_000;

export function lockRoot(env = process.env) {
  // `||`, not `??`: an EMPTY value would otherwise make every slot a relative
  // path in whatever directory the caller happens to be in.
  return env.BOBBLE_LOCK_DIR || '/tmp/bobble-locks';
}

export class LockTimeoutError extends Error {
  constructor(cls, waitMs, why) {
    super(`no ${cls} slot free after ${Math.round(waitMs / 60_000)} min${why ? ` (${why})` : ''}`);
    this.name = 'LockTimeoutError';
    this.cls = cls;
    this.exitCode = 75; // EX_TEMPFAIL, what with-lock.mjs has always exited with
  }
}

function assertClass(cls) {
  if (!Object.hasOwn(LOCK_CAPS, cls)) {
    throw new Error(`unknown lock class "${cls}" (expected ${Object.keys(LOCK_CAPS).join('|')})`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ── process facts ───────────────────────────────────────────────────────────

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is just not ours to signal.
    return e.code === 'EPERM';
  }
}

const startMemo = new Map();

/** `ps -o lstart=` for one pid — stable for a process's whole life. */
export function processStart(pid) {
  // Memoised for a second: a dozen waiters polling every 2 s would otherwise
  // spawn a `ps` per held slot per check, machine-wide.
  const hit = startMemo.get(pid);
  if (hit !== undefined && Date.now() - hit.at < 1000) return hit.value;
  let value = null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    }).trim();
    value = out.length > 0 ? out : null;
  } catch {
    value = null;
  }
  startMemo.set(pid, { value, at: Date.now() });
  if (startMemo.size > 256) startMemo.clear();
  return value;
}

const defaultRun = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 8000,
    maxBuffer: 32 * 1024 * 1024,
  });

// ── slots ───────────────────────────────────────────────────────────────────

export function slotDir(cls, index, root = lockRoot()) {
  return path.join(root, `${cls}-${index}`);
}

/** What a slot directory says about its owner, or null when it does not exist. */
export function readSlot(dir) {
  let since;
  try {
    since = statSync(dir).mtimeMs;
  } catch {
    return null;
  }
  const pidText = readText(path.join(dir, 'pid'));
  const pid = pidText === null ? 0 : Number(pidText.trim());
  const [command = '', cwd = ''] = (readText(path.join(dir, 'cmd')) ?? '').split('\n');
  const started = readText(path.join(dir, 'started'))?.trim() || null;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    started,
    command,
    cwd,
    since,
    hasPid: pidText !== null,
  };
}

/**
 * Is this owner still the process that took the slot?
 *
 * Alive by pid AND, when the slot recorded one, started at the same instant —
 * a pid that died and came back as something else is not the owner.
 */
export function ownerAlive(owner, deps = {}) {
  const { alive = pidAlive, startOf = processStart } = deps;
  if (owner === null || !(owner.pid > 0)) return false;
  if (!alive(owner.pid)) return false;
  if (owner.started) {
    const now = startOf(owner.pid);
    if (now !== null && now !== owner.started) return false;
  }
  return true;
}

/**
 * `free` (no dir), `held` (a live owner), `writing` (just made, pid not yet
 * written), or `stale` (a dead owner, or a writer that died mid-write).
 */
export function slotState(dir, deps = {}) {
  const { now = Date.now() } = deps;
  const owner = readSlot(dir);
  if (owner === null) return 'free';
  if (!owner.hasPid) return now - owner.since > HALF_WRITTEN_GRACE_MS ? 'stale' : 'writing';
  return ownerAlive(owner, deps) ? 'held' : 'stale';
}

function writeOwner(dir, { pid, command, cwd, startOf = processStart }) {
  // The pid first: an old reader treats a slot without one as "being written"
  // and leaves it alone, which is exactly right for these microseconds.
  writeFileSync(path.join(dir, 'pid'), String(pid));
  writeFileSync(path.join(dir, 'cmd'), `${command}\n${cwd}\n`);
  const started = startOf(pid);
  if (started !== null) writeFileSync(path.join(dir, 'started'), `${started}\n`);
}

/** mkdir, the atomic step. True when this caller created the directory. */
function claim(dir) {
  try {
    mkdirSync(dir);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') {
      // The root itself went away (someone cleaned /tmp) — make it and retry once.
      mkdirSync(path.dirname(dir), { recursive: true });
      try {
        mkdirSync(dir);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Take the reclaim mutex. Reclaiming is the one non-atomic step (remove a dead
 * owner's slot, then make it again): two waiters that both saw the same dead
 * owner must not both remove-and-remake, or the second removes the first's
 * fresh, LIVE slot and both run — two heavy jobs at once on a 24 GB machine.
 */
function takeMutex(root) {
  const dir = path.join(root, '.reclaim');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'pid'), String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        if (Date.now() - statSync(dir).mtimeMs > MUTEX_STALE_MS) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // gone between the mkdir and the stat — try again at once
      }
      sleepSync(20);
    }
  }
  return null;
}

/**
 * Remove a stale slot — and, unless `remake` is false, claim it — under the
 * mutex. True when the stale slot was removed (and, with `remake`, is now this
 * caller's).
 */
function reclaim(dir, root, deps, { remake = true } = {}) {
  const release = takeMutex(root);
  if (release === null) return false;
  try {
    // Re-read under the mutex: another waiter may have reclaimed it first, and
    // it may have a live owner again by now.
    if (slotState(dir, deps) !== 'stale') return false;
    rmSync(dir, { recursive: true, force: true });
    return remake ? claim(dir) : true;
  } finally {
    release();
  }
}

function heldCount(cls, root, deps) {
  let n = 0;
  for (let i = 0; i < LOCK_CAPS[cls]; i++) {
    if (slotState(slotDir(cls, i, root), deps) === 'held') n += 1;
  }
  return n;
}

/** Is any slot of `cls` held by a live owner? */
export function classHeld(cls, opts = {}) {
  assertClass(cls);
  return heldCount(cls, opts.root ?? lockRoot(opts.env), opts) > 0;
}

/** The cap right now: probes and builds shrink to one while a heavy job runs. */
export function capNow(cls, opts = {}) {
  assertClass(cls);
  if (!SHRINKS_UNDER_HEAVY.has(cls)) return LOCK_CAPS[cls];
  if (classHeld('heavy', opts) || heavyPending(opts)) return 1;
  return LOCK_CAPS[cls];
}

/*
 * HEAVY PENDING. A heavy job starts beside at most one probe and one build, so
 * it waits for them to drain — and with a dozen lanes launching probes all day
 * they might never drain on their own. While a heavy job is waiting on THAT
 * alone, it leaves a `heavy-pending` marker (same layout as a slot), and new
 * probes and builds are capped at one exactly as if it were already running.
 * Only then: a heavy job waiting for AC power must not throttle every lane for
 * the hours it may take.
 */
const PENDING = 'heavy-pending';

/** Is a live heavy job waiting for probes and builds to drain? */
export function heavyPending(opts = {}) {
  const dir = path.join(opts.root ?? lockRoot(opts.env), PENDING);
  return slotState(dir, opts) === 'held';
}

function markPending(root, pid, command, cwd, deps) {
  const dir = path.join(root, PENDING);
  const mine = claim(dir) || (slotState(dir, deps) === 'stale' && reclaim(dir, root, deps));
  if (mine) writeOwner(dir, { pid, command, cwd, startOf: deps.startOf });
  // Another heavy waiter holding the marker serves the same purpose.
}

function clearPending(root, pid) {
  const dir = path.join(root, PENDING);
  const o = readSlot(dir);
  if (o !== null && o.pid === pid) rmSync(dir, { recursive: true, force: true });
}

/**
 * One attempt, no waiting. Returns the slot directory now owned by `pid`, or
 * null. Does not check the heavy-job conditions — {@link acquire} does.
 */
export function tryAcquire(cls, opts = {}) {
  assertClass(cls);
  const root = opts.root ?? lockRoot(opts.env);
  const pid = opts.pid ?? process.pid;
  const command = opts.command ?? process.argv.slice(1).join(' ');
  const cwd = opts.cwd ?? process.cwd();
  mkdirSync(root, { recursive: true });
  const cap = capNow(cls, { ...opts, root });
  for (let i = 0; i < cap; i++) {
    const dir = slotDir(cls, i, root);
    const mine = claim(dir) || (slotState(dir, opts) === 'stale' && reclaim(dir, root, opts));
    if (!mine) continue;
    writeOwner(dir, { pid, command, cwd, startOf: opts.startOf });
    return dir;
  }
  return null;
}

/** Remove a slot, but only if it is still ours — never someone who reclaimed it. */
export function releaseSlot(dir, pid = process.pid) {
  const owner = readSlot(dir);
  if (owner !== null && owner.pid !== pid && owner.hasPid) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The classes an ancestor process holds, from {@link HELD_ENV}. */
export function heldByAncestor(cls, env = process.env) {
  return (env[HELD_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(cls);
}

function heldEnvValue(cls, env) {
  const held = new Set(
    (env[HELD_ENV] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  held.add(cls);
  return [...held].join(',');
}

function makeLease(cls, dir, root, pid, env) {
  let released = false;
  const onExit = () => {
    if (!released) releaseSlot(dir, pid);
  };
  process.once('exit', onExit);
  return {
    cls,
    slot: dir,
    root,
    pid,
    /** Env to hand a child so it knows this class is already held above it. */
    env: () => ({ [HELD_ENV]: heldEnvValue(cls, env) }),
    release() {
      if (released) return;
      released = true;
      process.removeListener('exit', onExit);
      releaseSlot(dir, pid);
    },
  };
}

function describeHolders(cls, root, deps) {
  const out = [];
  for (let i = 0; i < LOCK_CAPS[cls]; i++) {
    const dir = slotDir(cls, i, root);
    if (slotState(dir, deps) !== 'held') continue;
    const o = readSlot(dir);
    out.push(`pid ${o.pid} \`${o.command.slice(0, 60)}\``);
  }
  return out.join(', ');
}

/**
 * Wait for a slot of `cls` and take it. Resolves to a lease; `lease.release()`
 * gives it back (and it is given back on process exit regardless).
 *
 * Options: `waitMs`, `pollMs` (2 s), `command`/`cwd` (recorded in the slot),
 * `log` (a line writer; stderr by default), `root`, `env`, and — for tests —
 * `pid`, `run`, `platform`, `alive`, `startOf`.
 */
export async function acquire(cls, opts = {}) {
  assertClass(cls);
  const env = opts.env ?? process.env;
  const root = opts.root ?? lockRoot(env);
  const envWait = env.LOCK_WAIT_MS !== undefined ? Number(env.LOCK_WAIT_MS) : undefined;
  const waitMs = opts.waitMs ?? envWait ?? DEFAULT_WAIT_MS[cls];
  const pollMs = opts.pollMs ?? 2000;
  const pid = opts.pid ?? process.pid;
  const say = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const startedAt = Date.now();
  let lastWhy = '';
  let lastSaidAt = 0;
  const command = opts.command ?? process.argv.slice(1).join(' ');
  const cwd = opts.cwd ?? process.cwd();
  const dropPending = () => clearPending(root, pid);
  if (cls === 'heavy') process.once('exit', dropPending);
  try {
    for (;;) {
      const blockers = cls === 'heavy' ? heavyBlockers({ ...opts, root }) : [];
      if (blockers.length === 0) {
        const dir = tryAcquire(cls, { ...opts, root, pid });
        if (dir !== null) {
          if (lastWhy !== '') say(`[locks] got a ${cls} slot after ${elapsed(startedAt)}`);
          return makeLease(cls, dir, root, pid, env);
        }
      }
      if (cls === 'heavy') {
        // Waiting only for probes and builds to drain: ask new ones to hold back.
        if (blockers.length > 0 && blockers.every((b) => b.kind === 'busy')) {
          markPending(root, pid, command, cwd, opts);
        } else dropPending();
      }
      const why =
        blockers.length > 0
          ? blockers.map((b) => b.detail).join('; ')
          : `all ${capNow(cls, { ...opts, root })} ${cls} slot(s) busy: ${describeHolders(cls, root, opts)}`;
      if (Date.now() - startedAt > waitMs) throw new LockTimeoutError(cls, waitMs, why);
      if (why !== lastWhy || Date.now() - lastSaidAt > 60_000) {
        say(`[locks] waiting for a ${cls} slot — ${why}`);
        lastWhy = why;
        lastSaidAt = Date.now();
      }
      await sleep(pollMs);
    }
  } finally {
    if (cls === 'heavy') {
      dropPending();
      process.removeListener('exit', dropPending);
    }
  }
}

function elapsed(since) {
  const s = Math.round((Date.now() - since) / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/** acquire → fn(lease) → release, whatever fn does. */
export async function withLock(cls, fn, opts = {}) {
  const lease = await acquire(cls, opts);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}

// ── processes: orphans and the user's own app ───────────────────────────────────

/**
 * `ps -axo pid=,ppid=,command=` → rows. The same parse as
 * electron/inference/reap-orphans.ts (`parseProcessRows`); `_locks.test.ts`
 * holds the two to the same answers.
 */
export function parseProcessRows(psOutput) {
  const rows = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/** A model server, as opposed to a pip install or a `--help` run from the same venv. */
export function isServerCommand(command) {
  if (command.includes('llama-server')) return true;
  if (/\bmlx_lm\.server\b/.test(command)) return true;
  // `<venv>/bin/rapid-mlx serve …`, `…/dflash serve …`, `…/vllm serve …`
  return /\/bin\/[\w.-]+\s+serve(\s|$)/.test(command);
}

/**
 * The app's own binary roots, in ANY home: the real one and every probe's
 * throwaway one (`…/pd-home-x/.cache/bobble/llamacpp/…`). A server a person
 * started by hand from Homebrew is never in scope. The app's reaper passes
 * `<cache>/llamacpp` and `<cache>/engines` for its own cache; this is the same
 * pair for every cache at once, plus a `PI_DESKTOP_CACHE_DIR` override.
 */
export function orphanRootTest(env = process.env) {
  const extra = env.PI_DESKTOP_CACHE_DIR
    ? [
        path.join(env.PI_DESKTOP_CACHE_DIR, 'llamacpp'),
        path.join(env.PI_DESKTOP_CACHE_DIR, 'engines'),
      ]
    : [];
  const re = /\/\.cache\/(?:bobble|pi-desktop)\/(?:llamacpp|engines)\//;
  return (command) => re.test(command) || extra.some((root) => command.includes(root));
}

/**
 * Model servers from our own cache root whose parent is gone: `ppid == 1`, or
 * a parent missing from the table. Same rule as the app's launch-time reaper
 * (reap-orphans.ts `orphanedServers`), applied to every cache root at once.
 */
export function findOrphanServers(rows, opts = {}) {
  const underRoot = opts.underRoot ?? orphanRootTest(opts.env);
  const self = opts.self ?? process.pid;
  const live = new Set(rows.map((r) => r.pid));
  return rows.filter(
    (r) =>
      r.pid !== self &&
      underRoot(r.command) &&
      isServerCommand(r.command) &&
      (r.ppid === 1 || !live.has(r.ppid)),
  );
}

/**
 * Is this command the user's own Bobble — the installed app, or a dev `electron .`
 * run from the MAIN checkout? A probe's Electron runs from a worktree, or with
 * a throwaway `--user-data-dir` under the temp dir, and is never their.
 */
export function isUserAppCommand(command, mainCheckout = MAIN_CHECKOUT) {
  if (command.includes('/Applications/Bobble.app/')) return true;
  if (!/\/Electron\.app\/Contents\/MacOS\/Electron(\s|$)/.test(command)) return false;
  if (command.includes('/.claude/worktrees/')) return false;
  if (/--user-data-dir=\S*\/(T|tmp)\/(pd|pi)-/.test(command)) return false;
  return command.includes(`${mainCheckout}/`);
}

/**
 * The main checkout — this repo's root, or, from a lane's worktree, the
 * checkout that `.claude/worktrees/<lane>` lives in.
 */
export const MAIN_CHECKOUT = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
  .split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0];

/** A model server, or a Python worker (image/3D/audio generation), of the user's app. */
export function busyInstalledApp(rows, opts = {}) {
  const isUserApp = opts.isUserApp ?? isUserAppCommand;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const busy = [];
  for (const r of rows) {
    const heavy = isServerCommand(r.command) || /\bpython[0-9.]*\b|\/Python\b/i.test(r.command);
    if (!heavy) continue;
    let p = byPid.get(r.ppid);
    for (let depth = 0; p !== undefined && depth < 8; depth++) {
      if (isUserApp(p.command)) {
        busy.push(r);
        break;
      }
      p = byPid.get(p.ppid);
    }
  }
  return busy;
}

function shortCommand(command) {
  const first = command.split(/\s+/)[0] ?? command;
  return path.basename(first);
}

function batteryPercent(pmset) {
  const m = /(\d+)%/.exec(pmset);
  return m === null ? null : Number(m[1]);
}

/**
 * Why a heavy job may not start right now — [] when it may. Each entry is
 * `{ kind, detail, pids? }`, kind one of `battery`, `user-app`, `orphans`,
 * `busy`.
 */
export function heavyBlockers(opts = {}) {
  const run = opts.run ?? defaultRun;
  const platform = opts.platform ?? process.platform;
  const root = opts.root ?? lockRoot(opts.env);
  const reasons = [];
  if (platform === 'darwin') {
    let batt = null;
    try {
      batt = run('pmset', ['-g', 'batt']);
    } catch {
      /* no pmset: nothing to check */
    }
    if (batt !== null && !batt.includes("'AC Power'")) {
      const pct = batteryPercent(batt);
      reasons.push({ kind: 'battery', detail: `on battery${pct === null ? '' : ` (${pct}%)`}` });
    }
  }
  let rows = null;
  try {
    rows = parseProcessRows(run('ps', ['-axo', 'pid=,ppid=,command=']));
  } catch {
    /* ps unavailable: nothing to check */
  }
  if (rows !== null) {
    const busyApps = busyInstalledApp(rows, opts);
    if (busyApps.length > 0) {
      const what = [...new Set(busyApps.map((r) => shortCommand(r.command)))].join(', ');
      reasons.push({
        kind: 'user-app',
        detail: `the user's Bobble is busy (${what}, pid ${busyApps.map((r) => r.pid).join(' ')})`,
        pids: busyApps.map((r) => r.pid),
      });
    }
    const orphans = findOrphanServers(rows, opts);
    if (orphans.length > 0) {
      reasons.push({
        kind: 'orphans',
        detail: `orphaned model server(s) pid ${orphans.map((r) => r.pid).join(' ')} — sweep with \`node apps/desktop/tests/e2e/_locks.mjs orphans --kill\``,
        pids: orphans.map((r) => r.pid),
      });
    }
  }
  const probes = heldCount('probe', root, opts);
  const builds = heldCount('build', root, opts);
  if (probes > 1 || builds > 1) {
    reasons.push({
      kind: 'busy',
      detail: `${probes} probe(s) and ${builds} build(s) running — a heavy job starts beside at most one of each`,
    });
  }
  return reasons;
}

// ── pacing a running heavy job ──────────────────────────────────────────────

/** Whether pmset says the Mac is on battery (false off macOS, or unread). */
export function onBattery(opts = {}) {
  const run = opts.run ?? defaultRun;
  if ((opts.platform ?? process.platform) !== 'darwin') return false;
  try {
    return !run('pmset', ['-g', 'batt']).includes("'AC Power'");
  } catch {
    return false;
  }
}

/** `root` and every process descended from it, parents before children. */
export function processTree(rows, root) {
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const out = [];
  const todo = [root];
  while (todo.length > 0) {
    const pid = todo.shift();
    if (out.includes(pid)) continue;
    out.push(pid);
    todo.push(...(kids.get(pid) ?? []));
  }
  return out;
}

/**
 * ON BATTERY NOTHING HEAVY RUNS — not only "starts". The AC gate above holds a
 * heavy job's start; one that began on AC kept its model server and the GPU
 * busy after the charger came out (2026-09-25: an OmniSVG comparison ran on
 * into the battery, and an agent saw it at 2%). This checks the power every
 * `intervalMs`: on battery it stops the job's whole process tree (SIGSTOP —
 * nothing computes, nothing is lost), back on AC it lets it go on (SIGCONT).
 * `stop()` lets a paused job go on (so a signal meant to end it lands) and
 * stops watching; `tick()` is one check, for tests.
 */
export function paceHeavy(pid, opts = {}) {
  const run = opts.run ?? defaultRun;
  const kill = opts.kill ?? ((p, sig) => process.kill(p, sig));
  const log = opts.log ?? ((m) => console.error(m));
  let paused = [];
  const signal = (pids, sig) => {
    for (const p of pids) {
      try {
        kill(p, sig);
      } catch {
        /* already gone */
      }
    }
  };
  const resume = () => {
    signal(paused, 'SIGCONT');
    paused = [];
  };
  const tick = () => {
    const battery = onBattery(opts);
    if (battery && paused.length === 0) {
      let rows;
      try {
        rows = parseProcessRows(run('ps', ['-axo', 'pid=,ppid=,command=']));
      } catch {
        return;
      }
      paused = processTree(rows, pid);
      signal([...paused].reverse(), 'SIGSTOP');
      log(`with-lock: on battery — the heavy job is paused (pid ${paused.join(' ')}) until AC`);
    } else if (!battery && paused.length > 0) {
      resume();
      log('with-lock: on AC — the heavy job goes on');
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 20_000);
  timer.unref?.();
  return {
    tick,
    get paused() {
      return paused.length > 0;
    },
    stop() {
      clearInterval(timer);
      if (paused.length > 0) resume();
    },
  };
}

/**
 * Stop every orphaned model server: SIGTERM, then SIGKILL whatever is still
 * there after `graceMs`. Returns the pids that were signalled.
 */
export async function sweepOrphanServers(opts = {}) {
  const run = opts.run ?? defaultRun;
  const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig));
  const alive = opts.alive ?? pidAlive;
  const graceMs = opts.graceMs ?? 3000;
  let rows;
  try {
    rows = parseProcessRows(run('ps', ['-axo', 'pid=,ppid=,command=']));
  } catch {
    return [];
  }
  const orphans = findOrphanServers(rows, opts);
  const signalled = [];
  for (const r of orphans) {
    try {
      kill(r.pid, 'SIGTERM');
      signalled.push(r.pid);
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + graceMs;
  while (signalled.some(alive) && Date.now() < deadline) await sleep(100);
  for (const pid of signalled) {
    if (!alive(pid)) continue;
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* gone at the last moment */
    }
  }
  return signalled;
}

/** Remove every slot whose owner is dead. Returns the directories removed. */
export function cleanStaleSlots(opts = {}) {
  const root = opts.root ?? lockRoot(opts.env);
  const removed = [];
  for (const cls of Object.keys(LOCK_CAPS)) {
    for (let i = 0; i < LOCK_CAPS[cls]; i++) {
      const dir = slotDir(cls, i, root);
      if (slotState(dir, opts) === 'stale' && reclaim(dir, root, opts, { remake: false })) {
        removed.push(dir);
      }
    }
  }
  return removed;
}

/** Every class, every slot, and what would stop a heavy job — for `status` and reports. */
export function lockStatus(opts = {}) {
  const root = opts.root ?? lockRoot(opts.env);
  const classes = {};
  for (const cls of Object.keys(LOCK_CAPS)) {
    const slots = [];
    for (let i = 0; i < LOCK_CAPS[cls]; i++) {
      const dir = slotDir(cls, i, root);
      const state = slotState(dir, opts);
      const o = state === 'free' ? null : readSlot(dir);
      slots.push({
        index: i,
        state,
        ...(o !== null ? { pid: o.pid, command: o.command, cwd: o.cwd, since: o.since } : {}),
      });
    }
    classes[cls] = { cap: LOCK_CAPS[cls], capNow: capNow(cls, { ...opts, root }), slots };
  }
  const pending = readSlot(path.join(root, PENDING));
  return {
    root,
    classes,
    heavyPending: heavyPending({ ...opts, root })
      ? { pid: pending.pid, command: pending.command }
      : null,
    heavyBlockers: heavyBlockers({ ...opts, root }),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function printStatus(s) {
  console.log(`lock root: ${s.root}`);
  for (const [cls, c] of Object.entries(s.classes)) {
    const held = c.slots.filter((x) => x.state === 'held');
    const shrunk = c.capNow !== c.cap ? ` (cap ${c.capNow} while heavy runs or waits)` : '';
    console.log(`${cls.padEnd(6)} ${held.length}/${c.cap}${shrunk}`);
    for (const x of c.slots) {
      if (x.state === 'free') continue;
      const age = x.since ? elapsed(x.since) : '?';
      console.log(
        `  ${cls}-${x.index} ${x.state} pid ${x.pid} for ${age}: ${x.command} [${x.cwd}]`,
      );
    }
  }
  const running = s.classes.heavy.slots.find((x) => x.state === 'held');
  if (running !== undefined)
    console.log(`heavy: RUNNING (pid ${running.pid}) — the next one waits`);
  if (s.heavyPending !== null) {
    console.log(
      `heavy: PENDING (pid ${s.heavyPending.pid}: ${s.heavyPending.command}) — probes and builds held to one`,
    );
  }
  for (const b of s.heavyBlockers) console.log(`heavy blocked: ${b.detail}`);
  if (running === undefined && s.heavyBlockers.length === 0) console.log('heavy: may start now');
}

async function main(argv) {
  const [cmd = 'status', ...rest] = argv;
  if (cmd === 'status') {
    const s = lockStatus();
    if (rest.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else printStatus(s);
    return 0;
  }
  if (cmd === 'blockers') {
    const b = heavyBlockers();
    if (classHeld('heavy')) b.unshift({ kind: 'running', detail: 'a heavy job holds the slot' });
    for (const x of b) console.log(`${x.kind}: ${x.detail}`);
    if (b.length === 0) console.log('none — a heavy job may start');
    return b.length === 0 ? 0 : 1;
  }
  if (cmd === 'orphans') {
    if (rest.includes('--kill')) {
      const pids = await sweepOrphanServers();
      console.log(pids.length === 0 ? 'no orphaned model servers' : `stopped ${pids.join(' ')}`);
      return 0;
    }
    const rows = parseProcessRows(defaultRun('ps', ['-axo', 'pid=,ppid=,command=']));
    const orphans = findOrphanServers(rows);
    if (orphans.length === 0) console.log('no orphaned model servers');
    for (const r of orphans) console.log(`${r.pid} ${r.command}`);
    return 0;
  }
  if (cmd === 'clean') {
    const removed = cleanStaleSlots();
    console.log(removed.length === 0 ? 'no stale slots' : `removed ${removed.join(' ')}`);
    return 0;
  }
  console.error('usage: _locks.mjs status [--json] | blockers | orphans [--kill] | clean');
  return 64;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
