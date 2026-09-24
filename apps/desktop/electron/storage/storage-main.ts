/**
 * THE LIBRARY AT BOOT, AND MANAGE STORAGE'S MAIN-SIDE HALF.
 *
 * Boot: put the library root on the environment (every engine child inherits
 * it), move whatever is still in `~/.cache` onto the shelves (library-migration
 * — renames, engine views kept), and keep Spotlight out of the library the
 * way it is kept out of the cache.
 *
 * Page: a tree with sizes for the library and the support root, Reveal in
 * Finder, Trash (never rm), and a move of the whole library to another folder
 * or volume.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GEN3D_MODEL_SPECS } from '@pi-desktop/gen3d-engine';
import { cacheRoot, getCatalogModel, legacyCacheRoot, libraryRoot } from '@pi-desktop/inference';
import {
  defaultLibraryRoot,
  MODALITY_FOLDERS,
  repoFromHubEntry,
  shelfOf,
} from '@pi-desktop/model-store';
import { createLogger, registerIpcHandlers } from '@pi-desktop/shared';
import { dialog, type IpcMain, shell } from 'electron';
import { getLoadedModel } from '../inference/llm-main';
import { readSettings, writeSettingsPatch } from '../settings/settings-main';
import {
  applyLibraryMigration,
  type MigrationResult,
  planLibraryMigration,
  snapshotLegacy,
} from './library-migration';
import type {
  StorageEventMap,
  StorageInvokeMap,
  StorageMoveProgress,
  StorageNode,
  StorageOverview,
} from './storage-contract';
import { featureStorageRoots, featureStorageRows, supportNoteFor } from './storage-rows';

const log = createLogger('desktop:storage');

/** What the last migration did, for the page. */
let lastMigration: (MigrationResult & { ranAt: string; unsorted: readonly string[] }) | null = null;

/**
 * `~/.cache/pi-desktop` → `~/.cache/bobble`, once, with a symlink left at the
 * old name.
 *
 * the user (2026-09-13): "purge any 'pi desktop' branding totally". The support
 * root's name was the last place it showed — on the Manage Storage page, in
 * every engine's path. A rename is instant on the same volume; the symlink is
 * what keeps every venv under it working, since a venv bakes its absolute
 * path into each script it installs (`#!/Users/…/.cache/pi-desktop/engines/
 * mlx-venv/bin/python3`) and into pyvenv.cfg. Through the link those paths
 * still resolve; nothing is reinstalled. The hub-cache links into the library
 * are relative, so they move with the folder unchanged.
 *
 * Skipped when the support root is overridden (a probe, a test), when the new
 * name already exists, or when the old one is not a real directory.
 */
export function renameSupportRoot(): void {
  if (process.env.PI_DESKTOP_CACHE_DIR !== undefined && process.env.PI_DESKTOP_CACHE_DIR !== '') {
    return;
  }
  const next = cacheRoot();
  const old = legacyCacheRoot();
  if (existsSync(next)) return;
  let oldIsDir = false;
  try {
    oldIsDir = lstatSync(old).isDirectory();
  } catch {
    oldIsDir = false;
  }
  if (!oldIsDir) return;
  try {
    renameSync(old, next);
    symlinkSync(path.basename(next), old);
    log.info('support root renamed', { from: old, to: next, link: 'left at the old name' });
  } catch (err) {
    log.error('could not rename the support root; the old name stays', { error: String(err) });
  }
}

/**
 * The library root, from the setting, onto the environment — BEFORE any child
 * process is spawned, since they inherit it. A root already on the
 * environment (a probe pointing at the real library from a throwaway HOME)
 * wins over the setting.
 */
export function applyLibraryEnv(): void {
  if (process.env.PI_DESKTOP_MODELS_DIR !== undefined && process.env.PI_DESKTOP_MODELS_DIR !== '') {
    return;
  }
  const chosen = readSettings().modelsRoot;
  process.env.PI_DESKTOP_MODELS_DIR = chosen ?? defaultLibraryRoot();
}

