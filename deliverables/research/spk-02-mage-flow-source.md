# SPK-02 — Mage-Flow source, and sizing the Qwen-Image 2.1 edit port

Written 2026-09-23 by the spk-02 lane (branch `push/spk-02`). Track 8, Wave 1.

## Decision

**Microsoft withdrew Mage-Flow's weights. They are not gated and have not moved.** Every `microsoft/Mage-Flow-*`
repo (Base, the RL model, Turbo, and the three Edit variants) answers the HF API with `401 Invalid username or
password`. A repo that does not exist gets the same answer (`microsoft/this-repo-does-not-exist-zz9`). Gated repos
behave differently: `meta-llama/Meta-Llama-3-8B-Instruct` and `briaai/RMBG-2.0` return 200 with their metadata. Other
evidence:
- Microsoft's `mage` collection now lists only Mage-VL and Mage-ViT.
- Microsoft's own Mage-Flow Space is in `RUNTIME_ERROR`.
- The MIT code at `github.com/microsoft/Mage` is still public, and its README still links the dead repos.

**The weights are still published, byte for byte.** I checked them against the original trees that were saved beside
The user's copies (`~/Bobble/Models/Image/{Generation,Editing}/microsoft__mage-flow-*/trees/*.json`). The release has
four parts:

| Release path | Where it is now | Proof |
|---|---|---|
| `transformer/diffusion_pytorch_model.safetensors` | `Comfy-Org/Mage-Flow` → `diffusion_models/mage_flow_{turbo,edit_turbo}_bf16.safetensors` (MIT, ungated, ComfyUI's own org, 165k downloads) | same sha256 (`6df47d…`, `29c372…`) |
| `vae/diffusion_pytorch_model.safetensors` | `Comfy-Org/Mage-Flow` → `vae/mage_flow_vae_bf16.safetensors` | same sha256 (`34e076…`) |
| `text_encoder/` (every file) | `Qwen/Qwen3-VL-4B-Instruct` @ `ebb281ec` (Apache-2.0). CubePart already downloads this repo | same LFS sha256 and git blob ids, 12/12 files |
| `model_index.json`, `scheduler/`, `transformer/config.json`, `vae/config.json` (1.5 KB) | no live repo, so they ship in `src/mage-flow-release.ts` | same git blob ids (checked by a test) |

**Chosen source: Comfy-Org + Qwen, with the diffusers directory assembled on disk.** I rejected a community mirror
(option A). Nine full mirrors are byte-identical (`mage-flow-community/*`, `natalie5/*`, `arifqai/*`, …), but an
anonymous copy of a withdrawn model is the least durable thing to depend on, and assembling the pieces is also
smaller:
- Turbo and Edit-Turbo share 9.23 GB: the text encoder and the VAE.
- The editor is therefore an **8.2 GB** download next to the generator, instead of 17.5 GB.
- The text encoder costs nothing extra where CubePart is already installed.
- Installing both models takes 25.7 GB instead of 34.9 GB.

Other options I rejected:
- ComfyUI's int8 route runs on MPS, about 6× slower than MLX (memory `pi-desktop-comfy-mps-quants`).
- `xocialize/*-mlx` and `ddalcu/*-MLX-Serve` target other runtimes.
- Publishing an mflux 8-bit save needs a write token (Q6).

## What was broken on a fresh install, and the fix (`packages/gen3d-engine`)

1. **The weights returned 401.** `src/catalog.ts` now builds both Mage-Flow models from `mageFlowSource()` in the new
   `src/mage-flow-release.ts`:
   - `repos` are the Comfy-Org and Qwen pieces, **pinned by sha256**;
   - `layout` describes the diffusers directory;
   - `legacyRepos` lists `microsoft/*`.

   The sidecar (`python/engine/registry.py`) handles each part:
   - It judges completeness from the pinned blobs. A hub blob is named by its sha256, so no hashing is needed, and
     changed bytes are refused.
   - It builds `<cache>/assembled/<id>/` from symlinks and the release configs.
   - A complete old `microsoft/*` snapshot still counts as installed and is what the workers load, so **existing
     installs keep their 17 GB**.

   Changes in `downloads.py`:
   - Progress counts only this model's pinned blobs. Comfy-Org is shared, so counting the whole repo would show the
     edit download as done straight away.
   - A repo that is already whole is skipped.
   - Legacy weights skip the fetch entirely.
   - A failed fetch now reports what the hub said: the last stderr line, e.g. `RepositoryNotFoundError: 401`. Before,
     it reported only "exit 1".
2. **No mflux release has Mage-Flow.** PyPI's 0.18.0–0.20.0 have no `mflux-generate-mage-flow`. The port
   (mflux-community/mflux#483) was closed unmerged. The old `mflux==0.18.0` pin was the port's own version string, so it
   installed a build without the commands: a fresh Mac never had the 11 s path, and every edit failed with "editing an
   image needs the MLX image model".
   - Now a wheel built from the pinned commit ships in `prebuilt/darwin-arm64/`: 1.2 MB,
     `python/mflux-mageflow/build-wheel.sh`, manifest key `mflux`.
   - `envs.py` installs that wheel and repairs a venv that is missing the commands.
3. **The workers were handed repo ids.** Those ids resolve to the withdrawn repos inside mflux and inside
   `MageFlowPipeline`. `jobs.py` now passes the checkpoint **directory**:
   - `--model <dir> --base-model mage-flow-turbo` for generation;
   - `--edit-model <dir> --edit-base-model mage-flow-edit-turbo` for edits;
   - `--model <dir>` on the PyTorch fallback.
4. **The sidecar checked the wrong model for edits.** It checked the *generator* before an edit. An install with only
   the editor refused every edit, and one with only the generator let the edit through to fail in the worker. Edits
   now require `mageflow-edit`.

5. **One side effect in Manage Storage, fixed.** The storage card named the *first* 3D model whose repo list contains
   a folder. Qwen3-VL-4B is now listed by three models, so a CubePart-only user would have been told their encoder is
   "Mage-Flow Turbo".
   - `repoAttribution()` (catalog.ts) names the one model that uses a repo, or for a shared repo says "Shared by
     Mage-Flow Turbo, Mage-Flow Edit and CubePart."
   - The legacy `microsoft/*` copies still read "Mage-Flow Edit" / "Mage-Flow Turbo".
   - `storage-main.ts` uses it (3 lines). `StorageView.tsx` dedupes chips by their label: Comfy-Org/Mage-Flow showed
     "text → image" twice, once from the engine and once from the hub catalog.

6. **Existing copies the engine could no longer see (the user's Mac), fixed.** The legacy honour in (1) works only
   through the hub path, and on the user's Mac that path is gone. `~/.cache/bobble/gen3d` was recreated empty on
   2026-09-20, so every `gen3d/hf/hub/models--*` link the library migration had left behind went with it. The shelves
   still hold every byte, including the 35 GB of `microsoft/Mage-Flow-*` that nobody can download again. Result: every
   3D model read "not downloaded", and Download would fetch 26 GB of Mage-Flow that was already on disk.
   - New `apps/desktop/electron/storage/hub-relink.ts` is the migration's inverse. At every boot it runs from
     `runLibraryMigration` (2 lines in `storage-main.ts`). For each repo the 3D catalog names (its sources and its
     `legacyRepos`), it puts the link back when two things hold:
     - the hub cache has no entry of that name at all (a folder, a link or a dangling link is left exactly as it is);
     - a shelf holds that repo's folder in the hub layout (`snapshots/` inside), so the model store's plain folders
       are never linked.
   - The link is relative, the same spelling the migration writes. Nothing is moved, copied, overwritten or deleted.
     A repo being downloaded is skipped. A failure is logged, never thrown, so it cannot cost the boot its migration.
   - On the user's Mac today, a plan-only dry run of the real code against the real folders lists **14 links** to put
     back: both `microsoft/Mage-Flow-*` copies, Qwen3-VL-4B, CubePart, TRELLIS-image-large, SkinTokens, ARDY, the
     two LLM2Vec adapters, dinov3, BiRefNet, parakeet, FluidIntelligence and Qwen3-TTS.
   - The Download button is still needed on that Mac: the engine's venvs went with the cache. But it installs the
     runtime only. With a complete legacy copy, the download skips every weight.

The 3D studio's download cards do not change. The label, note and "17.5 GB" are pinned by a test, and before and
after screenshots of both Mage-Flow cards are pixel-identical in both themes.

**What this means for the chat's `edit_image` on a fresh install.** Before this fix it could not work: the weights
returned 401, and even with the weights on disk there was no Mage-Flow mflux build to run them. Now "Download" fetches
17.46 GB, or 8.23 GB when the generator is already installed. The runtime is the shipped wheel. The job loads the
assembled directory.

## Verification (no weights downloaded)

- **vitest (gen3d-engine): 37/37.**
  - Includes 10 new tests (8 in `mage-flow-release.test.ts`, 2 in `catalog.test.ts`), covering: configs by git blob
    id, pins equal to the release sha256s, the layout covering what both engines open, sharing with CubePart, the card
    unchanged, a fixture lock with Python, and `repoAttribution`.
  - Against the old catalog: 7 failed. The card test was added later and passes on both catalogs by design.
- **Python engine suite: 112/112 (3 skipped)**, re-run on 2026-09-23 at 23:13 with Python 3.12,
  `huggingface_hub==0.34.4`, numpy, trimesh, pillow, scipy and scikit-image. An earlier run in the sidecar's Python
  gave 104/104 with 11 skipped.
  - Includes 20 new tests in `test_mage_flow_source.py` and 3 new provisioning tests.
  - Against the old engine: 18 fail, the worker test exits 2 because argparse rejects `--base-model`, and the 4
    provisioning tests fail (the old code installed `mflux==0.18.0`).
- **apps/desktop: tsc clean on both configs.** vitest (re-run 23:24): 2777 passed, 8 skipped, 0 failed. That includes
  2 chip tests and 10 relink tests.
- **`python/tools/check_sources.py`: anonymous check against the live hub.**
  - Old catalog: **FAIL**, 401 on both repos.
  - New catalog: **OK**. All 4 pinned files match size and sha256, and 10 small text-encoder files (11.6 MB) were
    fetched into a fresh `HF_HOME` through the sidecar's own `snapshot_download`. All 10 are byte-identical to the
    release's `text_encoder/`.
- **`hf download … --dry-run` (hf 1.32, fresh `HF_HOME`, no token).**
  - Comfy edit set: 2 files, 8.6 G.
  - Turbo transformer: 8.2 G.
  - Qwen text encoder: 12 files, 8.9 G.
  - `microsoft/Mage-Flow-Edit-Turbo`: `DryRunError`, repository cannot be accessed.
  - `HF_HOME` stayed at 16 KB.
- **The assembled directory, loaded by the real code.** Setup: a scratch cache with the real small files plus sparse
  placeholders named by the pinned sha256s.
  - The real sidecar `Registry` assembles both directories.
  - The shipped mflux wheel (installed `--offline` from the uv cache) resolves each directory locally.
  - With `HF_HUB_OFFLINE=1` it loads the Qwen3-VL tokenizer and `MageFlowQwen3VLProcessor` through the symlinks.
  - The real `server.py` boots on the new registry and answers `/catalog` and the edit gate.
- **The assembled directory with the real weights, headers only.** The sidecar assembled Comfy-Org and Qwen snapshots
  that point at the user's shelved `microsoft/*` blobs (same sha256), and every pin passed. After mflux's own key mapping,
  the tensor counts match the port's expected counts exactly: transformer 397, text encoder 713, VAE 728 (the VAE file
  holds 839 keys, and the mapping drops 111). No tensor was loaded.

- **Screens, before (main `e376f35a`) and after, in dark and light.** Two hidden `launchApp` probes, looked at and
  pixel-diffed:
  - `gen3d-download-card-look.mjs`: both Mage-Flow cards have **0 differing pixels** in both themes. The whole panel
    has 0 in light and 3 stray pixels in dark, inside the 3D viewport.
  - `storage-shared-repo-look.mjs`: the Qwen3-VL-4B card changes from "CubePart" to "Shared by …", and Comfy-Org shows
    one chip. The single-use and legacy cards are identical.
  - Run against main, the storage probe fails ("the Qwen card is titled CubePart") and the card probe passes.
- **The relink (item 6), re-checked on 2026-09-23 at 23:15–23:25.**
  - Unit tests: `hub-relink.test.ts`, 10 tests on a real temp filesystem.
  - `hub-relink-probe.mjs` (hidden app, scratch support root and library, `PI_DESKTOP_MIGRATE_LIBRARY=1`):
    - on this branch: **OK**, both links relative and resolving to the shelf, the model store's folder not linked;
    - on main's build: **FAIL**, "no hub link for microsoft/Mage-Flow-Turbo" and none for Qwen.
  - Real weights, read only. The real relink wrote links into a scratch cache pointing at the user's real shelves, and
    then the real sidecar `Registry` read them:
    - before the relink: `weights_present` was False for both models and `model_dir` was None;
    - after: both True, `model_dir` is the legacy snapshot, and the transformer, VAE and text encoder resolve to
      the blobs named by the pinned sha256s;
    - nothing was assembled and nothing was written outside the scratch folder.
- **The acceptance checks, re-run on 2026-09-23 at 23:19 (no token, fresh `HF_HOME`):**
  - `check_sources.py` is OK: 4 of 4 pins match and 10 small files (11.6 MB) were fetched;
  - `microsoft/*` still answers 401;
  - the `hf --dry-run` numbers are unchanged, and `HF_HOME` stayed at 12–16 KB.

**Not verified here (BENCH: needs the GPU).** A real generation and a real edit through the assembled directory, with
both results looked at. `python/tools/bench_mageflow_assembled.sh` does it with **zero downloads**: it builds the
Comfy-Org and Qwen snapshots from the shelved `microsoft/*` blobs, installs the shipped wheel, and runs the real
worker. `DRY_RUN=1` has been run up to the model call. A true fresh-install download (26 GB) is a separate, optional
BENCH run.

## PORT-01 — Qwen-Image 2.1 editing in our mflux wheel: sizing

**Reference behaviour.** Sources: diffusers `QwenImage21Pipeline` (#14804, merged 2026-09-18) and ComfyUI 0.37
`TextEncodeQwenImage21`.
- Editing is the same pipeline called with `image=[…]`: 1 to 16 condition images, no mask argument.
- A mask or painted annotation is simply another condition image, described in the prompt.
- Each reference is resized to about the target area in multiples of 32 and is used twice:
  - Qwen3-VL-8B sees it as vision tokens, from `<imageN><|vision_start|><|image_pad|><|vision_end|>` in the template.
  - The VAE encodes it into latents.
- In the single-stream, block-causal DiT (32 layers, width 4096), each `image_pad` slot is expanded 4× and **replaced
  by that reference's latents**. The target comes last.
- Text and reference tokens are modulated at t = 0, so their K/V do not change from step to step. Both references
  cache them (the diffusers `QwenImage21KVCache`, the ComfyUI prefix cache): step 1 prefills, and later steps compute
  only the target rows.

**What mflux 0.20 / our te8 wheel has today.**
- The qwen21 port does text-to-image and img2img only.
- It has a text-only Qwen3-VL-8B encoder.
- The VAE encoder exists (img2img uses it).
- A Qwen3-VL vision tower with deepstack is already in-tree (`common_models/qwen3_vl`, used by FIBO-VLM).
- The app's converted model (`qwen-image-2.1-mflux-4bit-te8`) has **no vision weights**: 905 keys, 0 visual. All 351
  vision tensors are in the release's `text_encoder/model-00001-of-00004.safetensors` (5.0 GB). About 1.2 GB of it is
  vision, which HTTP range reads of the safetensors header could pull on their own.

**Work items and estimate (one agent).** Total ≈ **9–13 agent-days + one BENCH session**, consistent with the XL in
studios-editors.md.

| Item | Estimate |
|---|---|
| Encoder: vision tower (reuse, 27 layers, width 1152, deepstack [8, 16, 24]), mrope ids for vision tokens, image-slot bookkeeping | 3–4 d |
| DiT: `build_sequence` with slots and centred RoPE ids; per-segment block-causal attention | 2 d |
| Prefix KV cache | 1–2 d |
| Pipeline and CLI (`mflux-generate-qwen-2.1-edit --image-paths …`) | 1 d |
| te8 rebase; re-save with the vision tower | 0.5 d |
| Parity tests on tiny random configs | 1–2 d |
| BENCH: text benchmark, three edits looked at, footprint | ~2–4 h |

The gen-service/worker/catalog wiring belongs to IMG-04.

**Estimated cost on 24 GB (not measured).**
- For comparison, text-to-image today peaks at 5.96 GB in MLX, frees about 7.4 GB of the OS, and takes 97 s.
- An edit at 1024² with one reference roughly doubles the sequence (4096 + 4096 + text). The prefix cache adds
  about 2.2 GB in bf16.
- Expected MLX peak: about 9–11 GB.
- Expected time: about 2–2.5 min at 24 steps with the cache, about 4 min without it.
- It is still non-commercial (Qwen licence "other"), so PORT-01 stays gated on **Q3**. Mage-Flow-Edit (MIT, about
  9 s) remains the default editor.

**Side finding for the Qwen-Image 2.1 owner (not in this package).** Both references use the last decoder layer
**before** the text encoder's final RMSNorm. diffusers explains that the normed output loses "a third of the signal
the transformer reads, which shows up first in rendered text". mflux 0.20.0 upstream and our bundled
`mflux-0.19.2+bobble.qwen21.te8` wheel both return `self.norm(hidden_states)`, which is the normed output.
- This may be part of the letter flips the te8 README blames on quantizing the encoder ("BOBBBLE").
- It is unmeasured, so it is filed as a BENCH A/B: the same text benchmark with the final norm bypassed.

## Open points

- The relink (item 6) covers hub repos only. The migration's other linked folder, `gen3d/models/*`, is not
  relinked. On the user's Mac that is ARDY's baked MLX text encoder, `3D/Generation/ardy-text-encoder-mlx-8bit`, so ARDY
  would bake it again on its first prompt. That bake needs the gated Llama-3-8B base, which is not on the shelves.
  This belongs to ARDY, not Mage-Flow; it was noticed here and not changed.
- The shipped mflux wheel records its files with mode `0o230` (729 of 919 entries). `uv build` (uv_build) produced
  that: a rebuild from the pinned commit is byte-identical. pip and uv use only the executable bits of those modes,
  so installed files come out `0755` and import normally. Checked: an install into a scratch venv reads and imports.
- The download cards still quote each model's full size: 17.5 GB for the editor, and "Download all · 92.9 GB". Shared
  repos are now counted once per model, so these are upper bounds.
  - Beside the generator, the editor actually fetches 8.2 GB.
  - "Download all" actually fetches about 18 GB less.
  - A sidecar `downloadBytes` (bytes still missing) would make the cards exact. This is a follow-up with a small UI
    change.
- `Comfy-Org/Mage-Flow` is also a Model-hub catalog repo (`recommended-catalog.ts`). If the model store and the gen3d
  shelving both claim `Image/Generation/comfy-org__mage-flow`, the migration skips it with "target exists". Nothing
  breaks, but the storage lane should know.
