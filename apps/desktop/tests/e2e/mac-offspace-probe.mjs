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
  if (onSpace.behavior?.offSpace === true)
    fail('phantom hid itself while the window was right here');
  if (onSpace.alpha !== undefined && onSpace.alpha === 0) fail('phantom already invisible');
  console.log(`tracking ${APP} window ${onSpace.trackedWindow}, phantom shown`);

  // Vanish the window from the current Space's window list — the same thing
  // the overlay sees when the user switches desktops.
  await osa(`tell application "System Events" to set visible of process "${APP}" to false`);
  let away = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    away = await native();
    if (away.behavior?.offSpace === true) break;
  }
  if (away?.behavior?.offSpace !== true) {
    fail('the phantom kept drawing after its window left this desktop — it would follow the user');
  }
  console.log('off-desktop OK: the phantom hid itself rather than following');

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
  console.log('mac-offspace-probe OK');
} finally {
  await osa(`tell application "System Events" to set visible of process "${APP}" to true`);
  await osa(`tell application "${APP}" to quit`);
  await app.close().catch(() => {});
}
