/**
 * A FRESH MAC'S FIRST 3D MODEL — the user (2026-09-14): "any user on any mac
 * device can use video image 3d and audio generation with an m1-m6 mac".
 *
 * Throwaway home AND throwaway cache: no ComfyUI, no weights, no engine, no
 * git, no Xcode assumed. The 3D studio's gate offers "Download 3D module";
 * the probe presses it and watches the ComfyUI module install (uv, a venv,
 * torch, the master tarball) and then the TRELLIS.2 weights land on the
 * shelf, both through the modules layer the video studio already uses. Then a
 * picture becomes a model on the ComfyUI engine, and the studio shows it.
 *
 *   SHOT_DIR=/tmp/comfy3d-fresh node apps/desktop/tests/e2e/comfy3d-fresh-probe.mjs
 *
 * Budget: the install is a torch download (minutes), the weights ~9 GB, the
 * model ~5 minutes — half an hour end to end on a fast line.
 */
import {
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

const { page, shot, check, finish, home } = await launchApp('comfy3d-fresh', {
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout, arg) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 500 });
    return true;
  } catch {
    return false;
  }
};
try {
  if (process.env.RESERVE_GB !== undefined) {
    const file = path.join(home, '.pi', 'desktop', 'settings.json');
    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, powerReserveGB: Number(process.env.RESERVE_GB) }, null, 2)}\n`,
    );
  }
  const dir = path.join(home, 'Bobble', 'generated', 'probe');
  mkdirSync(dir, { recursive: true });
  const image = path.join(dir, 'mug.png');
  copyFileSync(IMAGE, image);

  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-module-gate"]', { timeout: 30_000 });
  await sleep(800);
  const gate = await page.evaluate(() => ({
    title: document.querySelector('[data-testid="tp-gate-title"]')?.textContent ?? '',
    comfyBtn: document.querySelector('[data-testid="tp-gate-download-comfy"]')?.textContent ?? null,
    engineBtn: document.querySelector('[data-testid="tp-gate-download"]')?.textContent ?? null,
  }));
  console.log('gate:', JSON.stringify(gate));
  check(gate.title === '3D module not installed', `the gate names the module (${gate.title})`);
  check(
    gate.comfyBtn !== null && /Download 3D module \([0-9.]+ GB\)/.test(gate.comfyBtn),
    `the ComfyUI download is the primary (${gate.comfyBtn})`,
  );
  check(
    gate.engineBtn !== null && gate.engineBtn.includes('Xcode'),
    `the engine is offered as the secondary, saying what it needs (${gate.engineBtn})`,
  );
  await shot('01-gate');

  const t0 = Date.now();
  await page.click('[data-testid="tp-gate-download-comfy"]');
  // The module cards' states as they stream (runtime first, then weights).
  let lastLine = '';
  const gateGone = await (async () => {
    const deadline = Date.now() + 40 * 60_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const state = await page.evaluate(() => {
        const s = window.__gen_modules_store?.().getState();
        const mods = (s?.modules ?? []).filter(
          (m) => m.id === 'comfy' || m.id.startsWith('weights:'),
        );
        return {
          gate: document.querySelector('[data-testid="tp-module-gate"]') !== null,
          progress: document.querySelector('[data-testid="tp-gate-progress"]')?.textContent ?? '',
          mods: mods.map(
            (m) =>
              `${m.id}:${m.ready ? 'ready' : m.installing ? 'installing' : 'idle'}${m.error ? ` ERROR ${m.error}` : ''}`,
          ),
        };
      });
      const line = `${state.mods.join(' ')} | ${state.progress.slice(0, 90)}`;
      if (line !== lastLine) {
        console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
        lastLine = line;
      }
      if (state.mods.some((m) => m.includes('ERROR'))) return false;
      if (!state.gate) return true;
    }
    return false;
  })();
  const installSec = Math.round((Date.now() - t0) / 1000);
  check(gateGone, `the gate lifted after the download (${installSec}s)`);
  await sleep(1500);
  await shot('02-after-install');

  // Now the picture → model, the way the panel does it when there is no engine.
  const t1 = Date.now();
  const started = await page.evaluate(
    (imagePath) =>
      window.piDesktop.invoke('gen3d:generate', {
        kind: 'image',
        imagePaths: [imagePath],
        resolution: 'low',
        texture: true,
      }),
    image,
  );
  console.log('generate:', JSON.stringify(started));
  check(started.ok === true, `main accepted the job (${started.error ?? ''})`);
  await page.evaluate((id) => {
    window.__c3d = [];
    window.piDesktop.onEvent('gen3d:job', (u) => {
      if (u.jobId === id) window.__c3d.push({ ...u });
    });
  }, started.jobId);
  let last = null;
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const updates = await page.evaluate(() => window.__c3d ?? []);
    const latest = updates.at(-1);
    if (latest && (last === null || latest.message !== last.message)) {
      console.log(`  [${Math.round((Date.now() - t1) / 1000)}s] ${latest.stage} ${latest.message}`);
      last = latest;
    }
    if (latest?.done) break;
  }
  const genSec = Math.round((Date.now() - t1) / 1000);
  check(
    last?.done === true && last?.error === undefined,
    `the model was made (${genSec}s) ${last?.error ?? ''}`,
  );
  const glb = last?.artifact?.path;
  check(typeof glb === 'string' && existsSync(glb), `a GLB on disk (${glb})`);
  if (typeof glb === 'string' && existsSync(glb))
    console.log(`model: ${(statSync(glb).size / 1e6).toFixed(1)} MB`);
  await sleep(4000);
  const assets = await page.evaluate(
    () => (window.__tripo_store?.().getState().assets ?? []).length,
  );
  check(assets > 0, 'the model is in the studio');
  await shot('03-model');
  console.log(`TOTAL install ${installSec}s + generate ${genSec}s`);
} finally {
  await finish();
}
