/**
 * LOOK at what Manage Storage's card says about the 3D engine's hub repos —
 * the one surface SPK-02's Mage-Flow source change can reach.
 *
 * Mage-Flow's weights now come from Comfy-Org/Mage-Flow and
 * Qwen/Qwen3-VL-4B-Instruct (catalog.ts, mage-flow-release.ts), and the Qwen
 * repo is also CubePart's prompt encoder. The card used to name the FIRST model
 * listing a repo, which would tell a CubePart user their encoder is "Mage-Flow
 * Turbo"; a repo several models share now says so instead (repoAttribution).
 *
 * Seeds a throwaway library + cache — four shelved repos, each with the hub
 * link the app leaves behind when it shelves a download — and opens each one's
 * card, in dark and in light. Nothing real is read or written.
 *
 *   SHOT_DIR=/tmp/x node apps/desktop/tests/e2e/storage-shared-repo-look.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const seed = mkdtempSync(path.join(tmpdir(), 'pd-storage-shared-'));
const lib = path.join(seed, 'Models');
const cache = path.join(seed, 'cache');
const hub = path.join(cache, 'gen3d', 'hf', 'hub');
mkdirSync(hub, { recursive: true });

/** A shelved hub repo: the folder the migration leaves plus its link back. */
const REPOS = [
  // Shared by both Mage-Flow models and CubePart.
  { repo: 'Qwen/Qwen3-VL-4B-Instruct', shelf: 'Support', folder: 'qwen__qwen3-vl-4b-instruct' },
  // Shared by the two Mage-Flow models (new with this change).
  { repo: 'Comfy-Org/Mage-Flow', shelf: 'Image/Generation', folder: 'comfy-org__mage-flow' },
  // The old copy an existing install keeps (legacyRepos): still "Mage-Flow Edit".
  {
    repo: 'microsoft/Mage-Flow-Edit-Turbo',
    shelf: 'Image/Editing',
    folder: 'microsoft__mage-flow-edit-turbo',
  },
  // A control used by exactly one model: must read as before.
  { repo: 'ZhengPeng7/BiRefNet', shelf: 'Support', folder: 'zhengpeng7__birefnet' },
];
for (const r of REPOS) {
  const dir = path.join(lib, ...r.shelf.split('/'), r.folder);
  const snap = path.join(dir, 'snapshots', 'a'.repeat(40));
  mkdirSync(snap, { recursive: true });
  mkdirSync(path.join(dir, 'refs'), { recursive: true });
  writeFileSync(path.join(dir, 'refs', 'main'), 'a'.repeat(40));
  writeFileSync(path.join(snap, 'config.json'), '{}\n');
  symlinkSync(dir, path.join(hub, `models--${r.repo.replace('/', '--')}`));
}

const {
  page: win,
  finish,
  shotDir,
} = await launchApp('storage-shared-repo-look', {
  waitFor: '[data-testid="composer-input"]',
  env: { PI_DESKTOP_CACHE_DIR: cache, PI_DESKTOP_MODELS_DIR: lib },
});
const shot = async (name) =>
  writeFileSync(path.join(shotDir, `${name}.png`), await win.screenshot());

async function openCard(folder) {
  const row = win.locator(`[data-testid="storage-row-model"][data-path$="/${folder}"]`).first();
  await row.locator('[data-testid="storage-name"]').click();
  await win.waitForSelector('[data-testid="storage-inspector"]', { timeout: 5000 });
  await win.waitForTimeout(600); // the avatar fetch
  return win.evaluate(() => ({
    name: document.querySelector('[data-testid="inspector-name"]')?.textContent ?? null,
    blurb: document.querySelector('[data-testid="inspector-blurb"]')?.textContent ?? null,
    chips: [...document.querySelectorAll('[data-testid="inspector-chips"] .pd-storage-chip')].map(
      (c) => c.textContent?.trim(),
    ),
  }));
}

const results = {};
try {
  await win.waitForTimeout(1500);
  await win.click('[data-testid="nav-model-management"]');
  await win.waitForSelector('[data-testid="models-tab-storage"]', { timeout: 15000 });
  await win.click('[data-testid="models-tab-storage"]');
  await win.waitForSelector(
    '[data-testid="storage-library"] [data-testid="storage-row-modality"]',
    {
      timeout: 60000,
    },
  );
  // Open every folder of the library, one at a time: a click re-renders the
  // tree, so handles taken up front go stale.
  const closed = win.locator('[data-testid="storage-library"] button[aria-label^="Expand "]');
  for (let i = 0; i < 20 && (await closed.count()) > 0; i++) {
    await closed.first().click();
    await win.waitForTimeout(150);
  }
  await win.waitForTimeout(300);
  await shot('00-open');

  for (const [i, r] of REPOS.entries()) {
    results[r.repo] = await openCard(r.folder);
    await shot(`${String(i + 1).padStart(2, '0')}-dark-${r.folder}`);
  }
  await win.evaluate(() => {
    document.documentElement.setAttribute('data-flavor', 'bobble');
    document.documentElement.setAttribute('data-mode', 'light');
  });
  await win.waitForTimeout(600);
  for (const [i, r] of REPOS.entries()) {
    const light = await openCard(r.folder);
    if (JSON.stringify(light) !== JSON.stringify(results[r.repo])) {
      throw new Error(`${r.repo}: the light card differs: ${JSON.stringify(light)}`);
    }
    await shot(`${String(i + 1).padStart(2, '0')}-light-${r.folder}`);
  }
  console.log(JSON.stringify(results, null, 2));
  console.log('shots in', shotDir);

  // What each card must say. A repo several models share names none of them.
  const expect = (cond, msg) => {
    if (!cond) throw new Error(`storage-shared-repo-look: ${msg}`);
  };
  const qwen = results['Qwen/Qwen3-VL-4B-Instruct'];
  expect(qwen.name === 'Qwen/Qwen3-VL-4B-Instruct', `the Qwen card is titled "${qwen.name}"`);
  expect(
    qwen.blurb === 'Shared by Mage-Flow Turbo, Mage-Flow Edit and CubePart.',
    `the Qwen card says "${qwen.blurb}"`,
  );
  const comfy = results['Comfy-Org/Mage-Flow'];
  expect(
    comfy.blurb === 'Shared by Mage-Flow Turbo and Mage-Flow Edit.',
    `the Comfy-Org card says "${comfy.blurb}"`,
  );
  for (const [repo, card] of Object.entries(results)) {
    expect(new Set(card.chips).size === card.chips.length, `${repo} repeats a chip: ${card.chips}`);
  }
  expect(
    results['microsoft/Mage-Flow-Edit-Turbo'].name === 'Mage-Flow Edit',
    'legacy copy renamed',
  );
  expect(results['ZhengPeng7/BiRefNet'].name === 'TRELLIS-2 (4B)', 'single-use repo renamed');
  console.log('storage-shared-repo-look: every card says what it should');
} finally {
  await finish();
  rmSync(seed, { recursive: true, force: true });
}
