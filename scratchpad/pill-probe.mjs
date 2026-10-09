/** Bring the pill up, hover its controls, and photograph them. */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = `${REPO_ROOT}/scratchpad/pill-shot`;
const PORT = 9418;
mkdirSync(OUT, { recursive: true });
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
await sleep(9000);
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
// A real session, so the pill has a real status on it.
await run('osascript', ['-e', 'tell application "Maps" to quit']).catch(() => {});
await sleep(2000);
const launched = await dbg('launch', { app: 'Maps' });
await dbg('monitor-session', { pid: launched.pid, app: 'Maps' });
await sleep(2500);
const info = await dbg('overlay-native-info', {});
console.log('pill frame  :', JSON.stringify(info.bubble?.frame));
console.log('pill text   :', JSON.stringify(info.bubble?.text));
console.log('controls    :', JSON.stringify(info.controls ?? 'not reported'));
console.log(
  'panel vis   :',
  info.visible,
  'bubble vis:',
  info.bubble?.visible,
  'cursorVis:',
  info.cursorVisible,
);
let b = info.bubble?.frame ?? { x: 400, y: 300, w: 120, h: 30 };
// Force the panel visible for the photograph — the E2E seam does exactly that.
await dbg('overlay-show', { x: 300, y: 240, w: 900, h: 600 });
await sleep(800);
const info2 = await dbg('overlay-native-info', {});
console.log(
  'after show  :',
  info2.visible,
  JSON.stringify(info2.bubble?.frame),
  JSON.stringify(info2.bubble?.text),
);
// Clear the occluder mask: Maps/Bobble were covering the phantom, which is the
// mask doing its job and makes the photograph blank.
await dbg('overlay-occluders', { rects: [] });
await sleep(300);
await dbg('overlay-backdrop', { color: '#1b1c22' });
await sleep(300);
b = info2.bubble?.frame ?? b;
// Whole screen first: the crop space was ambiguous, so find the pill by eye.
await dbg('overlay-render', {
  path: `${OUT}/pill.png`,
  x: Math.round(b.x - 40),
  y: Math.round(b.y - 30),
  w: Math.round(b.w + 80),
  h: Math.round(b.h + 60),
  scale: 6,
});
await dbg('overlay-backdrop', {});
console.log('rendered');
await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
