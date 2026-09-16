/**
 * THE 3D ENGINE ON A MAC WITH NO DEVELOPER TOOLS — the user (2026-09-15): "we do
 * need to make that work out of the box as well as rigging and motion, all
 * basic stuff needs to work out of the box".
 *
 * A fresh engine cache (GEN3D_CACHE_DIR) with only the Hugging Face weight
 * cache shared, and a PATH whose `git`, `clang`, `cc`, `c++`, `cmake`, `make`
 * and `swift` are stubs that fail like the missing tools would — so the
 * install can only succeed the way a fresh Mac's would: pinned tarballs from
 * GitHub, wheels, and the app's prebuilt Metal wheels + QuadriFlow.
 *
 * Then every basic stage on a real model, through the studio: texture from
 * a picture (the MLX texturing pipeline: mtldiffrast, flex_gemm, o_voxel —
 * the prebuilt set), segment (CubePart), retopo (QuadriFlow), rig (medial),
 * and — on a humanoid — the template rig and a motion clip (ARDY).
 *
 *   SHOT_DIR=/tmp/ootb node apps/desktop/tests/e2e/gen3d-ootb-probe.mjs
 *   MODEL_GLB=<a generated model>  IMAGE=<its picture>  STAGES=texture,segment,…
 *
 * Long: three venvs and their weights the first time (minutes to tens of
 * minutes on the line), then the stages (texturing is the long one).
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/ootb';
mkdirSync(SHOT_DIR, { recursive: true });
const MODEL_GLB = process.env.MODEL_GLB ?? '/tmp/c3d-grey/model-trellis2-grey.glb';
const IMAGE =
  process.env.IMAGE ?? path.join(homedir(), 'Bobble/generated/a-blue-mug/cand0_seed602697309.png');
const MANNEQUIN = process.env.MANNEQUIN ?? '';
const STAGES = (process.env.STAGES ?? 'texture,segment,retopo,rig,motion').split(',');
const MODELS = (process.env.MODELS ?? 'trellis2,cubepart,autoremesher,humanoid-rig,ardy-motion,mageflow')
  .split(',')
  .filter(Boolean);
if (!existsSync(MODEL_GLB)) throw new Error(`no model at ${MODEL_GLB}`);

/* NO DEVELOPER TOOLS. Stubs first on PATH: each says what the real thing
   would on a fresh Mac and fails. The sidecar inherits this PATH. */
const stubs = path.join(SHOT_DIR, 'no-dev-tools');
mkdirSync(stubs, { recursive: true });
for (const tool of [
  'git',
  'clang',
  'clang++',
  'cc',
  'c++',
  'gcc',
  'g++',
  'cmake',
  'make',
  'swift',
  'swiftc',
  'ninja',
]) {
  const file = path.join(stubs, tool);
  writeFileSync(
    file,
    `#!/bin/sh\necho "${tool}: command not found (no developer tools on this Mac)" >&2\nexit 127\n`,
  );
  chmodSync(file, 0o755);
}

const home = probeHome('gen3d-ootb');
const cache = path.join(home, '.cache', 'bobble', 'gen3d');
mkdirSync(cache, { recursive: true });
// The weights are the one thing shared: 20+ GB already on this Mac.
const realHf = path.join(homedir(), '.cache', 'bobble', 'gen3d', 'hf');
if (existsSync(realHf)) symlinkSync(realHf, path.join(cache, 'hf'));

