/**
 * WATCH A GENERATION HAPPEN — the user: "image and non textured model should be
 * shown as soon as ready during pipeline generations."
 *
 * Drops a source image on the Model tab, starts a run, and samples the viewport
 * on a timer. What is being checked is WHEN each thing appears: the Mage-Flow
 * image while there is still no mesh, then the untextured geometry, then the
 * textured model — rather than the blank panel the viewport used to show for
 * the first minute.
 */
import { _electron } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const IMG = process.env.IMG ?? '';
const OUT = process.env.OUT ?? '/tmp';
const MINUTES = Number(process.env.MINUTES ?? 8);

const app = await _electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.click('[data-testid="tp-gate-view"]').catch(() => {});
await win.waitForSelector('[data-testid="tp-canvas-host"]', { timeout: 30_000 }).catch(() => {});
await win.waitForTimeout(1500);

// Drop the source image the same way a user would.
const b64 = readFileSync(IMG).toString('base64');
await win.evaluate(async (b64) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([arr], 'source.png', { type: 'image/png' }));
  document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}, b64);
await win.waitForTimeout(2500);

await win.click('[data-testid="tp-generate-btn"]').catch(() => {});
console.log('generate clicked');

const seen = [];
const t0 = Date.now();
for (let i = 0; i < MINUTES * 6; i++) {
  await win.waitForTimeout(10_000);
  const s = await win.evaluate(() => ({
    img: document.querySelector('[data-testid="tp-image-stage-img"]') !== null,
    canvas: document.querySelector('[data-testid="tp-canvas-host"] canvas') !== null,
    empty: document.querySelector('[data-testid="tp-empty-state"]') !== null,
    faces: /Faces\s*([\d,]+)/.exec(document.body.textContent ?? '')?.[1] ?? null,
    stage: (document.body.textContent ?? '').match(/(Sampling[^.\n]{0,40}|Baking[^.\n]{0,30}|Texturing done|Geometry done)/)?.[1] ?? '',
  }));
  const key = `${s.img}|${s.canvas}|${s.empty}|${s.faces}`;
  const at = Math.round((Date.now() - t0) / 1000);
  if (!seen.includes(key)) {
    seen.push(key);
    await win.screenshot({ path: path.join(OUT, `prog-${String(at).padStart(3, '0')}s.png`) });
    console.log(`  ${at}s  image=${s.img} canvas=${s.canvas} empty=${s.empty} faces=${s.faces} ${s.stage}`);
  }
  if (s.faces !== null && s.canvas) {
    // Keep going a little past first geometry so the textured swap is caught.
    if (seen.length > 3) break;
  }
}
await app.close();
