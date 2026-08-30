/**
 * The test mode's own contract: run, see, and be unnoticeable.
 *
 * the user: "ideally headlessly … it doesn't take any focus away from me, I can use
 * the computer without any notice of any rapid test suites."
 *
 * Every other probe depends on this being true, so it is asserted once, here,
 * rather than assumed everywhere. If any of it regresses — a window learns to
 * show itself, a notification escapes, screenshots start coming back blank —
 * this goes red before a window appears over someone's work.
 */
import { launchApp } from './harness.mjs';

const { app, page, shot, check, finish } = await launchApp('headless-probe');

// --- invisible -------------------------------------------------------------
const windows = await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), onTop: w.isAlwaysOnTop() })),
);
const invisible =
  check(windows.length > 0, 'no window at all — the app did not start') &&
  check(
    windows.every((w) => !w.visible),
    `a window is visible: ${JSON.stringify(windows)}`,
  ) &&
  check(
    windows.every((w) => !w.onTop),
    'a window is always-on-top, which would float over the user',
  );
if (invisible) console.log(`[headless] OK: ${windows.length} window(s), none visible`);

// --- and out of the dock and the ⌘-Tab switcher ----------------------------
/* Asserted through the DOCK rather than `getActivationPolicy()`, which this
   Electron does not expose as a getter — and the dock is the thing a person
   would actually notice anyway. `accessory` is what puts it there or not. */
const dockVisible = await app.evaluate(({ app: a }) => a.dock?.isVisible?.() ?? null);
if (process.platform === 'darwin') {
  if (check(dockVisible !== true, `the app is in the dock (isVisible: ${dockVisible})`)) {
    console.log('[headless] OK: not in the dock or the ⌘-Tab switcher');
  }
}

// --- still fully alive -----------------------------------------------------
// A hidden window that does not render would make every visual probe useless,
// so this checks the three things that would silently rot: layout, animation
// frames, and a real screenshot.
const alive = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const rect = document.querySelector('.pd-composer-editor')?.getBoundingClientRect();
      let frames = 0;
      const t0 = performance.now();
      const step = () => {
        frames++;
        if (performance.now() - t0 < 500) requestAnimationFrame(step);
        else resolve({ width: Math.round(rect?.width ?? 0), frames });
      };
      requestAnimationFrame(step);
    }),
);
const rendering =
  check(alive.width > 100, `the composer has no layout (width ${alive.width})`) &&
  check(
    alive.frames > 10,
    `only ${alive.frames} animation frames in 500ms — rendering is throttled`,
  );
if (rendering) {
  console.log(`[headless] OK: laid out (${alive.width}px) and animating (${alive.frames} frames)`);
}

const file = await shot('hidden-window');
console.log(`[headless] OK: a real screenshot of a window nobody can see → ${file}`);

// --- notifications stay suppressed ----------------------------------------
// The most literal form of "taking notice": a banner over the user's screen.
const notified = await page.evaluate(() =>
  window.piDesktop.invoke('app:notify', {
    title: 'this must not appear',
    body: 'a suite must not post banners',
    sessionFile: '/tmp/x.jsonl',
    kind: 'finished',
  }),
);
const quiet =
  check(notified?.shown === false, `a notification was posted: ${JSON.stringify(notified)}`) &&
  check(
    String(notified?.reason ?? '').includes('background'),
    `suppressed for the wrong reason: ${JSON.stringify(notified)}`,
  );
if (quiet) console.log('[headless] OK: notifications are suppressed, and say why');

await finish();
