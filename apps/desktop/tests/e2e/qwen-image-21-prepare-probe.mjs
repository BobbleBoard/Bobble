/**
 * QWEN-IMAGE 2.1, MADE ON THIS MAC — the first run on a Mac that has never
 * had it: the studio asks for a picture, the weights card appears saying
 * what it costs (31 GB fetched, 13 GB kept), one press fetches the bf16
 * release through the model store, `mflux-save` converts it to 4 bits on the
 * shelf, the release is removed, and the SAME job continues to a picture.
 *
 * The library is a throwaway of its own (PI_DESKTOP_MODELS_DIR), so nothing
 * on the real shelf is touched. FROM_CACHE=1 (the default when the release
 * is in ~/.cache/huggingface) hard-links the release's files into the store
 * first, so the store's own download finds them complete — it still lists
 * the repo and verifies every file by sha256, and then runs the conversion
 * exactly as it would after a real fetch. FROM_CACHE=0 downloads 31 GB.
 *
 *   SHOT_DIR=/tmp/qwen21-prepare node apps/desktop/tests/e2e/qwen-image-21-prepare-probe.mjs
 *
 * Real cache (the image module's marker), throwaway home. `npm run build` first.
 */
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const MODEL_ID = 'qwen-image-2.1';
const library = mkdtempSync(path.join(tmpdir(), 'pd-library-qwen21-'));
const entry = path.join(library, 'Image', 'Generation', 'qwen__qwen-image-2.1');
const prepared = path.join(library, 'Image', 'Generation', 'qwen-image-2.1-mflux-4bit-te8');

