/**
 * Launch the app for a probe — invisibly, and prove it stayed that way.
 *
 * the user: "ideally headlessly … it doesn't take any focus away from me, I can use
 * the computer without any notice of any rapid test suites."
 *
 * Every probe used to hand-roll its own `electron.launch`, which meant every
 * probe independently forgot to pass the background flags — so a suite run put
 * a window over whatever you were doing, sixteen times in a row.
 *
 * ## What "invisible" means here
 *
 * The window is created and never shown. A hidden BrowserWindow still runs its
 * renderer, lays out at its real size, animates at full rate, and screenshots
 * correctly — this is not a degraded mode, it simply is not composited to a
 * display. Notifications, the computer-use overlay and second-instance
 * activation are suppressed at their own call sites (electron/background-mode.ts).
 *
 * ## The guarantee
 *
 * {@link launchApp} records the frontmost application at launch and
 * {@link finish} FAILS the probe if it ever changed. That is the difference
 * between believing the suite is unobtrusive and knowing it: if anything in the
 * app learns to steal focus again, a probe goes red instead of a window
 * appearing over someone's work.
 *
 * ## A home of its own
 *
 * Every probe gets a THROWAWAY `$HOME`, and this is not tidiness — it is the
 * same class of guarantee as the focus one. The app keeps almost everything a
 * person owns under their home: `~/.pi/desktop/settings.json`,
 * `~/.pi/agent/sessions/**` (their actual conversations), `~/Bobble/generated`,
 * and `~/.cache/bobble` (gigabytes of weights). `--user-data-dir` isolates
 * none of that; it only covers Electron's own profile.
 *
 * What that cost, before this existed:
 *
 *  - A probe pressed an arrow key on the effort slider and left the REAL app
 *    pinned to `level` — the setting persists to the real settings.json.
 *  - Every run booted whatever model the user had selected, ~7GB, and left the
 *    llama-server orphaned when Playwright's close raced the app's teardown.
 *  - A run's generated media landed in the user's own `~/Bobble/generated`.
 *
 * A probe that genuinely needs the downloaded weights asks for them by name —
 * `launchApp(name, { realCache: true })` — which points `PI_DESKTOP_CACHE_DIR`
 * at the real cache and leaves the rest of the home throwaway. A probe that
 * needs to WRITE somewhere the app will read back uses the `home` it is handed
 * rather than `os.homedir()`, which is now a different place entirely.
 *
 * ## Watching a run
 *
 * `PI_E2E_VISIBLE=1 node tests/e2e/<probe>.mjs` shows the window (still
 * unfocused). The focus assertion still applies.
 *
 * ## Many worktrees, one machine
 *
 * The push runs a dozen worktrees at once (deliverables/research/PLAN.md §4).
 * Two things here exist for that:
 *
 *  - {@link launchApp} takes a PROBE slot (_locks.mjs: three at once, one while
 *    a heavy job runs) for as long as the app is up, unless a wrapper above it
 *    already holds one (`with-lock.mjs probe --` hands down BOBBLE_LOCK_HELD).
 *    `PD_PROBE_LOCK=0` opts out.
 *  - The default screenshot directory and every STABLE probe home carry the
 *    worktree's tag (`PD_WORKTREE_TAG`, or the `.claude/worktrees/<name>` the
 *    checkout lives in), so the same probe run from two worktrees neither
 *    overwrites the other's screenshots nor shares a home. The main checkout
 *    has no tag, and its paths are exactly what they always were.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { acquire as acquireLock, heldByAncestor } from './_locks.mjs';

export {
  acquire as acquireLock,
  classHeld,
  findOrphanServers,
  heavyBlockers,
  LOCK_CAPS,
  lockStatus,
  sweepOrphanServers,
  withLock,
} from './_locks.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '../..');
export const REPO_ROOT = path.resolve(APP_ROOT, '../..');

/**
 * Which worktree this checkout is, for paths two worktrees must not share.
 *
 * `PD_WORKTREE_TAG` wins; otherwise the `<name>` of a `.claude/worktrees/<name>`
 * checkout; otherwise '' (the main checkout, whose paths stay as they were).
 * Reduced to characters that are safe in a file name.
 */
export function worktreeTag(env = process.env, repoRoot = REPO_ROOT) {
  const raw =
    env.PD_WORKTREE_TAG ?? /[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)/.exec(repoRoot)?.[1] ?? '';
  return raw.replace(/[^A-Za-z0-9._-]/g, '-');
}

export const WORKTREE_TAG = worktreeTag();

/**
 * `base` with the worktree tag, `@`-separated. The `@` matters: a throwaway
 * home is recognised by its mkdtemp shape (`pd-home-<name>-XXXXXX`), and a tag
 * joined with `-` could end in six letters and have a STABLE home deleted as
 * if it were a throwaway one. Nothing mkdtemp makes contains an `@`.
 */
