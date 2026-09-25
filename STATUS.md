# Bobble — status

Updated: 2026-09-24 (evening) · main `f56047f2` (+ this file) · **installed in /Applications: `candidate/2026-09-24` (`23a2ac12`)** = last night's candidate + the elevation, History-card and sidebar/lockup fixes below, packaged probe + smoke OK, signed with the stable identity · **the user's batch (next section) is on main but NOT installed yet** — it ships together with the two tracks still running, once they are merged and verified · the rest of the big push stays **paused for the user's testing**, except visual quality (pinned)

## 📌 PINNED HIGH PRIORITY — Visual quality (office, charts, HyperFrames) — the user, 2026-09-24
Order of work:
1. **Land Wave 1 on main, verified** — VQ-00 eval harness, VQ-01 office renderer correctness (`push/vq-office-w1`), VQ-02 chart hardening, VQ-03 palette checks, VQ-11L HyperFrames title card (`push/vq-kit-w1`). Today they exist only in the installed candidate, unverified. Before/after renders from the eval harness for every sample prompt, and the owed prefill/TTFT check on VQ-02's prompt delta (+~0.8k chars per mode).
2. **Finish VQ-08 anti-fabrication** (invented numbers, quotes, URLs and attributions flagged; WIP on `push/vq-office-w1`).
3. **Wave 2** — VQ-04 design kit, VQ-10 `diagram` tool, VQ-05 HTML → native emitters, WF-06 render-from-spec (deliverables/research/PLAN.md §10).

## Then (2026-09-24): the user's batch — generating card, density, studios that keep their job, the task tray
On main (`f600b3c7` … `f56047f2`), not in the installed candidate yet. Unit suite 2810 passing at the studio-track merge.

| Request (the user) | Before | After | Proof | Commit |
|---|---|---|---|---|
| "drop the blue 'new chat'" | the lead row's icon was the rail's one accent (blue) | gone; New chat keeps its medium weight as the lead | `sidebar-look.mjs` | `f600b3c7` |
| "the dropdowns and … the sidebar's buttons are like 1.5x as tall as the ones I see in claude/chatgpt" | rows 32px, menu items 30px, controls 26/32/40, 14px text | Mac density: rows 28px, menu items 26px, controls 24/28/36, 13px sidebar + menu text on 18px lines, section breaks a step tighter; Settings › Interface sliders still scale it. Measured in the built-in browser: chatgpt.com rows are 36px at 16px, claude.ai ~32px at 14px — the gap was to the Mac's own density | `sidebar-look.mjs` + `design-audit-probe.mjs`, before/after | `f600b3c7` |
| Dropdowns' all-round shadow — a regression from this morning's elevation pass | `shadow.edge` cut to a 2px line: the lift the user asked for earlier was gone | a soft halo again (10px light, 12px dark) | design-audit menu shots | `f600b3c7` |
| Generating card: "a distinct black background card that makes it feel raised, not lowered, but without a border, just quick but noticeable falloff" | plateless: the loader floated on the chat (the 09-17/23 choice, now reversed) | black ground on dark with a faint glow in its middle, a raised white sheet on light; no border; a short halo into the chat; the loader feathers into the ground | `pending-card-look.mjs` (ground, border, falloff) | `de9ffd6a` |
| "that terminal logging style text below it needs to go" + a bordered n% pill that "never outright lie[s]" | a sweeping bar with no number over the engine's raw tqdm line | a bordered pill bottom-right: a slope at this run's measured speed; never goes backwards; never claims a step the engine hasn't reported (slows into a late one, travels to an early one); the decode is kept for the result, so it lands on 100 with the picture; a past run is used only for the first step. Workers that only PRINT their steps (the edit path) are read from their tqdm line, which is no longer shown | `progress-estimate` tests (8), `tqdm` tests (3), per-frame pill samples incl. a late step | `de9ffd6a`, `7c377390` |
| "significantly smaller than the images generated" | 271px waiting vs 482px finished (a 4:3 picture) | 482 = 482; the handover keeps the job's shape and its number; no one-frame 200px flash | `pending-card-look.mjs` (thread size parity, handover) | `de9ffd6a` |
| (found while testing) the loader after a light/dark switch | white blocks on the light card — an empty card | the loader's ink follows the theme live | `pending-card-look.mjs`, light + dark | `de9ffd6a` |
| "leaving a studio with a generation running and then going back doesn't keep it going, or maybe it does but the UI resets" | the job ran on; the room forgot it: an empty room with a live Generate over a busy GPU, a picture finished while away never listed, a failure never shown, the 3D clock back at 0 | the job, prompt, knobs, result and error survive leaving; 3D keeps its clock; the % pill carries on instead of counting from 0 | `studio-leave-return-probe.mjs` | `50883cbe`, `7c377390` |
| "a little notifications button … to the right of the collapse sidebar button, this only appears when you leave a running task … a quick little card" | — | a bell beside the collapse button while a chat turn or studio job you left is running or finished-unseen; its slot opens with it (no gap when empty); compact card, status said once, a row takes you there | `task-tray-look.mjs` | `50883cbe`, `f56047f2` |

