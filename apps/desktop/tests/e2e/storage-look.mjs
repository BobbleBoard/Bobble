/**
 * LOOK at Manage Storage against the REAL library (read-only: a probe never
 * migrates, and this one only opens the page and reads sizes).
 *
 *   SHOT_DIR=/tmp/storage-look node apps/desktop/tests/e2e/storage-look.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const {
  page: win,
  finish,
  shotDir,
} = await launchApp('storage-look', {
  realCache: true,
  waitFor: '[data-testid="composer-input"]',
});
try {
  await win.waitForTimeout(1500);
  await win.click('[data-testid="nav-model-management"]');
  await win.waitForSelector('[data-testid="models-tab-storage"]', { timeout: 15000 });
  await win.click('[data-testid="models-tab-storage"]');
  await win.waitForSelector(
    '[data-testid="storage-library"] [data-testid="storage-row-modality"]',
    {
      timeout: 120000,
    },
  );
  await win.waitForTimeout(500);
  const summary = await win.evaluate(() => ({
    root: document.querySelector('[data-testid="storage-root"]')?.textContent,
    disk: document.querySelector('[data-testid="storage-disk"]')?.textContent,
    rows: [...document.querySelectorAll('[data-testid="storage-row-modality"]')].map(
      (r) =>
        `${r.querySelector('.pd-storage-name span')?.textContent}=${r.querySelector('[data-testid="storage-size"]')?.textContent}`,
    ),
    foot: document.querySelector('.pd-storage-foot')?.textContent,
  }));
  console.log(JSON.stringify(summary));
  writeFileSync(path.join(shotDir, '01-real-storage.png'), await win.screenshot());
  // Expand LLM → GGUF for the model rows.
  const llm = win.locator('[data-testid="storage-row-shelf"][data-path$="/LLM"]').first();
  await llm.locator('.pd-storage-twisty').first().click();
  await win.waitForTimeout(400);
  writeFileSync(path.join(shotDir, '02-real-llm-shelf.png'), await win.screenshot());
  console.log('shots in', shotDir);
} finally {
  await finish();
}
