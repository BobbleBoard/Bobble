/**
 * LOOK at Manage Storage against the REAL library (read-only: a probe never
 * migrates, and this one only opens the page, expands, scrolls and reads
 * sizes — nothing is deleted, moved or exported).
 *
 * What it shows: the page at rest, the LLM shelf open, a model's card (the
 * publisher's avatar, blurb, chips, breadcrumb), the page SCROLLED so the
 * pinned toolbar and the card can be seen not fading, the row "…" menu, and
 * the same in light mode.
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
const shot = async (name) =>
  writeFileSync(path.join(shotDir, `${name}.png`), await win.screenshot());
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
    chip: document.querySelector('[data-testid="hub-disk-free"]')?.textContent,
    rows: [...document.querySelectorAll('[data-testid="storage-row-modality"]')].map(
      (r) =>
        `${r.querySelector('.pd-storage-name span')?.textContent}=${r.querySelector('[data-testid="storage-size"]')?.textContent}`,
    ),
  }));
  console.log(JSON.stringify(summary));
  await shot('01-real-storage');

  // Open every modality, then the shelves under 3D and Image, for a page that
  // is longer than the window.
  for (const r of await win.$$('[data-testid="storage-row-modality"] .pd-storage-twisty')) {
    await r.click();
  }
  await win.waitForTimeout(300);
  for (const sel of ['/3D/Generation', '/Image/Generation', '/LLM/MLX']) {
    const t = win.locator(
      `[data-testid="storage-row-shelf"][data-path$="${sel}"] .pd-storage-twisty`,
    );
    if ((await t.count()) > 0) await t.first().click();
  }
  await win.waitForTimeout(400);
  await shot('02-real-open');

  // A model with a known publisher: TRELLIS → microsoft.
  const trellis = win.locator('[data-testid="storage-row-model"][data-path*="trellis"]').first();
  if ((await trellis.count()) > 0) {
    await trellis.locator('[data-testid="storage-name"]').click();
    await win.waitForSelector('[data-testid="storage-inspector"]', { timeout: 3000 });
    await win.waitForTimeout(900); // the avatar fetch
    const card = await win.evaluate(() => ({
      name: document.querySelector('.pd-storage-card-name')?.textContent,
      avatar: document
        .querySelector('[data-testid="storage-inspector"] [data-testid^="org-avatar-"]')
        ?.getAttribute('data-testid'),
      img: document.querySelector('[data-testid="storage-inspector"] img') !== null,
      blurb: document.querySelector('[data-testid="inspector-blurb"]')?.textContent,
      chips: [...document.querySelectorAll('[data-testid="inspector-chips"] .pd-storage-chip')].map(
        (c) => c.textContent?.trim(),
      ),
      location: document.querySelector('[data-testid="inspector-location"]')?.textContent,
    }));
    console.log('card:', JSON.stringify(card));
    await shot('03-real-card');
  }

  // Scroll a long way: the toolbar stays, the card stays, nothing fades.
  const scrolled = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="storage-scroll"]');
    el.scrollTop = 420;
    return new Promise((r) =>
      requestAnimationFrame(() =>
        r({
          top: el.scrollTop,
          toolbar: document.querySelector('.pd-storage-toolbar')?.getBoundingClientRect().top,
          scroll: el.getBoundingClientRect().top,
          card: document.querySelector('.pd-storage-side')?.getBoundingClientRect().top,
          mask: getComputedStyle(el).maskImage,
        }),
      ),
    );
  });
  console.log('scrolled:', JSON.stringify(scrolled));
  await win.waitForTimeout(250);
  await shot('04-real-scrolled');

  // The row "…" menu.
  const row = win.locator('[data-testid="storage-row-model"]').first();
  if ((await row.count()) > 0) {
    await row.locator('[data-testid="storage-more"]').click();
    await win.waitForSelector('.pd-storage-menu', { timeout: 3000 });
    await win.waitForTimeout(250);
    await shot('05-real-menu');
    await win.keyboard.press('Escape');
    await win.mouse.click(5, 5);
  }

  // Light mode, same page.
  await win.evaluate(() => {
    document.documentElement.setAttribute('data-flavor', 'bobble');
    document.documentElement.setAttribute('data-mode', 'light');
  });
  await win.waitForTimeout(600);
  await shot('06-real-light');
  console.log('shots in', shotDir);
} finally {
  await finish();
}
