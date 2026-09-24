/**
 * LOOK at the 3D studio's download cards for the two Mage-Flow models.
 *
 * SPK-02 moved where Mage-Flow's weights download from (Comfy-Org/Mage-Flow +
 * Qwen/Qwen3-VL-4B-Instruct instead of the withdrawn microsoft/* repos). The
 * cards must not change: same name, same note, same "Download · 17.5 GB". This
 * captures both cards in dark and light so a before/after pair can be diffed.
 *
 * The engine is forced to "not installed" (no sidecar, empty cache), the same
 * way tripo-ui-probe does, so the cards show their download state whatever is
 * on this Mac.
 *
 *   SHOT_DIR=/tmp/x node apps/desktop/tests/e2e/gen3d-download-card-look.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const emptyCache = mkdtempSync(path.join(tmpdir(), 'gen3d-empty-'));
const {
  page: win,
  finish,
  shotDir,
} = await launchApp('gen3d-download-card-look', {
  waitFor: '[data-testid="tp-root"]',
  env: {
    PI_DESKTOP_TRIPO: '1',
    GEN3D_PY_DIR: '/nonexistent-gen3d-py-dir',
    GEN3D_CACHE_DIR: emptyCache,
  },
});

const cards = {};
try {
  // The module gate covers the room while it decides; "View" is its own way in.
  const gate = await win.$('[data-testid="tp-gate-view"]');
  if (gate !== null) {
    await gate.click();
    await win
      .waitForSelector('[data-testid="tp-module-gate"]', { state: 'hidden', timeout: 8000 })
      .catch(() => undefined);
  }
  await win.click('[data-testid="tp-generate-btn"]');
  await win.waitForSelector('[data-testid="tp-download-panel"]', { timeout: 15000 });
  await win.waitForSelector('[data-testid="tp-dlcard-mageflow-edit"]', { timeout: 15000 });
  for (const mode of ['dark', 'light']) {
    await win.evaluate((m) => {
      document.documentElement.setAttribute('data-flavor', 'bobble');
      document.documentElement.setAttribute('data-mode', m);
    }, mode);
    await win.waitForTimeout(500);
    for (const id of ['mageflow', 'mageflow-edit']) {
      const card = win.locator(`[data-testid="tp-dlcard-${id}"]`);
      await card.scrollIntoViewIfNeeded();
      await win.waitForTimeout(250);
      cards[`${mode}:${id}`] = (await card.innerText()).replace(/\s+/g, ' ').trim();
      writeFileSync(path.join(shotDir, `${mode}-${id}.png`), await card.screenshot());
    }
    writeFileSync(path.join(shotDir, `${mode}-panel.png`), await win.screenshot());
  }
  console.log(JSON.stringify(cards, null, 2));
  console.log('shots in', shotDir);
  // The source moved; the cards did not.
  for (const [key, text] of Object.entries(cards)) {
    if (!text.includes('Download · 17.5 GB')) {
      throw new Error(`gen3d-download-card-look: ${key} no longer offers 17.5 GB: ${text}`);
    }
  }
  if (!cards['dark:mageflow'].includes('(microsoft/Mage-Flow-Turbo, MIT)')) {
    throw new Error('gen3d-download-card-look: the Turbo card lost its attribution');
  }
} finally {
  await finish();
  rmSync(emptyCache, { recursive: true, force: true });
}