export function tagged(base, tag = WORKTREE_TAG) {
  return tag === '' ? base : `${base}@${tag}`;
}

/** Is `home` a throwaway home this harness may delete (see launchApp)? */
export function isThrowawayHome(home, tmp = tmpdir()) {
  const base = path.basename(home);
  return (
    /-[A-Za-z0-9]{6}$/.test(home) &&
    home.startsWith(path.join(tmp, 'pd-home-')) &&
    !base.includes('@')
  );
}

/*
 * ONE PROBE SLOT PER PROCESS. A probe that launches two apps at once (two
 * instances talking to each other) is still one probe; counting it twice would
 * let it deadlock against itself while a heavy job holds the cap at one.
 */
let probeSlot = null;
let probeSlotUsers = 0;

async function holdProbeSlot(name) {
  if (process.env.PD_PROBE_LOCK === '0' || heldByAncestor('probe') || heldByAncestor('heavy')) {
    return () => {};
  }
  probeSlotUsers += 1;
  probeSlot ??= acquireLock('probe', { command: `probe ${name}`, cwd: APP_ROOT });
  let lease;
  try {
    lease = await probeSlot;
  } catch (e) {
    probeSlotUsers -= 1;
    probeSlot = null;
    throw e;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    probeSlotUsers -= 1;
    if (probeSlotUsers === 0) {
      lease.release();
      probeSlot = null;
    }
  };
}

export const MOCK_PI = path.join(REPO_ROOT, 'packages/engine/tools/mock-pi/mock-pi.mjs');
export const TOOL_USE_FIXTURE = path.join(
  REPO_ROOT,
  'packages/engine/tools/mock-pi/fixtures/tool-use.json',
);

/**
 * The real model cache — downloaded weights, gigabytes of them, shared by every
 * run because nothing else could be.
 *
 * `PI_DESKTOP_CACHE_DIR` is the documented seam that separates it from the rest
 * of a home (see @pi-desktop/inference paths.ts), which is what lets a probe
 * have a throwaway profile AND real weights: `launchApp(name, { realCache: true })`.
 */
export const REAL_CACHE = (() => {
  // The support root was renamed on 2026-09-13; a machine the app has not
  // relaunched since still has the old name (and nothing at the new one —
  // pointing a probe at an empty root makes it install engines into it).
  const next = path.join(homedir(), '.cache', 'bobble');
  const old = path.join(homedir(), '.cache', 'pi-desktop');
  return existsSync(next) ? next : existsSync(old) ? old : next;
})();
/**
 * The real MODEL LIBRARY — where the weights live now (`~/Bobble/Models`,
 * storage/library-migration.ts). A probe with a throwaway HOME would otherwise
 * look for its models under that HOME's empty `Bobble/Models`; pointing
 * `PI_DESKTOP_MODELS_DIR` here is the same seam as `PI_DESKTOP_CACHE_DIR`.
 * The migration itself never runs under PI_E2E (storage-main), so a probe
 * cannot move anything.
 */
export const REAL_LIBRARY =
  process.env.PI_DESKTOP_MODELS_DIR ?? path.join(homedir(), 'Bobble', 'Models');

/**
 * A throwaway `$HOME` for a probe, seeded the way a real one always is.
 *
 * {@link launchApp} calls this itself, so most probes never need it. It is
 * exported for the ones that must know the path BEFORE the app starts —
 * anything writing a fixture the app will read back through `pd-file://`, which
 * is fenced to the app's own generated-media root and therefore moves with the
 * home. Pass the result straight through as `env.HOME`.
 *
 * `stable: true` returns the SAME directory every run for that name. Reserved
 * for a probe whose fixture is expensive enough to be worth keeping — a real
 * generation, say — where a fresh home each time would mean paying for it again
 * on every run. It is still not the user's home, which is the whole point.
 */
export function probeHome(name, { stable = false, router = 'off' } = {}) {
  const home = stable
    ? path.join(tmpdir(), tagged(`pd-home-${name}`))
    : mkdtempSync(path.join(tmpdir(), `pd-home-${name}-`));
  mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
  if (router === 'off') {
    mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
    writeFileSync(
      path.join(home, '.pi', 'desktop', 'settings.json'),
      `${JSON.stringify({ modelSelection: { mode: 'tier', tier: 'balanced' } }, null, 2)}\n`,
    );
  }
  return home;
}

/**
 * The app the OS considers frontmost.
 *
 * macOS-only and best-effort: on another platform, or with the automation
 * permission withheld, it returns null and the focus assertion becomes a no-op
 * rather than a false failure.
 */