/**
 * Move the models out of the cache and onto the shelves. Idempotent and fast
 * (renames), so it runs at every boot and adopts anything an engine dropped
 * into a legacy spot since.
 *
 * NEVER under a probe: a probe keeps the REAL cache dir with a throwaway HOME,
 * and "the library" would then be a temp folder — the migration would carry
 * 400 GB of the user's weights into /var/folders. Two guards, both required
 * to be off: PI_E2E (unless the probe explicitly opts in), and a library root
 * anywhere under the system temp dir.
 */
export function runLibraryMigration(opts: { readonly skipRepos?: readonly string[] } = {}): void {
  const lib = libraryRoot();
  // The explicit opt-in is for a probe whose cache AND library are both
  // scratch (tests/e2e/storage-probe.mjs); it lifts both guards.
  if (process.env.PI_DESKTOP_MIGRATE_LIBRARY !== '1') {
    if (process.env.PI_E2E === '1') {
      log.info('library migration skipped under PI_E2E', { lib });
      return;
    }
    let tmp = tmpdir();
    try {
      tmp = realpathSync(tmp);
    } catch {
      /* keep the unresolved spelling */
    }
    const libReal = ((): string => {
      try {
        return realpathSync(lib);
      } catch {
        return lib;
      }
    })();
    if (libReal.startsWith(tmp) || lib.startsWith(tmpdir())) {
      log.warn('library migration refused: the library root is under the temp dir', { lib });
      return;
    }
  }
  const cache = cacheRoot();
  const snapAll = snapshotLegacy(cache, lib);
  // A repo still being downloaded is left alone: the worker writing it holds
  // its paths, and the moment between the rename and the link is a moment it
  // could miss.
  const skip = new Set(opts.skipRepos ?? []);
  const snap =
    skip.size === 0
      ? snapAll
      : {
          ...snapAll,
          hubEntries: snapAll.hubEntries.filter((e) => {
            const repo = e.startsWith('models--')
              ? e.slice('models--'.length).replace(/--/g, '/')
              : e;
            return !skip.has(repo);
          }),
        };
  const plan = planLibraryMigration(snap);
  if (plan.moves.length === 0) return;
  const result = applyLibraryMigration(plan);
  lastMigration = { ...result, ranAt: new Date().toISOString(), unsorted: plan.unsorted };
  log.info('library migration', {
    moved: result.moved.length,
    skipped: result.skipped.length,
    unsorted: plan.unsorted.length,
  });
  for (const m of result.moved) log.info('moved', { from: m.from, to: m.to });
  for (const s of result.skipped)
    if (s.why !== 'gone') log.warn('not moved', { from: s.move.from, why: s.why });
  // A record beside the models, so a person opening the folder can tell what
  // happened without the app.
  try {
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      path.join(lib, 'README.txt'),
      [
        'Bobble keeps its models here, sorted the way the app is:',
        '',
        '  LLM/                   chat models (GGUF), LLM/MLX their MLX twins',
        '  Image/  Video/  3D/  Audio/   generation models by what they make',
        '  Support/               models other models need (encoders, embedders)',
        '  Unsorted/              weights Bobble could not place, kept as they were',
        '',
        'A folder named org__name is a Hugging Face repo; the engines reach it through a',
        'link in ~/.cache/bobble, so move or delete these from Bobble (Model management',
        '→ Manage Storage) rather than by hand, or the link is left dangling.',
        '',
        `Last migration: ${lastMigration.ranAt} — ${result.moved.length} moved, ${result.skipped.length} left as they were.`,
        '',
      ].join('\n'),
    );
    // Spotlight: 400 GB of weights is not something anyone searches for.
    writeFileSync(path.join(lib, '.metadata_never_index'), '');
  } catch (err) {
    log.warn('could not write the library README', { error: String(err) });
  }
}

/** Free / total bytes on the volume that holds the library. */
export async function diskSpace(): Promise<{ free: number; total: number; root: string }> {
  const root = libraryRoot();
  try {
    const { statfs } = await import('node:fs/promises');
    const s = await statfs(existsSync(root) ? root : path.dirname(root));
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize, root };
  } catch {
    return { free: 0, total: 0, root };
  }
}

