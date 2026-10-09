# Training — on-device + cross-device training, Unsloth-Studio parity, exports

Research doc for tracks 3 + 7 of the 2026-09-23 push. Base commit `c9fe7098`.
Research only: nothing in the repo was changed; no model, server or training job was run.

**Recommendation in one paragraph.** Add a **Training** workspace route (sidebar,
beside Scheduled) with three tabs — **Configure · Current run · History** — and an
**Export** sheet. A Bobble-owned job runner drives a Python worker over the same kind of
NDJSON protocol the generation worker already uses, so a job can run on this Mac or on
a tailnet device without changing the protocol. On Apple Silicon the worker trains with
**mlx-lm + mlx-train-perf** (both MIT, pinned to the exact mlx/mlx-lm/transformers versions
already in `~/.cache/bobble/engines/mlx-venv`). On NVIDIA/AMD/Intel it uses **Unsloth**
(Apache-2.0 core) in its own venv. Exports merge the LoRA delta into the **original
Hugging Face weights**, then run a **tag-pinned `convert_hf_to_gguf.py`** and the
**`llama-quantize` we already ship**. The result goes straight into `~/Bobble/Models`
and the model picker, with the MTP speed head kept.

**Biggest findings (all verified against code on this Mac):**

1. **The mlx-lm we ship can't usefully train our own default model family.** Qwen3.5 mixes
   Gated-DeltaNet (linear attention) layers with full attention. `mlx_lm 0.31.3` (still the
   latest on PyPI) runs those layers with `use_kernel=not self.training`, so training falls
   back to a per-token Python loop. That costs about 7 GB for **one** layer at 1,024 tokens
   (mlx-lm PR #1870's benchmark). Fixes exist only in Unsloth's MLX kernels (merged
   2026-09-06) and in mlx-train-perf 0.7+ (`enable_gated_delta_training`). mlx-lm's own
   fix, PR #1870, is still open.
2. **`mlx_lm.fuse` output would convert into a broken GGUF.** mlx-lm's `qwen3_5.sanitize`
   adds `+1.0` to every RMSNorm weight, drops `mtp.*` and drops the vision tower.
   llama.cpp's converter adds `+1` again (`conversion/qwen.py:394`). The export has to
   merge into the original HF safetensors instead. As a side benefit, that path keeps the
   MTP head, because llama.cpp b10603's `_QwenMtpMixin` converts `mtp.*` to nextn layers.
