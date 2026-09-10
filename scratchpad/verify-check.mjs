/** Read the page's own verdict right now, without running a model. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9416;
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
while (await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).then((r) => r.stdout.trim() !== '', () => false)) await sleep(500);
await run('open', ['-g', '--env', 'PI_E2E=1', '-a', '/Applications/Bobble.app', '--args', `--remote-debugging-port=${PORT}`]);
await sleep(8000);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 40_000 });
const dbg = async (op, params) => {
  const r = await page.evaluate((x) => window.piDesktop.invoke('mac:debug', x), { op, params });
  return r?.result ?? r;
};
const find = (els) =>
  (els ?? []).filter((e) => e.role === 'AXRadioButton' && /\b\d+\s*(GB|TB)\b/i.test(e.name ?? ''));
let radios = find((await dbg('snapshot', { app: 'Google Chrome' })).elements);
if (radios.length === 0) {
  for (let i = 0; i < 6; i += 1) await dbg('scroll', { app: 'Google Chrome', direction: 'up', amount: 2000 });
  for (let i = 0; i < 24 && radios.length === 0; i += 1) {
    await dbg('scroll', { app: 'Google Chrome', direction: 'down', amount: 700 });
    await sleep(550);
    radios = find((await dbg('snapshot', { app: 'Google Chrome' })).elements);
  }
}
const chosen = radios.filter((e) => String(e.value ?? '0') !== '0').map((e) => (e.name ?? '').match(/\b\d+\s*(?:GB|TB)\b/i)?.[0]);
const snap = await dbg('snapshot', { app: 'Google Chrome' });
console.log('window  :', snap.window);
console.log('elements:', (snap.elements ?? []).length);
console.log('roles   :', [...new Set((snap.elements ?? []).map((e) => e.role))].slice(0, 12).join(', '));
const fields = (snap.elements ?? []).filter((e) => e.role === 'AXTextField');
console.log('address :', JSON.stringify(fields.map((e) => (e.value ?? e.name ?? '').slice(0, 120))));
console.log('all radios:', JSON.stringify((snap.elements ?? []).filter((e) => e.role === 'AXRadioButton').map((e) => (e.name ?? '').slice(0, 60))));
console.log('offered:', radios.map((e) => (e.name ?? '').match(/\b\d+\s*(?:GB|TB)\b/i)?.[0]).join(', '));
console.log('SELECTED:', JSON.stringify(chosen));
await browser.close().catch(() => {});
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
