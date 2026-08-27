/**
 * b5: does the effort popover still cover the editor?
 *
 * The report MEASURED 56.63 px of vertical overlap — the editor's full height,
 * across the right 38% of it. This drives the real app, opens the popover with a
 * multi-line draft in the box (the case a fixed sideOffset cannot handle), and
 * reports the intersection rectangle.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-effort-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

// A tall draft is the case a fixed offset gets wrong.
await page.click('.pd-composer-editor');
for (let i = 0; i < 4; i++) {
  await page.keyboard.type(`line ${i} of a draft the user is reading while choosing effort`);
  await page.keyboard.press('Shift+Enter');
}
await page.waitForTimeout(300);
await page.click('[data-testid="composer-effort"]');
await page.waitForSelector('.pd-effort-popover', { timeout: 5000 });
await page.waitForTimeout(400);

const m = await page.evaluate(() => {
  const pop = document.querySelector('.pd-effort-popover');
  const ed = document.querySelector('.pd-composer-editor');
  if (!pop || !ed) return { missing: { pop: !pop, editor: !ed } };
  const p = pop.getBoundingClientRect();
  const e = ed.getBoundingClientRect();
  const yOverlap = Math.max(0, Math.min(p.bottom, e.bottom) - Math.max(p.top, e.top));
  const xOverlap = Math.max(0, Math.min(p.right, e.right) - Math.max(p.left, e.left));
  return {
    yOverlap: +yOverlap.toFixed(2),
    xOverlap: +xOverlap.toFixed(2),
    editorHeight: +e.height.toFixed(2),
    editorWidth: +e.width.toFixed(2),
    popTop: +p.top.toFixed(2),
    editorTop: +e.top.toFixed(2),
  };
});
console.log('[effort]', JSON.stringify(m));
await page.screenshot({ path: process.env.SHOT ?? '/tmp/effort-popover.png' });
await app.close();
if (m === null || m.missing !== undefined) {
  console.error('[effort] FAIL: could not measure', JSON.stringify(m));
  process.exit(1);
}
if (m.yOverlap > 0) {
  console.error(`[effort] FAIL: popover still covers the editor by ${m.yOverlap}px`);
  process.exit(1);
}
console.log('[effort] OK: zero overlap with the editor rect');
