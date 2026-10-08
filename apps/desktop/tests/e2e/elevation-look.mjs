/**
 * LOOK at the 3D studio's floating surfaces, light and dark.
 *
 * the user (2026-09-24), on the studio's History card: "it looks 'flimsy' not like
 * it's a card firmly placed on top" — after "everything has the same softness".
 * The fix is in the elevation tokens and the studio's panel material, and a
 * token change can only be judged on the page: the design audit's throwaway
 * HOME has no 3D module, so its studio shot is the install gate over a blurred
 * studio and never shows the History card at all.
 *
 * So this opens the studio (PI_DESKTOP_TRIPO), shoots the install gate's card,
 * lifts it with View, drops a real model into the viewport — which loads an
 * asset, and with it the History card and the viewport's floating panels — and
 * shoots the whole studio plus a crop around the History card in both modes.
 * Each surface's computed fill, edge and shadow is printed beside the pixels.
 *
 *   GLB=<model.glb> SHOT_DIR=<dir> node apps/desktop/tests/e2e/elevation-look.mjs
 *
 * Run it once on the old build and once on the new one with different
 * SHOT_DIRs; the file names pair up.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const GLB = process.env.GLB ?? '';
if (GLB === '') throw new Error('set GLB=/path/to/model.glb');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { page, check, finish, shotDir } = await launchApp('elevation', {
  env: { PI_DESKTOP_TRIPO: '1' },
  waitFor: '[data-testid="tp-rightpanel"]',
  timeout: 60_000,
});

const setTheme = (mode) =>
  page.evaluate((mode) => {
    const t = window.__pi_theme?.();
    t?.setFlavor?.('bobble');
    t?.setMode?.(mode);
    return `${document.documentElement.dataset.flavor}/${document.documentElement.dataset.mode}`;
  }, mode);

/** A shot of one element with room around it for its shadow to show. */
const crop = async (selector, label, pad = 40) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!check(box !== null, `${selector} is on the page for ${label}`)) return;
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: path.join(shotDir, `${label}.png`),
    clip: {
      x,
      y,
      width: Math.min(vp.width - x, box.width + pad * 2),
      height: Math.min(vp.height - y, box.height + pad * 2),
    },
  });
};

/** Fill / edge / shadow of each floating surface that is on the page. */
const surfaces = () =>
  page.evaluate(() => {
    const out = {};
    for (const sel of [
      '.tp-gate-card',
      '.tp-history-rail',
      '.tp-float-group',
      '.tp-strip-pill',
      '.tp-actionbar',
      '.tp-genpanel',
    ]) {
      const el = document.querySelector(sel);
      if (el === null || el.getBoundingClientRect().width === 0) continue;
      const cs = getComputedStyle(el);
      out[sel] = {
        bg: cs.backgroundColor,
        edge: `${cs.borderTopWidth} ${cs.borderTopColor}`,
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow,
      };
    }
    return out;
  });

try {
  // 1. The install gate (no module in a throwaway HOME).
  const gated = (await page.locator('[data-testid="tp-module-gate"]').count()) > 0;
  if (gated) {
    for (const mode of ['light', 'dark']) {
      console.log('theme', await setTheme(mode));
      await sleep(500);
      await crop('.tp-gate-card', `gate-card-${mode}`, 72);
      console.log(`gate ${mode}`, JSON.stringify((await surfaces())['.tp-gate-card']));
    }
    await setTheme('light');
    await page.click('[data-testid="tp-gate-view"]');
    await sleep(600);
  }

  // 2. A real model in the viewport: an asset loads, the History card appears.
  const b64 = readFileSync(GLB).toString('base64');
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], 'model.glb', { type: 'model/gltf-binary' }));
    document.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  }, b64);
  await page
    .waitForSelector('[data-testid="tp-history-rail"]', { timeout: 30_000 })
    .catch(() => undefined);
  await sleep(Number(process.env.SETTLE ?? 5000));
  check(
    (await page.locator('[data-testid="tp-history-rail"]').count()) > 0,
    'the History card is up once a model is loaded',
  );

  for (const mode of ['light', 'dark']) {
    console.log('theme', await setTheme(mode));
    await sleep(900);
    await page.screenshot({ path: path.join(shotDir, `studio-${mode}.png`) });
    await crop('[data-testid="tp-history-rail"]', `history-card-${mode}`, 48);
    console.log(`studio ${mode}`, JSON.stringify(await surfaces(), null, 1));
  }
} finally {
  await finish();
}
