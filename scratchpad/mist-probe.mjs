/** Put a real window in the monitor and photograph its edges, so the mist can
 *  be LOOKED AT rather than argued about. */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/Users/user/Desktop/OSS-harness/scratchpad/mist-shot';
const PORT = 9417;
mkdirSync(OUT, { recursive: true });
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
while (await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).then((r) => r.stdout.trim() !== '', () => false)) await sleep(500);
await run('open', ['-g', '--env', 'PI_E2E=1', '-a', '/Applications/Bobble.app', '--args', `--remote-debugging-port=${PORT}`]);
await sleep(9000);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 40_000 });
const dbg = async (op, params) => {
  const r = await page.evaluate((x) => window.piDesktop.invoke('mac:debug', x), { op, params });
  if (r?.ok === false) throw new Error(`${op}: ${r.error}`);
  return r?.result ?? r;
};
await run('open', ['-g', '-a', 'Maps']);
await sleep(4000);
const b = await dbg('bounds', { app: 'Maps' });
await dbg('monitor-session', { pid: b.pid, app: 'Maps' });
await sleep(6000);
await page.screenshot({ path: `${OUT}/monitor.png` });
console.log('shot written');
await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
await run('osascript', ['-e', 'tell application "Maps" to quit']).catch(() => {});
