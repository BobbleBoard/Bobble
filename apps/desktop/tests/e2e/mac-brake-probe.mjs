/**
 * THE USER'S HALF of Mac computer use: the brake, the permission story, and the
 * states that tell slow from stuck.
 *
 * Everything here runs against the REAL app — the real overlay window, the real
 * monitor core, the real IPC — with no TCC grant and no app being driven, so it
 * works on a fresh Mac and in CI:
 *
 *   - the overlay's bubble is HIT-TESTABLE (main really does drop
 *     click-through while the pointer is on it, and really does take it back),
 *     and its ✕ stops the run;
 *   - stopping cuts the agent off: the next act is refused with a sentence that
 *     tells it what to do instead, while the surface can still say WHICH app
 *     was stopped;
 *   - taking over stops LOOKING, not just acting — no capture child, no
 *     Accessibility poll;
 *   - the Screen Recording explainer names the binary the user will actually
 *     find in the list ("Bobble") and says the app must be relaunched;
 *   - the bubble carries the app's own accent (one phantom, one palette, no
 *     purple), says "Reading the screen" while the agent reads it, and starts
 *     counting once a think has gone on long enough to be worth doubting.
 *
 * Run `npm run build` first. Shots default to $TMPDIR/mac-brake-shots
 * (override with MAC_BRAKE_OUT).
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const OUT_DIR = process.env.MAC_BRAKE_OUT ?? path.join(tmpdir(), 'mac-brake-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

if (process.platform !== 'darwin') {
  console.log('mac-brake-probe: SKIP — macOS only');
  process.exit(0);
}
if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('mac-brake-probe: app not built — run `npm run build` first');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

/**
 * TWO LAUNCHES, and the split is not incidental.
 *
 * The dev frame source (PI_MAC_MONITOR_MOCK) drives the real overlay on a
 * 14-second choreography of its own — exactly what you want when looking at
 * the monitor's states, and exactly what you must not have when timing the
 * bubble's: a probe that waits 20s for "Still thinking" while something else
 * pushes "Clicking" every few seconds is testing the mock.
 */
function launch(mock, extraEnv = {}) {
  return electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-brake-udd-'))}`],
    env: {
      ...process.env,
      HOME: probeHome('mac-brake-probe'),
      PI_E2E: '1',
      PI_BIN: mockPi,
      ...(mock ? { PI_MAC_MONITOR_MOCK: '1' } : {}),
      ...extraEnv,
    },
  });
}

async function connect(app) {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30_000,
  });
  const dbg = (op, params) =>
    page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
  const overlayPage = async () => {
    for (let i = 0; i < 60; i++) {
      const w = app.windows().find((win) => win.url().includes('overlay.html'));
      if (w !== undefined) return w;
      await sleep(200);
    }
    return null;
  };
  return { page, dbg, overlayPage };
}

// ══ 1. the monitor: what it says, and what a brake does to it ═══════════════
{
  const app = await launch(true);
  try {
    const { page, dbg } = await connect(app);
    const monitor = async () => (await dbg('monitor-info')).result;
    // Watch with FRAMES, as the surface does — both capture gates need it.
    await page.evaluate(() => window.piDesktop.invoke('mac:monitor:subscribe', { frames: true }));

    let state = await monitor();
    for (let i = 0; i < 40 && state?.stream !== 'live'; i++) {
      await sleep(250);
      state = await monitor();
    }
    check(state?.active === true, 'a session is being monitored', JSON.stringify(state?.appName));
    check(state?.stream === 'live', 'and the picture is arriving', state?.stream);
    // F6's clock: the published age is REAL and moves, which is what lets a
    // frozen stream be told from a slow one without another channel.
    check(
      typeof state?.lastPictureAgeMs === 'number' && state.lastPictureAgeMs < 4_000,
      'the age of the last picture is published and fresh',
      String(state?.lastPictureAgeMs),
    );

    // ── F2/F8: the Screen Recording explainer ───────────────────────────────
    await dbg('monitor-mock', { deny: true, restart: true });
    let denied = await monitor();
    for (let i = 0; i < 40 && denied?.captureDenied !== true; i++) {
      await sleep(250);
      denied = await monitor();
    }
    check(denied?.captureDenied === true, 'a refused capture reaches a state the user can act on');
    check(
      denied?.captureNotice?.title?.includes('Bobble') === true,
      'the explainer names the binary the user will find in the list',
      denied?.captureNotice?.title,
    );
    check(
      denied?.captureNotice?.hint?.includes('quit and reopen') === true,
      'and says macOS needs the app relaunched',
      denied?.captureNotice?.hint,
    );
    check(
      typeof denied?.streamMessage !== 'string' || !denied.streamMessage.includes('pi-mac'),
      'no process message is offered to a person',
      String(denied?.streamMessage),
    );
    check(denied?.captureAppName === 'Bobble', 'the app names itself as the user sees it');
    // The drawing keeps going — the point of the panel is that it is not the
    // only thing the user gets.
    check(denied?.polling === true, 'and the Accessibility drawing takes over meanwhile');

    // ── C2 / S6: the brake, and the wheel ───────────────────────────────────
    await dbg('mac-control', { mode: 'stopped' });
    const stopped = await monitor();
    check(stopped?.control === 'stopped', 'the brake is on');
    check(stopped?.capturing === false, 'stopping stops the capture');
    check(stopped?.polling === false, 'stopping stops the Accessibility poll too');
    check(stopped?.active === true, 'the surface can still say WHICH app was stopped');
    check(stopped?.captureNotice === null, 'and it is not asked for permissions it cannot use');
    const refused = await dbg('snapshot', { pid: 909090 });
    check(refused?.ok === false, 'the agent cannot act while stopped');
    check(
      typeof refused?.error === 'string' && refused.error.includes('ask whether'),
      'and the refusal tells it what to do instead',
      refused?.error,
    );
    // `visible` is the controller's own bookkeeping (info() has no `engaged`).
    check((await dbg('overlay-info')).result?.visible === false, 'the phantom is off the screen');

    await dbg('mac-control', { mode: 'agent' });
    check((await monitor())?.control === 'agent', 'control can be handed back');

    /*
     * …AND THE USER'S NEXT MESSAGE HANDS IT BACK TOO. The brake used to latch
     * past the run it stopped: a fresh chat's first `mac launch` still said
     * "The user pressed Stop" (MEASURED, two sessions), the model asked whether
     * to carry on, and the user's "carry on" changed nothing. A prompt from the
     * person is the answer; an app command (`/harness …`) is not.
     */
    await dbg('mac-control', { mode: 'stopped' });
    check((await monitor())?.control === 'stopped', 'stopped again');
    await page.evaluate(() =>
      window.piDesktop.invoke('pi:prompt', { message: '/harness workspace /tmp' }).catch(() => {}),
    );
    await sleep(300);
    check((await monitor())?.control === 'stopped', "an app command is not the user's hand-back");
    await page.evaluate(() =>
      window.piDesktop.invoke('pi:prompt', { message: 'carry on with notes' }).catch(() => {}),
    );
    await sleep(300);
    check((await monitor())?.control === 'agent', "the user's next message releases the brake");

    await dbg('mac-control', { mode: 'user' });
    const takeover = await dbg('screenshot', { pid: 909090 });
    check(takeover?.ok === false, 'take-over stops the agent LOOKING, not just acting');
    check(
      typeof takeover?.error === 'string' && takeover.error.includes('not watching'),
      'and says so in as many words',
      takeover?.error,
    );
    check((await monitor())?.capturing === false, 'nothing is captured while the user drives');
  } finally {
    await app.close().catch(() => {});
  }
}

