/**
 * Typed GGUF model catalog.
 *
 * HF-VERIFIED 2026-07-08/-10: the "verified: true" entries below were verified
 * live against Hugging Face (repo + file + `x-linked-size` bytes +
 * `x-linked-etag` LFS sha256, or the tree `lfs.oid`/`lfs.size`). Downloads
 * enforce sha256 when present and size only when > 0, so an entry may carry
 * `bytes: 0` + no sha to mean "known repo/quant, integrity not yet HEAD-verified"
 * (marked `verified: false`) without ever failing a real download's size assert.
 *
 * ROUND-12 expansion (data from round12-models.md, HF-verified 2026-07-10):
 *   - Vision was UNDERSTATED: gemma-4-E2B and EVERY Qwen `-MTP` repo actually
 *     ship an `mmproj` sibling (`image-text-to-text`). Their `input` now includes
 *     `'image'` — the fast-text launch is still text-only, but the on-demand
 *     multimodal restart flow can target them. (mmproj ⊥ MTP per launch.)
 *   - DFlash is REAL upstream now: `--spec-type draft-dflash` merged to llama.cpp
 *     master (PR #22105, 2026-06-28, release b9831+) — no fork. It is exposed as a
 *     third {@link SpecMethod} (`'dflash'`) and, per model, as a {@link SpecVariant}
 *     paired to a late-June (or newer) community draft repo. It does NOT exist for
 *     the <4B tier (smallest DFlash target is Qwen3.5-4B).
 *   - New reserved entries: Qwen3.5-0.8B/2B (genuine <4B fast picks, MTP), the
 *     sharded Qwen3.5-122B-A10B, and NVIDIA Nemotron-3-Nano-30B-A3B (NVIDIA Open
 *     Model License, NOT Apache). These carry accurate repo + quant labels but
 *     `bytes: 0` (size/sha not hand-verified here) → `verified: false`.
 *   - Every entry now carries an `engine` (llamacpp default; MLX foundation is a
 *     later wave), a `publisher` (HF handle + reliable-allowlist flag), a coarse
 *     `tier` hint, and the available speed `variants`.
 *
 * SUB-12B QUANT POLICY (round-17): every llama.cpp entry UNDER 12B params curates
 * a two-rung ladder — `Q8_0` (the default) + a dynamic `UD-Q6_K_XL` (the hard
 * floor) — and NO `Q4_K_M`. A small model at Q4 adds too much quality uncertainty
 * (a 4B loses more, proportionally, than a 27B), so Q8 is the default and the
 * Unsloth-Dynamic Q6 is the lowest we drop to when RAM is snug. Models >=12B keep
 * their existing Q4/Q6/UD ladder. The recommender (`sub12bQuant`) does the RAM-
 * tier pick. Q8_0 4B ≈ 4.3GB vs the old Q4_K_M ≈ 2.6GB; UD-Q6_K_XL 4B ≈ 4.0GB.
 * File bytes below are HF-verified live 2026-07-16 (`tree/main` `lfs.oid`/`size`).
 */

/** Inference engine backing a catalog entry. MLX is Apple-Silicon-only and is
 * reserved for a later wave; every current entry is `'llamacpp'` (GGUF). */
export type Engine = 'llamacpp' | 'mlx';

/** Per-launch server mode. MTP (fast-text) is mutually exclusive with mmproj. */
export type LaunchMode = 'fast-text' | 'multimodal';

/**
 * Coarse model-capability tier hint. Mirrors `ModelTier` in `@pi-desktop/harness`
 * (kept local so this low-level package does not depend on the harness). The
 * recommender's {@link resolveTierModels} is the authority for per-RAM resolution;
 * this per-model hint is a display/grouping aid for the model manager.
 */
export type ModelTier = 'fast' | 'balanced' | 'intelligent';

export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'intelligent'];

export interface CatalogFile {
  /** GGUF file name within the HF repo (`resolve/main/<name>`). */
  readonly name: string;
  /** File size in bytes; 0 = unknown/unverified (no size assertion on download). */
  readonly bytes: number;
  /** Quantization label, e.g. "Q4_K_M", "Q6_K", "UD-Q4_K_M". */
  readonly quant: string;
  /** Lowercase hex sha256, when verified. */
  readonly sha256?: string;
}

/**
 * Speculative-decoding speed method a catalog entry ships (see catalog note).
 * All three run on stock upstream llama.cpp (`draft-mtp` / `draft-eagle3` /
 * `draft-dflash`); DFlash landed upstream 2026-06-28 (b9831+), no fork.
 */
export type SpecMethod = 'mtp' | 'eagle3' | 'dflash';

/** One speed variant a model can launch with (surfaced in the manager's
 * [MTP / EAGLE3 / DFlash] variant dropdown). */
export interface SpecVariant {
  readonly method: SpecMethod;
  /** True when the head is embedded in the main GGUF (no separate draft file). */
  readonly embedded?: boolean;
  /** HF repo the draft GGUF lives in (EAGLE3/DFlash), when separate from `hfRepo`. */
  readonly draftRepo?: string;
  /** The draft GGUF, when its sha/size are HEAD-verified; undefined for reserved. */
  readonly draftModel?: CatalogFile;
}

/** The HF publisher hosting the GGUF + whether it is in the round-12 reliable
 * allowlist (Unsloth / Bartowski / ggml-org / NVIDIA / Qwen / Google / DeepMind /
 * mlx-community / lmstudio-community). Community re-quanters (mradermacher, etc.)
 * are NOT reliable. */
export interface ModelPublisher {
  readonly handle: string;
  readonly reliable: boolean;
}

/**
 * REPUTABLE-ORGANISATION ALLOWLIST, tagged by what each org is known for.
 *
 * the user: "the initial reccomended items should show verified organizations…
 * unsloth moonshot deepseek, qwen, nvidia, lighttricks, black forest etc. put a
 * list together starting with that that are the repuatable organizations."
 *
 * HF has no verified-org flag its search API exposes, so this IS the trust
 * signal: a hand-curated list of orgs whose repos are worth leading with. It is
 * tagged by domain because the hub is multi-modal now — when someone filters to
 * image models, "recommended" should mean black-forest-labs and stabilityai,
 * not the LLM labs. `reliableAuthorsForDomains` reads these tags.
 *
 * `gguf` marks the re-quant hosts that package OTHER labs' models to run locally
 * — how a text model actually gets used here — so they ride along with text.
 *
 * Handles are the exact HF org names (case is normalised at the lookup).
 */
export type PublisherDomain = 'text' | 'image' | 'video' | 'audio' | 'embeddings' | '3d' | 'gguf';

export interface ReliablePublisher {
  readonly handle: string;
  readonly domains: readonly PublisherDomain[];
}

