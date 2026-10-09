/**
 * MAGE-FLOW WITHOUT MICROSOFT'S REPOS — the release, rebuilt byte for byte.
 *
 * WHAT HAPPENED. Checked 2026-09-23: every `microsoft/Mage-Flow-*` repo (Base,
 * the RL model, Turbo and the three Edit variants) answers the Hugging Face API
 * with 401 "Invalid username or password" — exactly what a repo that does not
 * exist answers. Not gated: a gated repo (meta-llama/*, briaai/RMBG-2.0) still
 * serves its metadata anonymously. Withdrawn: microsoft's `mage` collection now
 * lists only Mage-VL and Mage-ViT, and microsoft's own Mage-Flow Space is in
 * RUNTIME_ERROR. The MIT code (github.com/microsoft/Mage) is still public. So a
 * fresh install could fetch neither the 3D module's image model nor the chat's
 * `edit_image` model.
 *
 * WHERE THE BYTES ARE NOW. The diffusers checkpoint was four things, and all of
 * them are still published under their own licences, byte-identical to the
 * release — checked against the original trees saved at download time beside
 * The user's copies (`~/Bobble/Models/Image/{Generation,Editing}/microsoft__mage-flow-*`):
 *
 *  - `transformer/diffusion_pytorch_model.safetensors` IS Comfy-Org/Mage-Flow's
 *    `diffusion_models/mage_flow_{turbo,edit_turbo}_bf16.safetensors` (same
 *    sha256; ComfyUI's own org, MIT, ungated);
 *  - `vae/diffusion_pytorch_model.safetensors` IS Comfy-Org's
 *    `vae/mage_flow_vae_bf16.safetensors` (same sha256);
 *  - `text_encoder/` IS Qwen/Qwen3-VL-4B-Instruct, every file (same git blob
 *    ids and LFS sha256s; Apache-2.0) — the repo CubePart already downloads;
 *  - four small configs (1.5 KB) no live repo carries. They are below,
 *    verbatim; `mage-flow-release.test.ts` checks their git blob ids against
 *    the release's.
 *
 * The sidecar downloads those pieces and assembles the diffusers directory
 * (symlinks into the hub cache, plus the configs) that both engines load:
 * the mflux Mage-Flow port (`--model <dir> --base-model …`) and the PyTorch
 * `MageFlowPipeline.from_pretrained(<dir>)`.
 *
 * WHY NOT A COMMUNITY MIRROR. At least nine full copies exist
 * (mage-flow-community/*, natalie5/*, arifqai/* …) and every one checked is
 * byte-identical — but an anonymous mirror of a withdrawn model is the least
 * durable place to point an app at, and the pieces cost less: the Turbo and
 * Edit-Turbo checkpoints share 9.2 GB (text encoder + VAE), so the editor adds
 * 8.2 GB to an install that has the generator instead of 17.5, and nothing at
 * all for the text encoder where CubePart is installed.
 *
 * EXISTING INSTALLS keep what they have: a complete `microsoft/*` snapshot on
 * disk still counts as installed and is what the workers load (`legacyRepos`),
 * so nobody re-downloads 17 GB because the source moved.
 */
import type { Gen3dLayoutEntry, Gen3dPinnedFile, Gen3dRepoSpec } from './catalog';

/** ComfyUI's repackaging of the release (MIT): transformers and VAE as single files. */
export const MAGE_FLOW_COMFY_REPO = 'Comfy-Org/Mage-Flow';
/** The text encoder the release shipped under `text_encoder/`, unchanged (Apache-2.0). */
export const MAGE_FLOW_TEXT_ENCODER_REPO = 'Qwen/Qwen3-VL-4B-Instruct';

/**
 * sha256 of the release's large files — which is what the hub reports as an
 * LFS file's etag, and what its cache names the blob. Read from the original
 * trees (microsoft/Mage-Flow-Turbo @ 34f3a2d2, microsoft/Mage-Flow-Edit-Turbo
 * @ 14427bd7) and matched, file for file, on Comfy-Org/Mage-Flow @ 6ff68fbf
 * and Qwen/Qwen3-VL-4B-Instruct @ ebb281ec on 2026-09-23.
 */
