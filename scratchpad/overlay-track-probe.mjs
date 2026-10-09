/**
 * DOES THE PHANTOM RIDE THE WINDOW?
 *
 * The user: "if I move the map around the cursor does not move with it." The shift
 * mechanism exists on both sides — the controller pushes a delta, the panel
 * translates by it — so this asks the running app which half is not happening.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9413;

await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
while (
  await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).then(
    (r) => r.stdout.trim() !== '',
    () => false,
  )
)
  await sleep(500);
await run('open', [
  '-g',
  '--env',
  'PI_E2E=1',
  '-a',
  '/Applications/Bobble.app',
  '--args',
  `--remote-debugging-port=${PORT}`,
]);
await sleep(8000);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
  timeout: 40_000,
});
const dbg = async (op, params) => {
  const r = await page.evaluate((x) => window.piDesktop.invoke('mac:debug', x), { op, params });
  if (r?.ok === false) throw new Error(`${op}: ${r.error}`);
  return r?.result ?? r;
};

await run('osascript', ['-e', 'tell application "Maps" to quit']).catch(() => {});
await sleep(2000);
const launched = await dbg('launch', { app: 'Maps' });
const pid = launched.pid;
console.log('maps pid', pid, 'at', JSON.stringify({ x: launched.x, y: launched.y }));

// Put the overlay on it, exactly as a real run does.
await dbg('monitor-session', { pid, app: 'Maps' });
await sleep(1500);
const before = await dbg('overlay-native-info', {});
console.log('phantom BEFORE :', JSON.stringify(before?.cursor ?? before));

// Move the window 220pt left, the way a person dragging it would.
await dbg('bounds', { pid });
const b0 = await dbg('bounds', { pid });
const target = { x: (b0?.x ?? 0) + 260, y: (b0?.y ?? 73) + 40 };
// Through the app, which HAS the Accessibility grant; a probe's own shell does not.
const mv = await dbg('move-window', { pid, x: target.x, y: target.y }).catch((e) => String(e));
console.log('move          :', JSON.stringify(mv)?.slice(0, 90), '→', JSON.stringify(target));
await sleep(2500);
const after = await dbg('overlay-native-info', {});
console.log('phantom AFTER  :', JSON.stringify(after?.cursor ?? after));
const b = await dbg('bounds', { pid });
console.log('window AFTER   :', JSON.stringify({ x: b?.x, y: b?.y }));

// ── the always-on-top question ───────────────────────────────────────────────
// Is anything reported as covering the controlled window, and does the panel
// know about it? The phantom must refuse to paint where a window ABOVE the app
// is — that is the whole point of the occluder mask.
const info = await dbg('overlay-native-info', {});
console.log('panel info    :', JSON.stringify(info, null, 0));
const b2 = await dbg('bounds', { pid });
console.log(
  'bounds sample :',
  JSON.stringify({
    occluded: b2?.occluded,
    covered: b2?.covered,
    occluders: (b2?.occluders ?? []).length,
    frontmost: b2?.frontmost,
    onScreen: b2?.onScreen,
  }),
);

await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
