/**
 * Pinned llama.cpp release manifest.
 *
 * We pin an exact GitHub release tag (never "latest") so a given Pi Desktop
 * build always installs the same server binary. The macOS arm64 asset is a
 * TAR.GZ (not a zip) containing llama-server/llama-cli/llama plus the Metal
 * dylibs.
 *
 * sha256 + sizeBytes below were verified against GitHub's own per-asset
 * `digest` field (the releases API exposes `sha256:<hex>` per asset) on
 * 2026-07-08. `resolveRelease()` can still re-fetch the digest from the API at
 * download time as a fallback / cross-check.
 *
 * NOTE (catalog correction): the W4 research catalog pinned ~b9907, but that
 * file was absent from the scratchpad at build time. The live latest at build
 * time was b9934; it is pinned here with its published digest.
 *
 * BUMPED b9934 → b10603 for `bailingmoe3`.
 *
 * MEASURED: b9934's libllama exports `bailingmoe` and `bailingmoe2` only, and
 * Ling 3.0's GGUF declares `general.architecture = bailingmoe3` (read out of the
 * file header: 128 experts x 1.0B, 8 used, 24 blocks, 131072 context). So the
 * whole Ling family — the newest small MoE worth having — could not load at all
 * on the pinned engine, and would have failed with an unknown-architecture error
 * rather than anything a user could act on. b10603 has it; the tarball's sha256
 * below was verified against the download, not just copied from the API.
 */
export interface LlamaCppAsset {
  /** Asset file name within the release. */
  readonly name: string;
  /** Lowercase hex sha256 (from GitHub's asset digest). */
  readonly sha256: string;
  /** Asset size in bytes. */
  readonly sizeBytes: number;
}

export interface LlamaCppRelease {
  /** GitHub release tag, e.g. "b9934". */
  readonly tag: string;
  /** GitHub owner/repo. */
  readonly repo: string;
  /** macOS arm64 (Apple Silicon, Metal) asset. */
  readonly macosArm64: LlamaCppAsset;
}

export const PINNED_LLAMACPP: LlamaCppRelease = {
  tag: 'b10603',
  repo: 'ggml-org/llama.cpp',
  macosArm64: {
    name: 'llama-b10603-bin-macos-arm64.tar.gz',
    sha256: '8cffd63989a0301d8d487e32d248d1c8c24e010634ebe42a783122006a4127f2',
    sizeBytes: 10744173,
  },
};

/** Browser download URL for a pinned release asset. */
export function assetDownloadUrl(release: LlamaCppRelease, assetName: string): string {
  return `https://github.com/${release.repo}/releases/download/${release.tag}/${assetName}`;
}

/** GitHub API URL for a pinned release (exposes per-asset `digest`). */
export function releaseApiUrl(release: LlamaCppRelease): string {
  return `https://api.github.com/repos/${release.repo}/releases/tags/${release.tag}`;
}