export const MAGE_FLOW_SHA256 = {
  turboTransformer: '6df47df3d7efc9ebdad075b87b3e9e4f74d09dca672d592271788f0ee27ab97d',
  editTurboTransformer: '29c3726ecd64afe149eef28af3e27b6b40de52646bfd16757a37da4b6fbcf288',
  vae: '34e076dc1e8a15321e1e07be5111d59cf16dd10b804b7c7e20b4de29013427e0',
  textEncoderShard1: '30a01a0556622645a3cce87b655bbbbbc1f170c196099f1b666c93202c3339a9',
  textEncoderShard2: '046296a2a387efb43b0c997d5833c789604d168834f6e0d3064bf7bb13d002a6',
} as const;

const TRANSFORMER_BYTES = 8_231_536_760;
const VAE_BYTES = 345_053_056;
const SHARD1_BYTES = 4_967_229_296;
const SHARD2_BYTES = 3_908_490_048;

/**
 * Qwen3-VL-4B-Instruct exactly as CubePart fetches it — the same repo, patterns
 * and byte total — so the two features share one download and one snapshot.
 */
export const MAGE_FLOW_TEXT_ENCODER: Gen3dRepoSpec = {
  repo: MAGE_FLOW_TEXT_ENCODER_REPO,
  allowPatterns: ['*.json', '*.safetensors', '*.txt'],
  bytes: 8_887_284_080,
  pinned: [
    {
      path: 'model-00001-of-00002.safetensors',
      bytes: SHARD1_BYTES,
      sha256: MAGE_FLOW_SHA256.textEncoderShard1,
    },
    {
      path: 'model-00002-of-00002.safetensors',
      bytes: SHARD2_BYTES,
      sha256: MAGE_FLOW_SHA256.textEncoderShard2,
    },
  ],
};

/* The four configs of the release, byte for byte (Turbo and Edit-Turbo ship
   identical copies). Kept as lines so a diff reads; `join('\n')` restores the
   exact bytes — only the scheduler's file ends with a newline. */
const MODEL_INDEX_JSON = [
  '{',
  '  "_class_name": "MageFlowPipeline",',
  '  "_mage_flow_version": "0.1.0",',
  '  "transformer": [',
  '    "mage_flow",',
  '    "MageFlow"',
  '  ],',
  '  "vae": [',
  '    "mage_flow",',
  '    "MageVAE"',
  '  ],',
  '  "text_encoder": [',
  '    "transformers",',
  '    "Qwen3VLForConditionalGeneration"',
  '  ],',
  '  "tokenizer": [',
  '    "transformers",',
  '    "AutoProcessor"',
  '  ],',
  '  "scheduler": [',
  '    "diffusers",',
  '    "FlowMatchEulerDiscreteScheduler"',
  '  ],',
  '  "_text_encoder_path": "text_encoder",',
  '  "_vae_source": "vae/diffusion_pytorch_model.safetensors"',
  '}',
].join('\n');

const SCHEDULER_CONFIG_JSON = [
  '{',
  '  "_class_name": "FlowMatchEulerDiscreteScheduler",',
  '  "_diffusers_version": "0.37.0",',
  '  "num_train_timesteps": 1000,',
  '  "use_dynamic_shifting": false,',
  '  "shift": 6.0',
  '}',
  '',
].join('\n');

const TRANSFORMER_CONFIG_JSON = [
  '{',
  '  "in_channels": 128,',
  '  "out_channels": 128,',
  '  "vec_in_dim": 0,',
  '  "context_in_dim": 2560,',
  '  "hidden_size": 3072,',
  '  "mlp_ratio": 4.0,',
  '  "num_heads": 24,',
  '  "depth": 12,',
  '  "depth_single_blocks": 0,',
  '  "axes_dim": [',
  '    16,',
  '    56,',
  '    56',
  '  ],',
  '  "theta": 10000,',
  '  "patch_size": 1,',
  '  "qkv_bias": true,',
  '  "guidance_embed": false,',
  '  "checkpoint": false,',
  '  "rope_type": "msrope",',
  '  "time_type": "qwen_proj",',
  '  "double_block_type": "double_stream",',
  '  "vec_type": null,',
  '  "apply_text_rotary_emb": false,',
  '  "_class_name": "MageFlow",',
  '  "txt_max_length": 2048,',
  '  "max_sequence_length": 2048,',
  '  "param_dtype": "bfloat16",',
  '  "packing": true,',
  '  "schedule_mode": "z-image",',
  '  "static_shift": 6.0,',
  '  "use_time_shift": false',
  '}',
].join('\n');

