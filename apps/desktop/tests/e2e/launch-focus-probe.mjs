/**
 * DOES A BACKGROUND LAUNCH TAKE THE SCREEN? Measured directly, no model.
 *
 * `open -g` asks for a background launch; an app is free to activate itself
 * anyway, and Chrome's profile chooser does. This isolates the question from a
 * four-minute model run: note who has focus, launch, and watch.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9361;
const APP = process.argv[2] ?? 'Google Chrome';

const front = async () =>
  (
    await run('osascript', [
      '-e',
      'tell application "System Events" to name of first application process whose frontmost is true',
    ]).catch(() => ({ stdout: '?' }))
  ).stdout.trim();

await run('osascript', ['-e', `tell application "${APP}" to quit`]).catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
await sleep(3000);
await run('open', [
  '-g',
  '--env',
  'PI_E2E=1',
  '--env',
  'PI_E2E_BACKGROUND=1',
  '-a',
  '/Applications/Bobble.app',
  '--args',
  `--remote-debugging-port=${PORT}`,
]);
await sleep(7000);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
try {
  const page = (browser.contexts()[0]?.pages() ?? []).find(
    (p) => !p.url().startsWith('devtools://'),
  );
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  console.log(`before launch, frontmost: ${await front()}`);
  await page.evaluate(
    (app) =>
      window.piDesktop.invoke('mac:debug', { op: 'launch', params: { app, background: true } }),
    APP,
  );
  const seen = [];
  for (let i = 0; i < 14; i += 1) {
    await sleep(500);
    seen.push(await front());
  }
  const stole = seen.filter((a) => new RegExp(APP.split(' ')[0], 'i').test(a));
  console.log(`after launch, 7s of samples: ${JSON.stringify(seen)}`);
  console.log(`${APP} frontmost in ${stole.length}/${seen.length}`);
} finally {
  await browser.close().catch(() => {});
  await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
  await run('osascript', ['-e', `tell application "${APP}" to quit`]).catch(() => {});
}
