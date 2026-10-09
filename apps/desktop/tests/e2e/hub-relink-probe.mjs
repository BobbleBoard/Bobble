/**
 * A 3D CACHE THAT LOST ITS LINKS GETS THEM BACK AT BOOT — through the real app.
 *
 * The user's Mac since 2026-09-20: `~/.cache/bobble/gen3d` was recreated empty,
 * while the library still holds every 3D weight, including 35 GB of Mage-Flow
 * from the withdrawn `microsoft/*` repos that nobody can download again. The
 * engine reads its weights only through `gen3d/hf/hub/models--Org--Name`
 * links, so it saw none of them. storage/hub-relink.ts puts the links back
 * from runLibraryMigration; this proves the boot path does it.
 *
 * A scratch world only: a scratch support root (PI_DESKTOP_CACHE_DIR) and a
 * scratch library (PI_DESKTOP_MODELS_DIR), with PI_DESKTOP_MIGRATE_LIBRARY=1
 * lifting the probe guard exactly as storage-probe does. Weights are a few
 * bytes. No model server (PI_E2E_NO_SERVER), no window, no focus taken.
 *
 *   node scripts/with-lock.mjs probe -- node tests/e2e/hub-relink-probe.mjs
 *
 * Fails on a build without hub-relink (no link appears).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const world = mkdtempSync(path.join(tmpdir(), 'hub-relink-probe-'));
const cache = path.join(world, 'cache');
const library = path.join(world, 'Models');
const hub = path.join(cache, 'gen3d', 'hf', 'hub');
// The engine's cache as the user's is now: there, and empty.
mkdirSync(path.join(cache, 'gen3d', 'hf'), { recursive: true });

/** A repo on a shelf the way the migration leaves it: blobs, refs/main, a snapshot linking in. */
const shelve = (shelf, folder, files) => {
  const dir = path.join(library, ...shelf.split('/'), folder);
  const rev = 'f'.repeat(40);
  mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  mkdirSync(path.join(dir, 'refs'), { recursive: true });
  writeFileSync(path.join(dir, 'refs', 'main'), rev);
  for (const [rel, blob, body] of files) {
    writeFileSync(path.join(dir, 'blobs', blob), body);
    const at = path.join(dir, 'snapshots', rev, rel);
    mkdirSync(path.dirname(at), { recursive: true });
    symlinkSync(path.relative(path.dirname(at), path.join(dir, 'blobs', blob)), at);
  }
  return { dir, rev };
};
const turbo = shelve('Image/Generation', 'microsoft__mage-flow-turbo', [
  [
    'model_index.json',
    '7bff2b06ec6b2d24dd9f9a2c5ef979bb906835',
    '{"_class_name":"MageFlowPipeline"}',
  ],
  [
    'transformer/diffusion_pytorch_model.safetensors',
    '6df47df3d7efc9ebdad075b87b3e9e4f74d09dca672d592271788f0ee27ab97d',
    'w',
  ],
]);
const encoder = shelve('Support', 'qwen__qwen3-vl-4b-instruct', [['config.json', '1c1c', '{}']]);
// The model store's own copy of Comfy-Org/Mage-Flow: plain files, which no hub cache reads.
mkdirSync(path.join(library, 'Image', 'Generation', 'comfy-org__mage-flow', 'vae'), {
  recursive: true,
});
writeFileSync(
  path.join(library, 'Image', 'Generation', 'comfy-org__mage-flow', 'model.json'),
  '{}',
);

const { page, check, finish, shot } = await launchApp('hub-relink', {
  env: {
    PI_DESKTOP_CACHE_DIR: cache,
    PI_DESKTOP_MODELS_DIR: library,
    PI_DESKTOP_MIGRATE_LIBRARY: '1',
    PI_E2E_NO_SERVER: '1',
  },
});
await page.waitForTimeout(500);

const linkOk = (repo, shelfDir, rev, file) => {
  const at = path.join(hub, `models--${repo.replace('/', '--')}`);
  let st = null;
  try {
    st = lstatSync(at);
  } catch {
    /* absent */
  }
  if (!check(st?.isSymbolicLink() === true, `no hub link for ${repo} at ${at}`)) return;
  const target = readlinkSync(at);
  check(!path.isAbsolute(target), `${repo}: the link is absolute (${target}), not relative`);
  check(
    realpathSync(at) === realpathSync(shelfDir),
    `${repo}: the link resolves to ${realpathSync(at)}, not the shelf ${shelfDir}`,
  );
  // What the engine reads: refs/main, then a snapshot file through the blob link.
  check(
    readFileSync(path.join(at, 'refs', 'main'), 'utf8') === rev,
    `${repo}: refs/main unreadable`,
  );
  check(existsSync(path.join(at, 'snapshots', rev, file)), `${repo}: ${file} not reachable`);
  console.log(`  ${repo} → ${target}`);
};
linkOk(
  'microsoft/Mage-Flow-Turbo',
  turbo.dir,
  turbo.rev,
  'transformer/diffusion_pytorch_model.safetensors',
);
linkOk('Qwen/Qwen3-VL-4B-Instruct', encoder.dir, encoder.rev, 'config.json');
check(
  !existsSync(path.join(hub, 'models--Comfy-Org--Mage-Flow')),
  'the model store’s plain Comfy-Org/Mage-Flow folder was linked into the 3D hub cache',
);
// Nothing on the shelves moved or changed.
check(existsSync(path.join(turbo.dir, 'blobs')), 'the shelved Mage-Flow copy moved');
await shot('booted');

const ok = await finish();
// Retries: an engine bootstrap the app began at boot (uv's Python, into the
// scratch support root) can still be letting go of its folder as the app exits.
if (ok) rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
