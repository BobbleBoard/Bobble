# Bobble — status

Updated: 2026-09-23 (4) · wave commits `c1f7d578` `3ab7ec95` `c51638c7` `9d0d2e38` (base `c9fe7098`) · build on /Applications: `c1f7d578` (installed 17:32, packaged probe + smoke OK)

## Wave — computer use / vision (the user 2026-09-23) — DONE

| # | Item | State |
|---|------|-------|
| 1 | Origin of the "TEXT-ONLY mode" note | DONE — it was true: rapid-mlx+MTP runs a text-only lane. The note now names the real cause |
| 2 | Vision on by default, switch in the engine menu | DONE, live-probed on qwen3.5-4b: sees a red square by default (llama.cpp + projector, reason shown); switch Off → text-only, the model says vision is off and where to turn it on. Found + fixed: an attached image used to relaunch multimodal behind the Off switch (5 min) |
| 3 | `--visual` snapshot = image only (Mac, Chrome, browser) | DONE + tested |
| 4 | Active app persisted | DONE + tested |
| 5 | "scrolled element 5000" | DONE — a scroll distance was read as an element index |
| 6 | Projects slide open/closed | DONE — probe: 0 in-between frames before, ≥4 after; slowed mid-slide still |
| 7 | Open / Open with in canvas + cards | DONE (subagent): menus open upward, card Open shows the canvas, text files open as real files, failures toast; probe 3/3 |
| 8 | HyperFrames 120 PNG cards | DONE (subagent): one looping APNG, frames in `frames/`; then frames at the requested size (was 2× on Retina, 7.8 → 3.75 MB) |
| 9 | Generating cards: no border, falloff, any aspect | DONE — probe BEFORE 7 fails → AFTER 0 |
| 10 | "Thinking for 14m" instantly | DONE + tested |
| 11 | Delete chat instant + terminates work | DONE — row gone in <1 frame, file gone, never returns; turn/subagents/team/all generations stopped |
| 12 | Computer-use icon | DONE — window + three lights + agent cursor |
| 13 | Monitor window margins | DONE — 12 px → 31 px |

Tests: 6,421 unit tests green across 11 packages; all typechecks clean.

Follow-ups, all DONE: HyperFrames frames now stream into the chat's card as they render (`c51638c7`, 49/49 frames seen; before 0); stale probes `canvas-probe` + `round9-file-write-probe` fixed and headless (`9d0d2e38`); the dark→light flip in one probe was an E2E-only artifact (theme not applied at boot under the probe flag), not a user bug.

## Big push (tracks) — see memory `user-big-push-2026-09-23`

| Track | State | Notes |
|---|---|---|
| 1 Hindsight memory + Memory tab | research DONE (`deliverables/research/hindsight-memory.md`) | plan pending |
| 2 "bobble help" settings assistant | research DONE (`bobble-help.md`) | plan pending |
| 3 Training dashboard + export/quant | research DONE (`training.md`) | plan pending |
| 4 Linux + Windows GPU/CPU compat | research DONE (`crossplatform.md`) | plan pending |
| 5 Tailscale Devices | research DONE (`devices-tailscale.md`) | plan pending |
| 6 Harness LoRA (Qwen3.5-4B) | research DONE (`harness-lora.md`) | plan pending |
| 7 Cross-device training, Unsloth-Studio parity | research DONE (in `training.md`) | plan pending |
| 8 Studios as editors (click-to-comment etc.) | research DONE (`studios-editors.md`) | plan pending |
| 9 "antling ming 0.1" design models | research DONE (`ming-models.md`) | plan pending |
| 10 Visual output quality | research DONE (`visual-quality.md` + samples in `deliverables/visual-quality/`) | plan pending |
| 11 Custom workflows | research DONE (`workflows.md`) | plan pending |

The planner (one agent over all eleven) is writing the build plan; implementation launches from it.

## Needs the user's go (downloads / GPU)
- Hindsight measurement spike WP-M0: ~0.3 GB wheels + ~0.14 GB models, model runs on AC.
- Ming design models: first real runs (GPU-heavy) — MING-4.
- Cross-platform: a local Linux VM/container runtime (OrbStack or Colima) for smoke tests.
- Training: the decision benchmark TR-0 (model downloads + GPU).

## Blocking / notes
- On AC, battery 80%. No model servers running.
- Before/after screenshots come from a clean BEFORE build of `c9fe7098` in a scratch worktree.