export const RELIABLE_PUBLISHER_LIST: readonly ReliablePublisher[] = [
  // GGUF / local-run hosts — how text models get run in this app.
  { handle: 'unsloth', domains: ['gguf', 'text'] },
  { handle: 'bartowski', domains: ['gguf', 'text'] },
  { handle: 'ggml-org', domains: ['gguf', 'text'] },
  { handle: 'mlx-community', domains: ['gguf', 'text'] },
  { handle: 'lmstudio-community', domains: ['gguf', 'text'] },
  // First-party LLM / VLM labs.
  { handle: 'Qwen', domains: ['text'] },
  { handle: 'deepseek-ai', domains: ['text'] },
  { handle: 'meta-llama', domains: ['text'] },
  { handle: 'mistralai', domains: ['text'] },
  { handle: 'google', domains: ['text', 'embeddings'] },
  { handle: 'microsoft', domains: ['text', '3d'] },
  { handle: 'nvidia', domains: ['text', 'audio'] },
  { handle: 'moonshotai', domains: ['text'] },
  { handle: 'zai-org', domains: ['text', 'video'] },
  { handle: 'openai', domains: ['text', 'audio'] },
  { handle: 'allenai', domains: ['text'] },
  { handle: 'ibm-granite', domains: ['text'] },
  { handle: 'HuggingFaceTB', domains: ['text'] },
  { handle: 'tiiuae', domains: ['text'] },
  { handle: 'CohereLabs', domains: ['text'] },
  { handle: 'baidu', domains: ['text'] },
  { handle: 'openbmb', domains: ['text'] },
  { handle: 'internlm', domains: ['text'] },
  { handle: 'NousResearch', domains: ['text'] },
  // Institute of Foundation Models (MBZUAI) — K2 Horizon, Apache-2.0, weights
  // and training lifecycle published together.
  { handle: 'IFM', domains: ['text'] },
  { handle: 'THUDM', domains: ['text', 'video'] },
  { handle: 'BAAI', domains: ['text', 'embeddings'] },
  // Image generation.
  { handle: 'black-forest-labs', domains: ['image'] },
  { handle: 'stabilityai', domains: ['image', '3d'] },
  { handle: 'playgroundai', domains: ['image'] },
  { handle: 'Kwai-Kolors', domains: ['image'] },
  { handle: 'ByteDance', domains: ['image', 'video'] },
  { handle: 'shakker-labs', domains: ['image'] },
  // Video generation.
  { handle: 'Lightricks', domains: ['video'] },
  { handle: 'Wan-AI', domains: ['video'] },
  { handle: 'genmo', domains: ['video'] },
  { handle: 'tencent', domains: ['video', '3d'] },
  { handle: 'rhymes-ai', domains: ['video'] },
  { handle: 'Skywork', domains: ['video'] },
  // Audio / speech.
  { handle: 'facebook', domains: ['audio', 'text'] },
  { handle: 'fixie-ai', domains: ['audio'] },
  { handle: 'hexgrad', domains: ['audio'] },
  { handle: 'SWivid', domains: ['audio'] },
  { handle: 'coqui', domains: ['audio'] },
  { handle: 'amphion', domains: ['audio'] },
  // Embeddings / retrieval.
  { handle: 'sentence-transformers', domains: ['embeddings'] },
  { handle: 'intfloat', domains: ['embeddings'] },
  { handle: 'mixedbread-ai', domains: ['embeddings'] },
  { handle: 'Alibaba-NLP', domains: ['embeddings', 'text'] },
  { handle: 'nomic-ai', domains: ['embeddings'] },
  { handle: 'jinaai', domains: ['embeddings'] },
  // 3D generation.
  { handle: 'VAST-AI-Research', domains: ['3d'] },
];

/** Flat handle list — what `isReliablePublisher` checks and the hub filters on. */
export const RELIABLE_PUBLISHERS: readonly string[] = RELIABLE_PUBLISHER_LIST.map((p) => p.handle);

/**
 * The default "Recommended" fan-out: a cross-domain top set for when no modality
 * filter is active. Leads with the GGUF hosts and the biggest LLM labs (the
 * common case) and seeds one image lab so the grid is not all text.
 */
export const DEFAULT_RECOMMENDED_AUTHORS: readonly string[] = [
  'unsloth',
  'bartowski',
  'ggml-org',
  'Qwen',
  'deepseek-ai',
  'meta-llama',
  'mistralai',
  'google',
  'microsoft',
  'nvidia',
  'moonshotai',
  'black-forest-labs',
];

/**
 * The reputable orgs for a set of domains, for the modality-aware fan-out.
 * Ordered by how many of the requested domains each covers, so the most relevant
 * orgs are queried first under the fan-out cap.
 */
