/**
 * b9: a harness warning has to be visible.
 *
 * The event router passed only `error` through, so every warning the harness
 * raises — a model too small for the work it just reached for, a failed verify,
 * a loop-guard steer — was dropped before anyone could see it. `info` stays
 * dropped on purpose: the app fires `/harness set-mode`, `effort` and `preset`
 * PROGRAMMATICALLY on every settings change, and routing that would inject
 * plumbing rows into ordinary conversations.
 *
 * Drives the real renderer through the sink the event router itself uses, then
 * looks at what actually rendered.
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

const fail = (m) => {
  console.error(`notice-row-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-notice-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__pi_sink === 'function', { timeout: 10_000 });

  const WARNING = 'Qwen3.5 4B (~4B) is small for generation work — results may be unreliable.';
  await page.evaluate((text) => {
    window.__pi_sink().notify('warning', text);
  }, WARNING);
  await page.waitForTimeout(600);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="chat-notice"]')].map((n) => n.textContent ?? ''),
  );
  if (rows.length === 0) fail('a harness warning rendered nothing');
  else if (!rows[0].includes('small for generation')) fail(`wrong text: ${rows[0]}`);
  else console.log('[notice] OK: the warning is in the transcript');

  // It has to be legible, not just present — a row nobody can read is not a fix.
  const style = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-notice"]');
    if (el === null) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { color: cs.color, background: cs.backgroundColor, width: Math.round(r.width) };
  });
  if (style === null || style.width < 100)
    fail(`the row is not laid out: ${JSON.stringify(style)}`);
  else if (style.color === style.background) fail(`invisible text: ${JSON.stringify(style)}`);
  else console.log(`[notice] OK: legible (${JSON.stringify(style)})`);

  // `info` must stay out: it is machine echo the app fires on every settings change.
  await page.evaluate(() => window.__pi_sink().notify('info', 'effort → high'));
  await page.waitForTimeout(400);
  const after = await page.evaluate(
    () => document.querySelectorAll('[data-testid="chat-notice"]').length,
  );
  if (after !== 1) fail(`an info notification added a row (now ${after})`);
  else console.log('[notice] OK: info stays out of the transcript');
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('notice-row-probe OK');
