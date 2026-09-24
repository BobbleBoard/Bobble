# Bobble — status

Updated: 2026-09-23 22:50 · **PAUSED** · main `8f52b2ce` · build on /Applications: `c1f7d578` (installed 17:32, packaged probe + smoke OK)

## Why it stopped
All five workflows stopped at about 19:35 because **the account hit its monthly spend limit** ("raise it at claude.ai/settings/usage"). This was not a crash. Every agent after that failed with the same message. Cleanup done:
- no leftover processes: no Electron, headless browser, model server or probe running;
- lock slots are free;
- 8,158 stale probe homes and profiles deleted from the temp folder (2.6 GB freed);
- in-progress changes in 6 worktrees saved as labelled WIP commits on their own branches. Nothing unverified touched main.

## Merged to main during the push (each built, independently verified, rebased, re-checked)

| Track | Package | Commit(s) | What it does |
|---|---|---|---|
| 4 Cross-platform | XP-01 | `bf167e4e` | Off macOS the memory guardian read "0 bytes free", treated that as critical and unloaded the chat model at every reading. It now reads the real machine (Linux PSI/MemAvailable, Windows); the macOS path is byte-identical |
| 9 Ming | MING-0 | `18d42c0a` | Ming-Image's engine: mlx-vlm at the Ming commit, patched and shipped as a pinned 3 MB wheel (it is not on PyPI) and wired into the worker command |
| 11 Workflows | WF-00b | `056baf83` `210225f3` `1fb4c49f` | Measured finding: DuckDuckGo refuses Bobble's search after 2 requests, even at 5 s pacing, and the refusal lasts over 30 min. Deep research must not wait it out |
| 5 Devices | DEV-0 · DEV-1 · DEV-2 · DEV-3 | `f299c754` `e0f65c4b` `0d2c988e` `5813e33c` `a5f4658c` `8f52b2ce` | Tailscale reading fixed for Finder launches; tailnet adapter (LocalAPI first, CLI fallback, whois, ping, live watch); providers send `models.json` headers/keys; device store, SAS pairing, hashed tokens with constant-time compare, trust policy, `safeStorage` secrets, 0600 files |

## Built but not merged (on branches, safe)

| Branch | State |
|---|---|
| `push/xp-04` | uv pinned per platform/arch with sha256 (pins spot-checked against the official release) + a zip extractor. Fixed after review; the second verification never ran |
| `push/w0-b` | Shared mocks (OpenAI/llama-server, web, Tailscale, Hindsight), `_locks.mjs`, `bench-run.sh`, `worktree-new.sh`. Verification found 7 issues (count-based caps, locale-proof pid check, bench orphan on SIGKILL, missing net/cargo classes, untagged output dirs); the fix never ran. + WIP |
| `push/spk-02` | Mage-Flow download source fix (the microsoft repos answer 401). Built; verification never ran |
| `push/mac-01` · `push/vq-kit-w1` · `push/vq-office-w1` | Mid-build (2–3 commits each + WIP) |
| `push/w0-a` | The pre-wire scaffold, mid-build (WIP: 155 new files, 29 modified). **Everything else in Wave 1 waits on this** |
| `bench/bench-1` | Engine-capability spike scripts written (WIP); never run |

## Research and design (on disk under `deliverables/`)
- `research/` — 10 track docs + **PLAN.md** (12 lanes, waves W0–W5, file ownership, resource plan, 28 ranked questions). Committed.
- `review/wave-0923-findings.md` — the review of today's wave: **6 confirmed bugs** (all in the vision work, 3/3 votes, unfixed) + **33 unverified candidates** (their checkers never ran). Committed.
- `ui-design/` — Image editor (click-to-comment), Devices, Workflows/Deep research, Memory, Bobble help: **2 clickable prototypes each (10), 930 screenshots in both themes**. Critique and refinement never ran. Not committed (374 MB of PNGs).
- `training-ui/` — 101 reference screenshots from the study phase; prototypes never started.
- `visual-quality/exemplars/` — exemplar deck (.pptx), report (.docx) and diagrams + 450 renders; critiques and the rulebook never ran.

## Blocked on the user
- **Spend limit** — raise it to continue. Every workflow resumes from its run id (`wf_bbdc6328-a58` build, `wf_de15cc75-557` training UI, `wf_ce6de857-d55` UI designs, `wf_b2330c71-d84` review, `wf_e80131e7-ca7` exemplars). Finished agents replay from cache.
- CI runs need your OK to push to the public GitHub repo (XP-03/04).
- Heavy downloads/GPU jobs (PLAN.md Q1): assumed yes. None ran; BENCH-1 was starting when the limit hit.

## Earlier today — computer use / vision wave: DONE
All 13 items + follow-ups: `c1f7d578` `3ab7ec95` `c51638c7` `9d0d2e38` (memory `pi-desktop-wave-2026-09-23`).