const { app, page, shot, check, finish } = await launchApp('gen3d-ootb', {
  realCache: true,
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
  env: {
    HOME: home,
    GEN3D_CACHE_DIR: cache,
    PI_E2E_NO_SERVER: '1',
    PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}`,
  },
});
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `[${Math.round((Date.now() - t0) / 1000)}s]`;

try {
  if (process.env.RESERVE_GB !== undefined) {
    const file = path.join(home, '.pi', 'desktop', 'settings.json');
    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, powerReserveGB: Number(process.env.RESERVE_GB) }, null, 2)}\n`,
    );
  }
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-viewport"], [data-testid="tp-module-gate"]', {
    timeout: 30_000,
  });
  // A fresh cache: nothing installed, the gate up.
  let catalog = null;
  for (let i = 0; i < 90 && catalog === null; i += 1) {
    catalog = await page.evaluate(() => window.piDesktop.invoke('gen3d:catalog', undefined));
    if (catalog?.engineBooting) {
      catalog = null;
      await sleep(2000);
    }
  }
  check(
    catalog !== null && catalog.engineReady === true,
    `the sidecar booted (${JSON.stringify(catalog && { engineReady: catalog.engineReady, booting: catalog.engineBooting })})`,
  );
  const installedBefore = (catalog?.models ?? []).filter((m) => m.installed).map((m) => m.id);
  console.log(`${at()} installed before: ${installedBefore.join(', ') || 'nothing'}`);
  check(!installedBefore.includes('trellis2'), 'the fresh cache has no engine yet');
  await shot('00-fresh-gate');

  // Download = provision every env + verify the weights (shared) — with no git,
  // no compiler, no metal on PATH.
  await page.evaluate(() => {
    window.__dl = [];
    window.piDesktop.onEvent('gen3d:download', (u) => window.__dl.push({ ...u, at: Date.now() }));
  });
  const started = await page.evaluate(
    (ids) => window.piDesktop.invoke('gen3d:download', { ids }),
    MODELS,
  );
  console.log(`${at()} download: ${JSON.stringify(started)}`);
  check(started.ok === true, 'the downloads started');
  const deadline = Date.now() + 60 * 60_000;
  const doneIds = new Set();
  const errors = new Map();
  let lastLine = '';
  while (Date.now() < deadline && doneIds.size + errors.size < MODELS.length) {
    await sleep(4000);
    const events = await page.evaluate(() => window.__dl ?? []);
    for (const e of events) {
      if (e.done && !doneIds.has(e.id) && !errors.has(e.id)) {
        if (e.error) errors.set(e.id, e.error);
        else doneIds.add(e.id);
        console.log(`${at()} ${e.id}: ${e.error ? `FAILED — ${e.error}` : 'installed'}`);
      }
    }
    const tail =
      readFileSync(mainLog, 'utf8')
        .split('\n')
        .filter((l) => l.includes('sidecar'))
        .at(-1) ?? '';
    if (tail !== lastLine) {
      lastLine = tail;
      console.log(`${at()} ${tail.replace(/^.*sidecar /, '').slice(0, 140)}`);
    }
  }
  for (const id of MODELS) {
    check(
      doneIds.has(id),
      `${id} installed without developer tools (${errors.get(id) ?? 'timed out'})`,
    );
  }
  // The main log must show no developer tool was reached for.
  const log = readFileSync(mainLog, 'utf8');
  check(!/command not found \(no developer tools/.test(log), 'no stubbed tool was invoked');
  // What is on disk: tarball trees with their pins, the prebuilt wheels, QuadriFlow.
  const pins = ['trellis2-apple', 'cube', 'ardy'].map((t) => [
    t,
    existsSync(path.join(cache, 'src', t, '.bobble-pin')),
  ]);
  console.log(`${at()} pins: ${JSON.stringify(pins)}`);
  check(
    pins.every(([, ok]) => ok),
    'tool trees came from pinned archives',
  );
  check(
    existsSync(path.join(cache, 'bin', 'quadriflow')),
    'QuadriFlow was installed from the prebuilt tree',
  );
  check(
    existsSync(
      path.join(
        cache,
        'src',
        'trellis2-apple',
        '.venv',
        'lib',
        'python3.12',
        'site-packages',
        'mtldiffrast',
      ),
    ) &&
      existsSync(
        path.join(
          cache,
          'src',
          'trellis2-apple',
          '.venv',
          'lib',
          'python3.12',
          'site-packages',
          'o_voxel',
        ),
      ),
    'the MLX tree carries the prebuilt Metal wheels',
  );
  catalog = await page.evaluate(() => window.piDesktop.invoke('gen3d:catalog', undefined));
  console.log(
    `${at()} installed after: ${(catalog?.models ?? [])
      .filter((m) => m.installed)
      .map((m) => m.id)
      .join(', ')}`,
  );
  await shot('01-installed');

  // ── the stages, through the studio ────────────────────────────────────────
  const dir = path.join(home, 'Bobble', 'generated', 'probe');
  mkdirSync(dir, { recursive: true });
  const model = path.join(dir, 'model.glb');
  copyFileSync(MODEL_GLB, model);
  const image = path.join(dir, 'reference.png');
  if (existsSync(IMAGE)) copyFileSync(IMAGE, image);

  // Leave the gate if it is still up (View), then import the model.
  await page.click('[data-testid="tp-gate-view"]').catch(() => {});
  await page.waitForSelector('[data-testid="tp-upload-card-input"]', {
    state: 'attached',
    timeout: 30_000,
  });
  await page.setInputFiles('[data-testid="tp-upload-card-input"]', model);
  await page.waitForFunction(
    () => document.querySelectorAll('.tp-asset-card').length > 0,
    undefined,
    { timeout: 60_000 },
  );
  await sleep(2500);
  await shot('02-imported');

  const runStage = async (op, extra, label, which = 'current') => {
    const origin = await page.evaluate((which) => {
      const s = window.__tripo_store().getState();
      const asset = s.assets.find((a) => a.id === s.loadedAssetId);
      const v = which === 'source' ? asset?.versions?.[0] : asset?.versions?.at(-1);
      return asset && v ? { assetId: asset.id, versionId: v.id, diskPath: v.diskPath } : null;
    }, which);
    check(origin !== null && origin.diskPath, `${op}: a loaded version on disk to act on`);
    if (origin === null || !origin.diskPath) return null;
    await page.evaluate(() => {
      window.__jobs = [];
      window.piDesktop.onEvent('gen3d:job', (u) => window.__jobs.push({ ...u, at: Date.now() }));
    });
    const t1 = Date.now();
    const started = await page.evaluate(
      ({ op, diskPath, origin, extra }) =>
        window
          .__gen3d_store()
          .getState()
          .runStage(
            op,
            diskPath,
            { assetId: origin.assetId, versionId: origin.versionId, op },
            extra,
          ),
      { op, diskPath: origin.diskPath, origin, extra },
    );
    if (started !== null) {
      check(false, `${label}: refused — ${started}`);
      return null;
    }
    let last = null;
    while (Date.now() - t1 < 40 * 60_000) {
      await sleep(3000);
      const jobs = await page.evaluate(() => window.__jobs ?? []);
      const latest = jobs.at(-1);
      if (latest && (last === null || latest.message !== last.message)) {
        console.log(
          `  ${at()} ${label}: ${latest.stage} ${latest.message} ${Math.round((latest.overallPercent ?? 0) * 100)}%`,
        );
        last = latest;
      }
      if (latest?.done) break;
    }
    const secs = Math.round((Date.now() - t1) / 1000);
    check(last?.done === true, `${label} finished (${secs}s)`);
    check(last?.error === undefined, `${label} without error (${last?.error ?? ''})`);
    const art = (await page.evaluate(() => window.__jobs ?? []))
      .map((j) => j.artifact)
      .filter(Boolean)
      .at(-1);
    console.log(`  ${at()} ${label}: ${secs}s → ${art?.path ?? 'no artifact'}`);
    await sleep(3000);
    return art?.path ?? null;
  };

  if (STAGES.includes('texture') && existsSync(image)) {
    await page.click('[data-testid="tp-rail-texture"]').catch(() => {});
    const out = await runStage(
      'texture',
      { imagePath: image, resolution: 'low', textureSize: 1024, finish: 'pbr' },
      'texture from image',
    );
    if (out) {
      await page.click('[data-testid="tp-rmode-textured"]').catch(() => {});
      await sleep(2500);
      await shot('03-textured');
      copyFileSync(out, path.join(SHOT_DIR, 'textured.glb'));
    }
  }
  if (STAGES.includes('segment')) {
    await page.click('[data-testid="tp-rail-segment"]').catch(() => {});
    const out = await runStage('segment', undefined, 'segment (CubePart)');
    if (out) {
      await sleep(2500);
      await shot('04-segmented');
    }
  }
  if (STAGES.includes('retopo')) {
    // The source version is the clean remesh input.
    await page.click('[data-testid="tp-rail-retopo"]').catch(() => {});
    const out = await runStage(
      'retopo',
      { targetQuads: 20000, method: 'quads' },
      'retopo (QuadriFlow)',
      'source',
    );
    if (out) {
      await sleep(2500);
      await shot('05-retopo');
    }
  }
  if (STAGES.includes('rig')) {
    await page.click('[data-testid="tp-rail-animate"]').catch(() => {});
    const out = await runStage(
      'rig',
      { humanoid: false, rigger: 'medial' },
      'rig (medial axis)',
      'source',
    );
    if (out) {
      await page
        .evaluate(() => window.__tripo_store().getState().set('showSkeleton', true))
        .catch(() => {});
      await sleep(2500);
      await shot('06-rigged');
    }
  }
  if (STAGES.includes('motion') && MANNEQUIN && existsSync(MANNEQUIN)) {
    const man = path.join(dir, 'mannequin.glb');
    copyFileSync(MANNEQUIN, man);
    await page.setInputFiles('[data-testid="tp-upload-card-input"]', man);
    await sleep(3000);
    const rigged = await runStage(
      'rig',
      { humanoid: true, rigger: 'template' },
      'rig (template, humanoid)',
    );
    if (rigged) {
      const clip = await runStage(
        'motion',
        { prompt: 'a person waves hello', seconds: 3, inPlace: true },
        'motion (ARDY)',
      );
      if (clip) {
        await sleep(2500);
        await shot('07-motion');
        copyFileSync(clip, path.join(SHOT_DIR, 'motion.glb'));
      }
    }
  }
  console.log(`${at()} TOTAL`);
} finally {
  await finish();
}
