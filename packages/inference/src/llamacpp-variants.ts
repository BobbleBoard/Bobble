/**
 * ENGINE VARIANTS — how a model architecture the shipped engine does not know
 * gets one that does.
 *
 * The pinned release (llamacpp-manifest.ts) is the engine for everything, and
 * that is the right default: one binary, one sha, one thing to trust. But a
 * genuinely new architecture lands in a model repo BEFORE it lands in a
 * llama.cpp release, and the gap is weeks. Until now the only lever was to bump
 * the pin — which works when upstream already has the code (b9934 → b10603 for
 * `bailingmoe3`) and cannot work at all when the code lives in the model
 * author's own fork with an open PR against upstream. In that case the app's
 * answer today is an unknown-architecture error the user cannot act on.
 *
 * So: a variant is an ADDITIONAL engine build, declared here, that provides
 * named architectures. Nothing else changes. A model whose GGUF says
 * `general.architecture = <arch>` is launched with the variant's `llama-server`;
 * every other model keeps the pinned one, byte for byte.
 *
 * ## Why this retires itself
 *
 * A fork is a temporary state of the world, and a pipeline that needs a human to
 * notice when it is over will keep a stale fork alive for months. So the
 * question "does the shipped engine handle this yet?" is asked of the BINARY
 * rather than of a comment: {@link architecturesIn} reads the arch identifiers
 * out of libllama, the same way the b10603 bump was verified. Bump the pin, and
 * any variant whose architectures the new pin covers stops being used — no code
 * change, no release note, no one remembering.
 *
 * ## Adding one
 *
 *   1. Read the GGUF header for its `general.architecture` (that string is the
 *      routing key; it is NOT the model's marketing name).
 *   2. Find the build that supports it — a fork branch, a PR, a tag.
 *   3. Pin the exact COMMIT, never the branch: a branch is a moving target and
 *      this is a binary users execute.
 *   4. Add an entry below with the reason and the upstream PR, so the next
 *      person can see what it is waiting on.
 *   5. Add the model to the catalog with the same `architecture` string.
 *
 * That is the whole pipeline. The build itself is llamacpp-source-build.ts.
 */

/** Where a variant's source comes from. Pinned to a commit, never a branch. */
export interface VariantSource {
  /** GitHub owner/repo, e.g. "MBZUAI-IFM/llama.cpp". */
  readonly repo: string;
  /** The human-facing ref this commit came from ("model/K2Horizon"). Display only. */
  readonly ref: string;
  /** Full 40-char commit sha. THIS is what gets built. */
  readonly commit: string;
}

export interface LlamaCppVariant {
  /** Stable id; also the cache directory name. */
  readonly id: string;
  /** Shown wherever the app has to explain why a second engine exists. */
  readonly displayName: string;
  /**
   * GGUF `general.architecture` values this build adds. Routing is by
   * architecture and not by model id on purpose: one fork usually brings a whole
   * family, and the next model in it should work without a code change.
   */
  readonly architectures: readonly string[];
  readonly source: VariantSource;
  /** One sentence for the user: what this is and why it is not the normal engine. */
  readonly why: string;
  /** The upstream PR that will make this unnecessary, when there is one. */
  readonly upstreamPr?: string;
}

/**
 * K2 Horizon (IFM). The GGUFs are published; upstream llama.cpp cannot read
 * them. MEASURED against the pinned b10603 libllama: it exports `bailingmoe3`,
 * `qwen35` and `deepseek2`, and has no `k2-horizon` at all — so every K2 GGUF
 * fails to load on the shipped engine, whatever the user does.
 *
 * The model card names the fork as the current answer, and the PR to upstream is
 * described there as in progress:
 * https://huggingface.co/IFM/K2-Horizon-0.9B-GGUF
 */