**Still running (two agents; not merged):**
- Thread placement — intermediate generations inside the thinking block (the generating card stays out) · Enter takes you to the bottom · ⌘Z within 3 s of sending, with the input empty, unsends and rewinds.
- Images — click a finished card to open it · copy an image and paste it into our composer · fullscreen viewer with the studio's left toolbar and a centred "Edit image" bar · plus the Image Studio Edit fix (Known issues).
- Not started (optional): ChatGPT's "gravity effect" on the generating card; the subtle glow is done.

## The big push (from 2026-09-23) — where each track stands
| Track | Status |
|---|---|
| 09-23 computer-use / vision list (13 items) | ✅ done — `c1f7d578` + follow-ups (installed) |
| Design prototypes (image editor, Devices, Workflows, Memory, Help) | ✅ 10 prototypes in `deliverables/gallery.html`, waiting on the user's critique |
| Visual quality (office, charts, HyperFrames) | 📌 pinned — see above |
| Training UI (Unsloth Studio parity) | 🟡 design brief + the 133-row parity study (`deliverables/training-ui/unsloth-parity.md`) done; the 3 prototypes not built |
| Tailscale Devices | 🟡 merged: DEV-0 safe Tailscale reads (`f299c754`), DEV-1 adapter (`e0f65c4b`), DEV-3 device store, pairing, tokens, trust policy (`5813e33c`); no UI yet |
| Linux / Windows GPUs | 🟡 XP-04 per-platform `uv` installer (in the candidate); the rest planned |
| Studios as editors (click-to-comment) | 🟡 prototypes done; the image viewer piece is being built now (Images track above) |
| Hindsight memory, bobble help, workflows | 🟡 prototypes only |
| Ming design models | 🟡 research spike merged (Ming-Image engine, `18d42c0a`) |
| Harness LoRA, cross-device training | ⚪ plan only (`deliverables/research/PLAN.md`) |

