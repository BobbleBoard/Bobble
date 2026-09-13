/**
 * Stable on-disk cache locations for downloaded llama.cpp binaries and GGUF
 * models. Everything lives under a single root so a user can wipe it in one
 * `rm -rf`. The root is overridable via `PI_DESKTOP_CACHE_DIR` — tests point it
 * at a scratch dir so they never touch the user's real cache.
 *
 * This module imports nothing electron-specific; `homedir()` is plain Node.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * THE SUPPORT ROOT — `~/.cache/bobble`: engines, venvs, tool binaries, the
 * workers' Hugging Face cache, scratch. Models are NOT here any more (see
 * `libraryRoot`). `PI_DESKTOP_CACHE_DIR` overrides it (tests and probes point
 * it at a scratch dir, or at the real one from a throwaway HOME).
 *
 * It was `~/.cache/pi-desktop` until 2026-09-13 (the user: "purge any 'pi desktop'
 * branding"). The app renames the old folder on first launch and leaves a
 * symlink at the old name, because every venv under it has the old absolute
 * path baked into its scripts — see storage-main's `renameSupportRoot`.
 */
export function cacheRoot(): string {
  const override = process.env.PI_DESKTOP_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.cache', 'bobble');
}

/** The pre-rename support root, for the one-time rename and for reading a machine not yet renamed. */
export function legacyCacheRoot(): string {
  return join(homedir(), '.cache', 'pi-desktop');
}

/**
 * KEEP SPOTLIGHT OUT OF THE CACHE.
 *
 * The morning the user's Mac froze under a generation, `/Library/Logs/
 * DiagnosticReports` held two `mds_stores` reports from the same half hour —
 * Spotlight writing 10 GB of index over 420 seconds. It was indexing the model
 * downloads: a 30 GB video checkpoint is, to Spotlight, a very large file worth
 * reading in full, on the same disk and in the same minutes the generation
 * needed it. Nothing in here is anything anyone will ever search for.
 *
 * `.metadata_never_index` at the root is macOS's own opt-out and is honoured
 * for the whole subtree. Harmless everywhere else — an empty file. Idempotent
 * and best-effort: a cache root that cannot be written is a different problem,
 * reported elsewhere.
 */
export async function excludeCacheFromIndexing(deps: {
  readonly root?: string;
  readonly mkdir: (dir: string) => Promise<unknown>;
  readonly writeFile: (file: string, data: string) => Promise<unknown>;
  readonly exists: (file: string) => Promise<boolean>;
}): Promise<'created' | 'present' | 'failed'> {
  const root = deps.root ?? cacheRoot();
  const marker = join(root, '.metadata_never_index');
  try {
    if (await deps.exists(marker)) return 'present';
    await deps.mkdir(root);
    await deps.writeFile(marker, '');
    return 'created';
  } catch {
    return 'failed';
  }
}

/** Directory for a specific pinned llama.cpp release, e.g. `.../llamacpp/b9934`. */
export function llamacppDir(tag: string): string {
  return join(cacheRoot(), 'llamacpp', tag);
}

/**
 * THE MODEL LIBRARY ROOT — `~/Bobble/Models`, a folder a person can open.
 *
 * the user (2026-09-12): "all models and such are dumped in .cache … let's not be
 * like that." Weights live here now, sorted by what they make (see
 * @pi-desktop/model-store's library.ts for the shelves); the support root
 * above keeps engines, venvs and scratch. `PI_DESKTOP_MODELS_DIR` overrides it
 * — the app sets it from the storage setting before anything reads a path,
 * and a probe points it at the real library while keeping a throwaway HOME.
 */
export function libraryRoot(): string {
  const override = process.env.PI_DESKTOP_MODELS_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), 'Bobble', 'Models');
}

/** Where chat models (GGUF + drafters + mmproj) live: `<library>/LLM`. */
export function modelsDir(): string {
  return join(libraryRoot(), 'LLM');
}

/** The pre-library location of the same thing, read while a cache is unmigrated. */
export function legacyModelsDir(): string {
  return join(cacheRoot(), 'models');
}

/**
 * Per-model subdirectory keyed by catalog id (files + siblings live together).
 * The library shelf, unless only the legacy cache holds it — a cache the
 * migration has not reached yet, or a probe pointed at the old tree.
 */
export function modelDir(modelId: string): string {
  // A tool's model rather than a chat model goes on its own shelf: OmniSVG
  // makes vectors, and belongs under Image/Vector like everything that does.
  const shelf = /^omnisvg/i.test(modelId) ? join(libraryRoot(), 'Image', 'Vector') : modelsDir();
  const here = join(shelf, modelId);
  if (existsSync(here)) return here;
  const legacy = join(legacyModelsDir(), modelId);
  return existsSync(legacy) ? legacy : here;
}
