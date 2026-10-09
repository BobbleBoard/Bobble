# Cross-platform: Linux + Windows, AMD / NVIDIA / Intel GPU + CPU

Research doc for track 4 of the 2026-09-23 push. Written 2026-09-23 against base commit `c9fe7098`.
No code was changed. External facts carry links. Codebase facts carry `file:line`. Everything
marked **MEASURED** was read today from a primary artefact (a GitHub release API response, a
downloaded llama.cpp tarball, a PyPI index, or this repo).

---

## 0. The short version

- **The app cannot run off macOS today, and the reason is not the big features.** It is a few
  mechanical things that fail on the first launch:
  - `uv` and llama.cpp are pinned to their macOS-arm64 assets only (`packages/web-tools/src/uv.ts:32`, `packages/inference/src/llamacpp-manifest.ts:46-53`).
  - Four tool bridges listen on Unix-domain sockets that Windows `net` cannot open (§2.4 A7).
  - Every venv path is spelled `bin/python`.
  - The window has no close/min/max buttons on Windows or Linux (`titleBarStyle: 'hiddenInset'` and no `titleBarOverlay`).
  - The pi harness needs bash, and Windows has none (pi throws "No bash shell found").
- **A latent bug would stop every generation on Linux and Windows.** `startGuardian`
  (`apps/desktop/electron/gen/guardian-main.ts:126,137`) feeds `samplePressure` `free: 0` and a
  `readFile` that always returns null. Off macOS, `samplePressure` falls back to
  `verdictFromFree(0, total)`, which answers `'critical'`. `judge()` (`packages/inference/src/guardian.ts:208`)
  then sheds. The fix is small (XP-01) and it must land before anyone tries a generation on a PC.
- **Upstream already did most of the engine work.** llama.cpp now ships per-backend builds for every platform and GPU vendor, with sha256 digests in the releases API:
  - Linux and Windows: CPU, Vulkan, CUDA 12, CUDA 13, ROCm 10, SYCL and OpenVINO.
  - Linux arm64 also gets Vulkan and CUDA 13, and Windows arm64 gets CPU, CUDA 13 and Adreno OpenCL.
  - **MEASURED**: `b11149` has 35 assets.
  - Those builds pick the right CPU code path at runtime from 14 CPU variants, so there is nothing to choose for AVX2 vs AVX-512.
  - The build also has `--list-devices`, `--device` and `--fit`, which sizes GPU offload automatically.

  The design is therefore "detect, fetch the right flavour, probe it, and let Calibrate pick"
  (§4.4–4.6). We do not build anything ourselves.
- **Computer use gets a new helper per OS.** The Node side and the NDJSON protocol stay (§4.9):
  - The pi-mac protocol (`packages/mac-computer-use/src/protocol.ts`) is already platform-neutral in shape.
  - Windows = Rust + UI Automation + Windows.Graphics.Capture.
  - Linux = Rust + AT-SPI2 + the xdg RemoteDesktop portal (libei).
  - The "never steal focus" promise holds on Windows only through UIA's semantic actions. On
    Wayland it cannot be kept for pointer input, and a global phantom-cursor overlay is impossible
    there.
- **Several things have no equivalent and need a substitute on PCs** (§4.10):
  - mflux, mlx-audio, parakeet-mlx, the MLX 3D sidecar, the MLX engines, AFM, the mac connectors and Spotlight.
  - The portable substitutes are ComfyUI (with `uv --torch-backend=auto`), sherpa-onnx, and ComfyUI's native TRELLIS.2.
- **Testing without owning the machines is possible.** It is layered:
  - Fixture tests and fake-host UI screenshots run on this Mac.
  - The free GitHub Linux and Windows runners (x64 and arm64) cover CPU and Vulkan-on-lavapipe engine smoke and the app e2e tests.
  - Real GPU lanes need self-hosted machines, which fits the Tailscale Devices track.

---

## 1. Goal

The user, verbatim: *"total linux and windows amd nvidia intel gpu and cpu compatibility including
computer use, specialized inference engines and OS compatibility, detection and working
calibration."*

Restated as checkable outcomes:

1. **OS compatibility.** Bobble installs, updates and runs on:
   - Windows 11 (and Windows 10 22H2 if the user wants it — Q1), x64 and arm64.
   - Mainstream desktop Linux: Ubuntu 22.04+ / Debian 12+ / Fedora / Arch, on X11 and Wayland.

   "Runs" includes the chat, the harness (tool CLI, subagents, corp), the canvas and browser,
   studios, downloads, storage, the guardian and power policy, and packaging.
2. **Hardware detection.** Every CPU, GPU and NPU of NVIDIA, AMD and Intel (plus Qualcomm on
   Windows-on-ARM) is found with vendor, name, dedicated or unified memory, driver version and
   compute capability or gfx target. Detection needs no admin rights and no pre-installed vendor
   tools, and it degrades to "CPU with this much RAM" instead of failing.
3. **Engines per vendor, one click.** llama.cpp in the right backend flavour for the machine is
   automatic. The specialized engines each platform deserves (vLLM, ExLlamaV3, Lemonade/NPU,
   OpenVINO, …) are one-click, with honest reasons when unsupported. The same holds for the
   generation stack (ComfyUI on CUDA / ROCm / XPU / CPU).
4. **Working calibration.** Calibrate measures every runnable (engine × backend flavour × speculative
   method) on the actual device, persists the verdict per hardware, and launches with it — as it
   already does for the MLX engines on the Mac.
5. **Computer use** on Windows and Linux, with the same tools, the same safety policy and the
   background-first behaviour wherever the OS allows it, plus clear degraded modes where it does not.

---

## 2. What exists today

### 2.1 Already portable, or close to it

- The **renderer** (React/Vite) and most of **Electron main**. pi runs as an `ELECTRON_RUN_AS_NODE`
  child with extensions loaded from TS source (`apps/desktop/electron/pi/pi-main.ts`).
- The **in-app browser** (WebContentsView + `packages/browser-use`). Only its bridge socket is Unix-only (A7 below).
- **Downloads** (`packages/inference/src/download.ts`, fetch + sha256) and the **model library** layout (`~/Bobble/Models`). Only the links need fixing (A14).
- **ComfyUI engine, graphs and job queue** (`packages/gen-service`, `apps/desktop/electron/gen/*`). ComfyUI itself is the portable
  baseline for image, video and audio. Only its torch install and launch flags are Mac-tuned (B-rows).
- **OmniSVG** (llama.cpp `/completion`) and the **office pipeline** (python-pptx/docx/openpyxl), except fonts (B-row).
- **Detection groundwork.** `packages/inference/src/accelerator.ts` already has pure parsers for:
  - `nvidia-smi` (`parseNvidiaSmi`), Windows `Win32_VideoController` CSV, `lspci -mm`, and macOS `system_profiler`;
  - `usableMemoryGB` (VRAM on discrete, 75% of RAM on unified);
  - `rankGpus`.
- **Pressure parsers.** `packages/inference/src/pressure.ts` has Linux PSI (`/proc/pressure/memory`),
  `/proc/meminfo`, `/proc/vmstat` and battery, plus `nvidia-smi` utilisation and VRAM.
  `power-manager.ts:classifyBottleneck` knows `unified | discrete | cpu`.
- **The engine catalogue is already a matrix.** `apps/desktop/src/settings/engine-catalog.ts` has
  platform × vendor × format × modality axes, `wired`, `baseline`, `requiresGpu`, `minCudaMajor`, and
  `enginesFor / preferredEngine / baselineEngine / recommendedEngine / defaultEngineSet`.
  `apps/desktop/src/settings/engine-picker.ts` gates by file format, then modality, then hardware, then speed.
- **Cross-platform bits already in place:**
  - `apps/desktop/electron/terminal/pty-manager.ts:86-89` picks `COMSPEC`/PowerShell on Windows.
  - `packages/cluster/src/tailscale.ts:32-38` already lists Linux and Windows Tailscale CLI paths.
  - `packages/gen3d-engine/python/workers/_device.py` answers cuda → mps → cpu.

### 2.2 Hardware detection today