export function reliableAuthorsForDomains(
  domains: readonly PublisherDomain[],
  limit = 16,
): string[] {
  if (domains.length === 0) return [...DEFAULT_RECOMMENDED_AUTHORS];
  const want = new Set(domains);
  const scored = RELIABLE_PUBLISHER_LIST.map((p) => ({
    handle: p.handle,
    score: p.domains.filter((d) => want.has(d)).length,
  }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((p) => p.handle);
}

/**
 * Case-insensitive on purpose: HF handles are shown with their published
 * capitalisation ('Qwen', 'BAAI') but arrive from search exactly as the author
 * typed them, and an exact-match test quietly answered "not reliable" for the
 * very orgs this list exists to name.
 */
export function isReliablePublisher(handle: string): boolean {
  const want = handle.toLowerCase();
  return RELIABLE_PUBLISHERS.some((h) => h.toLowerCase() === want);
}

/** Convenience: an `unsloth`-hosted (reliable) publisher. */
const UNSLOTH: ModelPublisher = { handle: 'unsloth', reliable: true };

/** Convenience: an `mlx-community`-hosted (reliable) publisher — the MLX org. */
const MLX_COMMUNITY: ModelPublisher = { handle: 'mlx-community', reliable: true };

export interface CatalogModel {
  readonly id: string;
  readonly displayName: string;
  /** HuggingFace repo, e.g. "unsloth/gemma-4-E2B-it-GGUF". */
  readonly hfRepo: string;
  /**
   * Canonical BASE (non-GGUF) repo that carries the authoritative
   * `chat_template.jinja`, e.g. "google/gemma-4-E2B-it". When set, the launcher
   * fetches + caches that template and passes `--jinja --chat-template-file`
   * (see `chat-template.ts`) so llama.cpp routes to the model's real chat/tool
   * parser instead of the GGUF's embedded (often stale) template. Usually gated
   * — the fetch uses the plumbed HF token. General-purpose: any model may set it.
   */
  readonly baseRepo?: string;
  /** Main GGUF file(s). Multiple entries = user picks a quant. */
  readonly files: readonly CatalogFile[];
  /** Vision projector sibling (multimodal launch). */
  readonly mmproj?: CatalogFile;
  /** Separate MTP head sibling (Gemma4 style). Undefined when embedded. */
  readonly mtpFile?: CatalogFile;
  /** True when the MTP head is embedded in the main GGUF (Qwen3.6 style). */
  readonly mtpEmbedded?: boolean;
  /**
   * Launch WITHOUT speculative decoding even though this model has a head.
   *
   * A speed head is an optimisation, not a fact about the model, and it does not
   * always pay: on Qwen3.8-27B it MEASURED 17–32% SLOWER than plain decoding
   * (see that entry). The head stays declared — `mtpEmbedded` is a true
   * statement about the file — and this says only that we choose not to use it,
   * which keeps the data honest and the reason in one place.
   */
  readonly specDisabled?: boolean;
  /**
   * The DEFAULT speed method used by the current launch path for a fast-text
   * launch (`--spec-type draft-<spec>`). See {@link variants} for the full set of
   * speed options a model supports (what the manager's variant dropdown offers).
   */
  readonly spec?: SpecMethod;
  /** HF repo the (EAGLE-3) draft lives in, when different from {@link hfRepo}. */
  readonly draftRepo?: string;
  /** EAGLE-3/DFlash draft GGUF (paired via `--model-draft`); undefined for MTP. */
  readonly draftModel?: CatalogFile;
  /** All speed variants this model can launch with (MTP / EAGLE3 / DFlash). */
  readonly variants?: readonly SpecVariant[];
  readonly license: string;
  /** Minimum system RAM (GB) to run this comfortably. */
  readonly minRamGB: number;
  readonly contextWindow: number;
  readonly input: readonly ('text' | 'image')[];
  /** True when the HF repo is gated (needs an accepted licence / token). */
  readonly gated?: boolean;
  /** True only for HEAD-verified repo/file/sha/size. */
  readonly verified: boolean;
  /** Inference engine (default 'llamacpp' when omitted). */
  readonly engine?: Engine;
  /** HF publisher + reliable-allowlist flag. */
  readonly publisher?: ModelPublisher;
  /** Coarse tier hint for grouping/sorting in the model manager. */
  readonly tier?: ModelTier;
  /**
   * What the model is FOR. Undefined means a chat model — the picker, the
   * quick menu and the model screen list it, pi registers it, a session can
   * select it. Anything else is a tool's private model: it downloads through
   * the same machinery and lives in the same directory, but never appears as a
   * thing to talk to. OmniSVG is the first — a Qwen2.5-VL fine-tune whose
   * entire output is SVG tokens, useless as a conversation partner and exactly
   * right behind the `svg` command.
   */
  readonly purpose?: 'chat' | 'svg';
  /** True when the quants are split into multiple shards (needs shard-join on
   * download/launch — a follow-up; reserved entries only for now). */
  readonly sharded?: boolean;
  /** Human-readable available-quant range (e.g. "Q3–Q8 + UD + IQ"). */
  readonly quantRange?: string;
  /**
   * The GGUF's own `general.architecture`, when this model needs an engine the
   * shipped llama.cpp release does not have.
   *
   * Only set it when it MATTERS — it is the routing key for engine variants
   * (llamacpp-variants.ts), not documentation. A model whose architecture the
   * pinned release already knows leaves this undefined and launches on the
   * pinned binary like everything else. Read it out of the file header rather
   * than guessing from the model's name: they are frequently different, and this
   * string decides which binary runs.
   */
  readonly architecture?: string;
}

// ---------------------------------------------------------------------------
// Gemma4 family — publisher `unsloth` (base `google`). All vision-capable.
// ---------------------------------------------------------------------------

/** Verified utility/fast model — small, fast, fits every tier. Now vision-capable
 * (mmproj sibling) so the on-demand multimodal flow can target it. */
export const GEMMA4_E2B: CatalogModel = {
  id: 'gemma-4-e2b-it',
  displayName: 'Gemma 4 E2B Instruct',
  hfRepo: 'unsloth/gemma-4-E2B-it-GGUF',
  baseRepo: 'google/gemma-4-E2B-it',
  // SUB-12B QUANT POLICY: a model under 12B params never ships a Q4 default — a
  // small model at Q4 adds too much quality uncertainty. Q8_0 is the default; the
  // dynamic Q6 floor (Unsloth `UD-Q6_K_XL`) is the hard floor the recommender
  // drops to only when RAM is snug (see `sub12bQuant` in recommender.ts).
  files: [
    {
      name: 'gemma-4-E2B-it-Q8_0.gguf',
      bytes: 5_048_350_848,
      quant: 'Q8_0',
      sha256: '0a8488b149e1f700712c35d5bf0a3795f9dcc2563b4944d5ef2fb89375f9483e',
    },
    {
      name: 'gemma-4-E2B-it-UD-Q6_K_XL.gguf',
      bytes: 4_710_086_784,
      quant: 'UD-Q6_K_XL',
      sha256: '23b9129abcd9db1df6e35aafeb3e43c65448dac7f114aa02b30fdf29b9db303d',
    },
  ],
  // E2B DOES ship vision (mmproj-F16, 985,654,080 B ≈ 0.918 GiB); sha not
  // HEAD-verified here (doc gives a 16-hex prefix only) so it is omitted.
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 985_654_080,
    quant: 'F16',
  },
  // Gemma4 MTP head ships as a separate Q8_0 sibling in the same repo.
  mtpFile: {
    name: 'mtp-gemma-4-E2B-it.gguf',
    bytes: 97_817_664,
    quant: 'Q8_0',
    sha256: '9eba819938efccfd6044f8af84e3bbfddc639a2bcf32ebc36420e6a649191919',
  },
  spec: 'mtp',
  variants: [{ method: 'mtp' }],
  license: 'Gemma',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

const GEMMA4_E4B: CatalogModel = {
  id: 'gemma-4-e4b-it',
  displayName: 'Gemma 4 E4B Instruct',
  hfRepo: 'unsloth/gemma-4-E4B-it-GGUF',
  baseRepo: 'google/gemma-4-E4B-it',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  files: [
    {
      name: 'gemma-4-E4B-it-Q8_0.gguf',
      bytes: 8_192_951_456,
      quant: 'Q8_0',
      sha256: 'a2232a649523c36bf530f1dc3614eb8c800645c4227390381c8b05d4d6eee05a',
    },
    {
      name: 'gemma-4-E4B-it-UD-Q6_K_XL.gguf',
      bytes: 7_457_760_416,
      quant: 'UD-Q6_K_XL',
      sha256: '718b86f1d3e2928df914e7abf83a5342ef752fb7a7e900d5ff036952709ea72f',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 990_372_672,
    quant: 'F16',
    sha256: 'ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51',
  },
  mtpFile: {
    name: 'mtp-gemma-4-E4B-it.gguf',
    bytes: 98_653_248,
    quant: 'Q8_0',
    sha256: 'b6a723115efa510d3b3215db1e26790dae84cd08c2134a764f3d194f1f0c3376',
  },
  spec: 'mtp',
  variants: [{ method: 'mtp' }],
  license: 'Gemma',
  minRamGB: 8,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

const GEMMA4_12B: CatalogModel = {
  id: 'gemma-4-12b-it',
  displayName: 'Gemma 4 12B Instruct',
  hfRepo: 'unsloth/gemma-4-12b-it-GGUF',
  baseRepo: 'google/gemma-4-12b-it',
  files: [
    {
      name: 'gemma-4-12b-it-Q4_K_M.gguf',
      bytes: 7_121_860_000,
      quant: 'Q4_K_M',
      sha256: '43fec98c5102b1c446b4ddd0a9439f1db3a2e1f2e0b8cd143ce1ea619a9403d6',
    },
    {
      name: 'gemma-4-12b-it-Q6_K.gguf',
      bytes: 9_786_021_280,
      quant: 'Q6_K',
      sha256: 'e1602ddc224c159584eb4c7d6a6c8d682fc6afb2efb8f76c10bfd63ba71436a2',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 175_115_840,
    quant: 'F16',
    sha256: '91f086971e56d7a7d8d39e271873fccdb49541bd259d6e02c401a4f1cb7a219e',
  },
  mtpFile: {
    name: 'mtp-gemma-4-12b-it.gguf',
    bytes: 465_109_248,
    quant: 'Q8_0',
    sha256: '145db9094bc0f85f1701e255a2ed216dcc9800fc8bc8631ad00905b456bd451b',
  },
  spec: 'mtp',
  // MTP sibling + a late-June DFlash draft (upstream draft-dflash).
  variants: [
    { method: 'mtp' },
    { method: 'dflash', draftRepo: 'williamliao/gemma-4-12B-it-DFlash-GGUF' },
  ],
  license: 'Gemma',
  minRamGB: 16,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Gemma4 26B-A4B MoE (fast active params + MTP): a strong 32–48GB vision pick. */
const GEMMA4_26B_A4B: CatalogModel = {
  id: 'gemma-4-26b-a4b-it',
  displayName: 'Gemma 4 26B-A4B Instruct',
  hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
  baseRepo: 'google/gemma-4-26B-A4B-it',
  // Repo ships only UD-quants at the Q4/Q6 tiers (no plain Q4_K_M/Q6_K).
  files: [
    {
      name: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
      bytes: 16_947_539_744,
      quant: 'UD-Q4_K_M',
      sha256: '34c746b1d50ab813e29cd46c4796e3f43c741901a582f93a67b55b9fc9687b35',
    },
    {
      name: 'gemma-4-26B-A4B-it-UD-Q6_K.gguf',
      bytes: 23_172_476_704,
      quant: 'UD-Q6_K',
      sha256: 'd3d9e6a63845bdc83e9f9fc5923e77c023ccc1197c9e145e6a8754bad80b5d75',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 1_193_058_784,
    quant: 'F16',
    sha256: '418a6d8723067cd712235facbbc5cba6c8fbbd413fc1292d2aace5a027d5a42f',
  },
  mtpFile: {
    name: 'mtp-gemma-4-26B-A4B-it.gguf',
    bytes: 461_766_816,
    quant: 'Q8_0',
    sha256: '6326fb9f5e487aa8dcdd313a091e3c67724cb2a666ec3b7d2895b5b26d93ed1b',
  },
  spec: 'mtp',
  // MTP sibling + the OFFICIAL RedHatAI EAGLE3 speculator (docs-cited) + a DFlash
  // draft. DFlash on a quantized MoE target can regress on weak GPUs (#25117) —
  // MTP stays the safe default.
  variants: [
    { method: 'mtp' },
    { method: 'eagle3', draftRepo: 'RedHatAI/gemma-4-26B-A4B-it-speculator.eagle3' },
    { method: 'dflash', draftRepo: 'Anbeeld/gemma-4-26B-A4B-it-DFlash-GGUF' },
  ],
  license: 'Gemma',
  minRamGB: 24,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'UD-Q4_K_M / UD-Q6_K / MXFP4_MOE / Q8_0',
};

/** Gemma4 31B dense (+ MTP): the high-tier vision-capable pick. */
const GEMMA4_31B: CatalogModel = {
  id: 'gemma-4-31b-it',
  displayName: 'Gemma 4 31B Instruct',
  hfRepo: 'unsloth/gemma-4-31B-it-GGUF',
  baseRepo: 'google/gemma-4-31B-it',
  files: [
    {
      name: 'gemma-4-31B-it-Q4_K_M.gguf',
      bytes: 18_323_731_456,
      quant: 'Q4_K_M',
      sha256: '9fdf3dc8b0384830b4402d151388c140bd8eb2abf8d60588d8224231198254a1',
    },
    {
      name: 'gemma-4-31B-it-Q6_K.gguf',
      bytes: 25_201_484_800,
      quant: 'Q6_K',
      sha256: 'abd0be03a2bc3f3c9d8e018cbb4ff5b553c340c65d49b6b346c48be5a1efde28',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 1_198_957_024,
    quant: 'F16',
    sha256: '6edcca228213c28d3567a35d22f849eea52d8360875093851959adf5d2f270eb',
  },
  mtpFile: {
    name: 'mtp-gemma-4-31B-it.gguf',
    bytes: 514_687_104,
    quant: 'Q8_0',
    sha256: '5ae8b0117bed601e8924c6305bd5b0585de361d51f0e77091bcb4252cf1f27de',
  },
  spec: 'mtp',
  variants: [
    { method: 'mtp' },
    { method: 'eagle3', draftRepo: 'RedHatAI/gemma-4-31B-it-speculator.eagle3' },
    { method: 'dflash', draftRepo: 'williamliao/gemma-4-31B-it-DFlash-GGUF' },
  ],
  license: 'Gemma',
  minRamGB: 24,
  contextWindow: 128_000,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'Q3–Q8 + UD + IQ',
};

// ---------------------------------------------------------------------------
// Qwen3.5 family — publisher `unsloth`, Apache-2.0. -MTP repos embed the head
// and are all vision-capable (mmproj sibling).
// ---------------------------------------------------------------------------

/** Qwen3.5 0.8B (embedded MTP): ultra-light <4B floor for the weakest machines. */
const QWEN35_0_8B_MTP: CatalogModel = {
  id: 'qwen3.5-0.8b-mtp',
  displayName: 'Qwen3.5 0.8B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-0.8B-MTP-GGUF',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  // Reserved entry — bytes:0 / verified:false (repo ships both; not HEAD-verified).
  files: [
    { name: 'Qwen3.5-0.8B-Q8_0.gguf', bytes: 0, quant: 'Q8_0' },
    { name: 'Qwen3.5-0.8B-UD-Q6_K_XL.gguf', bytes: 0, quant: 'UD-Q6_K_XL' },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // No EAGLE3/DFlash drafts exist for <4B models — MTP only.
  variants: [{ method: 'mtp', embedded: true }],
  license: 'Apache-2.0',
  minRamGB: 4,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Qwen3.5 2B (embedded MTP): a genuine <4B fast pick. */
const QWEN35_2B_MTP: CatalogModel = {
  id: 'qwen3.5-2b-mtp',
  displayName: 'Qwen3.5 2B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-2B-MTP-GGUF',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  // Reserved entry — bytes:0 / verified:false (repo ships both; not HEAD-verified).
  files: [
    { name: 'Qwen3.5-2B-Q8_0.gguf', bytes: 0, quant: 'Q8_0' },
    { name: 'Qwen3.5-2B-UD-Q6_K_XL.gguf', bytes: 0, quant: 'UD-Q6_K_XL' },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  variants: [{ method: 'mtp', embedded: true }],
  license: 'Apache-2.0',
  minRamGB: 4,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/**
 * Qwen3.5 4B (embedded MTP): the DEFAULT small / worker model — the fast-tier
 * speed pick AND the harness utility/classifier model (title generation, the
 * rung-2 tool-call fixer, classifier escalation). Its Qwen3.5 hybrid attention
 * (~75% Gated DeltaNet linear layers + ~25% full GQA) gives ~4× smaller KV
 * cache and ~4× faster prefill than a dense model of similar size — a big win
 * for `-np` parallel utility workers and prompt prefill. `baseRepo` points at
 * Qwen's canonical (non-gated) `chat_template.jinja` so the launcher routes to
 * the real Qwen tool-call parser via `--jinja --chat-template-file` (see
 * chat-template.ts), the same reason the Gemma-4 family declares one.
 */
const QWEN35_4B_MTP: CatalogModel = {
  id: 'qwen3.5-4b-mtp',
  displayName: 'Qwen3.5 4B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-4B-MTP-GGUF',
  baseRepo: 'Qwen/Qwen3.5-4B',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 (~4.3GB) is the DEFAULT worker
  // quant — no Q4 for the 4B (too much quality uncertainty for the utility/
  // classifier roles). UD-Q6_K_XL (~4.0GB) is the dynamic floor when RAM is snug.
  files: [
    {
      name: 'Qwen3.5-4B-Q8_0.gguf',
      bytes: 4_610_580_800,
      quant: 'Q8_0',
      sha256: '4f40ff26e3b6e23888e520e9c33d9a309d919b940cd1375b421710c6cb6cc8dd',
    },
    {
      name: 'Qwen3.5-4B-UD-Q6_K_XL.gguf',
      bytes: 4_261_908_800,
      quant: 'UD-Q6_K_XL',
      sha256: '28bedf3269ebb40444dab71cf884d85ad639fd57cfc30757a62b7929d4e316de',
    },
  ],
  // Real size (HF content-length for unsloth/Qwen3.5-4B-MTP-GGUF), not the 0
  // placeholder this carried. `bytes: 0` was being ENFORCED as an expectation by
  // the completion check in ./download.ts, so this projector's `.part` could never
  // be promoted — and the DEFAULT model therefore had no vision at all.
  mmproj: { name: 'mmproj-F16.gguf', bytes: 672_423_488, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // Smallest DFlash target in-family is 4B (late-June draft).
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'dflash', draftRepo: 'Anbeeld/Qwen3.5-4B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'fast',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Qwen3.5 9B (embedded MTP): the 16GB-tier speed pick. */
const QWEN35_9B_MTP: CatalogModel = {
  id: 'qwen3.5-9b-mtp',
  displayName: 'Qwen3.5 9B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-9B-MTP-GGUF',
  // Sub-12B quant policy (see GEMMA4_E2B): Q8_0 default, UD-Q6_K_XL dynamic floor.
  files: [
    {
      name: 'Qwen3.5-9B-Q8_0.gguf',
      bytes: 9_786_061_152,
      quant: 'Q8_0',
      sha256: '107125cda29dc42d62f5ba8ffac8817d21a9d7bd06c1b35860491a00a170ad4e',
    },
    {
      name: 'Qwen3.5-9B-UD-Q6_K_XL.gguf',
      bytes: 8_987_439_456,
      quant: 'UD-Q6_K_XL',
      sha256: 'a6d6c0ace780ea91d59a3ef5050a96b6ebbf416d94e6b23c191d1f492a6276f0',
    },
  ],
  /*
   * REAL bytes + hash. This was `bytes: 0` with no sha256 — a placeholder that
   * named a file nobody had checked existed. `bytes: 0` also means "unverified"
   * elsewhere in this catalog, so the download had no size to report and no
   * integrity check to run, and the model came up vision-blind while the app
   * reported it as image-capable. Taken from the repo's paths-info, not guessed.
   */
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 918_165_984,
    quant: 'F16',
    sha256: '5a40d1f771686432172a4981018a0d30d03a5aaf5793a5badd5416573362a232',
  },
  // The MTP head ships INSIDE the weights here (hence the -MTP- repo), so there
  // is no sibling draft file to fetch and `--model-draft` must not be passed.
  mtpEmbedded: true,
  spec: 'mtp',
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'dflash', draftRepo: 'Anbeeld/Qwen3.5-9B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 12,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/** Qwen3.5 122B-A10B MoE (embedded MTP): the top-tier local pick. Heavily
 * SHARDED — every quant ≥ UD-IQ3_S splits into 3–5 files (shard-join is a
 * follow-up), so this is a reserved entry (bytes 0, verified false) for now. */
const QWEN35_122B_A10B_MTP: CatalogModel = {
  id: 'qwen3.5-122b-a10b-mtp',
  displayName: 'Qwen3.5 122B-A10B (MTP)',
  hfRepo: 'unsloth/Qwen3.5-122B-A10B-MTP-GGUF',
  files: [
    { name: 'Qwen3.5-122B-A10B-UD-Q4_K_M-00001-of-00003.gguf', bytes: 0, quant: 'UD-Q4_K_M' },
    { name: 'Qwen3.5-122B-A10B-UD-Q6_K-00001-of-00004.gguf', bytes: 0, quant: 'UD-Q6_K' },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  variants: [{ method: 'mtp', embedded: true }],
  license: 'Apache-2.0',
  minRamGB: 80,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  sharded: true,
  quantRange: 'UD ladder + MXFP4_MOE + Q8_0 (multi-shard ≥ UD-IQ3_S)',
};

// ---------------------------------------------------------------------------
// Qwen3.6 family — publisher `unsloth`, Apache-2.0, vision via mmproj.
// ---------------------------------------------------------------------------

const QWEN36_27B_MTP: CatalogModel = {
  id: 'qwen3.6-27b-mtp',
  displayName: 'Qwen3.6 27B (MTP)',
  hfRepo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  files: [
    {
      name: 'Qwen3.6-27B-Q4_K_M.gguf',
      bytes: 17_106_773_120,
      quant: 'Q4_K_M',
      sha256: 'a7cbd3ecc0e3f9b333edee61ae66bc87ed713c5d49587a8355814722ed329e0f',
    },
    {
      name: 'Qwen3.6-27B-Q6_K.gguf',
      bytes: 22_884_406_400,
      quant: 'Q6_K',
      sha256: '773f1bf0be0589d056ce05476a8a135b50494a3f2ecc3f8f0c4f2c3594bba02e',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // The best-tested DFlash target (PR benchmarks it); EAGLE3 is community-only.
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'eagle3', draftRepo: 'gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF' },
    { method: 'dflash', draftRepo: 'williamliao/qwen3.6-27B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'Q3–Q8 + UD + IQ',
};

/**
 * Qwen3.8 27B — the 24GB-tier intelligence pick, released 2026-08-14.
 *
 * MEASURED from the GGUF's own metadata (`gguf-dump` of UD-Q3_K_XL), because
 * this generation is not shaped like the last one:
 *
 *   general.architecture      = qwen35   (llama.cpp's arch id for the family)
 *   qwen35.block_count        = 65
 *   qwen35.nextn_predict_layers = 1      → the MTP head is EMBEDDED (blk.64.nextn.*)
 *   qwen35.attention.head_count_kv = 4
 *   qwen35.full_attention_interval = 4   ┐ hybrid: full attention every 4th layer,
 *   qwen35.ssm.{state_size,inner_size…}  ┘ SSM state in between
 *   qwen35.context_length     = 262144
 *
 * The hybrid SSM layers matter for sizing: only every fourth block holds a
 * growing KV cache, so the real footprint is well under what `estimateRamGB`'s
 * dense-attention heuristic predicts. The heuristic errs toward "too big",
 * which is the safe direction, so it is left alone rather than special-cased.
 *
 * QUANTS. UD-Q3_K_XL (13.4 GB) is the entry a 24 GB Mac actually wants — with a
 * 64k window it lands ≈18.5 GB of a 19.2 GB budget. UD-Q4_K_XL (17.9 GB) does
 * NOT fit here despite being the family's usual default, which is exactly the
 * case the Model Manager's per-quant fit badge exists to show.
 *
 * CHAT TEMPLATE. the user: "use this chat template", froggeric's Qwen-Fixed set (v22,
 * 2026-08-13, covers 3.5/3.6/3.8). It ships `chat_template.jinja` at the repo
 * root, which is precisely what `baseRepo` fetches — the field is documented as
 * "the repo that carries the authoritative chat_template.jinja", not necessarily
 * the base MODEL repo. It fixes KV-cache invalidation, empty-think poisoning and
 * a tool-argument parse crash; the first of those is the recurring TTFT killer
 * here, so it is not a cosmetic choice.
 */
const QWEN38_27B_MTP: CatalogModel = {
  id: 'qwen3.8-27b-mtp',
  displayName: 'Qwen3.8 27B (MTP)',
  hfRepo: 'unsloth/Qwen3.8-27B-GGUF',
  baseRepo: 'froggeric/Qwen-Fixed-Chat-Templates',
  files: [
    {
      name: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
      bytes: 13_441_059_904,
      quant: 'UD-Q3_K_XL',
      sha256: '00cf92e666c6af6566996c38c89a44ccdb6449ea25ef0f112a452c853b2a71e2',
    },
    {
      name: 'Qwen3.8-27B-UD-Q2_K_XL.gguf',
      bytes: 10_676_423_744,
      quant: 'UD-Q2_K_XL',
      sha256: '46151b52a5cad673d90a00222103254864326c251130b8fc4381d6f34386b3c8',
    },
  ],
  mmproj: {
    name: 'mmproj-F16.gguf',
    bytes: 927_607_488,
    quant: 'F16',
    sha256: 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e',
  },
  mtpEmbedded: true,
  spec: 'mtp',
  /*
   * THE SPEED HEAD IS REAL AND IT MAKES THIS MODEL SLOWER. Measured on this M5
   * Pro, UD-Q3_K_XL, froggeric v22 template, three prompts each:
   *
   *              64k ctx     16k ctx
   *   MTP on     11.2 tok/s  14.0 tok/s
   *   MTP off    16.4 tok/s  16.8 tok/s
   *              −32%        −17%
   *
   * Speculative decoding only pays when the draft is accepted often enough to
   * cover its cost; on this hybrid attention/SSM architecture it clearly is not.
   * The head is still declared — that is a true statement about the file — and
   * `specDisabled` records that we choose not to launch with it.
   *
   * A NOTE ON A FAILURE I FIRST BLAMED ON MTP AND SHOULD NOT HAVE: this model
   * also returns HTTP 500 "Compute error." on every completion when launched
   * with `--mmproj` at a 64k window. The first failing launch happened to carry
   * both flags, so I wrote it up as an MTP/projector incompatibility. It is
   * neither — it is the MEMORY BUDGET: weights + projector + 64k KV comes to
   * ≈19.7 GB against ≈19.2 GB usable, and llama-server loads anyway and fails at
   * generation. Fixed where it belongs, by feeding the projector's bytes into
   * `chooseContextCap` so the window steps down to 48k and vision survives.
   * The tok/s numbers above were measured without a projector on both sides, so
   * they are unaffected.
   */
  specDisabled: true,
  /* MTP only. The DSpark / DFlash / EAGLE-3 repos that exist for this model are
     community re-uploads in non-GGUF formats today; naming one here would
     advertise a launch that cannot resolve. */
  variants: [{ method: 'mtp', embedded: true }],
  license: 'Apache-2.0',
  minRamGB: 24,
  /* The model allows 256k. This is what a 24 GB machine can actually hold, and
     `chooseContextCap` steps down from here anyway. */
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'Q2–Q8 + UD + IQ',
};

const QWEN36_35B_A3B_MTP: CatalogModel = {
  id: 'qwen3.6-35b-a3b-mtp',
  displayName: 'Qwen3.6 35B-A3B (MTP)',
  hfRepo: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  // Repo ships only UD-quants; plain Q4_K_M/Q6_K do not exist. UD-Q4_K_M is the
  // Q4-class pick, UD-Q6_K the Q6-class pick.
  files: [
    {
      name: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
      bytes: 22_663_387_424,
      quant: 'UD-Q4_K_M',
      sha256: '0b21525e972670ed59e1812e170b27c26355381f0656ecc4e25617ece7dac58b',
    },
    {
      name: 'Qwen3.6-35B-A3B-UD-Q6_K.gguf',
      bytes: 30_011_242_784,
      quant: 'UD-Q6_K',
      sha256: '49935b04ad883c2f3d4da61f65b609d447dad67d0b08453b90abb09a1bb35464',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  mtpEmbedded: true,
  spec: 'mtp',
  // DFlash on a quantized MoE target can regress on weak GPUs (#25117) — MTP safe.
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'dflash', draftRepo: 'Anbeeld/Qwen3.6-35B-A3B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 28,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'UD-Q4_K_M / UD-Q6_K / MXFP4_MOE / Q8_0',
};

/**
 * Qwen3.6 27B plain base with EAGLE-3 (and DFlash) draft-model speculative
 * decoding. The plain base (`unsloth/Qwen3.6-27B-GGUF`) is paired with a
 * community EAGLE-3 draft from a SEPARATE repo, launched as
 * `--spec-type draft-eagle3 --model-draft <draft>`. Encoded to exercise the
 * cross-repo draft-model wiring; MTP (the embedded `qwen3.6-27b-mtp` above) is
 * the simpler default for most users.
 */
const QWEN36_27B_EAGLE3: CatalogModel = {
  id: 'qwen3.6-27b-eagle3',
  displayName: 'Qwen3.6 27B (EAGLE-3)',
  hfRepo: 'unsloth/Qwen3.6-27B-GGUF',
  files: [
    {
      name: 'Qwen3.6-27B-Q4_K_M.gguf',
      bytes: 16_817_244_384,
      quant: 'Q4_K_M',
      sha256: '5ed60d0af4650a854b1755bd392f9aef4872643dc25a254bc68043fa638392a0',
    },
    {
      name: 'Qwen3.6-27B-Q6_K.gguf',
      bytes: 22_523_238_624,
      quant: 'Q6_K',
      sha256: 'ec1805fe87e6519c461c1ed2d179865464a875ed241032ead65a354f979cfe14',
    },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' },
  spec: 'eagle3',
  draftRepo: 'gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF',
  draftModel: {
    name: 'Qwen3.6-27B-PRISM-EAGLE3_Q4_K_M.gguf',
    bytes: 1_290_881_632,
    quant: 'Q4_K_M',
    sha256: '296550cca35276756a7f8c45787f0a21d53f769ea13cea4ff25e5346d75a512c',
  },
  variants: [
    {
      method: 'eagle3',
      draftRepo: 'gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF',
      draftModel: {
        name: 'Qwen3.6-27B-PRISM-EAGLE3_Q4_K_M.gguf',
        bytes: 1_290_881_632,
        quant: 'Q4_K_M',
        sha256: '296550cca35276756a7f8c45787f0a21d53f769ea13cea4ff25e5346d75a512c',
      },
    },
    { method: 'dflash', draftRepo: 'williamliao/qwen3.6-27B-DFlash-GGUF' },
  ],
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'intelligent',
  quantRange: 'Q3–Q8 + UD + IQ',
};

// ---------------------------------------------------------------------------
// NVIDIA Nemotron — current gen Nemotron-3. NVIDIA Open Model License (NOT
// Apache). Reserved entry (bytes 0, verified false) — the full quant ladder is
// on `unsloth/`, hosted (reliable) even though NVIDIA authored the weights.
// ---------------------------------------------------------------------------

/** Nemotron-3-Nano-30B-A3B MoE (A3B active → fast for its size). Text-only. */
const NEMOTRON3_NANO_30B_A3B: CatalogModel = {
  id: 'nemotron-3-nano-30b-a3b',
  displayName: 'NVIDIA Nemotron-3 Nano 30B-A3B',
  hfRepo: 'unsloth/Nemotron-3-Nano-30B-A3B-GGUF',
  files: [
    { name: 'Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf', bytes: 0, quant: 'Q4_K_M' },
    { name: 'Nemotron-3-Nano-30B-A3B-Q4_K_S.gguf', bytes: 0, quant: 'Q4_K_S' },
  ],
  // Text-only; no speculative-decoding variant ships for this model.
  license: 'NVIDIA Open Model License',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text'],
  verified: false,
  engine: 'llamacpp',
  publisher: UNSLOTH,
  tier: 'balanced',
  quantRange: 'Q4_K_M / Q4_K_S / IQ4_XS + more',
};

// ---------------------------------------------------------------------------
// MLX (Apple-Silicon) foundation — round-12. `engine:'mlx'` entries are served
// by `mlx_lm.server` (via uv), NOT llama.cpp; the artifact is an
// `mlx-community/*` safetensors repo, not a GGUF. These are gated `darwin+arm64`
// (see `isMlxSupported`) and opt-in behind the "Prefer MLX" engine preference.
// Reserved (bytes 0, verified false): `mlx_lm.server` auto-downloads the repo on
// first launch, so there is no single-file sha/size to HEAD-verify here. MLX has
// no MTP/EAGLE parity and (in the text engine) no vision → text-only, no variants.
// ---------------------------------------------------------------------------

/** Qwen3.5 4B (MLX 4-bit): the MLX fast-tier proof model. */
const MLX_QWEN35_4B: CatalogModel = {
  id: 'mlx-qwen3.5-4b-4bit',
  displayName: 'Qwen3.5 4B (MLX 4-bit)',
  hfRepo: 'mlx-community/Qwen3.5-4B-MLX-4bit',
  files: [{ name: 'Qwen3.5-4B-MLX-4bit', bytes: 0, quant: 'MLX-4bit' }],
  license: 'Apache-2.0',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text'],
  verified: false,
  engine: 'mlx',
  publisher: MLX_COMMUNITY,
  tier: 'fast',
  quantRange: 'MLX-4bit / MLX-8bit',
};

/** Qwen3.5 9B (MLX 4-bit): the MLX balanced-tier pick. */
const MLX_QWEN35_9B: CatalogModel = {
  id: 'mlx-qwen3.5-9b-4bit',
  displayName: 'Qwen3.5 9B (MLX 4-bit)',
  hfRepo: 'mlx-community/Qwen3.5-9B-MLX-4bit',
  files: [{ name: 'Qwen3.5-9B-MLX-4bit', bytes: 0, quant: 'MLX-4bit' }],
  license: 'Apache-2.0',
  minRamGB: 12,
  contextWindow: 65_536,
  input: ['text'],
  verified: false,
  engine: 'mlx',
  publisher: MLX_COMMUNITY,
  tier: 'balanced',
  quantRange: 'MLX-4bit / MLX-8bit',
};

/** Qwen3.6 27B (MLX mixed-precision OptiQ 4-bit): the MLX intelligent-tier pick. */
const MLX_QWEN36_27B: CatalogModel = {
  id: 'mlx-qwen3.6-27b-optiq',
  displayName: 'Qwen3.6 27B (MLX OptiQ 4-bit)',
  hfRepo: 'mlx-community/Qwen3.6-27B-OptiQ-4bit',
  files: [{ name: 'Qwen3.6-27B-OptiQ-4bit', bytes: 0, quant: 'OptiQ-4bit' }],
  license: 'Apache-2.0',
  minRamGB: 24,
  contextWindow: 65_536,
  input: ['text'],
  verified: false,
  engine: 'mlx',
  publisher: MLX_COMMUNITY,
  tier: 'intelligent',
  quantRange: 'OptiQ-4bit (KL-sensitivity mixed precision)',
};

/**
 * Ling 3.0 Tiny — a 7.9B MoE with ~0.8B active (128 experts, 8 used).
 *
 * Read straight out of the GGUF header rather than trusted from a card:
 * `general.architecture = bailingmoe3`, 128 experts x 1.0B, 8 used, 24 blocks,
 * 131072 context. That architecture is why the pinned llama.cpp had to move —
 * b9934 knows `bailingmoe` and `bailingmoe2` only, so every Ling 3.0 build
 * would have failed to load with an unknown-architecture error.
 *
 * WHY IT IS WORTH A SLOT. The active-parameter count is what decides speed, and
 * 0.8B active puts it in Qwen3.5-2B territory for tokens/sec while carrying
 * 7.9B of total weights' worth of knowledge. That trade is the whole argument
 * for small MoEs, and this is the current one.
 *
 * QUANTS from bloomer010 rather than unsloth, who have not published this repo
 * — the user checked: "no direct from unsloth but this seems to have everything
 * ... dynamic 2.0 still". The UD- builds there are Unsloth Dynamic 2.0.
 */
const LING3_TINY: CatalogModel = {
  id: 'ling-3.0-tiny',
  displayName: 'Ling 3.0 Tiny',
  hfRepo: 'bloomer010/Ling-3.0-tiny-GGUF',
  baseRepo: 'inclusionAI/Ling-3.0-tiny',
  files: [
    {
      name: 'Ling-3.0-tiny-UD-Q6_K_XL.gguf',
      bytes: 7_274_546_528,
      quant: 'UD-Q6_K_XL',
      sha256: 'a31376fc9c56309046cff6c43888adf180c5c40fa48228ef644937ee9bd5d64b',
    },
    {
      name: 'Ling-3.0-tiny-UD-Q4_K_XL.gguf',
      bytes: 5_340_611_552,
      quant: 'UD-Q4_K_XL',
      sha256: '7faee4091379ce1c644e09dd88848a8f0bc3348a216d2ee1c90a5388de6a5b13',
    },
  ],
  license: 'MIT',
  // An MoE's resident cost is its TOTAL weights, not its active ones — the
  // router can reach any expert on any token, so all 128 have to be in memory.
  minRamGB: 12,
  contextWindow: 32_768,
  input: ['text'],
  verified: true,
  engine: 'llamacpp',
  publisher: { handle: 'bloomer010', reliable: false },
  tier: 'fast',
  quantRange: 'Q1–Q8 + UD + IQ',
};

/**
 * K2 Horizon 0.9B (IFM) — the first catalog model that cannot run on the
 * shipped engine.
 *
 * Everything about this entry is read from the artefacts rather than the
 * announcement. The GGUF header says `general.architecture = k2-horizon`, 28
 * blocks, 1536 embedding, 32 heads over 8 KV heads, 131072 context with YaRN at
 * factor 16 — and the pinned b10603 libllama has no `k2-horizon` in it at all,
 * so this loads only on the variant built from IFM's fork
 * (llamacpp-variants.ts). That is the whole reason `architecture` exists.
 *
 * BF16 IS THE ONLY QUANT, and that is not an oversight to fix later: IFM
 * publishes exactly one file per size, in the original precision. So this is
 * 2.16GB for a 0.9B model where a Q8 would be under 1GB, and the 7B/32B/36B
 * members are 14/64/72GB — which is why only this one is here. `quantRange`
 * says so rather than implying a choice the repo does not offer.
 *
 * `baseRepo` carries the authoritative `chat_template.jinja`: the fork added its
 * own copy of the template, and pointing at the model's own is what keeps tool
 * calling honest when the two drift.
 */
export const K2_HORIZON_0_9B: CatalogModel = {
  id: 'k2-horizon-0.9b',
  displayName: 'K2 Horizon 0.9B',
  hfRepo: 'IFM/K2-Horizon-0.9B-GGUF',
  /*
   * NO `baseRepo`, DELIBERATELY — the one case where the base repo's template is
   * the wrong one to use. IFM's `chat_template.jinja` is 51KB of full-fat Jinja
   * written for transformers and vLLM, and llama.cpp's minja cannot parse it:
   * "Parser Error: Expected %} (Got true)", which makes llama-server refuse to
   * start at all. The GGUF ships a llama.cpp-compatible template of its own (the
   * fork added `models/templates/k2-horizon.jinja` alongside the conversion
   * code), so the embedded one is both correct and the only one that works.
   *
   * The launcher would now catch this anyway — it asks the engine whether a
   * template is parseable before passing it — but declaring a base repo whose
   * template is known to be unusable would be stating something false.
   */
  architecture: 'k2-horizon',
  files: [
    {
      name: 'K2-Horizon-1B-BF16.gguf',
      bytes: 2_159_424_896,
      quant: 'BF16',
      sha256: '371010db1807bb07b62e738422ee0de26c1e15a347f31108ed2c6e219095a8b8',
    },
  ],
  license: 'Apache-2.0',
  // BF16 weights (2.16GB) plus a KV cache the context-cap sizes to the machine.
  minRamGB: 8,
  contextWindow: 131_072,
  input: ['text'],
  verified: true,
  engine: 'llamacpp',
  publisher: { handle: 'IFM', reliable: true },
  tier: 'fast',
  quantRange: 'BF16 only (no quants published)',
};

/**
 * MiniCPM5 2B — the user's first queued small model.
 *
 * TEXT ONLY. The repo publishes three GGUFs and no mmproj, so there is no
 * vision tower to load: this model cannot be given a screenshot, which is why
 * it is not in the computer-use matrix. It is here to be measured on the work
 * that does not need eyes.
 */
const MINICPM5_2B: CatalogModel = {
  id: 'minicpm5-2b',
  displayName: 'MiniCPM5 2B',
  hfRepo: 'openbmb/MiniCPM5-2B-GGUF',
  files: [
    {
      name: 'MiniCPM5-2B-Q8_0.gguf',
      bytes: 2_679_710_688,
      quant: 'Q8_0',
      sha256: 'c5415f8989bf88a8288f1b55a3cc371af53c07b0faa220a63bd7a990cfaba078',
    },
  ],
  license: 'Apache-2.0',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text'],
  verified: true,
  engine: 'llamacpp',
  publisher: { handle: 'openbmb', reliable: true },
  tier: 'fast',
  quantRange: 'Q4_K_M–F16',
};

/**
 * Nanbeige 4.2 3B — the user's second queued small model.
 *
 * Also text only, and from bartowski rather than the model's own org: Nanbeige
 * publish no GGUF themselves. Q8_0 for the same reason as MiniCPM's — at this
 * size the whole file fits several times over, so there is no reason to measure
 * a quantisation artefact and call it the model.
 */
const NANBEIGE42_3B: CatalogModel = {
  id: 'nanbeige4.2-3b',
  displayName: 'Nanbeige 4.2 3B',
  hfRepo: 'bartowski/Nanbeige_Nanbeige4.2-3B-GGUF',
  baseRepo: 'Nanbeige/Nanbeige4.2-3B',
  files: [
    {
      name: 'Nanbeige4.2-3B-Q8_0.gguf',
      bytes: 4_434_787_488,
      quant: 'Q8_0',
      sha256: '837ba713ef3a3b5c9aee82e5dcba07600ea7db36ae392419f982b3bfaec04ef2',
    },
  ],
  license: 'Apache-2.0',
  minRamGB: 8,
  contextWindow: 32_768,
  input: ['text'],
  verified: true,
  engine: 'llamacpp',
  publisher: { handle: 'bartowski', reliable: true },
  tier: 'fast',
  quantRange: 'IQ2_M–Q8_0',
};

// ---------------------------------------------------------------------------
// OmniSVG — a tool's model, not a chat model (`purpose: 'svg'`).
// ---------------------------------------------------------------------------

/**
 * OmniSVG 1.1 4B — text/image → SVG. Qwen2.5-VL-3B with its vocabulary grown to
 * 197,000 entries: everything it generates is an SVG token (command,
 * coordinate on a 200×200 grid, arc parameter, 12-bit colour), decoded by
 * `@pi-desktop/gen-service`'s `decodeOmniSvg`, which is checked byte-for-byte
 * against the authors' own decoder.
 *
 * Converted here from the authors' PyTorch checkpoint (state dict → HF layout →
 * llama.cpp `convert_hf_to_gguf.py` at the app's pinned release → Q8_0), with
 * the GGUF's eos set to their end-of-SVG token (196999) rather than the chat
 * template's <|im_end|>, so the server stops where the model does. The 45k
 * SVG ids ride along as `[PADn]` tokens — llama.cpp pads a vocab gap that way —
 * and the server hands back ids with `return_tokens`. MEASURED on this M5 Pro:
 * 5s load, 58-66 tok/s, a heart in 23 tokens. bf16 was needed for the
 * PyTorch reference (fp16 on Metal returned a black square); Q8 matches it.
 *
 * Text-only conversions of the 8B exist on the Hub; this 4B build with its
 * vision tower (mmproj) for image-to-SVG is ours. Apache-2.0 upstream.
 */
export const OMNISVG_1_1_4B: CatalogModel = {
  id: 'omnisvg-1.1-4b',
  displayName: 'OmniSVG 1.1 4B',
  hfRepo: 'Lavanuke/OmniSVG1.1_4B-GGUF',
  baseRepo: 'OmniSVG/OmniSVG1.1_4B',
  files: [
    {
      name: 'OmniSVG1.1_4B-Q8_0.gguf',
      bytes: 3_813_241_984,
      quant: 'Q8_0',
      sha256: 'bf9ff5a186c86d0654f28c8da101cf167b4d3776bf8277e2ad433d9a9f192fd6',
    },
  ],
  mmproj: {
    name: 'mmproj-OmniSVG1.1_4B-F16.gguf',
    bytes: 1_338_428_000,
    quant: 'F16',
    sha256: 'fcb8d6a6b850d389c4906538214adf617735827c65096f56005e7f0856fdff25',
  },
  license: 'Apache-2.0',
  minRamGB: 8,
  contextWindow: 4_096,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  // The GGUF lives on the user's account (our conversion); the upstream is
  // `baseRepo`. A personal account is not on the reliable-publisher list, and
  // that is the truthful value: this quant is ours, not OmniSVG's.
  publisher: { handle: 'Lavanuke', reliable: false },
  tier: 'fast',
  purpose: 'svg',
  quantRange: 'Q8_0',
};

export const CATALOG: readonly CatalogModel[] = [
  OMNISVG_1_1_4B,
  GEMMA4_E2B,
  GEMMA4_E4B,
  GEMMA4_12B,
  GEMMA4_26B_A4B,
  GEMMA4_31B,
  QWEN35_0_8B_MTP,
  QWEN35_2B_MTP,
  MINICPM5_2B,
  NANBEIGE42_3B,
  QWEN35_4B_MTP,
  QWEN35_9B_MTP,
  LING3_TINY,
  K2_HORIZON_0_9B,
  QWEN35_122B_A10B_MTP,
  QWEN36_27B_MTP,
  QWEN36_35B_A3B_MTP,
  QWEN36_27B_EAGLE3,
  QWEN38_27B_MTP,
  NEMOTRON3_NANO_30B_A3B,
  MLX_QWEN35_4B,
  MLX_QWEN35_9B,
  MLX_QWEN36_27B,
];

/** All MLX (Apple-Silicon) catalog entries — the opt-in `engine:'mlx'` set. */
export const MLX_MODELS: readonly CatalogModel[] = CATALOG.filter(
  (m) => (m.engine ?? 'llamacpp') === 'mlx',
);

const BY_ID = new Map(CATALOG.map((m) => [m.id, m]));

export function getCatalogModel(id: string): CatalogModel | undefined {
  return BY_ID.get(id);
}

/** Find a specific quant within a model, by exact quant label. */
export function getCatalogFile(model: CatalogModel, quant: string): CatalogFile | undefined {
  return model.files.find((f) => f.quant === quant);
}

/** The inference engine for a model (defaults to 'llamacpp' when unset). */
export function modelEngine(model: CatalogModel): Engine {
  return model.engine ?? 'llamacpp';
}

/**
 * WHERE HUGGING FACE IS, for this process.
 *
 * `HF_ENDPOINT` is the variable `huggingface_hub` itself honours, so a machine
 * already pointed at a mirror — an enterprise cache, an air-gapped proxy — is
 * pointed there once and everything follows, including the Python side of this
 * app, which has read it all along. It is also the seam a download stress test
 * needs: driving concurrency, mid-flight cancellation and resume-from-partial
 * against the real host would mean moving tens of gigabytes to observe seconds
 * of behaviour.
 *
 * Read per call rather than captured, so a probe can set it before launching
 * the app and a long-lived process is not pinned to whatever was in the
 * environment at import time. Trailing slashes are trimmed, because a mirror
 * URL pasted from a browser has one and `//resolve/` 404s on some proxies.
 */
export function hfEndpoint(): string {
  const raw = typeof process === 'undefined' ? undefined : process.env?.HF_ENDPOINT;
  const base = raw === undefined || raw.trim() === '' ? 'https://huggingface.co' : raw.trim();
  return base.replace(/\/+$/, '');
}

/** HF `resolve/main` download URL for a catalog file. */
export function hfResolveUrl(repo: string, fileName: string): string {
  return `${hfEndpoint()}/${repo}/resolve/main/${fileName}`;
}