export function frontmostApp() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to name of first process whose frontmost is true'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Did the suite take the screen?
 *
 * "The frontmost app changed", not "it is not Electron": the user may switch
 * apps mid-run and that is theirs to do — what must never happen is the SUITE
 * moving it. Either reading being null (not macOS, or automation permission
 * withheld) means we cannot tell, and a check that cannot tell must not fail.
 *
 * Pure, so the rule is testable without moving anyone's focus.
 */
/**
 * The apps a probe could steal focus TO. A probe's window is an Electron one in
 * development and the packaged app when a probe runs against the bundle.
 */
const OUR_APPS = new Set(['Electron', 'Bobble']);

export function focusComplaint(before, during) {
  if (before === null || during === null) return null;
  if (before === during) return null;
  /*
   * ONLY OUR OWN WINDOW COUNTS.
   *
   * The guarantee is "the probe did not take the screen", and it was checked as
   * "the frontmost app is the same one" — which also fails when the PERSON at
   * the keyboard switches apps mid-run. Seen live: `was "Safari", became "Mail"`
   * on a green probe, because the user read his mail while it ran. A guard that
   * cries wolf on someone using their own computer stops being read, which
   * costs exactly the thing it was built to protect.
   */
  if (!OUR_APPS.has(during)) return null;
  return `focus moved during the run: was "${before}", became "${during}" — a probe must not take the screen`;
}

/**
 * Launch the desktop app for a probe.
 *
 * Returns `{ app, page, shot, check, finish, home, shotDir }`. `name` is used
 * for the screenshot directory and the failure prefix, so pass the probe's own
 * name. `home` is the throwaway `$HOME` the app is running in — write anything
 * the app must read back (a fixture image, a session file) under THAT, never
 * under `os.homedir()`.
 *
 * Options:
 *   `realCache`  point `PI_DESKTOP_CACHE_DIR` at the real weights (see REAL_CACHE)
 *   `env.HOME`   supply your own home instead of a throwaway one
 */
/**
 * Open the WORK half of the app — the ledge under the composer that carries the
 * project chip, the instruction files, the context ring and the effort dial.
 *
 * The app ships in CHAT mode, where that ledge is collapsed and `inert`, so a
 * probe that drives one of those controls has to ask for it first. This is one
 * line rather than eight copies of the same click, and it waits for the slide
 * to finish — the ledge animates over 260ms and a click landing mid-transition
 * is the "element intercepts pointer events" failure that found this.
 */
export async function openWorkMode(page) {
  // The Chat|Work toggle is gone (2026-09-21, the user: "just leave it on 'work'")
  // and the ledge is always open; this waits for it and nothing more, so the
  // probes that call it keep their shape.
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="composer-ledge"]')?.getAttribute('data-open') ===
      'true',
    undefined,
    { timeout: 5000 },
  );
  return true;
}

/**
 * REFUSE — AND RECORD — invoke calls on these channels, in MAIN.
 *
 * The obvious spy, wrapping `window.piDesktop.invoke` from the page, cannot
 * work: contextBridge hands the page a FROZEN copy of the bridge, and
 * `window.piDesktop` itself is non-writable and non-configurable. MEASURED
 * 2026-09-25: the assignment is silently dropped, replacing the object is
 * dropped, and redefining the property throws. Such a spy records nothing while
 * every real call goes through — which is how a probe once "saw no
 * hf:register" within 4 s of a Download click while the picker sat on
 * "Downloading…": the registration had gone through in 3 ms, and the click was
 * awaiting the real 50 GB transfer behind it.
 *
 * So the spy sits where every invoke lands. Each channel's `ipcMain` handler is
 * replaced by one that records the request and throws: the renderer sees an
 * ordinary rejected invoke, and nothing behind the channel runs. Calling this
 * again re-installs it (idempotent), which is how a probe re-asserts it right
 * before the clicks that matter. The app is thrown away at `finish()`, so there
 * is nothing to restore.
 *
 * Returns `calls()`: every refused request so far, in order, `{ channel,
 * request, at }`.
 */
export async function refuseIpc(app, channels) {
  await app.evaluate(({ ipcMain }, list) => {
    const g = /** @type {any} */ (globalThis);
    g.__pdRefusedIpc ??= [];
    for (const channel of list) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, request) => {
        g.__pdRefusedIpc.push({ channel, request, at: Date.now() });
        throw new Error(`refused by the probe: ${channel}`);
      });
    }
  }, channels);
  return {
    calls: () => app.evaluate(() => /** @type {any} */ (globalThis).__pdRefusedIpc ?? []),
  };
}

