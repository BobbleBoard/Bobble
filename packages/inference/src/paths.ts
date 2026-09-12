/**
 * Stable on-disk cache locations for downloaded llama.cpp binaries and GGUF
 * models. Everything lives under a single root so a user can wipe it in one
 * `rm -rf`. The root is overridable via `PI_DESKTOP_CACHE_DIR` — tests point it
 * at a scratch dir so they never touch the user's real cache.
 *
 * This module imports nothing electron-specific; `homedir()` is plain Node.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of the Pi Desktop download cache (`~/.cache/pi-desktop` by default). */
export function cacheRoot(): string {
  const override = process.env.PI_DESKTOP_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
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

/** Directory holding downloaded GGUF model files. */
export function modelsDir(): string {
  return join(cacheRoot(), 'models');
}

/** Per-model subdirectory keyed by catalog id (files + siblings live together). */
export function modelDir(modelId: string): string {
  return join(modelsDir(), modelId);
}