/** Kept back so a download never fills the disk to the last byte. */
export const DISK_MARGIN_BYTES = 2 * 1024 ** 3;

/**
 * "Not enough space" before a byte moves, or null when it fits. the user
 * (2026-09-13): "don't allow / warn of disk space issues when downloading a
 * model that there isn't enough space for." The margin is what the OS and the
 * next generation need to keep breathing.
 */
export async function spaceRefusal(bytes: number | undefined): Promise<string | null> {
  if (bytes === undefined || bytes <= 0) return null;
  const { free, total } = await diskSpace();
  if (total === 0) return null;
  if (free - bytes < DISK_MARGIN_BYTES) {
    const gb = (n: number) => `${(n / 1e9).toFixed(n >= 10e9 ? 0 : 1)} GB`;
    return `Not enough space: this needs ${gb(bytes)} and the disk has ${gb(free)} free (Bobble keeps ${gb(DISK_MARGIN_BYTES)} back). Delete something in Model management → Manage Storage first.`;
  }
  return null;
}

// ── the tree ────────────────────────────────────────────────────────────────

/** Bytes under `dir`, files only, symlinks not followed (they are the engines' view, not weight). */
async function sizeOf(p: string): Promise<{ bytes: number; files: number; mtime: number }> {
  let bytes = 0;
  let files = 0;
  let mtime = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) return;
        if (e.isDirectory()) {
          await walk(full);
          return;
        }
        if (e.isFile()) {
          try {
            // Read `bytes` AFTER the await: `bytes += (await stat()).size`
            // reads the old total before the await, and with stats running
            // concurrently every other file's size was lost (MEASURED: a
            // 16 GB repo summed to 0).
            const s = await stat(full);
            bytes += s.size;
            files += 1;
            if (s.mtimeMs > mtime) mtime = s.mtimeMs;
          } catch {
            /* vanished mid-walk */
          }
        }
      }),
    );
  };
  try {
    const s = lstatSync(p);
    if (s.isSymbolicLink()) return { bytes: 0, files: 0, mtime: 0 };
    if (s.isFile()) return { bytes: s.size, files: 1, mtime: s.mtimeMs };
  } catch {
    return { bytes: 0, files: 0, mtime: 0 };
  }
  await walk(p);
  return { bytes, files, mtime };
}

/** The store's manifest beside a repo's files, when there is one — the fields the card shows. */
async function readManifestLite(
  dir: string,
): Promise<{ name?: string; notes?: string; tasks?: readonly string[] } | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, 'model.json'), 'utf8')) as {
      name?: unknown;
      notes?: unknown;
      tasks?: unknown;
    };
    return {
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
      ...(Array.isArray(raw.tasks)
        ? { tasks: raw.tasks.filter((t): t is string => typeof t === 'string') }
        : {}),
    };
  } catch {
    return null;
  }
}

/** "4B" out of "Qwen3.5 4B (MTP)" or "Meta-Llama-3-8B-Instruct"; nothing when there is none. */
function paramsIn(text: string): string | undefined {
  const m = text.match(/(\d+(?:\.\d+)?)\s?[bB](?![a-z])/);
  return m === null ? undefined : `${m[1]}B`;
}

const SHELF_NOTES: Record<string, string> = {
  LLM: 'One folder per chat model: the GGUF, its drafters and vision projector',
  'LLM/MLX': 'MLX twins and MTP heads, loaded by rapid-mlx / mlx-lm / dflash / oMLX',
  'Image/Generation': 'Text → image',
  'Image/Editing': 'Image → image',
  'Image/Vector': 'SVG — OmniSVG',
  'Video/Generation': 'Text / image → video; ComfyUI reads the type folders here',
  'Video/Editing': 'Video → video',
  '3D/Generation': 'Image → 3D',
  '3D/Rigging': 'Skeletons and skinning',
  '3D/Motion': 'Text → motion',
  'Audio/Music': 'Music generation; ComfyUI reads the type folders here',
  'Audio/SFX': 'Sound effects',
  'Audio/Speech': 'Text → speech, dictation cleanup',
  'Audio/Transcription': 'Speech → text',
  Support: 'Models other models need — a vision backbone, an embedder, background removal',
  Unsorted: 'Weights the migration could not place; kept exactly as they were',
};

