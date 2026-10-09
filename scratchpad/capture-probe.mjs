/**
 * Capture one app through the SHIPPED bundle, which is the only process with
 * the Screen Recording grant, and write the picture out for inspection.
 *
 * Exists because the monitor showed a Maps window with a solid white block over
 * its right quarter and the desktop wallpaper all around it, and neither is
 * diagnosable from a demo recording — this asks the capture path directly.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = process.env.APP ?? 'Maps';
const OUT = `${REPO_ROOT}/scratchpad/capture-probe`;
const PORT = 9412;

mkdirSync(OUT, { recursive: true });
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
while (
  await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).then(
    (r) => r.stdout.trim() !== '',
    () => false,
  )
) {
  await sleep(500);
}
// -g: never take the screen (the user's standing rule).
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
  const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
  if (res?.ok === false) throw new Error(`${op}: ${res.error}`);
  return res?.result ?? res;
};

// Quit first so `launch` really launches — that is the path the nudge is on.
await run('osascript', ['-e', `tell application "${APP}" to quit`]).catch(() => {});
await sleep(2500);
const launched = await dbg('launch', { app: APP });
console.log('launch   :', JSON.stringify(launched?.bounds ?? launched));
await sleep(2500);
const snap = await dbg('snapshot', { app: APP });
console.log('window   :', JSON.stringify(snap.window));
console.log('bounds   :', JSON.stringify(snap.windowBounds));
console.log('union    :', JSON.stringify(snap.union));
console.log(
  'windows  :',
  JSON.stringify(
    (snap.windows ?? []).map((w) => ({
      t: w.title,
      ...(w.bbox ?? {}),
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
    })),
  ),
);

const shot = await dbg('screenshot', { app: APP });
console.log(
  'shot     :',
  Object.keys(shot)
    .filter((k) => k !== 'base64')
    .map((k) => `${k}=${JSON.stringify(shot[k]).slice(0, 200)}`)
    .join(' '),
);
if (shot.base64) {
  const p = path.join(OUT, `${APP.replace(/\W/g, '')}.png`);
  writeFileSync(p, Buffer.from(shot.base64, 'base64'));
  console.log('wrote', p);
}
await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
