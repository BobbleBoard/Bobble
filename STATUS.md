# Bobble — status

Updated: 2026-09-24 · **PAUSED for the user's testing** · main `9135cb54` · **installed in /Applications: `candidate/2026-09-24` (`fec48c2d`)** = last night's candidate + the elevation fix below, packaged probe + smoke OK, signed with the stable identity

## Since your review (2026-09-24): "everything has the same softness" / the History card looks "flimsy"
| Where | Before | After | Proof |
|---|---|---|---|
| Every Bobble surface (theme tokens) | one diffuse blur per level (md `0 4px 14px` 9%) — a haze on all sides, no contact | contact + cast (+ ambient) stacks with negative spread; dark adds a lit top rim; `edge` 2px not a 14px glow | design-audit probe, 50 surfaces before/after |
| Overlays / menus / dialogs | 85% sheet × 0.78 translucency (≈66%) | 95% sheet × 0.92 — still frosted, no longer grey | chat menu + settings pairs |
| 3D studio floating panels (History, generate panel, tool groups, strip pill, action bar) | 70% near-white (#f9f9fb on #f5f5f7), 6% edge, History 18px corners | one overlay sheet, border-default edge, History on radius-lg (14px) | `elevation-look.mjs` (real model dropped in), light + dark |
| Four cards with hard-coded haze (install card 0 24px 60px 36%, image-stage picture, storage bar, chart tooltip) | own literal shadows — the tokens never reached them | popover / lg / lg / md tokens | install-card pair |
| Prototypes (gallery) | same soft cards + 12 proto rules edged with the divider colour | follow the live tokens; those 12 edges on border-default; **all 10 prototypes re-shot** (804 shots; the gallery shows the 437 at 1440 wide). Help (B) links the app's compiled CSS by content hash — re-pointed at the current build | `deliverables/gallery.html` |

Commits: `b493d344` (tokens + studio material), `bc44d674` (four hard-coded shadows; `fec48c2d` on the candidate), `9135cb54` (the studio probe `elevation-look.mjs`). Themes suite 27/27, token-hygiene + terminal-surface CSS tests pass.

## What is in the installed candidate (built by agents; NOT independently verified — the user tests)
Everything below plus the elevation fix above. main (today's computer-use/vision wave + the merged push units) plus these branches, merged cleanly:

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
Training UI: the Bobble design brief is written (`deliverables/training-ui/bobble-design-brief.md`), the Unsloth Studio study was in progress; the 3 prototypes were not built before the pause. Resume: workflow `wf_de15cc75-557` (the script now stops before critique).

## Not in the candidate (on branches, WIP)
VQ-08 anti-fabrication (vq-office-w1 WIP), extra w0-b/wf-00b edits (WIP). Branch tips were recorded before the WIP commits.

## Known issues to fix next
`deliverables/review/wave-0923-findings.md`: 6 confirmed bugs in the vision work (worst: calibration/clicked rapid-mlx rows silently switched to the vision lane) + 33 unverified candidates.

## Blocked on the user
- Testing + feedback on the candidate and the prototypes.
- CI runs need a push to the public GitHub repo (XP-03/04).
- Heavy downloads / GPU jobs (PLAN.md Q1) — none ran.
