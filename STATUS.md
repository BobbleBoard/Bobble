# Bobble — status

Updated: 2026-09-23 (2) · base commit `c9fe7098` · build on /Applications: `41cf1b60`

## Current wave — computer use / vision (the user 2026-09-23)

| # | Item | State |
|---|------|-------|
| 1 | Origin of the "TEXT-ONLY mode" note | FOUND: provider-llamacpp `unviewableImageNote`, fired because rapid-mlx ran its MTP text lane (`visionReady:false` for every MLX engine). Note now names the real cause |
| 2 | Vision on by default, switch in the engine menu | BUILT + unit-tested (`loadVision`, vision plan, Vision row). Live check pending |
| 3 | `--visual` snapshot = image only (Mac, Chrome, browser) | BUILT + tested |
| 4 | Active app persisted | BUILT + tested (honest frontmost, last app carried across chats, exact-first app match) |
| 5 | "scrolled element 5000" | FIXED + tested — label parser read a scroll distance as an element index |
| 6 | Projects open/close slides the chats | BUILT; look-probe pending |
| 7 | Open / Open with in canvas + cards | subagent finishing (new `os-open.ts`) |
| 8 | HyperFrames 120 PNG cards | subagent finishing (one APNG, encoder + decoder test) |
| 9 | Generating cards: no border, falloff, any aspect | DONE + probed: no plate/border, feathered fade into the chat, the grid is a field generated for the card's shape (40/40 anim tests; probe BEFORE 7 fails → AFTER 0) |
| 10 | "Thinking for 14m" instantly | FIXED + tested (timer keyed per chain, not `thinking:0`) |
| 11 | Delete chat instant + terminates work | DONE + tested: row hidden this frame, pi turn/subagents/team/gen+3D+SVG jobs stopped, whole chain deleted, tombstones stop resurrection (7 + 3 tests) |
| 12 | Computer-use icon (window + traffic lights + agent cursor) | BUILT; look pending |
| 13 | Monitor window margins | BUILT + tested; look pending |

Also found and fixed while on 11: deleting a chat removed only the newest file of its chain, so the next-newest file became the row — the chat came back one model-switch older.

## Big push (tracks) — see memory `user-big-push-2026-09-23`

| Track | State | Notes |
|---|---|---|
| 1 Hindsight memory + Memory tab | research running | |
| 2 "bobble help" settings assistant | research running | |
| 3 Training dashboard + export/quant | research running | |
| 4 Linux + Windows GPU/CPU compat | research running | |
| 5 Tailscale Devices | research running | |
| 6 Harness LoRA (Qwen3.5-4B) | research running | |
| 7 Cross-device training, Unsloth-Studio parity | research running (with 3) | |
| 8 Studios as editors (click-to-comment etc.) | research running | |
| 9 "antling ming 0.1" design models | research running | |
| 10 Visual output quality | research running | |
| 11 Custom workflows | research running | |

Implementation starts once this wave is committed (the user's order: finish, note the commit, then launch).

## Blocking / notes
- Battery hit 1% and the Mac hibernated during engine benchmarks (15:37); on AC since 16:06. Heavy benchmarks wait for charge.
- Before/after screenshots come from a clean BEFORE build of `c9fe7098` in a scratch worktree.
