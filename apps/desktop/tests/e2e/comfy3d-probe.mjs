/**
 * IMAGE → 3D ON COMFYUI, THROUGH THE APP — the user (2026-09-14): "ok we'll work on
 * getting 3d and video out of the box".
 *
 * Real cache (ComfyUI installed, the Comfy-Org TRELLIS.2 weights on the 3D
 * shelf), throwaway home, headless. Opens the 3D studio, hands it a picture,
 * asks main for a model on the `comfy` engine (what a Mac with no Bobble 3D
 * engine gets by default), and watches the job the way the panels do:
 * gen3d:job updates → a model-glb artifact → an asset in the viewport.
 *
 *   SHOT_DIR=/tmp/comfy3d node apps/desktop/tests/e2e/comfy3d-probe.mjs
 *
 * The run itself is the measured ~5 minutes at 512³ (comfy-workflow.ts).
 *
 * FINISH=grey|color|pbr (default pbr) asks for that finish — the user (2026-09-15):
 * "add a setting for Grey/Color/PBR" — and the GLB's own material list is read
 * back to prove what was written: grey has no textures, colour a base colour
 * and nothing else, PBR the metal/roughness, normal and occlusion maps too.
 * MODEL=pixal3d runs ComfyUI's Pixal3D graph instead of TRELLIS.2.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const IMAGE =
  process.env.COMFY3D_IMAGE ??
  path.join(process.env.HOME ?? '', 'Bobble/generated/a-blue-mug/cand0_seed602697309.png');
if (!existsSync(IMAGE)) {
  console.error(`comfy3d-probe: no input image at ${IMAGE} (set COMFY3D_IMAGE)`);
  process.exit(1);
}

const { app, page, shot, check, finish, home } = await launchApp('comfy3d', {
  realCache: true,
  args: ['--', '--piE2E=1'],
  /*
   * NO CHAT MODEL. The app boots the library's model on launch, and a 9B at
   * 64k context is 12.6 GB — MEASURED landing on top of the 3D job here: the
   * guardian shed the run at 13% free with the machine swapping, then held it
   * behind the server it had just let in. A 3D job needs no chat model, so
   * the probe says so rather than racing it.
   */
  env: { PI_E2E_NO_SERVER: '1' },
});
// The main process's own log (the guardian, the room keeper, the queue) — it
// goes to stderr, and the verdicts live nowhere else.
const mainLog = path.join(process.env.SHOT_DIR ?? '/tmp', 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which PBR maps a GLB's materials reference — from its JSON chunk, no loader. */
function glbMaterialMaps(file) {
  const buf = readFileSync(file);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  const mats = json.materials ?? [];
  const has = (pick) => mats.some((m) => pick(m) !== undefined);
  return {
    textures: (json.textures ?? []).length,
    baseColor: has((m) => m.pbrMetallicRoughness?.baseColorTexture),
    metallicRoughness: has((m) => m.pbrMetallicRoughness?.metallicRoughnessTexture),
    normal: has((m) => m.normalTexture),
    occlusion: has((m) => m.occlusionTexture),
  };
}

try {
  // The picture must be somewhere the app can read: its own home is fenced in.
  const dir = path.join(home, 'Bobble', 'generated', 'probe');
  mkdirSync(dir, { recursive: true });
  const image = path.join(dir, 'mug.png');
  copyFileSync(IMAGE, image);

  /*
   * The probe's OWN memory reserve (never the shared settings). The default
   * on a 24 GB Mac is 6 GB, and `RESERVE_GB` lets a run measure a job's real
   * footprint with the guardian's line moved — the number that then goes in
   * the catalog is what puts the default back within reach.
   */
  if (process.env.RESERVE_GB !== undefined) {
    const file = path.join(home, '.pi', 'desktop', 'settings.json');
    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, powerReserveGB: Number(process.env.RESERVE_GB) }, null, 2)}\n`,
    );
  }

  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-viewport"]', { timeout: 20_000 });
  await sleep(1500);
  // What main says about the two paths.
  const catalog = await page.evaluate(() => window.piDesktop.invoke('gen3d:catalog', undefined));
  console.log(
    'catalog:',
    JSON.stringify({ engineReady: catalog.engineReady, comfy: catalog.comfy }),
  );
  check(catalog.comfy?.ready === true, 'the ComfyUI 3D path reports ready (runtime + weights)');
  await shot('01-studio');

  // Ask for the model on the ComfyUI engine and watch the job stream.
  const t0 = Date.now();
  const FINISH = process.env.FINISH ?? 'pbr';
  const MODEL = process.env.MODEL ?? 'trellis2';
  const started = await page.evaluate(
    ({ imagePath, finish, model }) =>
      window.piDesktop.invoke('gen3d:generate', {
        kind: 'image',
        imagePaths: [imagePath],
        resolution: 'low',
        texture: finish !== 'grey',
        finish,
        model,
        engine: 'comfy',
      }),
    { imagePath: image, finish: FINISH, model: MODEL },
  );
  console.log('generate:', JSON.stringify(started));
  check(started.ok === true && typeof started.jobId === 'string', 'main accepted the job');
  const jobId = started.jobId;

  // Collect updates in the page (the same event the panels watch), and the
  // guardian's verdicts — a held job says why here and nowhere else.
  await page.evaluate((id) => {
    window.__c3d = [];
    window.__guard = [];
    window.piDesktop.onEvent('gen3d:job', (u) => {
      if (u.jobId === id) window.__c3d.push({ ...u, at: Date.now() });
    });
    window.piDesktop.onEvent('gen:guardian', (g) => window.__guard.push(g));
  }, jobId);

  let last = null;
  let done = false;
  const deadline = Date.now() + 15 * 60_000;
  let guardSeen = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const guard = await page.evaluate(() => window.__guard ?? []);
    for (const g of guard.slice(guardSeen)) console.log(`  guardian: ${g.verdict} — ${g.reason}`);
    guardSeen = guard.length;
    const updates = await page.evaluate(() => window.__c3d ?? []);
    const latest = updates.at(-1);
    if (latest && (last === null || latest.message !== last.message)) {
      console.log(
        `  [${Math.round((Date.now() - t0) / 1000)}s] ${latest.stage} ${latest.message} ` +
          `${Math.round(latest.overallPercent * 100)}%`,
      );
      last = latest;
    }
    if (latest?.done) {
      done = true;
      break;
    }
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check(done, `the job finished (${elapsed}s)`);
  check(last?.error === undefined, `no error (${last?.error ?? ''})`);
  const glb = last?.artifact?.path;
  check(typeof glb === 'string' && glb.endsWith('.glb'), `a model-glb artifact (${glb})`);
  if (typeof glb === 'string' && existsSync(glb)) {
    const mb = statSync(glb).size / 1e6;
    console.log(`model: ${glb} (${mb.toFixed(1)} MB)`);
    // The material the file actually carries, read from its JSON chunk.
    const maps = glbMaterialMaps(glb);
    console.log(`material maps: ${JSON.stringify(maps)}`);
    if (FINISH === 'grey') {
      check(maps.textures === 0, 'grey: the GLB carries no textures at all');
    } else if (FINISH === 'color') {
      check(maps.baseColor, 'colour: a base colour texture');
      check(
        !maps.metallicRoughness && !maps.normal && !maps.occlusion,
        'colour: no metal/roughness, normal or occlusion maps',
      );
    } else {
      check(mb > 1, 'the GLB has textures in it (> 1 MB)');
      check(
        maps.baseColor && maps.metallicRoughness && maps.normal && maps.occlusion,
        'PBR: base colour, metal/roughness, normal and occlusion maps',
      );
    }
    // The home goes at finish(); the model is the evidence, so it comes out.
    copyFileSync(glb, path.join(process.env.SHOT_DIR ?? '/tmp', `model-${MODEL}-${FINISH}.glb`));
  }
  // The studio took it: an asset in the tree, the viewport showing it.
  await sleep(4000);
  const assets = await page.evaluate(() => {
    const s = window.__tripo_store?.().getState();
    return (s?.assets ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind }));
  });
  console.log('assets:', JSON.stringify(assets));
  check(assets.length > 0, 'the model registered as an asset in the studio');
  await shot('02-model-in-viewport');
  console.log(`TOTAL ${elapsed}s through the app`);
} finally {
  await finish();
}
