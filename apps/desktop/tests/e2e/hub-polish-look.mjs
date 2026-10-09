/**
 * THE MODEL HUB, LOOKED AT: the page, a card's quant menu with a row under the
 * pointer, and the bottom-left menu.
 *
 * The user (2026-10-08): the quant menu's hover "seems really thin … it should be a
 * bit wider and a bunch taller"; the hub is "a mess of filters and options all
 * dumped there" and reads as a page for technical users; Discover, On device
 * and Manage storage should be the high-level things, with the machine's specs
 * and the extra settings tucked away. This probe photographs each of those and
 * prints the boxes that decide them (the hovered row against its menu, the
 * header's controls), so a before and an after can be compared in numbers.
 *
 * The quant menu is a live Hugging Face listing: this needs the network.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/hub-polish-look.mjs
 */
import { launchApp } from './harness.mjs';

const REPO = process.env.REPO ?? 'unsloth/Qwen3.8-27B-GGUF';
const { page, shot, check, finish } = await launchApp('hub-polish', {
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** THEME=light flips the app to light through its own menu before looking. */
async function applyTheme() {
  if (process.env.THEME !== 'light') return;
  const dark = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
  if (dark === 'light') return;
  await page.click('[data-testid="profile-button"]');
  await page.click('[data-testid="toggle-mode"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-mode') === 'light');
}
const box = (el) =>
  el.evaluate((n) => {
    const r = n.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
try {
  await applyTheme();
  await page.click('[data-testid="nav-model-management"]');
  await sleep(2500);
  await shot('1-hub');
  // The folded-away parts, opened (they exist from the 2026-10-08 header on).
  if ((await page.$('[data-testid="hub-mac-toggle"]')) !== null) {
    await page.click('[data-testid="hub-mac-toggle"]');
    await sleep(500);
    const strip = (await page.textContent('[data-testid="hardware-strip"]')) ?? '';
    check(/GB RAM/.test(strip), `This Mac opens to the machine's specs ("${strip.trim()}")`);
    await shot('1b-this-mac');
    await page.click('[data-testid="hub-mac-toggle"]');
    await page.click('[data-testid="hub-scope-all"]');
    await sleep(1200);
    await page.click('[data-testid="hub-filters"]');
    await sleep(500);
    check(
      await page.isVisible('[data-testid="filter-sort"]'),
      'Filters opens to the sort, format, capability and size controls',
    );
    await shot('1c-filters');
    await page.click('[data-testid="hub-filters"]');
    await page.click('[data-testid="hub-scope-recommended"]');
    await sleep(1200);
  }

  // ── the other two places ─────────────────────────────────────────────────
  for (const t of ['device', 'storage']) {
    await page.click(`[data-testid="models-tab-${t}"]`);
    await sleep(1500);
    await shot(`1d-${t}`);
  }
  await page.click('[data-testid="models-tab-discover"]');
  await sleep(1500);

  // ── a card's quant menu, one row under the pointer ───────────────────────
  const variant = page.locator(`[data-testid^="family-variant-${REPO}:"]`).first();
  check((await variant.count()) > 0, `Recommended offers ${REPO}`);
  const family = await variant.evaluate(
    (el) =>
      el
        .closest('[data-testid^="family-card-"]')
        ?.getAttribute('data-testid')
        ?.slice('family-card-'.length) ?? '',
  );
  await page.click(`[data-testid="family-toggle-${family}"]`);
  await sleep(400);
  if ((await variant.getAttribute('data-selected')) !== 'true') {
    await variant.locator('button').first().click();
  }
  await page.waitForSelector('[data-testid="model-detail"]', { timeout: 10_000 });
  const listed = await page
    .waitForSelector('[data-testid="quant-picker"]', { timeout: 45_000 })
    .then(
      () => true,
      () => false,
    );
  check(listed, `${REPO}'s files came back from Hugging Face`);
  if (listed) {
    await page.click('[data-testid="quant-current"]');
    await page.waitForSelector('[data-testid="quant-menu"]');
    const rows = page.locator('[data-testid="quant-menu"] [data-testid^="quant-opt-list-"]');
    const row = rows.nth(3);
    await row.hover();
    await sleep(400);
    const menuBox = await box(page.locator('[data-testid="quant-menu"]'));
    const rowBox = await box(row);
    const wash = await row.evaluate((n) => getComputedStyle(n).backgroundColor);
    console.log('quant menu', JSON.stringify(menuBox), 'hovered row', JSON.stringify(rowBox), wash);
    await shot('2-quant-hover', page.locator('[data-testid="model-detail"]'));
    await page.keyboard.press('Escape');
    await page.click('[data-testid="quant-current"]').catch(() => {});
    await sleep(300);
  }

  // ── the bottom-left menu ─────────────────────────────────────────────────
  await page.mouse.click(5, 5);
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]');
  await sleep(400);
  await shot('3-profile-menu');
} finally {
  await finish();
}
