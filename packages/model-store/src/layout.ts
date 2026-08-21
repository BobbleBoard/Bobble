/**
 * WHERE A MODEL'S WEIGHTS LIVE, AND HOW TO FIND THEM AGAIN.
 *
 * the user: "we need to be able to download anything and store it properly in an
 * organized format so that no matter what we add either now or later we have an
 * easy way to list relevant models and know where their weights are stored their
 * names relevant info etc. (eg say we add a video/image studio.)"
 *
 * THE PROBLEM THIS SOLVES. Weights had already landed in three different places
 * by three different routes: GGUF text models under `models/<catalog-id>/`, the
 * 3D engine's repos in a Hugging Face cache under `gen3d/hf/`, and generation
 * backends fetching into caches of their own on first use. Nothing could answer
 * "what is on this machine, what does it make, and how much disk is it using" —
 * so every new studio would have invented a fourth place.
 *
 * THE SHAPE. A NEW download goes to one canonical spot:
 *
 *   <cache>/store/<kind>/<slug>/            kind = text|image|video|audio|3d
 *     model.json                            the manifest (see manifest.ts)
 *     <the repo's files, at their repo paths>
 *
 * Existing locations are NOT moved. Relocating a 30 GB model to tidy a directory
 * listing is a long, risky operation whose only benefit is symmetry — so the
 * index describes weights wherever they already are, and only new arrivals get
 * the canonical layout. That is why a manifest carries an absolute `dir` rather
 * than assuming one.
 *
 * SLUGS ARE DERIVED, NOT STORED SEPARATELY. `org__name` from the repo id, so a
 * directory is legible from the outside and two orgs can publish the same model
 * name without colliding.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What a model MAKES — the axis the whole app filters and groups on. */
export type ModelKind = 'text' | 'image' | 'video' | 'audio' | '3d';

export const MODEL_KINDS: readonly ModelKind[] = ['text', 'image', 'video', 'audio', '3d'];

/** Root of the app's download cache. Mirrors @pi-desktop/inference's `cacheRoot`
 *  (same env override), duplicated rather than imported so this module has no
 *  dependency on the inference package's runtime. */
export function cacheRoot(): string {
  const override = process.env.PI_DESKTOP_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.cache', 'pi-desktop');
}

/** Root of the unified store — everything downloaded from here on. */
export function storeRoot(root = cacheRoot()): string {
  return join(root, 'store');
}

/**
 * `org__name` for a repo id.
 *
 * Only characters that are awkward in a path are replaced; the rest is left
 * alone so the directory still reads as the repo it came from. Lowercasing is
 * deliberate: macOS is case-insensitive, so `Qwen/Qwen-Image` and
 * `qwen/qwen-image` must not be two entries that are one directory.
 */
export function slugFor(repo: string): string {
  return repo
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\//g, '__')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The canonical directory for a newly downloaded model. */
export function entryDir(kind: ModelKind, repo: string, root = cacheRoot()): string {
  return join(storeRoot(root), kind, slugFor(repo));
}

/** The manifest path inside a model's directory. */
export function manifestPath(dir: string): string {
  return join(dir, 'model.json');
}