/** Which `models--…` links in the workers' hub cache point where. */
function hubLinks(cache: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of [
    path.join(cache, 'gen3d', 'hf', 'hub'),
    path.join(cache, 'gen3d', 'models'),
    path.join(cache, 'omnisvg'),
  ]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const at = path.join(dir, n);
      try {
        if (!lstatSync(at).isSymbolicLink()) continue;
        out.set(realpathSync(at), at);
      } catch {
        /* dangling — nothing to map */
      }
    }
  }
  return out;
}

function inUsePaths(): Set<string> {
  const out = new Set<string>();
  const loaded = getLoadedModel();
  if (loaded !== null) {
    out.add(path.join(libraryRoot(), 'LLM', loaded.id));
  }
  return out;
}

/** A model folder: a repo (`org__name`) or a catalog id, with its size. */
async function modelNode(
  p: string,
  links: Map<string, string>,
  inUse: Set<string>,
): Promise<StorageNode> {
  const base = path.basename(p);
  const { bytes, files, mtime } = await sizeOf(p);
  let linked = false;
  let linkName: string | null = null;
  try {
    const at = links.get(realpathSync(p));
    linked = at !== undefined;
    if (at !== undefined) linkName = repoFromHubEntry(path.basename(at));
  } catch {
    linked = false;
  }
  // The folder is lowercase (macOS is case-insensitive); the hub link, when
  // there is one, still spells the repo the way its org does.
  const repo = linkName ?? (base.includes('__') ? base.replace('__', '/') : null);
  // A catalog id reads as the catalog names it.
  const catalog = repo === null ? getCatalogModel(base) : undefined;
  const name = repo ?? catalog?.displayName ?? base;
  const shelf = shelfOf(p);
  // What a catalog says about it: the 3D engine's spec for a hub repo, the
  // store's manifest for a repo it downloaded.
  const spec =
    repo === null ? undefined : GEN3D_MODEL_SPECS.find((m) => m.repos.some((r) => r.repo === repo));
  const manifest = await readManifestLite(p);
  const meta = {
    ...(repo !== null ? { org: repo.split('/')[0] ?? '', repo } : {}),
    ...(spec !== undefined ? { blurb: spec.note, tasks: [spec.role], label: spec.label } : {}),
    ...(manifest !== null
      ? {
          ...(manifest.notes !== undefined ? { blurb: manifest.notes } : {}),
          ...(manifest.tasks !== undefined ? { tasks: manifest.tasks } : {}),
          ...(manifest.name !== undefined ? { label: manifest.name } : {}),
        }
      : {}),
    ...(catalog !== undefined
      ? {
          org: catalog.hfRepo.split('/')[0] ?? '',
          repo: catalog.hfRepo,
          ...(catalog.files[0]?.quant !== undefined ? { quant: catalog.files[0].quant } : {}),
        }
      : {}),
    ...(() => {
      const params = paramsIn(catalog?.displayName ?? repo ?? base);
      return params === undefined ? {} : { params };
    })(),
    ...(shelf === null ? {} : { modality: shelf.split('/')[0] ?? '' }),
  };
  const isFile = ((): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  })();
  return {
    name,
    path: p,
    bytes,
    kind: isFile ? 'file' : 'model',
    ...(repo !== null
      ? {
          note: linked
            ? 'Hugging Face repo — the engines reach it through a link'
            : 'Hugging Face repo',
        }
      : {}),
    ...(linked ? { hubLinked: true } : {}),
    ...(inUse.has(p) ? { inUse: true } : {}),
    fileCount: files,
    mtime,
    meta,
  };
}