3. **Two upstream llama.cpp bugs block the "LoRA adapter on a GGUF" shortcut for
   Qwen3.5**: `convert_lora_to_gguf.py` crashes (#21125; fix PR #28324 still open), and
   the server reuses the prompt cache across different per-request LoRAs (#26207, open).
   So v1 exports **merged** GGUFs, and Compare uses two model instances rather than a
   per-request LoRA toggle.

---

## 1. Goal

The user's words:
- "training dashboard/on device training w/ export quantization and such"
- "training across devices/on device with UI parity to unsloth studio w/ easy gguf/other format exports and such."

Restated precisely, this track must deliver:

1. **A training surface in Bobble** (the "dashboard"): configure a run, watch it live
   (loss/eval/LR/grad-norm charts, progress, ETA, device health), see past runs, resume
   them, and export results.
2. **On-device training** on this Mac (Apple Silicon, MLX): LoRA and QLoRA (quantized
   base) as the core, plus full fine-tune on small models. Datasets come from Hugging Face
   or from local files.
3. **Training on other hardware**: NVIDIA, AMD and Intel GPUs on Linux and Windows, both
   when Bobble runs there and when it is reached as a remote device.
4. **Training across devices**: pick which device trains (this Mac or a tailnet box), and
   where it makes sense, several devices on one run.
5. **UI parity with Unsloth Studio's training flow**: model and method pick, dataset pick
   with format and column mapping, simple/advanced hyper-parameters, run preview with fit
   verdict, live charts with smoothing, stop-and-save/resume, history, compare-in-chat,
   and export.
6. **Easy exports**:
   - GGUF, any quant with an imatrix, into Bobble's own model library.
   - Merged 16-bit safetensors.
   - LoRA adapters.
   - MLX (8/6/4-bit).
   - Hugging Face push.
   - Other local runners (Ollama, LM Studio).
   - Quantization is part of the export. The MTP head stays so the result keeps its
     speculative-decoding speed.

Out of scope for v1, and filed as later work packages: preference/RL training (DPO/GRPO),
image LoRAs, synthetic "data recipes", S3 datasets, streaming datasets, continued
pre-training on Mac.

**Roadmap note.** `ROADMAP-LATEST.md` §6 puts fine-tuning "strictly after 5" (Linux/Windows
+ clustering), because "fine-tuning on one Mac is a much smaller idea than fine-tuning
across connected machines". The user has now pulled it forward. On-device parts (WPs TR-0…TR-13)
have no dependency on tracks 4/5. Cross-device parts (TR-14…TR-16) do.

---

## 2. What exists today

**No training code exists anywhere.** `grep -riE "fine-?tun|lora|unsloth|mlx_lm.lora|training"`
over `apps/desktop/{src,electron}` and `packages/*/src` hits only hub labels, the
"Fine-tune ready" filter and llama.cpp flag names. Here is what the new code can build on:

| Area | Where | What it gives the training track | Gap |
|---|---|---|---|
| Content routes | `apps/desktop/src/App.tsx` — `MainView = 'chat'\|'gallery'\|'models'\|'connectors'\|'scheduled'`, `contentOverride`, `contentTitle` | The seam Scheduled/Extensions/hub use; studios ride it too | No `'training'` view |
| Sidebar | `apps/desktop/src/chat/SessionSidebar.tsx` `workspaceNav` (Model management · Extensions · Scheduled), Modalities rows gated by `settings.capabilities` | Where a Training row goes | No row; no glyph (`packages/ui/src/components/glyph.tsx` `GLYPHS` has none) |
| Settings | `apps/desktop/src/settings/SettingsView.tsx` `NAV`; `electron/settings/settings-contract.ts` (`capabilities: GenerationCapabilities {image,video,audio,threeD}`, `hfToken` plain string, `modelsRoot`) | Pattern for a `training` block + capability toggle | No training settings; no write-token storage (no `safeStorage` use anywhere) |
| Model hub | `apps/desktop/src/models/ModelsView.tsx` (Models\|Datasets switch; Discover · On Device · Manage Storage), `models-layout.ts` (`format: 'finetune'` = "Fine-tune ready" = has safetensors) | Base-model search, the Unsloth-style layout the user already approved | Datasets are **read-only**: `rowAction` opens the Hub page — the comment says "Local dataset download is its own piece of work" |
| Dataset search | `apps/desktop/electron/inference/dataset-search-main.ts`, IPC `datasets:search` (`ipc-contract.ts` `DatasetInvokeMap`, `DatasetHitDTO`) | HF dataset listing with sizes | No splits/preview/download/import/format detection |
| Model library | `packages/model-store/src/library.ts` (`~/Bobble/Models`, shelves `LLM`, `LLM/MLX`, …), `packages/inference/src/paths.ts` `modelDir(id)` = `<library>/LLM/<id>`, Manage Storage (`StorageView.tsx`, `storage:*` incl. `storage:check-space`) | Where exports land; disk checks | No `LLM/Adapters` shelf; no Training/Datasets roots |
| Model registration | `packages/inference/src/catalog.ts` `CatalogModel` (`mtpEmbedded`, `specDisabled`, `mlxRepo`, `baseRepo`, `purpose`); `hf:register` → `supervisor-entry.ts` `registerHfModel()` → `~/.pi/desktop/hf-models.json`; `LlmCatalogEntry.source: 'curated'\|'hf'` | Exported GGUFs become launchable catalog entries the same way HF adds do | No `register-local-model`; no `source: 'trained'` |
| llama.cpp | `packages/inference/src/llamacpp-manifest.ts` pins **b10603**. The macOS tarball on disk contains `llama-quantize`, `llama-imatrix`, `llama-perplexity`, `llama-export-lora`, `llama-gguf-split`, `ggml-rpc-server` | Quantize, imatrix, perplexity checks with **no new binaries** | `convert_hf_to_gguf.py` / `convert_lora_to_gguf.py` are **source-only** (Python) — not in the tarball. `llamacpp-source-build.ts` already fetches GitHub source archives by commit without git (reusable pattern). A b10603 source tree sits in `~/.cache/bobble/omnisvg/llama.cpp` from the hand-done OmniSVG conversion (catalog.ts:1642 comment) — not app code |
| MLX engine venv | `electron/inference/engines-main.ts`, `engine-paths.ts` `mlxVenvRoot()` = `~/.cache/bobble/engines/mlx-venv`: **mlx 0.32.2, mlx-lm 0.31.3, mlx-vlm 0.6.3, transformers 5.12.1, datasets 5.0.1** | `mlx_lm.lora`, `fuse`, `convert` (+`dwq`/`awq`/`gptq`/`dynamic_quant`), `perplexity`, `upload`, `server --adapter-path` are already on disk | Training must not share this venv (engine upgrades would break training pins) |
| Python job pattern | `packages/gen-service/src/worker-command.ts` (`buildWorkerUvArgs`, `buildEnvWarmArgs`: `uv run --no-project --python 3.12 --with …`), `protocol.ts` ("remote-capable seam", NDJSON), `ensureUv` (pinned uv, Finder-PATH-safe) | Exact template for the training worker + its install | — |
| Module install UX | `electron/gen/gen-modules.ts` / `gen-modules-main.ts` (marker files, `gen:module*` IPC, wait-then-continue), `src/media/ModuleCard.tsx`, `src/chat/ModuleNotice.tsx` | "Training module · ~0.7 GB · Download" card, same anatomy | — |
| Machine safety | `packages/inference/src/guardian.ts` + `electron/gen/guardian-main.ts` (`admit(footprintGB)`), `electron/gen/pausables.ts` (SIGSTOP tree, kinds `'gen'\|'gen3d'\|'agent'`), `model-fit.ts` (`RAM_RESERVE_FRACTION = 0.3`), `pressure.ts` (`onBattery` via `pmset -g ps`, thermal via `pmset -g therm`, nvidia-smi util), `taskpolicy -t 5 -l 5` worker tier, `parkChatModel` (main.ts) | A training run registers as a pausable, is admitted by footprint, is paused on memory pressure, and can park the chat model | No `'train'` kind; no AC-only policy for long jobs |
| Hardware | `packages/inference/src/accelerator.ts` (OS, GPU vendor, VRAM, CUDA major, unified memory) | Backend selection per machine | — |
| Cluster | `packages/cluster` — `readTailnet()`, `probePeer()` → `GET http://<100.x>:8765/cluster/hello` (`PeerCapabilities`) | Device discovery for "where to run" | **Not imported anywhere yet**; no server side; no auth. The Devices track (5) owns this |
| Charts | `packages/charts` (`layoutChart`, `linePath` monotone, looks), `packages/canvas/src/surfaces/chart-surface.tsx` `ChartView` | Line/area rendering primitives in the house style | Category-axis charts; a live loss chart needs downsampling + EMA + log scale |
| Engine flag names | `src/chat/engine-settings/flag-names.ts` already names `--lora`, `--lora-scaled`, `--lora-init-without-apply` | Cosmetic only | — |
| Reference app on disk | **Unsloth Studio 2026.8.21** installed at `~/Applications/Unsloth Studio.app`, source at `~/.unsloth/studio/unsloth_studio/lib/python3.13/site-packages/studio/{frontend/src,backend}` + `unsloth_zoo/mlx/*` | The parity inventory below was read from this source (not blogs), per the `pi-desktop-unsloth-desktop-reference` rule | — |

---

## 3. External research

### 3.1 Unsloth Studio — what it is, and the complete training UI

- **What it is.** A Tauri desktop app plus a FastAPI backend in-repo at `unslothai/unsloth/studio/`.
  Studio code is **AGPL-3.0-only**; the `unsloth` core is **Apache-2.0**.
  `unsloth_zoo` declares **LGPL-3.0-or-later** in its metadata, but 19 of its files, including
  all of `unsloth_zoo/mlx/`, carry AGPL headers. Latest on PyPI: `unsloth 2026.9.11` and
  `unsloth-zoo 2026.9.7` (2026-09-22/23).
- **How it runs.**
  - On Mac, training goes through `unsloth_zoo.mlx` (`FastMLXModel`, `MLXTrainer`: ~42k
    lines incl. compile passes, cut-cross-entropy, 8-bit optimizers, DPO/ORPO,
    `mx.distributed` incl. JACCL).
  - On NVIDIA/AMD/Intel it uses torch + TRL.
  - The installed Studio directory on this Mac (`~/.unsloth/studio`, venvs included) is
    **2.3 GB**. Its venv holds torch 2.10, mlx 0.32.1, mlx-lm 0.31.3, mlx-vlm 0.6.16 and
    peft 0.18.1.
- **"Across devices" in Unsloth.**
  - A LAN listener (`backend/lan_access.py`: second uvicorn listener, QR code) and a
    Cloudflare tunnel let a phone or laptop *use* Studio running on a GPU box.
  - Multi-GPU is single-node only (`device_map="balanced"`, `gpu_ids`; FSDP2 is a design note).
  - The MLX trainer can run under `mlx.launch`, but the UI does not expose multi-machine runs.
  - **Bobble's cross-device design (§4.12) therefore goes beyond parity.**

**Training screen inventory (read from `frontend/src/features/{studio,training,export,dataset-picker,train-model-picker}`):**

| Area | Unsloth Studio behaviour | Mac restrictions in 2026.8.21 |
|---|---|---|
| Layout | Route "Train"; tabs **Configure / Current Run / History**; a stack of wizard cards on the left and a sticky **Run preview** card on the right; "Image training" link to a separate diffusion-LoRA mode | — |
| Model card | Base-model picker: Hub search, paste an id, local scan of models folder / HF cache / LM Studio / Ollama / custom folder. Rejects GGUF, adapters and wrong model type. VRAM badges (OOM / Tight / ~N GB). **Method** select: QLoRA · LoRA · Full · Continued pretraining, each with a one-line hint and coloured dot. HF-token indicator | CPT disabled; audio/embedding models disabled |
| Dataset card | Source: Hugging Face · Upload · S3 · local/"Recipe". Subset / train split / eval split selectors (or manual entry). Streaming toggle with a blocker list. Advanced: target format auto/alpaca/chatml/sharegpt/raw, row slice start/end, eval-file upload. PDF/DOCX uploads are redirected to Data Recipes. **Preview dialog** with per-column role dropdowns in the table headers (heuristic mapping plus an AI-assist mapper), system prompt, label mapping | Streaming unsupported on MLX |
| Parameters card | **Simple/Advanced** toggle. Project name. Epochs ⇄ Max steps toggle. Context length. LR with a recommendation line (LoRA 2e-4, CPT 5e-5, full 2e-5). Embedding LR (CPT). LoRA rank/alpha/dropout. Variant: LoRA / rsLoRA / LoftQ / DoRA. Target modules + vision/language/attention/MLP toggles. Optimizer, scheduler (linear/cosine), batch, grad-accum, weight decay, warmup, save steps, eval steps (fraction), seed, grad checkpointing (none/standard/unsloth/mlx), packing, assistant-completions-only, W&B/TensorBoard | LoftQ, DoRA (DoRA added later per changelog), packing off |
| Config card | Load/Save YAML, Reset to model defaults (per-model YAMLs under `backend/assets/configs/model_defaults/…`; defaults: seq 2048, lr 2e-4, bs 2, accum 4, r=16, α=16, q/k/v/o/gate/up/down, completions-only on) | — |
| Run preview | Ready/not-ready; method; length (steps/epochs); batch; context; LR; hardware; HF token; "downloads on start" for model and dataset; notices (e.g. an architecture that only trains in 16-bit, which needs much more VRAM); count of non-default advanced settings; Start CTA with disabled reasons | — |
| Start overlay | Terminal-style lines while resources download (model weights and dataset bars with ETA) → "waiting for first step" | — |
| Current run | Phase chip (downloading model/dataset, loading, configuring, training, *finalizing = saving*, completed, error, stopped). Epoch, % complete, step x/y, elapsed, ETA, steps/s, tokens. Charts: **Training loss** (raw + EMA-smoothed + average line), **Eval loss**, **Learning rate**, **Grad norm**. Chart settings: view window (latest N/all), smoothing slider, linear/log, clip p99/p95, per-axis. **GPU monitor** (utilization, temperature, VRAM, power). Config drawer. Stop dialog: *Stop* / *Stop and Save* (resumable) / continue. Halfway milestone toast. Done → **Compare in Chat** / **Export** | — |
| History | Card grid: status, final loss, loss sparkline, steps, relative time. Open, **Resume** (from a saved checkpoint), Delete with "also delete adapter files on disk" (shared-folder safe), load more | — |
| Export | Source: a training run → checkpoint, or any local/HF model. Method: **Merged** (16-bit; NVIDIA-only compressed-tensors FP8/INT8/W4A16/MXFP4/NVFP4; portable torchao FP8/INT8), **LoRA only** (safetensors, or GGUF adapter with outtype), **GGUF** (full model or LoRA target). Quant multi-select IQ2_XXS…F16 with **Q4_K_M recommended**; IQ quants need an imatrix; an imatrix switch **auto-downloads Unsloth's upstream imatrix** for the base. Size estimate from a bits-per-weight table. Destination: save locally (folder) or **Push to Hub** (username, repo name, token, private; one format per push) | GGUF-LoRA unavailable on Mac; "LoRA adapter" GGUF target hidden on Mac |
| Compare in chat | Split view, base vs fine-tuned; "fast simultaneous adapter-toggle path" when the checkpoint is a LoRA (`features/chat/chat-page.tsx`, `lib/training-compare-handoff.ts`) | — |
| Extras | Data Recipes (NVIDIA Data Designer graphs; templates: PDF-grounded QA, text-to-SQL, OCR extraction…), guided tours, diffusion LoRA training, memory coordination that evicts the resident chat/STT model when training needs VRAM (`routes/training_vram.py`: keep only if free ≥ required×1.15 + 4 GB) | — |

Recent changelog items (after the installed build):
- DoRA and more DPO loss types on Apple Silicon.
- Data Recipes dataset downloads.
- Better training memory estimates.
- Checkpoint saves on container shutdown.
- An AMD ROCm Docker image.
- RDNA1/2 support.
- Multi-user accounts.
- Default GGUF export changed to Q4_K_M.

Two of their bugs not to copy (already in `pi-desktop-unsloth-desktop-reference`):
- base-1000 vs base-1024 GB mixing;
- several fit estimators that disagree with each other.

### 3.2 On-device training on Apple Silicon

**Candidate stacks (versions checked on PyPI 2026-09-23):**

| Stack | License | What it adds | Qwen3.5 (Gated-DeltaNet) training | Fit for Bobble |
|---|---|---|---|---|
| **mlx-lm 0.31.3** (`mlx_lm.lora`, already in our venv) | MIT | LoRA/DoRA/full; QLoRA over MLX 4/8-bit bases. Formats `messages`(+`tools`), `prompt/completion`, `text`. `mask_prompt`. Grad checkpointing, grad accumulation. `TrainingCallback` (`on_train_loss_report` gives iteration, loss, lr, it/s, tokens/s, trained_tokens, **peak_memory**). Built-in data-parallel via `mx.distributed` + `average_gradients` | **Unusable past ~1k tokens.** `qwen3_5.py:194` `use_kernel=not self.training` → `gated_delta_ops`, a per-token loop keeping every state in the graph. PR #1870 (chunkwise, open, updated 2026-09-19) measures one layer at 1,024 tok: 7.09 GB/1.88 s vs 1.08 GB/0.05 s; 4,096 tok: ~108 GB vs 4.95 GB | Base layer only |
| **mlx-train-perf 0.8.0** (IonDen, 2026-09-17) | MIT | Wraps mlx-lm's loop: **logit-free (fused) cross-entropy**; flash-attention *training* kernels (fwd+bwd, O(N) memory); **sequence packing**; a **RAM-fit planner** (reads 1.09–1.19× of real peaks); `enable_gated_delta_training(model, impl="chunked")` for qwen3_5 (0.7.0, merged 2026-09-16; refuses MoE and packing on that family); optional external memory guard (0.8.0). Pins `mlx>=0.32,<0.33`, `mlx-lm>=0.31.3,<0.32`, `transformers>=5.0,<5.13` — **exactly our venv pair** | Supported (chunked) | **Chosen**: license-clean, small, matches our pins |
| **unsloth_zoo MLX** (via `unsloth`) | LGPL/AGPL headers | Most complete: fused Metal **gated-delta training backward** (PR #1142, merged 2026-09-06: 2.3–2.9× layer speed, peak memory ~unchanged at model scale because checkpointing already bounds it), memory-efficient custom VJP (`unsloth_zoo/gated_delta_vjp.py`), CCE, 8-bit Adam, DPO/ORPO, distributed (JACCL). GGUF export that rewrites MLX-VLM tensors and syncs the nextn config | Supported (open Qwen3.5 Studio bug #6002 on older mlx-vlm) | Optional "Unsloth engine" later (TR-17) if TR-0 shows a large win |
| mlx-lm-lora 3.1.3 | MIT (PyPI) | 13 algorithms (SFT, DPO, CPO, ORPO, GRPO, GSPO, DAPO, online DPO, PPO…); QLoRA 4/6/8-bit, QAT | Inherits mlx-lm's path | Good for DPO/GRPO later (harness LoRA) |
| mlx-tune 0.6.0 | Apache-2.0 | Unsloth-compatible API; SFT/DPO/GRPO/vision/TTS/STT; GGUF export (not from 4-bit bases) | Claims support | Watch; less mature |

**Qwen3.5 facts that drive memory** (read from each repo's `config.json` and `model.safetensors.index.json`):

| Model | Layers (GDN + full) | hidden / MLP | Text params | bf16 weights | HF repo size (incl. vision + MTP) | MTP tensors |
|---|---|---|---|---|---|---|
| Qwen3.5-0.8B | 18 + 6 | 1024 / 3584 | 0.75 B | 1.5 GB | 1.75 GB | 15 (`mtp.*`) |
| Qwen3.5-2B | 18 + 6 | 2048 / 6144 | 1.88 B | 3.8 GB | — | 15 |
| Qwen3.5-4B | 24 + 8 | 2560 / 9216 | 4.21 B | 8.4 GB | 9.32 GB | 15 |
| Qwen3.5-9B | 24 + 8 | 4096 / 12288 | 8.95 B | 17.9 GB | 19.31 GB | 15 |

- Vocab: **248,320**.
- GDN heads: Hk=16, Hv=16/32, Dk=Dv=128.
- `linear_attn` projections are named `in_proj_qkv`, `in_proj_z`, `in_proj_a`, `in_proj_b`, `out_proj` (+`conv1d`, `A_log`, `dt_bias`).
- License: Apache-2.0, not gated.
- Unsloth's Qwen3.5 guide:
  - bf16-LoRA VRAM on CUDA: 0.8B 3 GB, 2B 5 GB, 4B 10 GB, 9B 22 GB.
  - Advises **against QLoRA 4-bit for Qwen3.5** because quantization differs more than usual.
  - Recommends r=16/α=16 on q/k/v/o/gate/up/down (which touches only the 8 full-attention
    layers plus every MLP).
  - Says to keep **≥75% reasoning examples** to preserve thinking.

**Estimated footprint on this Mac.**
- Formula: bf16 LoRA, r=16 on attention+MLP, batch 1, sequence 2,048, grad checkpointing on,
  fused CE + chunked GDN, and a ×1.15 planner factor (mlx-train-perf's measured accuracy).
- Budget: 70% of 24 GB = 16.8 GB (`model-fit.ts`), minus ~1.5 GB for Bobble + pi.

| Model | Weights | LoRA + Adam state | Activations (ckpt + one-layer recompute) | Logits | ≈ Total | Verdict |
|---|---|---|---|---|---|---|
| 0.8B bf16 | 1.5 | 0.1 | ~0.5 | ~0 fused (2–6 GB unfused) | **~2.5 GB** | fits |
| 2B bf16 | 3.8 | 0.2 | ~0.8 | ~0 | **~5.5 GB** | fits |
| 4B bf16 | 8.4 | 0.35 | ~1.5 | ~0 | **~11.5 GB** | fits **only with the chat model parked** (a resident 4B Q8 chat model is +4.6 GB) |
| 9B bf16 | 17.9 | 0.5 | ~2 | ~0 | ~23 GB | **won't fit** |
| 9B 8-bit base | 9.5 | 0.5 | ~2 | ~0 | **~13.8 GB** | tight; chat parked |
| any Qwen3.5, stock mlx-lm | — | — | **+~7 GB per GDN layer at 1k tokens** (recomputed one layer at a time) | +2–6 GB | OOM beyond ~1k tokens | ✗ |

**Measured speed data points** (no local run was made; TR-0 measures this Mac):
- mlx-train-perf on an M1 Max 32 GB: Qwen3-8B-4bit LoRA **33 tok/s unpacked → 99 tok/s packed**;
  Llama-3.2-3B-4bit 71.5 → 194 tok/s.
- WWDC26 session 233: `mlx_lm.lora` on **Qwen3.5-9B** runs ~**180 tok/s on one M3 Ultra**,
  ~**600 tok/s on four** M3 Ultras over Thunderbolt 5 RDMA.
- Expected here (to confirm in TR-0): hundreds of tokens/s for 4B on an M5 Pro. A
  2M-token epoch (2,000 examples × 1k tokens) takes **hours**, not minutes. The UI must say
  so up front, and remote NVIDIA is worth building.

**MLX quantization for exports:** `mlx_lm.convert -q --q-bits {8,6,4}`, `mlx_lm.dwq` (distilled,
higher quality 4-bit), `mlx_lm.dynamic_quant` (mixed bits), `mlx_lm.awq`, `mlx_lm.gptq`, and
`mlx_lm.perplexity` for a quality check — all present in our venv's entry points.

### 3.3 NVIDIA / AMD / Intel

- **Unsloth** is the fastest widely used trainer there, and its core is Apache-2.0.
  - NVIDIA: CUDA capability ≥ 7.0 on Windows 10/11 and Linux.
  - QLoRA/LoRA VRAM from the requirements table: 3B 3.5/8 GB, 7B 5/19 GB, 70B 41/164 GB.
- **AMD**: officially supported on Linux (MI300/MI350, Radeon RX 6000–9000, Strix Halo) and
  natively on Windows. **Windows ROCm has no GPU collective backend (GLOO/CPU only), so
  multi-GPU AMD needs Linux.** Their installer picks the ROCm torch wheel.
- **Intel** Arc/Xe via torch XPU is supported, with a known import failure on Arc B580
  (`torch.xpu.memory.mem_get_info`, issue #3533).
- **Installing torch the right way**: `uv pip install --torch-backend=auto torch` detects the
  CUDA driver, AMD GPU or Intel GPU (falling back to CPU). It exists only in the `uv pip`
  interface, not `uv run --with`, so the CUDA/ROCm training env must be a real venv
  (`uv venv` + `uv pip install`), like `engines-main.ts` does for vLLM.
- **Fallback**: TRL `SFTTrainer` + PEFT (Apache-2.0) when Unsloth cannot import. It is slower
  but runs anywhere torch does. Unsloth's `train_on_responses_only` handles multi-turn
  assistant masking for templates that lack `{% generation %}` markers, as Qwen's do.

### 3.4 What "training across devices" can realistically mean

1. **Train on another device**: this is the valuable one.
   - The dataset and config are prepared on the Mac; the job runs on a tailnet GPU box.
   - Progress streams back; the adapter (tens to hundreds of MB) or the finished GGUF
     comes back.
   - An RTX-class card should be several- to 10×+ faster than an M-series Pro chip
     (to be measured).
2. **Several Macs on one run, data-parallel.**
   - MLX's distributed layer has `ring` (TCP, always available; Thunderbolt-bridge capable),
     `jaccl` (RDMA over Thunderbolt 5, macOS 26.2+, full-mesh, **enable once from Recovery
     via `rdma_ctl enable`**), `mpi` and `nccl`.
   - `mlx.launch` needs passwordless SSH and identical Python paths.
   - **But** reading the installed `mlx/_distributed_utils/launch.py` shows the ring backend's
     whole contract is two environment variables, `MLX_RANK=<k>` and `MLX_HOSTFILE=<file with
     [["ip:port",…],…]>`. SSH is only how `mlx.launch` *starts* processes. If each peer's
     Bobble starts its own rank, **no SSH is needed**. That matters because **Tailscale SSH
     servers only run on Linux and the open-source `tailscaled` macOS variant — not the
     App Store/standalone Mac app, and not Windows.**
   - For LoRA, only adapter gradients are all-reduced each step: ~20–40 M params ≈ 40–160 MB
     depending on dtype. Over 1 GbE that is sub-second per step, which fits a multi-second
     4B step. Over Wi-Fi/WireGuard it is marginal.
3. **Slow links: DiLoCo-style local SGD.** Each device trains its own shard for H steps
   (100–500), then the adapters are averaged with an outer optimizer. That cuts
   communication by 1/H and tolerates Wi-Fi/tailnet links and uneven machines (shards sized
   by measured tok/s). EXO Labs runs DiLoCo on Mac clusters (arXiv 2311.08105).
4. **Not realistic**: one run split across a CUDA box and a Mac (no shared collective
   backend; different kernels and numerics). Out of scope.

### 3.5 Exports

- **llama.cpp b10603's converter supports Qwen3.5 and keeps its MTP head.**
  - `conversion/__init__.py` maps `Qwen3_5ForConditionalGeneration` to `qwen.Qwen3_5TextModel`
    (text) and to `qwen3vl` (mmproj).
  - `_QwenMtpMixin` remaps `mtp.*` to nextn layers and writes `nextn_predict_layers`.
  - Flags: `--mtp` (MTP-only GGUF), `--no-mtp` (exclude).
- **Requirements** (`requirements/requirements-convert_hf_to_gguf.txt` at that tag):
  `torch==2.11.0` (CPU index), `numpy~=1.26.4`, `sentencepiece`, `transformers==4.57.6`,
  `protobuf`, and the tag's own `gguf-py`. This pin differs from the engine venv
  (transformers 5.12.1), so exports need their own env. Unsloth pins the converter to its
  llama-quantize tag for the same reason ("can't drift past the pinned llama-quantize
  binary's gguf API").
- **The MLX export trap**, in the installed code:
  - `mlx_lm/models/qwen3_5.py:348-372` `sanitize()`: drops `mtp.*`, moves conv1d axes,
    and **adds `+1.0` to every RMSNorm weight**.
  - `:429-443`: drops the vision tower.
  - llama.cpp `conversion/qwen.py:394-395`: `if name.endswith("norm.weight") …: data_torch =
    data_torch + 1`.
  - Converting `mlx_lm.fuse` output therefore double-shifts every norm, and the GGUF also
    has no MTP and no vision.
  - The LoRA math is simple: `mlx_lm/tuner/lora.py:52` fuses `delta = (scale · lora_bᵀ) @ lora_aᵀ`,
    which is already in HF `[out, in]` layout. Adding it to the **original HF tensor** (names map
    `language_model.model.layers.N.*` ↔ `model.language_model.layers.N.*`) produces a merged
    checkpoint that the stock converter handles, with `mtp.*` and the vision tower untouched.
- **`llama-quantize` (shipped b10603)**: all K/IQ/TQ types plus `Q1_0`/`Q2_0`/`MXFP4_MOE`;
  `--imatrix`; `--tensor-type`/`--tensor-type-file` (per-tensor overrides → "dynamic"
  presets); `--token-embedding-type`/`--output-tensor-type`; **`--dry-run` (exact output
  size without quantizing)**.
- **imatrix**: every Unsloth Qwen3.5 GGUF repo checked (0.8B/4B/9B, MTP and plain) publishes
  `imatrix_unsloth.gguf_file`. This is what Studio auto-downloads for fine-tune exports.
  When there is none, the shipped `llama-imatrix` computes one from the training text.
- **GGUF LoRA adapters**:
  - `convert_lora_to_gguf.py` fails for Qwen3.5 in `_reorder_v_heads` (issue #21125, open
    since 2026-03-28). Fix PR #28324 is approved by one reviewer but unmerged as of
    2026-09-22; the earlier attempt, #24627, is also open.
  - Separately, llama-server **reuses cached prompt KV across requests with different
    per-request `lora`** — output is silently contaminated (issue #26207, open; workaround
    `cache_prompt:false`).
  - Per-request `lora: [{id, scale}]` on `/v1/chat/completions` otherwise works; requests
    with different LoRAs are not batched together.
- **mlx_lm.server** supports `--adapter-path` and a per-request `"adapters"` field (with a
  reload per switch), so on a Mac a fresh adapter can be chatted with **before any export**.
- **MTP after fine-tuning**: the head was trained on the base model's hidden states, so its
  acceptance rate can drop. FastMTP (arXiv 2509.18362) re-aligns heads with self-distilled
  data. Bobble already models "a head that doesn't pay" with `CatalogModel.specDisabled`, and
  can measure it with Calibrate.
- **Other destinations**:
  - Ollama: `FROM /path/model.gguf` Modelfile + `ollama create`; no re-quantization.
  - LM Studio: `lms import <gguf> [--symbolic-link|--copy] --user-repo <ns/name>`, or place it
    at `~/.lmstudio/models/<publisher>/<model>/`.
  - Hugging Face: `@huggingface/hub` (`createRepo`, `uploadFiles`) from Node. Needs a
    **write** token; the user's installed token is read-only (`pi-desktop-hf-token`).
- **Dataset preview without downloading**: the HF dataset viewer API
  (`datasets-server.huggingface.co`) has `/splits`, `/first-rows` (100 rows + feature types),
  `/rows` (≤100/page), `/size`, `/parquet` (per-split parquet URLs). Gated datasets need the
  token header.

### 3.6 Licenses (Bobble is GPL-3.0-or-later)

| Component | License | How we use it |
|---|---|---|
| mlx, mlx-lm, mlx-train-perf, mflux, llama.cpp (+convert scripts) | MIT | Installed/run as tools; convert scripts downloaded at the pinned tag |
| mlx-lm-lora | MIT (PyPI metadata) | Later |
| unsloth | Apache-2.0 | Separately installed runtime (not vendored) |
| unsloth_zoo | LGPL-3.0-or-later metadata, AGPL headers on many files incl. `mlx/` | Separately installed; GPLv3 §13 allows combination with AGPLv3 anyway |
| Unsloth **Studio** UI/backend | AGPL-3.0-only | **Do not copy code.** Re-implement the design (as was done for the hub) |
| Qwen3.5 weights | Apache-2.0 | Fine-tunes inherit it; the export writes the base license into the manifest/model card |

### 3.7 What this means for Bobble

1. **The trainer can't be "just run `mlx_lm.lora`."** The worker must wrap mlx-lm's loop
   with mlx-train-perf (chunked GDN, fused CE, flash-attention training, packing). It must
   refuse Qwen3.5 on the stock path past a small context, with a plain sentence.
2. **Export must never feed MLX-layout weights to the converter.** Merge into the HF
   originals; the MTP head survives for free.
3. **Training a 4B on this Mac means parking the chat model**: ~11.5 GB + 4.6 GB > 16.8 GB.
   9B needs an 8-bit base or another device. The fit verdict and "Pause chat model while
   training" are first-class UI.
4. **On-device runs take hours**, and the user's Mac hibernated at 1% battery today. Default to
   **AC-only**, paused on battery, `caffeinate` while running, and honest ETAs learned from
   past runs.
5. **Remote GPU training is the high-leverage cross-device feature**: it needs the Devices
   track's authenticated peer API. Multi-Mac data-parallel is possible without SSH, but it is
   a second step.
6. **Exports reuse what ships**: `llama-quantize`/`llama-imatrix`/`llama-perplexity` b10603,
   plus one small new download (the tag's convert scripts and gguf-py, extracted from the
   GitHub source tarball with `tar` — no git and no compiler, per the out-of-box rule in
   `pi-desktop-gen-modules`).

---

## 4. Design

### 4.1 Principles

- **One protocol, any machine.**
  - The worker speaks NDJSON on stdout and takes JSON commands on stdin.
  - The local manager and a remote peer run the *same* manager code.
  - The remote transport is HTTP streaming of the same events, as `gen-service/src/protocol.ts`
    intended for generation.
- **The guardian owns the machine.**
  - A run is admitted by estimated footprint (`guardian.admit`) and registered as a pausable
    of kind `'train'`.
  - It is paused on pressure; on "terminate", it **checkpoints then stops** before any
    SIGKILL.
  - Workers run at `taskpolicy -t 5 -l 5`, never `-b` (the 12× E-core trap in
    `pi-desktop-memory-guard`).
- **No developer tools, no git, no compiler.** Everything installs through the pinned `uv`
  and GitHub tarballs.
- **License-clean core**: MIT/Apache default path; AGPL/LGPL only as optional, separately
  installed runtimes.
- **Measured, not guessed**: fit and time estimates are seeded by a benchmark (TR-0) and
  refined from each finished run (tok/s is stored per hardware key, model and backend, like
  calibration records).
- **Everything visible on disk**: runs in `~/Bobble/Training`, datasets in `~/Bobble/Datasets`,
  exports on the library shelves. Manage Storage shows all three.

### 4.2 Architecture

```
Renderer (apps/desktop/src/training/*)             Main (apps/desktop/electron/training/*)
 TrainingView ─ Configure / Current run / History     training-main.ts  (job manager, IPC train:*)
   │  ExportSheet · DatasetPreviewDialog               ├─ run-store.ts   (~/Bobble/Training/<run>/run.json, metrics.jsonl)
   │  training-store (zustand, __training_store seam)  ├─ train-worker.ts (argv via packages/training, spawn uv+taskpolicy,
   └─ IPC train:* / datasets:* / llm:register-local    │                    NDJSON in, JSON commands out)
                                                        ├─ power-gate.ts  (AC-only, caffeinate, thermal)
packages/training (pure TS, vitest)                    ├─ guardian-main.admit()  +  pausables.guardRun({kind:'train'})
 protocol · config · capabilities · fit · metrics      ├─ export-main.ts (merge → convert → quantize → register)
 dataset-format · runs · export-plan                   ├─ datasets-main.ts (HF viewer API, parquet download, local import)
packages/training/python/bobble_train (uv env)         ├─ train-module.ts (Training/Export module install cards)
 worker.py → backends/{mlx,unsloth,peft}.py            └─ remote-train.ts (peer API client; Devices track)
 data.py (canonical rows → tokens + assistant masks)
 export/{merge_lora_hf.py, adapter_formats.py}      Supervisor (electron/inference/supervisor-entry.ts)
                                                     └─ register-local-model → ~/.pi/desktop/trained-models.json
```

### 4.3 Backends and the capability matrix

`packages/training/src/capabilities.ts`: `trainBackendsFor(accel: AcceleratorInfo)`
(from `accelerator.ts`) returns the backends this machine can run, and each backend's
matrix drives every "Not available on …" reason in the UI (Unsloth's pattern).

| Capability | `mlx` (Apple Silicon) | `unsloth` (CUDA · ROCm Linux/Win · XPU) | `peft` fallback |
|---|---|---|---|
| LoRA 16-bit / DoRA / rsLoRA (α/√r) | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ (+LoftQ) | ✓ / ✓ / ✓ |
| QLoRA (quantized base) | 8-bit / 4-bit MLX affine (4-bit warned for Qwen3.5) | bnb 4-bit (warned for Qwen3.5) | bnb 4-bit |
| Full fine-tune | ≤ 2B on 24 GB | ✓ (VRAM-gated) | ✓ |
| Continued pretraining / embed LR | ✗ v1 | ✓ | ✓ |
| Packing | ✓ except the qwen3_5 chunked path | ✓ | ✓ |
| Assistant-span masking (multi-turn + tools) | ✓ (worker's own masks) | ✓ `train_on_responses_only` | ✓ |
| Vision-language fine-tune | later (mlx-vlm) | ✓ | ✓ |
| 8-bit optimizers | ✗ | ✓ | ✓ |
| Multi-device | ring (same-arch Macs) / DiLoCo | single-node multi-GPU (Linux) | DDP |

### 4.4 On-disk layout

```
~/Bobble/Training/                      (setting training.root; .metadata_never_index; tmutil exclusion on checkpoints/)
  <run-id>/  run.json  config.yaml  metrics.jsonl  worker.log
             adapters/  (adapters.safetensors + adapter_config.json, the MLX format)
             checkpoints/step-000500/ …  samples.jsonl  exports.json
~/Bobble/Datasets/<name>/               train.jsonl  eval.jsonl  dataset.json (source, format, mapping, rows, token stats)
~/Bobble/Models/LLM/<export-id>/        <Name>-Q4_K_M.gguf  <Name>-Q8_0.gguf  mmproj-F16.gguf  bobble-model.json
~/Bobble/Models/LLM/MLX/<export-id>-8bit/
~/Bobble/Models/LLM/Adapters/<export-id>/   (new shelf in packages/model-store/src/library.ts)
~/.pi/desktop/trained-models.json       (catalog entries, like hf-models.json)
~/.cache/bobble/train/                  envs markers, llama.cpp convert sources at <tag>/, imatrix cache
```

### 4.5 The job runner

**State machine** (per run, mirrored in `run.json.status`):
`queued → downloading(model|dataset) → preparing → loading → training ⇄ paused(memory|battery|user) → saving → completed | stopped(resumable) | error | interrupted(resumable)`.

**Start.** `train:start(config)` does the following, in order:
1. Validates with `packages/training/config.ts`.
2. Plans downloads (base HF snapshot, dataset parquet) and checks space with the existing
   `storage:check-space` logic.
3. Computes the footprint with `fit.ts` and asks `guardian.admit(footprintGB)`.
   - If the resident chat model would not fit beside the run, it asks once, per the
     `training.parkChat` setting: *"Training needs the memory your chat model is using. Pause
     the chat model until training finishes?"*
4. Checks the power gate.
5. Only then spawns
   `taskpolicy -t 5 -l 5 <uv> run --no-project --python 3.12 --with <pins> python -m bobble_train.worker --job <run>/job.json`.

**Control.**
- Stdin commands: `{"cmd":"stop","save":true}`, `{"cmd":"checkpoint"}`, `{"cmd":"sample"}`.
- Pause/resume is process-level (SIGSTOP/SIGCONT through `pausables.ts`), so the guardian,
  the battery gate and the user's Pause button share one mechanism.
- The pausable's `cancel` sends `stop+save` and waits up to 60 s before the guard's SIGKILL
  path.

**Power.**
- `training.onlyOnAC` (default **true**): pause on battery (reading `pressure.ts` `onBattery`)
  and resume on AC. The banner offers *Continue on battery*.
- `training.keepAwake` (default true): `caffeinate -i -w <pid>`.
- Thermal "serious" pauses the run the same way (`pmset -g therm`).

**Crash recovery.**
- The worker writes a pidfile.
- At boot the manager reaps orphan workers (the same idea as `reap-orphans.ts`) and marks the
  run `interrupted`; it can resume from its last checkpoint.

**Visibility.**
- A top-bar chip ("Training · 42% · 1h 12m left") in the `TopBarStatus` fallback slot,
  clickable to the run.
- A completion notification through `notify-gate` (suppressed under `PI_E2E`).

**Test seams.**
- `PI_TRAIN_FAKE_WORKER=<ndjson>` replays a recorded stream on a clock.
- `__training_store` exposes renderer state to probes.

### 4.6 Protocol (`packages/training/src/protocol.ts`)

```ts
export type TrainBackendId = 'mlx' | 'unsloth' | 'peft';
export type TrainMethod = 'lora' | 'qlora' | 'full';
export interface TrainJob {
  v: 1; runId: string; backend: TrainBackendId; method: TrainMethod;
  base: { id: string; hfRepo?: string; localPath: string; quantBits?: 4 | 8 };
  data: { train: string; eval?: string; kind: 'messages' | 'prompt-completion' | 'text';
          assistantOnly: boolean; renderThinking: 'keep' | 'strip' };
  hyper: { epochs?: number; maxSteps?: number; contextLength: number; learningRate: number;
           scheduler: 'linear' | 'cosine' | 'constant'; warmupSteps: number; batchSize: number;
           gradAccum: number; weightDecay: number; seed: number; gradCheckpoint: boolean;
           packing: boolean; optimizer: 'adamw' | 'adam' | 'adafactor' | 'muon' | 'sgd' | 'adamw_8bit' };
  lora?: { rank: number; alpha: number; dropout: number; variant: 'lora' | 'rslora' | 'dora';
           targets: string[] };               // e.g. q_proj…down_proj (+ in_proj_qkv/in_proj_z/out_proj)
  every: { save: number; eval?: number; log: number; samples?: number };
  samplePrompts?: string[]; outDir: string; resumeFrom?: string;
  dist?: { mode: 'ring' | 'diloco'; rank: number; world: number; hostfile?: string; syncEvery?: number };
}
export type TrainEvent =
  | { t: 'phase'; phase: TrainPhase; detail?: string; fraction?: number; bytes?: [number, number] }
  | { t: 'prepared'; rows: number; evalRows: number; tokens: number; truncated: number;
      lengthHist: number[]; maskedFraction: number }
  | { t: 'step'; step: number; total: number; epoch: number; loss: number; lr: number;
      gradNorm?: number; tokPerSec: number; tokens: number; peakMemGB: number; elapsedS: number }
  | { t: 'eval'; step: number; loss: number }
  | { t: 'sample'; step: number; prompt: string; text: string }
  | { t: 'checkpoint'; step: number; path: string; bytes: number }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; line: string }
  | { t: 'done'; status: 'completed' | 'stopped'; step: number; adapterPath: string }
  | { t: 'error'; message: string; hint?: string; oom?: boolean };
```

### 4.7 IPC (new `electron/training/training-contract.ts`, spread into `ipc-contract.ts` `APP_INVOKE_CHANNELS`/`AppEventMap`)

- **invoke**:
  - Runs: `train:capabilities` (local backends, module state, known peers), `train:plan`
    (config → verdict, footprint breakdown, steps, ETA, downloads, disk), `train:start`,
    `train:stop {runId, save}`, `train:pause`, `train:resume`, `train:runs`,
    `train:run {runId}` (run.json + metrics, downsampled), `train:delete-run {runId, deleteFiles}`.
  - Module: `train:module-status`, `train:module-install`.
  - Export: `train:export-plan` (uses `llama-quantize --dry-run`), `train:export`,
    `train:export-cancel`.
  - Chat: `train:try-in-chat`, `train:compare {runId, prompt}`.
  - Datasets: `datasets:splits`, `datasets:preview`, `datasets:download`,
    `datasets:import-local`, `datasets:list-local`, `datasets:inspect` (format + mapping +
    token stats), `datasets:from-chats`.
  - Registration: `llm:register-local` (supervisor `register-local-model`).
- **events**: `train:event {runId, event}`, `train:runs-changed`, `train:export-progress`,
  `datasets:progress`, `train:module`.
- **settings** (`settings-contract.ts`): `capabilities.training: boolean`, plus
  `training: { root: string | null; onlyOnAC: boolean; keepAwake: boolean;
  parkChat: 'ask' | 'always' | 'never'; defaultDevice: string | null }`.
  - The HF **write** token goes in Keychain via Electron `safeStorage`, not in settings.json
    (today's `hfToken` stays read-only).

### 4.8 Datasets

**Sources**:
- Hugging Face (search via the existing `datasets:search`; subset/split from `/splits`;
  preview from `/first-rows`; download a split's **parquet** from `/parquet` through
  `downloadFile`, which is resumable and sha-checked — no `datasets` library needed to fetch).
- Local file (drop JSONL/JSON/CSV/Parquet/TXT).
- **From my chats** (pi session JSONL → `messages` + `tools`; filters: completed turns only,
  drop errored tool calls, dedupe, redact home paths). This feeds track 6's harness LoRA.
- Recipe (later).

**Canonical forms** (what the worker trains on):
- OpenAI `{"messages":[…], "tools":[…]}`
- `{"prompt","completion"}`
- `{"text"}`

**Auto-detection** (`dataset-format.ts`):
- ShareGPT `conversations[{from,value}]`
- Alpaca `instruction/input/output`
- `question/answer`
- `messages`, `prompt/completion`, `text`

Anything else opens the mapping dialog. The **preview dialog** puts role dropdowns in the
column headers (Unsloth's best idea here), plus a system-prompt field, a row slice, and an
eval split or "hold out N%".

**Masking**:
- "Train on assistant replies only" is on by default.
- The worker computes **per-span** masks for every assistant turn, including tool-call turns.
  mlx-lm's `ChatDataset` masks by a single offset, so only the *last* assistant message is
  trained, which is wrong for agent traces.
- Qwen3.5 thinking: the data should be rendered with the same `enable_thinking` Bobble
  serves with. The dialog warns when fewer than 75% of rows carry reasoning, per Unsloth's
  guidance.

**Stats** come from a worker `prepare` subcommand using the base tokenizer: rows, total
tokens, a length histogram, how many rows exceed the context (truncated or dropped), and the
masked fraction. They show in the dataset card and the run preview.

### 4.9 Fit and time estimator (`packages/training/src/fit.ts`)

`estimateTrainFootprint({ paramsText, layers:{full, gdn}, hidden, vocab, baseBits, method, lora:{rank, targets}, seq, batch, gradCheckpoint, lossImpl:'fused'|'dense', gdnImpl:'ops'|'chunked'|'fused' })`
returns `{weights, adapterAndOptimizer, activations, logits, gdnRecompute, overhead, total}` in
GiB, with a ×1.15 overhead factor. Terms:
- weights = params × {2, 1.06, 0.56} B
- adapter = r·Σ(d_in+d_out) × 16 B
- checkpoints = L·seq·H·2 B
- recompute ≈ seq·(34H)·2 B
- logits = dense ? 2.5·seq·V·4 B : 0
- gdnRecompute = ops ? ~7 MB/token : chunked ≈ 1 GB

**Verdicts** mirror the hub's copy style: *Fits · Fits if chat model pauses · Tight · Won't fit —
try 8-bit base / shorter context / another device*. The budget reuses `model-fit.ts`
(70%, 2 GiB floor) and `guardian`'s live free percentage.

**Time**: `tokensTotal / tokPerSec`, where tok/s comes from the TR-0 seed table and is then
replaced by the machine's own measured value from earlier runs (`~/.cache/bobble/train/speed.json`
keyed by hardware key + model + backend + seq). The live ETA switches to the running average
after 20 steps.

### 4.10 Export pipeline (`electron/training/export-main.ts` + `python/bobble_train/export/`)

```
source: run adapter (MLX)  ─┐
        or any HF safetensors model (no adapter — "export any model", the OmniSVG use case) ─┐
 1 ensure base HF bf16 snapshot (download if absent; reuse store/hub cache)                 │
 2 merge_lora_hf.py: W_hf += scale·(Bᵀ·Aᵀ) per targeted linear, name-mapped; everything else │
   byte-copied (mtp.*, visual.*, norms, conv1d untouched) → <tmp>/merged (safetensors)  ◄─────┘
 3 convert: python convert_hf_to_gguf.py <tmp>/merged --outtype bf16  (b10603 sources, export env)
 4 imatrix: download imatrix_unsloth.gguf_file for known bases, else llama-imatrix on train text
 5 llama-quantize [--imatrix] bf16.gguf <Name>-<Q>.gguf <Q>   (sizes shown first via --dry-run)
 6 mmproj: hardlink the base's mmproj GGUF (vision untouched), else convert --mmproj
 7 MLX (optional): mlx_lm.convert --hf-path <tmp>/merged -q --q-bits 8|6|4 (or mlx_lm.dwq)
 8 adapters (optional): MLX adapter copy; PEFT safetensors (renamed/transposed); GGUF-LoRA when
   #28324 lands (or vendored patch)
 9 register: llm:register-local → CatalogModel {source:'trained', mtpEmbedded, mmproj,
   chat template file, license from base, trainedFrom:{base, runId, method}}
10 checks (TR-13): llama-perplexity bf16 vs each quant on the eval split (Δppl table); Calibrate
   the new id with/without MTP → specDisabled if the head no longer pays
11 destinations: Library (default) · Folder… · Ollama (Modelfile + `ollama create` if present)
   · LM Studio (`lms import --symbolic-link`, else ~/.lmstudio/models/bobble/<name>/)
   · Hugging Face (@huggingface/hub createRepo + uploadFiles; model card from run.json)
```

- **Environments.**
  - The *Export module* is a uv env with the tag's convert requirements (torch 2.11 CPU,
    transformers 4.57.6, numpy 1.26.x, sentencepiece, protobuf, safetensors).
  - The *convert sources* are `https://github.com/ggml-org/llama.cpp/archive/refs/tags/<PINNED_LLAMACPP.tag>.tar.gz`,
    extracting only `convert_hf_to_gguf.py`, `convert_lora_to_gguf.py`, `conversion/`,
    `gguf-py/` and `requirements/` into `~/.cache/bobble/train/llama.cpp/<tag>/`.
  - When the pinned tag moves, both move together.
- **Quant picker.**
  - Chips: IQ4_XS · Q4_K_M · Q5_K_M · Q6_K · Q8_0 · BF16, with IQ2/IQ3 under "More".
  - Each chip shows the exact size from `--dry-run` and a fit dot against this machine. As in
    the hub, the sort *is* the recommendation (`pi-desktop-unsloth-desktop-reference`):
    Q8_0 preselected for ≤ 4B, Q4_K_M for larger models.
  - "Keep speed head (MTP)" is on when the base has one.
- **Disk.** The peak temporary size (merged bf16 + bf16 GGUF + quants) is checked up front.
  Temps live on the library volume and are deleted as each step finishes.

### 4.11 UI

**Where.** A **Training** row in the sidebar's *Workspace* section, after Scheduled
(`SessionSidebar.tsx` `workspaceNav`), with a new glyph (the user's pick; §6 Q9). It opens
`view === 'training'` through `contentOverride` (lazy chunk `lazyRoute('Training', …)`), with
`contentTitle` "Training". Hidden when `capabilities.training` is off (Settings →
Capabilities gets a fifth toggle).

Cross-links:
- Hub → Datasets rows gain **Download** and **Train on this**.
- Hub → On Device row menu gets **Fine-tune…**.
- A finished run shows **Use in chat**.

**Configure tab** (two columns ≥ 1100 px, one column below):

```
┌ Model ───────────────────────────────┐  ┌ Run preview ───────────── sticky ┐
│ Base  [Qwen3.5 4B ▾] (library / Hub)  │  │ Ready ●   Qwen3.5 4B · LoRA 16-bit │
│ Method [● LoRA 16-bit ▾]  bf16 · 9.3 GB│  │ 1,840 rows · 2.1M tokens · 3 ep   │
│   (QLoRA 8-bit · Full — reasons shown) │  │ 1,380 steps · batch 1×8 · ctx 4k  │
├ Dataset ─────── [HF | File | Chats] ─┤  │ Memory ▓▓▓▓▓▓▓░░ 11.6 / 15.3 GB    │
│ harness-traces-0923  ·  Messages+tools │  │  ↳ pauses your chat model          │
│ 1,840 rows · 52 truncated at 4k · View │  │ This Mac · ~5 h 10 m (est.)        │
├ Parameters ──────── [Simple|Advanced] ┤  │ Downloads first: base 9.3 GB       │
│ Epochs 3 · Context 4096 · LR 2e-4 · r 16│  │ Runs while plugged in              │
│ ☑ Train on assistant replies only      │  │ [ Start training ]                 │
├ Where to run ────────────────────────┤  └───────────────────────────────────┘
│ ● This Mac  M5 Pro 24 GB   fits · ~5 h │
│ ○ user-4090  Online · 100.x.y.z  ~22 m │  (Devices track; greyed when offline)
└──────────────────────────────────────┘   Save/Load YAML · Reset to defaults
```

**States** (each tested):
- Module not installed → `ModuleCard` "Training module · ~0.7 GB · Download".
- Base or dataset pending.
- Won't fit (red bar with the three fixes as buttons).
- No local backend (Intel Mac / CPU-only PC): "Training needs Apple Silicon or an NVIDIA,
  AMD or Intel GPU. Train on another device → Devices".
- Another heavy job running → "Starts when the image job finishes" (queue-explainer pattern).

**Current run tab**:
- Phase chip + **Pause** / **Stop ▾** (*Stop and save* · *Cancel*).
- Progress line: step x/y, epoch, %, elapsed, ETA, tok/s, tokens, peak memory.
- A 2×2 chart grid: **Loss** (raw thin + EMA bold + dashed average; eval points overlaid),
  **Eval loss**, **Learning rate**, **Grad norm**. Settings popover: window
  All/Last 500/Last 100, smoothing 0–0.99, linear/log, clip p99/p95.
  - Charts come from a small `LossChart` built on `packages/charts` `linePath` + niceStep
    ticks, with LTTB downsampling to ≤ 1,000 points. The generic `ChartView` is
    category-axis and replays its entrance animation.
- **Device strip**:
  - Mac: memory free % + pressure from the guardian, GPU utilization from IOAccelerator
    `PerformanceStatistics` via `ioreg` (no sudo), thermal state, power source.
  - NVIDIA: the `pressure.ts` nvidia-smi fields.
- **Samples** panel: fixed prompts generated at each checkpoint, so you can *see* the model
  change.
- A collapsible worker log.

Pause reasons render as the guardian banner already does, in the top bar's centre slot:
*"Paused to keep your Mac responsive — resumes on its own"* / *"Paused on battery — plug in
or continue on battery"*.

Completion: **Use in chat** · **Compare** · **Export**, and a milestone toast at 50%.

**History tab**:
- Cards: name, base, method dot, status, final loss + sparkline, steps, duration, device,
  date.
- Actions: Open · Resume · Export · Delete (dialog with "Also delete adapter and checkpoint
  files", shared-folder safe). Reads `~/Bobble/Training/*/run.json`.

**Export sheet**: the dialog anatomy from `pi-desktop-chat-follow-and-dialogs`.
- Source (final or step N) → targets (GGUF quants · MLX · merged 16-bit · adapter) →
  destination.
- A progress list per step, with the same bar/ETA idiom as downloads.
- A result card with Δppl per quant and MTP speed, plus **Use in chat**.

**Compare** (inside the run view, "Playground"):
- Two columns, base vs fine-tuned, same prompt, temperature 0.
- Mac: two `mlx_lm.server` lanes (base, base + `--adapter-path`) before export, or two
  llama.cpp instances after export.
- Never per-request LoRA while #26207 is open.

**Parity map** (Unsloth → Bobble WP): model picker → TR-5; methods → TR-2/TR-5; dataset
sources/preview/mapping → TR-8; params simple/advanced + YAML → TR-5; run preview → TR-5;
start overlay + live charts + GPU monitor + stop/save → TR-6; history + resume → TR-7;
export (GGUF quant list, imatrix auto-download, merged, LoRA, push to hub) → TR-10/TR-11;
compare in chat → TR-12; data recipes → TR-18; image LoRA → TR-17; S3/streaming → not
planned. Beyond parity: remote device, multi-Mac, dataset from chats, samples panel,
Δppl/MTP export checks, AC-only power policy.

### 4.12 Cross-device

**Remote run (TR-15)**:
- The "Where to run" card lists tailnet peers from `@pi-desktop/cluster` `readTailnet()`
  plus `probePeer()`.
- The Devices track extends `/cluster/hello` with
  `train: {backends, vramGB, freeGB, busy, versions}`.
- The coordinator uploads `job.json` and the dataset files, then streams
  `GET /train/jobs/:id/events` (NDJSON, resumable by event index). Stop/pause/resume go by
  POST.
- Artifacts come back with sha256 through `GET /train/jobs/:id/artifacts/:name`.
- Export runs where the user chooses: remote (fast, on the GPU box) or local (needs the base
  bf16 on this Mac).
- The UI says in one line: "Your dataset is sent to *user-4090* over your tailnet".
- Auth, pairing and the server itself belong to track 5; this track only consumes them.

**Multi-Mac (TR-16)**, two modes chosen automatically by link speed (the Devices ping plus a
throughput probe):
- **Ring (Thunderbolt bridge or ≥ 1 GbE)**: the coordinator allocates ports, writes the ring
  hostfile with peer IPs, and asks each peer to spawn rank *k* with
  `MLX_RANK`/`MLX_HOSTFILE`. Batch scales with world size. Only same-pins peers that fit the
  model are eligible. JACCL is shown as a manual advanced option (it needs the one-time
  Recovery `rdma_ctl enable`).
- **DiLoCo (Wi-Fi / tailnet)**: independent shards sized by measured tok/s, with adapter
  averaging every H steps through the peer API. This tolerates mixed Macs and slow links.

### 4.13 Alternatives considered

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Where Training lives | Workspace sidebar row + content route | 4th Model-management tab (the hub is for *getting* models; a run is a long workflow with its own tabs — Unsloth also separates Hub and Train); Modalities (those are media studios); a Settings panel (not a setting) |
| Mac trainer | Bobble worker on mlx-lm + mlx-train-perf | Stock `mlx_lm.lora` (Qwen3.5 GDN OOM, logits memory); Unsloth MLX as default (2+ GB torch-bearing env, daily releases, AGPL-headed modules, its GGUF path builds llama.cpp from source = Xcode CLT) — kept as an optional engine; mlx-lm-lora/mlx-tune as base (inherit the GDN path / less mature) |
| PC trainer | Unsloth in its own uv venv, TRL+PEFT fallback | Driving a remote Unsloth Studio's private REST API (auth + churn); hand-rolled torch loops |
| GGUF export | Merge into HF originals → pinned convert → shipped quantize | `mlx_lm.fuse`→convert (double norm shift, drops MTP/vision); Unsloth `save_pretrained_gguf` (compiles llama.cpp, unpinned); GGUF-LoRA + `llama-export-lora` (blocked by #21125 for Qwen3.5) |
| Compare | Two model instances | Per-request LoRA on one llama-server (#26207 cache contamination; GGUF-LoRA blocked) |
| Remote transport | Bobble↔Bobble peer API, same NDJSON | SSH/`mlx.launch` (Tailscale SSH server not on the Mac GUI app or Windows; key setup); Cloudflare tunnels (off-tailnet) |
| Dataset fetch | HF viewer `/parquet` + our downloader | `datasets.load_dataset` in Python (opaque progress, cache in `~/.cache/huggingface`, hard to cancel) |

---

## 5. Work packages

Sizes: S ≤ 1 agent-day, M 2–4, L 1–2 weeks, XL > 2 weeks. Every probe runs through
`apps/desktop/tests/e2e/harness.mjs` `launchApp()` (PI_E2E background, focus guard, throwaway
HOME). Real training or downloads run only on AC, with the guardian built in, and with the user's
OK for the download size.

| id | title | size | files (create / touch) | depends on | acceptance | headless verification |
|---|---|---|---|---|---|---|
| **TR-0** | Decision benchmark: stock mlx-lm vs mlx-train-perf vs unsloth_zoo on Qwen3.5 | S | create `packages/training/python/bobble_train/bench_step.py`, `apps/desktop/tests/train/train-bench.mjs` | — | Table for {0.8B, 4B} × seq {512, 1024, 2048} × {stock, perf, unsloth}: peak GB (`mx.get_peak_memory`) + tok/s + loss after 5 steps, or "OOM at step k". Seeds `fit.ts` constants and the default backend | Script only; no window; watchdog SIGKILLs at 25% free; refuses to run on battery; needs 1.75 GB + 9.3 GB downloads (the user's OK) |
| **TR-1** | `packages/training` pure core | M | create `packages/training/{package.json,tsconfig.json,src/{index,protocol,config,model-defaults,capabilities,fit,metrics,dataset-format,runs,export-plan}.ts}` + tests + `python/pins.json` | — | Config validate/defaults/YAML round-trip; capability matrix gives a reason string for every disabled option; fit table matches §3.2 within 10%; EMA/LTTB/ETA pure | `cd packages/training && ./node_modules/.bin/vitest run` (~80 tests; read the error count, not just the pass line) |
| **TR-2** | Python worker, MLX backend | L | create `packages/training/python/bobble_train/{worker,ndjson,control,data,samples}.py`, `backends/mlx_backend.py`, `python/tests/*` | TR-1 (TR-0 informs defaults) | NDJSON events per §4.6. Per-span assistant masks (golden test on the real Qwen3.5 chat template with tools + thinking). `stop+save` writes a loadable adapter; resume continues the step count; chunked-GDN + fused-CE path used for qwen3_5; stock path refused beyond 1k ctx with a hint | pytest on **tiny random models** (a 2-layer qwen3 and a 2-layer qwen3_5 built from config dicts, real Qwen3.5 `tokenizer.json`), CPU/Metal < 60 s: loss decreases on a toy set; mask goldens; stop/resume; records `fixtures/train-run.ndjson` for UI probes |
| **TR-3** | Training + Export modules (install cards) | M | create `apps/desktop/electron/training/train-module.ts` (+test), reuse `src/media/ModuleCard.tsx` | TR-2 | Ready markers at `~/.cache/bobble/train/modules/{mlx,export}.json`; Download continues a waiting start; uv lines stream to the card; no system Python/pip/git used | `train-module-look.mjs` (states via seam, screenshots); `train-module-fresh-probe.mjs` (throwaway uv cache, real install ~0.7 GB + ~0.5 GB, permission-gated) |
| **TR-4** | Job manager, IPC, safety | L | create `electron/training/{training-contract,training-main,train-worker,run-store,power-gate}.ts` (+tests); touch `electron/ipc-contract.ts`, `electron/main.ts` (`registerTrainingIpc` beside `registerStudioIpc`), `electron/gen/pausables.ts` (kind `'train'`), `electron/settings/settings-{contract,logic}.ts` (`training` block, `capabilities.training`) | TR-1, TR-2 | Refused start names the reason (footprint, disk, battery); pause/resume via SIGSTOP tree; terminate = stop+save then kill; battery pause/resume; `caffeinate` lives and dies with the worker; orphan reap + `interrupted` status on boot; run.json/metrics.jsonl written | vitest with injected spawn/clock/pressure (state machine, admission, power gate, crash recovery); `training-flow-probe.mjs` with `PI_TRAIN_FAKE_WORKER` asserting IPC → store transitions and a clean focus guard |
| **TR-5** | Training view: sidebar row, route, Configure tab | L | create `apps/desktop/src/training/{TrainingView,ConfigureTab,RunPreview}.tsx`, `cards/{ModelCard,DatasetCard,ParamsCard,DeviceCard}.tsx`, `state/training-store.ts` (+test); touch `App.tsx`, `chat/SessionSidebar.tsx`, `settings/panels/CapabilitiesPanel.tsx`, `packages/ui/src/components/glyph.tsx` | TR-1, TR-4 (`train:plan`) | All §4.11 states render; disabled options show reasons; Simple/Advanced; YAML save/load; the verdict bar matches `train:plan`; the sidebar row routes and exits studios (the `exitModality()` rule) | `training-configure-look.mjs`: screenshots light/dark × 900/1400 px, computed-style asserts, "won't fit" + "no backend" via seam; `content-route-fit-probe.mjs` extended so the route ends at the window edge |
| **TR-6** | Live run dashboard + top-bar chip | M | create `training/{RunView,DeviceMonitor,SamplesPanel}.tsx`, `training/charts/{LossChart,ChartSettings}.tsx`, `chat/TrainingTopChip.tsx`; touch `chat/TopBarStatus.tsx` | TR-4, TR-5 | Charts stay smooth at 10k steps (LTTB ≤ 1k points); EMA/log/clip controls work; pause/stop menu drives IPC; completion actions visible; chip opens the run | `training-run-look.mjs` replays `train-run.ndjson` at 20× → shots at 0/50/100%, paused, error; `tests/e2e/flicker.mjs` watch on chart updates; seam asserts the store equals the replayed events |
| **TR-7** | History grid + resume/delete | S | create `training/HistoryGrid.tsx` | TR-4 | Cards from seeded run dirs; Resume re-enters Current run from the checkpoint; Delete with/without files; shared-folder safety | `training-history-look.mjs` with a seeded `~/Bobble/Training` in the throwaway HOME |
| **TR-8** | Datasets: HF splits/preview/download, local import, mapping | L | extend `electron/inference/dataset-search-main.ts` → `electron/training/datasets-main.ts`; create `training/DatasetPreviewDialog.tsx`; touch `models/ModelsView.tsx` (Datasets row Download / Train on this), `packages/model-store/src/library.ts` (Datasets root) | TR-1 | ShareGPT/Alpaca/messages/prompt-completion/text auto-detected; column-role mapping persists in `dataset.json`; parquet split downloaded resumably with progress; local drop imports; token stats shown | vitest on format fixtures; `datasets-flow-probe.mjs` against a loopback HF + datasets-server stub via `HF_ENDPOINT` (the `_hf-mirror.mjs` pattern) — no network in probes |
| **TR-9** | Dataset from my chats | M | create `electron/training/chats-to-dataset.ts` (+test); a "Chats" source in `cards/DatasetCard.tsx` | TR-1, TR-8 | pi session JSONL → `messages`+`tools` rows with thinking kept; filters (completed, no errored calls, dedupe, path redaction) | vitest with fixture sessions (tool calls, thinking, aborted turns); look probe selects two seeded sessions |
| **TR-10** | Export pipeline + library registration | L | create `python/bobble_train/export/{merge_lora_hf,adapter_formats}.py`, `electron/training/{export-main,llama-convert-source}.ts` (+tests), `training/ExportSheet.tsx`; touch `electron/inference/{supervisor-entry,protocol,llm-main}.ts` (`register-local-model`, `llm:register-local`, `trained-models.json`), `ipc-contract.ts` (`LlmCatalogEntry.source: 'trained'`), `packages/model-store/src/library.ts` (`LLM/Adapters` shelf), `models/StorageView.tsx` | TR-2, TR-3, TR-4 | Merged weights equal mlx-lm's own fuse (≤1e-3) **in HF layout**; norms unshifted; `mtp.*` + `visual.*` byte-identical to base; bf16 GGUF has `nextn_predict_layers=1`; quants + `--dry-run` sizes; imatrix auto-fetch; export appears in the model picker and launches | pytest merge-math + **the +1-norm regression test**; tiny-Qwen3.5 end to end: merge → convert (real b10603 scripts) → quantize Q8_0 (shipped binary) → `llama-cli -n 4` loads it (CPU); gguf-py reader asserts nextn tensors; `export-flow-probe.mjs` (fake steps) + `export-look.mjs` |
| **TR-11** | Export destinations: Folder, Ollama, LM Studio, Hugging Face | M | touch `electron/training/export-main.ts`; create `electron/training/hf-push.ts` (`@huggingface/hub`), keychain helper (`safeStorage`) | TR-10 | Ollama Modelfile + `ollama create` only when the CLI exists; `lms import --symbolic-link` else the folder layout; HF push with a write token stored encrypted, model card from run.json, one format per push | vitest with mocked CLIs/fetch; probe against a loopback HF upload stub |
| **TR-12** | Use in chat + Compare playground | M | create `training/PlaygroundCompare.tsx`; touch `electron/training/training-main.ts` (lanes via `startExternalEngine`/mlx-lm `--adapter-path`) | TR-10 (post-export) / TR-2 (pre-export on Mac) | "Use in chat" selects the fine-tune in a new chat; Compare shows base vs tuned at temp 0; no per-request-LoRA path | probe with mock OpenAI servers on loopback (two lanes); real check gated in TR-13 |
| **TR-13** | Post-export quality + speed checks, real acceptance run | M | touch `export-main.ts` (Δppl via `llama-perplexity`), reuse `llm:calibrate` → `specDisabled`; create `tests/e2e/training-real-probe.mjs` | TR-10, TR-12 | Δppl table on the export card; MTP kept only if it measures faster. **Real acceptance**: Qwen3.5-0.8B, 60 steps, seq 512, a toy "secret word" dataset → the base doesn't say it, the Q8_0 export does (temp 0), in a Bobble chat | `REAL=1` probe, AC-only, guardian on, real cache/library envs (`REAL_CACHE`/`REAL_LIBRARY`), screenshots of run/export/chat; logs prefill/TTFT per `user-always-check-prefill` |
| **TR-14** | CUDA/ROCm/XPU backend | L | create `python/bobble_train/backends/{unsloth_backend,peft_backend}.py`; touch `train-module.ts` (venv + `uv pip install --torch-backend=auto`), `capabilities.ts` | TR-2, track 4 (Linux/Windows app) | Same NDJSON; `train_on_responses_only`; exports via the §4.10 pipeline with that platform's llama.cpp release; clear refusals (Arc B580, Windows AMD multi-GPU) | pytest tiny-model on a CUDA runner or the user's GPU box (cannot run on this Mac); golden NDJSON shared with TR-2 |
| **TR-15** | Remote training on a tailnet device | L | create `electron/training/remote-train.ts` (+test); touch `cards/DeviceCard.tsx`, `packages/cluster` (hello `train` block) | TR-4, **track 5 peer API + auth** | Pick a peer → job runs there; events stream and resume after a disconnect; stop/pause work; artifacts pulled with sha256; local/remote export choice; dataset-leaves-this-Mac notice | vitest with an in-process fake peer; e2e: two app instances on loopback (separate HOMEs/ports), one "remote", fake worker on it |
| **TR-16** | Multi-device data-parallel (ring + DiLoCo) | XL | create `python/bobble_train/dist.py`, `electron/training/dist-coordinator.ts` (+tests) | TR-15 | Ring: 2 ranks via `MLX_RANK`/`MLX_HOSTFILE` without SSH; loss matches a single process with a doubled batch (tolerance); DiLoCo: sync every H, shard sizing by tok/s; mode picked by link speed | Two ranks on one Mac over loopback (tiny model); DiLoCo averaging unit tests; real two-Mac run only with the user's second Mac |
| **TR-17** | Later: preference/RL + image LoRA + optional Unsloth-MLX engine | L | `backends/mlx_backend.py` (DPO/ORPO via mlx-lm-lora or unsloth_zoo), GRPO with harness rewards (track 6), `mflux-train` image LoRA (character sheets, track 8) | TR-2, TR-10 | Each mode behind the capability matrix | pytest tiny models; look probes |
| **TR-18** | Later: data recipes (synthetic data from documents) | M | `electron/training/recipes-main.ts`, templates (grounded QA, tool-use traces) using the running llama-server | TR-8, track 11 workflows | Generate N rows from a PDF with the local model into a dataset | probe with the mock pi/llama fixtures |

Suggested order: TR-0 ∥ TR-1 → TR-2 → TR-3 ∥ TR-4 → TR-5 → TR-6 ∥ TR-7 ∥ TR-8 → TR-10 → TR-11 ∥ TR-12 → TR-13 (**first shippable on-device slice**) → TR-9 → TR-14/15/16 (as tracks 4/5 land) → TR-17/18.

---

## 6. Risks, blockers, open questions

**Risks / blockers**
1. **Qwen3.5 training on MLX depends on young code.** mlx-train-perf 0.7/0.8 is weeks old;
   mlx-lm's own fix (PR #1870) is open; MLX core only has *forward* GDN kernels (PR #4020,
   merged 2026-09-15, unreleased; backward is TODO). Mitigations: TR-0 measures it, the
   pins are exact, and the Unsloth MLX engine is kept as a fallback.
2. **Upstream llama.cpp bugs**: #21125 (Qwen3.5 GGUF-LoRA conversion) and #26207 (LoRA ×
   prompt-cache contamination). v1 avoids both by design; revisit when #28324 merges
   (or vendor its patch into our pinned convert copy).
3. **Memory**: a 4B bf16 run (~11.5 GB) plus a resident 4B chat model exceeds the 16.8 GB
   budget on 24 GB. Training must park chat, and 9B needs an 8-bit base or a remote GPU.
   The guardian's pause→shed rule must not kill a run that sustains its own pressure (the
   2026-09-16 pause-deadlock lesson); training's terminate is checkpoint-first.
4. **Battery/heat**: multi-hour runs. AC-only by default after today's 1% hibernation.
5. **Disk**: a 4B export peaks at ~9.3 GB base + ~8.4 GB merged + ~8.4 GB bf16 GGUF + quants.
   The user's disk has run to 7 GB free before; check up front and delete temps per step.
6. **MTP acceptance** can drop after fine-tuning. Measure it and set `specDisabled`
   automatically; head re-alignment (FastMTP-style) is later work.
7. **Unverifiable here**: CUDA/ROCm/XPU paths and multi-Mac need hardware this Mac doesn't
   have (a tailnet GPU box or a CI runner).
8. **Cross-device depends on track 5** (peer server, pairing/auth); ring over Wi-Fi is slow.
   DiLoCo is the fallback.
9. **Dependency churn**: the convert scripts pin transformers 4.57.6 / torch 2.11 while the
   engines use transformers 5.12.1. Separate envs are mandatory; bump `PINNED_LLAMACPP` and
   the convert sources together.
10. **Licensing**: copying Unsloth Studio UI code would pull in AGPL. The design is
    re-implemented; Unsloth runtimes are installed separately, never vendored.
11. **Roadmap conflict**: ROADMAP-LATEST §6 said fine-tuning comes strictly after
    clustering. The on-device slice is independent; the cross-device slice is not.

**Questions for the user**
1. Should Training be its own sidebar row under Workspace (recommended), or a 4th tab of
   Model management?
2. Mac default trainer: the license-clean mlx-lm + mlx-train-perf (MIT) path, or Unsloth's
   MLX trainer (more complete, heavier, LGPL/AGPL-headed)? Or both, with Unsloth as an
   installable engine?
3. May training download the full bf16 base (Qwen3.5-4B = 9.3 GB) for best quality and an
   exact MTP-preserving export? Or should the default be the 8-bit MLX twin already on disk
   (no download, lossier export)?
4. Train only while plugged in by default, and keep the Mac awake during runs?
5. When memory is short, auto-pause the chat model for the run's duration, or make training
   wait?
6. Which GPU machines are on your tailnet (OS/GPU)? They are needed to build and verify
   TR-14/15.
7. Push to Hugging Face needs a *write* token (yours is read-only). Add a Keychain-stored
   write-token field?
8. v1 scope: SFT only (LoRA/QLoRA/full), or bring DPO/GRPO forward for the harness LoRA
   (track 6)?
9. Which glyph for Training (e.g. Hugeicons dumbbell / chart-line / ai-brain)?
10. Export destinations beyond the Bobble library: are Ollama, LM Studio and Hugging Face
    all wanted in v1?
11. Is a real acceptance run on the 0.8B OK (1.75 GB download, ~10 min on AC)?

---

## Sources

Local (read on this Mac):
- Unsloth Studio 2026.8.21 — `~/.unsloth/studio/unsloth_studio/lib/python3.13/site-packages/studio/frontend/src/features/{studio,training,export,dataset-picker,train-model-picker}`, `studio/backend/{routes/training_vram.py,core/export/export.py,assets/configs/model_defaults/default.yaml,lan_access.py}`, `unsloth_zoo/mlx/{trainer,utils,loader}.py`, `unsloth_zoo/gated_delta_vjp.py`
- mlx-lm 0.31.3 — `~/.cache/bobble/engines/mlx-venv/lib/python3.12/site-packages/mlx_lm/{models/qwen3_5.py,models/gated_delta.py,tuner/{lora,datasets,trainer}.py,server.py}`; `mlx/_distributed_utils/launch.py`
- llama.cpp b10603 — `~/.cache/bobble/llamacpp/b10603/llama-b10603/` (binaries, `llama-quantize --help`); `~/.cache/bobble/omnisvg/llama.cpp/{conversion/qwen.py,conversion/__init__.py,convert_hf_to_gguf.py,requirements/}`

Web:
- Unsloth Studio docs — https://unsloth.ai/docs/new/studio · changelog https://unsloth.ai/docs/new/changelog · releases https://github.com/unslothai/unsloth/releases
- Unsloth requirements — https://unsloth.ai/docs/get-started/fine-tuning-for-beginners/unsloth-requirements
- Unsloth Qwen3.5 fine-tuning — https://unsloth.ai/docs/models/qwen3.5/fine-tune
- Unsloth AMD — https://unsloth.ai/docs/get-started/install/amd · https://www.amd.com/en/developer/resources/technical-articles/2026/train-and-run-models-on-amd-gpus-with-unsloth.html
- Unsloth Intel — https://unsloth.ai/docs/get-started/install/intel · B580 issue https://github.com/unslothai/unsloth/issues/3533
- Unsloth Qwen3.5 MLX bug — https://github.com/unslothai/unsloth/issues/6002 · fused GDN backward https://github.com/unslothai/unsloth-zoo/pull/1142
- mlx-lm chunkwise GDN PR — https://github.com/ml-explore/mlx-lm/pull/1870 · MLX GDN kernels https://github.com/ml-explore/mlx/pull/4020 · qwen3_5.py https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/models/qwen3_5.py
- mlx-train-perf — https://github.com/IonDen/mlx-train-perf · changelog https://github.com/IonDen/mlx-train-perf/blob/main/CHANGELOG.md · Qwen3.5 PR https://github.com/IonDen/mlx-train-perf/pull/19 · PyPI https://pypi.org/project/mlx-train-perf/
- mlx-lm-lora — https://github.com/Goekdeniz-Guelmez/mlx-lm-lora · mlx-tune https://github.com/ARahim3/mlx-tune
- MLX distributed — https://ml-explore.github.io/mlx/build/html/usage/distributed.html · WWDC26 "Explore distributed inference and training with MLX" https://developer.apple.com/videos/play/wwdc2026/233/
- Tailscale SSH platforms — https://tailscale.com/kb/1193/tailscale-ssh
- DiLoCo — https://arxiv.org/abs/2311.08105 · EXO — https://blog.exolabs.net/day-5/
- llama.cpp server (LoRA endpoints, per-request `lora`) — https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- llama.cpp #26207 (LoRA × prompt cache) — https://github.com/ggml-org/llama.cpp/issues/26207 · #21125 (Qwen3.5 LoRA convert) https://github.com/ggml-org/llama.cpp/issues/21125 · fix PRs https://github.com/ggml-org/llama.cpp/pull/28324 , https://github.com/ggml-org/llama.cpp/pull/24627
- FastMTP — https://arxiv.org/abs/2509.18362
- HF dataset viewer API — https://huggingface.co/docs/dataset-viewer/quick_start
- uv + PyTorch backends — https://docs.astral.sh/uv/guides/integration/pytorch/
- Ollama import — https://docs.ollama.com/import · LM Studio `lms import` https://lmstudio.ai/docs/cli/local-models/import
- huggingface.js hub — https://huggingface.co/docs/huggingface.js/index · https://www.npmjs.com/package/@huggingface/hub
- mflux (DreamBooth LoRA) — https://github.com/filipstrand/mflux
- Qwen3.5 checkpoints — https://huggingface.co/Qwen/Qwen3.5-4B · Unsloth GGUFs with `imatrix_unsloth.gguf_file` https://huggingface.co/unsloth/Qwen3.5-4B-MTP-GGUF
