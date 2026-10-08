/**
 * THE IMAGE STAGE'S PICTURE, CLEAR OF THE FLOATING CARD?
 *
 * The 3D studio shows the Image stage's picture in the viewport, and the
 * Generate card floats over the viewport's left. `.tp-image-stage` was meant to
 * keep the picture out from under it — a `padding-left: 312px` written ABOVE a
 * `padding: 40px` that cancelled it (biome: noShorthandPropertyOverrides) — so
 * the picture sat centred on the whole viewport, partly under the card. It now
 * pads by the measured cover (`--tp-covered-left`, viewport-cover.ts), as the
 * empty state does.
 *
 * No image model runs: the picture goes into the studio's store
 * (`__tripo_store`, the ?piE2E=1 hook) as the Image stage's one version.
 *
 * Usage (build first): node apps/desktop/tests/e2e/image-stage-look.mjs
 *   SHOT_DIR   where the screenshots go
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PICTURE = path.join(HERE, '..', '..', '..', '..', 'packages/pi-mac/fixtures/vision/cat.jpg');

const { page, shot, check, finish, home } = await launchApp('image-stage', {
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const dir = path.join(home, 'Bobble', 'generated', 'look');
  mkdirSync(dir, { recursive: true });
  const local = path.join(dir, 'cat.jpg');
  copyFileSync(PICTURE, local);

  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-viewport"]', { timeout: 20_000 });
  const view = await page.$('[data-testid="tp-gate-view"]');
  if (view) await view.click();
  await sleep(1500);

  await page.evaluate((p) => {
    window.__tripo_store?.().setState({
      tool: 'image',
      imageVersions: [{ path: p, label: 'Original' }],
      imageIndex: 0,
    });
  }, local);
  await page.waitForFunction(
    () => {
      const img = document.querySelector('[data-testid="tp-image-stage-img"]');
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
    },
    undefined,
    { timeout: 15_000 },
  );
  await sleep(600);
  await shot('image-stage');

  const boxes = await page.evaluate(() => {
    const box = (el) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
      };
    };
    const viewport = document.querySelector('[data-testid="tp-viewport"]');
    return {
      viewport: box(viewport),
      card: box(document.querySelector('.tp-genpanel')),
      picture: box(document.querySelector('[data-testid="tp-image-stage-img"]')),
      coveredLeft: viewport ? getComputedStyle(viewport).getPropertyValue('--tp-covered-left') : '',
    };
  });
  console.log(JSON.stringify(boxes));
  check(boxes.card !== null, 'the floating card is on screen');
  check(boxes.picture !== null, 'the picture is in the viewport');
  if (boxes.card !== null && boxes.picture !== null) {
    check(
      boxes.picture.left >= boxes.card.right,
      `the picture starts right of the card (picture ${boxes.picture.left} px, card ends ${boxes.card.right} px)`,
    );
  }
} finally {
  await finish();
}
