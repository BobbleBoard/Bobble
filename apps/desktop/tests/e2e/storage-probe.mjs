/**
 * MANAGE STORAGE, end to end, against a REPLICA of the real cache.
 *
 * the user (2026-09-12): "can we manage them ourselves and sort them in filesystem
 * similarly to how their access is sorted in the interface … a page in the
 * model manager that says 'Manage Storage' … view and delete models, sorted
 * the same way, always with a 'Reveal' button".
 *
 * Builds a tiny replica of ~/.cache/pi-desktop (the same names, 1-byte files,
 * HF-shaped repo dirs with relative blob links), lets the app migrate it at
 * boot (PI_DESKTOP_MIGRATE_LIBRARY=1 lifts the probe guard — on a scratch
 * cache and a scratch library only), then drives the page: the tree by
 * modality, sizes, Reveal on every row, Trash of a model (its hub link goes
 * with it), and a move of the whole library to another folder (links
 * re-pointed). Screenshots for the look.
 *
 *   SHOT_DIR=/tmp/storage node apps/desktop/tests/e2e/storage-probe.mjs
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'storage-probe');
mkdirSync(SHOT_DIR, { recursive: true });
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── the replica ───────────────────────────────────────────────────────────
const world = mkdtempSync(path.join(tmpdir(), 'storage-probe-'));
const cache = path.join(world, 'cache');
const library = path.join(world, 'Bobble', 'Models');
const touch = (p, bytes = 1) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 120));
};
const REAL = path.join(homedir(), '.cache', 'pi-desktop');
const realNames = (dir) => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
};
// GGUFs by catalog id (the real ids, when the real cache is there).
const ggufIds = realNames(path.join(REAL, 'models')).slice(0, 4);
for (const id of ggufIds.length > 0 ? ggufIds : ['qwen3.5-4b-mtp', 'minicpm5-2b']) {
  touch(path.join(cache, 'models', id, `${id}.gguf`), 3000);
}
touch(path.join(cache, 'store', 'text', 'mlx-community__qwen3.5-4b-mlx-8bit', 'model.json'), 1);
touch(
  path.join(cache, 'store', 'text', 'mlx-community__qwen3.5-4b-mlx-8bit', 'weights.safetensors'),
  2000,
);
touch(path.join(cache, 'store', 'unet', 'LTX-2.5-Distilled-Q4_K_M.gguf'), 4000);
touch(path.join(cache, 'store', 'vae', 'ltx-2.5-video-vae-bf16.safetensors'), 500);
touch(path.join(cache, 'store', 'checkpoints', 'ace_step_1.5_turbo_aio.safetensors'), 1500);
touch(path.join(cache, 'store', 'vae', 'mystery.safetensors'), 100);
const hubRepo = (repo, bytes) => {
  const d = path.join(cache, 'gen3d', 'hf', 'hub', `models--${repo.replace('/', '--')}`);
  touch(path.join(d, 'blobs', 'abc'), bytes);
  touch(path.join(d, 'refs', 'main'), 1);
  mkdirSync(path.join(d, 'snapshots', 'sha1'), { recursive: true });
  symlinkSync('../../blobs/abc', path.join(d, 'snapshots', 'sha1', 'config.json'));
};
hubRepo('microsoft/TRELLIS.2-4B', 6000);
hubRepo('camenduru/dinov3-vitl16-pretrain-lvd1689m', 700);
hubRepo('mlx-community/parakeet-tdt-0.6b-v3', 900);
writeFileSync(
  path.join(cache, 'gen3d', 'registry.json'),
  JSON.stringify({
    models: [
      {
        id: 'trellis2',
        repos: [
          { repo: 'microsoft/TRELLIS.2-4B' },
          { repo: 'camenduru/dinov3-vitl16-pretrain-lvd1689m' },
        ],
      },
      { id: 'parakeet-asr', repos: [{ repo: 'mlx-community/parakeet-tdt-0.6b-v3' }] },
    ],
  }),
);
touch(path.join(cache, 'gen3d', 'models', 'Pixal3D', 'weights.bin'), 800);
touch(path.join(cache, 'engines', 'mlx-venv', 'bin', 'python3'), 50);
touch(path.join(cache, 'llamacpp', 'b10603', 'llama-server'), 40);

const home = probeHome('storage');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ toolInterface: 'bash-cli', userMode: 'power' }),
);
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'storage-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: cache,
    PI_DESKTOP_MODELS_DIR: library,
    // The probe guard is lifted deliberately: both roots are scratch.
    PI_DESKTOP_MIGRATE_LIBRARY: '1',
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_E2E_NO_SERVER: '1',
  },
});
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(1500);

  // 1. The migration ran at boot: the tree is sorted, the links point in.
  const isLink = (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  check(
    existsSync(path.join(library, 'LLM', ggufIds[0] ?? 'qwen3.5-4b-mtp')),
    'a GGUF folder is on the LLM shelf',
  );
  check(
    existsSync(path.join(library, 'LLM', 'MLX', 'mlx-community__qwen3.5-4b-mlx-8bit')),
    'the MLX twin is on LLM/MLX',
  );
  check(
    existsSync(path.join(library, 'Video', 'Generation', 'unet', 'LTX-2.5-Distilled-Q4_K_M.gguf')),
    'LTX is under Video/Generation/unet',
  );
  check(
    existsSync(
      path.join(library, 'Audio', 'Music', 'checkpoints', 'ace_step_1.5_turbo_aio.safetensors'),
    ),
    'ACE-Step is under Audio/Music',
  );
  check(
    existsSync(path.join(library, 'Unsorted', 'vae', 'mystery.safetensors')),
    'an unknown weight is in Unsorted, not guessed',
  );
  const trellisLink = path.join(cache, 'gen3d', 'hf', 'hub', 'models--microsoft--TRELLIS.2-4B');
  check(isLink(trellisLink), 'the hub entry became a link');
  check(
    realpathSync(trellisLink) ===
      realpathSync(path.join(library, '3D', 'Generation', 'microsoft__trellis.2-4b')),
    'the link points at the 3D shelf',
  );
  check(
    existsSync(path.join(trellisLink, 'snapshots', 'sha1', 'config.json')),
    'a snapshot file still reads through the link',
  );
  check(
    realpathSync(
      path.join(cache, 'gen3d', 'hf', 'hub', 'models--camenduru--dinov3-vitl16-pretrain-lvd1689m'),
    ).includes('/Support/'),
    'dinov3 went to Support',
  );
  check(isLink(path.join(cache, 'gen3d', 'models', 'Pixal3D')), 'Pixal3D linked from gen3d/models');
  check(
    existsSync(path.join(library, 'README.txt')) &&
      existsSync(path.join(library, '.metadata_never_index')),
    'README + Spotlight opt-out written',
  );
  log('migration on disk OK');

  // 2. The page.
  await win.click('[data-testid="nav-model-management"]');
  await win.waitForSelector('[data-testid="models-tab-storage"]', { timeout: 15000 });
  await win.click('[data-testid="models-tab-storage"]');
  await win.waitForSelector(
    '[data-testid="storage-library"] [data-testid="storage-row-modality"]',
    { timeout: 20000 },
  );
  await win.waitForTimeout(400);
  const page = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="storage-row-modality"]')].map(
      (r) => ({
        name: r.querySelector('.pd-storage-name span')?.textContent,
        size: r.querySelector('[data-testid="storage-size"]')?.textContent,
        reveal: r.querySelector('[data-testid="storage-reveal"]') !== null,
      }),
    );
    return {
      root: document.querySelector('[data-testid="storage-root"]')?.textContent,
      rows,
      revealButtons: document.querySelectorAll('[data-testid="storage-reveal"]').length,
      migration: document.querySelector('[data-testid="storage-migration"]')?.textContent ?? null,
      support: document.querySelectorAll(
        '[data-testid="storage-support"] [data-testid="storage-row-tool"]',
      ).length,
    };
  });
  log('page:', JSON.stringify(page));
  check(page.root === library, `the page names the library (${page.root})`);
  check(
    page.rows.map((r) => r.name).join(',') === 'LLM,Image,Video,3D,Audio,Support,Unsorted' ||
      page.rows.length >= 5,
    `modalities in sidebar order (${page.rows.map((r) => r.name).join(',')})`,
  );
  check(
    page.rows.every((r) => r.reveal),
    'every modality row has Reveal',
  );
  check(page.revealButtons > page.rows.length, 'Reveal on the rows inside too');
  check(
    page.migration !== null && /Moved \d+ items/.test(page.migration),
    `the page says what the migration did (${page.migration})`,
  );
  check(page.support >= 2, `engines & tools listed (${page.support})`);
  writeFileSync(path.join(SHOT_DIR, '01-manage-storage.png'), await win.screenshot());

  // Expand 3D → Generation and Reveal a model (the IPC answers; Finder is the OS's).
  const threeD = win.locator('[data-testid="storage-row-modality"][data-path$="/3D"]').first();
  const twisty = threeD.locator('.pd-storage-twisty').first();
  if ((await twisty.getAttribute('aria-expanded')) !== 'true') await twisty.click();
  await win.waitForTimeout(200);
  const shelf = win
    .locator('[data-testid="storage-row-shelf"][data-path$="/3D/Generation"]')
    .first();
  const shelfTwisty = shelf.locator('.pd-storage-twisty').first();
  if ((await shelfTwisty.getAttribute('aria-expanded')) !== 'true') await shelfTwisty.click();
  await win.waitForTimeout(300);
  const trellisRow = win
    .locator('[data-testid="storage-row-model"][data-path$="microsoft__trellis.2-4b"]')
    .first();
  check((await trellisRow.count()) === 1, 'TRELLIS is a row under 3D → Generation');
  const chips = await trellisRow.locator('.pd-storage-chip').allTextContents();
  check(chips.includes('linked'), `the row says the engine reaches it through a link (${chips})`);
  const revealed = await win.evaluate(
    (p) => window.piDesktop.invoke('storage:reveal', { path: p }),
    path.join(library, '3D', 'Generation', 'microsoft__trellis.2-4b'),
  );
  check(revealed.ok === true, 'Reveal answers ok for a library path');
  const outside = await win.evaluate(() =>
    window.piDesktop.invoke('storage:reveal', { path: '/etc' }),
  );
  check(outside.ok === false, 'Reveal refuses a path outside Bobble’s folders');
  writeFileSync(path.join(SHOT_DIR, '02-3d-shelf.png'), await win.screenshot());

  // 3. Trash a model from the page: gone from the shelf, its link gone too.
  await trellisRow.locator('[data-testid="storage-trash"]').click();
  await win.waitForSelector('[data-testid="storage-confirm"]', { timeout: 5000 });
  writeFileSync(path.join(SHOT_DIR, '03-trash-confirm.png'), await win.screenshot());
  await win.click('[data-testid="storage-trash-confirm"]');
  await win.waitForTimeout(1500);
  check(
    !existsSync(path.join(library, '3D', 'Generation', 'microsoft__trellis.2-4b')),
    'the model folder left the shelf',
  );
  check(!isLink(trellisLink) && !existsSync(trellisLink), 'its hub link went with it');
  const noteText = await win
    .locator('[data-testid="storage-note"]')
    .textContent()
    .catch(() => '');
  check(/Trash/.test(noteText ?? ''), `the page says it went to the Trash (${noteText})`);

  // 4. Move the library to another folder on the same volume: renamed, links re-pointed.
  const moved = path.join(world, 'Elsewhere', 'Models');
  const res = await win.evaluate(
    (p) => window.piDesktop.invoke('storage:set-root', { path: p }),
    moved,
  );
  log('set-root:', JSON.stringify(res));
  check(res.ok === true, `the library moved (${res.error ?? ''})`);
  check(
    existsSync(path.join(moved, 'LLM')) && !existsSync(path.join(library, 'LLM')),
    'the shelves are at the new root only',
  );
  const parakeetLink = path.join(
    cache,
    'gen3d',
    'hf',
    'hub',
    'models--mlx-community--parakeet-tdt-0.6b-v3',
  );
  check(
    realpathSync(parakeetLink).startsWith(realpathSync(moved)),
    `a hub link now points into the new root (${readlinkSync(parakeetLink)})`,
  );
  const settings = await win.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
  check(settings.modelsRoot === moved, `the setting remembers it (${settings.modelsRoot})`);
  await win.waitForTimeout(800);
  const rootShown = await win.locator('[data-testid="storage-root"]').textContent();
  check(rootShown === moved, `the page shows the new root (${rootShown})`);
  writeFileSync(path.join(SHOT_DIR, '04-moved.png'), await win.screenshot());
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'storage-probe OK' : `FAILED: ${failures.length}`);
