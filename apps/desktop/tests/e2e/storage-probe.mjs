/**
 * MANAGE STORAGE, end to end, against a REPLICA of the real cache.
 *
 * the user (2026-09-12): "can we manage them ourselves and sort them in filesystem
 * similarly to how their access is sorted in the interface … a page in the
 * model manager that says 'Manage Storage' … view and delete models, sorted
 * the same way, always with a 'Reveal' button".
 *
 * Builds a tiny replica of ~/.cache/bobble (the same names, 1-byte files,
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
const REAL = path.join(homedir(), '.cache', 'bobble');
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

  // 2. The page: tree collapsed by default, no blurbs, Reveal + Delete on every
  //    row, the summary card on the right, the modalities in sidebar order.
  await win.click('[data-testid="nav-model-management"]');
  await win.waitForSelector('[data-testid="models-tab-storage"]', { timeout: 15000 });
  await win.click('[data-testid="models-tab-storage"]');
  await win.waitForSelector(
    '[data-testid="storage-library"] [data-testid="storage-row-modality"]',
    {
      timeout: 20000,
    },
  );
  await win.waitForTimeout(400);
  const page = await win.evaluate(() => {
    const rows = [
      ...document.querySelectorAll(
        '[data-testid="storage-library"] > .pd-storage-node > .pd-storage-row',
      ),
    ].map((r) => ({
      name: r.querySelector('.pd-storage-name-text')?.textContent,
      size: r.querySelector('[data-testid="storage-size"]')?.textContent,
      tone: r.querySelector('[data-testid="storage-size"]')?.getAttribute('data-tone'),
      reveal: r.querySelector('[data-testid="storage-reveal"]') !== null,
      del: r.querySelector('[data-testid="storage-delete"]') !== null,
      expanded: r.querySelector('.pd-storage-twisty')?.getAttribute('aria-expanded'),
    }));
    const reveal = document.querySelector('[data-testid="storage-reveal"]');
    const cs = reveal ? getComputedStyle(reveal) : null;
    return {
      root: document.querySelector('[data-testid="storage-root"]')?.textContent,
      rows,
      blurbs: document.querySelectorAll('.pd-storage-note-line').length,
      summary: document
        .querySelector('[data-testid="storage-summary"]')
        ?.textContent?.slice(0, 120),
      revealRadius: cs?.borderRadius,
      revealBg: cs?.backgroundColor,
      revealFg: cs?.color,
      noTopLabel: !/YOUR MODELS LIVE IN/i.test(document.body.textContent ?? ''),
      layout: (() => {
        const tree = document.querySelector('.pd-storage-tree')?.getBoundingClientRect();
        const side = document.querySelector('.pd-storage-side')?.getBoundingClientRect();
        return tree && side
          ? {
              treeLeft: Math.round(tree.left),
              treeRight: Math.round(tree.right),
              sideLeft: Math.round(side.left),
              sideWidth: Math.round(side.width),
            }
          : null;
      })(),
    };
  });
  log('page:', JSON.stringify(page));
  check(page.root === library, `the summary card names the library (${page.root})`);
  const names = page.rows.map((r) => r.name);
  check(
    names.includes('LLM') && names.includes('Video') && names.includes('Engines & tools'),
    `modalities + tools as top rows (${names.join(',')})`,
  );
  check(
    page.rows.every((r) => r.expanded === 'false'),
    'every folder is collapsed by default',
  );
  check(
    page.rows.every((r) => r.reveal),
    'every row has Reveal',
  );
  check(
    page.rows.filter((r) => r.name !== 'Engines & tools').every((r) => r.del),
    'every library row has Delete',
  );
  check(page.blurbs === 0, 'no blurbs under the names');
  check(page.noTopLabel, 'the "your models live in" label is gone');
  check(
    page.revealRadius !== undefined &&
      !/999|9999/.test(page.revealRadius) &&
      page.revealRadius !== '0px',
    `Reveal is a rounded rectangle, not a pill (${page.revealRadius})`,
  );
  check(
    page.layout !== null &&
      page.layout.sideLeft > page.layout.treeRight &&
      page.layout.sideWidth >= 260,
    `the tree sits left with the card on the right (${JSON.stringify(page.layout)})`,
  );
  writeFileSync(path.join(SHOT_DIR, '01-manage-storage.png'), await win.screenshot());

  // Sizes are coloured by size, sort flips, search finds a nested model.
  const smallTone = page.rows.find((r) => r.name === 'Support')?.tone;
  check(smallTone === 'green', `a sub-GB folder reads green (${smallTone})`);
  await win.click('[data-testid="storage-sort-name"]');
  await win.waitForTimeout(150);
  const byName = await win.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="storage-library"] > .pd-storage-node > .pd-storage-row .pd-storage-name-text',
      ),
    ].map((n) => n.textContent),
  );
  check(
    byName.join(',') === [...byName].sort((a, b) => a.localeCompare(b)).join(','),
    `sort by name orders A→Z (${byName.join(',')})`,
  );
  await win.click('[data-testid="storage-sort-size"]');
  await win.fill('[data-testid="storage-search"]', 'trellis');
  await win.waitForTimeout(250);
  const found = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="storage-row-model"]')].map(
      (r) => r.querySelector('.pd-storage-name-text')?.textContent,
    ),
  );
  check(
    found.length === 1 && /TRELLIS/i.test(found[0] ?? ''),
    `search opens the folders down to the match (${found.join(',')})`,
  );
  writeFileSync(path.join(SHOT_DIR, '02-search.png'), await win.screenshot());
  await win.fill('[data-testid="storage-search"]', '');
  await win.waitForTimeout(150);

  // 3. Click a model → the card on the right shows it; its Reveal answers.
  await win.click('[data-testid="storage-row-modality"][data-path$="/3D"] .pd-storage-twisty');
  await win.click(
    '[data-testid="storage-row-shelf"][data-path$="/3D/Generation"] .pd-storage-twisty',
  );
  await win.waitForTimeout(200);
  const trellisRow = win
    .locator('[data-testid="storage-row-model"][data-path$="microsoft__trellis.2-4b"]')
    .first();
  check((await trellisRow.count()) === 1, 'TRELLIS is a row under 3D → Generation');
  await trellisRow.locator('[data-testid="storage-name"]').click();
  await win.waitForSelector('[data-testid="storage-inspector"]', { timeout: 3000 });
  const insp = await win.evaluate(() => ({
    name: document.querySelector('.pd-storage-card-name')?.textContent,
    meta: document.querySelector('.pd-storage-card-meta')?.textContent,
    size: document.querySelector('.pd-storage-card-size')?.textContent,
    buttons: [...document.querySelectorAll('.pd-storage-card-actions button')].map((b) =>
      b.textContent?.trim(),
    ),
  }));
  log('inspector:', JSON.stringify(insp));
  check(
    insp.name === 'microsoft/TRELLIS.2-4B',
    `the card names the repo as its org spells it (${insp.name})`,
  );
  check(
    /4B/.test(insp.meta ?? '') && /microsoft/.test(insp.meta ?? ''),
    `parameters and org on the card (${insp.meta})`,
  );
  check(
    insp.buttons?.join(',') === 'Delete,Reveal,Export',
    `Delete · Reveal · Export on the card (${insp.buttons})`,
  );
  const revealed = await win.evaluate(
    (p) => window.piDesktop.invoke('storage:reveal', { path: p }),
    path.join(library, '3D', 'Generation', 'microsoft__trellis.2-4b'),
  );
  check(revealed.ok === true, 'Reveal answers ok for a library path');
  const outside = await win.evaluate(() =>
    window.piDesktop.invoke('storage:reveal', { path: '/etc' }),
  );
  check(outside.ok === false, 'Reveal refuses a path outside Bobble’s folders');
  writeFileSync(path.join(SHOT_DIR, '03-inspector.png'), await win.screenshot());

  // 4. Delete from the row: a dialog, not raw text; "don't show again" sticks.
  await trellisRow.locator('[data-testid="storage-delete"]').click();
  await win.waitForSelector('[data-testid="delete-model-dialog"]', { timeout: 5000 });
  await win.waitForTimeout(350); // the dialog fades in
  const dlg = await win.evaluate(
    () => document.querySelector('[data-testid="delete-model-dialog"]')?.textContent ?? '',
  );
  check(
    /Delete microsoft\/TRELLIS\.2-4B\?/.test(dlg) && /Don.t show again/.test(dlg),
    `the dialog names the model and offers don't-show-again (${dlg.slice(0, 80)})`,
  );
  writeFileSync(path.join(SHOT_DIR, '04-delete-dialog.png'), await win.screenshot());
  await win.click('[data-testid="delete-model-dontask"]');
  await win.click('[data-testid="delete-model-confirm"]');
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
  const setting = await win.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
  check(setting.hideDeleteModelConfirm === true, 'don’t-show-again is remembered');

  // 5. Select mode: tick a whole folder and a model, Delete (n) in the toolbar;
  //    with the confirmation off it goes straight to the Trash.
  await win.click('[data-testid="storage-select-mode"]');
  await win.waitForTimeout(150);
  await win.click('[data-testid="storage-row-modality"][data-path$="/Audio"] .pd-storage-twisty');
  await win.waitForTimeout(150);
  await win
    .locator(
      '[data-testid="storage-row-modality"][data-path$="/Audio"] [data-testid="storage-select"]',
    )
    .click();
  await win
    .locator(
      '[data-testid="storage-row-modality"][data-path$="/Unsorted"] [data-testid="storage-select"]',
    )
    .click();
  await win.waitForTimeout(150);
  const sel = await win.evaluate(() => ({
    del: document.querySelector('[data-testid="storage-delete-selected"]')?.textContent?.trim(),
    exp: document.querySelector('[data-testid="storage-export-selected"]')?.textContent?.trim(),
    bar: document.querySelector('[data-testid="storage-selection-bar"]')?.textContent,
    inherited: [
      ...document.querySelectorAll(
        '[data-testid="storage-row-shelf"][data-path*="/Audio/"] [data-testid="storage-select"]',
      ),
    ].map((c) => `${c.getAttribute('data-state')}:${c.hasAttribute('disabled')}`),
  }));
  log('selection:', JSON.stringify(sel));
  check(
    sel.del === 'Delete (2)' && sel.exp === 'Export (2)',
    `the toolbar counts the selection (${sel.del} / ${sel.exp})`,
  );
  check(
    sel.inherited.length > 0 && sel.inherited.every((s) => s === 'checked:true'),
    `rows inside a selected folder show ticked and inert (${sel.inherited})`,
  );
  writeFileSync(path.join(SHOT_DIR, '05-select-mode.png'), await win.screenshot());
  await win.click('[data-testid="storage-delete-selected"]');
  await win.waitForTimeout(1500);
  check(
    !existsSync(path.join(library, 'Audio')) && !existsSync(path.join(library, 'Unsorted')),
    'both selected folders went to the Trash without a dialog',
  );
  const parakeetLink0 = path.join(
    cache,
    'gen3d',
    'hf',
    'hub',
    'models--mlx-community--parakeet-tdt-0.6b-v3',
  );
  check(
    !existsSync(parakeetLink0) && !isLink(parakeetLink0),
    'a link into the deleted folder went too',
  );
  await win.click('[data-testid="storage-select-done"]');

  // 6. Move the library to another folder on the same volume: renamed, links re-pointed.
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
  const dinoLink = path.join(
    cache,
    'gen3d',
    'hf',
    'hub',
    'models--camenduru--dinov3-vitl16-pretrain-lvd1689m',
  );
  check(
    realpathSync(dinoLink).startsWith(realpathSync(moved)),
    `a hub link now points into the new root (${readlinkSync(dinoLink)})`,
  );
  const settings = await win.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
  check(settings.modelsRoot === moved, `the setting remembers it (${settings.modelsRoot})`);
  await win.waitForTimeout(800);
  const rootShown = await win.locator('[data-testid="storage-root"]').textContent();
  check(rootShown === moved, `the page shows the new root (${rootShown})`);
  writeFileSync(path.join(SHOT_DIR, '06-moved.png'), await win.screenshot());

  // 7. Export a model to a folder (the picker is native; the handler is driven
  //    with a destination through the same copy path).
  const exportDest = path.join(world, 'Exported');
  mkdirSync(exportDest, { recursive: true });
  const exp = await win.evaluate(
    ({ p, d }) => window.piDesktop.invoke('storage:export', { paths: [p], dest: d }),
    { p: path.join(moved, 'LLM', 'MLX', 'mlx-community__qwen3.5-4b-mlx-8bit'), d: exportDest },
  );
  log('export:', JSON.stringify(exp));
  check(
    exp.ok === true &&
      existsSync(
        path.join(exportDest, 'mlx-community__qwen3.5-4b-mlx-8bit', 'weights.safetensors'),
      ),
    'export copied the model folder',
  );
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'storage-probe OK' : `FAILED: ${failures.length}`);