## Then (2026-09-24): the sidebar's hierarchy and the new-chat "Bobble" line
| Where | Before (measured) | After |
|---|---|---|
| Rail inks | every nav row, studio and chat title 14px/400 at 6.6:1; icons louder than labels | a row with an icon is a place → primary ink (15.1:1); chat titles stay 6.6:1; the current chat lifts with pill + primary |
| New chat | a row like any other, 48px from both neighbours | the lead action: medium weight, one row under Search (its blue icon was dropped later the same day, at the user's request — `f600b3c7`) |
| Search (compact, click to type) | 2.4:1 — fainter than the section labels, read as disabled | 6.6:1, glass in the icon ink; behaviour unchanged |
| Modalities | a 14px row over a 13px indented tree (read as a folder of chats) | the same section header as Workspace/Projects/Chats (still folds, still no icon); studios are the same rows as Workspace |
| New-chat lockup | the mark's tiles 40px beside 32px capitals (5px over the cap line, under the baseline) | tiles = capital height (1cap / 0.828), meeting cap line and baseline; gap tightened |

Commit `62a32658` (`23a2ac12` on the candidate), probe `apps/desktop/tests/e2e/sidebar-look.mjs` (per-row size/weight/contrast/gap + shots). Claude/Codex flavors: only the Modalities structure changes; their inks are untouched.
**Installed while the user's Bobble was open** (my miss: the running-check and the ship shared one command) — quit and reopen Bobble to load this build. `ship-local.sh` now quits a running Bobble first (`ea0ef232`).

## Then (2026-09-24): the History cards — "text not vertically centered inside dots and overlapping not well done dotted lines especially around the curves"
| Where | Before | After | Proof |
|---|---|---|---|
| Numbers in dots (History badges, queue dots, chips, canvas pins — both image-editor prototypes) | −0.9…+0.8px off, and different at every position: Chrome snaps a text baseline to a whole pixel but paints the circle where it falls | text trimmed to cap height + baseline, and each circle moved so the digit's baseline lands on a whole pixel: every kind within 0.25px (the measurement's step), identical at every position | 4× crops measured per kind, light + dark |
| Branch lines (both prototypes) | a dashed-border elbow drawn over the trunk (doubled dashes), a smudged rounded corner, a run that stopped short and above the dot; Direction B's spine restarted its dashes at every row and ran past the last branch | one SVG layer fitted to the laid-out rows: whole dashes per stretch, the trunk split around each fork so nothing is drawn twice, the last branch is the trunk turning (╰) | 8× fork crops |
| The app's 3D History card | one dashed line behind every dot, cut by a ring: a dash + stub in one gap, a lone dash in the next | one stretch per stage, two whole dashes and 3px of air at both dots | app markup + stylesheets at 4×; real studio card re-checked |

Commits: `2ea663a7` (app; `e3276740` on the candidate). The prototypes' fixes are in `deliverables/ui-design/_shared/` (`history-lines.js`, `number-dots.js`) + their own CSS/JS; both image-editor prototypes re-shot, gallery rebuilt.

