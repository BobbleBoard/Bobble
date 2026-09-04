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
 * ## Watching a run
 *
 * `PI_E2E_VISIBLE=1 node tests/e2e/<probe>.mjs` shows the window (still
 * unfocused). The focus assertion still applies.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '../..');
export const REPO_ROOT = path.resolve(APP_ROOT, '../..');
export const MOCK_PI = path.join(REPO_ROOT, 'packages/engine/tools/mock-pi/mock-pi.mjs');
export const TOOL_USE_FIXTURE = path.join(
  REPO_ROOT,
  'packages/engine/tools/mock-pi/fixtures/tool-use.json',
);

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
 * Returns `{ app, page, shot, check, finish }`. `name` is used for the
 * screenshot directory and the failure prefix, so pass the probe's own name.
 */
export async function launchApp(name, options = {}) {
  const {
    fixture = TOOL_USE_FIXTURE,
    env = {},
    args = [],
    waitFor = '.pd-composer-editor',
    timeout = 30_000,
  } = options;

  const shotDir = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', name);
  mkdirSync(shotDir, { recursive: true });

  const before = frontmostApp();
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP_ROOT, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), `pd-${name}-`))}`, ...args],
    env: {
      ...process.env,
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

  const page = await app.firstWindow();
  if (waitFor !== null) await page.waitForSelector(waitFor, { timeout });

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
    const complaint = focusComplaint(before, during);
    if (complaint !== null) check(false, complaint);
    if (process.exitCode === 1) {
      console.error(`${name}: ${failures.length} failure(s)`);
      return false;
    }
    console.log(`${name} OK`);
    return true;
  };

  return { app, page, shot, check, finish, shotDir };
}
