/**
 * WHICH llama-server RUNS THIS MODEL.
 *
 * One question, asked in one place, so the rest of the launch path never has to
 * think about it: everything gets the pinned release unless the model's
 * architecture is one the pinned release does not have, in which case it gets
 * the variant declared for that architecture (llamacpp-variants.ts).
 *
 * The check is against the BINARY, not against a list we maintain. That is what
 * makes the arrangement temporary by construction: bump the pin to a release
 * that includes the architecture and the variant stops being selected on the
 * next launch, with no code change and nobody having to notice the PR landed.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CatalogModel } from './catalog.js';
import { type ExecFileFn, ensureLlamaCpp } from './llamacpp-manager.js';
import { buildVariant } from './llamacpp-source-build.js';
import { architecturesIn, resolveEngine, variantArchitectures } from './llamacpp-variants.js';

/**
 * THE CORE libllama, out of a directory full of things that look like it.
 *
 * A llama.cpp build tree carries a dozen `libllama-*-impl.dylib` helpers beside
 * the real library — batched-bench, cli, common, server, quantize. Only the core
 * one holds the architecture table. Taking the first alphabetically gets
 * `libllama-batched-bench-impl.dylib`, which contains no architectures at all,
 * and the answer that comes back is a confident "this engine supports nothing" —
 * MEASURED against a freshly built K2 variant whose libllama.dylib does have
 * `k2-horizon` in it.
 *
 * So the rule is by SHAPE: `libllama` followed immediately by `.`, never by `-`.
 * Both `libllama.dylib` and the versioned `libllama.0.dylib` qualify; every
 * hyphenated helper is excluded by construction rather than by a list of names
 * that would go stale on the next release.
 */
export function pickLibllama(names: readonly string[]): string | undefined {
  const core = names.filter((n) => /^libllama\.[0-9.]*dylib$/.test(n));
  // Shortest wins: `libllama.dylib` (usually a symlink to the versioned one)
  // over `libllama.0.3.0.dylib`. Either reads the same; this is just stable.
  return [...core].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/** The core libllama beside a llama-server, when there is one. */
async function libllamaBeside(serverPath: string): Promise<string | undefined> {
  const dir = dirname(serverPath);
  const entries = await readdir(dir).catch(() => []);
  const name = pickLibllama(entries);
  return name === undefined ? undefined : join(dir, name);
}

/**
 * The architectures a built engine actually knows.
 *
 * Reads the arch identifier table out of libllama — the same evidence used to
 * establish that b10603 has `bailingmoe3` and no `k2-horizon`. Returns undefined
 * when the library cannot be read, which callers must treat as "unknown" rather
 * than as "no": guessing "no" would keep a variant alive forever, guessing "yes"
 * would hand a model to an engine that cannot load it.
 */
export async function engineArchitectures(
  serverPath: string,
  candidates: readonly string[] = variantArchitectures(),
): Promise<ReadonlySet<string> | undefined> {
  const lib = await libllamaBeside(serverPath);
  if (lib === undefined) return undefined;
  const bytes = await readFile(lib).catch(() => undefined);
  if (bytes === undefined) return undefined;
  return architecturesIn(bytes, candidates);
}

export interface EngineForModel {
  readonly serverPath: string;
  /** Set when a variant was used — for the status line and for diagnostics. */
  readonly variantId?: string;
  /** Human sentence for the UI when a variant is in play. */
  readonly note?: string;
}

export interface EnsureEngineOptions {
  readonly execFileImpl: ExecFileFn;
  readonly jobs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: { phase: string; note: string }) => void;
}

/**
 * Resolve and install the engine for `model`, returning the server to spawn.
 *
 * The pinned release is ensured first in every case: it is the fallback, it is
 * what the retirement check is asked about, and it is already installed on any
 * machine that has run the app once, so this costs nothing in the common path.
 */
export async function ensureEngineFor(
  model: Pick<CatalogModel, 'architecture' | 'displayName'>,
  opts: EnsureEngineOptions,
): Promise<EngineForModel> {
  const pinned = await ensureLlamaCpp();
  if (model.architecture === undefined) return { serverPath: pinned.serverPath };

  const known = await engineArchitectures(pinned.serverPath);
  const choice = resolveEngine(model.architecture, known);
  if (choice.kind === 'pinned') return { serverPath: pinned.serverPath };

  const built = await buildVariant({
    variant: choice.variant,
    execFileImpl: opts.execFileImpl,
    ...(opts.jobs !== undefined ? { jobs: opts.jobs } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
  });
  return {
    serverPath: built.serverPath,
    variantId: choice.variant.id,
    note: choice.variant.why,
  };
}