const VAE_CONFIG_JSON = [
  '{',
  '  "_class_name": "MageVAE",',
  '  "latent_channels": 128,',
  '  "downsample_factor": 16,',
  '  "sample_posterior": false',
  '}',
].join('\n');

/** The release's small files, path → exact content. */
export const MAGE_FLOW_CONFIGS: Readonly<Record<string, string>> = {
  'model_index.json': MODEL_INDEX_JSON,
  'scheduler/scheduler_config.json': SCHEDULER_CONFIG_JSON,
  'transformer/config.json': TRANSFORMER_CONFIG_JSON,
  'vae/config.json': VAE_CONFIG_JSON,
};

/** Patterns the release's repos were fetched with (the old catalog's). */
const LEGACY_PATTERNS = ['transformer/*', 'text_encoder/*', 'vae/*', 'scheduler/*', '*.json'];
/** Those patterns' byte total on either release repo (measured from the saved trees). */
const LEGACY_BYTES = 17_463_884_035;

export type MageFlowVariant = 'turbo' | 'edit-turbo';

interface MageFlowSource {
  /** What a fresh install downloads. */
  readonly repos: readonly Gen3dRepoSpec[];
  /** The diffusers directory the workers load, assembled from `repos`. */
  readonly layout: readonly Gen3dLayoutEntry[];
  /** The withdrawn release repo — honoured on disk, never fetched. */
  readonly legacyRepos: readonly Gen3dRepoSpec[];
}

function transformerFile(variant: MageFlowVariant): Gen3dPinnedFile {
  return variant === 'turbo'
    ? {
        path: 'diffusion_models/mage_flow_turbo_bf16.safetensors',
        bytes: TRANSFORMER_BYTES,
        sha256: MAGE_FLOW_SHA256.turboTransformer,
      }
    : {
        path: 'diffusion_models/mage_flow_edit_turbo_bf16.safetensors',
        bytes: TRANSFORMER_BYTES,
        sha256: MAGE_FLOW_SHA256.editTurboTransformer,
      };
}

const VAE_FILE: Gen3dPinnedFile = {
  path: 'vae/mage_flow_vae_bf16.safetensors',
  bytes: VAE_BYTES,
  sha256: MAGE_FLOW_SHA256.vae,
};

/** Everything the catalog needs for one Mage-Flow checkpoint. */
export function mageFlowSource(variant: MageFlowVariant): MageFlowSource {
  const transformer = transformerFile(variant);
  const comfy: Gen3dRepoSpec = {
    repo: MAGE_FLOW_COMFY_REPO,
    // Exactly the two files: the repo also carries eight other variants
    // (~50 GB) this checkpoint does not use.
    allowPatterns: [transformer.path, VAE_FILE.path],
    bytes: transformer.bytes + VAE_FILE.bytes,
    pinned: [transformer, VAE_FILE],
  };
  const layout: Gen3dLayoutEntry[] = [
    ...Object.entries(MAGE_FLOW_CONFIGS).map(
      ([path, text]): Gen3dLayoutEntry => ({ kind: 'text', path, text }),
    ),
    {
      kind: 'file',
      path: 'transformer/diffusion_pytorch_model.safetensors',
      repo: MAGE_FLOW_COMFY_REPO,
      source: transformer.path,
    },
    {
      kind: 'file',
      path: 'vae/diffusion_pytorch_model.safetensors',
      repo: MAGE_FLOW_COMFY_REPO,
      source: VAE_FILE.path,
    },
    { kind: 'dir', path: 'text_encoder', repo: MAGE_FLOW_TEXT_ENCODER_REPO },
  ];
  const legacy: Gen3dRepoSpec = {
    repo: variant === 'turbo' ? 'microsoft/Mage-Flow-Turbo' : 'microsoft/Mage-Flow-Edit-Turbo',
    allowPatterns: LEGACY_PATTERNS,
    bytes: LEGACY_BYTES,
    pinned: [
      { ...transformer, path: 'transformer/diffusion_pytorch_model.safetensors' },
      { ...VAE_FILE, path: 'vae/diffusion_pytorch_model.safetensors' },
      ...(MAGE_FLOW_TEXT_ENCODER.pinned ?? []).map((f) => ({
        ...f,
        path: `text_encoder/${f.path}`,
      })),
    ],
  };
  return { repos: [comfy, MAGE_FLOW_TEXT_ENCODER], layout, legacyRepos: [legacy] };
}