// The release, from the hub cache, as hard links: no second copy of 31 GB.
const snapshots = path.join(
  homedir(),
  '.cache',
  'huggingface',
  'hub',
  'models--Qwen--Qwen-Image-2.1',
  'snapshots',
);
const fromCache = (process.env.FROM_CACHE ?? (existsSync(snapshots) ? '1' : '0')) === '1';
if (fromCache) {
  const snap = path.join(snapshots, readdirSync(snapshots)[0]);
  const link = (rel) => {
    const src = path.join(snap, rel);
    const st = statSync(src);
    if (st.isDirectory()) {
      for (const name of readdirSync(src)) link(path.join(rel, name));
      return;
    }
    const dest = path.join(entry, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    linkSync(realpathSync(src), dest);
  };
  for (const rel of [
    'transformer',
    'text_encoder',
    'vae',
    'processor',
    'scheduler',
    'model_index.json',
  ])
    link(rel);
  console.log(`release hard-linked from the hub cache into ${entry}`);
}

const { app, page, shot, check, finish } = await launchApp('qwen-image-21-prepare', {
  realCache: true,
  env: { PI_DESKTOP_MODELS_DIR: library, PI_DESKTOP_GEN: '1' },
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
});
const mainLog = path.join(process.env.SHOT_DIR ?? '/tmp', 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
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
  await page.waitForFunction(() => typeof window.__modality_store === 'function', {
    timeout: 30_000,
  });
  await page.evaluate(() => window.__modality_store().getState().setView('image'));
  await page.waitForSelector('[data-testid="studio-prompt"]', { timeout: 20_000 });
  await page.waitForFunction(() => (window.__gen_store?.().getState().catalog ?? []).length > 0, {
    timeout: 20_000,
  });
  const modules = await page.evaluate(async () => {
    const s = window.__gen_modules_store?.().getState();
    await s?.refresh();
    return (window.__gen_modules_store?.().getState().modules ?? []).map((m) => ({
      id: m.id,
      ready: m.ready,
    }));
  });
  console.log('modules:', JSON.stringify(modules));
  check(
    modules.find((m) => m.id === 'image')?.ready === true,
    'the image module is ready (real cache)',
  );
  check(!existsSync(prepared), 'the throwaway library has no conversion yet');

  await page.fill(
    '[data-testid="studio-prompt"]',
    'A vintage travel poster with the words "VISIT KYOTO" in bold serif letters, a red torii gate among maple trees, flat retro print style',
  );
  await shot('01-ready');
  const t0 = Date.now();
  await page.click('[data-testid="studio-run"]');

  const cardSel = `[data-testid="module-card-weights:${MODEL_ID}"]`;
  const card = await until((sel) => document.querySelector(sel) !== null, 30_000, cardSel);
  check(card, 'the weights card appears for the model made on this Mac');
  const text = await page.evaluate(
    (sel) => document.querySelector(sel)?.textContent ?? '',
    cardSel,
  );
  console.log(`weights card: ${text.replace(/\s+/g, ' ').slice(0, 220)}`);
  check(/31 GB/.test(text), 'the card says what is fetched (31 GB)');
  check(/13 GB/.test(text) && /4-bit/.test(text), 'and what stays (a 13 GB 4-bit MLX model)');
  await shot('02-weights-card');
  await page.click(`[data-testid="module-install-weights:${MODEL_ID}"]`);

  let lastDetail = '';
  const phases = new Set();
  const gone = await (async () => {
    const deadline = Date.now() + (fromCache ? 20 : 240) * 60_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const st = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return {
          present: el !== null,
          detail: el?.querySelector('.pd-module-card-sub')?.textContent ?? '',
        };
      }, cardSel);
      if (st.detail !== lastDetail && st.detail !== '') {
        console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${st.detail.slice(0, 120)}`);
        lastDetail = st.detail;
        if (/Downloading/.test(st.detail)) phases.add('download');
        // "Converting to 4-bit…" is on screen for a second before mflux-save's
        // own progress replaces it; either reads as the conversion.
        if (/Converting|shard|Saving components/.test(st.detail)) phases.add('convert');
        if (/Removing/.test(st.detail)) phases.add('remove');
      }
      if (!st.present) return true;
    }
    return false;
  })();
  check(gone, `the conversion landed and the card left (${Math.round((Date.now() - t0) / 1000)}s)`);
  check(
    phases.has('download') && phases.has('convert'),
    `the card narrated fetch and conversion (${[...phases].join(', ')})`,
  );

  // On disk: the conversion with its manifest, the release gone.
  check(
    existsSync(path.join(prepared, 'transformer', '0.safetensors')),
    'the 4-bit transformer is on the shelf',
  );
  check(
    existsSync(path.join(prepared, 'text_encoder', '0.safetensors')),
    'the 4-bit text encoder too',
  );
  const manifest = existsSync(path.join(prepared, 'model.json'))
    ? JSON.parse(readFileSync(path.join(prepared, 'model.json'), 'utf8'))
    : null;
  check(manifest !== null, 'the conversion has a manifest for Model management');
  console.log(
    'manifest:',
    JSON.stringify({
      name: manifest?.model?.name,
      quant: manifest?.model?.quant,
      bytesGB: ((manifest?.model?.bytes ?? 0) / 1e9).toFixed(1),
      files: manifest?.model?.files?.length,
    }),
  );
  check(
    /MLX 4-bit, 8-bit encoder/.test(manifest?.model?.name ?? ''),
    'named as the 4-bit MLX conversion with its 8-bit encoder',
  );
  check(!existsSync(entry), 'the 31 GB release was removed after the conversion');

  // The same job continues to a picture.
  let done = false;
  let lastNote = '';
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const state = await page.evaluate(() => {
      const job = document.querySelector('[data-testid="studio-job"]');
      return {
        note: (job?.textContent ?? '').slice(0, 160),
        cards: document.querySelectorAll('[data-testid="media-card"]').length,
        err: document.querySelector('.pd-studio-error')?.textContent ?? '',
      };
    });
    if (state.note !== lastNote && state.note !== '') {
      console.log(
        `  [${Math.round((Date.now() - t0) / 1000)}s] ${state.note.replace(/\s+/g, ' ').slice(0, 120)}`,
      );
      lastNote = state.note;
    }
    if (state.err !== '') {
      check(false, `the generation failed: ${state.err}`);
      break;
    }
    if (state.cards > 0) {
      done = true;
      break;
    }
  }
  check(
    done,
    `the job that waited at the card finished with a picture (${Math.round((Date.now() - t0) / 1000)}s)`,
  );
  await sleep(1500);
  await shot('03-picture');
  console.log(`TOTAL ${Math.round((Date.now() - t0) / 1000)}s from Generate to picture`);
} finally {
  await finish();
  rmSync(library, { recursive: true, force: true });
}
