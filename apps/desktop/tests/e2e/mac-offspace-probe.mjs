/**
 * THE PHANTOM MUST NOT FOLLOW THE USER TO ANOTHER DESKTOP.
 *
 * the user: "when I switch desktops I notice a new bug where the mouse cursor
 * follows instead of staying on the window in the other desktop and redoes the
 * on top of wrong window bug."
 *
 * The panel carries `.canJoinAllSpaces` and must — the controlled window can be
 * on any Space and the phantom has to reach it. So it exists on every Space,
 * and the question is only whether it DRAWS on one the tracked window is not on.
 *
 * Switching Spaces cannot be driven from a script, but it does not need to be:
 * what the overlay actually sees is the tracked window vanishing from
 * `CGWindowListCopyWindowInfo(.optionOnScreenOnly)`, which lists the current
 * Space only. Hiding the app removes it from that list the same way, so this
 * exercises the identical code path with a gesture a probe can make.
 *
 * Needs a REAL tracked window: the overlay probe's synthetic bounds source
 * leaves trackedWindow at 0, which is why this check could not live there.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const run = promisify(execFile);
const osa = (s) => run('osascript', ['-e', s]).catch(() => undefined);
const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBinary = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  throw new Error(`mac-offspace-probe failed: ${m}`);
};

if (process.platform !== 'darwin') {
  console.log('mac-offspace-probe: SKIP — macOS only');
  process.exit(0);
}
if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('mac-offspace-probe: app not built — run `npm run build` first');
  process.exit(1);
}

const APP = process.env.OFFSPACE_APP ?? 'Maps';
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: probeHome('offspace'), PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 20000,
  });
  const dbg = (op, params) =>
    page.evaluate((req) => window.piDesktop.invoke('mac:debug', req), { op, params });
  const native = async () => {
    const res = await dbg('overlay-native-info');
    if (res.ok !== true || res.result == null) fail(`overlay-native-info: ${res.error}`);
    return res.result;
  };

  // Take a real app in the background — this is what gives us a real
  // trackedWindow, which the synthetic bounds source in mac-overlay-probe never
  // does.
  const launched = await dbg('launch', { app: APP, background: true });
  if (launched.ok !== true) fail(`could not take ${APP}: ${launched.error}`);
  const pid = Number(launched.result?.pid ?? 0);
  if (!(pid > 0)) fail(`launch gave no pid: ${JSON.stringify(launched.result)}`);
  /* `launch` alone does not point the tracker at a window — `monitor-session`
     is what calls overlay.control(pid) and gives us a real trackedWindow. */
  const sess = await dbg('monitor-session', { pid, app: APP });
  if (sess.ok !== true) fail(`monitor-session: ${sess.error}`);
  await dbg('overlay-cursor', { x: 500, y: 400 });
  await sleep(1500);

  const onSpace = await native();
  if (!(onSpace.trackedWindow > 0)) {
    console.log('launch:', JSON.stringify(launched).slice(0, 300));
    console.log('session:', JSON.stringify(sess).slice(0, 300));
    console.log('grants:', JSON.stringify(await dbg('grants', {})).slice(0, 200));
    fail(`no real window tracked (${onSpace.trackedWindow})`);
  }
  /*
   * PRECONDITION, not a failure: if the tracked window is not on the Space this
   * probe runs on, there is nothing here to mask against and nothing below can
   * say anything true. A fullscreen app is the usual cause — macOS gives it its
   * own Space, so an app launched in the background lands elsewhere and the
   * phantom hides itself, which is exactly the off-desktop behaviour under test.
   * "Skipped, and why" beats a failure that reads like a regression.
   */
  if (onSpace.behavior?.offSpace === true) {
    console.log(
      'mac-offspace-probe: SKIP — the tracked window is not on this Space (a ' +
        'fullscreen app owns it). The phantom hid itself, which is correct, but ' +
        'masking cannot be measured from here.',
    );
    await osa(`tell application "${APP}" to quit`);
    await app.close().catch(() => {});
    process.exit(0);
  }
  if (onSpace.alpha !== undefined && onSpace.alpha === 0) fail('phantom already invisible');
  console.log(`tracking ${APP} window ${onSpace.trackedWindow}, phantom shown`);

  // Vanish the window from the current Space's window list — the same thing
  // the overlay sees when the user switches desktops.
  /*
   * HOW FAST it hides is the whole bug. The phantom used to wait two occlusion
   * ticks before hiding AND clear its mask on the first one, so for ~66ms it sat
   * unmasked on the desktop the user had just switched to — a flash nobody can
   * screenshot but everybody sees. Hiding is now immediate and only the RETURN
   * is debounced, so this measures the gap rather than just the end state.
   */
  const vanishedAt = Date.now();
  await osa(`tell application "System Events" to set visible of process "${APP}" to false`);
  let away = null;
  let hidAfter = null;
  for (let i = 0; i < 400; i++) {
    away = await native();
    if (away.behavior?.offSpace === true) {
      hidAfter = Date.now() - vanishedAt;
      break;
    }
    await sleep(20);
  }
  if (away?.behavior?.offSpace !== true) {
    fail('the phantom kept drawing after its window left this desktop — it would follow the user');
  }
  /* The DETECTOR has to have noticed too, not just the hiding. the user asked for
     this to be logged whenever it happens, and a log line nobody can prove
     fires is not logging. `unmasked` is the same string the panel writes to
     stderr, read back through info() so the assertion does not depend on where
     the process's stderr happens to be plumbed. */
  if ((away.behavior?.unmasked ?? '') === '') {
    fail('the phantom hid, but never reported WHY — the unmasked detector is silent');
  }
  console.log(`detector OK: reported "${away.behavior.unmasked}"`);
  console.log(`off-desktop OK: hid itself ${hidAfter}ms after the window went (not following)`);

  // …and comes back on its own when the window returns.
  await osa(`tell application "System Events" to set visible of process "${APP}" to true`);
  let back = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    back = await native();
    if (back.behavior?.offSpace === false) break;
  }
  if (back?.behavior?.offSpace !== false) fail('the phantom never came back with its window');
  console.log('return OK: the phantom came back with its window');

  /*
   * …AND A REAL WINDOW ABOVE THE TRACKED ONE MUST ERASE IT.
   *
   * the user, twice: "cursor on top is occurring again". Everything else here is a
   * proxy; this is the symptom. The probe's OWN Bobble window is a real window
   * sitting above Maps in the z-order, so parking the phantom inside it is the
   * cheapest honest reproduction there is — no second app to install, no
   * synthetic occluder rect standing in for the thing being tested.
   */
  const own = await page.evaluate(() => ({
    x: window.screenX,
    y: window.screenY,
    w: window.outerWidth,
    h: window.outerHeight,
  }));
  const tip = { x: Math.round(own.x + own.w / 2), y: Math.round(own.y + own.h / 2) };

  /*
   * PIXELS DECIDE — but count the PHANTOM, not "anything unlike the backdrop".
   *
   * The first version of this painted a flat ground and counted pixels that
   * differed from it. That cannot work here: the mask cuts the whole stage, and
   * the backdrop lives inside it, so in exactly the region under test the ground
   * is erased too and plain white read as 76,800 px of phantom. The panel was
   * masking correctly the entire time.
   *
   * The phantom is blue — a light glyph and a strong pill — and every ground it
   * can sit on here (white, #eceef2) is grey. So count SATURATED pixels: channel
   * spread is what separates the cursor from any backdrop, masked or not.
   *
   * With a positive control, because a measure that returns zero for the wrong
   * reason passes this test silently: the same count taken where the phantom is
   * NOT covered has to come back non-zero, or the measurement is broken rather
   * than the mask being good.
   */
  const saturated = async (name, at) => {
    const box = { x: at.x - 80, y: at.y - 60, w: 160, h: 120 };
    const shotPath = path.join(tmpdir(), name);
    const r = await dbg('overlay-render', { path: shotPath, ...box, scale: 2 });
    if (r.ok !== true) fail(`could not render ${name}`);
    return await app.evaluate(({ nativeImage }, p) => {
      const b = nativeImage.createFromPath(p).toBitmap();
      let n = 0;
      for (let i = 0; i < b.length; i += 4) {
        const mx = Math.max(b[i], b[i + 1], b[i + 2]);
        const mn = Math.min(b[i], b[i + 1], b[i + 2]);
        if (mx - mn > 25) n++;
      }
      return n;
    }, shotPath);
  };

  // Positive control: over the tracked window itself, the phantom must be there.
  /* The control point has to be over the TRACKED window and clear of the one
     above it — our own window covers most of the screen, so the first attempt
     put the control inside the very occluder it was meant to contrast with and
     read a correctly-masked phantom as a broken measurement. Just above our
     window's top edge is over Maps and over nothing else. */
  const homeTip = { x: Math.round(own.x + own.w / 2), y: Math.max(40, own.y - 40) };
  await dbg('overlay-cursor', { x: homeTip.x, y: homeTip.y, ms: 0 });
  await sleep(400);
  const visiblePx = await saturated('offspace-uncovered.png', homeTip);
  if (visiblePx === 0) {
    fail(
      'the phantom did not paint even where it SHOULD — the measurement is broken, not the mask',
    );
  }

  // The real check: inside a window that is above the tracked one, nothing.
  await dbg('overlay-cursor', { x: tip.x, y: tip.y, ms: 0 });
  await sleep(400);
  const covered = await native();
  if (covered.behavior?.offSpace === true) fail('phantom hid entirely instead of being masked');
  const why = covered.behavior?.unmasked ?? '';
  if (why !== '') fail(`the panel reports it cannot mask: ${why}`);
  const coveredPx = await saturated('offspace-covered.png', tip);
  if (coveredPx !== 0) {
    const st = await native();
    console.log(
      'state:',
      JSON.stringify({ maskHoles: st.maskHoles, unmasked: st.behavior?.unmasked }),
    );
    fail(
      `${coveredPx} px of phantom painted inside a window ABOVE its own — the "cursor on top" bug`,
    );
  }
  console.log(
    `covered OK: ${visiblePx} px where it belongs, 0 px inside our own window at ${tip.x},${tip.y}`,
  );
  console.log('mac-offspace-probe OK');
} finally {
  await osa(`tell application "System Events" to set visible of process "${APP}" to true`);
  await osa(`tell application "${APP}" to quit`);
  await app.close().catch(() => {});
}
