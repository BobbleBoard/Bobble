/**
 * Round-9 adversarial E2E — PI KILLED MID-STREAM (failure point #11).
 *
 * With a turn streaming, the pi child process is killed. The app must degrade
 * gracefully — surface the "Pi stopped" restart affordance (ToastHost, driven by
 * the store's `bridgeExited`) and keep the UI mounted — NOT hang on a white
 * screen. Run `pnpm build` first.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('round9-pi-crash-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
/* THE SLOW FIXTURE, because the whole probe is about an exit that INTERRUPTS
   something. simple-chat's turn is over in a few hundred milliseconds, so the
   kill kept landing on an idle bridge — and an idle exit deliberately raises no
   notice (pi-slice.ts). `stress` streams long, slow turns, which is the window
   this needs. */
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/stress.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round9-pi-crash-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // Start a turn streaming, then kill pi mid-flight.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('hello there');
  await page.keyboard.press('Enter');
  /*
   * KILL IT WHILE A TURN IS ACTUALLY IN FLIGHT, which is the case under test and
   * which this used to reach by luck. It slept 150ms and hoped; the day the send
   * path got faster the kill started landing AFTER the turn had finished, and an
   * exit that interrupted nothing raises no notice — deliberately, and the user's
   * words are in pi-slice.ts: an exit nobody was waiting on "just shouldn't show
   * up as a notification at all". So the probe was reporting a missing crash
   * affordance for a crash it had not managed to cause.
   */
  await page.waitForFunction(() => window.__pi_store().getState().agent?.isStreaming === true, {
    timeout: 15_000,
  });

  // Kill the mock-pi child (the app spawned it as PI_BIN). SIGKILL so it cannot
  // shut down cleanly — the harshest "process vanished" case.
  try {
    execSync('pkill -9 -f mock-pi.mjs');
  } catch {
    // pkill exits non-zero if nothing matched; the process may have already gone.
  }

  // The app surfaces the bridge-exit restart affordance and stays mounted.
  await page.waitForFunction(
    () => window.__pi_store().getState().bridgeExited !== null,
    undefined,
    { timeout: 12000 },
  );
  /*
   * WHAT THE TOAST HAS TO SAY, rather than the exact words it says it in.
   *
   * This waited on the literal string "Pi stopped" and went red the day the copy
   * did what it was always going to do: the app is Bobble to a user and "pi" is
   * an internal name, so the toast reads "The assistant stopped" now. A probe
   * that pins a sentence goes red for a rewording and green for a regression
   * that keeps the sentence — the wrong way round on both counts.
   *
   * The rules in toast-policy.ts are what this is really about: ONE toast, no
   * raw signal code in front of the user (the router emits "pi exited (143)."
   * alongside the bridge exit), and a Restart button that is the only thing
   * claiming to have restarted anything.
   */
  const toast = page.locator('.pd-toast').first();
  await toast.waitFor({ state: 'visible', timeout: 6000 });
  await page.waitForSelector('button:has-text("Restart")', { timeout: 6000 });
  // The accessible-name prefix Radix adds ("Notification") is chrome, not copy.
  const said = ((await toast.textContent()) ?? '').replace(/^Notification/, '');
  assert(
    !/\bpi\b/i.test(said),
    `the crash toast still names the internal engine to the user: ${JSON.stringify(said)}`,
  );
  assert(
    !/\(\d+\)|\bSIG[A-Z]+\b|\b143\b/.test(said),
    `the crash toast leaked a raw exit/signal code: ${JSON.stringify(said)}`,
  );
  assert(
    (await page.locator('.pd-toast').count()) === 1,
    `the raw "pi exited (…)" line stacked a second toast beside the humanized one: ${JSON.stringify(
      await page.locator('.pd-toast').allTextContents(),
    )}`,
  );
  assert(
    (await page.locator('[data-testid="composer-input"]').count()) === 1,
    'the composer disappeared after pi died (white-screen / hang)',
  );

  console.log(
    `round9-pi-crash-probe OK — killing pi mid-stream surfaced ONE humanized restart toast (${JSON.stringify(said)}), no raw signal code, no internal engine name, and left the UI mounted (no white-screen/hang)`,
  );
} finally {
  await app.close();
}
