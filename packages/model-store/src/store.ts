/**
 * THE INDEX — reading the store back off the disk, and writing to it.
 *
 * Every function here takes its roots as arguments rather than reaching for the
 * user's cache, so tests (and a future "move my models to an external drive")
 * work without a global. The default is the real cache; nothing else assumes it.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cacheRoot,
  entryDir,
  MODEL_KINDS,
  type ModelKind,
  manifestPath,
  slugFor,
  storeRoot,
} from './layout.js';
import { libraryRoot, SHELVES, shelfDir } from './library.js';
import { parseManifest, type StoredModel, serializeManifest } from './manifest.js';

export interface StoreOptions {
  /** Legacy cache root; defaults to the app's. */
  readonly root?: string;
  /** Library root; defaults to the app's. */
  readonly library?: string;
}

/** Write (or rewrite) a model's manifest, creating its directory. */
export async function writeManifest(model: StoredModel): Promise<void> {
  await mkdir(model.dir, { recursive: true });
  await writeFile(manifestPath(model.dir), serializeManifest(model), 'utf8');
}

/** Read one manifest, or undefined when the directory holds none. */
export async function readManifest(dir: string): Promise<StoredModel | undefined> {
  try {
    return parseManifest(await readFile(manifestPath(dir), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Everything in the canonical store.
 *
 * A directory with no manifest is SKIPPED rather than guessed at. The store is
 * meant to be authoritative about what it lists, and inferring a model from a
 * folder of loose files is exactly the kind of guess that later shows the user a
 * "model" that is half a download.
 */
export async function listStore(opts: StoreOptions = {}): Promise<StoredModel[]> {
  const found: StoredModel[] = [];
  const seen = new Set<string>();
  const take = async (dir: string): Promise<void> => {
    try {
      if (!(await stat(dir)).isDirectory()) return;
    } catch {
      return;
    }
    const model = await readManifest(dir);
    if (model === undefined || seen.has(model.dir)) return;
    seen.add(model.dir);
    found.push(model);
  };
  // The library: every shelf, one level of repo folders each.
  const library = opts.library ?? libraryRoot();
  for (const shelf of SHELVES) {
    const dir = shelfDir(shelf, library);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (shelf === 'LLM' && name === 'MLX') continue; // a shelf of its own
      await take(join(dir, name));
    }
  }
  // The legacy store, while a machine still has one.
  const root = storeRoot(opts.root ?? cacheRoot());
  for (const kind of MODEL_KINDS) {
    const kindDir = join(root, kind);
    let entries: string[];
    try {
      entries = await readdir(kindDir);
    } catch {
      continue;
    }
    for (const name of entries) await take(join(kindDir, name));
  }
  return found;
}

/** One entry by id (its slug), or undefined. */
export async function findStored(
  id: string,
  opts: StoreOptions = {},
): Promise<StoredModel | undefined> {
  return (await listStore(opts)).find((m) => m.id === id);
}

/** By repo id — what the hub asks when it wants to know "do I have this?". */
export async function findByRepo(
  repo: string,
  opts: StoreOptions = {},
): Promise<StoredModel | undefined> {
  const slug = slugFor(repo);
  return (await listStore(opts)).find((m) => m.id === slug || m.repo === repo);
}

/**
 * Delete a stored model, weights and all.
 *
 * Refuses anything whose `source` is not `store`: a GGUF model belongs to the
 * inference supervisor's own directory and a 3D engine repo to the Hugging Face
 * cache the engine reads. Deleting those from here would leave the owning
 * component believing they are still installed — the caller is told so rather
 * than the call quietly doing nothing.
 */
export async function removeStored(id: string, opts: StoreOptions = {}): Promise<void> {
  const model = await findStored(id, opts);
  if (model === undefined) return;
  if (model.source !== 'store') {
    throw new Error(`${id} is owned by the ${model.source} component; delete it there`);
  }
  await rm(model.dir, { recursive: true, force: true });
}

/** The directory a repo of this kind would be downloaded into. */
export function plannedDir(kind: ModelKind, repo: string, opts: StoreOptions = {}): string {
  return entryDir(kind, repo, opts.root ?? cacheRoot(), {
    ...(opts.library === undefined ? {} : { library: opts.library }),
  });
}