## First (2026-09-24), since your review: "everything has the same softness" / the History card looks "flimsy"
| Where | Before | After | Proof |
|---|---|---|---|
| Every Bobble surface (theme tokens) | one diffuse blur per level (md `0 4px 14px` 9%) — a haze on all sides, no contact | contact + cast (+ ambient) stacks with negative spread; dark adds a lit top rim; `edge` 2px not a 14px glow | design-audit probe, 50 surfaces before/after |
| Overlays / menus / dialogs | 85% sheet × 0.78 translucency (≈66%) | 95% sheet × 0.92 — still frosted, no longer grey | chat menu + settings pairs |
| 3D studio floating panels (History, generate panel, tool groups, strip pill, action bar) | 70% near-white (#f9f9fb on #f5f5f7), 6% edge, History 18px corners | one overlay sheet, border-default edge, History on radius-lg (14px) | `elevation-look.mjs` (real model dropped in), light + dark |
| Four cards with hard-coded haze (install card 0 24px 60px 36%, image-stage picture, storage bar, chart tooltip) | own literal shadows — the tokens never reached them | popover / lg / lg / md tokens | install-card pair |
| Prototypes (gallery) | same soft cards + 12 proto rules edged with the divider colour | follow the live tokens; those 12 edges on border-default; **all 10 prototypes re-shot** (804 shots; the gallery shows the 437 at 1440 wide). Help (B) links the app's compiled CSS by content hash — re-pointed at the current build | `deliverables/gallery.html` |

Commits: `b493d344` (tokens + studio material), `bc44d674` (four hard-coded shadows; `fec48c2d` on the candidate), `9135cb54` (the studio probe `elevation-look.mjs`). Themes suite 27/27, token-hygiene + terminal-surface CSS tests pass.

## What is in the installed candidate (built by agents; NOT independently verified — the user tests)
Everything below plus the elevation, History-card and sidebar/lockup fixes above. main (today's computer-use/vision wave + the merged push units) plus these branches, merged cleanly:

| Unit | Kind | What it does | How to try it |
|---|---|---|---|
| W0-A pre-wire scaffold | internal | Registries and contracts for every coming feature (settings sections, routes, + menu entries, thread slots, storage rows, per-feature settings groups, 9 new package skeletons, a batch of new glyphs). **Nothing on screen should move.** Byte-identical prompt; 48/50 before/after shots identical (2 = render noise) | Use the app normally: any visual change or broken setting/sidebar/composer is a regression |
| XP-04 uv per platform | functional | The Python tool installer (uv) is now pinned and sha256-checked per OS and CPU (was: macOS arm64 tarball on every OS); Windows by OS architecture | Fresh install of a module that needs uv (Image/Audio/3D module download) still works |
| MAC-01 pi-mac vision | functional (helper) | The computer-use helper gains `--vision`: instance masks, the instance under a point, and OCR on image files | Computer use must still work as before (permissions kept) |
| SPK-02 Mage-Flow downloads | functional | The image-edit model downloads again: the withdrawn microsoft/* weights are rebuilt byte-for-byte from Comfy-Org + Qwen sources | 3D studio → Image editing, or `edit_image` in chat: the edit model downloads and runs |
| VQ-00/VQ-01 office renderers | output quality | The office renderers stop corrupting ordinary input (numbers like 22M/$38k, overlaps, blank headers, table widths) and say what they drew | Ask for a deck/doc with numbers and a table |
| VQ-02/03/11L charts + HyperFrames | output quality | Charts: each call writes its own file, `22M`/`3,100`/`$1.2M` parse, ticks carry units, size presets, sticky look; every look passes palette checks (no periwinkle); a HyperFrames title card shows the quoted words, not the prompt | Ask for charts with units; ask for a "Launch day" title animation |
| W0-B test infrastructure | dev only | Mock model server, mock web, fake Tailscale/Hindsight, one lock scheme, bench-run.sh | — |
| XP-01 probe | dev only | A probe for the guardian fix already on main | — |

Candidate-only fixes: the prompt snapshot now includes VQ-02's chart-tool wording (**+~0.8k chars per mode, ~200 tokens — a real TTFT/prefill check is still owed**); a stale fake-Tailscale test expectation.

## Design prototypes — `deliverables/gallery.html` (open it in a browser)
10 clickable prototypes, 2 directions each, 437 screens light/dark: **Image editor (click-to-comment)**, Devices, Workflows + Deep research, Memory, Bobble help. Plus the visual exemplars (deck, report, diagrams). No automated critique — the user critiques.
Training UI: the Bobble design brief is written (`deliverables/training-ui/bobble-design-brief.md`) and the Unsloth Studio parity study is done (133 rows, `deliverables/training-ui/unsloth-parity.md`); the 3 prototypes were not built before the pause. Resume: workflow `wf_de15cc75-557` (the script now stops before critique).

## Not in the candidate (on branches, WIP)
VQ-08 anti-fabrication (vq-office-w1 WIP), extra w0-b/wf-00b edits (WIP). Branch tips were recorded before the WIP commits.

## Known issues to fix next
- `deliverables/review/wave-0923-findings.md`: 6 confirmed bugs in the vision work (worst: calibration/clicked rapid-mlx rows silently switched to the vision lane) + 33 unverified candidates.
- **Image Studio's Edit never edited**: `gen:generate` dropped the input image, strength and guidance, so an "edit" was a fresh picture. Found by the studio track today; the Images track owns the fix.
- **3D studio (view-only)**: the progress bar overlaps the Finish row. Found today, not fixed.
- **VQ-02's prompt delta** (+~0.8k chars per mode, in the candidate): prefill/TTFT check owed — the pinned track's first item.
- A stale Ladle (component browser) build ships inside the app bundle, ~3 MB. Minor.

## Blocked on the user
- Testing + feedback on the candidate and the prototypes.
- CI runs need a push to the public GitHub repo (XP-03/04).
- Heavy downloads / GPU jobs (PLAN.md Q1) — none ran.