export const K2_HORIZON_VARIANT: LlamaCppVariant = {
  id: 'k2-horizon',
  displayName: 'llama.cpp (K2 Horizon)',
  architectures: ['k2-horizon'],
  source: {
    repo: 'MBZUAI-IFM/llama.cpp',
    ref: 'model/K2Horizon',
    // "model: K2 Horizon chat template and accomodate safetensors naming",
    // 2026-09-01 — the branch head when this was pinned. Five commits on top of
    // upstream 4e97ac86: gguf conversion, hparams/tensor loading, the compute
    // graph, tokenizer registration, and the chat template.
    commit: '35999d101cf2233fc54f09c3c8d599da7303ce02',
  },
  why: 'K2 Horizon needs a llama.cpp build from IFM’s own fork — upstream support is still in review.',
  upstreamPr: 'https://github.com/ggml-org/llama.cpp/pulls?q=k2+horizon',
};

/** Every declared variant. */
export const LLAMACPP_VARIANTS: readonly LlamaCppVariant[] = [K2_HORIZON_VARIANT];

/** The variant that provides `architecture`, if one is declared. */
export function variantForArchitecture(architecture: string): LlamaCppVariant | undefined {
  const want = architecture.trim().toLowerCase();
  if (want === '') return undefined;
  return LLAMACPP_VARIANTS.find((v) => v.architectures.some((a) => a.toLowerCase() === want));
}

export type EngineChoice =
  /** The pinned release — the answer for everything the shipped engine knows. */
  | { readonly kind: 'pinned'; readonly reason: 'supported' | 'no-variant' }
  /** A declared variant, because the pinned engine does not know this arch. */
  | { readonly kind: 'variant'; readonly variant: LlamaCppVariant };

/**
 * Which engine should run a model of this architecture.
 *
 * `pinnedArchitectures` is what the SHIPPED binary actually exports (see
 * {@link architecturesIn}) — pass it and a variant retires itself the moment a
 * pin bump covers its architecture. Omit it and the declared variant is used
 * whenever one matches, which is the safe answer when the binary cannot be read
 * (not installed yet, another platform, `strings` unavailable).
 */
export function resolveEngine(
  architecture: string | undefined,
  pinnedArchitectures?: ReadonlySet<string>,
): EngineChoice {
  if (architecture === undefined || architecture.trim() === '') {
    return { kind: 'pinned', reason: 'no-variant' };
  }
  const arch = architecture.trim().toLowerCase();
  if (pinnedArchitectures?.has(arch) === true) return { kind: 'pinned', reason: 'supported' };
  const variant = variantForArchitecture(arch);
  return variant === undefined
    ? { kind: 'pinned', reason: 'no-variant' }
    : { kind: 'variant', variant };
}

/**
 * The architecture identifiers a llama.cpp build knows, read out of the binary.
 *
 * llama.cpp holds them in a table of plain ASCII names (`LLM_ARCH_QWEN35` ↔
 * "qwen35"), so they are literally present in libllama — which makes "does this
 * engine handle this model?" a question about the artefact rather than about our
 * notes. Deliberately conservative: it only reports names it was ASKED about, so
 * an unrelated string in the binary can never be mistaken for an architecture.
 *
 * Returns undefined when the file cannot be read, which callers must treat as
 * "unknown", not as "no".
 */
export function architecturesIn(
  bytes: Uint8Array,
  candidates: readonly string[],
): ReadonlySet<string> {
  const text = Buffer.from(bytes).toString('latin1');
  const found = new Set<string>();
  for (const name of candidates) {
    // NUL-delimited on both sides: llama.cpp's table holds C strings, so "qwen3"
    // must not match inside "qwen35" and give a wrong answer with confidence.
    if (text.includes(`\0${name}\0`)) found.add(name.toLowerCase());
  }
  return found;
}

/** Every architecture any declared variant claims — the candidate set to scan for. */
export function variantArchitectures(): readonly string[] {
  return LLAMACPP_VARIANTS.flatMap((v) => v.architectures);
}