/** A shelf: its model folders; a ComfyUI type folder inside a shelf is listed as its files. */
async function shelfNode(
  shelfPath: string,
  shelf: string,
  links: Map<string, string>,
  inUse: Set<string>,
): Promise<StorageNode | null> {
  let entries: string[];
  try {
    entries = readdirSync(shelfPath).filter((n) => !n.startsWith('.') && n !== 'README.txt');
  } catch {
    return null;
  }
  const children: StorageNode[] = [];
  for (const n of entries) {
    if (shelf === 'LLM' && n === 'MLX') continue;
    const p = path.join(shelfPath, n);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    // A ComfyUI type folder (unet/, vae/, …) holds loose weights: each is a row.
    if (
      isDir &&
      /^(checkpoints|diffusion_models|unet|vae|clip|clip_vision|text_encoders|audio_encoders|loras|controlnet|upscale_models|latent_upscale_models)$/.test(
        n,
      )
    ) {
      let files: string[] = [];
      try {
        files = readdirSync(p).filter((f) => !f.startsWith('.'));
      } catch {
        files = [];
      }
      for (const f of files) {
        const fp = path.join(p, f);
        const { bytes, mtime } = await sizeOf(fp);
        children.push({
          name: f,
          path: fp,
          bytes,
          kind: 'file',
          note: `ComfyUI ${n}`,
          mtime,
          meta: { modality: shelf.split('/')[0] ?? '' },
        });
      }
      continue;
    }
    children.push(await modelNode(p, links, inUse));
  }
  children.sort((a, b) => b.bytes - a.bytes);
  return {
    name: shelf.split('/').pop() ?? shelf,
    path: shelfPath,
    bytes: children.reduce((s, c) => s + c.bytes, 0),
    kind: 'shelf',
    ...(SHELF_NOTES[shelf] === undefined ? {} : { note: SHELF_NOTES[shelf] }),
    children,
    mtime: children.reduce((m, c) => Math.max(m, c.mtime ?? 0), 0),
    fileCount: children.reduce((n, c) => n + (c.fileCount ?? 0), 0),
  };
}

async function libraryTree(): Promise<StorageNode> {
  const root = libraryRoot();
  const links = hubLinks(cacheRoot());
  const inUse = inUsePaths();
  const modalities: StorageNode[] = [];
  for (const m of MODALITY_FOLDERS) {
    const folder = path.join(root, m.folder);
    if (!existsSync(folder)) continue;
    const shelves: StorageNode[] = [];
    if (m.folder === 'LLM') {
      const own = await shelfNode(folder, 'LLM', links, inUse);
      if (own !== null) shelves.push({ ...own, name: 'GGUF' });
      const mlx = await shelfNode(path.join(folder, 'MLX'), 'LLM/MLX', links, inUse);
      if (mlx !== null) shelves.push(mlx);
    } else if (m.folder === 'Support' || m.folder === 'Unsorted') {
      const own = await shelfNode(folder, m.folder, links, inUse);
      if (own !== null) shelves.push(own);
    } else {
      let subs: string[] = [];
      try {
        subs = readdirSync(folder).filter((n) => !n.startsWith('.'));
      } catch {
        subs = [];
      }
      for (const sub of subs) {
        const node = await shelfNode(path.join(folder, sub), `${m.folder}/${sub}`, links, inUse);
        if (node !== null) shelves.push(node);
      }
    }
    modalities.push({
      name: m.label,
      path: folder,
      bytes: shelves.reduce((s, c) => s + c.bytes, 0),
      kind: 'modality',
      note: m.blurb,
      children: shelves,
      mtime: shelves.reduce((t, c) => Math.max(t, c.mtime ?? 0), 0),
      fileCount: shelves.reduce((n, c) => n + (c.fileCount ?? 0), 0),
    });
  }
  return {
    name: 'Models',
    path: root,
    bytes: modalities.reduce((s, c) => s + c.bytes, 0),
    kind: 'root',
    children: modalities,
  };
}

const SUPPORT_NOTES: Record<string, string> = {
  engines: 'Python venvs for the MLX engines, ComfyUI, the office pipeline',
  llamacpp: 'llama.cpp releases',
  gen3d:
    '3D/image/audio workers: sources, venvs, binaries and their Hugging Face cache (links into the library)',
  omnisvg: 'OmniSVG code and its llama.cpp; weights are in Image/Vector',
  uv: 'The uv Python installer',
  'chat-templates': 'Chat templates fetched or uploaded',
  calibration: 'Calibration records (which engine each model runs best on)',
  'office-gen': 'Office document pipeline scratch',
  hf: 'Hub cache the MLX engines are pointed at (empty by design)',
  store: 'The legacy store — empty once migrated',
  models: 'The legacy GGUF folder — empty once migrated',
};

