/**
 * THE HISTORY RAIL, WITH TWO STAGES ON IT — a model handed to the studio, then
 * retopologised through the real engine (QuadriFlow, seconds), so the rail
 * has "Imported model" and "Low-Poly Generation": the second is the working
 * version (blue), pointing at the first previews it in the viewport (the
 * face count flips to the import's), clicking it makes it current again.
 *
 *   GLB=… SHOT_DIR=… node apps/desktop/tests/e2e/history-rail-probe.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const GLB = process.env.GLB ?? '';
if (!existsSync(GLB)) {
  console.error('history-rail-probe: GLB=<path> is required');
  process.exit(1);
}
const { page, shot, check, finish, home } = await launchApp('history-rail', {
  realCache: true,
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout, arg) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 400 });
    return true;
  } catch {
    return false;
  }
};
try {
  const dir = path.join(home, 'Bobble', 'generated', 'look');
  mkdirSync(dir, { recursive: true });
  const local = path.join(dir, 'mug.glb');
  copyFileSync(GLB, local);
  await page.evaluate(
    ({ p, name }) =>
      window.__studio_handoff?.().getState().offer('3d', { path: p, name, kind: 'model' }),
    { p: local, name: 'mug.glb' },
  );
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-viewport"]', { timeout: 20_000 });
  const view = await page.$('[data-testid="tp-gate-view"]');
  if (view) await view.click();
  await sleep(5000);
  // The engine must be up for a stage (the catalog boots it).
  const engine = await until(
    () => window.__gen3d_store?.().getState().engineReady === true,
    90_000,
  );
  check(engine, 'the Bobble 3D engine is up');
  const before = await page.evaluate(() => {
    const s = window.__tripo_store?.().getState();
    const a = s?.assets.find((x) => x.id === s.loadedAssetId);
    return {
      versions: a?.versions.length ?? 0,
      faces: s?.stats?.faces ?? 0,
      assetId: a?.id,
      versionId: a?.currentVersionId,
      path: a?.versions[0]?.diskPath,
    };
  });
  console.log('before:', JSON.stringify(before));
  check(before.versions === 1, 'one stage on the rail to begin with');
  // Retopologise through the engine, as a node on this asset.
  const started = await page.evaluate(
    (b) =>
      window.__gen3d_store?.().getState().runStage('retopo', b.path, {
        assetId: b.assetId,
        versionId: b.versionId,
        op: 'retopo',
      }),
    before,
  );
  console.log('retopo:', JSON.stringify(started));
  const twoStages = await until(() => {
    const s = window.__tripo_store?.().getState();
    const a = s?.assets.find((x) => x.id === s.loadedAssetId);
    return (a?.versions.length ?? 0) >= 2 && a?.currentVersionId !== a?.versions[0]?.id;
  }, 8 * 60_000);
  check(twoStages, 'the retopo landed as a second stage and became the working version');
  await sleep(2500);
  const rail = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tp-history-"]')]
      .filter((el) => el.matches('.tp-history-node'))
      .map((el) => ({ label: el.textContent, current: el.dataset.current, id: el.dataset.testid })),
  );
  console.log('rail:', JSON.stringify(rail));
  check(rail.length === 2, 'two nodes on the rail');
  check(
    rail[1]?.current === 'true' && /Low-Poly/.test(rail[1]?.label ?? ''),
    'the low-poly stage is current',
  );
  const facesLow = await page.evaluate(() => window.__tripo_store?.().getState().stats?.faces ?? 0);
  await shot('01-rail-two-stages');
  // Hover the first: the viewport previews the import (its face count comes back).
  await page.hover(`[data-testid="${rail[0].id}"]`);
  const previewed = await until(
    (n) => (window.__tripo_store?.().getState().stats?.faces ?? 0) === n,
    15_000,
    before.faces,
  );
  const facesHover = await page.evaluate(
    () => window.__tripo_store?.().getState().stats?.faces ?? 0,
  );
  console.log(
    `faces: low-poly ${facesLow}, hovering the import ${facesHover} (import had ${before.faces})`,
  );
  check(previewed, 'hovering the first stage previews it in the viewport');
  await shot('02-rail-hover-preview');
  // Click it: it is the working version again (the next op would branch).
  await page.click(`[data-testid="${rail[0].id}"]`);
  await sleep(800);
  const cur = await page.evaluate(() => {
    const s = window.__tripo_store?.().getState();
    const a = s?.assets.find((x) => x.id === s.loadedAssetId);
    return { current: a?.currentVersionId === a?.versions[0]?.id, preview: s?.previewVersionId };
  });
  check(
    cur.current && cur.preview === null,
    'clicking it goes back: the import is the working version',
  );
  await shot('03-rail-went-back');
} finally {
  await finish();
}
