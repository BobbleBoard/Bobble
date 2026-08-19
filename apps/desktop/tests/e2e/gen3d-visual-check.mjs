/**
 * LOOK AT A GENERATED MODEL — the visual half of verifying the 3D engines.
 *
 * A GLB that loads and reports plausible face counts can still be garbage:
 * texture seams, wireframe artifacting, a rig whose joints sit outside the body,
 * a retopo that melted the shape. None of that is visible to a structural
 * validator, and the user's rule for this surface is to drive the real app and LOOK.
 *
 * So this drops a real artifact into the real studio viewport and screenshots it
 * in whichever render modes were asked for.
 *
 *   GLB=/path/model.glb MODES=clay,textured,wireframe OUT=/dir LABEL=trellis \
 *     node tests/e2e/gen3d-visual-check.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLB = process.env.GLB ?? '';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'gen3d-shots');
const LABEL = process.env.LABEL ?? 'model';
const MODES = (process.env.MODES ?? 'clay')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
if (GLB === '') throw new Error('set GLB=/path/to/model.glb');
mkdirSync(OUT, { recursive: true });

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'vis-'))}`],
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_TRIPO: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('[data-testid="tp-rightpanel"]', { timeout: 60_000 });
// The module gate may cover the studio on a machine without the module; View
// lifts it so the viewport is inspectable either way.
await win.click('[data-testid="tp-gate-view"]').catch(() => {});
await win.waitForSelector('[data-testid="tp-canvas-host"]', { timeout: 30_000 }).catch(() => {});
await win.waitForTimeout(1200);

// Some stages only shade the way they are meant to on their own tab — the
// segment palette is applied from the Segment tool, not the Model one.
const TAB = process.env.TAB ?? '';
if (TAB !== '') {
  await win.click(`[data-testid="tp-rail-${TAB}"]`).catch(() => {});
  await win.waitForTimeout(800);
}

const b64 = readFileSync(GLB).toString('base64');
await win.evaluate(async (b64) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const file = new File([arr], 'model.glb', { type: 'model/gltf-binary' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.dispatchEvent(
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
  );
}, b64);
// A clip with root motion travels, so WHEN a frame is grabbed changes what is
// in it. Default is late enough for a big model to finish loading; SETTLE lets
// a motion check catch the character while it is still in shot.
const SETTLE = Number(process.env.SETTLE ?? 7000);
await win.waitForTimeout(SETTLE);

const stats = await win.evaluate(() => {
  const t = document.querySelector('[data-testid="tp-topology"]')?.textContent ?? '';
  const body = document.body.textContent ?? '';
  const faces = /Faces\s*([\d,]+)/.exec(body)?.[1] ?? null;
  const verts = /Vertices\s*([\d,]+)/.exec(body)?.[1] ?? null;
  return { topology: t.slice(0, 60), faces, verts };
});
console.log(`${LABEL}: faces=${stats.faces} verts=${stats.verts}`);

for (const mode of MODES) {
  if (mode === 'wireframe') {
    await win.click('[data-testid="tp-wire-toggle"]').catch(() => {});
  } else if (mode === 'skeleton') {
    await win.click('[data-testid="tp-skeleton-btn"]').catch(() => {});
  } else {
    await win.click(`[data-testid="tp-rmode-${mode}"]`).catch(() => {});
  }
  await win.waitForTimeout(Number(process.env.MODE_SETTLE ?? 2500));
  await win.screenshot({ path: path.join(OUT, `${LABEL}-${mode}.png`) });
  console.log(`  shot: ${LABEL}-${mode}.png`);
}
await app.close();
