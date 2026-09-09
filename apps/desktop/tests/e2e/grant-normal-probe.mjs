/**
 * IS THE GRANT REAL WHEN macOS LAUNCHES THE APP ITSELF?
 *
 * The other probe spawns Contents/MacOS/Bobble directly, and TCC attributes a
 * request to the RESPONSIBLE process — which for a directly-spawned binary can
 * be the shell that spawned it rather than the bundle. This launches Bobble the
 * way a person does (LaunchServices) and asks the same question over CDP.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9333;

await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
await sleep(2000);
// -g: open without bringing it to the front (the user's screen stays his).
/*
 * LaunchServices, with the E2E env carried through `open --env` — so the app
 * gets the same debug channel and background behaviour as the spawned probes,
 * but macOS launches it the way a person does. That is the only difference
 * being tested.
 */
await run('open', [
  '-g',
  '--env',
  'PI_E2E=1',
  '--env',
  'PI_E2E_BACKGROUND=1',
  '--env',
  'PI_MAC_PRECONSENT=1',
  '-a',
  '/Applications/Bobble.app',
  '--args',
  `--remote-debugging-port=${PORT}`,
]);
await sleep(6000);

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = (ctx?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
  if (page === undefined) throw new Error('no renderer page over CDP');
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  const helper = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('helper sees:', JSON.stringify(helper?.result ?? helper));
  const grants = await page
    .evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'grants' }))
    .catch((e) => String(e).slice(0, 60));
  console.log('grants op:', JSON.stringify(grants));
  await page
    .evaluate(() =>
      window.piDesktop.invoke('mac:debug', {
        op: 'launch',
        params: { app: 'Calculator', background: true },
      }),
    )
    .catch(() => {});
  await sleep(2500);
  await page.evaluate(() => window.piDesktop.invoke('mac:monitor:subscribe', { frames: true }));
  await sleep(5000);
  /* DO FRAMES ACTUALLY ARRIVE? `stream: "live"` is the monitor's opinion; a
     frame is the evidence. Count them where they land. */
  await page.evaluate(() => {
    window.__frames = 0;
    window.piDesktop.onEvent('mac:monitor:frame', () => {
      window.__frames += 1;
    });
  });
  await sleep(9000);
  const frames = await page.evaluate(() => window.__frames ?? -1);
  const after = await page.evaluate(() =>
    window.piDesktop.invoke('mac:monitor:subscribe', { frames: true }),
  );
  console.log(
    `frames in 9s: ${frames} (stream=${after?.state?.stream} err=${after?.state?.streamError ?? 'none'})`,
  );

  const st = await page.evaluate(() =>
    window.piDesktop.invoke('mac:monitor:subscribe', { frames: true }),
  );
  console.log(
    'monitor:',
    JSON.stringify({
      stream: st?.state?.stream,
      denied: st?.state?.captureDenied,
      err: st?.state?.streamError,
    }),
  );
} finally {
  await browser?.close().catch(() => {});
}
