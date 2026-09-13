/**
 * NO ROOM, NO DOWNLOAD — and the hub says so where the click happened.
 *
 * the user: "don't allow / warn of disk space issues when downloading a model
 * that there isn't enough space for." The probe runs against the REAL volume
 * (a throwaway HOME lives on the same disk) and asks the hub to fetch a
 * recommended recipe bigger than what is free, then checks that the refusal
 * is on screen with both figures, that nothing started (no bar, no
 * supervisor download, an empty store), and that the top-right strip
 * carries the free-space chip. It needs a disk with less free space than
 * the recipe (17 GB) — true of this Mac; elsewhere it reports and skips.
 *
 *   SHOT_DIR=/tmp/hub-space node apps/desktop/tests/e2e/hub-space-probe.mjs
 */
import { launchApp } from './harness.mjs';

const {
  page: win,
  check,
  shot,
  finish,
} = await launchApp('hub-space', {
  waitFor: '[data-testid="composer-input"]',
});
try {
  await win.waitForTimeout(800);
  await win.click('[data-testid="nav-model-management"]');
  await win.waitForSelector('[data-testid="top-recommended-heading"]', { timeout: 20000 });
  await win.waitForTimeout(600);

  // The disk's own figure decides: with 7 GB free on this Mac the recipe's
  // 17 GB is refused by the real check (a contextBridge `invoke` cannot be
  // spied on from the page, so the probe reads outcomes, not calls).
  const disk = await win.evaluate(() => window.piDesktop.invoke('storage:disk', undefined));
  console.log('disk:', JSON.stringify(disk));

  const chip = await win.evaluate(
    () => document.querySelector('[data-testid="hub-disk-free"]')?.textContent ?? null,
  );
  check(chip !== null && /GB free/.test(chip), `the strip shows free disk space (${chip})`);

  // A generation recipe (the store path; the variant carries approxBytes).
  // Quick Download is the one button visible on a collapsed family card.
  const gen = win.locator('[data-testid="family-quick-mage-flow"]');
  if (disk.free > 17e9) {
    console.log('this disk has room for the 17 GB recipe — nothing to refuse; skipping');
  } else {
    await gen.first().scrollIntoViewIfNeeded();
    await gen.first().click();
    await win.waitForSelector('[data-testid="models-error"]', { timeout: 5000 });
    const err1 = await win.evaluate(
      () => document.querySelector('[data-testid="models-error"]')?.textContent ?? '',
    );
    check(
      /Not enough space: this needs \d+(\.\d+)? GB and the disk has \d+(\.\d+)? GB free/.test(err1),
      `the recipe is refused with its size and the free figure (${err1})`,
    );
    await win.waitForTimeout(600);
    const after = await win.evaluate(async () => ({
      bars: document.querySelectorAll('[data-testid^="family-quick-progress-"]').length,
      llm: window.__llm_store?.().getState().download ?? null,
      store: (await window.piDesktop.invoke('store:list', undefined)).models.length,
    }));
    check(
      after.bars === 0 && after.llm === null && after.store === 0,
      `nothing started: no bar, no supervisor download, nothing in the store (${JSON.stringify(after)})`,
    );
    await win.evaluate(() =>
      document.querySelector('[data-testid="models-error"]')?.scrollIntoView({ block: 'center' }),
    );
    await win.waitForTimeout(300);
    await shot('01-refused-recipe');
  }
} finally {
  await finish();
}