| File | What it does | Gap |
|---|---|---|
| `packages/inference/src/hardware.ts:86-106` | `sysctl` on macOS; `os.totalmem()/cpus()` elsewhere | RAM and CPU only, no GPU. Used for `hardwareKey` and tier sizing. |
| `packages/inference/src/accelerator.ts:247-311` | `nvidia-smi` (non-mac), `system_profiler` (mac), `wmic` (Windows), `lspci -mm` (Linux) | **WMIC is disabled by default on Windows 11 25H2 and removed from 24H2+ with the Aug-2026 update** ([Microsoft](https://support.microsoft.com/en-us/topic/windows-management-instrumentation-command-line-wmic-removal-from-windows-e9e83c7f-4992-477f-ba1d-96f694b8665d), [BleepingComputer](https://www.bleepingcomputer.com/news/microsoft/microsoft-wmic-will-be-removed-after-windows-11-25h2-upgrade/)), so only NVIDIA is found on current Windows. `lspci` is often absent (pciutils) and gives no VRAM. VRAM comes from NVIDIA only. `cudaMajor` stores only the compute-capability *major*: Volta (7.0) vs Turing (7.5) is exactly the CUDA-13 cut, and it is invisible here. AMD APUs (Strix Halo), Intel iGPUs and NVIDIA GB10/Jetson are not modelled as unified memory (`unifiedMemory` heuristic at `:297-299`). No driver version. No NPU on Linux. Multi-GPU is ranked only by vendor order. |
| `packages/inference/src/pressure.ts:334-509` | macOS probes are complete; Linux PSI/meminfo/vmstat/`card0` busy/BAT0; Windows = portable floor only | Windows has no commit-charge or VRAM view except NVIDIA. AMD looks only at `card0`. Intel is not covered. |
| `packages/inference/src/recommender.ts` | tiers by `totalRamGB` | Ignores VRAM and MoE offload. A 64 GB-RAM + 8 GB-GPU PC and a 64 GB Mac get the same pick. |
| `apps/desktop/src/models/model-recommender.ts:56` | uses `usableMemoryGB` | Right idea (VRAM on discrete), but misses llama.cpp's MoE-offload headroom (see `--fit`, §3.1). |
| `packages/inference/src/calibrate.ts:455-462` `hardwareKey` | `platform-arch-chip-RAM` | No GPU, VRAM or driver in the key. A GPU swap or driver change keeps a stale verdict. |
| `apps/desktop/electron/ipc-contract.ts:514-537` `LlmHardware` | one GPU (vendor/name/vramGB/cudaMajor), unified, npu | One GPU only. No driver or device list. `apps/desktop/src/settings/host-gpu.ts` passes only vendor and name. |

### 2.3 Engines and launch today

- **llama.cpp.** `ensureLlamaCpp` (`packages/inference/src/llamacpp-manager.ts:132`) installs
  `PINNED_LLAMACPP.macosArm64` whatever the OS, extracts with `tar -xzf`, and looks for a file
  named exactly `llama-server`. `ensureEngineFor` (`engine-select.ts:94`) reads architectures out
  of `libllama*.dylib` only (`pickLibllama`, `:38`). The fork build (`llamacpp-source-build.ts`)
  hard-codes `-DGGML_METAL=ON` and a POSIX output path.
- **External engines.** `packages/inference/src/engine-launch.ts` builds argv for rapid-mlx,
  dflash-mlx, mlx-dspark, oMLX, mlx-lm and `vllm serve`. Installs live in
  `apps/desktop/electron/inference/engines-main.ts`:
  - The MLX venvs.
  - ComfyUI: GitHub tarball + `uv pip install -r requirements.txt`.
  - vLLM: `uv pip install vllm`, Linux-gated at `:734`.
  - NInfer and NInfer-3090: `git clone` + cmake. Linux only; the Windows zip is pointed at but not handled.
- **Calibration** (`packages/inference/src/calibrate.ts:145-253`):
  - llama.cpp × {none, mtp, eagle3/dflash/dspark if drafters present, ngram} everywhere.
  - The MLX engines on Apple Silicon.
  - `vllm/none` on Linux when installed (and, oddly, only when `mlxPresent === false`, `:247`).
  - No notion of a llama.cpp *backend*.
- **Per-hardware launch args** (`packages/inference/src/perf-args.ts:108-135`): the non-Apple branch adds
  `-fa on` and carries `TODO(vram-probe)`.
- **Default engine sets** (`engine-catalog.ts:553-574`): darwin+AS → the MLX four; linux → vllm +
  NInfer rows; win32 → NInfer-3090. llama.cpp flavours are not a concept.

### 2.4 The macOS-assumption audit

Grep of `apps/desktop/electron`, `apps/desktop/src`, `packages/*`, `tools/`, `scripts/` for
`darwin, osascript, pmset, open -a/-g, Metal, MLX, pi-mac, pi-afm, launchctl, codesign,
/Applications, Library/, hdiutil, sysctl, vm_stat, taskpolicy, mdfind, sips, screencapture,
system_profiler, SIGSTOP, /bin/sh, bin/python, process.env.HOME, ps -axo, .dylib, xattr, keychain,
app.dock, .sock` (tests and vendored code excluded). Counts: `darwin` 38 files, `Metal` 47, `pi-mac`
39, `osascript` 17, `/Applications` 26, `mlx` 82, `mps` 102, … The rows below are the ones that matter,
grouped by what happens on a PC.

**A. Breaks on first run (blockers)**

| # | Location | Assumption | Effect on Windows / Linux | WP |
|---|---|---|---|---|
| A1 | `packages/web-tools/src/uv.ts:30-34` | `PINNED_UV` = `uv-aarch64-apple-darwin.tar.gz`, bin `uv` | Every Python feature (gen modules, ComfyUI, office-gen, vLLM, 3D) runs `ensureUv` → a mac binary. The resolver in `engines-main.ts:193-205` also only knows macOS locations. | XP-04 |
| A2 | `packages/inference/src/llamacpp-manifest.ts:46-53` | Only a `macosArm64` asset | No chat at all. | XP-05 |
| A3 | `llamacpp-manager.ts:95,185` | `tar -xzf`, looks for `llama-server` | Windows assets are `.zip` and the binary is `llama-server.exe`. | XP-05 |
| A4 | `engine-select.ts:38` | `/^libllama\.[0-9.]*dylib$/` | Linux is `libllama.so*` and Windows is `llama.dll`. The architecture check returns "unknown", so variants never retire. | XP-05 |
| A5 | `llamacpp-source-build.ts:74,108-113,248` | `-DGGML_METAL=ON`, brew/xcode hints, `build/bin/llama-server` | Fork builds (K2 Horizon) cannot build on a PC (MSVC output is `build/bin/Release/*.exe`). | XP-05 |
| A6 | `apps/desktop/electron/gen/guardian-main.ts:126,137` | `memory: () => ({ total, free: 0 })`, `readFile: async () => null` | Off macOS, `samplePressure` → `verdictFromFree(0, total)` → `'critical'` → `guardian.ts:208` **sheds every generation** on its first busy reading. | XP-01 |
| A7 | `packages/harness/src/tools/tool-cli-bridge.ts:460`, `packages/mcp-lite/src/bash-cli.ts:379`, `apps/desktop/electron/canvas/browser-agent.ts:386`, `apps/desktop/electron/mac/mac-agent.ts:685` | `path.join(os.tmpdir(), '*.sock')` + `net.listen(path)` | On Windows, Node's local-socket paths must be `\\.\pipe\…`. So the tool CLI, the MCP CLI, the browser tools and the computer-use bridge all fail. | XP-02 |
| A8 | `apps/desktop/electron/inference/engine-paths.ts:40,64-74`, `engines-main.ts:573`, `studio/studio-main.ts:48`, `office/office-gen-env.ts:66`, `gen3d/gen3d-main.ts:163`, `gen/comfy-install.ts:306` | venv `bin/python`, `bin/<cli>` | Windows venvs are `Scripts\python.exe` / `Scripts\<cli>.exe`. | XP-02 |
| A9 | `tool-cli-bridge.ts:115,154,293,344`, `apps/desktop/electron/corp/submit-work.ts:85`, `corp/product-gate.ts:99`, `pi/present-bridge.ts:131` | `#!/bin/sh` shims, `/usr/bin/<cmd>` fall-through, `exec /usr/bin/open`, `/bin/sh`, `sh -lc command -v` | No POSIX shell on Windows. **pi itself** resolves bash via `getShellConfig`: Git Bash in Program Files, then `bash.exe` on PATH, else it throws "No bash shell found" (`node_modules/.pnpm/@mariozechner+pi-coding-agent@0.68.1…/dist/utils/shell.js:47-91`). | XP-13 |
| A10 | all `spawn`/`execFile` sites (zero `windowsHide` hits in the repo) | console children | Every `llama-server.exe` / `python.exe` / `uv.exe` / `powershell` spawn from the GUI **flashes a console window**. That is a focus steal, the exact thing the user rules out. | XP-02 |
| A11 | `apps/desktop/electron/main.ts:319,326` + `window-chrome.ts` | `titleBarStyle: 'hiddenInset'`, `trafficLightPosition`, left gutter for traffic lights | `hiddenInset` is macOS-only. On Windows/Linux `hidden` needs `titleBarOverlay` or the window has **no close/min/max controls** ([Electron](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)). | XP-12 |
| A12 | `apps/desktop/electron/gen/pausables.ts:80,117,154,167`, `inference/llm-main.ts:815`, `packages/gen-service/python/worker.py:274-290` | `ps -axo pid=,ppid=`, `SIGSTOP/SIGCONT` | No `ps` on Windows, and no stop signals (Node's `process.kill` on Windows only terminates). Python's `signal.SIGSTOP` does not exist on Windows, so the pacer raises `AttributeError`. | XP-14 |
| A13 | `apps/desktop/electron/inference/reap-orphans.ts:62-86` | orphan = `ppid === 1` or parent gone; server regex `/bin/<x> serve` | Desktop Linux reparents orphans to `systemd --user` (a live subreaper), so they are never reaped. Windows has no reparenting and uses `\Scripts\` paths. | XP-14 |
| A14 | `apps/desktop/electron/storage/storage-main.ts:92,807`, `storage/library-migration.ts:372,399`, `inference/supervisor-entry.ts:1728` | relative `symlinkSync` for dirs | Windows symlinks need Developer Mode or admin. Directory **junctions** do not, but need absolute targets. | XP-02 |
| A15 | `packages/inference/src/accelerator.ts:277-287` | `wmic` for GPUs and NPU | Removed on current Windows 11 (see §2.2). GPUs other than NVIDIA and all NPUs are invisible. | XP-06 |

**B. A Mac-only implementation (feature missing or degraded on PCs)**

| Area | Location | What is Mac-only | PC path (§) |
|---|---|---|---|
| Computer use | `apps/desktop/electron/mac/*` (7.7k lines), `packages/pi-mac` (Swift, 7.7k lines), `packages/mac-computer-use` | AX tree, CGEvent `postToPid`, SCK capture, NSPanel overlay, `--apps`/icons via NSWorkspace, `open -g -a` (`mac-agent.ts:332`), System Events `osascript` (`:227`), TCC (`window-capture.ts`, `systemPreferences`) | §4.9 |
| User's Chrome | `packages/mac-computer-use/src/chrome.ts:67-72,149,159` | `defaults`, `pgrep`, AppleScript `execute javascript` | §4.9 (extension/CDP) |
| Open-with / reveal | `apps/desktop/electron/canvas/canvas-main.ts:302,478,601,617-628,694-738,909` | `open -a`, `open -b`, `/Applications/*.app` lists | XP-23 |
| Connectors | `packages/mac-connectors/*` (Mail/Calendar/Messages/Contacts/Reminders via osascript + sqlite); `packages/mcp-lite/src/detect-apps.ts:992` scans `/Applications` | hidden off-mac; app inventory per OS | XP-23 |
| File search | `packages/web-tools/src/spotlight.ts:328` (`mdfind`) | refuses off-mac | XP-23 |
| AFM | `apps/desktop/electron/afm/*`, `packages/afm`, `packages/provider-afm` | Apple Foundation Models (gated already) | none (hide) |
| Image gen | `packages/gen-service/src/worker-command.ts` (`mflux`) + gen module `image` | MLX | ComfyUI (§4.10) |
| TTS / dictation | `packages/gen3d-engine/python/workers/audio_worker.py:7-9,52-53` (mlx-audio Qwen3-TTS, parakeet-mlx) via `gen3d/dictation-main.ts` | MLX | sherpa-onnx / ComfyUI (§4.10) |
| 3D | `packages/gen3d-engine/python/engine/envs.py:120,178,403,410,424,443,482,570` (prebuilt `darwin-arm64` wheels, `hdiutil`, `xattr`, `codesign`) | MLX sidecar, Metal wheels | ComfyUI native TRELLIS.2 / Pixal3D (§4.10) |
| MLX engines | `mlx-manager.ts:59`, engine catalog rows | Apple Silicon only | vLLM / ExLlamaV3 / Lemonade (§4.4) |
| ComfyUI launch | `packages/gen-service/src/comfy-supervisor.ts:49,61` | `--force-upcast-attention` and `--fp32-vae` always on (MPS workarounds) | per-vendor flags (XP-17) |
| ComfyUI install | `engines-main.ts:608-650` | `requirements.txt` from the default index | Windows gets **CPU** torch. Linux gets the **CUDA 13** torch even on AMD/Intel boxes (**MEASURED**, PyPI `torch 2.14.0` Linux wheels depend on `cuda-toolkit==13.0.3`; the Windows wheel is 124 MB CPU-only). → `--torch-backend=auto` (XP-17) |
| vLLM install | `engines-main.ts:737` | plain `uv pip install vllm` | **MEASURED** `vllm 0.30.0`: manylinux x86_64/aarch64 only, `torch==2.13.0`, cu13 deps. Needs driver ≥ 580 and cc ≥ 7.5, has no ROCm, no Windows. (XP-24) |
| Priority | `inference/process-priority.ts:69-87,112-121` | `taskpolicy`; `renice`; Windows `'unsupported'` | Node `os.setPriority` maps to `BELOW_NORMAL_PRIORITY_CLASS` on Windows ([Node docs via GfG](https://www.geeksforgeeks.org/node-js/node-js-os-setpriority-method/)) (XP-02) |
| Pressure | `pressure.ts:426-439` `pmset`; `guardian-main.ts` | macOS verdict/level/free-pages | per-OS pressure + VRAM (XP-15) |
| Perf args | `perf-args.ts:108-135` | `TODO(vram-probe)` | `--fit`/`--device` (XP-08) |
| Process-group kill | `packages/web-tools/src/python.ts:99`, `packages/mac-connectors/src/exec.ts:91` | `process.kill(-pid)` | No process groups on Windows → `taskkill /T /F` or a Job Object (XP-02/XP-14) |
| Office fonts | `tools/office-gen/textfit.py:29-34` | `/System/Library/Fonts/*.ttc` | Falls back to `ImageFont.load_default()`, so line-wrapping measurements are wrong and text overlaps (XP-16) |
| Prompts | `packages/harness/src/prompt/capability-prompt.ts:157`; the `open` wrapper in `tool-cli-bridge.ts` checks `/Applications/$target.app` | "NATIVE macOS app", `/usr/bin/open` | OS-aware prompt lines (XP-13) |
| Support dirs | `packages/inference/src/paths.ts:27` `~/.cache/bobble`; `.metadata_never_index` | XDG / `%LOCALAPPDATA%` conventions | XP-02 (with env override kept) |
| Background mode | `main.ts:123-126` `setActivationPolicy('accessory')`, `dock.hide()`; `:691` dock badge; `:1031` quit on last window | mac activation model | XP-12 |
| GenOffice sidecar | `apps/desktop/electron-builder.yml` extraResources `…/xlsx-engine/target/release/xlsx-sidecar` | a mach-o built on this Mac | per-OS Rust build in CI (XP-18) |
| Packaging/CI | `electron-builder.yml` (`mac:` only, `.icns`), `scripts/ship-local.sh` (codesign/ditto/defaults/keychain), `.github/workflows/ci.yml` (`macos-14` only), `apps/desktop/tests/e2e/harness.mjs:138` (`frontmostApp` via osascript) | mac only | XP-03, XP-18 |

### 2.5 What this means

Nothing in the architecture is Mac-shaped. The engine catalogue, the picker, the calibration record
and the supervisor's `buildArgsFn`/`healthPath` seams were all written with other platforms in mind.
What is Mac-shaped is a layer of ~40 call sites that each re-decide "how do I spawn, where do venvs
live, how do I list processes, what is a socket path". §4.2 moves those decisions into one package.

---

## 3. External research

### 3.1 llama.cpp release artefacts (the core fact)

**MEASURED** from `GET /repos/ggml-org/llama.cpp/releases`, 2026-09-23:

- **Semantic releases now exist.** `v0.5.0` (published 2026-09-23 20:50Z) carries only
  `nightly-tag.txt` = `b11146`, and its notes link the binaries to that nightly. `b<N>` builds are
  marked *prerelease*. ([release v0.5.0](https://github.com/ggml-org/llama.cpp/releases/tag/v0.5.0);
  versioning: [ggml discussion #1579](https://github.com/ggml-org/ggml/discussions/1579)). So we can pin a
  **semver** release and resolve its nightly tag: one tag for every platform, a sha256 digest per asset.
- **Assets in `b11149` (sizes MB):**

| Platform | Flavour → asset | MB | Companion |
|---|---|---|---|
| macOS arm64 | Metal `llama-…-bin-macos-arm64.tar.gz` | 11.2 | — |
| macOS x64 | CPU `…-macos-x64.tar.gz` (Metal OFF in `release.yml:85`) | 11.2 | — |
| Ubuntu x64 | CPU 17.0 · Vulkan 30.6 · CUDA 12.8 168.9 · CUDA 13.4 149.3 · ROCm 10.0 234.7 · SYCL fp32 54.9 / fp16 55.2 · OpenVINO 2026.4 109.1 | | cudart 12.8: 594.4; cudart 13.4: 440.2 |
| Ubuntu arm64 | CPU 13.6 · Vulkan 24.4 · CUDA 13.4 145.0 | | cudart 13.4 arm64: 552.5 |
| Linux arm64 Snapdragon | CPU+Adreno+Hexagon 18.8 | | — |
| Windows x64 | CPU 18.6 · Vulkan 32.1 · CUDA 12.4 253.9 · CUDA 13.4 149.8 · ROCm 10.0 251.9 · SYCL 120.2 · OpenVINO 88.3 | | cudart 12.4: 391.4; cudart 13.4: 423.5 |
| Windows arm64 | CPU 12.0 · OpenCL-Adreno 12.9 · CUDA 13.4 142.6 | | cudart 13.4 arm64: 153.3 |

- **How the packages are built** ([`.github/workflows/release.yml`](https://github.com/ggml-org/llama.cpp/blob/master/.github/workflows/release.yml)):
  - Linux and Windows are built with `-DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=ON`.
    **MEASURED** in the Linux CPU tarball: `libggml-cpu-{x64, sse42, sandybridge, ivybridge, haswell,
    skylakex, cannonlake, cascadelake, icelake, cooperlake, alderlake, sapphirerapids, zen4, piledriver}.so`.
    The Windows zip has the same set as `ggml-cpu-*.dll` plus `libomp.dll`. **The ISA is picked at
    runtime, so Bobble never chooses AVX2 vs AVX-512.**
  - **Windows backend zips = the CPU toolset + one backend DLL.** The "Merge artifacts" step injects
    `llama-server` and `ggml-cpu` into every `llama-bin-win-*-<arch>.zip`, "only with a different
    backend library on top" (`release.yml`, merge step).
  - **CUDA runtime**: separate `cudart-*` archives, extracted *next to the binaries*:
    - Windows: `cudart64_*.dll`, `cublas64_*.dll`, `cublasLt64_*.dll`.
    - Linux: `libcudart/libcublas/libcublasLt.so`, with `$ORIGIN` rpath.
    - Only the NVIDIA driver is needed on the host.
  - **ROCm 10.0.** Windows targets `gfx1010…1036; gfx1100…1103; gfx1150…1153; gfx1200; gfx1201`.
    The zip bundles `amdhip64_7.dll`, `rocm_kpack.dll`, `amd_comgr.dll`, because Adrenalin ships its own
    `amdhip64_7.dll` in System32. The workflow says "rocblas/hipblaslt kernels resolve fine via PATH and
    are not copied". Linux adds `gfx908;gfx90a;gfx942;gfx950` and packs `./build/bin` only, i.e.
    **no ROCm runtime libraries in the Linux tarball** (inferred from the workflow; verify on hardware).
  - **OpenVINO** zips bundle the OpenVINO runtime, TBB and (Linux) OpenCL. **SYCL-Windows** bundles the oneAPI
    DLLs (`mkl_sycl_blas.5.dll`, `sycl8.dll`, …). SYCL-Linux packs `build/bin` only.
- **MEASURED ABI floor**: `llama-server` and `libllama.so` in `b11149` need `GLIBC_2.34`,
  `GLIBCXX_3.4.29` → Ubuntu 22.04+, Debian 12+, Fedora 35+, RHEL 9+.
- **Built-in device control** (**MEASURED** from `libllama-common.so` strings):
  - `--list-devices` ("print list of available devices and exit").
  - `--device <dev1,dev2,…>` ("none = don't offload").
  - `--fit [on|off]` (default on), `-fitt/--fit-target MiB0,MiB1,…`, `-fitc/--fit-ctx`, `--fit-print`.
  - A `llama-fit-params` tool.
- **What `--fit` does** ([discussion #18049](https://github.com/ggml-org/llama.cpp/discussions/18049), after PR #16653, Dec 2025):
  - Probes free device memory and sets `n_gpu_layers`, tensor split, **MoE tensor overrides (dense weights first)**
    and context size automatically, to ~85–90% utilisation.
  - Default margin 1024 MiB per device.
  - Disabled wholesale if the user sets `-ngl`, `--tensor-split` or `-ot`.
- **Example output** (llama.app docs, cited in search results):
  - `Available devices: CUDA0: NVIDIA GeForce RTX 4060 Ti (15944 MiB, 14143 MiB free)`.
  - The Vulkan init line carries `uma: 0|1` (unified memory), `fp16`, `int dot`, `matrix cores: NV_coopmat2`.
  - The HIP init line names the `gfx` arch.
- Upstream now ships **aarch64 + CUDA 13** (DGX Spark / Jetson Thor class). Some 2026 guides still
  say it doesn't ([Arm learning path](https://learn.arm.com/learning-paths/laptops-and-desktops/dgx_spark_llamacpp/2_gb10_llamacpp_gpu/)).
  **MEASURED** `llama-b11149-bin-ubuntu-cuda-13.4-arm64.tar.gz` exists.

**For Bobble:**
- Stop building or choosing CPU variants.
- Model llama.cpp as **flavours** (`cpu | vulkan | cuda-12 | cuda-13 | rocm | sycl | openvino | metal | opencl-adreno`) of one pinned release.
- Get the device list and ground-truth VRAM from `--list-devices` *of the flavour we will run*.
- Stop hand-tuning `-ngl`: pass `--device` and let `--fit` size placement, with `--fit-target` derived from the guardian's reserve.

### 3.2 Driver and toolkit constraints per vendor

- **NVIDIA.**
  - CUDA 13 dropped Maxwell/Pascal/Volta: compute capability < 7.5 cannot use CUDA-13 builds.
  - CUDA 13 needs driver **≥ 580** ([CUDA 13.0 release notes](https://docs.nvidia.com/cuda/archive/13.0.3/cuda-toolkit-release-notes/index.html), [Tom's Hardware](https://www.tomshardware.com/pc-components/gpus/nvidia-to-drop-cuda-support-for-maxwell-pascal-and-volta-gpus-with-the-next-major-toolkit-release)).
  - So: cc < 7.5 **or** driver < 580 → the CUDA 12 flavour. Blackwell (sm_120/121) → prefer CUDA 13.
  - `nvidia-smi` ships with the driver on both OSes.
- **AMD.**
  - ROCm 10.0 supports RDNA3 (`gfx1100-1103`), RDNA4 (`gfx1200/1201`), Strix/Strix Halo (`gfx1150/1151`),
    Instinct parts, and `gfx1030` PRO. Windows = "Windows 11 25H2 for Radeon and APU platforms"
    ([ROCm 10.0.0 matrix](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html)).
    RDNA2 consumer and Vega are not listed. llama.cpp's own Windows ROCm build still compiles `gfx103x`.
  - **Vulkan is the universal AMD path.**
  - Lemonade maintains per-gfx ROCm builds **with the ROCm runtime bundled**: `lemonade-sdk/llamacpp-rocm` `b1330`,
    Windows 97–496 MB, Ubuntu 399–820 MB, targets gfx103X/110X/1150/1151/120X/908/90a (**MEASURED**, releases API).
  - `amd-smi` replaces `rocm-smi` ([AMD SMI docs](https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html)).
  - On Linux the kernel exposes `mem_info_vram_total/used` per card under `/sys/class/drm/card*/device/`
    with no ROCm installed ([kernel docs](https://docs.kernel.org/gpu/amdgpu/driver-misc.html)).
- **Intel.**
  - IPEX-LLM was **archived 2026-01-28**; the forward path is OpenVINO ([intel/ipex-llm](https://github.com/intel/ipex-llm)).
  - llama.cpp's OpenVINO backend targets Intel CPU/iGPU/Arc/NPU on Linux and Windows. The device is chosen via
    `GGML_OPENVINO_DEVICE=CPU|GPU|NPU`, and it is labelled work-in-progress ([docs/backend/OPENVINO.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/OPENVINO.md)).
  - Vulkan works on Arc and Xe iGPUs. SYCL needs Level Zero.
  - PyTorch XPU wheels: `https://download.pytorch.org/whl/xpu` for Arc (DG2/BMG) and Core Ultra iGPUs ([PyTorch blog](https://pytorch.org/blog/intel-gpu-support-pytorch-2-5/)).
- **Qualcomm (Windows on ARM).** The llama.cpp `win-cpu-arm64` and `win-opencl-adreno-arm64` builds; the NPU via Foundry Local (§3.3).

### 3.3 Specialized engines worth offering (and what they cost)

| Engine | OS | Vendors | Install form (**MEASURED** where noted) | Licence | Fit for Bobble |
|---|---|---|---|---|---|
| **llama.cpp** flavours | all | all | release zips/tarballs (above) | MIT | The baseline everywhere. |
| **vLLM** | Linux only; Windows via WSL ([docs](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/)) | NVIDIA (PyPI); ROCm via AMD docker/wheels; XPU source build | **`vllm 0.30.0`**: `manylinux_2_28` x86_64 (314.9 MB) / aarch64 wheels, `torch==2.13.0`, CUDA 13 deps (PyPI) | Apache-2.0 | Big NVIDIA Linux boxes, many concurrent agents (corp). Gate: driver ≥ 580, cc ≥ 7.5. |
| **SGLang** | Linux | NVIDIA, ROCm | **`sglang 0.5.20`**: `manylinux_2_34` wheels only (PyPI) | Apache-2.0 | Same niche as vLLM. Lower priority. |
| **ExLlamaV3** (+ TabbyAPI server) | Linux, Windows | NVIDIA (CUDA ≥ 12.4) | **`v1.5.1`**: prebuilt wheels `win_amd64` + `linux_x86_64` for cu128/cu132 × torch 2.8–2.13 ([releases](https://github.com/turboderp-org/exllamav3/releases)). No compiler needed. | MIT | The NVIDIA "fastest single chat" counterpart of DFlash/MLX. Needs EXL3 twins. |
| **TensorRT-LLM** | **Linux** (Windows deprecated since 0.18, [release notes](https://nvidia.github.io/TensorRT-LLM/release-notes.html)) | NVIDIA | wheels / NGC | Apache-2.0 | Catalogue fix: drop `win32`. Low priority (per-GPU engine build). |
| **Lemonade** (Server + **Embeddable**) | Windows, Linux, macOS | AMD NPU (FastFlowLM), AMD/NVIDIA/Intel GPU via llama.cpp (Vulkan/ROCm/CUDA) | **`v2026.39.1`**: MSI 10.8 MB, deb/rpm 3–7 MB, **`lemonade-embeddable-*` 5.4–7.4 MB** for win-x64 / ubuntu-x64/arm64 / macos-arm64 (releases API) | Apache-2.0 (5.8k stars) | **The only practical AMD-NPU path** (FastFlowLM on Windows and Linux). Backends installed at runtime via `POST /v1/install {recipe, backend}`, pinned in `backend_versions.json`, locked with `LEMONADE_API_KEY` ([embeddable docs](https://lemonade-server.ai/docs/embeddable/), [backends](https://lemonade-server.ai/docs/embeddable/backends/)). Also roadmap item 2. |
| **Foundry Local** | Windows (and macOS) | Qualcomm/Intel/AMD NPU, DirectML GPUs, CUDA | installer, OpenAI-compatible endpoint, hardware-specific ONNX variants per alias ([repo](https://github.com/microsoft/Foundry-Local)) | MIT | The Copilot+ NPU path. Catalogue row, not first wave. |
| **OpenVINO** | Windows, Linux | Intel CPU/GPU/NPU | as a llama.cpp flavour (bundled runtime) | Apache-2.0 | A Calibrate candidate on Intel. |
| **stable-diffusion.cpp** | all | all | **`master-908-88411ef`**: macOS arm64 34 MB; Linux CPU 25.5 / Vulkan 38.6 / ROCm 258 MB; Windows CPU 17.2 / Vulkan 32 / CUDA 12 334 (+ cudart 564) / ROCm 192 MB (releases API) | MIT | A portable image/video engine with no Python, and the **same flavour resolver** as llama.cpp. |
| **NInfer / NInfer-3090** | Linux (+ Windows zip for 3090) | one RTX 5090 / 3090 | source build | — | Already catalogued; unchanged. |

### 3.4 GPU / NPU detection methods

- **NVIDIA:**

  ```
  nvidia-smi --query-gpu=name,memory.total,memory.free,compute_cap,driver_version,pci.bus_id --format=csv,noheader,nounits
  ```
  - `nvidia-smi` is on PATH (and in `System32` on Windows) with every driver.
  - NVML over FFI is possible later (koffi is already in the tree via pi's clipboard dependency).
  - GB10 reports "128 GB unified" through nvidia-smi, while CUDA sees ~121.7 GiB ([DGX Spark notes](https://dredyson.com/5-critical-mistakes-everyone-makes-with-running-a-full-llm-stack-on-dgx-spark-gb10-your-application-litellm-llama-swap-vllm-llama-cpp-ollama-and-how-to-fix-them-before-you-lose-your-mind/)).
    So arm64-Linux NVIDIA must be treated as **unified**.
- **Linux, any vendor, zero dependencies:** read sysfs.
  - `/sys/class/drm/card*/device/{vendor,device,class,boot_vga}`, with PCI vendor `0x10de` / `0x1002` / `0x8086`.
  - amdgpu `mem_info_vram_total`, `mem_info_gtt_total` (the unified pool on APUs).
  - The KFD topology `gfx_target_version` for the AMD gfx id.
  - `lspci` only as a fallback.
- **Windows, no WMIC:** PowerShell `Get-CimInstance Win32_VideoController` (name, PNPDeviceID, driver).
  - **Plus the registry `HardwareInformation.qwMemorySize`** under
    `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\000N`.
    `AdapterRAM` is a uint32 and caps at 4 GB ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2202526/loop-through-and-read-adapters), [example PR](https://github.com/maximecll/ai-studio/pull/14)).
    `accelerator.ts` already discards the saturated value.
  - Live per-vendor VRAM: the `\GPU Adapter Memory(*)\Dedicated Usage` performance counters (WDDM 2.0+) ([Microsoft](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/gpu-process-memory-counters-report-wrong-value)).
  - NPUs: `Get-PnpDevice` classes `NeuralProcessors` **or** `ComputeAccelerator` (Intel AI Boost reports as the latter) ([AskWoody test script](https://www.askwoody.com/forums/topic/powershell-to-detect-npu-testers-needed/)).
- **Vendor-neutral ground truth:** `llama-server --list-devices` of each installed flavour (§3.1). It
  proves the backend *loads* on this machine: driver compatible, DLLs found, arch supported. A static
  probe cannot prove that.
- **Node built-ins:**
  - `os.freemem()` is honest off-macOS (Linux `MemAvailable`, Windows `ullAvailPhys`).
  - `process.availableMemory()` is cgroup-aware on Linux.
  - `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` works on Windows ([libuv misc](https://docs.libuv.org/en/v1.x/misc.html)).

### 3.5 Computer use on Windows

- **Prior art in 2026:**
  - Codex shipped Computer Use on Windows on 2026-05-29: UI Automation + `SendInput`, **Windows 11 24H2+**, and it works "in the foreground" ([WinBuzzer](https://winbuzzer.com/2026/06/01/openai-brings-codex-computer-use-to-windows-pcs-xcxwbn/), [PCWorld](https://www.pcworld.com/article/3154677/openai-codex-can-finally-control-windows-11-pcs-on-its-own.html)).
    Its capture uses Windows.Graphics.Capture and broke on Windows 10 by assuming `IsBorderRequired` exists ([codex #38271](https://github.com/openai/codex/issues/38271)).
  - Microsoft's UFO² combines UIA with visual grounding ([paper](https://arxiv.org/html/2504.14603v1)).
  - Apache Maka's Windows executor issue ([#3785](https://github.com/apache/maka/issues/3785)) is a ready-made hardening checklist. It maps onto Bobble's rules:
    - Reuse the platform-neutral protocol.
    - A long-lived native helper, not per-call PowerShell.
    - Action ladder **UIA semantic (Invoke/Toggle/Value/Scroll) → HWND message → foreground `SendInput` only by user policy**.
    - Per-Monitor-V2 DPI and negative virtual-screen coordinates.
    - Explicit UIPI, secure-desktop and locked-session results.
    - Verify every fallback. Capture that matches the tree's window.
- **Hard OS limits:**
  - **UIPI**: a medium-integrity process cannot inject into elevated windows. `UIAccess` needs a signed exe in a secure location ([UIPI](https://en.wikipedia.org/wiki/User_Interface_Privilege_Isolation), [hermes-agent #49067](https://github.com/NousResearch/hermes-agent/issues/49067)).
  - `SendInput` goes to the foreground.
  - `PostMessage` to an HWND works for classic Win32 but many Chromium/WinUI surfaces ignore it.
  - UIA patterns act without focus when the control exposes them.
- **Capture:**
  - WGC per-window capture works occluded.
  - Removing the yellow border requires `GraphicsCaptureAccess.RequestAccessAsync(Borderless)` (a user prompt) **and** the
    `graphicsCaptureWithoutBorder` capability **in a package manifest** ([Microsoft Learn](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired?view=winrt-26100)).
    An unpackaged NSIS install shows the border while capturing.
  - `PrintWindow(PW_RENDERFULLCONTENT)` is the borderless fallback for most apps.
- **Bindings:** Microsoft's `windows` crate (UIA, WGC, DXGI, SendInput) and `uiautomation` (MIT wrapper) ([uiautomation-rs](https://github.com/leexgone/uiautomation-rs)).
- **No TCC.** Windows has no Accessibility/Screen-Recording grants. The consent is Bobble's own policy (`packages/mac-computer-use/src/policy.ts`).

### 3.6 Computer use on Linux

- **Tree: AT-SPI2 over D-Bus.**
  - Toolkits publish only when `org.a11y.Status.IsEnabled` is true. Setting `ScreenReaderEnabled` instead starts Orca, a real bug in trycua ([cua #2010](https://github.com/trycua/cua/issues/2010)).
  - **Chromium/Electron decide at startup**, so an already-running Chrome must be relaunched.
  - Qt honours `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` ([AT-SPI2](https://www.freedesktop.org/wiki/Accessibility/AT-SPI2/), [cua #2915](https://github.com/trycua/cua/issues/2915)).
- **Input:**
  - Wayland: the xdg **RemoteDesktop portal + `ConnectToEIS` (libei)**, a one-time user consent ([portal spec](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html), [Who-T, 2026-07](http://who-t.blogspot.com/2026/07/libei-integrations-in-xdg-remotedesktop.html)).
  - The `ydotool`/uinput fallback needs the `input` group.
  - X11: XTest (`xdotool`).
  - "Wayland pointer actions are subject to the compositor's input-focus rules" — background pointer input is not possible. AT-SPI `Action`/`EditableText` calls are.
- **Capture:** GNOME Shell D-Bus screenshot → `org.freedesktop.portal.Screenshot` → X11.
- **Prior art:** `agent-sh/computer-use-linux` (Rust, **MIT**) does exactly this stack. It uses the `atspi` crate, the
  RemoteDesktop portal with a ydotool fallback, `wtype`, and xdotool on X11, and it has been validated on GNOME Wayland ([repo](https://github.com/agent-sh/computer-use-linux)). It is a candidate base for `pi-linux`.
- **Overlay:** Wayland forbids global window coordinates. `setPosition`/`getPosition` do not work ([Electron: Wayland tech talk](https://www.electronjs.org/blog/tech-talk-wayland), [#40886](https://github.com/electron/electron/issues/40886)).
  **No phantom-cursor overlay on Wayland.** The in-app monitor tab is the only surface. X11 can keep an overlay.

### 3.7 The shell on Windows (the harness depends on it)

- pi's bash tool requires bash (above).
- **MinGit has no bash** ("MinGit does not include /usr/bin/bash"). The BusyBox MinGit ships `ash` only ([MinGit](https://gitforwindows.org/mingit.html)).
- **PortableGit** includes bash + coreutils. **MEASURED** `PortableGit-2.55.0.5-64-bit.7z.exe` 59.0 MB, arm64 59.2 MB (GPLv2, ships as a separate program).
- MSYS bash runs `#!/bin/sh` shims on PATH, so the tool-CLI shims work unchanged once the socket is a named pipe.
- Setting pi's `shellPath` (its documented override) points pi at it.
- Killing process trees: pi itself uses `taskkill /F /T /PID` on Windows (`shell.js:killProcessTree`).

### 3.8 Packaging, signing, updates

- **electron-builder Linux targets:** AppImage, deb, rpm, flatpak, snap, pacman, … `electron-updater`
  auto-updates **AppImage, deb, rpm, pacman** ([electron-builder Linux](https://www.electron.build/docs/linux/), [auto-update](https://www.electron.build/docs/features/auto-update/)).
- **AppImage on Ubuntu 24.04+ / Fedora / Arch needs the static runtime.** electron-builder **26.15.3 (our
  version) defaults to the libfuse2 runtime**. Set `toolsets.appimage: "1.0.3"`; v27 defaults to the
  static runtime ([t3code PR](https://github.com/pingdotgg/t3code/pull/7765), [AppImage docs](https://www.electron.build/docs/appimage/)).
- **The Chromium sandbox vs Ubuntu's AppArmor userns restriction** (`apparmor_restrict_unprivileged_userns=1`):
  - electron-builder v26 emits an AppArmor profile for **deb/rpm**, but not for AppImage (ephemeral mount path).
  - AppImages otherwise need `--no-sandbox` ([AppImage docs](https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html), [Chromium 333313925](https://issues.chromium.org/issues/333313925)).
  - → deb/rpm are the primary Linux packages. AppImage is secondary.
- **Windows signing:** Azure **Artifact Signing** (ex-Trusted Signing). $9.99/mo for 5k signatures. Individual
  developers are limited to the US/Canada. SmartScreen reputation still builds over releases. Supported by electron-builder
  ([Azure](https://azure.microsoft.com/en-us/products/artifact-signing), [electron-builder](https://www.electron.build/docs/features/code-signing/code-signing-win/)).
- **Title bar:**
  - `titleBarStyle: 'hidden'` + `titleBarOverlay: {color, symbolColor, height}` on Windows/Linux.
  - `env(titlebar-area-x/width/height)` CSS variables for layout ([Electron](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)).
- **Wayland global shortcuts** need `--enable-features=GlobalShortcutsPortal`, and GNOME 50's portal has a registration bug ([#51875](https://github.com/electron/electron/issues/51875)). This is relevant to the "universal hotkey UI" roadmap item.
- **Windows MAX_PATH:** torch venvs under a long per-user path can exceed 260 characters unless `LongPathsEnabled=1` ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)). Keep the support root short.

### 3.9 The generation stack off the Mac

- **uv `--torch-backend=auto`** (also `UV_TORCH_BACKEND`) detects the CUDA driver, AMD GPU or Intel GPU and picks
  the PyTorch index. Values: `auto, cpu, cu118, cu126, cu128, cu130, rocm7.2, xpu`. It works only in the
  `uv pip` interface ([uv docs](https://docs.astral.sh/uv/guides/integration/pytorch/)).
- **ComfyUI's official GPU installs** ([docs.comfy.org manual install](https://docs.comfy.org/installation/manual_install)):
  - NVIDIA: `--extra-index-url https://download.pytorch.org/whl/cu130`.
  - AMD Linux: `--index-url https://download.pytorch.org/whl/rocm7.2`.
  - **AMD Windows**: `--index-url https://stable.repo.amd.com/rocm/whl-next/ "torch[device-all]==2.13.0+rocm10.0.0" …`, which **requires Python 3.13** (Bobble pins 3.12 everywhere).
  - AMD's Windows PyTorch covers RX 7000/9000 and Ryzen AI 300 / Max ([AMD docs](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/windows/install-pytorch.html)).
- **Mac-only today** → portable replacements:
  - mflux (image) → ComfyUI (the catalogue's GGUF graphs) or sd.cpp.
  - mlx-audio TTS and parakeet-mlx ASR → **sherpa-onnx** (Parakeet TDT 0.6B v3 int8 + Kokoro, Node addon, Apache-2.0) ([sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/index.html), [Node examples](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md)) or ComfyUI audio nodes.
  - The MLX TRELLIS sidecar → ComfyUI's native TRELLIS.2/Pixal3D. Memory `pi-desktop-comfy-native-3d-video` measured it portable, with no git or Xcode.
  - ffmpeg is optional, not bundled (`video-dispatch.ts:219`).

### 3.10 CI and test infrastructure

- **Free hosted runners for public repos:**
  - `ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-2025`, `windows-11-arm`.
  - arm64 standard runners have also been available on private repos since 2026-01-29 ([changelog](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/), [runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)).
- **GPU runners (T4) are "larger runners"**: paid, org plans ([GA changelog](https://github.blog/changelog/2024-07-08-github-actions-gpu-hosted-runners-are-now-generally-available/)).
- Windows runners have an interactive desktop, and UIA/WinAppDriver tests run on them ([WinAppDriver](https://github.com/microsoft/WinAppDriver)).
- **Vulkan without a GPU:**
  - Mesa **lavapipe** on Linux CI (`mesa-vulkan-drivers`) exercises the Vulkan flavour end to end.
  - **MEASURED** Electron 43 ships a SwiftShader Vulkan ICD (`vk_swiftshader_icd.json` + `libvk_swiftshader.dylib` here, `vk_swiftshader.dll` / `libvk_swiftshader.so` on other OSes). Worth a try on Windows runners via `VK_DRIVER_FILES`. It is unverified that ggml-vulkan's feature needs are met.
- **This Mac:** no Docker, OrbStack, Colima, UTM or QEMU is installed (**MEASURED**), and there is no Windows/Linux/GPU box. Rust helpers can at least be
  compile-checked for `x86_64-pc-windows-msvc` / `x86_64-unknown-linux-gnu` (`cargo check`, `cargo xwin`/`zigbuild` to link).
- **Chrome ≥ 136 ignores `--remote-debugging-port` on the default profile** ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)). Driving the user's *own* Chrome off-mac therefore needs an extension (chrome.debugger + native messaging), not CDP.

---

## 4. Design

### 4.1 Principles

1. **The baseline is never dropped.** This is the user's rule, extended one level down: every GPU box also keeps the llama.cpp
   **Vulkan** flavour, and every box keeps **CPU**. A vendor-tuned flavour is an optimisation that
   Calibrate must beat the baseline with.
2. **Detect → fetch → probe → calibrate.**
   - Static probes decide what to *download*.
   - The downloaded backend's own `--list-devices` decides what can *run*.
   - Calibrate decides what is *fastest*.
   - Each stage writes its reason where the user can read it.
3. **Upstream artefacts, pinned and verified.** No compiling on the user's machine for anything on the default path. Same sha256 discipline as today.
4. **No admin rights, no system installs, no focus theft:**
   - Per-user installer.
   - Everything under the app's support root.
   - `windowsHide: true` on every spawn.
   - Nothing activates another app unless the user's policy says so.
5. **One protocol, one vocabulary.** Computer use keeps the pi-mac NDJSON protocol, and the CLI command group
   becomes OS-neutral, so the harness LoRA (track 6) learns one surface.
6. **Headless by default** in every probe (memory `user-headless-testing-always`), on every OS.

### 4.2 The portability layer: `packages/platform` (new, Electron-free)

One package owns every "which OS am I on" decision. The ~40 call sites in §2.4 call into it.

| Module | API (sketch) | Replaces |
|---|---|---|
| `ipc-endpoint.ts` | `localEndpoint(name): string` → `\\.\pipe\bobble-<name>-<pid>-<rand>` on win32, `<tmp>/<name>.sock` elsewhere; `cleanupEndpoint(p)` | A7 (4 bridges) |
| `spawn.ts` | `spawnTracked(cmd, args, opts)`: `windowsHide:true` default, tree tracking, `detached` semantics per OS | A10, every `spawn` |
| `proc.ts` | `listProcesses()`: posix `ps -axo` / Linux `/proc` / Windows `Get-CimInstance Win32_Process` (JSON). `processTree(root)`, `killTree(pid)` (`taskkill /T /F` on win32), `setPriority(pid, tier)` via `os.setPriority`, `suspendTree/resumeTree` (SIGSTOP/SIGCONT on posix; the helper's `suspend` on Windows, see §4.7) | A12, A13, process-priority, `process.kill(-pid)` |
| `venv.ts` | `venvPython(root)`, `venvBin(root, name)` → `Scripts\name.exe` on win32 | A8 |
| `exe.ts` | `exe(name)` (+`.exe`), `findExecutable(root, name)` | A3 |
| `archive.ts` | `extract(archive, dest)` for `.tar.gz` and `.zip` (JS unzip; `tar.exe`/bsdtar as fallback) | A3, uv, engines-main |
| `links.ts` | `linkDir(target, at)`: a junction with an absolute target on win32, a relative symlink elsewhere | A14 |
| `dirs.ts` | `supportRoot()`: `$XDG_CACHE_HOME/bobble` on Linux, `%LOCALAPPDATA%\Bobble` on Windows, `~/.cache/bobble` on mac; `PI_DESKTOP_CACHE_DIR` still wins; one-time migration shim | `packages/inference/src/paths.ts:27` |
| `shell.ts` | `bashFor(pi)`: bundled PortableGit bash on win32; `defaultPtyShell()`; `which(cmd)`; `revealInFileManager()`; `openWithDefault()` (no focus steal where possible) | A9, `present-bridge.ts:131` |

Everything is injectable (the pattern already used by `accelerator.ts`/`pressure.ts`) and unit-tested
against `path.win32`/`path.posix` fixtures on the Mac, then for real on the CI matrix (XP-03).

### 4.3 Detection v2: `HostProfile`

`packages/inference/src/host-profile.ts` merges `hardware.ts` + `accelerator.ts` into one object.
The existing exports stay as adapters.

```ts
interface HostProfile {
  os: { platform: 'darwin'|'win32'|'linux'; release: string; distro?: string; displayServer?: 'x11'|'wayland'; arch: string };
  cpu: { brand: string; cores: number; isa?: string[] };          // isa: avx2/avx512/neon (informational only)
  ramGB: number;
  gpus: Array<{
    id: string;                       // stable: PCI bus id or LUID
    vendor: 'nvidia'|'amd'|'intel'|'apple'|'qualcomm'|'unknown';
    name: string; kind: 'discrete'|'integrated';
    vramGB?: number; sharedGB?: number;  // sharedGB = GTT / unified pool
    unified: boolean;
    driver?: string;                  // "581.15", "31.0.24033.1003", "amdgpu 6.14", "Mesa 25.2"
    computeCap?: string;              // "8.9" (full, not major)
    gfx?: string;                     // "gfx1100"
  }>;
  npus: Array<{ vendor: string; name: string }>;
  devices?: Record<Flavor, ListedDevice[]>;   // filled by --list-devices, per installed flavour
}
```

**Stage 1: static probes** (cached per launch; no downloads; each one best-effort):

| OS | Probe order |
|---|---|
| Windows | `nvidia-smi` query (§3.4) → PowerShell `Get-CimInstance Win32_VideoController` JSON + registry `HardwareInformation.qwMemorySize` → `Get-PnpDevice -Class NeuralProcessors,ComputeAccelerator` → (legacy `wmic` last, for Windows 10 installs that still have it) |
| Linux | sysfs `/sys/class/drm/card*/device` (vendor/device/class/boot_vga, amdgpu `mem_info_vram_total`, `mem_info_gtt_total`) → KFD `gfx_target_version` → `nvidia-smi` → `/sys/class/accel/*` (Intel/AMD NPU) → `lspci -mm` fallback; `XDG_SESSION_TYPE` for display server |
| macOS | unchanged |

**Unified-memory rules:**
- Apple Silicon.
- Any `kind: integrated` (Intel Xe/Arc iGPU, AMD APU incl. Strix Halo: budget = `sharedGB` (GTT), not the BIOS carve-out).
- NVIDIA on Linux arm64 (GB10 / Jetson).
- A Vulkan device reporting `uma: 1`.

**Stage 2: backend ground truth.**
- After a llama.cpp flavour installs, run `llama-server --list-devices` (timeout 15 s, `windowsHide`) and parse
  `Available devices:` plus the backend init lines (`compute capability`, `gfx…`, `uma:`).
- Cache per (flavour build, driver).
- A flavour whose `--list-devices` finds no GPU is marked **"installed, cannot use this GPU"** with its stderr tail.
  That is how "driver too old for CUDA 13" or "gfx not in this ROCm build" becomes a sentence in the UI rather than a crash at chat time.

**Stage 3: live telemetry** for the guardian (§4.7).

`hardwareKey` becomes `platform-arch-cpu-RAM-<gpu name>-<vram>-<driver major>`, so a GPU swap or
driver upgrade invalidates stale calibrations.

### 4.4 Engines: llama.cpp flavours + the specialized set

**Manifest:** `packages/inference/src/llamacpp-manifest.ts` becomes generated data.
- It is written by `scripts/pin-llamacpp.mjs`, which reads the releases API for a chosen **semver** release,
  resolves its nightly tag, and records `{platform, arch, flavor, asset, sha256, bytes, companion?}` for every asset.
- A per-platform tag override lets the Mac stay on `b10603` until the MTP/prefix behaviour is re-measured on the bump.
- `--check` mode only does HEAD + digest comparison, so it can run on this Mac.

**Install layout:** `<support>/llamacpp/<tag>/<platform>-<arch>-<flavor>/` with the `cudart` companion extracted into the same directory.
- One marker per flavour.
- `engines:list` reports flavours as sub-rows of the llama.cpp row.

**Selection:** `llamacpp-flavors.ts`, pure, tested per host fixture. An ordered list per GPU, first entry fetched first:

| Host | Flavour order (fetch order) | Notes |
|---|---|---|
| NVIDIA, cc ≥ 7.5, driver ≥ 580 | `vulkan` → `cuda-13` → `cpu` | Vulkan is 31 MB and ready in seconds. CUDA 13 (150 + 424–440 MB) arrives in the background. Blackwell requires 13. |
| NVIDIA, cc < 7.5 or driver < 580 | `vulkan` → `cuda-12` → `cpu` | The "Update your driver to 580+ for CUDA 13" note appears only when cc ≥ 7.5. |
| AMD, gfx in the ROCm build's target list | `vulkan` → `rocm` → `cpu` | Linux ROCm needs a runtime. Offer the upstream build + AMD's pip `rocm[libraries]` in a private venv via uv (no root), or Lemonade's per-gfx build with the runtime bundled. Pick after hardware testing (Q9). |
| AMD, other (RDNA2 on Windows, Vega, older) | `vulkan` → `cpu` | ROCm skip reason: "ROCm 10 does not support gfx1031 on Windows". |
| AMD Ryzen AI NPU | + Lemonade/FastFlowLM engine (XP-25) | NPU models are a separate format (FLM). |
| Intel Arc / Xe iGPU | `vulkan` → `openvino` → `sycl` → `cpu` | OpenVINO/SYCL are Calibrate candidates, not defaults. `GGML_OPENVINO_DEVICE=GPU`. |
| Intel Core Ultra NPU | `openvino` (NPU, Q4_0-oriented) | experimental; Calibrate decides |
| Windows on ARM (Snapdragon) | `cpu` → `opencl-adreno` | NPU via Foundry Local later |
| Linux arm64 + NVIDIA (GB10/Jetson) | `cuda-13` → `vulkan` → `cpu` | unified memory budget |
| No usable GPU | `cpu` | |
| macOS | unchanged (`metal`, MLX engines) | |

**Specialized engines** (ordered by value per effort; all behind the existing OpenAI-compatible `startExternalEngine` path):

1. **vLLM** (Linux): install with `uv pip install vllm --torch-backend=auto`, gated on driver ≥ 580 and cc ≥ 7.5 (current wheels). ROCm stays "advanced" (AMD's images or wheels).
   - Needs a safetensors/AWQ twin: generalize the catalogue's `mlxRepo` into
     `twins: { mlx?, safetensors?, awq?, exl3? }` so "Fetch missing" fetches the right twin per host.
   - Part of `defaultEngineSet` only on "big Linux boxes" (the user's wording): NVIDIA with VRAM ≥ 24 GB.
2. **ExLlamaV3 + TabbyAPI** (Linux/Windows NVIDIA): prebuilt wheels matched to the torch from `--torch-backend`; EXL3 twins; one more Calibrate row.
3. **Lemonade Embeddable** (Windows/Linux): **only for the AMD NPU** at first (FastFlowLM). The GPU paths
   duplicate our own flavours, and our supervisor features would sit behind Lemonade's router
   (MTP/draft flags, `/slots` prefix-reuse measurement, park/resume, portable knobs).
   This answers roadmap item 2 concretely.
4. Catalogue-only rows (unwired): Foundry Local (Windows NPU), SGLang (Linux), TensorRT-LLM (**Linux only**; fix the row), stable-diffusion.cpp flavours (image/video; same resolver).

### 4.5 Launch policy on PCs

In `chooseServerPerfArgs` + the supervisor:

- **Always pass `--device <DEV>`** for a GPU flavour (from Stage 2).
  - A laptop with an Intel iGPU and an NVIDIA dGPU shows *both* under Vulkan.
  - A box with CUDA and Vulkan flavours in one directory would show the same GPU twice.
  - Implicit multi-device placement is never what we want by default. Multi-GPU (2×3090) is an explicit `--device CUDA0,CUDA1` profile that Calibrate can measure.
- **Discrete GPU: do not pass `-ngl`.**
  - Leave `--fit on`, with `--fit-target = max(1024 MiB, guardian VRAM reserve)`.
  - MoE models then get dense-first placement with experts spilled to RAM automatically. That is the "35B-A3B on an 8 GB card with 64 GB RAM" case the RAM-only recommender cannot express.
  - `--fit-ctx` = our context floor.
- **Unified (APU/iGPU/GB10):** the Apple rules. Budget = unified pool minus reserve. The q8 KV fallback under pressure (`perf-args.ts`) applies unchanged.
- **Launch fallback:** if a flavour dies during startup, the supervisor falls back down the flavour list
  (cuda → vulkan → cpu). It records **why** and says so in the engine menu. This mirrors the existing "calibrated engine
  cannot launch → llama.cpp" fallback.

### 4.6 Calibration across flavours

- `CalibrationCandidate` gains `flavor?: Flavor` and `device?: string`. Ids become
  `llamacpp:cuda-13/mtp`, `llamacpp:vulkan/none`, `vllm/none`, `exllamav3/none`.
- `planCandidates` takes
  `llamacpp: { installed: Flavor[]; installable: Flavor[]; unusable: Array<{flavor, reason}> }`.
- Skips carry the new reasons, each with a `fix`:
  - "needs NVIDIA driver 580+ (you have 552.44)" — `fix: 'none'` + help link.
  - "ROCm build has no gfx1031".
  - "installable (574 MB)" — `fix: 'install'`.
- The existing bench prompts and rules are unchanged (thinking off, sampled, no shared topic).
- The record stores `engineBuild` **per flavour** (`<tag>/<flavor>`), so a flavour update re-measures only its own rows.
- Multi-GPU: candidates `…/split` (all devices) vs `…/single` (best device) are added when ≥ 2 discrete GPUs are present.
- The "Fetch missing · N" button (`llm:companions` + calibration-plan skips) now also fetches missing flavours.

### 4.7 Guardian, memory guard and power policy off macOS

1. **Fix A6 first** (XP-01):
   - `memory: () => ({ total: totalmem(), free: freemem() })` off-darwin.
   - A real `readFile` so Linux PSI/meminfo/vmstat are read.
   - A regression test that a calm Linux or Windows reading is `normal`.
2. **Per-OS signals** in `pressure.ts`:
   - Linux: already good (PSI is the best signal on any OS). Scan all `card*`, not `card0`.
   - Windows: available physical (`freemem`) + **commit charge vs limit**. Windows OOM is commit-limit driven, and the pagefile grows first. Read these with a cached PowerShell `Win32_OperatingSystem` reading at the slow cadence, or from the helper at the busy cadence.
   - Windows also offers `QueryMemoryResourceNotification` (low/high) from the helper, the closest analogue to macOS's verdict ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-creatememoryresourcenotification)).
3. **VRAM as a wall on discrete GPUs:**
   - Admission compares a job's GPU footprint with **free VRAM** (nvidia-smi / amdgpu sysfs / Windows GPU memory counters). RAM is used only for offloaded parts.
   - A CUDA OOM is a clean job failure, not a machine freeze. The shed lines stay RAM-driven, while admission and holds also consider VRAM.
4. **Pause** (memory `pi-desktop-memory-guard`: pause → resume → terminate):
   - Linux: SIGSTOP/SIGCONT through `platform/proc` (a `/proc` tree).
   - Windows: the helper's `suspend/resume` (NtSuspendProcess, the method Process Explorer uses; [Suspending-Techniques](https://github.com/diversenok/Suspending-Techniques)). Until the helper exists, a pause degrades to *hold + terminate at the shed line*, and the reason says so.
   - The Python pacer (`worker.py:243-290`) uses `psutil.Process.suspend()/resume()` on Windows and keeps the signals on posix.
5. **Orphans:**
   - Linux: "parent is not a live Bobble process" (subreaper-proof), matched by our support-root path.
   - Windows: CIM parent check at launch plus a Job Object (kill-on-close) owned by the helper, so a crash cannot leave a 12 GB `llama-server.exe` behind.
6. **Priority:** `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` on Windows. `renice` equivalents via the same call on Linux (nice 10 or 5 as today).

### 4.8 Shell and the tool CLI on Windows and Linux

- **Windows bash:** first run fetches PortableGit (59 MB, pinned + sha256) into
  `<support>/tools/git/`, and pi's `shellPath` points at its `bin\bash.exe`. An existing Git for Windows is detected and reused.
  Alternative considered: requiring Git for Windows. It is one more manual step and breaks "one click".
- **Tool-CLI shims** (`tool-cli-bridge.ts`, `mcp-lite/bash-cli.ts`):
  - Keep the `#!/bin/sh` shims (MSYS runs them) and add `.cmd` twins so the PowerShell terminal tab can also call `media …`, `office …`.
  - Use the named-pipe endpoint (§4.2).
  - `shimFallthroughFor` asks `which` instead of `/usr/bin/<cmd>`.
- **`open` wrapper per OS:**
  - Windows `start`/`explorer`: same rules — URL → `browser navigate`, folder → `ls`, app → `desktop launch`.
  - Linux `xdg-open`.
- **System prompt:**
  - Add an OS line: "You are on Windows 11; your shell is Git Bash; paths look like `/c/Users/…` and `C:\Users\…` both work".
  - Capability wording per OS (`capability-prompt.ts:157`).
  - The `SHELL_CWD_TRUTH` wording applies unchanged.
  - The harness LoRA dataset (track 6) must include these OS variants.

### 4.9 Computer use on Windows and Linux

**Keep:**
- The protocol (`MacAgentMethod`, `MacSnapshot`, `MacActAck`, …).
- The Node bridge (`apps/desktop/electron/mac/mac-agent.ts`) and the tools (`packages/mac-computer-use`).
- The policy and app grid (`policy.ts`, `AppGrid.tsx`).
- The monitor and Activity tab.

**Rename conceptually** to *desktop agent*. The `mac` CLI group becomes `desktop` with `mac` as an alias on darwin (Q2).

**Helpers:** one Cargo workspace `packages/desktop-helper/`:
- `crates/protocol`: the NDJSON types, generated from `protocol.ts` so both sides cannot drift.
- `bins/pi-win` and `bins/pi-linux`.

| Method | Windows (`pi-win`) | Linux (`pi-linux`) |
|---|---|---|
| `check` | always ok; reports `uipi` state, capture mode, WGC borderless availability | a11y bus `IsEnabled`, portal RemoteDesktop session/restore token, `/dev/uinput` access, display server |
| `snapshot` | UIA tree with a cache request (control/content view), bounded node/depth/time budgets, `Name/ControlType/BoundingRectangle/IsEnabled/HasKeyboardFocus/patterns`; `text` lines from `TextPattern`/`Value` | AT-SPI (`atspi` crate): roles, names, states, `Component` extents, `Text` |
| `click` | ladder: `InvokePattern`/`TogglePattern`/`SelectionItemPattern`/`ExpandCollapsePattern`/`LegacyIAccessible.DoDefaultAction` (background) → `PostMessage` WM_LBUTTON* to the HWND (verified after) → `SendInput` (foreground; only when policy allows) | `Action.do_action` (background) → portal/libei pointer (focus rules apply; activate the window first) → XTest on X11 → ydotool |
| `type` | `ValuePattern.SetValue` / `TextPattern` (background) → `WM_CHAR` → `SendInput` Unicode | `EditableText.set_text_contents`/`insert_text` (background) → libei keyboard → `wtype`/xdotool |
| `key` / `scroll` | `SendInput` or `ScrollPattern`; wheel in **screen** coordinates (the Maka bug) | libei / XTest |
| `launch` | `Get-StartApps`/`shell:AppsFolder` AUMIDs + `CreateProcess` with `SW_SHOWNOACTIVATE`; watch-and-restore focus like `restoreFocusTo` (bounded by Windows' foreground-lock rules) | `.desktop` files in `XDG_DATA_DIRS` (+ flatpak/snap exports) → `gtk-launch`/`Exec` |
| `screenshot` | WGC per-window (occluded ok; yellow border unless packaged, §3.5) → `PrintWindow(PW_RENDERFULLCONTENT)` fallback; DXGI for the monitor | portal Screenshot / GNOME Shell D-Bus → X11 `XGetImage` |
| `bounds/windows/occlusion` | `EnumWindows` z-order + DWM extended frame bounds; per-monitor DPI v2 | X11: `_NET_CLIENT_LIST_STACKING`; Wayland: only AT-SPI extents (no z-order) |
| `menus/menuClick` | UIA `MenuBar`/`MenuItem` (`ExpandCollapse`/`Invoke`) | AT-SPI menus |
| `apps` + icons | AUMID list + `SHGetFileInfo`/`IShellItemImageFactory` → PNG data URLs (same contract as `pi-mac --apps`) | `.desktop` `Icon=` via the icon theme lookup |
| `suspend/resume` (new; used by §4.7) | NtSuspendProcess / NtResumeProcess tree | not needed (signals) |

**`check` adds a capability block** so the Node side and the prompt can be honest:

```json
{
  "background": "full" | "semantic-only" | "none",
  "overlay": "native" | "electron" | "none",
  "capture": "wgc" | "wgc-bordered" | "printwindow" | "portal" | "x11"
}
```

**Overlay:**
- Windows and X11: revive the Electron click-through overlay window (it existed before the NSPanel rewrite — memory
  `pi-desktop-mac-computer-use`), fed by the helper's z-order for masking.
- Wayland: `none`. The Activity-tab monitor is the only view, and Settings says why.

**Policy denylist per OS:** Windows Security, Registry Editor, UAC consent, Credential Manager. Linux: Settings/Passwords & Keys (Seahorse), polkit agent.

**Permissions UX** (Settings → Computer use, per OS):
- Windows: "Apps running as administrator can't be controlled (Windows blocks it). Bobble never runs elevated."
- Linux:
  - "Accessibility: On" (Bobble sets `org.a11y.Status.IsEnabled`; apps already open must be relaunched).
  - "Input: [Allow]" (portal consent, token remembered).
  - "Fallback input needs the `input` group" (with the exact command).

**The user's own Chrome off-mac:** CDP on the default profile is blocked (§3.10). Recommend a small
Bobble Chrome extension (chrome.debugger + native messaging to Bobble), which also works on macOS.
Until it exists, `chrome_*` tools are hidden off-mac and the in-app browser is the path.

### 4.10 The generation stack per OS

| Modality | macOS (today) | Windows / Linux (target) |
|---|---|---|
| Image | mflux (MLX) default, ComfyUI | **ComfyUI** (GGUF graphs already in the catalogue); Nunchaku later (NVIDIA); sd.cpp flavours as the no-Python option |
| Video | ComfyUI (Wan 1.3B, LTX GGUF), HyperFrames | same; CUDA machines lift the 24 GB-Mac limits (LTX native safetensors etc.) |
| Music / SFX | ComfyUI Stable Audio | same |
| TTS | mlx-audio (Qwen3-TTS) | **sherpa-onnx Kokoro** (Node addon, CPU-fast) or ComfyUI TTS nodes |
| Dictation | parakeet-mlx | **sherpa-onnx Parakeet TDT 0.6B v3 int8** |
| 3D | MLX sidecar (TRELLIS.2 / CubePart / ARDY) | **ComfyUI native TRELLIS.2 / Pixal3D**; the sidecar's CUDA paths later (the workers already pick `cuda` first, `_device.py`); add `xpu` |
| SVG | OmniSVG on llama.cpp | same, on the chosen flavour |
| Office | python-pptx/docx/openpyxl | same + **bundled metric-compatible fonts** (e.g. Liberation/Arimo/Tinos/Cousine) mapped in `textfit.py` |

ComfyUI install on PCs:
- `uv pip install --python <venv> --torch-backend=auto -r requirements.txt` (NVIDIA → cu130/cu128 by driver, AMD Linux → rocm7.2, Intel → xpu, none → cpu).
- **AMD Windows** is the exception: a Python **3.13** venv and AMD's ROCm-10 multi-arch wheels.
- Launch flags per vendor: drop `--force-upcast-attention`/`--fp32-vae` on CUDA unless a graph needs them (the audio VAE bf16 garbage was an MPS artefact).
- The gen-module card (`gen-modules-main.ts`) maps `image` → ComfyUI off-mac, and says so.

### 4.11 Packaging, signing, updates

- `electron-builder.yml`:
  - `win`: `nsis` (per-user, no admin, `oneClick` like the user wants), `x64` + `arm64`, `.ico`.
  - `linux`: **deb + rpm** (with the v26 AppArmor profile), **AppImage** (static runtime: `toolsets.appimage: "1.0.3"`), `tar.gz`; icons set.
  - `asarUnpack` for `pi-win`/`pi-linux`.
  - Per-OS `extraResources` (GenOffice xlsx sidecar built per OS).
- **Native deps:** `node-pty` has no prebuilds here (`pnpm-workspace.yaml` note), so CI rebuilds it per OS with
  `@electron/rebuild`. The helpers are built in CI per OS and arch.
- **Signing:** Windows via Azure Artifact Signing (the user's account; §6). Sign the helpers too, because input-injecting
  unsigned binaries attract Defender heuristics. Linux: GPG-signed repo metadata if a repo is offered. macOS W11
  (Developer ID + notarization) is the same pipeline shape.
- **Updates:** `electron-updater` with the GitHub provider (NSIS, AppImage, deb, rpm).
- **Per-OS ship scripts** replace `scripts/ship-local.sh` for their OS. The packaged smoke runs per OS in CI.

### 4.12 UI: where it lives and what the user sees

1. **Settings → Engines → "This machine"** (new card at the top of `EnginePanel.tsx`, `data-testid="engine-this-machine"`):

   ```
   This machine                                                        [Copy system report]
   Windows 11 24H2 · x64 · AMD Ryzen 9 7950X · 64 GB
   GPU   NVIDIA GeForce RTX 4090 · 24 GB · driver 581.15 · compute 8.9
         Intel UHD Graphics 770 (integrated) · not used for models
   NPU   none
   Seen by engines   CUDA0 RTX 4090 (24 GB, 22.8 free) · Vulkan0 RTX 4090 · Vulkan1 UHD 770
   Status            Ready · llama.cpp CUDA 13 measured fastest (Calibrate, 2 min ago)
   ! Update the NVIDIA driver to 580 or newer to use the CUDA 13 build (you have 552.44).  [How]
   ```

   States:
   - *Checking this machine…* (the existing spinner copy).
   - *Ready*.
   - *Degraded* (amber, with the one-line fix).
   - *CPU only* (neutral, "no supported GPU found", with what was found).
   - *Probe failed* (with a log tail).
2. **The llama.cpp engine row expands into flavour chips:**
   `CPU · Vulkan (installed) · CUDA 13 (574 MB, downloading 41%) · CUDA 12 · ROCm (not for this GPU)`.
   Unsupported chips carry the reason on hover (the `InfoDot` pattern). Install/remove per chip.
3. **Engine menu** (top bar, `EngineMenu.tsx`):
   - The running line gains the flavour and device: `Qwen3.5 9B · llama.cpp CUDA 13 · RTX 4090 · MTP · 142 tok/s`.
   - Calibrate rows label flavours: `llama.cpp · CUDA 13 · MTP`.
   - Skips say driver/arch reasons.
4. **Local devices for track 5.** A new IPC `llm:devices` returns `{id: 'CUDA0', flavor, name, vramGB, freeGB, unified}[]`,
   so the top-left engine/GPU icon's device chooser lists local accelerators (multi-GPU boxes pick which GPU serves)
   beside remote Tailscale devices. This is the shared seam between track 4 and track 5.
5. **Onboarding → Setup** (`SetupStep.tsx` / `presets.ts`):
   - "We found an NVIDIA GeForce RTX 4090 (24 GB). Vulkan (31 MB) now so you can chat in seconds; CUDA 13 (574 MB) next, then Calibrate picks the faster one."
   - `planPreset` uses the VRAM-aware budget.
6. **Settings → Computer use**: the per-OS permission section (§4.9). The app grid is fed by `pi-win`/`pi-linux --apps`.
7. **Window chrome:** Windows/Linux get native caption buttons at the **top right** (`titleBarOverlay`, height 46 = `--pd-height-topbar`).
   The left gutter shrinks from `CHROME_LEFT` (85 px) to 12 px. `window-chrome.ts` exports per-OS geometry, and the renderer reads `env(titlebar-area-*)`.

### 4.13 Per-OS matrix (target at the end of this track)

"Full" = same as macOS today. "Degraded" = works, with the stated limit. "No" = not planned in this track.

| Capability | macOS (AS) | Windows NVIDIA | Windows AMD | Windows Intel / ARM / CPU | Linux NVIDIA | Linux AMD | Linux Intel / ARM / CPU |
|---|---|---|---|---|---|---|---|
| Chat LLM (llama.cpp) | Full (Metal) | Full (CUDA 12/13 → Vulkan → CPU) | Full (ROCm RDNA3/4/APU; else Vulkan) | Full (Vulkan/SYCL/OpenVINO; CPU; Adreno OpenCL on ARM) | Full (CUDA; arm64 CUDA 13) | Full (ROCm or Vulkan) | Full (Vulkan/OpenVINO/SYCL; CPU) |
| Vision (mmproj) / MTP / drafters | Full | Full | Full | Full (speed varies) | Full | Full | Full |
| Alt engines | MLX ×5 | ExLlamaV3 | Lemonade NPU | Foundry Local (later) | vLLM, ExLlamaV3 | vLLM-ROCm (advanced), Lemonade NPU | OpenVINO |
| Calibrate | Full | Full (flavours × methods) | Full | Full | Full | Full | Full |
| Image / video / music | Full (MLX + Comfy) | Full (Comfy CUDA) | Full (Comfy ROCm; Python 3.13) | Degraded (XPU or CPU = slow) | Full | Full | Degraded (XPU/CPU) |
| TTS / dictation | Full (MLX) | Full (sherpa-onnx) | Full | Full | Full | Full | Full |
| 3D | Full (MLX sidecar) | Full (Comfy native) | Degraded (Comfy native on ROCm, unmeasured) | Degraded / No (CPU too slow) | Full | Degraded | Degraded / No |
| Office / SVG / HyperFrames | Full | Full (fonts bundled) | Full | Full | Full | Full | Full |
| In-app browser + browser use | Full | Full | Full | Full | Full | Full | Full |
| User's own Chrome | Full (AppleScript) | Degraded (needs the Bobble extension) | same | same | same | same | same |
| Computer use | Full (background) | Degraded (background via UIA patterns; foreground fallback by policy; no elevated apps) | same | same | X11: Degraded (background via AT-SPI; XTest input). Wayland: Degraded (portal consent; pointer needs focus) | same | same |
| Phantom cursor overlay | Full | Full (Electron overlay) | Full | Full | X11 Full / Wayland No | same | same |
| Mail / Calendar / Messages connectors, Spotlight, AFM | Full | No (hidden; MCP connectors instead) | No | No | No | No | No |
| Guardian: pause → resume → terminate | Full | Full once `pi-win` exists (Degraded before: hold + terminate) | same | same | Full | Full | Full |
| Low-power pacing | Full | Full (psutil suspend) | Full | Full | Full | Full | Full |
| Installer + auto-update | dir build (W11 pending) | NSIS + updater | same | same (arm64 NSIS) | deb/rpm/AppImage + updater | same | same |

### 4.14 Alternatives considered and rejected

| Alternative | Why not (now) |
|---|---|
| **Embed Lemonade as the only non-Mac engine** | Lemonade already orchestrates llama.cpp across Vulkan, ROCm and CUDA. But Bobble's supervisor owns the llama-server process for MTP/draft flags, `/slots` prefix-reuse measurement, park/resume for the guardian, the portable knobs and Calibrate. Routing through `lemond` hides those or needs a second control plane. It is kept for what only it has, the AMD NPU (FastFlowLM), and as roadmap item 2's evaluation. |
| **Compile llama.cpp on the user's machine** | Needs CUDA/ROCm/oneAPI toolkits and MSVC/gcc. That means minutes to hours and admin installs. Upstream artefacts cover every flavour with digests. Source builds stay for forks only (K2 Horizon), with per-OS toolchain checks. |
| **Ollama as the backend** | Another daemon with its own model store and naming. Bobble's GGUF library, calibration and spec methods would be second-class. Detecting a user's Ollama and offering it via `baseUrl` is fine later. |
| **WSL2 / Docker on Windows** | Heavy, admin-gated, GPU passthrough caveats. Useful *later* for vLLM/SGLang on Windows (`wsl.exe -- vllm serve`), not as the base. |
| **PowerShell instead of bash on Windows** | It would fork the harness vocabulary and the LoRA training data per OS, and models are much stronger at bash. Git Bash keeps one vocabulary. |
| **C#/.NET NativeAOT helper for Windows** | FlaUI/UIA3 interop is not NativeAOT-friendly. The Rust `windows` crate covers UIA, WGC, DXGI and SendInput in one small static exe, and a shared Rust workspace also serves Linux (`atspi`, `ashpd`/libei). |
| **Flatpak/Snap as the primary Linux package** | Confinement conflicts with spawning engines, reading `/sys` and `/dev/dri` broadly, driving other apps via AT-SPI, and writing `~/Bobble`. Portals help for some of this, not all. |
| **MSIX-only on Windows** | It would give package identity (and borderless WGC capture), but brings filesystem/registry virtualization quirks for caches and venvs. NSIS first. A *sparse package* for identity later if the capture border matters. |
| **DirectML / torch-directml for Windows AMD/Intel** | Legacy path. ROCm-on-Windows wheels and XPU wheels superseded it for PyTorch. llama.cpp Vulkan covers LLMs. |
| **One "fat" llama.cpp directory with every backend DLL** | `GGML_BACKEND_DL` would load them all, so the same GPU appears as CUDA0 and Vulkan0 and implicit placement can split across them. Separate flavour directories plus explicit `--device` are simpler to reason about. The duplicate CPU toolset costs ~17 MB. |

### 4.15 Test strategy without owning the machines

| Layer | Where | What it proves |
|---|---|---|
| **L0 fixtures** | this Mac (vitest) | Parsers and planners for every host class, from recorded outputs: `nvidia-smi` CSV, PowerShell CIM JSON + registry values, sysfs trees, `--list-devices` stderr for CUDA/HIP/Vulkan/SYCL, `Get-PnpDevice`, PSI/meminfo; flavour selection; calibration plans; launch argv; `path.win32` venv/exe/pipe/junction logic. Seed fixtures from vendor docs now and replace them with real captures from testers (L5) as they arrive. |
| **L0b fake-host UI** | this Mac (Playwright, headless) | `PI_E2E_HOST=<fixture>` (PI_E2E-only seam) makes `accelerators()`/`app:get-info` report a Windows or Linux host. `crossplatform-look.mjs` screenshots Engines → This machine, flavour chips, the engine menu, onboarding and Computer use for ~6 hosts. |
| **L0c manifest check** | this Mac (network, HEAD only) | `pin-llamacpp.mjs --check`: every pinned asset exists and its digest matches. |
| **L1 platform** | GitHub `ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-2025`, `windows-11-arm` | `packages/platform` against the real OS: named-pipe round trip, junctions without admin, zip/tar extraction, `killTree` on a 3-level tree, CIM process list, `os.setPriority`. |
| **L2 engine smoke** | same runners, no GPU | Install `cpu` + `vulkan` flavours; `llama-server --version`, `--list-devices` (Linux: **lavapipe** shows `llvmpipe`; Windows: try Electron's SwiftShader ICD); one short completion from a tiny GGUF via the real supervisor; ComfyUI `--torch-backend=cpu` install + `/object_info`. |
| **L3 app e2e** | same runners | The packaged app via Playwright `_electron` (Linux under `xvfb-run` with `kernel.apparmor_restrict_unprivileged_userns=0` on the runner). A subset of the existing headless probes plus the new probes. A focus assertion per OS (Windows `GetForegroundWindow` via PowerShell; Linux `xdotool getactivewindow` under Xvfb). |
| **L4 computer use** | Windows runner (interactive desktop); Linux Docker image with headless GNOME/Mutter or Weston + AT-SPI | `pi-win` drives Notepad (type, save dialog), Calculator (WinUI), an Electron fixture app; `pi-linux` drives gedit/GTK and a Qt app; screenshots attached as artifacts. |
| **L5 real hardware** | self-hosted runners (the user's or testers' machines, reachable over Tailscale — track 5) labelled `gpu-nvidia`, `gpu-amd`, `gpu-intel`, `win-arm` | Nightly `calibrate-probe` + `engine-matrix-probe` + a generation per modality. Results as artifacts and a table. A **"Copy system report"** button (HostProfile + `--list-devices` + calibration + log tails) turns any user into an L5 data point. Optional: rented cloud GPUs (NVIDIA; AMD Developer Cloud for ROCm) when no machine is available. |

On this Mac today, L0/L0b/L0c run immediately. L2 for Linux arm64 (CPU + lavapipe) could run locally if
The user installs a container runtime (OrbStack/Colima). Nothing heavier than a tiny GGUF is needed.

---

## 5. Work packages

Sizes: **S** ≤ 1 day · **M** 2–4 days · **L** 1–2 weeks · **XL** > 2 weeks. Ordered for execution.
"Verify" is always headless (memory `user-headless-testing-always`).

**XP-01 — Stop the guardian shedding everything off macOS** · S · deps: —
- Files: `apps/desktop/electron/gen/guardian-main.ts` (memory/readFile per OS); `packages/inference/src/pressure.ts` (Windows branch labels); new `apps/desktop/electron/gen/guardian-main.test.ts`.
- Acceptance: with `platform: 'linux'` and a `/proc` fixture at 60% `MemAvailable` and PSI 0, `judge` returns `calm`. With `platform: 'win32'`, `freemem` 40% returns `calm`. The macOS path is byte-identical.
- Verify: vitest in `packages/inference` and `apps/desktop` (`./node_modules/.bin/vitest run`, never `npx`).

**XP-02 — `packages/platform` foundation** · M · deps: —
- Files: create `packages/platform/{package.json,tsconfig.json,vitest.config.ts,src/{index,ipc-endpoint,spawn,proc,venv,exe,archive,links,dirs,shell}.ts}` + tests.
- Touch: the four bridges (A7); every venv path (A8); `llamacpp-manager.ts`, `uv.ts`, `engines-main.ts`, `llamacpp-source-build.ts` (archive/exe); `storage-main.ts`, `library-migration.ts`, `supervisor-entry.ts:1728` (links); `pausables.ts`, `llm-main.ts:815`, `reap-orphans.ts` (proc); `process-priority.ts` (setPriority); `web-tools/src/python.ts:99`, `mac-connectors/src/exec.ts:91` (killTree); every spawn gets `windowsHide`.
- Acceptance: all existing suites green on darwin; no `'.sock'`, `'bin', 'python'` or `symlinkSync(` outside `packages/platform`. A grep test enforces this.
- Verify: vitest on the Mac; the same suite on the XP-03 matrix.

**XP-03 — Cross-OS CI matrix** · M · deps: XP-02
- Files: `.github/workflows/ci.yml` (+ `crossplatform.yml`).
- Jobs:
  - `ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-2025`, `windows-11-arm`: lint, typecheck, unit (per-package vitest).
  - `platform-live`: the L1 tests.
  - `engine-smoke`: L2, with `mesa-vulkan-drivers`.
  - `e2e-subset`: L3, with `xvfb-run` and the AppArmor sysctl.
  - Artifacts on failure.
- Acceptance: all jobs green on a PR. Nightly schedule for engine smoke.
- Verify: CI itself.

**XP-04 — uv on every platform** · S · deps: XP-02
- Files: `packages/web-tools/src/uv.ts` (`PINNED_UV` per `platform-arch` with sha256 from the release digests, `uv.exe`, zip extraction); `apps/desktop/electron/inference/engines-main.ts:193-205` (per-OS candidates, e.g. `%USERPROFILE%\.local\bin\uv.exe`).
- Acceptance: `ensureUv({ignorePath:true})` installs and verifies on the four runners. Unit tests cover asset selection.
- Verify: vitest with a fetch fake + CI.

**XP-05 — llama.cpp flavour manifest + installer** · M · deps: XP-02
- Files: create `scripts/pin-llamacpp.mjs`, `packages/inference/src/llamacpp-flavors.ts`. Rewrite `llamacpp-manifest.ts` (generated data: per platform × arch × flavour + companions + optional per-platform tag). Touch:
  - `llamacpp-manager.ts`: flavour param, `.exe`, zip, companion extraction, per-flavour marker.
  - `engine-select.ts`: `pickLibllama` for `.so`/`.dll`.
  - `llamacpp-source-build.ts`: per-OS cmake flags and toolchain checks (vswhere/MSVC on Windows; `-DGGML_VULKAN/CUDA` options).
  - `engines-main.ts`: the llama.cpp row lists flavours; install per flavour.
- Acceptance:
  - Manifest entries exist for every flavour in §3.1 with sha256 + bytes.
  - `pin-llamacpp.mjs --check` passes.
  - CI installs `cpu` + `vulkan` on ubuntu/windows; `--version` and `--list-devices` succeed.
  - `architecturesIn` finds `qwen35` in `libllama.so` / `llama.dll`.
- Verify: vitest + `--check` on the Mac + CI smoke.

**XP-06 — Detection v2 (`HostProfile`)** · M · deps: XP-02, XP-05
- Files:
  - Create `packages/inference/src/host-profile.ts`, `probes/{win32,linux,darwin}.ts`, `list-devices.ts`, `__fixtures__/hosts/*` (≥ 10 classes: RTX 4090 Win, GTX 1080 Win, RX 7900 Win, RX 6700 Win, Arc B580 Win, Snapdragon X, RTX Ubuntu, Strix Halo Fedora, Arc Ubuntu, GB10, CPU-only).
  - Touch `accelerator.ts` + `hardware.ts` (adapters), `calibrate.ts:hardwareKey`, `supervisor-entry.ts:accelerators()/listCatalog`, `ipc-contract.ts:LlmHardware` (+ `gpus[]`, `driver`, `computeCap`, `gfx`, `devices`), `settings/host-gpu.ts`, `recommender.ts` / `model-recommender.ts` (VRAM + MoE-offload budget).
- Acceptance:
  - Each fixture yields the expected profile (vendor, VRAM, unified flag, full compute cap, gfx, NPU).
  - Windows never shells `wmic` first.
  - `recommendation-matrix.test.ts` prints a row per new host.
- Verify: vitest.

**XP-07 — Fake-host e2e seam + cross-platform look probe** · S · deps: XP-06
- Files: `supervisor-entry.ts` + `main.ts` (`PI_E2E_HOST`, PI_E2E-gated); create `apps/desktop/tests/e2e/crossplatform-look.mjs` and host fixtures.
- Acceptance: screenshots for 6 hosts show correct This-machine cards, flavour chips, engine-menu lines and unsupported reasons. The seam is inert without `PI_E2E`.
- Verify: `SHOT_DIR=… node tests/e2e/crossplatform-look.mjs` on the Mac (after `npm run build`); read the screenshots.

**XP-08 — Flavour selection + launch policy** · M · deps: XP-05, XP-06
- Files: `llamacpp-flavors.ts` (ordered list + reasons); `supervisor-entry.ts` (flavour choice, `--device`, fallback chain with reasons); `perf-args.ts` (non-Apple branch: `--fit on`, `--fit-target` from the reserve, `--fit-ctx`, no `-ngl`); `calibrate.ts` `LaunchProfile` (+`flavor`, `device`); `portable-knobs.ts` (device knob).
- Acceptance: argv tests per fixture (iGPU+dGPU → dGPU device; cc 6.1 → cuda-12; driver 552 → cuda-12 + note). The fallback chain is exercised by a fake binary that dies. CI Linux launches a tiny model on `vulkan` (lavapipe) through the supervisor.
- Verify: vitest + CI.

**XP-09 — Calibration across flavours** · M · deps: XP-08
- Files: `calibrate.ts` (`planCandidates` flavour dimension, skips with driver/arch reasons, per-flavour `engineBuild`); `supervisor-entry.ts` `calibrate()`; `EngineMenu.tsx` labels; `llm-store.ts`.
- Acceptance: planner tests for NVIDIA/AMD/Intel/CPU fixtures. A record written under one GPU is ignored under another. "Fetch missing" includes flavours.
- Verify: vitest; `calibrate-probe.mjs` under `PI_E2E_HOST` (UI states); CI Linux real measurement of `cpu` vs `vulkan`.

**XP-10 — Engine catalogue corrections + per-host default sets** · S · deps: XP-06
- Files: `apps/desktop/src/settings/engine-catalog.ts` (TensorRT-LLM → linux; vLLM/SGLang notes; rows for Foundry Local, OpenVINO, sd.cpp; `defaultEngineSet` per (OS, vendor, VRAM): vLLM only on NVIDIA ≥ 24 GB with driver ≥ 580 / cc ≥ 7.5; llama.cpp flavours listed) + tests; `engine-picker.ts` (`computeCap` instead of `cudaMajor`).
- Acceptance: the existing invariants stay green (baseline per cell, etc.). New tests pin the per-host sets.
- Verify: vitest.

**XP-11 — Detection & engine UI** · M · deps: XP-06, XP-07, XP-08
- Files: `EnginePanel.tsx` (This-machine card, flavour chips, Copy system report), `EngineMenu.tsx` (running line), `onboarding/SetupStep.tsx` + `presets.ts` (VRAM budget, Vulkan-first plan copy), new IPC `llm:devices` + `app:system-report` in `ipc-contract.ts`/`llm-main.ts`, `global.css`.
- Acceptance: screenshots per fake host match §4.12. `llm:devices` returns local devices for the track-5 picker.
- Verify: `crossplatform-look.mjs` + `settings-probe`/`onboarding-probe` updates.

**XP-12 — Window chrome and shell integration per OS** · M · deps: XP-03
- Files: `main.ts` (`titleBarStyle:'hidden'` + `titleBarOverlay` off-mac; app menu; badge → `setOverlayIcon`/`app.setBadgeCount`; background-mode equivalents: `skipTaskbar`, `showInactive`, no-focus), `window-chrome.ts` (per-OS geometry), top-bar CSS (`env(titlebar-area-*)`), `background-mode.ts`, `tests/e2e/harness.mjs` (`frontmostApp` per OS).
- Acceptance: jsdom tests of per-OS constants; CI screenshots on windows/linux show caption buttons unobstructed; the focus assertion runs on all three OSes.
- Verify: vitest + CI e2e artifacts.

**XP-13 — Shell and tool CLI on Windows/Linux** · M · deps: XP-02
- Files:
  - `packages/platform/src/shell.ts` (PortableGit pin + fetch).
  - `pi/pi-main.ts` (pi `shellPath`/env).
  - `packages/harness/src/tools/tool-cli-bridge.ts` and `packages/mcp-lite/src/bash-cli.ts` (named pipes, `.cmd` twins, `which` fall-through, per-OS `open` wrapper).
  - `pi/present-bridge.ts:131`, `corp/submit-work.ts:85`, `corp/product-gate.ts:99`.
  - `packages/harness/src/prompt/capability-prompt.ts` (OS lines).
- Acceptance: on `windows-2025` a mock-model pi turn runs `media --help` via Git Bash and reads the help. `open -a Notepad` becomes `desktop launch`. On Linux `open x.pdf` gives the read/present advice. Prompt tests per OS.
- Verify: vitest + CI e2e (mock pi, `packages/engine/tools/mock-pi`).

**XP-14 — Process control parity** · M · deps: XP-02
- Files: `reap-orphans.ts` (subreaper-proof Linux rule; Windows CIM + `\Scripts\` regex), `pausables.ts` (tree via `platform/proc`; Windows suspend through the helper with a hold+terminate degrade until XP-21), `packages/gen-service/python/worker.py` (pacer via psutil on Windows; posix unchanged) + its tests, `supervisor.ts` (killTree for trees on Windows).
- Acceptance: CI spawns uv → python → child on each OS; `killTree` leaves none. Linux pause shows state `T` and resumes. The pacer test runs on the Windows runner.
- Verify: vitest + pytest (`packages/gen-service/python/test_worker.py`) + CI.

**XP-15 — Guardian and pressure per OS + VRAM wall** · M · deps: XP-01, XP-06, XP-14
- Files: `pressure.ts` (Windows commit/available; all `card*`; Intel; Windows GPU counters), `guardian.ts` (VRAM admission for discrete), `guardian-main.ts`, `power-policy.ts` (discrete lever = fit target), `gen-manager.ts` admission.
- Acceptance: fixture tests; a job whose VRAM need exceeds free VRAM is refused with a reason; a Linux memory-guard probe in a cgroup-limited CI container shows pause/resume/terminate.
- Verify: vitest + CI container probe.

**XP-16 — Office fonts everywhere** · S · deps: —
- Files: `tools/office-gen/textfit.py` (font map per OS + bundled fonts), bundled metric-compatible fonts under `tools/office-gen/fonts/` (licences alongside), `electron-builder.yml` extraResources.
- Acceptance: wrap widths on Linux CI within 2% of the macOS reference for the benchmark deck strings. No `load_default()` fallback in normal runs.
- Verify: pytest on the Mac + CI.

**XP-17 — Generation stack portability** · L · deps: XP-02, XP-04, XP-06
- Files:
  - `engines-main.ts` ComfyUI install (`--torch-backend=auto`; the AMD-Windows Python 3.13 + AMD index path; XPU).
  - `packages/gen-service/src/comfy-supervisor.ts` (per-vendor flags).
  - `apps/desktop/electron/gen/gen-modules*.ts` (module ids per OS: image → ComfyUI off-mac; audio → sherpa-onnx / ComfyUI).
  - `packages/gen-service/src/catalog.ts` (backend availability per OS).
  - `gen3d/gen3d-main.ts` (3D → ComfyUI native off-mac).
  - `gen3d/dictation-main.ts` (sherpa-onnx ASR off-mac).
  - `packages/gen3d-engine/python/workers/_device.py` (+`xpu`).
- Acceptance: on each OS the module cards offer the portable path; CI Linux installs ComfyUI CPU and lists `TextEncodeQwenImage21` and the other required nodes via `/object_info`; argv tests per host.
- Verify: vitest + CI; real-GPU generation deferred to XP-26.

**XP-18 — Packaging per OS** · L · deps: XP-02, XP-12, XP-13
- Files: `apps/desktop/electron-builder.yml` (win nsis x64/arm64; linux deb/rpm/AppImage `toolsets.appimage: "1.0.3"`/tar.gz; icons; asarUnpack helpers; per-OS extraResources incl. the GenOffice sidecar built per OS), icon generation for `.ico`/png sets, per-OS ship scripts, `node-pty` rebuild in CI, `tests/e2e/packaged-{probe,smoke}.mjs` parameterized per OS.
- Acceptance: CI produces installers for 4 targets; the packaged smoke passes on ubuntu-24.04 and windows-2025 (the app starts, pi spawns from the bundled cli.js, the canvas harness serves).
- Verify: CI artifacts + packaged smoke.

**XP-19 — Signing + auto-update** · M · deps: XP-18
- Files: `electron-builder.yml` (`win.azureSignOptions`, `publish`), `electron/main.ts` (electron-updater wiring behind a setting), CI secrets.
- Acceptance: a signed NSIS build installs without an "unknown publisher" prompt; the updater upgrades from N to N+1 in CI (a local feed).
- Verify: CI. **Blocked on the user's signing account** (§6).

**XP-20 — Computer-use protocol v2 + Node generalization** · M · deps: XP-02
- Files: `packages/mac-computer-use` → `packages/computer-use` (re-export shim kept); a protocol capability block + `suspend/resume` methods (`protocol.ts`); `apps/desktop/electron/mac/mac-agent.ts` → `desktop-agent.ts` with per-OS helper resolution; `tool-names.ts` + `tool-cli-groups` (`desktop` group, `mac` alias on darwin); `format.ts` per-OS wording; `policy.ts` per-OS denylist; `overlay-controller.ts` (Electron overlay path for win32/X11); `settings/panels/ComputerUsePanel.tsx` (per-OS permissions); `mac-agent-methods.test.ts` updated.
- Acceptance: the 1280-line `tools.test.ts` passes against fake helpers advertising each capability set. The prompt says what a degraded mode cannot do.
- Verify: vitest; `mac-overlay-probe` stays green on the Mac.

**XP-21 — `pi-win` (Windows helper, Rust)** · XL · deps: XP-20
- Files: create `packages/desktop-helper/` (Cargo workspace: `crates/protocol`, `bins/pi-win`), CI build + sign.
- Methods: all of §4.9's Windows column, including `--apps`/icons and `suspend/resume`, Per-Monitor-V2 DPI, UIPI detection, the capture ladder, and the Maka checklist items that apply.
- Acceptance: on `windows-2025`, a script drives Notepad (type, Save As dialog as a modal, save), Calculator (WinUI buttons via Invoke, read the display text) and an Electron fixture, with no foreground `SendInput` unless the policy allows it. Screenshots are attached.
- Verify: `cargo test` + CI L4; `cargo check --target x86_64-pc-windows-msvc` on the Mac.

**XP-22 — `pi-linux` (Linux helper, Rust)** · XL · deps: XP-20
- Files: `packages/desktop-helper/bins/pi-linux` (evaluate forking `agent-sh/computer-use-linux`, MIT), a Docker test image (GNOME headless or Weston + at-spi2 + gedit + a Qt app).
- Methods: §4.9's Linux column; the a11y `IsEnabled` toggle; portal RemoteDesktop with a restore token; X11 fallback; `--apps` from `.desktop` files.
- Acceptance: in the CI container, snapshot → click → type → read back works on GTK and Qt apps via AT-SPI actions without focus. Portal input is exercised on a headless GNOME session.
- Verify: `cargo test` + CI L4.

**XP-23 — Feature gating, OS app inventory, open-with, file search** · M · deps: XP-20
- Files: `canvas/canvas-main.ts` (open-with lists per OS: Windows registry `OpenWithProgids`/AUMIDs; Linux `xdg-mime` + `.desktop` `MimeType`), `packages/mcp-lite/src/detect-apps.ts` (inventory per OS for connector recommendations), `packages/web-tools/src/spotlight.ts` (off-mac: a portable `file_search` — Windows Search index via `Search.CollatorDSO`, Linux `plocate`, `fd`/scan fallback — or hidden), `mac-connectors` gating, `mac/wallpaper.ts` per OS, capability prompt.
- Acceptance: no macOS-only tool is advertised off-mac (a grep test over the advertised tool list per platform). Open-with menus list real apps on the CI runners.
- Verify: vitest + CI e2e.

**XP-24 — vLLM + ExLlamaV3 wiring** · L · deps: XP-06, XP-09, XP-17
- Files: `engines-main.ts` (installs with `--torch-backend=auto` and gates), `packages/inference/src/engine-launch.ts` (`exllamav3`/TabbyAPI argv; vLLM flags per VRAM), `catalog.ts` + `recommended-catalog.ts` (`twins`), `model-downloader.ts` (per-host twin fetch), `calibrate.ts` rows, provider reuse (`provider-mlx`'s OpenAI path; rename to a generic OpenAI-server provider if needed).
- Acceptance: install/launch/health argv tests; on an NVIDIA L5 runner both engines answer, call tools and appear as Calibrate rows.
- Verify: vitest + L5.

**XP-25 — Lemonade Embeddable for the AMD NPU (roadmap item 2)** · M · deps: XP-06, XP-09
- Files: `engines-main.ts` (fetch the embeddable zip/tarball, pin `backend_versions.json`, `LEMONADE_API_KEY`), `engine-launch.ts` (`lemond --port`), catalogue row (`role: 'npu'`, `requiresNpu`), FLM model mapping in the catalogue.
- Acceptance: on a Ryzen AI L5 machine, a FastFlowLM model answers through Bobble's chat and appears in Calibrate. Elsewhere the row is greyed with the reason.
- Verify: vitest + L5.

**XP-26 — Real-hardware acceptance lanes + system report** · M · deps: XP-03, XP-06
- Files: `.github/workflows/hardware-nightly.yml` (self-hosted labels), `deliverables/crossplatform-acceptance.md` (checklist per machine class), the system-report builder (`llm-main.ts`), docs for testers.
- Acceptance: at least one NVIDIA-Windows and one AMD-Linux machine run the nightly (calibrate + one generation per modality + a computer-use script) and publish a result table.
- Verify: the lane itself; results in STATUS.md.

**Critical path:** XP-01 → XP-02 → XP-05 → XP-06 → XP-08 → XP-09 gives "chat + calibration on any PC".
XP-13/XP-12/XP-18 make it installable and usable. XP-20 → XP-21/XP-22 is the long pole (computer use).
XP-01, XP-02, XP-03, XP-04, XP-16 need no hardware and can start immediately.

---

## 6. Risks, blockers, open questions

### Blockers
1. **No Windows, Linux or GPU hardware in hand.** Free CI covers CPU/Vulkan-software paths only. GPU runners are paid (T4, org plans). Real NVIDIA/AMD/Intel acceptance needs self-hosted machines or testers (XP-26).
2. **Windows code signing** needs an Azure Artifact Signing account: individuals in the US/Canada, or an org with 3+ years of history. $9.99/mo. Unsigned builds hit SmartScreen and Defender friction, especially for an input-injecting helper.
3. **This Mac has no container or VM runtime.** Local Linux smoke tests need the user's OK to install one (OrbStack/Colima). Everything else is testable here as fixtures and fake-host screenshots.
4. **Hard OS limits that cannot be engineered away:**
   - Wayland has no global overlay and no unprompted input (portal consent; pointer input follows focus).
   - Windows UIPI means no control of elevated apps.
   - Windows WGC shows a yellow border for unpackaged apps.
   - Windows' foreground-lock rules limit "give focus back" after a launch.
5. **Latent day-one bugs** (A6 guardian shed, A7 sockets, A10 console flashes, A11 no window controls) must be fixed before any PC run is judged. Otherwise the first impression is "it's broken" for reasons unrelated to the hardware.

### Risks
- **Download sizes on NVIDIA.** CUDA runtimes are 391–594 MB on top of a 150–254 MB build (§3.1). The Vulkan-first start avoids a first-run wait, but it is still ~600 MB in the background (Q4).
- **ROCm fragmentation:**
  - Linux upstream builds need a ROCm runtime (pip `rocm[libraries]` or system).
  - Windows needs the rocBLAS kernels "via PATH".
  - Lemonade's per-gfx builds bundle everything but are 100–800 MB.
  - Unmeasured until hardware (Q9).
- **The AMD-Windows ComfyUI path needs Python 3.13** (AMD wheels) while everything else pins 3.12. That means two interpreters in the support root.
- **Upstream churn:**
  - llama.cpp publishes several builds a day and now also semver releases; flag renames happen (`--mtp` → `--spec-type`, from memory `project-pi-desktop`).
  - A manifest bump must re-run the engine matrix on the Mac too (per-platform tag override mitigates).
  - vLLM wheels track CUDA 13 (driver ≥ 580), which can strand older drivers.
- **Performance expectations.** Vulkan vs CUDA/ROCm speed varies by card and version. Calibrate exists to measure it, but first-run defaults may be the slower one until it runs.
- **Windows specifics:**
  - MAX_PATH with deep torch venvs (keep the support root short).
  - Defender scanning multi-GB GGUFs on first load.
  - The firewall prompt when track 5 binds a server to the tailnet interface.
  - Symlink-vs-junction semantics in the model library and the HF cache (HF falls back to copies without symlink rights, doubling disk).
- **Licences:**
  - PortableGit is GPLv2 (a separate program, mere aggregation).
  - Bundled fonts need OFL/Apache licences.
  - ffmpeg builds vary (GPL vs LGPL) if ever bundled.
  - Bobble is `GPL-3.0-or-later` (`apps/desktop/package.json`), compatible with all of the above.
- **The MLX-only features have no equivalents:**
  - The measured MLX speedups (mflux 6×, rapid-mlx prefill, DFlash-MLX) do not transfer.
  - PC users get ComfyUI/PyTorch speed on their GPU, often faster in absolute terms on NVIDIA, but through different code paths that need their own measurements.
- **Computer-use parity is the largest scope item** (two XL helpers). The Mac helper took several rounds of live defects (memory `pi-desktop-mac-computer-use`), and the PC helpers will too.

### Questions for the user
1. **Minimum OS targets:** Windows 11 only (Codex chose 24H2+), or also Windows 10 22H2 (out of support since Oct 2025)? Linux: Ubuntu 22.04+/Debian 12+/Fedora/Arch, X11 **and** Wayland?
2. **CLI vocabulary:** rename the `mac` command group and `mac_*` tools to an OS-neutral `desktop` (keeping `mac` as an alias on macOS)? This changes what the harness LoRA (track 6) is trained on, so it should be decided before that dataset is built.
3. **Windows shell:** OK to download PortableGit (59 MB, GPLv2) on first run so pi has bash? Or require the user to install Git for Windows?
4. **NVIDIA first-run downloads:** OK to fetch the CUDA build + runtime (~575 MB on Windows CUDA 13, up to ~765 MB for Linux CUDA 12.8) automatically in the background after a Vulkan-first start, or ask first?
5. **Distribution:**
   - Does the user qualify for (and want) Azure Artifact Signing?
   - Linux channels = deb + rpm + AppImage, no Flatpak/Snap?
   - NSIS one-click per-user install on Windows?
6. **Test hardware:** can the user lend or borrow a Windows+NVIDIA box and a Linux+AMD box as self-hosted runners (they can join over Tailscale — track 5)? Or is there budget for cloud GPUs / paid GPU runners?
7. **Windows computer use:** strictly background (UIA semantic actions only, refuse otherwise), or allow foreground `SendInput` as a fallback when the user's policy permits (what Codex does)?
8. **Wayland:** acceptable that the phantom cursor is absent (Activity monitor only) and that input needs a one-time portal "Allow"?
9. **AMD ROCm on Linux:** upstream builds + AMD's pip runtime in a private venv, or Lemonade's per-gfx builds with the runtime bundled (bigger, simpler)? And should Lemonade be evaluated as more than the NPU path?
10. **Scope:** are Windows-on-ARM (Snapdragon) and Linux arm64 (DGX Spark, Jetson) in v1, or follow-ups?
11. **Mac pin:** bump macOS llama.cpp to the same semver release as the PCs now (re-measure MTP/prefix behaviour on the Mac), or keep `b10603` on the Mac and pin PCs separately for a while?

---

## Appendix A — sources

Primary artefacts read today:
- llama.cpp releases API: [`b11149`](https://github.com/ggml-org/llama.cpp/releases/tag/b11149), [`v0.5.0`](https://github.com/ggml-org/llama.cpp/releases/tag/v0.5.0), [`b10603`](https://github.com/ggml-org/llama.cpp/releases/tag/b10603).
- [llama.cpp `release.yml`](https://github.com/ggml-org/llama.cpp/blob/master/.github/workflows/release.yml).
- The `b11149` ubuntu-x64 / ubuntu-vulkan-x64 / win-cpu-x64 archives (contents, glibc symbols).
- [uv 0.11.28 release](https://github.com/astral-sh/uv/releases/tag/0.11.28).
- [Git for Windows 2.55.0.windows.5](https://github.com/git-for-windows/git/releases).
- [Lemonade v2026.39.1](https://github.com/lemonade-sdk/lemonade/releases), [lemonade-sdk/llamacpp-rocm b1330](https://github.com/lemonade-sdk/llamacpp-rocm/releases).
- [ExLlamaV3 v1.5.1](https://github.com/turboderp-org/exllamav3/releases), [stable-diffusion.cpp master-908](https://github.com/leejet/stable-diffusion.cpp/releases).
- PyPI JSON for [vllm](https://pypi.org/project/vllm/), [sglang](https://pypi.org/project/sglang/), [torch](https://pypi.org/project/torch/).

Documentation and articles (each cited inline above):
- llama.cpp [`--fit` discussion #18049](https://github.com/ggml-org/llama.cpp/discussions/18049), [OpenVINO backend](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/OPENVINO.md).
- [uv PyTorch guide](https://docs.astral.sh/uv/guides/integration/pytorch/), [ComfyUI manual install](https://docs.comfy.org/installation/manual_install).
- CUDA 13: [release notes](https://docs.nvidia.com/cuda/archive/13.0.3/cuda-toolkit-release-notes/index.html), [Tom's Hardware](https://www.tomshardware.com/pc-components/gpus/nvidia-to-drop-cuda-support-for-maxwell-pascal-and-volta-gpus-with-the-next-major-toolkit-release).
- AMD: [ROCm 10.0.0 matrix](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html), [AMD PyTorch on Windows](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/windows/install-pytorch.html), [amdgpu sysfs](https://docs.kernel.org/gpu/amdgpu/driver-misc.html), [AMD SMI](https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html).
- Intel: [IPEX-LLM archive](https://github.com/intel/ipex-llm), [PyTorch XPU](https://pytorch.org/blog/intel-gpu-support-pytorch-2-5/).
- [TensorRT-LLM release notes](https://nvidia.github.io/TensorRT-LLM/release-notes.html), [vLLM GPU install](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/), [Lemonade llama.cpp backends](https://lemonade-server.ai/docs/guide/configuration/llamacpp/), [Lemonade embeddable](https://lemonade-server.ai/docs/embeddable/), [Foundry Local](https://github.com/microsoft/Foundry-Local).
- Windows detection: [WMIC removal (Microsoft)](https://support.microsoft.com/en-us/topic/windows-management-instrumentation-command-line-wmic-removal-from-windows-e9e83c7f-4992-477f-ba1d-96f694b8665d), [BleepingComputer](https://www.bleepingcomputer.com/news/microsoft/microsoft-wmic-will-be-removed-after-windows-11-25h2-upgrade/), [AdapterRAM/qwMemorySize](https://learn.microsoft.com/en-us/answers/questions/2202526/loop-through-and-read-adapters), [NPU detection](https://www.askwoody.com/forums/topic/powershell-to-detect-npu-testers-needed/), [CreateMemoryResourceNotification](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-creatememoryresourcenotification), [Suspending-Techniques](https://github.com/diversenok/Suspending-Techniques).
- Windows computer use: [WGC IsBorderRequired](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired?view=winrt-26100), [Codex Windows computer use](https://winbuzzer.com/2026/06/01/openai-brings-codex-computer-use-to-windows-pcs-xcxwbn/), [codex #38271](https://github.com/openai/codex/issues/38271), [Apache Maka #3785](https://github.com/apache/maka/issues/3785), [UFO²](https://arxiv.org/html/2504.14603v1), [uiautomation-rs](https://github.com/leexgone/uiautomation-rs), [UIPI](https://en.wikipedia.org/wiki/User_Interface_Privilege_Isolation).
- Linux computer use: [computer-use-linux](https://github.com/agent-sh/computer-use-linux), [AT-SPI2](https://www.freedesktop.org/wiki/Accessibility/AT-SPI2/), [cua #2010](https://github.com/trycua/cua/issues/2010), [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html), [libei in portals (Who-T)](http://who-t.blogspot.com/2026/07/libei-integrations-in-xdg-remotedesktop.html).
- Electron: [Wayland tech talk](https://www.electronjs.org/blog/tech-talk-wayland), [custom title bar](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar), [powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor), [globalShortcut Wayland #51875](https://github.com/electron/electron/issues/51875).
- Packaging: [electron-builder Linux](https://www.electron.build/docs/linux/), [auto-update](https://www.electron.build/docs/features/auto-update/), [AppImage static runtime PR](https://github.com/pingdotgg/t3code/pull/7765), [Electron AppImage sandboxing](https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html), [Azure Artifact Signing](https://azure.microsoft.com/en-us/products/artifact-signing), [electron-builder Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win/).
- Shell and runtime: [MinGit](https://gitforwindows.org/mingit.html), [Chrome 136 remote debugging](https://developer.chrome.com/blog/remote-debugging-port), [sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/index.html), [MAX_PATH](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation), [libuv misc](https://docs.libuv.org/en/v1.x/misc.html).
- CI: [GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners), [arm64 in private repos](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/), [GPU runners](https://github.blog/changelog/2024-07-08-github-actions-gpu-hosted-runners-are-now-generally-available/).