async function supportTree(): Promise<StorageNode[]> {
  const root = cacheRoot();
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
  const out: StorageNode[] = [];
  for (const n of names) {
    const p = path.join(root, n);
    const { bytes, files, mtime } = await sizeOf(p);
    // A feature's own folder carries the note it registered (storage-rows.ts).
    const note = SUPPORT_NOTES[n] ?? supportNoteFor(n);
    out.push({
      name: n,
      path: p,
      bytes,
      kind: 'tool',
      ...(note === undefined ? {} : { note }),
      fileCount: files,
      mtime,
    });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

let cached: { at: number; overview: StorageOverview } | null = null;

async function overview(fresh: boolean): Promise<StorageOverview> {
  if (!fresh && cached !== null && Date.now() - cached.at < 30_000) return cached.overview;
  const t0 = Date.now();
  const [library, support, features] = await Promise.all([
    libraryTree(),
    supportTree(),
    featureStorageRows((id, error) =>
      log.warn('storage rows failed', { provider: id, error: String(error) }),
    ),
  ]);
  const { free, total } = await diskSpace();
  const disk = { free, total };
  const out: StorageOverview = {
    libraryRoot: libraryRoot(),
    defaultLibraryRoot: defaultLibraryRoot(),
    supportRoot: cacheRoot(),
    disk,
    library,
    support,
    features,
    migration:
      lastMigration === null
        ? null
        : {
            ranAt: lastMigration.ranAt,
            moved: lastMigration.moved.length,
            skipped: lastMigration.skipped
              .filter((s) => s.why !== 'gone' && s.why !== 'already a link')
              .map((s) => ({ path: s.move.from, why: s.why })),
            unsorted: lastMigration.unsorted,
          },
    scanMs: Date.now() - t0,
  };
  cached = { at: Date.now(), overview: out };
  return out;
}

/** Only the library, the support root and the folders a feature registered
 * (storage-rows.ts) are ours to touch. */
function underOurRoots(p: string): boolean {
  const roots = [libraryRoot(), cacheRoot(), ...featureStorageRoots()].map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    real = p;
  }
  return roots.some((r) => real === r || real.startsWith(`${r}/`));
}

/**
 * The engine-view links that point at `p` (or inside it) — resolved from the
 * link text, so it works before AND after the target is gone. `p` is matched
 * both as spelled and as its real path (`/var` vs `/private/var`).
 */
function linksPointingAt(p: string): string[] {
  const spellings = new Set([path.resolve(p)]);
  try {
    spellings.add(realpathSync(p));
  } catch {
    /* gone already — its spelled path still matches the link text */
  }
  const out: string[] = [];
  for (const dir of [
    path.join(cacheRoot(), 'gen3d', 'hf', 'hub'),
    path.join(cacheRoot(), 'gen3d', 'models'),
    path.join(cacheRoot(), 'omnisvg'),
  ]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const at = path.join(dir, n);
      try {
        if (!lstatSync(at).isSymbolicLink()) continue;
        const target = path.resolve(dir, readlinkSync(at));
        const targets = new Set([target]);
        try {
          targets.add(`${realpathSync(path.dirname(target))}/${path.basename(target)}`);
        } catch {
          /* the parent may be gone too */
        }
        for (const t of targets) {
          for (const sp of spellings) {
            if (t === sp || t.startsWith(`${sp}/`)) out.push(at);
          }
        }
      } catch {
        /* unreadable link — not ours to touch */
      }
    }
  }
  return [...new Set(out)];
}

// ── moving the whole library ────────────────────────────────────────────────

