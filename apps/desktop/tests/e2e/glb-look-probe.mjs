/**
 * LOOK AT A GLB IN THE STUDIO'S OWN VIEWPORT — the three render modes, framed.
 *
 *   GLB=/path/to/model.glb SHOT_DIR=/tmp/look node apps/desktop/tests/e2e/glb-look-probe.mjs
 *
 * the user (2026-09-14): "this cup shows a lot of artifacting" — the judgement is
 * made on what the studio renders, so this is what the report shows.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const GLB = process.env.GLB ?? '';
if (!existsSync(GLB)) {
  console.error('glb-look-probe: GLB=<path> is required');
  process.exit(1);
}
const { page, shot, check, finish, home } = await launchApp('glb-look', {
  realCache: true,
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  // The GLB must sit inside the pd-file fence: copy it under the probe's home.
  const dir = path.join(home, 'Bobble', 'generated', 'look');
  mkdirSync(dir, { recursive: true });
  const local = path.join(dir, path.basename(GLB));
  copyFileSync(GLB, local);
  // Hand it to the studio the way a chat card does ("Open in studio").
  await page.evaluate(
    ({ p, name }) =>
      window.__studio_handoff?.().getState().offer('3d', { path: p, name, kind: 'model' }),
    { p: local, name: path.basename(GLB) },
  );
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-viewport"]', { timeout: 20_000 });
  await sleep(1500);
  const view = await page.$('[data-testid="tp-gate-view"]');
  if (view) await view.click();
  await sleep(6000);
  const assets = await page.evaluate(
    () => (window.__tripo_store?.().getState().assets ?? []).length,
  );
  check(assets > 0, 'the model registered');
  // Zoom out a little so the whole thing is in frame.
  const box = await page.$eval('[data-testid="tp-viewport"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, 700);
  await sleep(600);
  for (const mode of ['textured', 'clay', 'normal']) {
    await page.click(`[data-testid="tp-rmode-${mode}"]`);
    await sleep(900);
    const el = await page.$('[data-testid="tp-viewport"]');
    await el.screenshot({ path: `${process.env.SHOT_DIR ?? '/tmp'}/${mode}.png` });
  }
  await shot('studio');
} finally {
  await finish();
}