/*
 * (The former section 2 drove an `overlay.html` BrowserWindow — the overlay
 * before it went native. That window no longer exists, so its checks — the
 * hit-testable bubble, the palette, the pill's copy — live in
 * mac-overlay-probe.mjs against the NSPanel, where they belong. What survives
 * from it is the one thing that would otherwise silently not exist.)
 */
{
  const app = await launch(false);
  try {
    await connect(app);
    /* C7's brake for the user who is NOT in Bobble. It is never armed in a
       test run — eating the Escape key of whoever is using this machine is
       exactly the kind of "taking notice" the headless rule forbids — so what
       is checked here is whether macOS will hand this app the accelerator at
       all. Held for microseconds. */
    const escRegistrable = await app.evaluate(({ globalShortcut }) => {
      const ok = globalShortcut.register('Escape', () => {});
      globalShortcut.unregister('Escape');
      return ok;
    });
    check(escRegistrable === true, 'macOS will give Bobble the global Escape brake');
  } finally {
    await app.close().catch(() => {});
  }
}

// ══ 3. which binary takes the picture, against the real Chromium ═══════════
/*
 * F2's headline, as far as a machine with no capture grant can prove it.
 *
 * The grant cannot be arranged in a test, so the app is TOLD it holds one; what
 * Chromium then does with the request is entirely real. On a machine that is
 * actually denied it refuses — and the thing being tested is that the monitor
 * then falls back to the helper and the picture keeps coming, rather than the
 * preferred path failing silently and leaving a blank stage.
 */
{
  const app = await launch(true, { PI_MAC_FORCE_CAPTURE_GRANT: 'granted' });
  try {
    const { page, dbg } = await connect(app);
    const monitor = async () => (await dbg('monitor-info')).result;
    await page.evaluate(() => window.piDesktop.invoke('mac:monitor:subscribe', { frames: true }));
    let sawElectron = false;
    let state = null;
    for (let i = 0; i < 60; i++) {
      state = await monitor();
      if (state?.captureSource === 'electron') sawElectron = true;
      if (sawElectron && state?.captureSource === 'helper') break;
      await sleep(200);
    }
    check(
      sawElectron,
      'the app captures for itself when it holds the grant',
      'captureSource=electron',
    );
    check(
      state?.captureSource === 'helper',
      'and falls back to the helper when Chromium will not share',
      `captureSource=${state?.captureSource}`,
    );
    for (let i = 0; i < 40 && state?.stream !== 'live'; i++) {
      await sleep(250);
      state = await monitor();
    }
    check(state?.stream === 'live', 'the picture survives the fallback', state?.stream);
  } finally {
    await app.close().catch(() => {});
  }
}

console.log(`\nshots in ${OUT_DIR}`);
if (failures > 0) {
  console.error(`\nmac-brake-probe: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nmac-brake-probe: all checks passed');