async function moveLibrary(
  to: string,
  emit: (p: StorageMoveProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const from = libraryRoot();
  if (path.resolve(to) === path.resolve(from)) return { ok: true };
  if (getLoadedModel() !== null) {
    return {
      ok: false,
      error:
        'a model is being served from the library — stop it first (Model management → the running model), then move',
    };
  }
  if (existsSync(to) && readdirSync(to).some((n) => !n.startsWith('.'))) {
    return { ok: false, error: `${to} is not empty` };
  }
  mkdirSync(path.dirname(to), { recursive: true });
  if (!existsSync(from)) {
    mkdirSync(to, { recursive: true });
    return { ok: true };
  }
  // Same volume: one rename.
  try {
    if (existsSync(to)) await rm(to, { recursive: true, force: true });
    renameSync(from, to);
    relinkAfterMove(from, to);
    emit({ phase: 'done', copied: 0, total: 0 });
    return { ok: true };
  } catch (err) {
    if ((err as { code?: string }).code !== 'EXDEV') {
      return { ok: false, error: String(err) };
    }
  }
  // Another volume: copy with progress, verify the byte total, then remove.
  const total = (await sizeOf(from)).bytes;
  let copied = 0;
  let stop = false;
  const ticker = setInterval(() => {
    void sizeOf(to).then((s) => {
      copied = s.bytes;
      if (!stop) emit({ phase: 'copying', copied, total });
    });
  }, 1000);
  try {
    await cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: false,
      force: true,
    });
  } catch (err) {
    stop = true;
    clearInterval(ticker);
    emit({ phase: 'failed', copied, total, error: String(err) });
    return { ok: false, error: `copy failed: ${String(err)}` };
  }
  stop = true;
  clearInterval(ticker);
  const after = (await sizeOf(to)).bytes;
  if (after < total) {
    emit({
      phase: 'failed',
      copied: after,
      total,
      error: 'the copy is smaller than the original; the original was kept',
    });
    return { ok: false, error: `copied ${after} of ${total} bytes; the original was kept` };
  }
  emit({ phase: 'removing', copied: after, total });
  await rm(from, { recursive: true, force: true });
  relinkAfterMove(from, to);
  emit({ phase: 'done', copied: after, total });
  return { ok: true };
}

/** The engines' links pointed into the old root: point them at the new one. */
function relinkAfterMove(from: string, to: string): void {
  for (const dir of [
    path.join(cacheRoot(), 'gen3d', 'hf', 'hub'),
    path.join(cacheRoot(), 'gen3d', 'models'),
    path.join(cacheRoot(), 'omnisvg'),
  ]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const at = path.join(dir, n);
      try {
        if (!lstatSync(at).isSymbolicLink()) continue;
        const target = readlinkSync(at);
        const abs = path.resolve(dir, target);
        if (!abs.startsWith(from)) continue;
        const next = path.join(to, abs.slice(from.length).replace(/^\/+/, ''));
        unlinkSync(at);
        symlinkSync(path.relative(dir, next), at);
      } catch {
        /* a link we cannot read is not ours to fix */
      }
    }
  }
}

/** Two channels, each with its own payload — spelled out so main's typed sender accepts it. */
type Emit = {
  (channel: 'storage:move', payload: StorageEventMap['storage:move']): void;
  (channel: 'storage:export', payload: StorageEventMap['storage:export']): void;
};

