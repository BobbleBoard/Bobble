import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9419;
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
while (await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).then((r) => r.stdout.trim() !== '', () => false)) await sleep(500);
await run('open', ['-g', '--env', 'PI_E2E=1', '-a', '/Applications/Bobble.app', '--args', `--remote-debugging-port=${PORT}`]);
await sleep(9000);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 40_000 });
const dbg = async (op, params) => {
  const r = await page.evaluate((x) => window.piDesktop.invoke('mac:debug', x), { op, params });
  return r?.result ?? r;
};
const names = async () => {
  const s = await dbg('snapshot', { app: 'Google Chrome' });
  return (s.elements ?? []).map((e) => (e.name ?? '').slice(0, 24)).join('|');
};
for (let i = 0; i < 8; i += 1) await dbg('scroll', { app: 'Google Chrome', direction: 'up', amount: 2000 });
await sleep(800);
for (let i = 0; i < 26; i += 1) {
  const s = await dbg('snapshot', { app: 'Google Chrome' });
  const radios = (s.elements ?? []).filter((e) => e.role === 'AXRadioButton').map((e) => (e.name ?? '').slice(0, 26));
  const heads = (s.elements ?? []).filter((e) => /storage|how much space/i.test(e.name ?? '')).length;
  console.log(`step ${String(i).padStart(2)}  radios=${JSON.stringify(radios).slice(0, 110)}  storageText=${heads}`);
  if (radios.some((r) => /\d+\s*(GB|TB)/i.test(r))) { console.log('FOUND at step', i); break; }
  await dbg('scroll', { app: 'Google Chrome', direction: 'down', amount: 700 });
  await sleep(550);
}
await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
