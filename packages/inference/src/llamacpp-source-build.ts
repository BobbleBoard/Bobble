/**
 * Building an engine variant from source.
 *
 * The pinned release arrives as a signed-off tarball with a published sha256
 * (llamacpp-manager.ts). A fork has no releases — MEASURED for the K2 Horizon
 * one: MBZUAI-IFM/llama.cpp has zero published releases, so there is no binary
 * to fetch and no digest to check against. What there IS, for any GitHub commit,
 * is a source archive at a fixed URL, and a commit sha is a stronger promise
 * about contents than a release asset's digest: it covers the whole tree.
 *
 * So this fetches `archive/<sha>.tar.gz`, records the archive's own sha256 the
 * first time and REQUIRES it to match on every rebuild afterwards, and compiles.
 * Idempotent through the same marker file the release path uses: a second call
 * with the binary present returns without recompiling.
 *
 * ## What it costs, and why that is stated up front
 *
 * This is a compile, not a download — minutes, not seconds, and it needs cmake
 * and a C++ toolchain that a fresh Mac does not have until Xcode's command line
 * tools are installed. Both of those are real failure modes for a user, so
 * {@link buildRequirements} answers "can this machine do it" BEFORE anything is
 * downloaded, and the caller can say so plainly instead of failing three minutes
 * in with a compiler error.
 *
 * MEASURED on an M5 Pro (10 build jobs): configure 12s, build 3m41s, and the
 * resulting libllama exports `k2-horizon` where the pinned b10603 does not.
 *
 * Electron-free and injectable, like the rest of this package: the exec and
 * fetch surfaces are parameters so the whole thing unit-tests without a
 * compiler.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecFileFn } from './llamacpp-manager.js';
import type { LlamaCppVariant } from './llamacpp-variants.js';
import { llamacppDir } from './paths.js';

/** Source archive URL for a pinned commit. Stable for the life of the commit. */
export function variantArchiveUrl(variant: LlamaCppVariant): string {
  return `https://github.com/${variant.source.repo}/archive/${variant.source.commit}.tar.gz`;
}

export interface VariantInstall {
  readonly variantId: string;
  readonly commit: string;
  readonly dir: string;
  /** Absolute path to the built `llama-server`. */
  readonly serverPath: string;
  /** sha256 of the source archive this was built from. */
  readonly archiveSha256: string;
}

interface VariantMarker {
  readonly variantId: string;
  readonly commit: string;
  readonly serverPath: string;
  readonly archiveSha256: string;
}

const MARKER = '.built.json';

/**
 * The cmake flags, and the reason for each.
 *
 * Tests and examples are the bulk of the build and none of it ships — leaving
 * them on roughly doubles a wait the user is already watching. `LLAMA_CURL=OFF`
 * because the app does its own downloading and linking libcurl adds a system
 * dependency for a feature that would never be used. Metal ON is the point of
 * the exercise on Apple Silicon.
 */
export const VARIANT_CMAKE_FLAGS: readonly string[] = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DGGML_METAL=ON',
  '-DLLAMA_BUILD_TESTS=OFF',
  '-DLLAMA_BUILD_EXAMPLES=OFF',
  '-DLLAMA_BUILD_TOOLS=ON',
  '-DLLAMA_CURL=OFF',
];

export interface BuildRequirement {
  readonly tool: string;
  readonly present: boolean;
  /** What the user would have to do, when it is missing. */
  readonly install?: string;
}

/**
 * Whether this machine can compile a variant at all — asked before downloading
 * 37MB of source and spending three minutes discovering the answer.
 */
export async function buildRequirements(
  execFileImpl: ExecFileFn,
): Promise<readonly BuildRequirement[]> {
  const check = async (
    tool: string,
    args: string[],
    install: string,
  ): Promise<BuildRequirement> => {
    try {
      await execFileImpl(tool, args, { timeout: 10_000 });
      return { tool, present: true };
    } catch {
      return { tool, present: false, install };
    }
  };
  return [
    await check('cmake', ['--version'], 'Install CMake (brew install cmake).'),
    await check(
      'cc',
      ['--version'],
      'Install the Xcode command line tools (xcode-select --install).',
    ),
  ];
}