export function registerStorageIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  emit: Emit,
): void {
  registerIpcHandlers<StorageInvokeMap>(
    ipcMain,
    {
      'storage:overview': (req) => overview(req?.fresh === true),
      'storage:disk': () => diskSpace(),
      'storage:check-space': async ({ bytes }) => {
        const refusal = await spaceRefusal(bytes);
        const { free } = await diskSpace();
        return { ok: refusal === null, refusal, free };
      },
      'storage:reveal': async ({ path: p }) => {
        if (!underOurRoots(p)) return { ok: false, error: 'not a Bobble folder' };
        if (!existsSync(p)) return { ok: false, error: 'gone' };
        shell.showItemInFolder(p);
        return { ok: true };
      },
      'storage:trash': async ({ paths }) => {
        let freed = 0;
        const failed: { path: string; error: string }[] = [];
        const busy = inUsePaths();
        for (const p of paths) {
          if (!underOurRoots(p)) {
            failed.push({ path: p, error: 'not a Bobble folder' });
            continue;
          }
          if (
            path.resolve(p) === path.resolve(libraryRoot()) ||
            path.resolve(p) === path.resolve(cacheRoot())
          ) {
            failed.push({ path: p, error: 'that is the whole library' });
            continue;
          }
          if ([...busy].some((b) => b === p || b.startsWith(`${p}/`))) {
            failed.push({
              path: p,
              error: 'a model in here is being served right now — stop it first',
            });
            continue;
          }
          const { bytes } = await sizeOf(p);
          // The links are found BEFORE the trash: a dangling link no longer
          // resolves to anything that could be matched.
          const links = linksPointingAt(p);
          try {
            await shell.trashItem(p);
          } catch (err) {
            failed.push({ path: p, error: String(err) });
            continue;
          }
          for (const at of links) {
            try {
              unlinkSync(at);
            } catch {
              /* already gone */
            }
          }
          freed += bytes;
        }
        cached = null;
        return { ok: failed.length === 0, freed, failed };
      },
      'storage:export': async ({ paths, dest: seam }) => {
        const wanted = paths.filter((p) => underOurRoots(p) && existsSync(p));
        if (wanted.length === 0) return { ok: false, error: 'nothing to export' };
        let dest: string;
        if (process.env.PI_E2E === '1' && typeof seam === 'string' && seam.length > 0) {
          dest = seam; // a probe cannot drive the native picker
        } else {
          const picked = await dialog.showOpenDialog({
            title:
              wanted.length === 1
                ? `Export ${path.basename(wanted[0] ?? '')} to…`
                : `Export ${wanted.length} items to…`,
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Export here',
          });
          if (picked.canceled || picked.filePaths.length === 0) {
            return { ok: false, cancelled: true };
          }
          dest = picked.filePaths[0] ?? '';
        }
        let total = 0;
        for (const p of wanted) total += (await sizeOf(p)).bytes;
        let copied = 0;
        let current = '';
        let stop = false;
        const ticker = setInterval(() => {
          void (async () => {
            let sum = 0;
            for (const p of wanted) sum += (await sizeOf(path.join(dest, path.basename(p)))).bytes;
            copied = sum;
            if (!stop) emit('storage:export', { phase: 'copying', copied, total, current });
          })();
        }, 1000);
        try {
          for (const p of wanted) {
            current = path.basename(p);
            const target = path.join(dest, current);
            if (existsSync(target)) throw new Error(`${current} already exists there`);
            // Through the links, not the links: an export is for another
            // machine, which has no hub cache of ours to point at.
            await cp(p, target, { recursive: true, dereference: true, errorOnExist: true });
          }
        } catch (err) {
          stop = true;
          clearInterval(ticker);
          emit('storage:export', { phase: 'failed', copied, total, error: String(err) });
          return { ok: false, error: String(err), dest };
        }
        stop = true;
        clearInterval(ticker);
        emit('storage:export', { phase: 'done', copied: total, total });
        return { ok: true, dest };
      },
      'storage:pick-root': async () => {
        const picked = await dialog.showOpenDialog({
          title: 'Choose where Bobble keeps its models',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: path.dirname(libraryRoot()),
        });
        if (picked.canceled || picked.filePaths.length === 0) return { path: null };
        return { path: picked.filePaths[0] ?? null };
      },
      'storage:set-root': async ({ path: p }) => {
        const to = p === null ? defaultLibraryRoot() : path.resolve(p);
        // A library under the temp folder would be swept by the OS; only the
        // scratch probe (its opt-in) may put one there.
        if (to.startsWith(tmpdir()) && process.env.PI_DESKTOP_MIGRATE_LIBRARY !== '1') {
          return { ok: false, error: 'not under the temp folder' };
        }
        const res = await moveLibrary(to, (progress) => emit('storage:move', progress));
        if (!res.ok) return res;
        writeSettingsPatch({ modelsRoot: p === null ? null : to });
        process.env.PI_DESKTOP_MODELS_DIR = to;
        cached = null;
        return { ok: true, root: to };
      },
    },
    { allowSender },
  );
}
