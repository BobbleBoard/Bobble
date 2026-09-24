# Ming-Image 0.1 Design models ("antling ming 0.1"): research and plan

Track 9 of the 2026-09-23 push. Research only, written 2026-09-23 against repo HEAD `c9fe7098`.
Nothing was run on the GPU and nothing was downloaded beyond configs, safetensors headers
(HTTP range reads) and source files. Every speed and memory figure for this Mac below is either
**someone else's measurement (cited)** or an **estimate (marked)**. None of them come from this machine.

---

## 1. Goal

**the user:** "support new antling ming 0.1 design models."

**What that name means (high confidence).** "antling" is **Ant Ling**, the brand of Ant Group's
inclusionAI lab (X: [@AntLingAGI](https://x.com/AntLingAGI), site [ant-ling.com](https://www.ant-ling.com/en/)).
"ming 0.1 design models" is the **Ming-Image-0.1-Design family**. Ant Ling announced it on
2026-09-22/23, the day before this request. The weights went up on 2026-09-17. The family has two models:

- **[inclusionAI/Ming-Image-0.1-Design](https://huggingface.co/inclusionAI/Ming-Image-0.1-Design)** turns text
  into a finished design image: UI screens, dashboards, posters, infographics and other designs with a lot
  of text. It can output **RGBA with a transparent background**.
- **[inclusionAI/Ming-Image-0.1-Design-Layer](https://huggingface.co/inclusionAI/Ming-Image-0.1-Design-Layer)**
  takes a flattened design image plus a layer plan and returns **N separate RGBA layers** (2 to 9 per the
  announcement) that restack into the original.

No other inclusionAI model has "Ming", "0.1" and "Design" in its name. §3.1 lists the alternatives I
ruled out.

**The goal, stated precisely.** Make both models usable **inside Bobble, offline, on the user's M5 Pro with
24 GB first**, built so other Apple-Silicon Macs and later Linux/Windows can follow:

1. **Generate design images** (UI screens, posters, infographics, slides, social posts, dashboards) with
   exact text, including **transparent assets**. This must work from any chat through `generate_image`
   (and its CLI form `media generate image …`) and from the **Image Studio**.
2. **Split a design into editable layers.** This feeds studio editing (track 8), "remove background" for
   designs, and image → editable PPTX (track 10).
3. Run under Bobble's existing machinery (engine/weights module cards, guardian admission and
   pause/terminate, the eco pacer, the prompt enhancer, Manage Storage shelves, the model hub) with
   headless verification.

Non-goals for this track: training or fine-tuning Ming (tracks 3/7; see the ostris adapter note in §3.5),
hosted APIs as a default path (Bobble is offline-first), and photographic generation (Qwen-Image 2.1,
FLUX.2 klein and Z-Image already cover it).

---

## 2. What exists today

### 2.1 The generation stack Ming would plug into

| Piece | Where | What it does now | What it means for Ming |
|---|---|---|---|
| Modality catalog | `packages/gen-service/src/catalog.ts` (`MODALITY_CATALOG`, `ModalityModel`, `MfluxBackendConfig`, `PreparedWeights`, `jobFootprintGB`, `previewCostGB`, `defaultImageModel`) | Image entries run on `mflux`: `qwen-image-2.1` (the default, MLX 4-bit DiT + 8-bit encoder, research-nc licence), `flux2-klein-4b`, `z-image-turbo`, and others. They carry the measured `residentFloorGB` and `peakResidentGB` that admission reads. | Ming needs a new entry shape (`mlxVlm` backend config) plus measured numbers. |
| Job protocol | `packages/gen-service/src/protocol.ts` (`Backend` union, `ImageJobSpec`, `GenJob`, `GenEvent`) | `Backend = 'mflux' \| 'mlx-audio' \| 'torch-tts' \| 'triposr' \| 'trellis' \| 'hyperframes' \| 'comfyui'`. `ImageJobSpec` is shaped for mflux (it requires `mfluxCommand`). | Add `'mlx-vlm'` and a `DesignJobSpec` (task t2i / edit / layers). |
| uv worker argv | `packages/gen-service/src/worker-command.ts` (`baseWorkerWith`, `buildEnvWarmArgs`, `buildWorkerUvArgs`, `bundledWheelPath`, `MFLUX_PIN=0.18.0`) | Each backend gets its base `uv --with` package. A bundled wheel can replace a pin, which is the Qwen-Image 2.1 precedent. | `baseWorkerWith('mlx-vlm')` should point at a pinned mlx-vlm wheel. |
| Python worker | `packages/gen-service/python/worker.py` (`dispatch`, `run_image`, `build_mflux_cmd`, `drive_subprocess`, `Pacer`), `test_worker.py` | Drives mflux console commands as child processes. It emits NDJSON events and SIGSTOPs the child to pace it. | Add `run_design` plus a child driver script. |
| Bundled-wheel precedent | `packages/gen-service/python/mflux-qwen21/` (`build-wheel.sh`, `quantized-text-encoder.patch`, `README.md`), `python/wheels/mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl` | Runs an open upstream PR plus one patch as a wheel. No git dependency at runtime. | Use the same shape for mlx-vlm at a pinned commit. |
| Dispatch + admission | `apps/desktop/electron/gen/gen-manager.ts` (`handleGenerate`, `registerGenIpc`), `image-dispatch.ts` (ComfyUI images), `guardian-main.ts`, `make-room.ts`, `pausables.ts`, `packages/inference/src/guardian.ts` | `handleGenerate` builds the mflux job or the ComfyUI job. Admission is by footprint (`jobFootprintGB` vs the OS free %). The chat model is parked to make room. Pause is a SIGSTOP of the worker tree. | Add a third branch for `mlxVlm` models. Ming's footprint has two phases: encode, then denoise (§4.4). |
| Modules (the download cards) | `apps/desktop/electron/gen/gen-modules.ts` (`GEN_MODULE_IDS = image\|audio\|comfy\|3d`, `weights:<id>`, `moduleForBackend`, `MODULE_WAIT_MS`), `gen-modules-main.ts` (`warmArgs`, `installPrepared`, `adoptPrepared`, `installWeights`, `downloadRepo`), `weights-on-shelf.ts` (`preparedDir`, `weightsPresent`, `weightsMeta`), renderer `apps/desktop/src/media/ModuleCard.tsx` | A job whose engine or weights are missing waits for the Download button, then continues. | Add a runtime module for the mlx-vlm env and `weights:ming-image-0.1-design`. |
| IPC | `apps/desktop/electron/gen/gen-ipc-contract.ts`: `gen:generate` (image fields `size/n/steps/seed/guidance/negativePrompt/inputImage/strength`), `gen:enhance`, `gen:cancel`, `gen:module-status/-install/-dismiss`, events `gen:open`, `gen:update`, `gen:module`, `gen:guardian` | | `gen:generate` needs `transparent?: boolean`, plus `task`/`numLayers` later. |
| Prompt enhancer | `apps/desktop/electron/gen/prompt-guidelines.ts` (`PromptDialect = image-natural\|video\|music\|sfx\|none`, `BY_MODEL`, `guidelineFor`), `prompt-enhancer.ts` (`enhanceSystemPrompt`, `cleanEnhanced`, word cap `maxWords`), probe `apps/desktop/tests/enhance/enhance-probe.mjs` | The enhancer rewrites a line into one flowing sentence, capped by words. | Ming's own rewriter emits a **JSON layout document**. The word cap and prose cleaning would destroy it, so it needs a new dialect (§4.6). |
| Agent tools | `packages/gen-tools/src/tools.ts` (`generate_image`: `prompt, save_to, model, size, n, steps, seed, negative_prompt`), `packages/gen-tools/src/gen-contract.ts` (`GenerateImageParams`), `packages/harness/src/tools/image-tools.ts` (`edit_image` on the gen3d Mage-Flow-Edit path), `packages/harness/src/presets/capabilities.ts` (the `generation` and `svg` capability lines), `packages/harness/src/tools/tool-cli.ts` (`media generate image`, `COMMAND_PATH_OVERRIDES`) | The model can already pick an image model by id. | Add `ming-image-0.1-design` as an id, a `transparent` param, and routing guidance that does not steal from `svg` (§4.7). |
| Image Studio | `apps/desktop/src/studio/ImageStudio.tsx` (`SHAPES`, model `StudioPicker`, starters, `useEnhancer`, edit via handoff `inputImage/strength`), `StudioShell.tsx`, `StudioRun.tsx`, `use-studio.ts`, `apps/desktop/src/chat/ThreadMedia` | Shape × size, count, model, enhancer. | Needs design presets, a transparency toggle with a checkerboard, and later a Layers panel (§4.8). This must coordinate with the track-8 editor redesign. |
| Model hub + storage | `apps/desktop/src/models/recommended-catalog.ts` (an `inclusionAI` org already exists: the Ling 3.0 family), `ModelsView.tsx`, `StorageView.tsx`, `packages/model-store/src/library.ts` (`shelfFor`: `Image/Generation`, `Image/Editing`, `Image/Vector`) | | Add a `ming-image` family. Design goes on `Image/Generation`, Layer on `Image/Editing` (pass task `image-to-image`, because the repo name contains no "edit"). |
| Engine matrix | `apps/desktop/src/settings/engine-catalog.ts` (`ENGINES`, `enginesFor`, `preferredEngine`, `baselineEngine`; `mflux` rank 30, `comfyui` = baseline for image/video/audio) | | Add an `mlx-vlm` engine row (darwin, apple, image). ComfyUI stays the portable baseline. |
| E2E harness | `apps/desktop/tests/e2e/harness.mjs` (`launchApp`, hidden window, `REAL_CACHE`, `REAL_LIBRARY`, `probeHome`); templates `qwen-image-21-real-probe.mjs`, `qwen-image-21-prepare-probe.mjs`, `module-card-look.mjs`, `module-gate-probe.mjs`, `low-power-gen-probe.mjs`, `tool-surface-probe.mjs`, `enhance-prefill-probe.mjs`; E2E seams `__gen_store`, `__modality_store`, `__gen_modules_store` | | Ming probes copy these (§5). |
| Office pipeline | `tools/office-gen/office.py` (`imagery.py` uses stock photos (picsum) or procedural fields; there is no local generation), `packages/harness/src/tools/office-tool.ts` | | Later (track 10): transparent Ming assets for decks, and image → editable slide through layers. |

### 2.2 What is missing

- **No backend can run Ming.** mflux has no Ming support (no issue or PR, checked 2026-09-23).
  The ComfyUI checkout has no Ming nodes, and upstream support is still an open PR (§3.5).
- **No catalog, module, weights, hub or engine entries** for Ming.
- **No enhancer dialect** that produces Ming's structured layout prompt.
- **No transparency path in the UI.** Qwen-Image 2.1 can also make RGBA cutouts from a prompt phrase (see
  the comment in `prompt-guidelines.ts` `BY_MODEL`), but nothing in the studio or tools asks for it, and
  nothing shows alpha on a checkerboard.
- **No layer concept anywhere**: no layers tool, panel or export.
- **No instruction editing for designs.** `edit_image` uses Mage-Flow-Edit through the gen3d bridge, and the
  studio's edit is img2img through `--image-path`.

---

## 3. External research

### 3.1 Which models "antling ming 0.1 design" could mean (ranked)

| Rank | Candidate | Released | Size | Modality | Licence | Why it does or does not match |
|---|---|---|---|---|---|---|
| **1** | **Ming-Image-0.1-Design** | weights 2026-09-17, announced 2026-09-22/23 | "6B" (DiT 6.15B) plus a ~17B MoE conditioning MLLM | text → RGBA design image | MIT | Matches **Ant Ling + Ming + 0.1 + Design** exactly. [HF](https://huggingface.co/inclusionAI/Ming-Image-0.1-Design), [X post](https://x.com/AntLingAGI/status/2102452045374804304) |
| **1** | **Ming-Image-0.1-Design-Layer** | same | "6B" (DiT 6.15B, stored F32) plus the same MLLM | image + layer plan → N RGBA layers | MIT | Same family. "models", plural. [HF](https://huggingface.co/inclusionAI/Ming-Image-0.1-Design-Layer) |
| 3 | LLaDA-Image / LLaDA-Image-Turbo | 2026-08-28 / 09-04 | 6.5B | T2I + editing | Apache-2.0 | inclusionAI, but not Ming, not 0.1, not design-branded. [HF](https://huggingface.co/inclusionAI/LLaDA-Image) |
| 4 | LLaDA-UI | 2026-09-06 | 16.9B MoE | GUI agent (screenshots → actions) | n/a | UI *understanding*, not design generation. [HF](https://huggingface.co/inclusionAI/LLaDA-UI) |
| 5 | Ming-flash-omni 2.0 | 2026-02-11 | 100B-A6B | any-to-any | MIT | Ming, but not 0.1 and not design; far too big for 24 GB. [HF](https://huggingface.co/inclusionAI/Ming-flash-omni-2.0) |
| 6 | Ming-UniVision-16B-A3B / Ming-Lite-Omni 1.5 | 2025 | 16-20B MoE | unified understanding + generation | MIT | Older and general-purpose. |

**Verdict:** candidates 1 and 1 together; confidence ≈95%. The question for the user (§6) only asks him to
confirm that both are wanted.

### 3.2 The two models at a glance

| | Ming-Image-0.1-Design | Ming-Image-0.1-Design-Layer |
|---|---|---|
| Task | text → design image (UI, dashboards, posters, infographics, text-heavy compositions); RGBA output | flattened design + layer plan → N RGBA layers + 1 composite |
| Hidden capability | The reference code's `generation_edit` profile also accepts **`image-edit`** (one reference image + instruction, 1024 bucket). vLLM-Omni, ComfyUI (PR) and WanGP all expose editing, although the model card only says text-to-image. | `--num-layers N` or "Decompose this image into N layers …" with one line per layer |
| Recommended settings (card) | 2048×2048 (1024 "faster"), **12 steps, CFG 1.0** (runs without classifier-free guidance), BF16 | working bucket 1024 (512 faster), 12 steps, **CFG 2.0**, BF16 |
| Vendor-validated hardware | "one CUDA GPU with 80 GiB VRAM" | same |
| Prompt | Structured prompts up to ~8K tokens (announcement). The official rewriter emits Figma-style JSON layers. | an explicit per-layer spec (the official "guided prompt") |
| Transparency | Prepend **exactly one** of ten fixed phrases, e.g. `RGBA, 4-channel, transparent background` | Always RGBA |
| Repo size | **52.9 GB** (bf16) | **65.2 GB** (DiT in F32) |
| Code | [github.com/inclusionAI/Ming-Image](https://github.com/inclusionAI/Ming-Image) (`infer.py`, MIT repo; files carry Apache-2.0 headers). Pins `torch==2.4.0`, `transformer-engine==1.11.0` (CUDA-only), `transformers==4.57.1`, `diffusers==0.36.0`. | same |
| Blog / demos | [WeChat blog](https://mp.weixin.qq.com/s/VGdtxfM8kbHIQJw50VD_Sw) (blocked from here), [Design demo Space](https://huggingface.co/spaces/hugging-apps/ming-image-0-1-design-demo), [Layer demo Space](https://huggingface.co/spaces/Xiaolong-Wang/Ming-Image-0.1-Design-Layer) | |

### 3.3 The architecture, read from the checkpoint configs and code

The "6B" is only the diffusion transformer. The shipped pipeline is **five components**. I read this from
each component's `config.json`, the HF tree and the reference code (`modeling_bailingmm2.py`,
`diffusion/generator.py`, `diffusion/pipeline.py`):

| Component | What it is | Params | bf16 size | Notes |
|---|---|---|---|---|
| `mllm/` | `BailingMM2NativeForConditionalGeneration` = a **BailingMoeV2** LLM with the same shape as **Ling-mini-2.0** (20 layers, hidden 2048, **256 experts, 8 active + 1 shared**, vocab 157,184) plus a **Qwen2.5-ViT** vision tower (32 layers, hidden 1280) | ~16.3B + 0.7B (~1.4B active per token) | 34.0 GB (7 shards) | **"MultiRouter": every MoE layer has a text router (`gate`) and an image router (`image_gate`).** The 256 learnable query tokens go through `image_gate`. Byte-identical in both repos (same LFS oids). |
| `connector/` | `Qwen2ForCausalLM` config (28 layers, hidden 1536, the Qwen2.5-1.5B shape) run **bidirectionally** (`is_causal=False`) over the 256 query-token states | 1.54B | 6.2 GB **stored fp32** | Different weights per repo |
| `mlp/` | `proj_in` 2048→1536, `proj_out` 1536→2560, `proj_directvlm` (RMSNorm + Linear 6144→3840), `query_tokens` [256, 2048] | small | 0.13 GB | `selected_hidden_states_layers: [5, 12, 20]` |
| `transformer/` | "DiffusionTransformer" = **the Z-Image / Lumina-2 "NextDiT" single-stream DiT**: dim 3840, 30 layers + 2 noise-refiner + 2 context-refiner layers, 30 heads, `cap_feat_dim` 2560, `axes_dims [32,48,48]`, rope θ 256 | 6.15B | 12.3 GB (Layer: 24.6 GB in F32) | Identical to Tongyi-MAI Z-Image's `ZImageTransformer2DModel` config except `axes_lens[0]` 1536 → **20480** (long captions) and two new flags: `alignment_padding_mode` (`zero_masked` / `learned`) and `multi_frame_output` (false / true). mlx-vlm and ComfyUI both reuse their Z-Image code for it. The card does not say whether it was initialised from Z-Image. |
| `vae/` | `AutoencoderKLQwenImage` with **`input_channels: 4`** (RGBA), z_dim 16 | 0.13B | 0.25 GB | 8× spatial. Shared across repos. |
| `scheduler/` | FlowMatchEulerDiscrete, shift 6, with dynamic shifting forced on in code | | | |

**The conditioning path** (this matters for porting, quantizing and speed):
1. The chat-templated prompt, with an input image for edit/layers, goes to the MLLM with **256 learnable
   query tokens appended**.
2. **Stream A:** the final-layer states at the 256 query positions pass through `proj_in`, the bidirectional
   connector and `proj_out`, giving 256 × 2560 `cap_feats`.
3. **Stream B ("direct VLM"):** the hidden states of layers 5, 12 and 20 at **every prompt-token position**
   are concatenated (6144-d), then RMSNorm + Linear give `cap_feats_2` (N × 3840).
4. The DiT runs **joint self-attention over [image tokens + 256 + N prompt tokens]**. **Long prompts
   therefore make every denoising step slower.** The official JSON prompts run to ~1-2K tokens.
5. For edit/layers, the reference image is VAE-encoded (argmax) and enters as extra frames (`ref_x`). The
   Layer model denoises **N+1 frames jointly** (a composite plus N layers), so its attention cost grows with
   (N+1) × image tokens.

### 3.4 Quality claims

- **Vendor:** "#1 among open-weight models on Artificial Analysis's UI/UX Design leaderboard". Their graphic
  (in both repos) shows **Ming 1082 Elo**, Ideogram 4.0 (Quality) 1052, Ideogram 4.0 1015, HunyuanImage 3.0
  Instruct 1005, FLUX.2 [dev] 1000, HiDream-O1 987, **Z-Image Turbo 946**, ERNIE Image 914.
- **Independent (Artificial Analysis general text-to-image board, fetched 2026-09-23):** Ming-Image-0.1-Design
  is **#45, 995 Elo (±8, 21,305 appearances)**. That puts it above Z-Image Turbo (#74, 942) and FLUX.2 [klein] 4B
  (#117, 864), both of which Bobble ships. [Board](https://artificialanalysis.ai/image/leaderboard/text-to-image)
  (read through a page summariser, so treat the numbers as indicative). The UI/UX category view was not
  reachable, and one marketing blog ([orcarouter](https://www.orcarouter.ai/blog/ming-image-0-1-design-quiet-release))
  says the 1082 figure only appears in the vendor graphic. **Reading:** it is a specialist. It is strong on
  design and text and mid-pack on general pictures, so it **complements** the photo models rather than
  replacing them.
- **Layer model:** the vendor table on the Crello test set (the row is labelled "CLEAR-1024 (Ours)"; I have
  not located the paper) gives **RGB L1 0.0574 / alpha soft-IoU 0.8923** at zero merges. The open
  Qwen-Image-Layered-I2L-1024 scores **0.1409 / 0.7177**. It is best in all 12 settings, and the announcement
  says it is "4.3× faster than the 20B open-weight Qwen baseline".

### 3.5 Runtimes and ports as of 2026-09-23 (two days after release)

| Runtime / artifact | Platform | T2I | Edit | Layers | Status and numbers | Link |
|---|---|---|---|---|---|---|
| Upstream `infer.py` (PyTorch) | CUDA only (transformer-engine) | ✓ | ✓ | ✓ | Validated on 1 × 80 GB | [repo](https://github.com/inclusionAI/Ming-Image) |
| **mlx-vlm `ming_image`** | **Apple Silicon (MLX)** | **✓** | ✗ | ✗ | **Merged 2026-09-23 (PR #2334, commit `7b3397a621`)**. Not yet on PyPI (latest 0.7.2 is from 09-21). CLI `mlx_vlm.generate --output-modality image`; Python `load_image_generation_model` / `generate_image`. Evicts the text encoder after encoding; rejects guidance ≠ 1; sizes 256-2048, multiples of 16. **M5 Max bf16: 1024² = 3.1 s/step, 36 s per 12 steps, peak 38 GB; 2048² = 52.9 s/step, 650 s, peak 43 GB.** | [PR](https://github.com/Blaizzy/mlx-vlm/pull/2334), [code](https://github.com/Blaizzy/mlx-vlm/tree/main/mlx_vlm/models/ming_image) |
| nativ-community MLX 4-bit | MLX (mlx-vlm layout) | ✓ | – | – | **13.4 GB**: text_encoder 9.84 (MLLM 4-bit g64 **text-only, no vision tower**, routers kept bf16, connector 4-bit with f32 scales) + DiT 3.48 (4-bit, `t_embedder`/`cap_embedder` unquantized) + VAE 0.09. Rev `844f9ef…` | [HF](https://huggingface.co/nativ-community/Ming-Image-0.1-Design-MLX-4bit) |
| nativ-community MLX 8-bit | MLX | ✓ | – | – | **25.1 GB** (encoder 18.5). Rev `2568173…` | [HF](https://huggingface.co/nativ-community/Ming-Image-0.1-Design-MLX-8bit) |
| vLLM-Omni | Linux CUDA | ✓ | ✓ | ✓ | **Merged 2026-09-23 (PR #8021)**. Two-stage serving with an OpenAI-compatible `/v1/chat/completions` (`modalities:["image"]`, `extra_body` height/width/steps/cfg/seed/num_layers). Recipe environment: **2 × H100 80 GB** (1 × H100 "to be validated"); quantization and offload are TODO | [recipe](https://github.com/vllm-project/vllm-omni/blob/main/recipes/inclusionAI/Ming-Image.md), [PR](https://github.com/vllm-project/vllm-omni/pull/8021) |
| ComfyUI native (kijai) | CUDA/ROCm/Intel/MPS/CPU | ✓ | ✓ | (weights published) | **Open PR [#16482](https://github.com/Comfy-Org/ComfyUI/pull/16482)** (+586/−60, `comfy/text_encoders/ming_image.py`, `comfy_extras/nodes_ming.py`, lumina model changes). A user reports the int8 file lacks metadata and is **misdetected as Z-Image**. | weights: [Kijai/Ming-Image-ComfyUI](https://huggingface.co/Kijai/Ming-Image-ComfyUI): DiT bf16 12.3 / int8_convrot 6.2 GB, Layer DiT int8 6.2, Ling-mini encoder bf16 36.7 / int8 19.5 / **w4a8 12.8**, VAE 0.25 |
| GGUF (realrebelai) | ComfyUI-GGUF | ✓ | – | – | DiT "HQ" ladder **Q2_K 4.7 … Q4_K_M 5.9 … Q8_0 7.3 GB** (embedders, refiners and adaLN kept bf16). Encoder **Q4_K_M-HQ 9.9 / Q2_K-HQ 6.3 GB** (experts at Q2, backbone at Q4). **Needs open PR [city96/ComfyUI-GGUF#484](https://github.com/city96/ComfyUI-GGUF/pull/484)**, which was tested on an **RTX 3070 8 GB with `--lowvram`** | [HF](https://huggingface.co/realrebelai/Ming-Image_GGUFs) |
| alexokita INT4/INT8/FP8 + custom node | CUDA (DGX Spark) | ✓ | – | – | Weight-only absmax. INT4 total 15.4 GB. Custom node pack `ComfyUI-Ming-Image` (`MingImageDesign`) | [INT4](https://huggingface.co/alexokita/Ming-Image-0.1-Design-INT4), [workflow](https://huggingface.co/alexokita/Ming-Image-0.1-Design-ComfyUI) |
| WanGP (DeepBeepMeep) | CUDA, low-VRAM offload | ✓ | ✓ | ✗ | Single-file bf16 / int8 ConvRot | [HF](https://huggingface.co/DeepBeepMeep/MingImage) |
| ROCm build (Strix Halo) | AMD gfx1151 | ✓ | – | – | **1024², 12 steps: BF16 upstream code 451 s mean → INT8 + fast attention 86.5 s.** PyTorch peak **58.7 GiB** with everything resident, and **33.6 GiB** with INT8 and the MLLM released after conditioning. Prompt length visibly changes the time. | [HF](https://huggingface.co/kingjones777/Ming-Image-0.1-Design-ROCm-INT8) |
| ostris training adapter | ai-toolkit | – | – | – | 170 MB `ming_image_01_design_training_adapter_v1.safetensors` (empty README; presumably for LoRA training, relevant to tracks 3/7) | [HF](https://huggingface.co/ostris/ming_image_training_adapter) |
| Hosted APIs | cloud | ✓ | – | ✓ | OpenRouter lists both (`inclusionai/ming-image-0.1-design`, `…-design-layer`). The official skills default to Novita's OpenAI-compatible `images/generations` and `images/edits` | [OpenRouter](https://openrouter.ai/inclusionai/ming-image-0.1-design) |

**What no one has yet:** an **MLX (Mac) port of image-edit or of the Layer model**, or any Mac runtime
for them at all. ComfyUI on MPS would technically run the Kijai PR. However, Bobble measured on 2026-09-20
that **MPS holds a GGUF dequantized** (Metal 8.1 GB for a 4.2 GB Q4) and that the guardian sheds such jobs
on 24 GB. See memory `pi-desktop-qwen-image-21` and `pi-desktop-comfy-mps-quants`. So ComfyUI is not the
Mac path.

### 3.6 The companion Agent Skills (MIT, [inclusionAI/ling-cookbook](https://github.com/inclusionAI/ling-cookbook/tree/main/resources/recommended-skills))

- **`ling-ui-design`** is a "visual-first" UI workflow:
  1. Generate a page reference with Ming (or take the user's screenshot).
  2. Decompose it once into 4 layers (`text / image / container / background`) with a fixed preset prompt.
  3. Crop reusable raster assets from the layers (`crop_elements.py`, `refine_crop.py`).
  4. Pass an "asset gate" in which every material raster region is accepted, refined, generated or omitted.
  5. Implement the page in code.
  6. Screenshot and fix the largest mismatch, for at most five cycles.

  It talks to an OpenAI-compatible `images/generations` endpoint (payload `model, prompt, output_format,
  response_format:"b64_json", enable_thinking`) and `images/edits` (payload `image, prompt, size, steps,
  seed, num_layers, use_pe`).
- **`image-to-editable-ppt`** turns one slide image into one editable `.pptx`. Text becomes native text
  boxes, simple containers become native shapes, and artwork becomes tight RGBA crops, all through
  iterative layer decomposition and a `scene.json` → PPTX compiler (`scene_to_pptx.py`, `render_pptx.py`,
  `validate_pptx.py`). Its README says "the workflow needs a strong model".

**What Bobble can reuse:** the **prompts**, all MIT: the T2I rewriter system prompt
(`assets/t2i_rewriter_system_prompt.txt`), the layer "guided prompt", and the 4-layer preset. The
**workflow shapes** feed tracks 10 and 11. The layers → `scene.json` → PPTX idea fits `tools/office-gen`.
The skills themselves assume a frontier model and a hosted API, so they cannot be dropped in as they are.

### 3.7 What this means for Bobble

1. **The Mac path is MLX through mlx-vlm, and it exists as of today.** Text → design on a 24 GB Mac is a
   **pinned-wheel integration, not a port**. This is the same pattern as the mflux#736 wheel for Qwen-Image
   2.1. mlx-vlm is maintained by Blaizzy, who also maintains mlx-audio, which Bobble's audio module already uses.
2. **The encoder is the memory problem, not the DiT.** At 4 bits the DiT is 3.5 GB. The MoE encoder is
   ~9 GB at 4 bits and ~18 GB at 8 bits. Its phase comes first and is evicted before denoising. Estimated
   phase peaks for the nativ 4-bit weights: **~10-11 GB while encoding** and **~5-8 GB while denoising at
   1024²** (estimates, to be measured). That fits 24 GB beside a small chat model, or with make-room
   parking it. 16 GB is doubtful without a lower-bit or offloaded encoder.
3. **Speed estimate on the M5 Pro (4-bit, 1024², 12 steps): ~3-4.5 s/step, about 1 to 1.5 minutes per
   image including loads.** I derived this from the M5 Max bf16 figure (3.1 s/step) and this Mac's own
   Qwen-Image 2.1 and Z-Image numbers. **2048², the vendor's recommendation, is impractical here.** The
   M5 Max needed 52.9 s/step at 43 GB peak, which suggests ~15-20 min on the M5 Pro. So on machines of
   32 GB or less, **1024² is the default and 2048² is a "Large (slow)" option admitted by the guardian**.
4. **The quality risk sits in the quantized encoder.** For Qwen-Image 2.1, the words-in-picture benchmark
   showed that the *4-bit encoder* flipped about one letter in ten, and an 8-bit encoder fixed it (memory
   `pi-desktop-qwen-image-21`). Ming's whole value is text in designs, so the same benchmark has to choose
   Ming's recipe.
5. **Prompting is part of the model.** The vendor's pipeline expects a VLM rewriter (Ling-3.0-flash-VL at
   124B-A5.5B, or "qwen3.8-27B") to turn a line into a JSON layout. Neither fits beside Ming on 24 GB, so
   Bobble's local chat model or enhancer has to do it. JSON-schema-constrained decoding on llama-server makes
   that reliable even for 2-4B models.
6. **Layers and editing are the differentiator, but on a Mac they need Bobble to write the port**: vision
   tower, reference-image latents, multi-frame output, learned padding and CFG 2. The reference code and
   two independent implementations (vLLM-Omni, ComfyUI PR) serve as specs.
7. **Licensing is clean.** Weights, code, skills and mlx-vlm are all MIT, compatible with Bobble's GPL-3.
   Unlike the current default Qwen-Image 2.1 (research-nc), **Ming is commercially usable**.

---

## 4. Design

### 4.1 Recommendation

Support the family in **three phases**:

1. **Generate (Mac, now).** Add a new **`mlx-vlm` backend** to the gen-service: a process-per-job uv
   worker, exactly like mflux, running Ming-Image-0.1-Design from a **pinned mlx-vlm wheel** with a
   **Bobble-owned driver script**. Weights start as nativ-community MLX 4-bit (13.4 GB, a plain download).
   A words-in-picture benchmark then picks the shipped recipe. The model is exposed through
   `generate_image` (`model: ming-image-0.1-design`, `transparent: true`) and through **Design presets in
   the Image Studio**.
2. **Layers + edit (Mac).** Extend the MLX port with the vision tower, reference latents, multi-frame
   output and CFG 2, as a patch set in the same wheel that is upstreamed to mlx-vlm. This lights up
   **Split into layers** and **instruction edits on designs** in the studio (track 8's editor) and a
   `media layers` tool.
3. **Other platforms and remote.** ComfyUI (baseline engine) once `Comfy-Org/ComfyUI#16482` and
   `city96/ComfyUI-GGUF#484` land. vLLM-Omni on a big Linux GPU as a **Devices-track** remote target.

### 4.2 Runtime: the `mlx-vlm` backend

- **Protocol** (`protocol.ts`): add `'mlx-vlm'` to `Backend` and add `GenJob.design?: DesignJobSpec`:

  ```ts
  export interface DesignJobSpec {
    readonly task: 'text-to-image' | 'image-edit' | 'layers'; // phase 1 ships text-to-image only
    readonly family: 'ming_image';          // mlx-vlm model family (future Ming-Image 0.x reuse this)
    readonly modelId: string;               // catalog id (the footnote)
    readonly modelPath: string;             // the MLX folder on the Image shelf
    readonly prompt: string;                // enhanced; transparency phrase already prefixed
    readonly width: number; readonly height: number; // snapped to Ming's aspect buckets
    readonly steps: number;                 // 12
    readonly cfg?: number;                  // 1.0 (t2i/edit), 2.0 (layers)
    readonly seeds: readonly number[];      // one PNG per seed, ONE encode for all
    readonly pace?: number;                 // eco duty cycle, as for mflux
    readonly imagePath?: string;            // edit / layers (phase 2)
    readonly numLayers?: number;            // layers (phase 2)
    readonly cacheLimitGB?: number;         // MLX buffer-cache cap (the --low-ram analogue)
  }
  ```

  The worker stays catalog-free: `modelPath` and the task are resolved in main, as they are for mflux.
- **Env** (`worker-command.ts`): `baseWorkerWith('mlx-vlm', …, mlxVlmWith)` returns a **bundled wheel**
  `python/wheels/mlx_vlm-0.7.3.dev0+bobble.ming-py3-none-any.whl`. It is built by a new
  `python/mlx-vlm-ming/build-wheel.sh` from a GitHub tarball of commit `7b3397a621` (no git, which avoids
  the CLT dialog, per memory `pi-desktop-gen-modules`) plus a small patch set:
  - (a) an `on_step` callback, plus "encode once, many seeds" in `MingImagePipeline`;
  - (b) a loader that honours **per-layer quantization overrides** (for the recipe in §4.3);
  - (c) `mx.eval` after each encoder layer, which lets the expert-offload store evict (§4.3).

  All three are upstreamable. Switch to `mlx-vlm==0.7.x` from PyPI once a release carries what we need.
  `buildEnvWarmArgs` covers it for the module card.
- **Driver** (`python/ming_generate.py`, new, spawned by `worker.py run_design` through `drive_subprocess`
  so the `Pacer`'s SIGSTOP and cancel keep working): it loads `MingImagePipeline(modelPath)`, encodes
  **once**, then for each seed denoises for 12 steps, printing `STEP i/N`, decodes, and writes a PNG.
  - **If every alpha value is 255 it saves RGB.** Only a transparent request keeps RGBA, so downstream tools
    never mistake an opaque picture for a cutout.
  - It prints `CANDIDATE k <path>`.
  - `worker.py` translates those lines into the existing `GenEvent`s (`start` / `progress` / `candidate` /
    `done` / `error` / `log`). The renderer needs no new event types.
- **Memory hygiene:** set `mx.set_cache_limit(cacheLimitGB ?? 1)`, rely on the encoder eviction that is
  already in the pipeline, and keep **one heavy job at a time** (`heavy: true`). There are no per-step
  previews (`previews: false`): the card plays the mark, as it does for Qwen-Image 2.1. A later nice-to-have
  is a free latent→RGB preview (a 16×3 linear map, no VAE decode).
- **Precision:** T2I is CFG-free, so the Metal fp32 issue (memory `pi-desktop-metal-precision`) should not
  compound. The Layer path runs CFG 2 and must pass a numerical gate against PyTorch on CPU (MING-8).

### 4.3 Weights and the recipe

- **v1 = nativ-community MLX 4-bit**, a plain snapshot download pinned to rev `844f9ef…`. It lands on
  `~/Bobble/Models/Image/Generation/nativ-community__Ming-Image-0.1-Design-MLX-4bit/` through the existing
  `downloadRepo` → weights module path. The catalog carries a new `mlxVlm: { family, repo, revision }`
  block, and `weights-on-shelf.ts` learns `weightsPresent` for it.
- **The recipe decision (MING-5).** Rerun the **words-in-picture benchmark** that chose te8 for Qwen-Image
  2.1: ten prompts with a word in the picture at one seed, BOBBLE at three seeds, the KYOTO poster, and
  three UI/infographic prompts from Ming's own samples. Compare:
  1. nativ 4-bit;
  2. nativ 8-bit (encoder offloaded, see below);
  3. **a Bobble mixed recipe**: routed experts at 4 bits (or 3), attention, shared experts, dense layer 0 and
     routers at 8 bits; connector at 8 bits; DiT at 4 bits, keeping `t_embedder`, `x_embedder`,
     `cap_embedder`, refiners, adaLN and the final layer at 8 bits or bf16 (the same protection realrebelai's
     GGUF "HQ" ladder uses).

  Estimated sizes: the routed experts are ≈ 15.3B of the MLLM's ~16B params (19 MoE layers × 256 × 3 ×
  2048 × 512). With the rest of the MLLM at 8 bits (~0.7 GB), the MLLM is **~9.3 GB with 4-bit experts
  (4.5 effective bits at g64) or ~7.4 GB with 3-bit**. Add the connector: ~1.6 GB at 8 bits or ~0.9 GB at 4
  bits. For comparison, nativ's all-4-bit text encoder is 9.84 GB. The protected DiT is ~4 GB. **Ship
  whichever gets every word right at the smallest size.** The sheets go to the user to LOOK at (memory
  `user-visual-confirmation-required`).
- **If the Bobble recipe wins, how it reaches users:**
  - (a) **publish it to HF** (needs the user's write token; same request as OmniSVG and Qwen-Image 2.1), which
    makes it a ~11-14 GB download; or
  - (b) `mlxVlm.prepared`: convert on the Mac from the 52.9 GB bf16 release with a **streaming shard-by-shard
    converter**, so the transient disk cost is one 5 GB shard and not the whole release. The pattern follows
    `installPrepared` / `adoptPrepared`; the folder name carries the recipe, as `…-te8` does today.
- **Expert offload (MING-13)** reuses mlx-vlm's own `moe_offload` (`ExpertStore`: mmapped per-expert files
  with an LRU byte budget). Combined with a per-layer `mx.eval`, the **8-bit encoder costs ~1-3 GB
  resident instead of ~18 GB**, at the price of reading ~16 GB from SSD per encode (≈3-5 s on this Mac's
  SSD, estimated). That is the route to 8-bit quality on 24 GB and to any Ming at all on 16 GB Macs.
- **Layer weights (phase 2):** the MLLM is byte-identical between the two repos. So the Layer package only
  adds its connector, mlp and DiT (24.6 GB F32 → ~3.5-4 GB at 4 bits), plus the vision tower, which neither
  nativ package contains. **A shared encoder folder** used by both models saves ~9 GB of disk.

### 4.4 Catalog and admission

```ts
{
  id: 'ming-image-0.1-design', modality: 'image', label: 'Ming-Image Design',
  backend: 'mlx-vlm', repo: 'inclusionAI/Ming-Image-0.1-Design',
  license: 'mit', commercialUse: true,
  approxSizeGB: 13.4,                 // nativ 4-bit; replaced by the recipe's size
  residentFloorGB: /* MEASURED in MING-4: the encode-phase OS drop */,
  peakResidentGB:  /* MEASURED in MING-4: the 1024² max over phases */,
  minUnifiedMemoryGB: 24,             // provisional; 16 only after MING-13 is measured
  runsLocally: true, heavy: true, previews: false, defaultSteps: 12, recommended: true,
  mlxVlm: { family: 'ming_image', repo: 'nativ-community/Ming-Image-0.1-Design-MLX-4bit',
            revision: '844f9efc7a02dd0753fd2ee690e53ef5571cfc8e', tasks: ['text-to-image'] },
  notes: 'Design, not photos: UI screens, posters, infographics with exact text; transparent assets. MIT.',
}
// + 'ming-image-0.1-design-layer' { reserved: true } until MING-8
```

- **Two-phase footprint.** `jobFootprintGB` is linear in pixels. Put the **encode phase in
  `residentFloorGB`**, since it does not depend on pixels and dominates at 1024², and the 1024² maximum in
  `peakResidentGB`.
  - **2048² is not linear**: attention over ~16.6K+ tokens, and a VAE decode with no tiling. So 2048²
    needs its own measured figure, or it is **refused below 48 GB** with advice ("try Standard size").
  - The guardian's `fits`, a fresh reading, make-room and pause/terminate all apply unchanged.
- **Sizes:** use **Ming's own aspect buckets** (`process_ratio` tables in `bailingmm_utils.py`) and do not
  compute Bobble's `SHAPES`:
  - at the 1024 level: 1:1 → 1024×1024, 16:9 → 1280×720, 9:16 → 720×1280, 4:3 → 1152×864,
    3:4 → 864×1152;
  - the 2048 level is "Large".
  - The vendor CLI is square-only for T2I, so **non-square quality is validated in MING-4** before the UI
    offers it.
- **Knobs the model ignores:** guidance is locked at 1.0 (mlx-vlm rejects other values).
  `negative_prompt` is dropped with a note (vLLM-Omni rejects it; the model uses zero negative
  conditioning). Steps default to 12.

### 4.5 Modules and cards

- **A new runtime module `design`** in `GEN_MODULE_IDS` and `GEN_MODULE_META`, with
  `moduleForBackend('mlx-vlm') → 'design'`:
  - label **"Design module"**;
  - blurb "The engine for design models (mlx-vlm on MLX): Ming-Image posters, UI and infographics.";
  - `approxGB` measured in MING-0. mlx-vlm's requirements pull transformers ≥ 5.14, mlx-audio, opencv and
    fastapi, so expect roughly 1.5-2.5 GB.
  - `gen-modules-main.ts`: add `warmArgs('design')` → `buildEnvWarmArgs({ backend: 'mlx-vlm', mlxVlmWith })`
    and a marker at `~/.cache/bobble/gen/modules/design.json`.
  - *Why not fold it into `image`:* the image module would then download an extra env for every user,
    including those who never touch design. A first design job would also hit an unwarmed env inside the
    job, which is exactly the "Starting…" minutes that gen-modules exists to prevent.
- **The weights module `weights:ming-image-0.1-design`** uses the same card: "Ming-Image Design · 13.4 GB
  · MIT". It is disk-checked through `storage:check-space` before it is queued.
- Chat shows the `ModuleNotice` above the composer, and the studio shows the `StudioShell` notice with
  `ModuleCard`. Both exist already.

### 4.6 Prompting: the `design-layout` dialect

- `prompt-guidelines.ts`: add `PromptDialect 'design-layout'` and `BY_MODEL['ming-image-0.1-design']`.
  - **Rules** are adapted from the MIT rewriter system prompt: one JSON object, exactly
    `canvas_settings {aspect_ratio, ambient_lighting, image_style}` plus `layers[]` from back to front. Each
    layer has `description, coordinates ("cx: 0.500, cy: 0.500, w: 1.000, h: 1.000"),
    hierarchy_and_relation, color_specs[]`. **Every user string appears verbatim, exactly once.** No
    "etc." and no invisible layers.
  - The **example** is one short brief → one compact JSON.
- `prompt-enhancer.ts` changes:
  - a dialect branch in `cleanEnhanced` → `cleanDesignLayout`: strip fences and `<think>`, `JSON.parse`,
    validate the schema, check that each user-quoted string occurs exactly once, and fall back to the
    original line (plain prose is still a valid Ming prompt) on any failure;
  - a **token cap**, not a word cap (≈1,200 tokens), because caption tokens join the DiT's attention (§3.3);
  - **JSON-schema-constrained decoding** when the endpoint is Bobble's llama-server (`response_format` /
    `json_schema`), which guarantees valid JSON even from a 2B model.
- **Transparency:** strip any RGBA phrase before enhancing, then prepend exactly one fixed phrase
  (`RGBA, 4-channel, transparent background`) afterwards: `phrase + ", " + text`, or `phrase + "\n" + json`.
  Both forms are tested in MING-4.
- **Enhancer candidates to grade** (with generation off, the method from memory
  `pi-desktop-studios-and-enhancer`): gemma-4-E2B (the current enhancer), Qwen3.5-4B (the chat default),
  and **Ling-3.0-tiny**, which is already in the hub under inclusionAI and is Ming's own lab.
- **Prefill rule:** the enhancer call must not evict the chat's KV slot. Check this with
  `enhance-prefill-probe.mjs` (memory `user-always-check-prefill`).

### 4.7 Agent surface

- **`generate_image`** (`packages/gen-tools/src/tools.ts`, `gen-contract.ts` `GenerateImageParams`,
  `gen:generate`):
  - `ming-image-0.1-design` becomes a valid `model`;
  - add `transparent?: boolean` ("a cutout on a transparent background, PNG with alpha");
  - add one description sentence: "for UI screens, posters, infographics, slides-as-pictures, dashboards and
    any picture that must carry exact words, or a transparent cutout, use model ming-image-0.1-design".
- **Capability split** (`capabilities.ts`): **vector** icons, logos and flat illustrations stay with `svg`,
  which is the user's rule (memory `pi-desktop-omnisvg-connector`). **Raster** designs with text, and
  transparent raster assets, go to generate_image + Ming. `tool-surface-probe.mjs` on the 4B must show no
  regression in svg routing.
- **Phase 2 tool `split_image_layers`** (`image`, `n`, `plan?`, `out?`) returns layer PNG paths plus
  `manifest.json` (roles, sizes). Add a `COMMAND_PATH_OVERRIDES` entry `['layers']` so the CLI reads
  `media layers <image> --n 4 --out dir/`. It uses the ling-ui-design 4-layer preset
  (text / image / container / background) by default, so it does not depend on a strong prompt writer.
- **Every description change moves the cached prompt prefix.** Measure TTFT and prefill before and after
  (memory `user-always-check-prefill`).

### 4.8 UI: the Image Studio and model hub

Design this together with **track 8** (studios become editors, not chats). Ming supplies the editor's
design-grade tools.

- **Design presets.** A "Design" row in the studio's starters or rail: *UI screen · Poster · Infographic
  · Slide · Social post · Dashboard · Transparent asset*. Each preset sets `model=ming-image-0.1-design`,
  the right bucketed shape (UI screen: 9:16 or 16:9 toggle; slide: 16:9; poster: 3:4), the
  `design-layout` enhancer, and a one-line hint of what to type. Photo prompts keep the default model.
- **Transparent toggle** in the rail. `StudioRun` and `ThreadMedia` show alpha on a checkerboard (CSS
  background), and export is PNG with alpha.
- **The layout drawer, optional (phase 1.5).** After enhancing, show the JSON as editable rows: layer
  description, box and colour chips. Editing a row edits the prompt. The user sees the plan before paying
  ~1 minute of GPU, following the enhancer principle that "the rewrite lands in the composer BEFORE the run".
- **States:** empty → preset chosen → engine card (Design module) → weights card (13.4 GB) → admitted or
  held (guardian numbers in the banner) → generating (the loader arc, "step 7/12", honest ETA from the
  measured s/step) → done (checkerboard if transparent) → error (the worker's tail, as `drive_subprocess`
  already gives).
- **Phase 2: the Layers panel** in the editor. Thumbnails, visibility, reorder, export PNGs or a ZIP,
  "Use as asset" (send to chat/canvas), **"Make editable slide"** (layers → office-gen `scene.json` →
  PPTX), and "Remove background" (a two-layer split for designs; photos keep BiRefNet).
  - **Comment pins** (the user's "numbered pin + Describe changes ✓ ✕") become **Ming instruction edits**:
    "at pin 1 (top left, the logo): …".
  - This also covers the queued left editing bar (Markup · Comment · Remove BG · Erase · Resize) from memory
    `pi-desktop-qwen-image-21`.
- **Hub:** a `ming-image` family in `recommended-catalog.ts` (org `inclusionAI`, `output: 'image'`, blurb
  "Design, not photos: UI, posters, infographics with exact text, and transparent assets. MIT."), with
  variants MLX 4-bit (and later the recipe) and Layer (reserved).
  - Storage shelves: Design → `Image/Generation`, Layer → `Image/Editing`.
  - The OrgAvatar uses the existing inclusionAI mark; never draw one (memory `user-logos-and-hover-rules`).
- **Engines panel:** add an `mlx-vlm` `EngineSpec` (`platforms: ['darwin']`, `gpuVendors: ['apple']`,
  `requiresAppleSilicon`, `modalities: ['image']`, `formats: ['mlx','safetensors']`, `rank` just under
  mflux, `wired` once MING-3 lands).

### 4.9 Phase 2: layers and edit on MLX (the port)

**What has to be added** to the mlx-vlm port, with the reference `modeling_bailingmm2.py` and
`diffusion/*`, vLLM-Omni and the ComfyUI PR as specs:
- the **Qwen2.5-ViT** vision tower (mlx-vlm already has Qwen2.5-VL vision);
- `prompt_wrap_navit` image-token placement, with image tokens routed through `image_gate`;
- a **VAE encoder** for reference images (argmax);
- DiT `ref_x` frames, **multi-frame output** (N+1), and **learned** alignment padding
  (`x_pad_token` / `cap_pad_token`);
- **CFG 2.0** with zero negative conditioning;
- a converter for the F32 Layer DiT;
- the task contract from `inference_profile.py`, followed exactly: `generation_edit` vs `layer_decompose`,
  and never inferred from a folder name.

**The cost** grows with (N+1) × image tokens, times two for CFG. For 4 layers at a 1024 working size that
is ~20K image tokens plus the reference frame, per pass. **The 24 GB default is therefore a 512 working
size and 4 layers**, with 1024 offered as "High quality (slow)", pending measurement.

**Verification gates:**
- a numerical comparison against PyTorch on CPU on a tiny slice (memory `pi-desktop-metal-precision`);
- a recomposite check: stack the layers, then compare RGB L1 against the input;
- visual review of the upstream 6-layer card sample (MIT asset).

### 4.10 Other platforms and remote serving

- **Linux/Windows (NVIDIA/AMD/Intel), track 4:** ComfyUI is the **baseline engine**.
  - Once PR #16482 merges, add a comfy template `ming-image-t2i` (and `-edit`) in
    `packages/gen-service/src/comfy-workflow.ts`, with `weights:` lists that point at Kijai's int8 DiT plus
    the w4a8 or int8 encoder, or at realrebelai's GGUFs (needs ComfyUI-GGUF #484).
  - Pin both in `comfy-install.ts` (`fetchGitHubTree`).
  - Evidence it fits consumer cards: the GGUF PR author ran it on an **8 GB RTX 3070 with `--lowvram`**,
    and the ROCm build shows ~87 s per 1024² image on Strix Halo.
  - **Not on the Mac** (MPS dequantizes GGUF; §3.5).
- **Remote, track 5 (Devices over Tailscale):** vLLM-Omni's OpenAI-compatible server on a big Linux GPU
  serves all three tasks. The gen protocol was built "remote-capable" (the `protocol.ts` header), so this
  is a catalog variant with `runsLocally: false` plus a transport. It depends on the Devices track.

### 4.11 Alternatives considered

| Alternative | Why rejected (for now) |
|---|---|
| Upstream PyTorch `infer.py` on MPS | Pins CUDA-only `transformer-engine`. The bf16 MLLM alone is 34 GB. The ROCm port shows PyTorch peaks of 33-59 GiB even with INT8. |
| ComfyUI on the Mac (Kijai PR + GGUF) | The PR is open and has a detection bug. MPS holds GGUFs dequantized (measured for Qwen-Image 2.1: guardian shed on 24 GB). The encoder's Q4 GGUF is 9.9 GB and would inflate on MPS. Keep ComfyUI as the baseline elsewhere. |
| Port Ming into mflux (Bobble's current image engine) | mflux has no Ming or BailingMoe code. mlx-vlm already has Ming, Z-Image, Qwen-Image, FLUX.2 and BailingMoe. Duplicating it would be weeks of work for no gain. |
| Call the mlx-vlm CLI (`mlx_vlm.generate --output-modality image`) per image | No per-step progress, one seed per process (so the ~10 GB encoder is reloaded per candidate), and the CLI cannot be paced. Use a Bobble driver over the pipeline class instead. |
| A persistent Ming server that keeps weights resident | Holds 4-14 GB when idle, against Bobble's memory posture (guardian, make-room). Process-per-job matches mflux, and the encode-once-many-seeds driver recovers most of the reuse. |
| nativ 8-bit as the default | The encoder alone is ~18.5 GB and cannot sit beside anything on 24 GB. It is only viable with expert offload (MING-13). |
| Use the MIT skills as they are (a hosted Novita API plus a frontier model) | Not offline. The README says the workflows "need a strong model". Take the prompts and workflow shapes instead (MING-12). |
| A hosted API fallback (OpenRouter/Novita) for small machines | Bobble is offline-first. Remote serving belongs to the user's own device (track 5). Left as a question for the user. |
| Make Ming the global default image model | It is a design specialist (#45 on the general board, where Qwen-Image 2.1 is not ranked). Keep the photo default and route design intents to Ming (presets plus tool guidance). The MIT-vs-research-nc angle is a question for the user. |

---

## 5. Work packages

Ordered. "Headless" means `apps/desktop/tests/e2e/harness.mjs` `launchApp` with its hidden window, a
throwaway `HOME` and `REAL_CACHE`/`REAL_LIBRARY` only when real weights are needed (memory
`user-headless-testing-always`). **GPU-heavy** packages need the user's go-ahead, AC power, a
`kern.memorystatus_level` trace and a 6% SIGKILL watchdog (memory `pi-desktop-memory-guard`).

### MING-0: Pin mlx-vlm and build the wheel (S)
- **Files:** new `packages/gen-service/python/mlx-vlm-ming/{build-wheel.sh,README.md,patches/*.patch}`,
  `packages/gen-service/python/wheels/mlx_vlm-…+bobble.ming-py3-none-any.whl`,
  `packages/gen-service/src/worker-command.ts` (+`worker-command.test.ts`): `MLX_VLM_WITH`,
  `baseWorkerWith('mlx-vlm')`, `buildEnvWarmArgs({ backend: 'mlx-vlm' })`.
- **Depends on:** none.
- **Accept:**
  - The wheel builds from a GitHub tarball of `7b3397a621` plus the patches (on_step, encode-once/many-seeds,
    per-layer quant overrides, per-layer eval), with no git.
  - The argv tests pass.
  - The env's size and import graph are recorded in the README (measured with a fresh `UV_CACHE_DIR`), and
    the resolution has **0 source builds**.
- **Verify:** vitest; `uv pip compile`/dry-run for source builds; `python -c "import mlx_vlm.models.ming_image"`
  inside the warmed env. No weights needed.

### MING-1: Protocol, worker and driver (M)
- **Files:** `packages/gen-service/src/protocol.ts` (+test): `Backend 'mlx-vlm'`, `DesignJobSpec`,
  `GenJob.design`. `packages/gen-service/src/client.ts`: `RunJobOptions.mlxVlmWith`.
  `packages/gen-service/python/worker.py`: `run_design`, `dispatch`. New
  `packages/gen-service/python/ming_generate.py`. `packages/gen-service/python/test_worker.py`.
- **Depends on:** MING-0.
- **Accept:**
  - A design job emits the same `GenEvent` sequence as an mflux job.
  - N seeds give one encode and N PNGs.
  - Fully opaque output is saved as RGB; transparent output as RGBA.
  - Pace, pause and cancel work on the child (SIGSTOP/SIGCONT/SIGKILL of the tree).
  - An error carries the child's stderr tail.
- **Verify:** python unit tests with a **stub pipeline** (no MLX weights) for line parsing, events, RGB/RGBA
  save and pacing; vitest for the NDJSON parser.

### MING-2: Catalog, weights module, runtime module and DTO (M)
- **Files:** `packages/gen-service/src/catalog.ts` (+`catalog.test.ts`): the `ming-image-0.1-design` entry,
  `ming-image-0.1-design-layer` (reserved), the `MlxVlmBackendConfig` type.
  `apps/desktop/electron/gen/gen-modules.ts` (+test): `design` module, `moduleForBackend`, `weightsModuleFor`.
  `gen-modules-main.ts`: `warmArgs('design')`, weights install through `downloadRepo` pinned to a revision.
  `weights-on-shelf.ts` (+test). `gen-catalog-dto.ts` (+test).
- **Depends on:** MING-1.
- **Accept:**
  - The catalog tests pass: MIT means not gated, the new backend maps to a module, steps 12, `previews: false`.
  - The weights land on `Image/Generation/<org__repo>`; `weightsPresent` is true after the download.
  - A first job waits on the cards, then continues.
- **Verify:** vitest. A headless **`ming-module-card-look.mjs`** (copied from `module-card-look.mjs`) drives
  the states through the `__gen_modules_store` seam and screenshots both cards. No download.

### MING-3: Dispatch, admission and the agent tool (M)
- **Files:** `apps/desktop/electron/gen/gen-manager.ts`: the `handleGenerate` branch for `mlxVlm`, bucket
  snapping, guidance lock, dropping the negative prompt, the transparency prefix, admission via
  `jobFootprintGB`, and refusing 2048² below 48 GB until measured. `gen-ipc-contract.ts` (`transparent`).
  `packages/gen-tools/src/{tools.ts,gen-contract.ts}` (+tests): `transparent` and the model guidance line.
  `packages/harness/src/presets/capabilities.ts`: the raster-design vs svg wording.
- **Depends on:** MING-2.
- **Accept:**
  - Unit tests build the right `DesignJobSpec` for studio and tool requests.
  - `media generate image … --model ming-image-0.1-design --transparent` parses in CLI mode.
  - On the 4B, **no svg-routing regression** and design prompts pick Ming.
  - Prefill/TTFT are measured before and after with any re-prefill fixed.
- **Verify:** vitest; `tool-surface-probe.mjs` (every command); `enhance-prefill-probe.mjs`.

### MING-4: First real runs and the numbers (M, GPU-heavy, needs the user's go)
- **Files:** new `apps/desktop/tests/e2e/ming-design-real-probe.mjs` (modelled on
  `qwen-image-21-real-probe.mjs`); the catalog numbers and comments.
- **Depends on:** MING-3.
- **Accept:**
  - Through the studio, headless with the real library: 1024² × 12 steps with a 4B chat model resident.
    Record s/step, wall time, MLX peak and the **OS free-memory drop per phase**, then set
    `residentFloorGB`/`peakResidentGB` from those.
  - The guardian admits, or make-room parks the chat model. No shed.
  - A transparent run gives a PNG with a real alpha channel (the count of non-opaque pixels is above 0).
  - Non-square buckets (16:9, 9:16) are checked visually.
  - One 2048² run on an idle machine, or it is explicitly skipped with the reason.
  - Images LOOK right, and the report carries them.
- **Verify:** the probe plus a measure-lowram-style trace, and visual review.

### MING-5: Words-in-picture benchmark and the recipe (L, GPU-heavy)
- **Files:** `packages/gen-service/python/mlx-vlm-ming/convert_recipe.py` (mixed-bit predicate, streaming
  shard-by-shard conversion), `apps/desktop/tests/e2e/ming-textbench.mjs`, sheets in `scratch/`, the catalog
  (`mlxVlm.prepared` or a published repo).
- **Depends on:** MING-4.
- **Accept:** nativ 4-bit vs 8-bit (offloaded) vs the Bobble mixed recipe on the benchmark (§4.3), same seeds.
  The shipped recipe gets every word exactly right. Its size and footprint are recorded. The conversion's
  transient disk use is at most one shard plus the output.
- **Verify:** contact sheets reviewed by eye (the user), plus an OCR helper if one is available; admission
  numbers re-measured for the chosen recipe.

### MING-6: The `design-layout` enhancer dialect (M)
- **Files:** `apps/desktop/electron/gen/prompt-guidelines.ts`, `prompt-enhancer.ts` (+`prompt-enhancer.test.ts`),
  `apps/desktop/tests/enhance/enhance-probe.mjs` (design cases), plus schema-constrained decoding in the
  enhancer's request.
- **Depends on:** MING-2 (catalog id). It can run in parallel with MING-3/4.
- **Accept:** with generation off, on gemma-4-E2B, Qwen3.5-4B and Ling-3.0-tiny:
  - **100% schema-valid** with constrained decoding;
  - user strings preserved exactly once in at least 15/16 cases;
  - no chat leakage;
  - output within ~1,200 tokens;
  - the transparency phrase preserved;
  - the chat slot not evicted (prefill check).
- **Verify:** mechanical grading in `enhance-probe.mjs`, plus vitest for `cleanDesignLayout`.

### MING-7: Studio presets, transparency, hub and engines UI (L)
- **Files:** `apps/desktop/src/studio/{ImageStudio.tsx,StudioRun.tsx,StudioShell.tsx}`,
  `apps/desktop/src/chat/ThreadMedia*` (checkerboard), `apps/desktop/src/models/recommended-catalog.ts`
  (+test), `apps/desktop/src/settings/engine-catalog.ts` (+test).
- **Depends on:** MING-3. The final ETA copy uses MING-4's numbers.
- **Accept:**
  - Every state in §4.8 is reachable and screenshotted.
  - No overlap or overflow (content-route fit).
  - Presets set model, shape and dialect.
  - The transparent result shows on a checkerboard.
  - The hub family renders with the inclusionAI avatar.
  - This is done in lockstep with track 8's editor layout.
- **Verify:** a headless **`ming-studio-look.mjs`** walks the states through the store seams (`__gen_store`,
  `__gen_modules_store`, `__modality_store`) and saves before/after screenshots
  (memory `user-visual-verification-ui`).

### MING-8: MLX port of image-edit and Layer decomposition (XL)
- **Files:** `packages/gen-service/python/mlx-vlm-ming/patches/` (vision tower, ref latents, multi-frame,
  learned padding, CFG 2, Layer converter), `ming_generate.py` (tasks `image-edit` and `layers`),
  `test_worker.py`, a numerical-gate script. Upstream PR to Blaizzy/mlx-vlm.
- **Depends on:** MING-1. Independent of MING-5.
- **Accept:**
  - The PyTorch-CPU vs MLX comparison on a tiny slice is within tolerance, or the fast path is shown to give
    the same output (memory `pi-desktop-metal-precision`).
  - The upstream card sample decomposes into 6 layers that restack to the input (RGB L1 < 0.05).
  - "Change the headline to …" works on a Ming-made poster.
  - Layer and edit footprints are measured, and defaults are set (512 × 4 layers on 24 GB).
- **Verify:** unit tests for shapes and contracts with no weights; the numerical script with tiny random
  weights; one real run each (GPU-heavy, with the user's go).

### MING-9: Layers in the product (L)
- **Files:** `packages/gen-tools/src/tools.ts` (`split_image_layers`), `packages/harness/src/tools/tool-cli.ts`
  (`COMMAND_PATH_OVERRIDES: split_image_layers → ['layers']`), `capabilities.ts`, a new
  `apps/desktop/src/studio/LayersPanel.tsx`, and in `tools/office-gen/` a new `layers_to_pptx.py`
  (scene.json → PPTX, after image-to-editable-ppt).
- **Depends on:** MING-8, MING-7.
- **Accept:**
  - The tool returns RGBA paths and a manifest.
  - The panel toggles, reorders and exports.
  - "Make editable slide" yields a PPTX whose text is native text boxes, and it renders through the office
    render check.
  - Comment pins become edit instructions (with track 8).
- **Verify:** a headless `ming-layers-look.mjs` (panel screenshots) and an office inspect of the PPTX.

### MING-10: ComfyUI baseline for Linux and Windows (M, blocked upstream)
- **Files:** `packages/gen-service/src/comfy-workflow.ts` (+test), the catalog `weights:` lists,
  `apps/desktop/electron/gen/comfy-install.ts` (pins), `engine-catalog.ts`.
- **Depends on:** MING-2, plus `Comfy-Org/ComfyUI#16482` and `city96/ComfyUI-GGUF#484` merging.
- **Accept:** the graph validates against an `/object_info` fixture, and a real run on a Linux or Windows
  box (with the Devices/compat tracks) produces an RGBA design.
- **Verify:** vitest against the fixture; a remote run log and image.

### MING-11: vLLM-Omni as a remote engine (S, blocked on track 5)
- **Files:** a catalog variant (`runsLocally: false`) and the transport adapter in the Devices track.
- **Depends on:** MING-2 and the Devices track.
- **Accept:** a Bobble client on the Mac gets T2I, edit and layers from a tailnet GPU box.
- **Verify:** a probe against a stub OpenAI server, then a real device.

### MING-12: Design workflows for agents (L, cross-track 10/11)
- **Files:** workflow templates in the harness (track 11) and office-gen imagery (track 10).
- **Depends on:** MING-4, MING-9.
- **Accept:** a "visual-first site" workflow (reference → layers → crops → code → screenshot-compare, at most
  5 cycles) and "slide image → editable PPTX" complete on the local 9B at a measured success rate, with
  samples critiqued against the non-Ming baseline.
- **Verify:** the track-10 sample harness with before/after images.

### MING-13: Expert-offload encoder for 16 GB Macs and 8-bit quality (M)
- **Files:** the patches (per-layer `mx.eval` plus mlx-vlm `moe_offload` repack at prepare time), catalog
  variants.
- **Depends on:** MING-5.
- **Accept:** the 8-bit encoder runs with at most ~3 GB resident on 24 GB. The encode time is recorded. A
  16 GB-class admission is simulated through the guardian env seams (`PI_GUARDIAN_*`) and the decision is
  recorded.
- **Verify:** a measure-lowram trace, and the benchmark subset from MING-5.

**Suggested order:** MING-0 → 1 → 2 → 3, with MING-6 in parallel from 2 and MING-7 from 3. Then MING-4
(needs the user's go) → MING-5 → MING-13. MING-8 can start after 1, followed by MING-9. MING-10, 11 and 12 wait
on upstream work or other tracks.

---

## 6. Risks, blockers and open questions

### Risks and blockers
1. **GPU-heavy measurement is gated.** MING-4, -5 and -8 need real downloads (13-25 GB, or 53 GB bf16 for
   our own recipe) and long GPU runs. They need the user's go-ahead and AC power. None of the numbers for this
   Mac are measured yet.
2. **The code is two days old and still moving.** The mlx-vlm support was merged today and is not in a PyPI
   release (0.7.2). The ComfyUI PR is open with a detection bug. ComfyUI-GGUF #484 is open. The nativ repos
   are one day old. Pin commits and revisions, and ship a wheel (the Qwen-Image 2.1 pattern).
3. **Memory on 24 GB.** The encode phase alone is ~10-11 GB estimated at 4 bits. With the chat model
   resident, admission may often need make-room. 16 GB is unknown until MING-13. 8 GB is out.
4. **2048² is the vendor's recommended quality and is impractical here** (M5 Max bf16: 52.9 s/step, 43 GB
   peak). The 1024² default may render dense UI text less crisply. That is unmeasured.
5. **Quantization can break text rendering**, as the Qwen-Image 2.1 precedent shows. The recipe is not
   settled until MING-5 has been run.
6. **Prompt quality.** The vendor pipeline assumes a 27-124B VLM rewriter. A 2-4B enhancer will write
   weaker layouts. Constrained decoding fixes validity, not taste, so MING-6 has to measure this.
7. **Layers and editing on a Mac have no runtime yet.** It is an XL port with numerical risk (CFG 2 on
   Metal), and the Layer cost grows with the layer count.
8. **The quality claim is the vendor's own.** The 1082 Elo UI/UX #1 open-weights figure comes from their
   graphic. Independently it is #45 (995) on the general board. It is a design specialist, not a photo model.
9. **Disk.** Transient conversions of 53-65 GB need the streaming converter or a published recipe. the user's
   disk had ~7 GB free on 2026-09-13 and has 176 GB today.
10. **Routing drift.** Adding a raster "design" path must not pull icons and logos away from OmniSVG
    (the user's svg rule). The tool-surface probe on the 4B guards this.
11. **Naming.** "antling ming 0.1" was not written out exactly. The mapping to Ming-Image-0.1-Design(+Layer)
    is about 95% certain (§3.1).

### Questions for the user
1. Is "antling ming 0.1 design models" the **Ming-Image-0.1-Design** and **Ming-Image-0.1-Design-Layer**
   pair from Ant Ling / inclusionAI (MIT, 2026-09-22), and do you want **both**, generation and
   layer-split?
2. On 24 GB Macs, may the **default be 1024²** (≈1-1.5 min estimated) with 2048² as a slow "Large" option
   (≈15-20 min estimated), even though the vendor recommends 2048²?
3. May I run a **GPU-heavy measurement session** on AC power (a 13-25 GB download, and possibly the 53 GB
   bf16 for our own recipe) to set the memory numbers and pick the quant recipe?
4. Should the agent **route design requests to Ming automatically** (posters, UI screens, infographics,
   slides-as-images, transparent cutouts), or only when it is picked? And since Ming is **MIT** while the
   current default Qwen-Image 2.1 is non-commercial, should that change any defaults?
5. Will you provide a **Hugging Face write token** so Bobble's tuned MLX recipe can be published? That turns
   a 53 GB fetch-and-convert into a ~11-14 GB download. It is the same ask as OmniSVG and Qwen-Image 2.1.
6. Should Ming's **UI-design and image-to-editable-PPT workflows** (MIT skills) become Bobble workflows for
   website and deck quality (tracks 10/11), knowing their authors say they need a strong model?
7. For Linux and Windows: should we **wait for upstream ComfyUI support** (PR #16482), or ship a Bobble
   custom node earlier?

---

## Sources

- Models: [Ming-Image-0.1-Design](https://huggingface.co/inclusionAI/Ming-Image-0.1-Design) ·
  [Ming-Image-0.1-Design-Layer](https://huggingface.co/inclusionAI/Ming-Image-0.1-Design-Layer) ·
  [inclusionAI org](https://huggingface.co/inclusionAI) · [Ming-Image code](https://github.com/inclusionAI/Ming-Image)
  (`infer.py`, `inference_profile.py`, `modeling_bailingmm2.py`, `diffusion/{pipeline,generator,transformer}.py`,
  `bailingmm_utils.py`, `requirements.txt`) · [announcement on X](https://x.com/AntLingAGI/status/2102452045374804304) ·
  [WeChat blog](https://mp.weixin.qq.com/s/VGdtxfM8kbHIQJw50VD_Sw) ·
  [ArtRealmAI](https://artrealmai.com/article/ant-ming-image-0-1-design) · [TechFlow](https://www.techflowpost.com/en-US/newsletter/137477)
- Skills: [ling-cookbook recommended skills](https://github.com/inclusionAI/ling-cookbook/tree/main/resources/recommended-skills)
  (`ling-ui-design`, `image-to-editable-ppt`)
- Runtimes: [mlx-vlm PR #2334](https://github.com/Blaizzy/mlx-vlm/pull/2334) and
  [ming_image code](https://github.com/Blaizzy/mlx-vlm/tree/main/mlx_vlm/models/ming_image) ·
  [mlx-vlm on PyPI](https://pypi.org/project/mlx-vlm/) ·
  [nativ MLX 4-bit](https://huggingface.co/nativ-community/Ming-Image-0.1-Design-MLX-4bit) ·
  [nativ MLX 8-bit](https://huggingface.co/nativ-community/Ming-Image-0.1-Design-MLX-8bit) ·
  [Nativ app](https://github.com/Blaizzy/nativ) ·
  [vLLM-Omni recipe](https://github.com/vllm-project/vllm-omni/blob/main/recipes/inclusionAI/Ming-Image.md) and
  [PR #8021](https://github.com/vllm-project/vllm-omni/pull/8021) ·
  [ComfyUI PR #16482](https://github.com/Comfy-Org/ComfyUI/pull/16482) ·
  [Kijai weights](https://huggingface.co/Kijai/Ming-Image-ComfyUI) ·
  [ComfyUI-GGUF PR #484](https://github.com/city96/ComfyUI-GGUF/pull/484) ·
  [realrebelai GGUFs](https://huggingface.co/realrebelai/Ming-Image_GGUFs) ·
  [alexokita INT4](https://huggingface.co/alexokita/Ming-Image-0.1-Design-INT4) and
  [ComfyUI workflow](https://huggingface.co/alexokita/Ming-Image-0.1-Design-ComfyUI) ·
  [WanGP weights](https://huggingface.co/DeepBeepMeep/MingImage) ·
  [ROCm Strix Halo build](https://huggingface.co/kingjones777/Ming-Image-0.1-Design-ROCm-INT8) ·
  [ostris training adapter](https://huggingface.co/ostris/ming_image_training_adapter)
- Quality: [Artificial Analysis text-to-image board](https://artificialanalysis.ai/image/leaderboard/text-to-image) ·
  vendor graphic `assets/uiux_leaderboard.webp` and Crello table `assets/performance.webp` in the HF repos ·
  [orcarouter critique](https://www.orcarouter.ai/blog/ming-image-0-1-design-quiet-release) ·
  [Qwen-Image-Layered paper](https://arxiv.org/abs/2512.15603)
- Hosted: [OpenRouter: Design](https://openrouter.ai/inclusionai/ming-image-0.1-design) ·
  [OpenRouter: Layer](https://openrouter.ai/inclusionai/ming-image-0.1-design-layer)
- Architecture comparison: [Z-Image-Turbo transformer config](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/blob/main/transformer/config.json)
- Bobble memory notes used: `pi-desktop-qwen-image-21`, `pi-desktop-gen-modules`, `pi-desktop-gen-stack-live`,
  `pi-desktop-comfy-mps-quants`, `pi-desktop-guardian`, `pi-desktop-memory-guard`, `pi-desktop-low-power-generation`,
  `pi-desktop-metal-precision`, `pi-desktop-omnisvg-connector`, `pi-desktop-storage-queue`,
  `pi-desktop-studios-and-enhancer`, `user-big-push-2026-09-23`.
