import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9334;
await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
await sleep(2500);
await run('open', ['-g', '--env', 'PI_E2E=1', '--env', 'PI_E2E_BACKGROUND=1', '-a', '/Applications/Bobble.app', '--args', `--remote-debugging-port=${PORT}`]);
await sleep(6000);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
try {
  const page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 30000 });
  const before = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('before prompt:', JSON.stringify(before?.result ?? before));
  console.log('...asking macOS for the Accessibility grant (a dialog may appear)');
  const p = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'promptGrants' })).catch((e) => String(e).slice(0, 80));
  console.log('promptGrants:', JSON.stringify(p?.result ?? p));
  await sleep(1500);
  const after = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('after prompt:', JSON.stringify(after?.result ?? after));
} finally { await browser.close().catch(() => {}); }
