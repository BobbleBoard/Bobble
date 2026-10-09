# Studios as professional-but-simple editors (track 8)

Research doc · 2026-09-23 · base commit `c9fe7098` (branch `main`) · research only: nothing in
the repo was changed to write this.

Reading guide: §1 is the ask, §2 is what the code does today (with the defects found while
reading it), §3 is the outside world (models, runtimes, reference products, licenses), §4 is the
recommended design, §5 is the ordered work, §6 is what could stop it and what the user has to decide.

---

## 1. Goal

**The user, verbatim:** "image video and audio studios shouldn't actually be a chat interface, users
wanting that experience can have it via just asking model to call media tools in a regular chat,
studios are like professional but very simple editors with the specialized model integrations eg.
image studio image generation w/ inpainting, editing, click to comment, remove bg, make a character
sheet, ui, mockups, those presets and more..."

His click-to-comment reference: **a numbered pin placed on the picture, and a floating pill beside
it reading "Describe changes" with a check button and an X.**

Restated as requirements:

| # | Requirement |
|---|---|
| R1 | The Image, Video and Audio studios stop being chat-shaped (no transcript of prompt bubbles, no docked chat composer as the main control). Each becomes an **editor**: one document on a canvas or timeline, with tools, layers or lanes, history and export. |
| R2 | "Chat-style" media stays exactly where it is: a regular chat can still generate or edit media through the existing tools (`generate_image`, `edit_image`, `generate_video`, `generate_audio`, `generate_3d`). The two routes connect: a chat card opens in an editor, and an editor sends results back to chat. |
| R3 | "Professional but very simple": few, obvious tools; every model integration is one gesture; no node graphs, sampler menus or forty knobs on the surface. |
| R4 | Image editor: generation, inpainting/outpainting, instruction editing, **click-to-comment** (numbered pin + "Describe changes" pill with ✓ and ✕), remove background, erase, resize/expand, upscale, markup, and **presets**: character sheet, UI screens, mockups and more. |
| R5 | Audio editor: TTS voices, voice cloning, music, sound effects, cleanup, stems, trimming. The same comment grammar on the timeline. |
| R6 | Video editor: trim/arrange/captions locally; image-to-video, extend, add sound, upscale as model integrations. The same comment grammar on a frame. |
| R7 | Each edit maps to a named model call that runs **locally** — on a 24 GB Apple Silicon Mac first (the user's M5 Pro), with a portable baseline for CUDA/ROCm/CPU (track 4). |
| R8 | The app's existing rules still hold: the guardian and memory guard admit and pause heavy work; modules download on first use; readable paths under `~/Bobble`; headless, focus-safe tests; every visual change is verified by looking at screenshots. |

Out of scope: the 3D studio (already an editor, `apps/desktop/src/tripo/`, reused as the pattern
here), and the chat media tools themselves (kept; §4.10 covers how they meet the editors).

---

## 2. What exists today

### 2.1 Routing and the shared shell

| File | What it does |
|---|---|
| `apps/desktop/src/state/modality-store.ts` | `Modality = 'chat' \| '3d' \| 'image' \| 'video' \| 'audio'`; `exitModality()`. UI-only, not persisted. |
| `apps/desktop/src/App.tsx` (≈l.363–386) | Studios are a **content route**: `contentOverride` renders `<ImageStudio/>`, `<VideoStudio/>`, `<AudioStudio/>` (lazy via `lazyRoute`) or `<TripoWorkspace/>` in place of the chat thread. The sidebar and top bar stay. |
| `apps/desktop/src/chat/ChatApp.tsx` | `STUDIO_TITLES` puts the studio's name in the top bar. `StudioTopBarControls` gives the three rooms the gears (advanced dialog) and a right-rail toggle; the 3D route gets `TripoTopBarControls` (Send To and Export) instead. |
| `apps/desktop/src/studio/StudioShell.tsx` (833 lines) | The shared frame. Its header comment says it outright: **"THE SHAPE IS THE CHAT'S SHAPE, ON PURPOSE"**. A scrolling results column, a docked composer (prompt plus run button), `controls` shown as dropups under the composer (`StudioPicker`), a right settings rail (`RailGroup`, `RailToggle`, `Segmented`), a gears `Dialog`, a drop veil and `StudioEmpty` with starter cards. Escape leaves the studio. |
| `apps/desktop/src/studio/StudioRun.tsx` | `RunHeader` draws each run's prompt as a chat `MessageRow` bubble with Copy and Edit; `StudioJob` mounts `PendingMediaCard` early and reveals the result with the cascade sweep. |
| `apps/desktop/src/studio/use-studio.ts` | One run = `gen:generate`; progress comes from `gen:open`/`gen:update`; results go to `useStudioRuns` (`apps/desktop/src/state/studio-runs.ts`), a module-level store that is **in memory only** (lost on relaunch). |
| `apps/desktop/src/studio/use-handoff.tsx` + `apps/desktop/src/state/studio-handoff.ts` | Media handed to a room (a transcript card's "Open in studio", a drop, `pathForFile`) arrives as a "Working from …" card; `ACCEPTS` lists the extensions each room takes. |
| `apps/desktop/src/studio/use-enhancer.ts` + `electron/gen/prompt-{guidelines,enhancer}.ts` | `gen:enhance`: a tiny local model rewrites the prompt in each model's dialect (never for speech). |

### 2.2 The three rooms

- **ImageStudio.tsx (755 lines):** prompt → `gen:generate {kind:'image'}`; Shape × Size (a
  machine-aware default: 512²/768²/1024² by RAM), Style (prompt suffixes), Count 1/2/4, Model,
  Enhance. **"Edit" is plain img2img**: with an input picture it sends `inputImage` + `strength`,
  which `worker.py build_mflux_cmd` turns into `--image-path/--image-strength` (inverted there on
  purpose). No mask, no region, no instruction-edit model, no background removal, no upscale, no
  layers. The starters are "Describe a picture / Stylize / Four to compare", or with an input
  "Change something / Restyle / Just polish".
- **VideoStudio.tsx (478 lines):** text-to-video only (Shape, Size, Length 2/4/8 s at 24 fps,
  Model, Enhance). **Defect:** it shows the "Working from <clip>" card for a dropped or handed-in
  file, but `onRun` never passes the input (no `handoff.input` reference) — the input is ignored.
  There is no image-to-video, no trimming, no timeline.
- **AudioStudio.tsx (695 lines):** Speech (voice list, pace, clone from `refAudio`), Music and
  Effects modes, lengths, takes. **Same defect:** a dropped audio file shows "Working from" but is
  never used (the clone clip comes only from the rail's own picker). No waveform editing, no
  transcript, no cleanup, no stems.

### 2.3 Shared media pieces (reusable as-is)

`apps/desktop/src/media/`: `MediaCard.tsx` (one card for chat and studios: Open in studio / Use as
input, Copy, Export, Expand), `ExpandedScrim.tsx` (the large centred viewer, `role="dialog"`),
`PendingMediaCard.tsx` (the reveal), `ModuleCard.tsx` (module download card), `VideoSurface.tsx`,
`ModelSurface.tsx`, `media-actions.ts` (`canvas:save-as`, `canvas:copy-file`, `canvas:reveal`,
`canvas:start-drag`), `send-to-chat.ts` (the return trip to chat). `apps/desktop/src/chat/
ThreadAudio.tsx` + `chat/audio-peaks.ts` (`peaksOf`, a waveform decoded from real samples) —
the audio editor's lanes can use this directly.

### 2.4 The generation path in main

- `apps/desktop/electron/gen/gen-ipc-contract.ts` → `gen:generate` request: image `size, n,
  negativePrompt, steps, seed, guidance, inputImage, strength`; video `seconds, fps`; audio
  `audioKind, voice, speed, lang, refAudio, refText`. There are **no fields for a mask, a region,
  several reference images, upscale or matting.**
- `apps/desktop/electron/gen/gen-manager.ts` `handleGenerate` builds an mflux `ImageJobSpec` or a
  ComfyUI job (`image-dispatch.ts`); an input image on the ComfyUI path is refused ("editing a
  picture needs an mflux edit model (see edit_image)"). Around it: `JobQueue` (serial heavy jobs),
  guardian admission (`guardian-main.ts`, `packages/inference/src/guardian.ts`), the pause →
  resume → terminate memory guard (`pausables.ts`), `make-room.ts` (parks the chat model), and
  modules (`gen-modules.ts`: `image | audio | comfy | 3d` plus `weights:<id>`).
- `packages/gen-service/src/protocol.ts` `ImageJobSpec`: one `imagePath` + `imageStrength` — a
  single input image, nothing else.
- `packages/gen-service/python/worker.py`: `run_image` drives an mflux console script, and a
  persistent `serve_loop` exists (for TRELLIS) that the new tools worker can copy.
- `packages/gen-service/src/worker-command.ts`: `MFLUX_PIN = '0.18.0'`, `MLX_AUDIO_PIN = '0.4.5'`,
  `DEFAULT_PYTHON_VERSION = '3.12'`. Qwen-Image 2.1 runs on the bundled
  `python/wheels/mflux-0.19.2+bobble.qwen21.te8-py3-none-any.whl`.
- Legacy: `apps/desktop/electron/studio/studio-main.ts` registers a "primitive" `studio:*` IPC
  (status/generate/cancel on ComfyUI) whose only caller is `tests/e2e/studio-probe.mjs`. It is a
  cleanup candidate and should not be confused with the new editor IPC.

### 2.5 Capabilities already on disk that the studios never call (local findings)

1. **The bundled mflux wheel already carries the editing commands.** Its `entry_points.txt` (read
   from the wheel) lists `mflux-generate-flux2-edit` (FLUX.2 klein edit, `--image-paths` with one or
   more references), `mflux-generate-qwen-edit` (Qwen-Image-Edit 2509/2511 aliases),
   `mflux-generate-fill` (FLUX.1 Fill: `--image-path` + `--masked-image-path`),
   `mflux-generate-kontext`, `mflux-generate-fibo-edit` (with `--mask-path`, plus a
   `fibo-edit-rmbg` background-removal variant), `mflux-upscale-seedvr2` (`--resolution 2x|<px>`,
   `--softness`), `mflux-generate-z-image-controlnet` (canny/depth/pose/hed/mlsd),
   `mflux-save-depth` (Depth Pro) and `mflux-generate-in-context-catvton` (try-on). None of these
   is wired. mflux **0.20.0** (PyPI, 2026-09-21) has the identical command set and makes Qwen-Image
   2.1 upstream, but its Qwen 2.1 is still text-to-image plus img2img only (only `variants/txt2img`
   exists; there is no reference or mask path).
2. **Mage-Flow-Edit-Turbo already runs on this Mac**, in the **3D module**:
   `packages/gen3d-engine/python/engine/registry.py` `mflux_edit_cli()` (a Mage-Flow mflux branch
   venv; "9 s for a 1024 px edit at 4 steps, 14.76 GB peak"), reached by `gen3d:generate
   {imageOnly, editFrom}` and by the chat tool `edit_image`
   (`packages/harness/src/tools/image-tools.ts`). The user's library has it at
   `~/Bobble/Models/Image/Editing/microsoft__mage-flow-edit-turbo`. **Risk found:** the HF API now
   returns 401 for `microsoft/Mage-Flow-Turbo`, `-Edit-Turbo` and `-Edit` without auth (so does
   `microsoft/Lens`, whose originals mflux's own README calls withdrawn), while `Comfy-Org/Mage-Flow` (MIT,
   ungated) carries `mage_flow_edit_turbo_int8_convrot.safetensors` (4.16 GB) +
   `qwen3vl_4b_bf16` (8.88 GB) + VAE (0.35 GB). A fresh install may not be able to fetch the
   source `gen3d-engine/src/catalog.ts` names (17.5 GB).
3. **BiRefNet (MIT) is already downloaded in two places:** `ZhengPeng7/BiRefNet` (444 MB) in the
   TRELLIS env, which substitutes it for the gated RMBG-2.0 (`GATED_MIRRORS`), and
   `birefnet.safetensors` behind ComfyUI's native `RemoveBackground` in the image→3D graph
   (`packages/gen-service/src/comfy-workflow.ts`).
4. **ComfyUI 0.37.0** is installed (`~/.cache/bobble/engines/comfyui`) and natively has the whole
   editor toolbox (read from `comfy_extras/`): `SAM3_Detect` (point, box and text prompts →
   masks), `SAM3_VideoTrack`, `RemoveBackground`/`LoadBackgroundRemovalModel`, the SeedVR2 nodes,
   `TextEncodeQwenImageEditPlus`, `TextEncodeQwenImage21` (up to 16 reference images),
   `TextEncodeMageFlowEdit`, `ReferenceLatent`, `InpaintModelConditioning`, `SetLatentNoiseMask`,
   `DifferentialDiffusion`, mask ops (Grow/Feather/Threshold/Composite/ImageCompositeMasked),
   `EmptyQwenImageLayeredLatentImage`, `TextOverlay`, `ImageCompare`, frame interpolation
   (RIFE/FILM), `VideoTrim`/`Video Slice`/`ConcatenateVideo`/`VideoCrop`, audio
   `TrimAudioDuration`/`AudioConcat`/`AudioMerge`/`AudioAdjustVolume`/`AudioEqualizer3Band`,
   ACE-Step 1.5 (`TextEncodeAceStepAudio1.5`, `ReferenceTimbreAudio`), YuE2, MiniMax Music 3, and
   Wan `WanVaceToVideo`/`WanFirstLastFrameToVideo`/`WanImageToVideo`/`WanMove*`, LTX
   `LTXVImgToVideo`/`LTXVAddGuide`, and VOID (video object removal). This is the portable
   baseline for every editor op (§4.9).

### 2.6 The one studio that is already an editor: 3D

`apps/desktop/src/tripo/` is the pattern to copy: the viewport fills the room; panels **float**
over it (the user, 2026-09-14: "make the … cards on the left float above the viewport");
`HistoryRail.tsx` is a version **tree** (`store.ts AssetVersion {id, parentId, op, …}`) — hover to
preview, click to go back, and a new op from an old node is a branch; `StudioEngineChip.tsx` shows
*this studio's* engine and steps/s instead of the chat model's tok/s; `TopBar.tsx`
`TripoTopBarControls` puts Send To (real app logos) and Export in the app's top-right cluster; a
drop anywhere imports; `ModuleGate` blurs the room while its engine is missing.

### 2.7 What is missing

| Capability | Today |
|---|---|
| An image canvas (zoom, pan, overlays), selections and masks | none |
| Click-to-comment, region edits, markup | none |
| Instruction editing in the Image studio | only img2img; the instruction-edit model exists only in chat and 3D |
| Inpaint, erase, outpaint/resize, upscale, background removal | engines on disk, none wired |
| Layers, text layers, presets beyond starter prompts | none |
| Documents that survive a relaunch | none (`useStudioRuns` is in memory) |
| Audio timeline, trim/split/fade, transcript, cleanup, stems | none |
| Video timeline, trim/export, captions, image-to-video, extend | none (and the video input is silently ignored) |
| An engine chip for the image/audio/video studios | none (only 3D has one) |

### 2.8 Earlier asks from the user this design has to satisfy

- **The queued editing bar** (memory `pi-desktop-qwen-image-21`): "an editing bar on the LEFT of the
  fullscreen image viewer (Markup · Comment · Remove BG · Erase · Resize) with masking edits". That
  is exactly ChatGPT Images 2.5's edit toolbar (§3.1), and it is the Image editor's tool rail here.
- Core controls live in the bar under the input, then the rail, then the gears (the
  `StudioShell` doctrine: "you should be able to access all core functionality … without even going
  into the right sidebar"); compact dropups, not forms.
- Floating panels over the canvas, the studio's own engine chip, no Chat|Work toggle in a studio
  (3D queue, 2026-09-14).
- The result is revealed in place (the cascade sweep), not swapped (memory `pi-desktop-bobble-loader`).
- Readable paths only (`~/Bobble/...`, `electron/bobble-paths.ts`).
- The guardian and memory guard admit and pause every heavy run; nothing may freeze the Mac.
- Headless tests with a focus guard; look at screenshots before claiming a visual change is done.
- Brand logos come from a catalog or the owner's own file, never redrawn; a + control lights only
  on its own hover.

---

## 3. External research

### 3.1 Reference editors — what each does and what we take

| Product | What it does | What we take |
|---|---|---|
| **ChatGPT Images 2.5** (2026-09-08) — [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-images-2-5-is-out-ive-been-testing-it-for-24-hours-and-these-are-the-3-new-features-youll-actually-use), [MakeUseOf](https://www.makeuseof.com/chatgpts-image-editor/), [Atlas Cloud on comments](https://www.atlascloud.ai/blog/tips/gpt-image-2.5-comment-edit) | An Edit mode over a picture with a toolbar: **Markup, Comment, Remove BG, Erase, Resize**. Comment: click a spot, type the change; **several numbered pins** per image. Resize: aspect presets (1:1, 3:4, 9:16, 4:3, 16:9) by outpainting. Weakness they state: "the pin is not a hard mask" — nearby pixels drift. | The tool set and the pin grammar (this is the user's reference). Our improvement: the pin resolves to a region and the edit is **stitched**, so pixels outside the region are guaranteed unchanged (§4.4). |
| **Krea Edit annotations** (2026-03-26) — [Krea blog](https://www.krea.ai/blog/annotations) | Draw rectangles; each gets a **numbered badge in its own colour**; a prompt card anchors below each; a sidebar lists them; a region can carry a reference image; **one generation applies all**. | Batching ("Apply 3 changes"), per-pin colour, the side list, and reference images per pin. |
| **Photoshop Generative Fill** — [Adobe help](https://helpx.adobe.com/photoshop/desktop/create-open-import-images/create-images/edit-images-with-generative-fill.html) | Select → a **contextual task bar** under the selection → prompt (empty = fill with surroundings) → **3 variations** → result on a new generative layer. | The contextual bar at the bottom, "empty prompt = remove/fill", variations as siblings, non-destructive layers. |
| **Canva Magic Edit** — [Canva help](https://www.canva.com/help/using-magic-edit/) | Brush over an area (size slider), describe what to add or replace, Generate. | A brush as the fallback selection. |
| **Photoroom** — [help](https://help.photoroom.com/en/articles/7969763-remove-the-background-of-a-photo) | Background removal first; then transparent, colour, image or AI-generated backgrounds; templates. | The Product-shot preset and the background choices after Remove BG. |
| **Apple Photos Clean Up** — [Apple support](https://support.apple.com/guide/photos/remove-distractions-and-imperfections-pht5c38b77c5/mac) | Tap, brush or circle an object to erase it; distractions pre-highlighted. | Tap-to-erase on a detected object; brush and circle as fallbacks. |
| **Google Magic Editor** — [How-To Geek](https://www.howtogeek.com/how-to-use-magic-editor-on-your-google-pixel-9/) | Tap or circle → Erase / Move / Reimagine (prompt). | The same verbs on a selection. |
| **Descript** — [Descript](https://www.descript.com/blog/article/how-to-use-descript) | Edit audio and video **by editing the transcript**; Studio Sound (one toggle); Regenerate a word in your voice; filler-word removal. | Script-first speech editing, one-toggle cleanup, regenerate a phrase. |
| **ElevenLabs Studio** — [docs](https://elevenlabs.io/docs/eleven-creative/products/studio), [auto-regenerate](https://elevenlabs.io/docs/help-center/product/studio/studio/what-is-auto-regenerate) | Paragraphs with a voice each; regenerate words or paragraphs; a timeline with music, SFX and captions; **Auto-Regenerate** checks output for mispronunciations and redoes it up to twice. | Voice per speaker lane, word-level regenerate, and the self-check (STT round trip) as a system-level quality gate. |
| **Rescript** (open source) — [scriptbyai](https://www.scriptbyai.com/rescript-video-editor/) | A local Descript: Whisper word timestamps in the browser, delete text to cut. | Proof the transcript editor works fully locally. |

The shared lesson: **one selection gesture (tap an object, brush or pin) + one sentence + the result
in place with the old one a click away.** Nobody that ships this to consumers exposes a graph.

### 3.2 Image — which local models can do each operation

Licenses are the weights' licenses; "NC" means non-commercial. Sizes are downloads unless marked.
"Measured" numbers are from this repo's own notes on the user's M5 Pro 24 GB; everything else is
unmeasured here.

| Operation | Candidate (license) | Mac path | CUDA / portable path | Notes |
|---|---|---|---|---|
| Text → image | **Qwen-Image 2.1** 7B (Qwen Research License, **NC**) — [HF](https://huggingface.co/Qwen/Qwen-Image-2.1), [eesel](https://www.eesel.ai/blog/qwen-image-2-1) | mflux wheel (the current default): 97 s/1024², ≈7.4 GB OS drop (**measured**) | ComfyUI native `TextEncodeQwenImage21` | Released 2026-09-20: native 2K, native **RGBA** ("This is an RGBA image with transparency…"), **up to 10 reference images**, and local edits marked by "circles, painted annotations or a separate mask". Editing is not in mflux 0.20.0. |
| Text → image, permissive | **FLUX.2 klein 4B** (Apache-2.0); 9B is NC — [BFL](https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence) | mflux: 16.7 s/1024², ≈5.8 GB (**measured**, `--low-ram`) | ComfyUI | Also **edits with one or more references** (`mflux-generate-flux2-edit`). |
| Instruction edit (whole image or a crop) | **Mage-Flow-Edit-Turbo** 4B (MIT; GEdit-EN 8.27) — [comfyui-wiki](https://comfyui-wiki.com/en/news/2026-07-22-mage-flow-microsoft), [Comfy-Org mirror](https://huggingface.co/Comfy-Org/Mage-Flow) | Mage-Flow mflux branch (in the 3D module): 9 s/1024, 14.76 GB peak at 8-bit (**measured**, gen3d notes); the 4-bit *generator* renders noise on that branch (`mlx_image_worker.py`), 4-bit edit untested. MLX-Swift port: [mage-flow-swift](https://github.com/xocialize/mage-flow-swift) (1–3 references) | ComfyUI native (`TextEncodeMageFlowEdit`, int8 4.16 GB) | The best permissive edit quality found. The source repo question above (401) must be settled first. |
| Instruction edit, permissive and light | **FLUX.2 klein 4B edit** (Apache) | `mflux-generate-flux2-edit --image-paths a.png [b.png…]`, guidance fixed at 1.0 (distilled), 4 steps; already in the bundled wheel | ComfyUI `ReferenceLatent` graph | Edit footprint unmeasured; reference tokens lengthen the sequence, so expect more than generation's 5.8 GB. |
| Instruction edit, strongest consistency | **Qwen-Image-Edit-2511** 20B (Apache) — [Qwen blog](https://qwen.ai/blog?id=qwen-image-edit-2511) | `mflux-generate-qwen-edit` (alias `qwen-edit-2511`); the 7B VL encoder stays bf16 in mflux — too big beside a 4-bit 20B DiT on 24 GB (estimate; an 8-bit-encoder patch like our Qwen 2.1 "te8" recipe would be needed) | ComfyUI `TextEncodeQwenImageEditPlus` | Character consistency; multi-person; lighting and novel-view built in. 32 GB+ Macs. |
| Instruction edit, marks and masks | **Qwen-Image 2.1** edit (NC) | **Not available** in mflux 0.20.0 — needs a port (vision tokens + reference latents); ComfyUI's GGUF route costs ≈15 GB on MPS (memory note) | ComfyUI native (16 refs) | Reads painted annotations natively, which fits Markup→edit. |
| Masked inpaint / outpaint | **FLUX.1 Fill [dev]** 12B (FLUX.1-dev NC license; the HF repo is gated "auto") | `mflux-generate-fill --image-path --masked-image-path` | ComfyUI `InpaintModelConditioning` | The best mask-true fill; NC and gated, so an opt-in. Permissive fallback: klein edit on the crop plus our stitch (§4.4). |
| Masked edit, reference | FIBO-Edit (Bria; `--mask-path`) | mflux `mflux-generate-fibo-edit` | ComfyUI | License not verified here; not recommended until checked. |
| Erase (object removal) | **LaMa / big-lama** (Apache-2.0) — [advimman/lama](https://github.com/advimman/lama), [LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX) | onnxruntime (CPU or CoreML EP), fixed 512² crops; Core ML conversion exists ([big-lama-coreml](https://huggingface.co/Jia-Liu/big-lama-coreml), license to verify) | onnxruntime CPU/CUDA/DirectML | Seconds, tiny footprint; generative fill for large holes. |
| Remove background | **BiRefNet** (MIT) — [ZhengPeng7/BiRefNet](https://github.com/zhengpeng7/birefnet); `onnx-community/BiRefNet_lite-ONNX` (MIT, ungated) | already on disk (see §2.5); ONNX lite for speed | ComfyUI `RemoveBackground` (`Comfy-Org/BiRefNet`, MIT) | **Avoid RMBG-2.0**: CC BY-NC ([briaai](https://huggingface.co/briaai/RMBG-2.0)). |
| Remove background, instant, Mac only | **Apple Vision** `VNGenerateForegroundInstanceMaskRequest` (OS, no weights; macOS 14+) — [WWDC23 10176](https://wwdcnotes.com/documentation/wwdc23-10176-lift-subjects-from-images-in-your-app/) | Swift (pi-mac) | — | Class-agnostic instance masks (0 = background, 1…n = objects); an instance can be looked up under a tap point. |
| Click → object mask | **SAM 2.1** (Apache-2.0): [Core ML](https://huggingface.co/apple/coreml-sam2.1-large) (`apple/coreml-sam2.1-{tiny,small,baseplus,large}`, Apache, ungated, separate image-encoder and mask-decoder `.mlpackage`s — checked via the HF API), ONNX `onnx-community/sam2.1-hiera-{tiny,small}-ONNX` (ungated) | Core ML via Swift, or onnxruntime in a Python worker. `mlx-sam` 0.3.0 needs **Python ≥ 3.14** and its repo has **no license** (checked via PyPI and GitHub APIs) → do not vendor | onnxruntime, or ComfyUI SAM3 | Encode once per image, decode per click (tens of ms). |
| Click/text → mask, portable | **SAM 3 / 3.1** (Meta **SAM License**: commercial use allowed with restrictions) — [Meta](https://ai.meta.com/blog/segment-anything-model-3/), `Comfy-Org/sam3.1` (1.75 GB, ungated) | ComfyUI MPS | ComfyUI `SAM3_Detect` (`positive_coords`, `negative_coords`, `bboxes`, text) | Text prompts ("the phone screen") make presets possible (mockup screen quad). |
| Upscale / restore | **SeedVR2 3B/7B** (Apache-2.0), one-step — [HF](https://huggingface.co/ByteDance-Seed/SeedVR2-3B) | `mflux-upscale-seedvr2 --resolution 2x --softness 0.x` (in the wheel); `mlx-community/SeedVR2-3B-mlx` | ComfyUI SeedVR2 nodes | Footprint unmeasured. |
| Character consistency | klein edit multi-reference (Apache); Qwen-Edit-2511 + multi-angle/turnaround LoRAs — [turnaround LoRA](https://huggingface.co/tarn59/character_turnaround_sheet_qwen_edit_2511), [guide](https://stable-diffusion-art.com/qwen-image-edit-multiple-angle-lora/); Qwen 2.1 multi-reference (NC) | klein edit per view | ComfyUI | Views generated one at a time and **laid out by the app** beat one-shot "sheet" prompts on consistency and control (§4.5.6). |
| Layer decomposition | **Qwen-Image-Layered** (Apache) — [QwenLM](https://github.com/QwenLM/Qwen-Image-Layered) | 20B-class; not 24 GB | ComfyUI native latent | v3 candidate for "split into layers". |
| Typography | Ideogram 4 (weights under the Ideogram **non-commercial** agreement, gated) — [firethering](https://firethering.com/ideogram-4-open-weight/); Qwen-Image 2.1 | mflux has both | ComfyUI | For posters prefer **real text layers** over diffusion text (§4.5.4). |
| Other permissive edit families | Boogu-Image 0.1 Edit/Edit-Turbo (Apache, 10B) — [GitHub](https://github.com/boogu-project/Boogu-Image) | mflux has t2i only | ComfyUI native (`nodes_boogu.py`) | Watch list. |
| MLX masked-edit reference implementation | [mlx-gen](https://github.com/lpalbou/mlx-gen) (MIT, 30★, a fork of mflux) | `--mask-path` for Qwen edit, a control-inpaint sidecar for klein, Wan2.2/VACE video | — | A reference for a later latent-masked path; too small to depend on. |

### 3.3 Audio

| Operation | Candidate (license) | Mac path | Portable path |
|---|---|---|---|
| TTS / clone | Qwen3-TTS 0.6B/1.7B, Kokoro, MOSS-TTSD, Dia (all in the catalog) | mlx-audio (the existing `audio` module, pinned 0.4.5) | torch/ONNX builds (track 4) |
| Speech → text with **word timestamps** | Whisper (MIT), Parakeet-TDT (weights CC-BY-4.0; `parakeet-mlx` Apache) — [mlx-audio docs](https://blaizzy.github.io/mlx-audio/), [parakeet-mlx](https://github.com/senstella/parakeet-mlx) | mlx-audio STT (word timestamps) — same env | faster-whisper (CTranslate2, MIT) |
| Cleanup (denoise / enhance) | DeepFilterNet3 (MIT/Apache; ONNX exists) — [Rikorose](https://github.com/Rikorose/DeepFilterNet); MossFormer2 SE 48k (Apache) — [HF](https://huggingface.co/alibabasglab/MossFormer2_SE_48K) | mlx-audio lists both | onnxruntime (DeepFilterNet3 ONNX) |
| Stems | Demucs / HTDemucs (MIT) — [demucs-mlx](https://github.com/ssmall256/demucs-mlx) (7-min song in ~12 s on an M4 Max, their number) | demucs-mlx | torch demucs |
| "Isolate the dog barking" | **SAM-Audio** (SAM License) — [Meta](https://ai.meta.com/blog/sam-audio/) | mlx-audio lists it | torch |
| Music (+ repaint, extend, cover, stems, BPM/key) | **ACE-Step 1.5** 2B/XL-4B (**MIT** code and weights) — [GitHub](https://github.com/ace-step/ACE-Step-1.5) | vendor says MLX supported; ComfyUI native nodes | ComfyUI native |
| Music / SFX (existing) | Stable Audio 3 small (Stability Community licence; the catalog marks it `commercialUse: false`, while its Stable Audio Open rows note commercial use is free under $1M revenue — to reconcile): 6 s for 12 s of audio (**measured**) | ComfyUI | ComfyUI |
| Foley from video | HunyuanVideo-Foley (Tencent community licence) — [GitHub](https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley); MMAudio (weights licence to verify) | heavy | ComfyUI has an MMAudio VAE in-tree | 

mlx-audio's latest release (0.5.0, 2026-09-14 per its release notes) adds MiniMax Music 3 and more ([releases](https://github.com/Blaizzy/mlx-audio/releases)); the app pins 0.4.5, so which of the STT/enhance/separation models the pinned version already has — and the upgrade — is its own measured step (AUD-03).

### 3.4 Video

| Operation | Candidate (license) | Notes |
|---|---|---|
| Image → video (I2V) | **Wan2.2 TI2V-5B** (Apache) — [ComfyUI docs](https://docs.comfy.org/tutorials/video/wan/wan2_2); **LTX-2.5** (open weights, free under $10M ARR) — [LTX](https://ltx.io/model/ltx-2-5) | LTX-2.5 distilled is in the catalog (195 s for 2 s at 640×352 at Q2_K, **measured**; `minUnifiedMemoryGB: 32`). Wan2.2-5B on 24 GB is unmeasured. |
| Extend / masked video edit / reference-to-video | **Wan2.1-VACE-1.3B** (Apache; ~8 GB VRAM class, 480p) — [HF](https://huggingface.co/ali-vilab/VACE-Wan2.1-1.3B-Preview), [ComfyUI VACE](https://docs.comfy.org/tutorials/video/wan/vace) | ComfyUI `WanVaceToVideo`; start/end frames via `WanFirstLastFrameToVideo`; motion paths via `WanMove*` ("drag to animate"). |
| Smooth motion / upscale | RIFE/FILM (native `FrameInterpolate`); SeedVR2 (Apache) | ComfyUI native. |
| Object removal in video | SAM3 video track + VOID (native nodes) or VACE MV2V | Heavy: v3. |
| Local trim / arrange / export | **Mediabunny** (MPL-2.0, zero deps, pure TS over WebCodecs) — [mediabunny.dev](https://mediabunny.dev/), [GitHub](https://github.com/Vanilagy/mediabunny) | Trim, transmux, transcode, resize, audio resample in the renderer; hardware H.264 through WebCodecs. **No ffmpeg** (the app ships none; the user's Mac only has Homebrew's). Pure TS also means no WASM, which the renderer CSP (`script-src 'self'`) would forbid. |

Context from this repo: Wan2.1-1.3B T2V took **835 s** for the studio's default 4 s clip on the 24 GB
Mac (memory `pi-desktop-comfy-native-3d-video`). Generation in a 24 GB video editor is a
minutes-long, clearly-labelled action; the editor must be useful without it.

### 3.5 Plumbing facts that shape the design

- The **renderer CSP** is `script-src 'self'` (`apps/desktop/vite.config.ts`): no
  `'wasm-unsafe-eval'`, so onnxruntime-web or transformers.js in the renderer would need a CSP
  change. Keep ML out of the renderer; pure-TS pixel, audio and container work is fine.
- **`nativeImage`** in main decodes PNG/JPEG to raw bitmaps and encodes PNG with no dependency
  (HEIC excepted: use `sips`, per memory) — the stitcher can live in main with zero new deps.
- **onnxruntime** Python wheels exist for macOS arm64 (with the CoreML EP), Linux (CUDA) and Windows
  (DirectML), so one `tools_worker.py` serves SAM 2.1 / BiRefNet / LaMa / DeepFilterNet on every
  platform. `onnxruntime-node` 1.30 (MIT) is 301 MB unpacked for all platforms — a heavier
  alternative that would sit in the app bundle rather than a download-on-demand module.
- **`pi-mac`** (SwiftPM, `platforms: .macOS("26.0")`, built with Command Line Tools only) can
  link `Vision` and `CoreML` without Xcode; Core ML packages compile at runtime
  (`MLModel.compileModel(at:)`). MLX-Swift helpers, by contrast, need the Metal compiler, which
  this Mac lacks (memory `pi-desktop-3d-ootb-and-finish`).
- mflux 0.20's in-loop callback exposes the model's per-step `denoised` prediction; `mlx-taef`
  decodes it cheaply for FLUX.2/Krea 2 ([PR](https://github.com/IonDen/mlx-taef/pull/44)), not for
  Qwen 2.1. That gives cheap live previews for klein edits.

### 3.6 What this means for Bobble

1. **Most of the image editor's model work is already installed or one module away.** The bundled
   wheel has klein edit, Fill, Kontext, Qwen edit and SeedVR2; the 3D module has Mage-Flow-Edit;
   two copies of BiRefNet exist; ComfyUI 0.37 has SAM3, background removal, SeedVR2, inpaint
   conditioning and all the video nodes. The missing part is **the editor**, not the models.
2. **The region guarantee has to come from the system, not the model.** No permissive MLX model
   takes a mask plus an instruction today (Fill is NC and gated; Qwen 2.1's marks are NC and
   unported). Crop → edit → feathered, colour-matched stitch works with *any* edit engine and
   makes "everything outside the pin is untouched" a guarantee (ChatGPT only offers it as advice).
3. **Commercial-clean defaults exist for every image op:** klein 4B (Apache), Mage-Flow (MIT),
   BiRefNet (MIT), SAM 2.1 (Apache), LaMa (Apache), SeedVR2 (Apache). The best-in-class options
   (Qwen-Image 2.1, FLUX Fill) are NC, so the licence choice is the user's (§6).
4. **Segmentation on Mac** should be Apple Vision (zero download, instant) plus SAM 2.1 through
   Core ML or onnxruntime; the MLX SAM ports are unlicensed or need Python 3.14. ComfyUI SAM3 is
   the portable baseline.
5. **Audio needs almost no new runtime on Mac:** mlx-audio (already the `audio` module) covers
   STT with word timestamps, enhancement and separation; ACE-Step 1.5 (MIT) runs through ComfyUI.
6. **Video editing is a WebCodecs + Mediabunny job**; model ops are ComfyUI graphs with honest
   time estimates.

---

## 4. Design

### 4.1 Principles

1. **Document, not transcript.** An editor holds one document (a picture, a mix, a cut) and its
   version tree. Generating is one tool among many, not the room's identity.
2. **One gesture grammar in all three rooms: point → say → see it in place.** A pin on a picture,
   on a moment in the audio, or on a spot in a video frame opens the same "Describe changes" pill.
3. **The system carries the guarantees.** Regions are stitched; exact text is a text layer;
   speech is checked by transcribing it back; product pixels are recomposited over generated
   scenes. The model is asked only for what only a model can do (the user's own framing in track 10).
4. **Every op has a baseline.** Platform × op → an ordered list of engines, like
   `apps/desktop/src/settings/engine-catalog.ts` (`enginesFor`, `preferredEngine`,
   `baselineEngine`): a Mac fast path first, a portable ComfyUI or onnxruntime path always.
5. **Non-destructive by construction.** Every op writes a new version file; undo moves a pointer.
6. **Same doors as today:** `JobQueue`, guardian admission, pausables, make-room, modules and
   `ModuleCard`, readable paths, and the reveal animation.

### 4.2 Architecture

```
 renderer  apps/desktop/src/editor/                 main  apps/desktop/electron/editor/
 ┌───────────────────────────────────────┐   IPC   ┌─────────────────────────────────────────┐
 │ EditorFrame (tool rail, floating       │ editor:* │ editor-docs.ts   documents on disk      │
 │  panels, contextual bar, top-bar chip) │────────▶│ op-router.ts     platform×op → engines  │
 │ CommentLayer (pins + pill)             │◀────────│ editor-manager.ts runs ops through the  │
 │ ImageCanvas / AudioTimeline / VideoTL  │ events  │   existing JobQueue + guardian + modules │
 │ doc-store.ts (zustand)                 │         │ stitch.ts        crop/feather/colour-   │
 │ pure: mask-geometry, version-tree,     │         │   match/composite (nativeImage IO)      │
 │  timeline math, loudness, wav encode   │         └──────┬───────────┬───────────┬──────────┘
 │ WebCodecs + Mediabunny (local AV edits)│                │           │           │
 └───────────────────────────────────────┘        worker.py (mflux)  tools_worker.py   ComfyUI graphs
                                                  edit/fill/upscale  (onnxruntime: SAM2.1,  (baseline for
                                                  gen (existing)     BiRefNet, LaMa, DFN3)   every op)
                                                  pi-mac --vision (Apple Vision, OCR)
                                                  gen3d bridge (Mage-Flow-Edit, until moved)
```

The chat keeps its tools; later they call the same `editor-manager` ops (§4.10).

### 4.3 The shared editor frame

Layout (all three rooms), rendered through the existing `contentOverride` seam:

```
┌ app top bar ─────────────────────────────────────────────────────────────────────┐
│ ☰  Image Studio · fox-at-dusk ▾         [● Mage-Flow Edit · 2.1 steps/s] [Send To] [Export] │
├──────────────────────────────────────────────────────────────────────────────────┤
│ ┌──┐                                                            History ⌃         │
│ │ ↖│                ┌──────────────────────────────┐            ● 4  Make the sky…│
│ │ ◎│   ①            │                              │            ○ 3  Remove BG    │
│ │ ✎│   ┌──────────────────────────────┐            │            ○ 2  Generated    │
│ │ ⌫│   │ Describe changes        ✓  ✕ │            │            Layers ⌄          │
│ │ ▢│   └──────────────────────────────┘            │                              │
│ │ ⤢│                │         (canvas)             │                              │
│ │ ⇧│                └──────────────────────────────┘                              │
│ │ ✦│         ┌ Describe a change to the whole picture…                 ↵ ┐        │
│ └──┘         └ [1:1 ▴] [Model: Recommended ▴] [Takes: 1 ▴] [Enhance ▴]    ┘        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Canvas** fills the content area; everything else floats over it (the 3D rule).
- **Tool rail** (left, vertical pill; this is the user's queued left edit bar): per room, below.
  Shortcuts on hover.
- **Contextual bar** (bottom centre, the `StudioShell` composer and `StudioPicker` dropups
  reused): what the active tool needs — the whole-image instruction or new prompt, brush size for
  Erase, aspect for Resize. Core controls live here, never only in a side panel.
- **History ⌃ / Layers ⌄** (top right, floating, collapsible): a generalisation of
  `tripo/HistoryRail.tsx` (hover = preview in place, click = go back, next op branches).
- **Top bar right cluster** (like `TripoTopBarControls`): the **engine chip** (the running op's
  model and steps/s or ×realtime — the `StudioEngineChip` idea), **Send To**, **Export**. No gears
  and no settings-rail toggle; "Advanced" (steps, seed, guidance) moves into each tool's
  contextual bar behind a "More" dropup.
- **Document switcher**: the doc name in the title ("fox-at-dusk ▾") → recent documents, New,
  Open file…, Reveal in Finder.
- **States:** empty (the drop target plus preset cards; §4.5.6); **module missing** (`ModuleCard`
  in the contextual bar's place, room visible and usable for what it can already do); **running**
  (the region shows the Bobble cascade and reveals the result along the sweep; the pin shows a
  progress ring; the chip shows the rate); **held by the guardian** (the existing note sink:
  "Waiting for memory — needs about 7.9 GB…"); **paused** (memory guard; the pin ring freezes and
  shows "Paused — the Mac needs memory"); **error** (a red dot on the pin, the reason in the pill,
  Retry).
- **Keyboard:** V select, C comment, M markup, E erase, B remove background, R resize, U upscale,
  Space-drag pan, ⌘+/⌘−/0 zoom, `\` hold to compare with the previous version, ⌘Z/⌘⇧Z move through
  history, Enter ✓, Esc ✕ (then leaves the room when nothing is open, as today).

### 4.4 Click-to-comment — the universal grammar

**UI (the user's reference, specified):**

1. Comment tool (C), or hold C and click anywhere with any tool. A **numbered pin** (1, 2, 3 … per
   document, each in its own colour as in Krea) drops at the click.
2. A **floating pill** opens beside the pin (right side; flips left or up near an edge; follows
   zoom and pan): a single-line field with the placeholder **"Describe changes"**, a **✓** button
   (disabled while empty) and a **✕**. Enter = ✓, Esc = ✕ (removes the pin), ⌘Enter = apply every
   pending pin.
3. While the pill is open the **region preview** is already computed: a soft tinted outline around
   what "this" means (§ region pipeline). `[` and `]` (or the scroll wheel) cycle smaller or larger
   candidate masks; ⇧-click adds and ⌥-click subtracts (SAM negative points). With no object under
   the pin the region is a disc; dragging the pin's ring resizes it ("add a bird here").
4. **✓ applies immediately** (queued behind any running job). Pins placed while one runs queue and
   run in pin order, each on the latest version, so they compose. Overlapping queued pins merge
   into one crop with a numbered instruction list. **"Apply 3 changes"** appears in the contextual
   bar when there are drafts (Krea's batching).
5. Pin states: draft (outlined) → queued (filled, number) → running (progress ring; the region
   plays the cascade) → **done** (small check; the pin dims; its pill shows the instruction plus
   *Compare* (hold), *Try again* (a sibling take = branch) and *Undo*) · failed (red dot; the pill
   shows why plus Retry) · cancelled. A "Hide comments" toggle lives in the History panel header.
6. Every applied pin adds a History node labelled with its text ("① Make the jacket red").

**Region pipeline (image; the same idea in time for audio):**

```
tap (x,y) ─▶ proposals:   Mac: pi-mac --vision instance-at-point (0 ms model, OS)
                          + SAM 2.1 point prompt (Core ML / onnxruntime), 3 masks s/m/l
                          baseline: ComfyUI SAM3_Detect positive_coords
          ─▶ pick default: the medium mask with 0.2% < area < 60%; else a disc r = 10% of the short side
✓        ─▶ crop box  = bbox(mask) grown by max(64 px, 0.5 × bbox), clamped, ≥ 512 px short side,
                        snapped to the engine's multiple (16 for FLUX.2, 32 for Qwen 2.1)
          ─▶ engine(crop, instruction[, whole picture downscaled as a 2nd reference for context])
          ─▶ stitch    = result resized into the crop · alpha = feather(dilate(mask, d), f)
                        (d, f scale with the crop: ≈ 8/16 px at 1024) · Lab mean/std colour match
                        measured on a ring outside the mask · composite
          ─▶ new version (pixels outside the feathered mask are byte-identical to the parent)
```

"Let it change the surroundings" (in the pill's ⋯) skips the stitch and edits the whole picture
with a location phrase instead — for global changes such as "warmer light here".

**Interpretation** (rules first, the tiny enhancer model as a fallback, shown in the pill before it
runs, e.g. "→ Erase"):

| Said about a pin | Op |
|---|---|
| remove / delete / erase / get rid of … (object region) | `image.erase` — LaMa for masks under ≈8% of the image, generative fill above |
| "transparent background", "remove the background" | `image.matte` |
| "move / make bigger / smaller" | v1 says it cannot move things yet; v2 lifts the region to a layer, transforms it and fills behind |
| anything else | `image.region_edit` (crop-edit-stitch) |
| audio pin at time t: "say this warmer", "add a door slam", "swell the music here", "cut the cough" | `audio.regenerate_span` (TTS) · `audio.sfx_insert` · `audio.music_repaint` · `audio.cut` / `audio.enhance_span` |
| video pin at (t, x, y) | v1: `video.edit_frame` (the frame goes to the image editor, then "re-animate from here"); v3: SAM3 track + VACE masked V2V |

### 4.5 Image Studio

#### 4.5.1 Tools (rail order = the user's queued bar, plus the rest)

| Tool | Gesture | Op → engine (Mac default; Mac alternates; baseline) |
|---|---|---|
| **Select / Move** (V) | click to select an object, drag layers | `image.segment` → Vision / SAM 2.1; baseline SAM3 |
| **Comment** (C) | pin + pill (§4.4) | `image.region_edit` → **Mage-Flow-Edit-Turbo** (MIT) or **klein 4B edit** (Apache); alt Qwen-Edit-2511 (32 GB+), Qwen 2.1 edit (NC, after the port); baseline ComfyUI klein/Mage-Flow graph + stitch |
| **Markup** (M) | pen, arrow, circle, text note — a vector Markup layer (hidden on export unless chosen) | stays annotation; "Apply markup" sends each shape as a region edit, or the annotated picture to Qwen 2.1 (NC) when that path exists |
| **Remove BG** (B) | one click; then a choice: Transparent / White / Colour / Blur / Scene… | `image.matte` → **Apple Vision** (instant) → **BiRefNet** HQ (MIT); baseline ComfyUI `RemoveBackground`. Scene = klein edit with the cutout as reference, then **the original cutout pixels composited back** plus a contact shadow drawn from the alpha |
| **Erase** (E) | tap an object (Clean Up style), brush or lasso | `image.erase` → **LaMa** (Apache, onnxruntime); large masks → generative fill (FLUX Fill if opted in, else klein crop-edit "remove it, continue the background" + stitch) |
| **Resize** (R) | presets 1:1, 3:4, 9:16, 4:3, 16:9, custom; Extend (default) / Crop / Scale | `image.outpaint` → FLUX.1 Fill (NC, opt-in) or klein edit on a padded canvas, then the original re-composited over the centre; baseline ComfyUI outpaint |
| **Upscale** (U) | 2× / 4K; "Soft" toggle | `image.upscale` → **SeedVR2-3B** via `mflux-upscale-seedvr2`; baseline ComfyUI SeedVR2 |
| **Presets** (✦) | gallery of recipes (§4.5.6) | composed ops |

The contextual bar with no tool active is the **whole-picture instruction**
(`image.edit`: same engines, no crop). With an empty document it becomes the **Generate** bar
(`image.generate`: Qwen-Image 2.1 by default, klein, Z-Image — the existing `gen:generate` path,
Shape/Size/Style/Takes/Model/Enhance dropups kept). Takes > 1 shows a small strip of candidates
above the bar; picking one makes it current and the rest stay as siblings in History (Photoshop's
three variations).

#### 4.5.2 Layers — deliberately few

`Background` (the version's pixels) · `Cutout` layers (from Remove BG or "Lift to layer" on a
selection) · `Text` layers (real type rendered by the app with system fonts: exact spelling,
editable, crisp) · `Markup`. Visibility, opacity and order only; normal blend; flattened on export.
A PSD-grade stack is not the goal; this set covers posters, product shots, mockups and stickers.

#### 4.5.3 History

The version tree from `tripo/store.ts`, shared as a pure `editor/version-tree.ts`: every op adds a
node `{id, parentId, op, label, file, thumb, params, seed, model, created}`; hover previews in
place; click goes back; the next op branches. "Try again" on a pin makes a sibling.

#### 4.5.4 Text and typography

Diffusion text fails at the edges (the Qwen 2.1 text benchmark in memory found letter flips at 4
bits). The editor does not depend on it: a poster's copy is a **Text layer**; if the picture was
generated with text, an **OCR check** (Apple Vision `VNRecognizeTextRequest` through pi-mac) compares
it with the prompt's quoted strings and offers "Replace with a real text layer".

#### 4.5.5 Export and Send To

Export: PNG / JPEG / WebP; 1×, 2× or a custom size; keep transparency or flatten on a colour;
include markup; strip metadata (default) or keep prompt/seed/model. Send To (with real logos): **Chat**
(`send-to-chat.ts`), **3D Studio** (the image, or a character sheet's views, as multi-image input
through `tripo/viewer-io.ts addInputImages` — the handoff has to accept images for `'3d'`),
**Video Studio** ("Animate"), Photos, Preview, Finder, and any installed editor from
`canvas-main.ts CATEGORY_APPS`.

#### 4.5.6 Presets (data, not code: `editor/presets.ts`)

A preset is `{id, title, glyph, inputs[], steps: Op[], layout?, output}` shown as the empty-state
cards (replacing today's starters) and in the ✦ gallery.

| Preset | Recipe (system does the parts a model is bad at) |
|---|---|
| **Character sheet** | Input: a picture or a prompt (generate first). For each view (front, ¾, side, back; optional expressions row): klein edit with the reference — "same character, full body, {view} view, neutral A-pose, plain light-grey background, even studio light" → Remove BG → the **app lays out the sheet** (equal figure heights from the alpha bounds, labels, padding) → output the sheet plus each RGBA view. **Send To 3D** uses the views as TRELLIS multi-image input. Upgrades: Qwen-Edit-2511 with a turnaround LoRA on 32 GB+; Qwen 2.1 multi-reference when ported. |
| **UI screen** | The local chat model writes one HTML/CSS screen from the brief (a strict system prompt, like the enhancer calls it) → rendered to PNG by the existing HyperFrames still renderer (`electron/gen/hyperframes-still.ts`, offscreen Chromium) → a crisp, real-text picture; Comment edits regenerate the HTML region, not pixels. Shares the design-quality work of track 10. |
| **Device / product mockup** | Input: a screenshot or artwork. Scene: generate "a {phone/laptop/poster/mug} on {surface}, soft light" (klein), or pick a saved scene → locate the screen with SAM3's text prompt "screen" (or the user's four taps) → fit a quad → **perspective-warp the user's exact pixels in** (not regenerated) → an optional low-strength edit pass at the edges for glare and shadow. |
| **Product shot** (Photoroom) | Remove BG → scene choices (Studio white, Marble, Outdoor, Pastel, Custom prompt) → klein edit with the cutout as reference → original cutout composited back → contact shadow → export 1:1 and 4:5. |
| **Sticker / transparent asset** | Qwen 2.1 RGBA prompt (NC) or generate on a flat background → Remove BG → optional white die-cut outline stroked from the alpha. |
| **Poster** | Qwen 2.1 background (NC) or klein → Text layers for the copy → OCR check. |
| **Restore & upscale** | SeedVR2 → optional "colourise" instruction edit. |
| **Expand to size** | Resize preset (a shortcut). |
| **Logo / icon** | Links to the existing OmniSVG connector (vector), opening the result as an image layer. |

#### 4.5.7 Memory on a 24 GB Mac

Region edits run on crops (≤ 1024² by default), so the region edit costs less than a full-picture
edit. Heavy edit engines (Mage-Flow-Edit 8-bit: 14.76 GB peak) park the chat model through
`make-room.ts` exactly as generation does; the tools worker (SAM/BiRefNet/LaMa, an estimated 1–2 GB, measured in SPK-01) is light,
registers with `pausables.ts`, and is stopped when the room closes. Every new engine's catalog
footprint (`residentFloorGB`, `peakResidentGB`) is **measured** before shipping, as the catalog
comments demand.

### 4.6 Audio Studio

```
┌ top bar: Audio Studio · podcast-intro ▾      [● Qwen3-TTS · 1.4× realtime] [Send To] [Export] ┐
│┌─┐  ▶ ⏮ ⏭  00:12.4 / 01:30      ───────────── ruler ──────────────────         History ⌃    │
││↖│  Script ▸ "Welcome back to │the show│ — today we're …"  (selected words → [Regenerate]  │
││✂│                                                        [Voice ▾] [Delete] [Slower])   │
││◎│  Voice · Ava    ▕██▇▅▃▂▁▂▅▇██▇▅▃▂▁ ▕▇▅▃▂▁▂▃▅▇▕           ②                              │
││✧│  Music          ▕▂▃▅▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▅▃▂▁▕                                          │
││✚│  Effects             ▕█▅▂▕                ▕▇▃▕                                        │
││✦│  ┌ + Speech ▴ │ The text to read at the playhead…                              ↵ ┐   │
│└─┘  └ [Voice: Ava ▴] [Pace ▴] [Model ▴]                                              ┘   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Lanes and clips:** tracks (Voice × speakers, Music, Effects, Imported), clips with real
  waveforms (`chat/audio-peaks.ts peaksOf`), trim handles, split at the playhead (S), fades, gain,
  snapping, mute and solo. Playback is a Web Audio graph; **mixdown** renders through
  `OfflineAudioContext` → WAV (pure TS) or M4A/AAC (WebCodecs `AudioEncoder` + Mediabunny).
  Loudness normalise to −16 LUFS (spoken) or −14 (music) with a pure BS.1770 meter.
- **Tools:** Select, Split (✂), Comment (◎, a pin at a time), Clean up (✧: one toggle on a clip →
  DeepFilterNet3 or MossFormer2; Descript's Studio Sound), Generate (✚ at the playhead: Speech /
  Music / Effect, the existing `gen:generate` audio paths), Presets (✦).
- **Script-first speech** (Descript): generated speech keeps its text; imported speech is
  transcribed (mlx-audio Whisper/Parakeet with word timestamps). Select words → Regenerate (same
  voice, a take chosen from siblings), change voice, delete (cuts the audio), speed; typing new
  words inserts TTS in that clip's voice (cloned voices included). "Remove filler words" is one
  action.
- **Voices:** presets plus saved clones ("Use this as a voice" on any clip selection stores the
  reference clip in the document; Qwen3-TTS clones from ≈3 s).
- **Auto-check (ElevenLabs' pattern, system-side):** each TTS take is transcribed back; if the
  word error rate against the script exceeds a threshold it is regenerated with the next seed, up
  to twice, and flagged if it still fails.
- **Model ops:** Isolate/Stems (demucs-mlx, MIT; "Isolate …" by text with SAM-Audio, SAM License,
  opt-in), Music with BPM/key and **Repaint/Extend a section** (ACE-Step 1.5, MIT, through ComfyUI;
  Stable Audio 3 kept), SFX takes (Stable Audio 3).
- **Presets:** Podcast intro (voice + music bed with automatic ducking), Voiceover from a script,
  Audiobook chapter (paragraph-per-clip), Clean up a recording, Split a song into stems, Sound pack
  (N takes of an effect), Loop (ACE-Step at a BPM, trimmed to whole bars).
- **Export:** mixdown WAV/M4A, stems, selected clip, SRT/VTT of the script.

### 4.7 Video Studio

```
┌ top bar: Video Studio · launch-teaser ▾     [● LTX-2.5 · 0.4 steps/s] [Send To] [Export] ┐
│┌─┐        ┌──────────── monitor (fit, 16:9 | 9:16 | 1:1) ────────────┐   History ⌃     │
││↖│        │                 frame @ 00:04.2                  ③      │                 │
││✂│        └──────────────────────────────────────────────────────────┘                 │
││T│   ▶ ⏮ ⏭   00:04.2 / 00:18.0        [Fit ▴] [Aspect 9:16 ▴]                           │
││◎│   Video   ▕clip 1 ▕clip 2 ───────▕clip 3▕                                           │
││✚│   Audio   ▕music bed ─────────────────────────▕                                     │
││✦│   Text    ▕Title▕     ▕caption▕caption▕caption▕                                     │
│└─┘                                                                                    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- **Local, instant editing first** (no model): import, arrange, trim, split, speed, reframe or crop
  (16:9 ↔ 9:16 ↔ 1:1 with a draggable safe area), fades, a music bed, titles and lower thirds
  (HyperFrames scenes rendered by the existing still renderer), **captions** from STT (burned in or
  exported as SRT). Preview decodes with WebCodecs (Mediabunny's canvas sink) for frame-accurate
  scrubbing; **export** re-encodes H.264/AAC MP4 through WebCodecs + Mediabunny, with no ffmpeg.
- **Model ops (✚), each with a time estimate before it starts and the guardian's admission:**
  *Animate a picture* (I2V: LTX-2.5 distilled where memory allows — `minUnifiedMemoryGB 32` today —
  or Wan2.2-TI2V-5B, to be measured on 24 GB), *Extend* (the last frame → I2V, or VACE-1.3B
  extension), *Start → end* (`WanFirstLastFrameToVideo`), *Motion path* (draw an arrow → `WanMove`),
  *Add sound* (Stable Audio 3 SFX at the playhead; LTX-2.5's joint audio), *Smooth motion* (RIFE),
  *Upscale* (SeedVR2). Remove object in video (SAM3 track + VACE/VOID) is v3.
- **Comment on a frame:** v1 opens that frame in the Image editor; the edited frame comes back as
  a still or as the start of a re-animation ("Re-animate from here").
- **Presets:** Animate a picture, Captioned short (9:16 plus auto-captions), Title card, Slideshow
  (images plus a Ken Burns move plus music), Product spin (image → 3D → turntable render → clip; a
  cross-studio recipe).

### 4.8 Documents on disk

```
~/Bobble/studio/image/fox-at-dusk/
  document.json            ← {kind, name, versions[], currentVersionId, comments[], layers[], presets used}
  01-generated.png
  02-remove-background.png
  03-make-the-jacket-red.png     (label-derived names, deduplicated like bobble-paths.uniqueName)
  masks/03-pin-1.png
  thumbs/…
~/Bobble/studio/audio/podcast-intro/{document.json, clips/*.wav, mixdowns/*.m4a}
~/Bobble/studio/video/launch-teaser/{document.json, media/*, exports/*.mp4}
```

Chat results stay in `~/Bobble/generated/…`; "Open in studio" **copies** the file into a new
document (the original stays untouched). Per-document size shows in the document switcher; "Clean
up history" keeps the current branch. The `~/Bobble/studio` root joins Manage Storage.

### 4.9 Platform matrix (engine lists per op, first available wins, the last is the baseline)

| Op | macOS (Apple Silicon) | Linux / Windows (NVIDIA, AMD, Intel, CPU) |
|---|---|---|
| segment | Vision instance → SAM 2.1 (Core ML or ORT) → ComfyUI SAM3 | SAM 2.1 (ORT CUDA/DirectML/CPU) → ComfyUI SAM3 |
| matte | Vision → BiRefNet (ORT) → ComfyUI RemoveBackground | BiRefNet (ORT) → ComfyUI RemoveBackground |
| erase | LaMa (ORT) → generative fill | LaMa (ORT) → generative fill |
| region_edit / edit | Mage-Flow-Edit (mflux branch) → klein edit (mflux wheel) → ComfyUI graph | ComfyUI (klein / Mage-Flow / Qwen-Edit-2511 fp8) |
| fill / outpaint | FLUX Fill (mflux, NC opt-in) → klein padded-edit + stitch → ComfyUI | ComfyUI (FLUX Fill or klein) |
| upscale | SeedVR2 (mflux) → ComfyUI SeedVR2 | ComfyUI SeedVR2 |
| stt / enhance / stems | mlx-audio (Whisper/Parakeet, MossFormer2/DFN3), demucs-mlx | faster-whisper, DFN3 (ORT), demucs (torch) |
| music / sfx | ComfyUI (ACE-Step 1.5, Stable Audio 3) | ComfyUI |
| i2v / extend / interpolate | ComfyUI (LTX-2.5, Wan2.2-5B, VACE-1.3B, RIFE) | ComfyUI |
| trim / arrange / export | WebCodecs + Mediabunny (VideoToolbox) | WebCodecs + Mediabunny (H.264 on Linux to verify; VP9/WebM fallback) |

`op-router.ts` is a pure function of (host, installed modules, licence policy) → an ordered list,
unit-tested the way `engine-catalog.test.ts` tests `enginesFor`.

### 4.10 Relationship with the chat

- Chat keeps `generate_image` / `edit_image` / `generate_video` / `generate_audio` / `generate_3d`
  and inline cards (R2).
- `MediaCard` "Open in studio" creates an editor document. The expanded viewer (`ExpandedScrim`)
  gains the same five-tool strip on its left edge (the user's queued bar); choosing a tool opens the
  Image editor with that tool active on that picture — one editor, not a second one in the
  viewer.
- Later (CHAT-01): `edit_image` gains optional `region` (x,y) / `mask_path` / `op` parameters
  backed by the same `editor-manager` ops, rather than new tools (each advertised tool costs
  prompt prefix; memory `pi-desktop-prompt-prefix-cost`).

### 4.11 Alternatives considered

| Alternative | Why not |
|---|---|
| Keep the chat-shaped studios and add edit buttons to result cards | Contradicts R1; there would be no single document, no layers, and no place for pins to live. |
| One "do-everything" model (Qwen-Image 2.1 marks, masks and references) | NC licence; not runnable in MLX today; ComfyUI's route costs ≈15 GB on 24 GB. It stays an optional engine behind the same ops. |
| Embed the ComfyUI frontend, or expose graphs | The opposite of "very simple"; the user already rejected knob walls in the studios. |
| Embed a web editor (Photopea, miniPaint) | Licensing and branding; still needs our model integration; not the app's design language. |
| ML in the renderer (transformers.js, onnxruntime-web) | The CSP forbids WASM; it would be a second runtime per platform; the big encoders are slow in browsers. |
| Bundle ffmpeg | 50–80 MB per platform, GPL/LGPL build choices, and not needed now that WebCodecs + Mediabunny cover trim and export. Keep as a Linux fallback question for track 4. |
| The MLX SAM ports (`mlx-sam`, `mlx_sam3`) | Python ≥ 3.14 or no/unclear licence (checked); the Core ML SAM 2.1 (Apache) and ORT exports cover the need. |
| MLX-Swift helpers (Mage-Flow, BiRefNet, EdgeTAM ports exist) | Building MLX-Swift needs the Metal compiler (full Xcode), which this machine and the CLT build do not have. |
| Rely on the model not to touch pixels outside the pin (ChatGPT's approach) | Drift is documented even there; the stitch makes it a guarantee at almost no cost. |

---

## 5. Work packages

Sizes: **S** ≤ 1 day · **M** 1–3 days · **L** 3–7 days · **XL** > 1 week (one agent). Every UI
package ends with screenshots in light and dark that were looked at, per the visual-verification
rule. Every probe uses `apps/desktop/tests/e2e/harness.mjs launchApp` (hidden window, focus guard,
throwaway HOME) and never writes the shared `~/.pi/desktop/settings.json`. Real-model probes run on
AC power, one heavy thing at a time, with `realCache`, the guardian on, `PI_E2E_NO_SERVER=1`
(no chat model), and a 30%-free watchdog.

### Summary

| id | title | size | depends on |
|---|---|---|---|
| SPK-01 | Measure the edit engines on the 24 GB Mac | M | — |
| SPK-02 | Mage-Flow source + Qwen-Image 2.1 edit-port feasibility | S | — |
| ED-01 | Editor documents on disk + `editor:*` IPC + doc store | M | — |
| ED-02 | EditorFrame (rail, floating panels, contextual bar, top-bar chip, Send To, Export) | L | ED-01 |
| ED-03 | Shared version tree + History rail (generalised from 3D) | M | ED-01 |
| ED-04 | Op router + editor-manager on the existing queue/guardian/modules | L | ED-01 |
| ED-05 | Stitcher: crop, feather, colour match, composite (main, nativeImage) | M | — |
| TOOLS-01 | "Editing tools" module: onnxruntime worker (SAM 2.1, BiRefNet, LaMa, DFN3) | L | ED-04 |
| MAC-01 | pi-mac `--vision`: instance masks, instance-at-point, OCR | M | — |
| IMG-01 | Image canvas (zoom, pan, overlays, compare, candidates strip) | M | ED-02 |
| IMG-02 | Click-to-comment UI (pins + "Describe changes" pill + queue + states) | M | IMG-01, ED-03 |
| IMG-03 | Region proposals wired (Vision → SAM → disc), cycling, add/subtract | M | IMG-02, TOOLS-01, MAC-01 |
| IMG-04 | Edit engines: klein edit, Fill, SeedVR2 in gen-service; Mage-Flow route; catalog rows | L | SPK-01, ED-04 |
| IMG-05 | Region edit end to end (interpret → crop → engine → stitch → version) | M | IMG-03, IMG-04, ED-05 |
| IMG-06 | Remove BG + background choices | M | TOOLS-01, MAC-01, ED-05 |
| IMG-07 | Erase (tap, brush, lasso) with LaMa and generative fallback | M | TOOLS-01, IMG-03 |
| IMG-08 | Resize / Expand and Upscale | M | IMG-04, ED-05 |
| IMG-09 | Layers: cutout, text, markup; markup → edits; OCR check | L | IMG-01, MAC-01 |
| IMG-10 | Presets framework + Character sheet, Product shot, Sticker, Device mockup | L | IMG-05, IMG-06, IMG-09 |
| IMG-11 | UI-screen preset (LLM HTML → HyperFrames still) | M | IMG-10 |
| IMG-12 | Replace ImageStudio; handoffs; expanded-viewer edit strip; probe migration | M | IMG-02, IMG-06 |
| XP-01 | ComfyUI baseline graphs for every image op (Linux/Windows) | L | ED-04 |
| AUD-01 | Audio timeline core (lanes, clips, trim/split/fade, playback, mixdown, LUFS) | L | ED-02, ED-03 |
| AUD-02 | Speech lanes: script, regenerate words, voices and clones, auto-check | L | AUD-01, AUD-03 |
| AUD-03 | STT with word timestamps + text-based cutting + fillers + SRT | M | AUD-01 |
| AUD-04 | Clean up, stems, isolate | M | AUD-01 |
| AUD-05 | Music/SFX into lanes; ACE-Step 1.5 repaint/extend | L | AUD-01 |
| AUD-06 | Audio comment pins + intent → op; replace AudioStudio | M | AUD-02, AUD-05 |
| VID-01 | Video timeline + monitor + local edits + MP4 export (WebCodecs/Mediabunny) | XL | ED-02, ED-03 |
| VID-02 | Text lane: titles (HyperFrames) + captions (STT) | M | VID-01, AUD-03 |
| VID-03 | Generative clip ops (I2V, extend, first→last, add sound, RIFE, upscale) | XL | VID-01, SPK-01 |
| VID-04 | Frame comments via the image editor; replace VideoStudio | M | VID-01, IMG-05 |
| CHAT-01 | Chat tools on the shared op engine | M | IMG-05 |
| PORT-01 | (optional) Qwen-Image 2.1 editing in the bundled mflux wheel | XL | SPK-02 |

### Details

**SPK-01 · Measure the edit engines on the 24 GB Mac (M)**
- Measure, as the OS free-memory drop under the `measure-lowram.sh` watchdog pattern: klein 4B edit
  (`mflux-generate-flux2-edit`, 1 and 2 references, 768² and 1024², `--low-ram`), Mage-Flow-Edit
  8-bit from the user's library (with and without `--low-ram`), FLUX.1 Fill 4-bit (only if the user opts
  into NC; the weights are gated), SeedVR2-3B at 2× of a 1024² picture, and the ONNX tools (SAM 2.1
  small encoder/decoder, BiRefNet lite/full, LaMa) on CPU vs the CoreML EP.
- Files: `scratchpad/measure/*.sh` plus a results table appended to this doc; no app code.
- Acceptance: each engine has seconds, `residentFloorGB` and `peakResidentGB` measured, and the
  outputs looked at (not just exit 0 — Mage-Flow's 4-bit "succeeds" with noise).
- Verification: the numbers table and a contact sheet of outputs; never with the app's shared
  settings touched.

**SPK-02 · Mage-Flow source + Qwen 2.1 edit feasibility (S)**
- Settle whether `microsoft/Mage-Flow-*` is gated, withdrawn or moved (401 observed 2026-09-23); if
  it is gone, switch `packages/gen3d-engine/src/catalog.ts` `mageflow`/`mageflow-edit` repos to
  `Comfy-Org/Mage-Flow` (ComfyUI layout) or an MLX mirror, and check what that means for the chat's
  `edit_image` on a fresh install.
- Read the diffusers `QwenImage21Pipeline` edit path and ComfyUI `TextEncodeQwenImage21` to size a
  port of reference/mask editing into our wheel (PORT-01).
- Acceptance: a one-page note with the decision, file paths and an estimate.
- Verification: the `hf` download dry run from a fresh `HF_HOME` (small files only).

**ED-01 · Editor documents on disk (M)**
- Create `apps/desktop/electron/editor/{editor-contract.ts, editor-docs.ts, editor-docs.test.ts}`;
  `apps/desktop/src/editor/{doc-store.ts, types.ts}`. Touch `electron/main.ts` (register),
  `electron/ipc-contract.ts` (compose the map), `electron/bobble-paths.ts` (a `STUDIO_DIR`).
- IPC: `editor:docs`, `editor:open` (new, by id, or from a path — copying the file in),
  `editor:save`, `editor:write-version` (base64 PNG or a file path), `editor:reveal`.
- Acceptance: documents round-trip; readable names; fenced to `~/Bobble/studio` (and served over
  `pd-file://` through `allowedWriteRoots`).
- Verification: unit tests (naming, dedupe, serialisation, version ops on a temp root); probe
  `editor-docs-probe.mjs` (create through the seam, relaunch with the same stable probe HOME, the
  document and its thumbnails are back).

**ED-02 · EditorFrame (L)**
- Create `apps/desktop/src/editor/{EditorFrame.tsx, ToolRail.tsx, ContextBar.tsx,
  FloatingPanel.tsx, EditorTopBar.tsx, EngineChip.tsx, editor.css}`; touch `App.tsx`
  (`contentOverride`), `chat/ChatApp.tsx` (the lazy `EditorTopBar` for image/audio/video in place
  of `StudioTopBarControls`).
- Reuse `StudioPicker`/`Segmented` (moved to `editor/controls.tsx` and re-exported for the old
  shell until IMG-12), `ModuleCard`, `PendingMediaCard`/`BobbleLoader`, and the drop veil.
- Acceptance: the canvas fills the content area; the rail, panels and bar float; the top bar shows
  the chip, Send To and Export and no gears; Escape semantics are kept; all states from §4.3
  render.
- Verification: `editor-layout-probe.mjs` (geometry: canvas ⊇ content area, rail left inset,
  panels do not overlap the bar, top-bar buttons present, no `data-testid="studio-advanced-toggle"`),
  screenshots of each state in both themes, looked at.

**ED-03 · Version tree + History rail (M)**
- Create `apps/desktop/src/editor/{version-tree.ts, version-tree.test.ts, HistoryRail.tsx}`
  (from `tripo/HistoryRail.tsx` + `tripo/store.ts` `orderedVersions`/`versionDepth`); the 3D
  studio can adopt it later (question 8).
- Acceptance: hover previews in place, click moves the current pointer, the next op branches,
  ⌘Z/⌘⇧Z walk the history.
- Verification: unit tests (ordering, branching, depth, undo/redo pointer); probe: seed three
  versions, hover → the canvas `src` changes, click → current changes, a new op from an old node
  creates a sibling.

**ED-04 · Op router + editor-manager (L)**
- Create `apps/desktop/electron/editor/{op-router.ts, op-router.test.ts, editor-manager.ts,
  ops.ts}`; touch `electron/gen/gen-manager.ts` (export the queue, admission and note-sink hooks it
  already has, instead of duplicating them), `gen-ipc-contract.ts` only if shared types move.
- IPC: `editor:run` → `{jobId}`, `editor:cancel`, `editor:segment` (fast, synchronous-ish),
  event `editor:job` (status, progress, note, version ids, error).
- Acceptance: every op goes through `JobQueue` admission (footprints from the catalog), module
  gates (`modules.ensure`) and `pausables` registration; the router picks by host, installed
  modules and the licence policy setting; a mock executor seam (`PI_E2E_EDIT_MOCK=1`) returns a
  deterministic recolour so UI probes run without models.
- Verification: unit tests (router ordering per platform, NC excluded when the policy says so,
  admission math); `editor-ops-mock-probe.mjs` drives a region edit through the mock and checks the
  version, the event sequence and the guardian note path (`PI_GUARDIAN_HOLD_FREE` seam).

**ED-05 · Stitcher (M)**
- Create `packages/gen-service/src/stitch.ts` (pure RGBA math: crop box, dilate by distance
  transform, separable-blur feather, Lab mean/std colour match on a ring, composite) + tests;
  `apps/desktop/electron/editor/stitch-io.ts` (nativeImage decode/encode in a `worker_thread`).
- Acceptance: outside the feathered mask the output equals the parent byte for byte; the seam's
  mean ΔE on synthetic tests stays under a set bound; 2048² in < 1 s on the M5.
- Verification: vitest on synthetic images (checkerboards, gradients, tone-shifted edits); a
  golden-image test.

**TOOLS-01 · "Editing tools" module (L)**
- Create `packages/gen-service/python/tools_worker.py` (a `--serve` NDJSON loop copied from
  `worker.py serve_loop`; ops `segment{points, box}` with a per-image embedding cache, `matte`,
  `erase{mask}`, `denoise{audio}`), `test_tools_worker.py`; touch `electron/gen/gen-modules.ts`
  (`GenRuntimeModuleId` gains `tools`, `GEN_MODULE_META` with a size), `gen-modules-main.ts`
  (install = uv env `onnxruntime numpy pillow opencv-python-headless` + the model files),
  `pausables.ts` registration, a supervisor in `electron/editor/tools-supervisor.ts` (lazy start,
  idle stop).
- Models (ungated, permissive): `onnx-community/sam2.1-hiera-small-ONNX` (Apache upstream),
  `onnx-community/BiRefNet_lite-ONNX` + `BiRefNet-ONNX` (MIT), a LaMa ONNX (Apache),
  DeepFilterNet3 ONNX (MIT/Apache).
- Acceptance: a first click after the module is installed returns masks in < 1.5 s (encode) and
  later clicks in < 100 ms (decode, cached); matte and erase return PNGs; the worker survives a bad
  request; the ModuleCard shows the download.
- Verification: pytest with small fixtures and mocked sessions for protocol tests, plus one real
  ORT run on a 256² fixture; `tools-module-probe.mjs` (fresh cache → card → install → segment on a
  fixture photo; masks cover the subject's known bbox ≥ 90%).

**MAC-01 · pi-mac `--vision` (M)**
- Create `packages/pi-mac/swift/Sources/pi-mac/Vision.swift` (`--vision-serve` NDJSON: `lift` →
  instance masks as PNG plus bboxes; `instance-at` a point; `ocr` → lines with boxes); touch
  `main.swift` (dispatch), `Package.swift` (link Vision, CoreML), `packages/pi-mac/src/` (a client
  plus types), `electron/editor/` (a Mac executor).
- Acceptance: the fixture photo's subject is returned as instance 1 with a sensible bbox; the OCR
  of a fixture poster returns its words; no TCC prompt; `.prohibited` activation policy kept (no
  dock tile).
- Verification: vitest for the TS client's JSON contract; a node script that runs the helper on
  fixtures (headless — it never opens a window); the probe's focus guard stays green.

**IMG-01 · Image canvas (M)**
- Create `apps/desktop/src/editor/image/{ImageCanvas.tsx, viewport.ts, viewport.test.ts,
  CandidatesStrip.tsx}`: an `<img>`/canvas under a CSS transform, an SVG overlay layer in image
  coordinates, a transparency checkerboard, hold-`\` compare, and candidates from Takes > 1.
- Acceptance: pins and outlines stay locked to image pixels across zoom and pan; the fit is exact;
  a 4096² picture stays smooth.
- Verification: unit (screen↔image transforms); a probe that zooms and pans, then asserts an
  overlay element's position against the computed transform; screenshots.

**IMG-02 · Click-to-comment UI (M)**
- Create `apps/desktop/src/editor/comments/{CommentLayer.tsx, CommentPin.tsx, CommentPill.tsx,
  comment-state.ts, comment-state.test.ts}`.
- Acceptance: the user's reference exactly — numbered pin, a pill beside it reading "Describe changes"
  with ✓ and ✕; Enter/Esc/⌘Enter; edge flipping; per-pin colour; queued/running/done/failed
  states; Compare, Try again, Undo on done pins; "Apply N changes".
- Verification: unit (the state machine, including queueing and merging overlaps); probe
  `image-comment-probe.mjs` with the mock executor: click → pill → type → ✓ → a new version and a
  resolved pin; two pins queue in order; Esc removes a draft; screenshots of every state in both
  themes and a zoom crop of the pill beside the reference — looked at.

**IMG-03 · Region proposals (M)**
- Wire `editor:segment` to Vision (Mac), then SAM 2.1 (tools module), then ComfyUI SAM3 (when
  neither is present), then the disc; `[`/`]` cycling; ⇧/⌥ refine; the region outline overlay.
- Acceptance: on the fixture photo a tap on the subject selects it on the first try; a tap on sky
  gives a disc; cycling changes the mask area monotonically.
- Verification: probe with fixture pictures and known masks (IoU ≥ 0.8 for the subject tap);
  screenshots of the outline.

**IMG-04 · Edit engines in gen-service (L)**
- Touch `packages/gen-service/src/protocol.ts` (`ImageJobSpec.imagePaths[]`, `maskPath`,
  `upscale{resolution, softness}`, `task: 'edit'|'fill'|'upscale'`), `python/worker.py`
  (`build_mflux_cmd` emits `--image-paths` for `flux2-edit`/`qwen-edit`, `--image-path
  --masked-image-path` for `fill`, the seedvr2 arguments; progress parsing for each), `catalog.ts`
  (rows `flux2-klein-4b-edit`, `flux1-fill-dev` (NC, gated, off by default),
  `seedvr2-3b`, `mage-flow-edit-turbo` routed to the gen3d bridge until the image module carries
  it; a `task` field so pickers list the right rows; measured footprints from SPK-01),
  `worker-command.ts` (the wheel for these commands), `apps/desktop/electron/gen/gen-manager.ts`
  (build these jobs through the same admission).
- Acceptance: each engine produces a correct-sized PNG from a fixture through the app; the NC
  rows are hidden unless the licence policy allows them; guardian admission reads the new rows.
- Verification: `test_worker.py` argv tests per command; vitest for job building; real probe
  `image-edit-ops-real-probe.mjs` (edit a fixture crop, fill a mask, 2× upscale), outputs looked at.

**IMG-05 · Region edit end to end (M)**
- `editor-manager` op `image.region_edit`: interpret (rules, then the enhancer model), crop, run
  (IMG-04), stitch (ED-05), write the version, emit events; the loader cascade plays inside the
  region and reveals along the sweep.
- Acceptance: on real engines, "make the jacket red" on a fixture changes the jacket, and every
  pixel outside the feathered mask is identical to the parent (checked in the probe by diffing the
  PNGs).
- Verification: the real probe diff (outside-mask identity, inside-mask change > threshold);
  before/after screenshots looked at.

**IMG-06 · Remove BG + background choices (M)**
- `image.matte` (Vision → BiRefNet → ComfyUI) and `image.background` (transparent, colour, blur,
  scene with a recomposited cutout and a contact shadow).
- Acceptance: a transparent PNG with a clean edge on the fixture set (people, product, pet); the
  scene keeps the product's original pixels (diffed inside the alpha).
- Verification: probe with fixtures (alpha coverage vs known masks; inside-alpha identity for
  scenes); screenshots on the checkerboard and on scenes.

**IMG-07 · Erase (M)**
- Tap-to-erase (the selected object's mask, dilated), brush and lasso painters, LaMa for small
  masks, generative fill for large.
- Acceptance: a fixture with a known distractor removed with no visible seam at 100%; the brush
  size is in the contextual bar.
- Verification: probe (mask in → output differs only inside the dilated mask); a zoomed screenshot
  looked at.

**IMG-08 · Resize / Expand and Upscale (M)**
- `image.outpaint` (presets; the original re-composited; pins remapped by the transform) and
  `image.upscale` (2×/4K, soft).
- Acceptance: the original pixels are unchanged inside the old frame after Expand; upscale
  dimensions are exact.
- Verification: probe diffs and dimension checks; screenshots.

**IMG-09 · Layers, text, markup, OCR (L)**
- Create `apps/desktop/src/editor/image/layers/*` (cutout, text, markup layers; the Layers
  panel), text rendering to canvas with system fonts, markup tools (pen, arrow, circle, note),
  "Apply markup" (each shape → a region edit), and the OCR check through MAC-01.
- Acceptance: text layers export crisp and exact; markup hides on export unless chosen; OCR
  flags a misspelt generated word on a fixture.
- Verification: unit tests (layer model, flatten order); probe exports and pixel-samples text
  edges; screenshots.

**IMG-10 · Presets framework + four presets (L)**
- Create `apps/desktop/src/editor/presets/{presets.ts, run-preset.ts, sheet-layout.ts (+test)}`;
  the ✦ gallery; the empty-state cards. Presets: Character sheet, Product shot, Sticker, Device
  mockup.
- Acceptance: each preset runs end to end from one input and produces the documented outputs; the
  character sheet's views go to the 3D studio as multi-image input.
- Verification: unit (sheet layout math, preset step validation); a mock-executor probe for
  wiring; one real run per preset, looked at, with the engine times recorded.

**IMG-11 · UI-screen preset (M)**
- The local chat model writes HTML (a strict prompt, like `prompt-enhancer.ts`), rendered by
  `electron/gen/hyperframes-still.ts` to a PNG; comments on it regenerate the HTML region.
- Acceptance: a brief yields a legible screen with real text; a comment changes that part.
- Verification: probe with a stubbed model (fixed HTML) for the render path; a real run looked at.
  Coordinate with track 10 (visual quality) on the design prompts.

**IMG-12 · Replace ImageStudio; handoffs; expanded-viewer strip (M)**
- Swap `ImageStudio` for `ImageEditor` in `App.tsx`; the Generate bar keeps `gen:generate`;
  `MediaCard` "Open in studio" opens a document; `ExpandedScrim` gets the five-tool strip;
  `studio-handoff.ts` accepts images for `'3d'`; delete the old image paths in `StudioShell` only
  when the other two rooms have moved (AUD-06, VID-04).
- Acceptance: every flow in `media-handoff-probe.mjs` and `studio-layout-probe.mjs` still holds or
  is rewritten to the editor's shape; `image-edit-real-probe.mjs` is moved onto the new op.
- Verification: the updated probes plus `studio-visual.mjs` screenshots, looked at.

**XP-01 · ComfyUI baseline graphs (L)**
- Add templates to `packages/gen-service/src/comfy-workflow.ts`: `sam3-point-mask`,
  `birefnet-matte`, `klein-edit-refs`, `mage-flow-edit`, `inpaint-masked` (InpaintModelConditioning
  + DifferentialDiffusion), `outpaint-pad`, `seedvr2-image`; weights lists from ungated sources.
- Acceptance: each op runs with the Mac fast paths disabled (a router override) on the Mac's
  ComfyUI; later on track 4's Linux/Windows hosts.
- Verification: unit tests for graph building (existing `comfy-workflow.test.ts` style); a real
  run of each on the Mac with outputs looked at.

**AUD-01 · Audio timeline core (L)**
- Create `apps/desktop/src/editor/audio/{AudioEditor.tsx, Timeline.tsx, Lane.tsx, Clip.tsx,
  playback.ts, mixdown.ts, wav-encode.ts, loudness.ts, timeline-math.ts}` + tests.
- Acceptance: import, trim, split, fades, gain, mute/solo; the mixdown length and peaks match the
  arrangement; −16/−14 LUFS normalisation within 0.5 LU on test tones.
- Verification: unit tests (timeline math, WAV header/bytes, BS.1770 on reference signals);
  `audio-editor-probe.mjs` with fixture WAVs (arrange → mixdown → decode → assert length and
  segment energies); screenshots.

**AUD-02 · Speech lanes (L)**
- Script view, regenerate selection, voice library and clones (reference clips stored in the
  document), the STT round-trip auto-check with up to two retries.
- Acceptance: regenerating a phrase replaces only that span; a forced mismatch triggers a retry.
- Verification: a mock TTS/STT probe for the logic; a real Qwen3-TTS run looked at and listened
  to (the transcript used as the check).

**AUD-03 · STT and text-based cutting (M)**
- A mlx-audio STT job (Whisper or Parakeet, word timestamps), after measuring the 0.4.5 → 0.5.x
  pin change; delete words → cut; filler removal; SRT/VTT.
- Acceptance: word boundaries within 80 ms on a fixture; deleting a word removes that audio.
- Verification: pytest/vitest for alignment math; a real probe on a fixture recording.

**AUD-04 · Clean up, stems, isolate (M)**
- Enhance (DFN3/MossFormer2), stems (demucs-mlx), isolate (SAM-Audio, opt-in by licence).
- Acceptance: SNR improves on a noisy fixture; stems sum back to the mix within a tolerance.
- Verification: signal tests on fixtures; listened to.

**AUD-05 · Music/SFX into lanes; repaint/extend (L)**
- ACE-Step 1.5 graphs (text2music with BPM/key, repaint a span, extend) plus the existing Stable
  Audio 3 rows.
- Acceptance: a repaint changes only its span (with crossfades); an extension continues in tempo.
- Verification: graph-building unit tests; a real run on the Mac; listened to.

**AUD-06 · Audio comments + replace AudioStudio (M)**
- Pins at a time on the timeline with the same pill; intent → op; `App.tsx` swaps `AudioStudio`.
- Verification: a mock-executor probe for the pin flow; screenshots.

**VID-01 · Video timeline + local edits + export (XL)**
- Create `apps/desktop/src/editor/video/{VideoEditor.tsx, Monitor.tsx, Timeline.tsx,
  compose.ts, export.ts}` on Mediabunny + WebCodecs; add `mediabunny` (MPL-2.0) to
  `apps/desktop/package.json`.
- Acceptance: trim/split/reorder/speed/reframe; export an H.264 MP4 whose duration and frame
  count match the edit; no ffmpeg anywhere.
- Verification: a probe that generates a fixture clip with Mediabunny (a canvas counter), edits
  it, exports, re-reads the export and asserts duration, frame count and that sampled frames show
  the expected counter values; screenshots.

**VID-02 · Titles and captions (M)** — HyperFrames titles as a lane; STT captions (AUD-03);
burned in at export or written as SRT. Verification: probe OCRs (MAC-01) a burned-in caption frame.

**VID-03 · Generative clip ops (XL)** — ComfyUI graphs for LTX-2.5 I2V (`LTXVImgToVideo`),
Wan2.2-5B I2V (after SPK-01 measures it), VACE-1.3B extend, first→last frame, WanMove paths, SFX at
the playhead, RIFE, SeedVR2 video; time estimates shown before starting (the
`tripo/stage-estimates.ts` pattern). Verification: graph unit tests; one real run each on AC power,
the output looked at frame by frame (video-reference-review method).

**VID-04 · Frame comments + replace VideoStudio (M)** — pin at (t, x, y) → the frame opens in the
image editor → comes back as a still or a re-animation start. Verification: a mock-executor probe.

**CHAT-01 · Chat tools on the shared op engine (M)** — `edit_image` gains optional `region`,
`mask_path` and `op` backed by `editor-manager`; `media image remove-bg|upscale|erase` in tool-CLI
mode; measure the prompt-prefix cost before and after (`prefill` rule). Verification: harness
unit tests; the tool-surface probe; prefill numbers logged.

**PORT-01 · Qwen-Image 2.1 editing in our mflux wheel (XL, optional)** — reference images via the
Qwen3-VL vision tokens + reference latents, masks and annotations, rebased on mflux 0.20.0 with the
te8 patch. Only if the user wants NC editing as a default (question 1). Verification: parity against
the diffusers pipeline on a 64 GB machine or published samples; the text benchmark re-run.

Suggested order: SPK-01/02 and ED-01/05/MAC-01 in parallel → ED-02/03/04 → TOOLS-01, IMG-01/02 →
IMG-03/04/05 (the click-to-comment milestone the user asked for) → IMG-06/07/08 → IMG-12 (ship the
Image editor) → IMG-09/10/11, XP-01 → the audio track → the video track → CHAT-01.

---

## 6. Risks, blockers and open questions

### Risks and blockers

1. **Memory on 24 GB.** Mage-Flow-Edit peaks at 14.76 GB at 8-bit (the 4-bit build renders
   noise); klein-edit, FLUX Fill, SeedVR2 and Wan2.2-5B footprints are unmeasured. The editor
   depends on SPK-01 before any catalog row ships. Mitigations: crops ≤ 1024², make-room parking,
   pause/resume, and the ONNX tools kept light.
2. **The Mage-Flow source.** `microsoft/Mage-Flow-*` answered 401 without auth on 2026-09-23. If it
   was withdrawn, fresh installs of the 3D module's Mage-Flow — and the chat's `edit_image` — break;
   `Comfy-Org/Mage-Flow` (MIT) is the likely replacement (SPK-02).
3. **Licences.** The current default picture model (Qwen-Image 2.1) is non-commercial; the best
   fill (FLUX.1 Fill dev) is non-commercial and gated; SAM 3/SAM-Audio use the SAM License;
   RMBG-2.0 and Ideogram 4 are non-commercial (avoided); LTX-2.5 is free only under $10M ARR.
   Permissive defaults exist for every op, so this is a policy choice rather than a blocker.
4. **Qwen-Image 2.1 editing is not runnable on MLX** (mflux 0.20.0 has text-to-image only) and
   costs ≈15 GB through ComfyUI on MPS; it needs PORT-01.
5. **Stitch seams** on edits that need context wider than the crop (relighting, shadows): the
   ⋯ "change the surroundings" escape hatch and the colour match cover most of it; worth watching.
6. **Renderer CSP** forbids WASM: every ML op stays out of the renderer (the design assumes this).
7. **Linux WebCodecs H.264 encoding** is unverified; VP9/WebM or a bundled encoder is the
   fallback (track 4).
8. **Video generation on 24 GB takes minutes per clip** (Wan2.1-1.3B: 835 s for 4 s). The video
   editor has to be worth opening without it.
9. **Probe churn:** `studio-layout-probe`, `studio-visual`, `media-handoff-probe`,
   `image-edit-real-probe`, `pending-look` and `studio-cards-look` assert today's chat-shaped rooms
   and move with IMG-12, AUD-06 and VID-04.
10. **Disk growth** from full-PNG versions (≈6–10 MB each at 2048²): mitigated by History cleanup
    and Manage Storage listing.
11. **Legacy `studio:*` IPC** (`electron/studio/studio-main.ts`, only `studio-probe.mjs` uses it)
    should be removed separately to avoid confusion with `editor:*`.

### Questions for the user

1. **Licence policy:** may the editors default to non-commercial models (Qwen-Image 2.1 marks/masks
   once ported, FLUX Fill) with a "(non-commercial)" label, or must defaults be permissive (klein,
   Mage-Flow, BiRefNet, SAM 2.1, LaMa, SeedVR2) with NC models as opt-ins?
2. **What ✓ does:** apply that pin immediately (queueing behind any running one, ⌘Enter for all) —
   my proposal — or collect pins and apply them together (Krea's single pass)?
3. **Hard regions:** should "nothing outside the pin changes" be the default (stitched), with
   "let it change the surroundings" as the opt-in?
4. **Layers:** is the small set (background, cutouts, text, markup) right for v1, or do you want a
   fuller stack?
5. **Where documents live:** `~/Bobble/studio/<image|audio|video>/<name>/` with readable version
   files — agree?
6. **Video scope:** local timeline editing first (instant, no models) and generation second —
   agree? Is multi-minute video generation on 24 GB expected at all, or only on bigger machines
   and remote devices (track 5)?
7. **SAM 3 / SAM-Audio (SAM License):** acceptable as optional engines?
8. **3D studio:** should it adopt the shared EditorFrame and History rail now, or stay as it is?
9. **UI screens:** rendered from real HTML (crisp, editable, real text; my proposal) or painted by
   the image model?
10. **Chat `edit_image`:** move it onto the shared op engine (same models and stitching as the
    editor) once IMG-05 lands?