export async function launchApp(name, options = {}) {
  const {
    fixture = TOOL_USE_FIXTURE,
    env = {},
    args = [],
    waitFor = '.pd-composer-editor',
    timeout = 30_000,
    realCache = false,
    /*
     * Playwright's Electron launch EMULATES prefers-color-scheme — 'light'
     * unless told otherwise — so no page in a probe ever sees dark, whatever
     * the app's native theme is. `null` turns the emulation off, for a probe
     * that checks how the app's own light/dark reaches embedded pages.
     */
    colorScheme,
  } = options;

  const shotDir = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', tagged(name));
  mkdirSync(shotDir, { recursive: true });

  /*
   * The throwaway home. Seeded with the sessions directory because the app
   * expects to find one and every hand-rolled probe was already creating it by
   * hand — the one piece of structure a real home always has.
   *
   * A caller's own `env.HOME` still wins (it is spread last below); this reads
   * it here only so the value handed back is the one the app actually got.
   */
  const home = env.HOME ?? probeHome(name);
  /*
   * Ours to remove at the end: any mkdtemp-shaped `pd-home-<name>-XXXXXX`
   * under the temp dir, whoever made it — a probe that builds its own home
   * with `probeHome()` and hands it over as `env.HOME` (deep-tasks,
   * chat-order, dialogs-look) is not asking to keep it. MEASURED 2026-09-20:
   * ten of those left behind by one session, 2.2 GB in one of them (uv's
   * cache). A stable one (probeHome's `stable`) is a per-name path a mkdtemp
   * name never has, and a home elsewhere is the caller's.
   */
  const throwaway = isThrowawayHome(home);
  mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });

  // A probe slot for as long as this app is up (see holdProbeSlot).
  const releaseSlot = await holdProbeSlot(name);

  const before = frontmostApp();
  // The user-data-dir is ours too (Chromium's caches, a few MB a run): 968 of
  // them were sitting in $TMPDIR on 2026-09-18 because only the home was removed.
  const userDataDir = mkdtempSync(path.join(tmpdir(), `pd-${name}-`));
  let app;
  let page;
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [APP_ROOT, `--user-data-dir=${userDataDir}`, ...args],
      ...(colorScheme === undefined ? {} : { colorScheme }),
      env: {
        ...process.env,
        // Before PI_BIN and friends so an explicit `env.HOME` still wins, and
        // before the cache so `realCache` is not undone by it.
        HOME: home,
        ...(realCache
          ? { PI_DESKTOP_CACHE_DIR: REAL_CACHE, PI_DESKTOP_MODELS_DIR: REAL_LIBRARY }
          : {}),
        PI_BIN: MOCK_PI,
        MOCK_PI_FIXTURE: fixture,
        PI_E2E: '1',
        // The whole point. A probe never opts out of this; `PI_E2E_VISIBLE=1` in
        // the caller's environment is the one way to watch a run, and it flows
        // through `...process.env` above.
        PI_E2E_BACKGROUND: '1',
        ...env,
      },
    });

    page = await app.firstWindow();
    if (waitFor !== null) await page.waitForSelector(waitFor, { timeout });
  } catch (e) {
    await app?.close().catch(() => undefined);
    releaseSlot();
    throw e;
  }

  const failures = [];
  const check = (condition, message) => {
    if (condition) return true;
    failures.push(message);
    console.error(`${name} FAILED: ${message}`);
    process.exitCode = 1;
    return false;
  };

  /**
   * A real screenshot of the hidden window.
   *
   * Playwright's own capture works here (verified), so this only adds the
   * per-probe directory and a size check — a blank frame is the failure mode
   * that would otherwise pass silently and produce a suite of black images.
   */
  const shot = async (label) => {
    const file = path.join(shotDir, `${label}.png`);
    const buf = await page.screenshot();
    writeFileSync(file, buf);
    check(buf.length > 5000, `screenshot "${label}" came back blank (${buf.length} bytes)`);
    return file;
  };

  /** Close the app and assert nothing took the screen (see focusComplaint). */
  const finish = async () => {
    const during = frontmostApp();
    await app.close().catch(() => undefined);
    releaseSlot();
    const complaint = focusComplaint(before, during);
    if (complaint !== null) check(false, complaint);
    /*
     * THE THROWAWAY HOME IS THROWN AWAY. Each one holds whatever the run
     * installed — a uv Python, a module's wheels, generated media — and none of
     * it was ever removed: MEASURED 277 of them, 55 GB, on the day the disk ran
     * out under a download. `PI_E2E_KEEP_HOME=1` keeps it for a post-mortem.
     */
    if (throwaway && process.env.PI_E2E_KEEP_HOME !== '1') {
      rmSync(home, { recursive: true, force: true });
    }
    if (process.env.PI_E2E_KEEP_HOME !== '1') {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    if (process.exitCode === 1) {
      console.error(`${name}: ${failures.length} failure(s)`);
      return false;
    }
    console.log(`${name} OK`);
    return true;
  };

  return { app, page, shot, check, finish, home, shotDir };
}
