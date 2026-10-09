/** Render the phantom over a light and a dark backdrop, so the new cursor can
 *  be LOOKED AT rather than assumed. Uses the panel's own debug render. */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = `${REPO_ROOT}/scratchpad/cursor-shot`;
const PORT = 9414;
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
await dbg('overlay-show', { x: 300, y: 240, w: 700, h: 420 });
await sleep(400);
// Put the cursor somewhere known, then crop around where the panel says it is.
await dbg('overlay-retarget', { x: 300, y: 240, w: 700, h: 420 }).catch(() => {});
const info = await dbg('overlay-native-info', {});
const g = info.cursorGlyph ?? { x: 400, y: 320, w: 24, h: 24 };
console.log('glyph at', JSON.stringify(g), 'pill', JSON.stringify(info.bubble?.frame));
const pad = 26;
const crop = {
  x: Math.round(g.x - pad),
  y: Math.round(g.y - pad),
  w: Math.round(g.w + pad * 2),
  h: Math.round(g.h + pad * 2),
};
// Put a pill up so the controls have something to sit on.
await dbg('overlay-page', {}).catch(() => {});
for (const [name, color] of [
  ['light', '#ffffff'],
  ['dark', '#1b1c22'],
]) {
  await dbg('overlay-backdrop', { color });
  await sleep(400);
  await dbg('overlay-render', {
    path: `${OUT}/cursor-${name}.png`,
    ...crop,
    scale: 6,
  });
  console.log('rendered', name);
}
await dbg('overlay-backdrop', {});
await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
