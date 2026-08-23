critical: tool dropdowns not generic code blocks, custom ui for each, just like web search for example currently is. file edits/writes parsed live and open and focus canvas to them, running python/bash opens a terminal in the canvas and shows it there. and another critical thing is latency, thing I found (https://github.com/co-l/cache-hunter)) TTFT and decode speed being minimized as hard as possible and aggresive adaption per hardware to provide a seamless out of the box extremely high performance experience in 90+% of cases for hardware, this includes amd and intel gpus, 

── STATUS (updated 2026-08-20) ──────────────────────────────────────────────
DONE SINCE 08-18: 3D studio finished end to end (texture an existing model,
  CubePart on imports, 1024^3, instant preset motions, geodesic skinning,
  per-stage time estimates, self-provisioning, a fresh Mac gets a button not an
  instruction); model management wave 1 (favourites + configurable quick menu);
  left-sidebar close now slides instead of vanishing.
DONE: rebrand→Bobble + third UI mode (Apple-frosted default); harness swap
  (pi/system-pi/custom + Codex/Hermes/OpenCode connect, real marks); model hub
  rebuilt (Unsloth-style: discover/on-device/datasets, real HF search, model
  cards, quant picker, Recommended=reputable-orgs-by-domain, modality search +
  HF in→out badges, size filter, HF token); onboarding (engine/model/harness);
  settings floating panel + engine install/uninstall; scheduled tasks (headless
  throwaway-session runs, per-task past-runs history with inline artifacts, a
  create_scheduled_task tool usable from any harness).
NEGATIVE RESULTS (settled, do not reopen without new info): unified rapid-mlx+
  DFlash engine (c=1 target unreachable — Qwen3.5-4B is a GatedDeltaNet SSM
  hybrid needing per-position rollback); MLX Metal fp32 ~8e-4 accurate by
  default (root cause of the "clean on Metal, garbage out" family).
NEEDS ATTENTION: corp harness unexercised since 2026-08-06 (all work since has
  been UI) — run a full LocalConvert before leaning on it.

── CURRENT ORDERED PLAN (the user 2026-08-18) ───────────────────────────────────
A. 3D: wire the real ported engines to the studio (TRELLIS/autoremesher/
   SkinTokens/ARDY|HY-Motion) — item 1 below, now the front of the queue.
B. Custom UI per tool call (the `critical:` line): bespoke card per tool like
   web search; file edits open+focus the canvas; bash/python open a canvas
   terminal.
C. Modularity + heaviness audit, surfaced in-app: make Bobble as light or as
   feature-packed as the user wants, and make the COST legible from the start —
   disk size + RAM/compute weight shown BEFORE install for every optional
   component (generation engines + weights, connectors, extensions, inference
   engines), all add/removable.
D. Studio UIs + chat wiring for image / video / audio, the same treatment 3D
   got (item 2 below).
E. Other harnesses as first-class GUI, not TUI (tentative, effort unknown):
   click a connected harness and drive it inside Bobble, parsing its tool
   stream into the per-tool-call UI from step B. Scope-spike first.
F. Usability + out-of-box optimization (last): any generation type at high
   optimization on 99% of hardware (incl. AMD/Intel) with no setup; every
   technical knob available but out of the way; interface-preference options
   (a big one: inline widgets vs canvas for SVG/video/etc. display).
─────────────────────────────────────────────────────────────────────────────

0. third UI mode default, rename the app 'bobble', custom UI style. add to onboarding and settings canvas/inline option for visuals/files and onboarding checking for installed opencode/hermes/pi and offer importing from any (just show options to import from any that are installed).
1. tripo style 3d workspace, trellis generation, autoremesher(Now MIT liscnesed as of last month!!! https://github.com/huxingyi/autoremesher)), auto rigging (https://github.com/VAST-AI-Research/SkinTokens?tab=MIT-1-ov-file), nvidia ARDY for animation generation working
2. 3d/image/video/audio/music baseline generation working and tested, from the chat model should be able to call a tool to generate any of this or call 
3. specailists/workflows eg. vlm see and prompt for edits/regen image + mark and save best, presnet best up to n iterations loops working to be called as tools from regular chat/corp as specialists.
4. cmd+; for screenshot and access the app quick chat from anywhere, configurable keybind
5. computer use UI click through invisible overlay+fake cursor for visual of where the model moves and clicks and acts etc. on any app being used; any app can be used in the background without interrupting the user quickly and efficiently, find optimizations, these are slow processes.
6. cognee memory https://github.com/topoteretes/cognee
7. autonomous fine tuning/specializing models/workflows for given task



links of interest possibly for various purpouses (performance/hardware compatibily/modalities/capability) 

misc
minimax h3 — the user 2026-08-06: people at comfy have got it running on a lot lower end hardware reasonably. worth a look for the "runs well on modest machines" requirement.
https://github.com/co-l/cache-hunter
https://github.com/topoteretes/cognee
https://github.com/headroomlabs-ai/headroom   (Apache-2.0 context compression for agents; python+rust, local-first, library/proxy/MCP. 60-95% fewer tokens on JSON, ~20% on coding agents; content-aware — SmartCrusher for JSON, AST for code, Kompress-v2-base for text; reversible via cached-content retrieval. NOTE: its "live-zone compression preserves prompt cache hits" is directly relevant to our prefix-caching work)

APPLE SILICON / MLX PORTS — we are on PyTorch MPS everywhere; MLX is typically 3-5x faster
https://github.com/pedronaugusto/trellis2-apple            (TRELLIS.2 MLX backend + Metal mesh postproc — vs our current shivampkumar/trellis-mac, which is MPS)
https://huggingface.co/mlx-community/SkinTokens-bf16       (SkinTokens on Apple Silicon, 1.68GB bf16 — CONTRADICTS the "CUDA-only" finding; outputs a VRoid bone template, not ARDY cskel27)
https://huggingface.co/AgenticVibes/hunyuan3d-2.1-mlx      (MLX texture gen, reports ~3-5x faster UNet than PyTorch MPS)
https://github.com/Tencent-Hunyuan/HY-Motion-1.0           (text-to-3D-human-motion, open source — the ARDY alternative; ARDY is Ubuntu+NVIDIA only)

audio
https://github.com/pwilkin/thinksound.cpp
https://github.com/QwenLM/Qwen3-TTS   (the user 2026-08-06: natively merged into llama.cpp as of ~today — so TTS may come free through the llama-server path we already run, no separate engine)

3d
https://github.com/VAST-AI-Research/SkinTokens?tab=MIT-1-ov-file
https://github.com/IgorAherne/TRELLIS.2-stableprojectorz

image
https://huggingface.co/krea/Krea-2-Turbo
https://huggingface.co/microsoft/Mage-Flow-Edit
https://huggingface.co/microsoft/Mage-Flow-Turbo
https://huggingface.co/microsoft/Mage-Flow

video
https://huggingface.co/Lightricks/LTX-2.3


text
https://huggingface.co/nvidia/Nemotron-Labs-Diffusion-VLM-8B
https://huggingface.co/microsoft/Fara1.5-4B

## Queued — assessed 2026-08-19

### 1. Model management: favourites + a configurable quick menu — **DONE 2026-08-20**
The footer already has a tier dropdown (`footer-models.ts`, fast / balanced /
intelligent, with USER mode leading on the tier label and POWER mode leading on
the model name). What is missing is that it is not the user's:

- **Favourites** — pin models so they lead the menu regardless of tier.
- **Configurable tiers** — choose which model each slot maps to, rename slots,
  add slots. Names are model names, per the user; no invented marketing words.
- **"More models"** — reveals a search box once the list is long enough to need
  one, plus every downloaded model, **largest first**, with its org icon and
  name. Largest-first is the right sort because size is the thing the user is
  trading against: it reads as a capability ladder.
- Org icons already exist (`settings/brand-svg.ts` + `brand-svg-extra.ts`), so
  this is assembly rather than new artwork.

Assessment: worth doing and well-scoped — the pieces (tiers, icons, the
downloaded-model list) all exist and are not joined up. The one design call is
that a renamed slot must keep pointing at a real model id, so the rename is a
label over a binding, never a replacement for it.

BUILT (`chat/quick-menu.ts`, `TierPickerMenu.tsx`, `QuickMenuPanel.tsx`): all
four bullets, with the binding rule held. Two bugs the build surfaced and fixed:
the menu was still rendering the OLD fixed tiers so renames never appeared, and
a rename following a favourite clobbered it (a stale config captured in a popup
closure — the apply path now reads the store at apply time).

### 2. Models to add: LFM 2.5–2.6B, Qwen3 8B–27B at Q3 — **NEXT**
Assessment: catalogue work, cheap, and it belongs AFTER (1) — the point of new
models is choosing between them, and the choosing is what (1) builds. Qwen3 at
Q3 is the interesting one on 24 GB: it is the largest thing that fits with a
real context window, so it wants the fit-verdict maths already in
`model-manager-logic.ts` rather than a hand-written size note.

### 2b. DFlash 2 — an UPDATE to DFlash, not a model (the user's correction)
I had this filed as a model to add; it is not one. DFlash is a speculative
decoding METHOD, already modelled as one: `SpecMethod = 'mtp' | 'eagle3' |
'dflash'`, with per-model `SpecVariant`s carrying a `draftRepo`, and llama.cpp
takes it as `--spec-type draft-dflash`. So DFlash 2 is a version bump on that
path — new draft repos and whatever the flag becomes — and lands in
`packages/inference/src/catalog.ts` beside the existing variants, NOT in the
model list. Worth checking at the same time whether the variant picker should
name the version, since a model carrying DFlash 1 and one carrying DFlash 2 are
different speed characteristics under one label.

### 3. ninfer / ninfer3090 when exactly one 3090 or 5090 is present
Assessment: **do the generalisable half, skip the specific half for now.** A
single-GPU NVIDIA fast path is real work aimed at hardware this app does not
otherwise target, and `perf-args.ts` already notes that nvidia-smi / rocm-smi
probing does not exist yet. the user's own instinct is the valuable part: if a piece
of hardware-specific work can be done once and pay off across every Apple
Silicon Mac, do it that way. The Apple-Silicon-shaped version of this is (4).

### 4. High vs low power mode — **brainstorm written, not built**
See "Power modes" below. Directly reachable today: the 3D workers already
demonstrate every mechanism it needs (per-step model residency, an allocator cap
that can be lifted or lowered, encode budgets that scale with RAM).

### 5. 3D studio — **DONE 2026-08-19/20**, with the boundaries recorded
Texture-an-existing-model, CubePart on imports, 1024, instant preset motions,
geodesic skinning, per-stage time estimates and self-provisioning all landed.
The known boundaries, stated rather than hidden: six preset poses fall back to
generating because they shard at full swing; the reference `o_voxel` bake is
opt-in because its GLB maps as static in our viewer; ARDY's download stays
excluded by request.

## Optimal out of the box — the picker and the recommender (the user 2026-08-23)

the user: "this is paramount to the whole out of the box experience on any users
machine, this is paramount to the whole backend idea of this app out of the box
optimized, you get 99% of the way there on 99% of models on 99% of hardware to a
person who knows how to do their stuff and manually configures stuff for maximum
performance… this is the core of the entire idea."

**Four pieces, each of which is useless without the ones under it:**

1. **`packages/inference/src/accelerator.ts`** — real detection on every
   platform: OS, arch, GPU vendor/name, VRAM, CUDA compute capability, NPU,
   unified-vs-dedicated memory. Every probe is best-effort; a box with no
   nvidia-smi, no wmic and no lspci still answers. `usableMemoryGB` is the
   number everything above turns on, and it is VRAM on a discrete card and 75%
   of system RAM on unified memory — conflating those is the most common way a
   recommender promises something that OOMs.

2. **`settings/engine-catalog.ts`** — 15 engines with the axes a decision needs:
   platforms, GPU vendors, min CUDA generation, NPU, WEIGHT FORMATS, modality,
   rank, and `wired` (have we integrated it). Text: llama.cpp, ik_llama.cpp,
   rapid-mlx, DFlash, vLLM, SGLang, TensorRT-LLM, ExLlamaV3, Lemonade,
   ONNX Runtime GenAI. Image/video: ComfyUI, stable-diffusion.cpp, Nunchaku,
   mflux, Draw Things.

3. **`settings/engine-picker.ts`** — for ANY model, the best engine this machine
   can run it with. Three hard gates then one preference, and the order is the
   design: can it load the FILE, does it make this KIND of thing, does the
   HARDWARE exist, and only then which is fastest. Every rejection carries its
   reason in words ("needs RTX 20-series or newer", "does not load gguf
   weights"). `best` is always something we can drive; `bestPossible` says what
   we are leaving on the table, so the wiring gap is visible rather than hidden.

4. **`models/model-recommender.ts` + `quant-ladder.ts`** — per modality, the
   model AND the quant. the user's rules, encoded and tested:
   - Qwen3.8 27B first whenever it fits (independently #1 on Artificial
     Analysis among open weights, intelligence 52 vs MiniMax-M3's 45).
   - **The floor: never below IQ3_XS under 100B.** When it is hit the
     recommender steps down a MODEL SIZE, not another quant — a 27B at Q2 is
     worse than a 9B at Q5 on every axis anyone notices, and slower.
   - Diffusion gets a HIGHER floor (Q4_K_M): a language model degrades legibly,
     a diffusion model at too few bits produces artefacts that read as a broken
     app. Evidence: ComfyUI-GGUF's own note that DiTs tolerate quantisation
     where UNets do not.
   - Mage Flow leads images (few-step, and the advantage grows as the machine
     slows); LTX leads video over MiniMax-H3 (same quality to the eye, much
     faster); TRELLIS leads 3D because it is what our studio actually runs.

**Surfaced now** as "Best for your machine" at the top of Recommended: one card
per modality with the exact variant, the quant, the memory against what this
machine has, the reason, and the engine that will run it. MEASURED end to end on
this machine: "Apple M5 Pro · 18 GB to work with" → Qwen3.8 27B at Q3_K_M on
llama.cpp, Mage Flow Turbo int8 on mflux, LTX 2B Q4 on ComfyUI, Kokoro, TRELLIS.2.

**`recommendation-matrix.test.ts` prints the whole table** — every machine class
against every modality. It is not an assertion; it is how three real bugs
surfaced that no unit test caught. Keep it: the cheapest way to audit a pile of
judgement calls is to look at all of them at once.

**Still to do:** the picker is not yet consulted at RUN time (the chat still
starts llama.cpp directly), and the unwired engines are catalogued rather than
integrated — ExLlamaV3 and Nunchaku both outrank what we have on an NVIDIA box.

## Engines are a MATRIX, not a ranking (the user 2026-08-21)

the user, correcting a Mac-shaped answer of mine: "this thing about targeting an m5
is not correct. remember we're working on this mac, but we target all major OS
and all major hardware eventually in a modular fashion such that we have a
boatload of alternatives that we know of and can get working quick to get max
out of the box no setup fast inference for any* hardware on any OS."

**The correction, and why it matters more than a wording fix.** I had ranked
engines by how fast they are on the machine in front of me. That produces
recommendations that are meaningless one platform over — "use Draw Things for
images" has no answer on a Windows box with an Intel GPU. The right question is
never "which engine is best" but "**which engines can serve THIS modality on
THIS host, in order**", and that is a matrix with a guaranteed last element.

**Now data rather than prose** (`settings/engine-catalog.ts`): every engine
declares its `modalities` alongside its `platforms`, one per modality is marked
`baseline`, and `enginesFor(modality, host)` returns the ordered list.
`preferredEngine` takes the head, `baselineEngine` the portable one. Tests pin
the invariants that a Mac-only session would never notice breaking: every
platform has a text, image and video engine; every (platform, modality) cell
keeps a baseline; an Intel Mac is never offered an Apple-Silicon engine.

**THE BASELINE IS NEVER DROPPED**, even where something faster is installed. A
fast path is an optimisation over something that already works — if the only
engine for a modality is a fast path, the modality is unsupported on every
machine that path was not written for. ComfyUI is that baseline for
image/video/audio precisely because it is portable (CUDA, ROCm, Intel, MPS,
CPU), not because it is quick; llama.cpp is it for text for the same reason.

**The shape to fill in:**

| modality | portable baseline | fast paths, where they exist |
|---|---|---|
| text | llama.cpp (all) | rapid-mlx / DFlash (Apple Silicon), vLLM (Linux+CUDA), Lemonade (AMD NPU) |
| image | ComfyUI (all) | mflux/MLX (Apple, MEASURED 71s→11s), Draw Things (Apple, GPL-3 like us), TensorRT/SDNext (CUDA) — none wired |
| video | ComfyUI (all) | Draw Things (Apple), MiniMax-H3 MLX port (Apache-2.0) — none wired |
| audio | ComfyUI (all) | mlx-audio (Apple) — partly wired via gen3d |
| 3d | our gen3d stack | — |

**3D is closer to portable than it looks, and the direction of the work is why.**
Everything upstream was CUDA-first; almost all our Mac work REMOVED a CUDA
assumption rather than adding a Mac one — SDPA instead of flash-attn,
`SPARSE_CONV_BACKEND=pytorch` instead of the CUDA sparse kernel, a CPU build of
o_voxel's `_C`, ARDY needing no patches at all (two call-site device decisions).
Those paths still work on CUDA, and CUDA gets the faster upstream versions back.
The SkinTokens shims are COPIED IN rather than patched over, so a CUDA install
simply does not copy them. `workers/_device.py` now answers "which accelerator"
in one place (cuda → mps → cpu) instead of each worker hardcoding `mps`.

The ONE genuine gap: the text→image hop is mflux/MLX, which is Apple-only. On
CUDA that needs the ComfyUI path — which is the argument for the baseline again.

## Perceived speed — instant window, snappy UI (the user 2026-08-21)

the user: "because this runs locally we want users to feel absolutely instant
startup and general UI snappiness (especially when it doesn't actually matter to
the end user whether the functionality was as snappy as the UI suggested — such
as the app window immediately showing up is infinitely better than a slow 10
second load, even if the initial prompt typed in and submitted rapidly takes an
extra few seconds)."

**The principle, stated so it can be applied rather than admired:** the user's
clock starts when they click, not when we are ready. Every second before the
window paints is a second they spend wondering whether the click registered;
every second after it paints, while they are reading and typing, is free. So the
work moves BEHIND the first paint, not before it.

**What that means concretely here, roughly in order of payoff:**

- **Paint the window before anything else exists.** The shell — sidebar, top
  bar, empty composer — depends on nothing but settings. Model catalog, hardware
  probe, HF token, chat list, engine status can all arrive afterwards into a
  window that is already up and typeable.
- **The composer accepts input before the engine is ready.** Typing and submit
  are the two things that must never wait; a queued first message that takes an
  extra two seconds to answer is invisible next to a window that took ten
  seconds to appear. We already queue mid-turn sends, so the mechanism exists.
- **Nothing on the boot path may be synchronous I/O.** Every `readFileSync` and
  every `await` before `show()` is a frame the user does not get.
- **Optimistic UI on anything local and reversible.** A chat rename, a pin, a
  favourite, a project move: apply it, persist behind it, reconcile if the write
  fails. These cannot fail in a way the user can act on anyway.
- **Measure it like the TTFT work.** The existing probes time first token; the
  equivalent here is click → first paint → first typeable frame, sampled the way
  `ttft-probe.mjs` samples generation. An unmeasured "feels faster" is how this
  kind of work quietly regresses.

Related and already done: preemptive system-prompt warmup (MEASURED ~20× on
turn-1 TTFT), and the sidebar/canvas slide work — the same instinct applied to
one animation.

## Power modes — brainstorm (not built)

the user: run everything slower and lighter so the fans stay off and the machine
stays usable — for long unattended work (a corp harness run, a 3D generation)
where wall-clock does not matter but being blocked does.

**The framing that makes this tractable:** it is not a "slow mode", it is
*pretending to be a smaller machine*. Every knob we would need already exists,
because we already have to behave well on an 8 GB Air — Low Power is simply
choosing those settings on a machine that did not force them.

**Knobs we already own, and what each buys:**

| Knob | Where it lives now | Effect |
|---|---|---|
| Model residency per step | `low_vram` in the TRELLIS pipelines | Peak memory drops to one model instead of the set; costs shuttling time |
| Allocator ceiling | `PYTORCH_MPS_HIGH_WATERMARK_RATIO` | We raise it to let big jobs finish; LOWERING it caps a job's footprint so the rest of the machine keeps its pages |
| Encode/bake budgets | `ENCODE_FACE_BUDGET`, `BAKE_FACE_BUDGET`, `encode_voxel_budget()` | Already scale with RAM — Low Power just feeds them a smaller number than the machine has |
| Resolution | 512 vs 1024 | The single biggest lever; 512 is ~2.3x faster and a fraction of the memory |
| llama-server slots + KV | `perf-args.ts` | Fewer slots and a smaller context = less resident memory, less bandwidth |
| Process concurrency | the job runner | Serialising stages keeps one core group busy instead of all of them |

**The part that is NOT just settings, and is the actual product idea:** thermals
are about *sustained* draw, not peak. A job that runs at 60% for twenty minutes
can be quieter than one that runs at 100% for eight, and the user cannot tell
the difference if they are not watching. So the honest control is not a slider
labelled "slow" but a **duty cycle** — do a chunk of work, yield, do the next —
which the stage-per-subprocess architecture already makes possible: the runner
can simply wait between stages. That also gives a natural place to hand the
machine back for interactive use.

**What I would want to measure before building it:** wall-clock and peak memory
for one 1024 generation at three settings (as-is, low_vram everywhere, low_vram
plus a duty cycle), and fan RPM or `powermetrics` package power alongside. The
claim to test is "quiet and finishes" versus "quiet and never finishes" — if the
duty-cycled run takes 4x, that is a different product than the one the user
described, and worth knowing before shipping a toggle.

**Where the toggle belongs:** next to the effort slider, not buried in settings,
because it is the same kind of decision — how much of the machine this work is
allowed to have. And it should be per-run overridable, since "leave it going
overnight" and "I need this now" are the same user an hour apart.

## Dropped / stale from the founding prompt (the user, 2026-08-19)

- **Per-task classifier — DROPPED.** The original brief opened every task with a
  classifier labelling it simple-QA / basic-tools / full-shebang and preloading
  tool sets from that. Not doing it. Tool search plus the semantic preload
  already put the likely tools in reach without a gate that can be wrong, and a
  misclassification is worse than no classification: it withholds capability at
  the exact moment the model needed it.
- **The model list in the founding prompt is STALE.** Qwen3.6-27b/35b-a3b,
  Gemma4, LTX-2.3, TRELLIS-2, Hunyuan3D Omni, Hunyuan Motion/World, Hyperframes,
  LiveEdit were the state of the art when it was written; almost all have newer
  versions now. Treat those names as *the shape of the intent* — a strong
  general model, an audio-native small one, a video model, a 3D model — and
  resolve the actual version at the time the work is done, not from that list.
