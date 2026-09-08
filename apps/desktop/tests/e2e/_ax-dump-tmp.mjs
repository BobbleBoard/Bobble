/** Dump the REAL AX snapshot of TextEdit (window + save sheet) so the fallback
 * renderer is built against actual data, not a guess. Dev Electron holds the
 * Accessibility grant (measured). */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { probeHome } from '/Users/user/Desktop/OSS-harness/apps/desktop/tests/e2e/harness.mjs';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (s) => run('osascript', ['-e', s]).catch(() => undefined);
const OUT = path.dirname(fileURLToPath(import.meta.url));
const appRoot = '/Users/user/Desktop/OSS-harness/apps/desktop';

await osa('tell application "TextEdit" to close every document without saving');
await sleep(400);
await osa('tell application "TextEdit" to quit saving no');
await sleep(1200);

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-axdump-'))}`],
  env: {
    ...process.env,
    HOME: probeHome('ax-dump'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_MAC_PRECONSENT: '1',
  },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30_000,
  });
  const dbg = async (op, params) => {
    const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
    if (res.ok !== true) throw new Error(`${op}: ${res.error}`);
    return res.result;
  };
  console.log('TCC', JSON.stringify(await dbg('check')));
  const launch = await dbg('launch', { app: 'TextEdit', background: true });
  const pid = launch.pid;
  console.log('pid', pid, JSON.stringify(launch.bounds ?? null));
  await dbg('key', { pid, combo: 'cmd+n' });
  await sleep(1200);
  await dbg('snapshot', { pid });
  const area = (await dbg('snapshot', { pid })).elements?.find((e) => e.role === 'AXTextArea');
  if (area) {
    await dbg('type', {
      pid,
      index: area.index,
      text: 'Bobble is driving this window.\nThe monitor is drawing it from Accessibility.\n',
      append: true,
    });
  }
  await sleep(700);
  const plain = await dbg('snapshot', { pid, cap: 200 });
  writeFileSync(path.join(OUT, 'ax-plain.json'), JSON.stringify(plain, null, 2));
  console.log('--- PLAIN ---');
  console.log('windows', JSON.stringify(plain.windows));
  console.log('windowBounds', JSON.stringify(plain.windowBounds), 'union', JSON.stringify(plain.union));
  console.log('elements', JSON.stringify(plain.elements, null, 1).slice(0, 4000));

  await dbg('menuClick', { pid, path: 'File > Save', activate: true });
  await sleep(1600);
  const sheet = await dbg('snapshot', { pid, cap: 200 });
  writeFileSync(path.join(OUT, 'ax-sheet.json'), JSON.stringify(sheet, null, 2));
  console.log('--- SHEET ---');
  console.log('windows', JSON.stringify(sheet.windows));
  console.log('dialog', JSON.stringify(sheet.dialog));
  console.log('union', JSON.stringify(sheet.union));
  console.log('elements', JSON.stringify(sheet.elements, null, 1).slice(0, 6000));
} finally {
  await app.close().catch(() => {});
  await osa('tell application "TextEdit" to quit saving no');
}
process.exit(0);