export interface BuildVariantOptions {
  readonly variant: LlamaCppVariant;
  /** Cache dir override; defaults to `~/.cache/pi-desktop/llamacpp/<variant id>`. */
  readonly dir?: string;
  readonly fetchImpl?: typeof fetch;
  readonly execFileImpl: ExecFileFn;
  readonly signal?: AbortSignal;
  /** Parallel compile jobs. Defaults to a sensible share of the machine. */
  readonly jobs?: number;
  /**
   * Progress, in the same shape the rest of the app reports work in: a phase and
   * a human line. A compile has no honest byte count, so it does not pretend to.
   */
  readonly onProgress?: (p: {
    phase: 'fetch' | 'extract' | 'configure' | 'compile';
    note: string;
  }) => void;
  /** Injectable extractor (tests). Default: `tar -xzf`. */
  readonly extract?: (archivePath: string, destDir: string) => Promise<void>;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The single directory a GitHub source tarball extracts into. */
async function soleSourceDir(root: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('llama.cpp-'));
  return dirs[0] === undefined ? undefined : join(root, dirs[0].name);
}

/**
 * Ensure `variant` is built and return its `llama-server`.
 *
 * Fast path: a marker recording the same commit and an existing binary returns
 * immediately. The commit is part of that check on purpose — re-pinning a
 * variant to a newer fork commit must rebuild rather than silently keep running
 * the old binary, which is the failure mode that would be hardest to notice.
 */
export async function buildVariant(opts: BuildVariantOptions): Promise<VariantInstall> {
  const { variant, execFileImpl, signal } = opts;
  const dir = opts.dir ?? llamacppDir(variant.id);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const marker = join(dir, MARKER);
  const note = (phase: 'fetch' | 'extract' | 'configure' | 'compile', text: string): void =>
    opts.onProgress?.({ phase, note: text });

  const existing = await readFile(marker, 'utf8')
    .then((t) => JSON.parse(t) as VariantMarker)
    .catch(() => undefined);
  if (
    existing !== undefined &&
    existing.commit === variant.source.commit &&
    (await pathExists(existing.serverPath))
  ) {
    return {
      variantId: variant.id,
      commit: existing.commit,
      dir,
      serverPath: existing.serverPath,
      archiveSha256: existing.archiveSha256,
    };
  }

  await mkdir(dir, { recursive: true });
  const archivePath = join(dir, `${variant.source.commit}.tar.gz`);

  note('fetch', `Fetching ${variant.source.repo} at ${variant.source.commit.slice(0, 8)}`);
  const res = await fetchImpl(variantArchiveUrl(variant), {
    headers: { 'user-agent': 'pi-desktop' },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok) {
    throw new Error(
      `could not fetch ${variant.displayName} source (HTTP ${res.status}) — ${variantArchiveUrl(variant)}`,
    );
  }
  const archive = Buffer.from(await res.arrayBuffer());
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  /*
   * A fork has no published digest to check against, so the FIRST build records
   * what it got and every rebuild must match it. That does not prove the archive
   * is what the author intended — only the commit sha does that — but it does
   * turn a silently different source tree into a hard error.
   */
  if (existing !== undefined && existing.commit === variant.source.commit) {
    if (existing.archiveSha256 !== archiveSha256) {
      throw new Error(
        `${variant.displayName}: the source archive for ${variant.source.commit.slice(0, 8)} changed since it was last built (${existing.archiveSha256} → ${archiveSha256})`,
      );
    }
  }
  await writeFile(archivePath, archive);

  note('extract', 'Unpacking source');
  const srcRoot = join(dir, 'src');
  await rm(srcRoot, { recursive: true, force: true });
  await mkdir(srcRoot, { recursive: true });
  const extract =
    opts.extract ??
    (async (a, d) => {
      await execFileImpl('tar', ['-xzf', a, '-C', d], { timeout: 300_000 });
    });
  await extract(archivePath, srcRoot);
  const src = await soleSourceDir(srcRoot);
  if (src === undefined) throw new Error(`${variant.displayName}: source archive had no tree`);

  note('configure', 'Configuring the build');
  await execFileImpl('cmake', ['-B', 'build', ...VARIANT_CMAKE_FLAGS], {
    cwd: src,
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  } as never);

  const jobs = Math.max(1, opts.jobs ?? 4);
  note('compile', `Compiling with ${jobs} jobs — this takes a few minutes`);
  await execFileImpl('cmake', ['--build', 'build', '--config', 'Release', '-j', String(jobs)], {
    cwd: src,
    timeout: 3_600_000,
    maxBuffer: 64 * 1024 * 1024,
  } as never);

  const serverPath = join(src, 'build', 'bin', 'llama-server');
  if (!(await pathExists(serverPath))) {
    throw new Error(`${variant.displayName}: build finished but no llama-server at ${serverPath}`);
  }
  const built: VariantMarker = {
    variantId: variant.id,
    commit: variant.source.commit,
    serverPath,
    archiveSha256,
  };
  await writeFile(marker, `${JSON.stringify(built, null, 2)}\n`);
  // The tarball is 37MB and has done its job; the tree it produced is what matters.
  await rm(archivePath, { force: true });
  return { variantId: variant.id, commit: built.commit, dir, serverPath, archiveSha256 };
}
