/** Screenshots of the group-(b) parity work, for review. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');
const OUT = process.env.OUT ?? '/tmp/round-b-shots';
mkdirSync(OUT, { recursive: true });

const dir = path.join(homedir(), '.pi/agent/sessions', '-tmp-shots-');
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, 'shots.jsonl'),
  `${[
    JSON.stringify({
      type: 'session',
      id: 'shots',
      cwd: '/tmp/w',
      timestamp: '2026-08-20T09:00:00Z',
    }),
    JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'set up the release build' },
    }),
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: 'Done — the notarization step is the slow one.' },
    }),
  ].join('\n')}\n`,
);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-shots-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });
await page.waitForFunction(() => typeof window.__pi_sink === 'function', { timeout: 10_000 });

// 1. The harness warning, in the transcript.
await page.click('.pd-composer-editor');
await page.keyboard.type('make me a picture of a red fox');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
await page.evaluate(() =>
  window
    .__pi_sink()
    .notify(
      'warning',
      'Qwen3.5 4B (~4B) is small for generation work — results may be unreliable. Consider a larger model.',
    ),
);
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '1-notice-row.png') });

// 2. The effort popover, clear of a multi-line draft.
await page.click('.pd-composer-editor');
for (let i = 0; i < 3; i++) {
  await page.keyboard.type(`line ${i} of a draft you can still read`);
  await page.keyboard.press('Shift+Enter');
}
await page.click('[data-testid="composer-effort"]');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '2-effort-popover.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 3. Content search with its excerpt.
await page.click('.pd-collapsible-search--collapsed');
await page.waitForTimeout(300);
const search = page.locator('input[placeholder="Search chats"]').first();
await search.fill('notarization');
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(OUT, '3-content-search.png') });
await search.fill('');
await page.waitForTimeout(600);

// 4. The Export submenu.
// The 3-dot menu is hover-revealed, so hover the ROW first.
await page.locator('.pd-chatrow').first().hover();
await page.waitForTimeout(400);
const row = page.locator('[data-testid^="chat-menu-"]').first();
await row.click({ force: true });
await page.waitForTimeout(400);
await page.locator('[role="menuitem"]', { hasText: 'Export' }).first().hover();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '4-export-menu.png') });
await page.keyboard.press('Escape');

console.log(`shots in ${OUT}`);
await app.close();
