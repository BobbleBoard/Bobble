# Bobble — status

Updated: 2026-09-25 (night, on AC) · main `741d317d` · installed `c034085d` (16:15) — tonight's 18 commits are not installed yet · the user: "keep going on the list, bugs can go first, verify", then "make ggufs using unsloth dynamic … test that against the current 4b omnisvg", "test some math/physics/chemistry practice problem requests … add a teach skill.md" — the per-kind visual suite ran (4B) and every defect it showed has a fix; the SVG bake-off and the STEM run are in the heavy queue

## Report — 2026-09-25 night: the per-kind visual suite, and the user's two new asks

**How it was checked.** The 15-task visual suite ran on the 4B (qwen3.5-4b-mtp, rapid-mlx, bash-CLI) at build `4eb34a58`/`f6f1d565` — one real turn per kind, the chat screenshot, every picture the model was handed saved (`PD_DIAG_PRESENT_DIR`), prefill per request. Each defect below was reproduced in that run, fixed, and re-run on the 4B (`suite-4b-rerun`: website, nn-widget, icons, intro-anim, math-anim, game-asset) or checked live without a model where one is not needed (office look, server stop, page problems, contact sheets). Suites: harness 1,850 · desktop 3,552 · gen-tools 56 · typechecks and biome clean.

### F. The visual suite (4B) — what each kind produced, what was wrong, what changed
| Task | First run | Fix | Re-run |
|---|---|---|---|
| intro-anim ("6-second animated intro for 'Byte Sized' — playful, title bouncing in") | 488 s, capped: four `media generate image` calls (one saved as `.mp4`), no animation | `f65b8b20` generate_video gets the guideline generate_image had; `d7dff216` HyperFrames reads "bouncing/playful" (letters drop in on a stagger, squash, settle); `e0c04844` "colorful" is a bright run, a clip is as long as its prompt says (was 5 s for "6-second") | 156 s: `media generate video` → a HyperFrames APNG of "Byte Sized" bouncing in (frames looked at) |
| math-anim (Pythagorean rearrangement) | wrote an animated SVG; the diagram guard refused it toward Mermaid; turn ended | `2d2671ee` markup that animates is never a diagram; `f65b8b20` svg answers a prompt that IS markup instead of sending it to OmniSVG | wrote and presented `pythagorean_proof.html`; capped while rewriting it (the partial-rewrite guard held three whole-file rewrites) |
| game-asset (low-poly treasure chest) | "I don't have access to 3D modeling software" + an offer to write vertex data in Python | `ee34d2ba` a prompt line (re-run: made a PICTURE and called it a model — worse) → `fd4f7cf8` with 3D in the app but off, `3d generate` exists and answers how to turn it on; the line is gone | line: failed as above · command: in the next heavy run |
| icons (six line icons) | `svg recipe-app-icons --icons timer,…` ×3 — a slug prompt and a flag svg does not have | `06929516` a flag the command lacks is named in the result; `f65b8b20` caption-style svg prompts | 94 s, 0 errors: wrote six SVGs — which draw NOTHING (shapes nested in a `<path>`); presented as a folder listing, so unseen → `e0c04844` a folder of pictures comes back as a captioned sheet, and a picture that draws nothing is named (sheet rendered from the real six: six blank cells) |
| website (Kiln & Co landing page) | photos hotlinked from recalled Unsplash ids — the hero a bathroom | `f65b8b20` a guideline line (re-run: hotlinked again, "All images are sourced from Unsplash") → `fd4f7cf8` present names a page's pictures that load from addresses nothing in the chat gave the model | line: failed · note: in the next heavy run |
| nn-widget | 489 s, capped: `python3 -m http.server` in the foreground held the turn 5 min | `ee34d2ba` a command whose own process listens on a port and has gone quiet is stopped in seconds (no command list); the clock's explanation, dead since it was written, now fires | 197 s, 0 errors (no server this time); the stop verified with pi's real bash: http.server stopped at 6.6 s, the port freed, a quiet `sleep 9` untouched |
| deck / budget / report | the model saw a 440-px pane: slide 1 at 29 % zoom; three columns | `e0c04844` + `319fcf7c` a look of its own on a hidden editor: every slide on one sheet, a workbook or document wide | office-look-probe on the suite's own files (looked at): 8 slides legible (slide 8's empty body now visible), all columns (every value 0, the chart empty — visible now) |
| report "with sources" | no research; five made-up references; the reply promised "source citations" | `741d317d` office make names a brief's sources that nothing read in the chat backs | in the next heavy run |
| fourier / nn-widget (a canvas that drew nothing) | a screenshot cannot show a script that threw | `e0c04844` a rendered page reports its console errors, exceptions and failed loads | live: a broken page reports `Uncaught TypeError … getContext (line 5)` and `missing-picture.png failed to load`; the suite's Fourier page reports none |
| intro-anim's look | the model was sent the 14 MB APNG — a decoder shows frame 0, an empty card — and described "the title bouncing" | `e0c04844` an animation is six moments on one strip, with their times | tests (frames byte-exact); live in the next run |
| dataviz / image / email / research / svg-art | chart JSON series, blank render-back, CLI placement, announced step, save_to — fixed earlier tonight (`397d3490`, `f6f1d565`, `1ba47daf`, `395e0810`, `42f670f6`) | — | svg-art ran `rm -rf ~/Desktop/lighthouse-blog-header` (made empty folders only; removed) — bash is unrestricted by design, noted |
| template debris | `coordinate present --path=index.html "</parameter"` on 3 of 15 tasks | `06929516` a word that is only a tool-template tag is dropped | — |

**Prefill (the prompt changes):** the video guideline, the page-photos sentence and (since removed) the not-set-up line: the system prompt is 10,224 characters; first-token probe on the 4B: 372 ms, 3,571 of 3,689 prompt tokens from the warm prefix, no re-prefill. The teach skill never enters the system prompt (it rides beside the one message that asks, once per chat); its cost is measured on the STEM run.

### G. the user's new asks (evening)
| Ask | State |
|---|---|
| "make ggufs using unsloth dynamic ideally, run q6_k_m for all" | ✅ `tools/gguf-export` (`4930c820`): llama.cpp has no Q6_K_M; Unsloth's Q6 is UD-Q6_K_XL — its per-tensor recipe read off Unsloth's own GGUF headers for each base (attention q/k/v at Q8_0 in every layer, ffn_down in 10 layers and gate/up in 5 at Q8_0, embeddings Q8_0, the rest Q6_K) and applied to the fine-tunes. VFIG-4B 3.66 GB and IntroSVG-7B 6.96 GB — exactly Unsloth's base sizes; HiVG-3B 3.03 GB (+0.26 GB: its own output head). Downloads deleted after; the training dashboard's export is design-only (TR-10/11), so this is the piece it will call |
| "test that against the current 4b omnisvg both for image and text and both to svg along with editing existing competently" | 🟡 running: 4 models × (10 text, 6 image, 4 edit), each in its authors' own prompt and sampling. Smoke: on the kinetic-theory figure VFIG rebuilt it with every label as text (one stray dashed diagonal); OmniSVG drew a circle; IntroSVG a box |
| "test some math/physics/chemistry... practice problem requests … add a teach skill.md … detect and inject automatically" | 🟡 built, run queued: `fd4f7cf8` a bundled MIT skill (IES practice guide, Rosenshine, Mayer, Tversky; worked steps, a labelled figure when the problem has a shape, animation only for change, practice to finish), in Skills (new "Learning" category), and attached by the harness once per chat beside a message that asks to learn or sets a problem. Five STEM tasks in the suite, the first with the Fig. 3.1 figure attached |

## Report — 2026-09-25 evening (the user: "a table documenting the bugfixes/suggested worktree runs")

Every row below was reproduced first (a failing test, or a probe/filmstrip on the old build), fixed, and re-checked; images were looked at for anything visible. Suites on main now: desktop 3,536 · harness 1,803 · ui 429 · mac-computer-use 263 · gen-service 194 · gen-tools 52 · gen3d-engine 43 + 104 Python · canvas 384. Typechecks clean.

### A. Worktree runs (agents, each in its own git worktree, merged by me after its suites + images)
| Run (branch) | Scope | Result | Merged | Verified by | Left open (and what happened to it) |
|---|---|---|---|---|---|
| Mermaid lane (`worktree-agent-adc1dccca7ef8a3e7`) | Bobble's own diagram look, live build, card build-in | done | `729d0845` | diagram-build-look, chart-build-film, arrival-film, turn-cards/pending-card looks | class empty compartment → `7d15b07b`; class arrows side-on → `0bfbbbac`; line/area glide → `407386de` (all fixed by me) |
| Vision wave review (`worktree-agent-aa22dc2e86494f458`) | the 6 confirmed vision bugs + the 33 candidates in its area | 12 real, fixed | `ac453f51` | failing test first for each | — |
| Chat delete, run 1 (`worktree-agent-af6b22f6899fa940b`) | 10 review findings | 10/10 confirmed, fixed | `e7bf6741` | 25 new tests; wave-0923-look + chat-projects-probe on main; real pi: abort not acked in 6 s with a question open, 10 ms after "no answer" | 4 follow-ups → run 2 |
| Chat delete, run 2 | Stop waited for generations; talk_to_manager ignored Stop; silent failed delete; lingering Download wait; production nesting | 4/4 confirmed, fixed | `b846a019` | stop-generation-probe (schemas 68 ms, CLI 153 ms, job released), delete-refused-look, pi-level checks | 300 s bash clock would cancel long renders → `363613e3`; "1 image failed" after Stop → `389b4e0c` (both mine) |
| Computer use, run 1 (`worktree-agent-a26ea1a27f3a5ebd1`) | 9 review findings (2 high) | 9/9 confirmed, fixed | `8849f3c9` | 26 new tests, Swift compiled | 3 pre-existing → run 2 |
| Computer use, run 2 | Chrome page commands had no consent gate; a bare look could land on Bobble; one chat's turn end cleared another's overlay | 3/3 confirmed, fixed | `4aea7524` | 13 new tests, helper rebuilt (15:06) | named-app routing + wording → run 3 |
| Computer use, run 3 | a named app lost to the controlled one; header wording; `mac_type` description | 3/3 fixed | `08dd2d06` | 8 new tests | the description change needs a live prefill check (queued) |
| Renderer, run 1 (`worktree-agent-a78959c4c199e1470`) | 8 review findings | 8/8 (R3 partly fixed already) | `dcff54e4` | live-frames / loader-loop / audio-handover / studio-cards looks, re-run and looked at on main | thread bugs → run 2 |
| Renderer, run 2 | the 4 thread bugs | 3 fixed, 1 refuted (⌘Z keeps partial: not on today's code, real pi, both provider paths) | `140d6309` | turn-card-move-look (1 element, 0 regrow frames; was 3 and 133), reply-embed-look, unsend-real-pi-probe; widget-inline-look after the portal change | the model lost its folder after ⌘Z → suggested task `task_ec6092f8` → fixed by me `336771cc`, chip withdrawn |
| Side sessions (suggested runs from 09-24) | `claude/nice-hertz-e0f8aa`, `claude/elated-chatelet-abe541`, `claude/gallant-burnell-c0f392` | finished on branches | `1e85a6af`, `8f4182a2`, `c4864a80` | harness 1,796, inference 396, model-fit-ui-probe (hub looked at) | — |

### B. Harness fixes today
| Bug | Fix | Verified by |
|---|---|---|
| A CLI command escaped its tool's own tool_call rules | `1e85a6af` | harness suite |
| `uv run --with` launches died offline 10 min after resolving | `c4864a80` | inference suite, dead-proxy recipe |
| After ⌘Z or an edit past the turn that told the model its working folder, the model lost it for good | `336771cc` the branch's own notes decide what was told | fork-session 6/6, new case fails on the old rule |
| Stop waited for a running generation (gen tools ignored pi's abort); a killed CLI command orphaned its job | `b846a019` (2cdc2bd7, ca87aba9) — Stop cancels, as delete does | stop-generation-probe in the real app |
| talk_to_manager ignored Stop | `b846a019` (3bec4684) | pi acks in 3 ms, the app sees the hang-up 1 ms later |
| …which would have cancelled any render over bash's 300 s clock (a video took 521 s) | `363613e3` media/svg/3d commands get 30 min in CLI mode | index.test (media gets it, a build and `echo media` do not) |
| Computer use: 15 findings across three runs (Chrome took control from the chosen app; carried-over control ended other chats' driving; no consent gate on Chrome's page commands; looks landing on Bobble; …) | `8849f3c9`, `4aea7524`, `08dd2d06` | mac-computer-use 263 (47 new) |
| A heavy job that began on AC ran on into the battery (an agent saw 2%) | `4e88ea6f` with-lock pauses the job's process tree on battery, resumes at AC | _locks.test, live S→T→S |
| gen3d-engine Python tests failed 2/104 on macOS's Python 3.9 | `16e519e3` they run on the engine's uv 3.12 | 104/104 |
| Flaky under load: abandon-chats' module re-import hook (10 s) | `6b085cad` | full suite green under a model run |

**Prefill:** no always-on prompt text changed today. `mac_type`'s description changed (schemas mode with computer use on only, −7 characters; CLI mode lists just its unchanged first line) — the live prefill check is queued behind the OmniSVG reference. The re-sent folder note after a rewind is ~30 tokens, once.

### C. UI/UX fixes today
| Bug | Fix | Verified by (looked at) |
|---|---|---|
| "why such a pale blue for the notifications?" | `23d21af6` `--pd-status-*-solid` | tray-transfers-look, notif-redesign-probe |
| Diagrams: triangle arrowheads, wandering curves, shiny borders | `33752a35` open chevrons, elbows through labels, solid 1.5 px borders | diagram-page tests, inline-diagram-probe |
| Class/ER lines met their boxes aslant (every kit) | `0bfbbbac` | new "every line meets its boxes square": fails on the old page, passes 6 kits × 2 modes |
| A class with no methods kept a divider over nothing | `7d15b07b` | renders |
| Line/area charts redrew instead of gliding | `407386de` | chart-build-film CHART_TYPE=line filmstrip |
| A light app's report wore a black status bar; docs warned "Missing document fonts" | `420ea136` | office-render-probe (both directions) |
| A finished card remounted into the chain (bars regrew 133 frames) | `140d6309` | turn-card-move-look filmstrip |
| A picture presented and embedded showed twice | `140d6309` | reply-embed-look |
| A chat's generating card showed a studio's clip; the loader blanked on resize, ignored Reduce Motion, ran rAF forever; the sound card popped; a corp thought's clock started at 30m | `dcff54e4` | the four renderer looks |
| Delete: not instant/final in 10 ways; a refused delete said nothing | `e7bf6741`, `b846a019` | wave-0923-look, delete-refused-look ("Couldn't delete “trip plans for march”… permission denied") |
| After Stop the chain said "1 image failed" in red | `389b4e0c` orange "Stopped", "1 image stopped" | activity-mapping + chain tests (fail on the old code) — not in the installed build yet |
| The Ladle component browser (3 MB) shipped in the app | `68cf0219` | installed asar: 0 `.ladle`, 0 stories entries |

### D. Visuals status (the 09-24 request)
| Kind | State today |
|---|---|
| Diagrams | ✅ look, live build, elbows, square class/ER lines |
| Charts | 🟡 live growth for bars AND lines; no model-driven run yet |
| Interactive widgets | 🟡 built (`14a91cc6`), live in the chat, survive the card move; no model-driven run yet |
| Images: look back | 🟡 generate_image and edit_image hand the model a small look (`ee33de15`) |
| SVG (OmniSVG) | 🟡 measured, two causes fixed (below); characters still weak — the bf16 reference is running |
| Office (pptx/docx/xlsx) | 🟡 renderer fixed (fonts, theme sheets); no model-driven run |
| Website, UI screens, math/NN, animations, mixes, 3D for games, Ming 0.1 | ❌ not verified — the 16-task visual suite (one real turn per kind, screenshots, prefill per request) is next in the heavy queue |

**OmniSVG, measured today** (the authors' 19 prompts + our 4 + 4 caption rewrites, 3 samples each, the app's own Q8 pipeline):
| Finding | Number | Fix |
|---|---|---|
| Icons from their prompts | clean (heart, star, arrow, checkmark, thermometer, database, monitor, bookmark) | — |
| A sample loops on one zero-length command to the token limit | 25% of their prompts, 50% of ours/captions | `00b88aed` loop guard: cut at the loop, draw again (3 more tries) |
| llama-server's sampler chain ≠ theirs (min_p 0.05, temperature last, 64-token penalty window) | 25% → 17% looping with theirs | `b13ec0ec` |
| The icon/illustration rule was not theirs | their icon prompts sampled as illustrations | `dd9284bf` |
| Terse prompts ("a fox", "a coffee cup icon") | junk; the same as captions draw clean marks (kiln, cup) | the tool's prompt guidance → caption style (queued with a prefill check) |
| Characters/scenes | weak at 1,536; some recognisable at 2,048 (a bust silhouette, two avatars), 46% still loop | — the model's own limit (next row) |
| **The authors' own bf16 PyTorch pipeline, same 19 prompts** (their `generate` settings, run on this Mac, 17:00) | **loops 26% (ours 25%, with their sampler 17%); icons equal to ours; characters equally hit-and-miss** (it drew a clean avatar and the pink-✕ scene where ours missed, and missed the running figure and the silhouette where ours drew them) | **the conversion and our pipeline are at parity with theirs.** Their showcase characters are best-of-many picks. What is left is how the chat model uses it: caption-style prompts, and single icons/pictograms/marks + tracing (its strengths) over characters — the guidance change is next after the suite's baseline (with a prefill check) |

### E. The overall request, by request
| the user asked | State |
|---|---|
| "omnisvg should be really good … figure this out" | ✅ figured out: our Q8 pipeline is at parity with the authors' own bf16 pipeline (loops 25% vs 26%, icons equal, characters equally hit-and-miss); the loops are cut and redrawn now, the sampler is theirs; the remaining lever is caption-style prompts from the chat model (queued after the suite) |
| "why such a pale blue" | ✅ |
| "custom mermaid arrows and box styling … animate/build in real time" | ✅ |
| "arrows should not be triangles … elbow arrows … clean solid borders" | ✅ (and class/ER) |
| "status for everything else … I don't believe it's totally all finished" | ✅ recalled (the list below), kept current |
| "keep going on the list, bugs can go first, verify" | ✅ bugs: 39 review findings + 4 thread bugs (1 refuted) + 10 follow-ups the agents found + 17 of mine, all verified; the open ones are listed under Open bugs. Next: the visual list |
| "add to the harness + ui/ux report + visuals status + overall … a table documenting the bugfixes/suggested worktree runs" | ✅ this section |

## Morning 2026-09-25 (the user back)
| Item | State |
|---|---|
| "why such a pale blue for the notifications?" | **Done** `23d21af6`: progress bars + unread dots use a new per-theme `--pd-status-*-solid` (the hue at full strength, #0a84ff on Bobble dark) instead of `fg`, a text colour lifted toward white on dark. tray-transfers-look + notif-redesign-probe green, looked at. |
| "omnisvg should be really good … figure this out" | **Two causes found and fixed (evening), the reference still running.** (1) A quarter of all samples (25% of the authors' prompts, 50% of caption rewrites) looped: one command of no length repeated to the 1,536-id limit — fixed by a loop guard that cuts the sample where the loop begins and draws another (`00b88aed`), and by sampling with the authors' chain instead of llama-server's (`b13ec0ec`; 25% → 17%). (2) Terse prompts ("a fox") draw junk where a caption ("A dark gray kiln with an arched opening and a gold flame inside, simple flat logo mark") draws a clean mark: the icon/illustration rule was also not theirs (`dd9284bf`). Characters are still weak in our pipeline either way — the bf16 PyTorch reference (their exact code) and a 2,048-token run decide whether that is the Q8 conversion, the length, or the model. **Before:** The authors' own 18 prompts through OUR app pipeline (Q8, their instruction, their sampling): **icons are clean** (heart, star, arrow, checkmark, thermometer, database, monitor-with-bars, bookmark — p00–p10), **characters and scenes fail** (a lone background circle, a dot, nothing — p11–p17), mostly by running 1,536 tokens on one path (`stop=limit`). Upstream caps at 1,536 too (config.yaml; the demo's default), so the cap is not the gap. Found and fixed on the way: the app's icon/illustration rule was not theirs (`dd9284bf` — their own icon prompts were sampled as illustrations). Still to measure (queued, paced on battery, resumed 15:40 on AC): llama.cpp's sampler vs HF's (min_p 0.05 default, a 64-token repeat window vs the whole history, temperature last vs first — the `hflike` set) and their bf16 PyTorch reference on the same prompts. **Earlier:** The side-by-side waited for AC all morning (battery) and died with the session at ~11:40; re-queued behind AC + an idle machine. Everything below still stands. **Earlier:** Ruled out, measured: the GGUF conversion (embedding rows identical to OmniSVG's own checkpoint, cos 1.0000; the matrix is tied, as their config says), prompt tokenization (llama-server parses `<\|im_start\|>` as specials). Our "fox" fixture decodes to a red abstract shape; the authors' demos are clean flat icons and characters. Suspects: our prompts (terse/abstract, with text) vs their caption style, candidate choice (eos-first favours short drawings; 1,536-token cap vs their 4,096 table), sampler order. A side-by-side (our Q8 pipeline ×2 samplers vs their bf16 PyTorch pipeline, same prompts) is queued behind the AC-power gate. |
| "arrows should not be triangles, beveled tip/tail clean and curved path eg. elbow arrows … clean solid borders no shininess" | **Done, on main `33752a35` (built, not installed):** every arrowhead an open ">" stroked like its edge (round caps/joins, point on the border); flowchart + state-diagram edges re-drawn as elbows from dagre's own points — straight when boxes share room, a decision's branch from its corner, a loop round the side its label is on, labels riding on the route (matched by id), each route checked against boxes, placed labels and earlier edges; solid 1.5 px borders, flat fills. diagram-page tests 50/50 (7 new), inline-diagram-probe OK. **Not re-verified:** the hand-over glide (a game held the GPU at 10 fps during both runs). Class/ER keep Mermaid's routing (their UML marks are placed for it). |
| "custom mermaid arrows and box styling … animate/build in real time" | **Done, on main `729d0845`, installed:** Bobble's own diagram look over Mermaid's (chevron arrowheads, hairline rounded boxes, edge-label pills; six kits × light/dark × flowchart/sequence/state/class/ER, contrast guard green); the card builds live from the streaming `source` (parts matched across frames: new ones pop in, edges draw, moved ones glide; longest frame 16.5 ms) and hands over in place (0 px); charts ease to each new height; small SVGs draw in (<0.7 s); file and Sources cards rise in; nothing replays on a chat switch; reduced motion honoured. Plus `66c1c092`: the chain's wait row grows in / folds away, so a card beneath it glides when a tool answers (largest single-frame move 34 px → 3.2 px). Tests: ui 427, desktop 3,365, canvas 384; probes diagram-build-look, chart-build-film, arrival-film, turn-cards-look, pending-card-look, image-viewer, inline-diagram green on main. Not fixed (reported by the lane): a class with only fields or only methods keeps a thin empty compartment; step-routed class arrows enter side-on in two kits; line/area charts redraw rather than glide when a point is added. |

## Afternoon 2026-09-25 — the bug pass (each one reproduced, fixed, re-checked)
| Bug | Fix | Verified by |
|---|---|---|
| Side sessions' work sitting on branches | merged: `1e85a6af` (a CLI command held to its tool's own tool_call rules), `8f4182a2` (Download asks for the pinned file; hub quants; model-fit probe), `c4864a80` (uv launches offline-first) | harness 1,796, inference 396, gen3d-engine 43, gen-service 188, desktop 3,406; model-fit-ui-probe OK (looked at the hub) |
| Docs made by Bobble opened with "Missing document fonts: Cambria, Calibri" | `420ea136` docx_fonts.own_fonts in both docx builders | new test fails on the stock template, passes after; office-gen 184/184; the canvas status bar now "Opened report.docx" (looked at) |
| (found while looking) a light app's report wore a BLACK status bar after the theme had been dark | `420ea136` office-css-swap: an editor's theme sheets are swapped, not piled up | office-render-probe flips dark→light with the report open: FAIL rgb(21,21,23) before, PASS rgb(243,244,246) after, dark still dark |
| A class with fields but no methods kept a divider over a blank strip | `7d15b07b` divider removed, rows centred | renders looked at (two kits); electron/gen 364 |
| Ladle build (3 MB) in the app bundle | `68cf0219` excluded in electron-builder.yml | to confirm with the asar listing at the next packaging |
| Diagram hand-over glide (couldn't be judged under the game's load) | — | re-run idle: longest frame 9.3 ms, card's largest step 3.3 px, drawing moved 0 px |
| office-render-probe's 1/15 chip flicker | — | passed 15/15 three times today; intermittent, left open |
| The review of the 09-23 wave: 39 findings in four areas | merged, each reproduced by a failing test first: vision 12 `ac453f51` · chat delete 10 `e7bf6741` · computer use 9 `8849f3c9` · renderer 8 `dcff54e4` (one chat-jobs.ts conflict, both sides kept) | desktop 3,484 tests (292 files), mac-computer-use 242, pi-mac 37, both typechecks; wave-0923-look + chat-projects-probe (delete is instant and final), real pi: an abort with a question open is not acked in 6 s, acked 10 ms after the "no answer" the fix sends; live-frames, loader-loop, audio-handover, studio-cards looks OK (looked at) |
| Line and area charts redrew instead of gliding | `407386de` every named label keeps a point level with the last value while typed; line, area and dots ease | PendingChartCard 7/7; chart-build-film CHART_TYPE=line: one path shape throughout (filmstrip looked at). `d71dee0d`: the probe threw after its checks for a line (frames.json never written) |
| Class diagram UML marks and ER crow's feet met their boxes aslant (every kit) | `0bfbbbac` class and ER lines take the elbow pass: square out and in, the UML mark's gap kept, multiplicities carried | diagram-look's new "every line meets its boxes square": FAILS on the old page (4 aslant ends per kit), passes 6 kits × 2 modes × every sample; before/after looked at |
| gen3d-engine Python tests failed 2/104 on macOS's Python 3.9 | `16e519e3` they run on the engine's own uv 3.12 (+ numpy, scipy, Pillow); a file-level Skip no longer crashes the runner; CI gets setup-uv | 104/104 (was 102/104), same 11 worker-venv skips |
| The thread bugs (a card remounting into the chain, a picture twice, ⌘Z keeping a partial, an image-only rewind) | `140d6309`: a presented card moves as the same element (portal + slot, a 320 ms glide); a presented+embedded picture shows once; a picture sent alone rewinds out of pi's session. ⌘Z-keeps-partial REFUTED against the real pi (both provider paths) | turn-card-move-look (1 element, 0 regrow frames, was 3 and 133), reply-embed-look, unsend-real-pi-probe, widget-inline-look after the portal change (the widget keeps its state), turn-cards/pending-card looks; looked at |
| Follow-ups the fixes surfaced: Chrome's page commands had no consent gate; a bare look could land on Bobble; one chat's turn end cleared another's overlay; a named app lost to the controlled one | `4aea7524`, `08dd2d06` | mac-computer-use 263 (21 new), Swift helper rebuilt |
| …Stop waited for a running generation; talk_to_manager ignored Stop; a failed delete was silent; a stopped job's Download wait lingered | `b846a019` (Stop cancels, as delete does) + `363613e3` (a generation command gets a 30-min clock in CLI mode, so the new reach does not cancel a 521 s render) | stop-generation-probe (schemas 68 ms / CLI 153 ms, job released), delete-refused-look; harness 1,803 |
| After a ⌘Z or edit past the turn that told the model its folder, the model lost it | `336771cc` the branch's own notes decide what was told | fork-session 6/6 (new case fails on the old rule) |
| A heavy job that started on AC ran on into the battery (an agent saw 2%) | `4e88ea6f` with-lock pauses a running heavy job's whole process tree on battery (SIGSTOP), resumes at AC | _locks.test 26/26; live bash+sleep tree S → T → S |

## Everything NOT finished (2026-09-25 midday) — the user: "I don't believe it's totally all finished"
**The visual push (the user, 09-24 night) — per kind:**
| Kind | State |
|---|---|
| Website (images as backgrounds, scroll features, SVG, UI) | ❌ not worked on beyond the SVG unblock; not verified |
| UI (app-like screens) | ❌ not started |
| pptx / docx / xlsx | 🟡 renderer-from-spec fixed (fonts, citations, Sources slide/sheet, multi-sheet); the "Missing document fonts" warning fixed (`420ea136`); no model-driven run |
| Charts / dataviz | 🟡 VQ-02/03 fixes + live growth, lines and areas glide too (`407386de`); no model-driven run |
| Diagrams | ✅ tool, look, live build, today's elbow/arrow/border restyle; class and ER lines square too (`0bfbbbac`) |
| Math explanations, math animations, NN inner workings | ❌ not started |
| Animations (HyperFrames) | 🟡 title-card fix only |
| Interactive widgets inline + canvas | 🟡 built `14a91cc6`: a presented one-file page with something to use (canvas/svg/controls/script, ≤64 KB, not page-like) runs live in the chat, sized to its content, light and dark (widget-inline-look: gradient-descent fixture, a click, the fit). No model-driven run yet |
| SVG icons / artwork | 🟡 policy + render-back done, no model run since; OmniSVG quality open (above) |
| Images: observe + improve loop | 🟡 generate_image and edit_image both hand the model a small look (~384 px) at what they made (`ee33de15`); no loop work beyond that |
| 3D for games (generate, rig, retopo) | ❌ not touched in the push |
| Sources UI | ✅ chips, hover card, Sources card — but the 4B puts research into notes.md 3 of 4 times (unfixed) |
| Mixes (deck with diagrams + data + images + animation; site with images + SVG + UI) and improve-loops inside a big task | ❌ not started |
| Ming 0.1 (models + pptx skill) | ❌ not started (only the earlier engine spike, 18d42c0a) |
| One generation per kind "you're proud of", + the quick-email control | ❌ not done (the suite stopped at the time cap) |

**The 09-23 tracks:** Hindsight memory, bobble help, workflows — prototypes only · training/Unsloth parity — brief + parity study, 3 prototypes not built · Linux/Windows GPUs — uv installer only · Tailscale Devices — backend merged, no UI · studios as editors — prototypes + the image viewer's Edit bar · harness LoRA — plan only · the 10 design prototypes — waiting on the user's critique.

**Side sessions (finished, NOT merged to main):** `claude/nice-hertz-e0f8aa` (a CLI command held to its tool's own tool_call rules), `claude/elated-chatelet-abe541` (Download asks for the pinned file; the model-fit probe drives the hub; includes `claude/vigorous-ellis-7c0351`'s one-row-per-model quants), `claude/gallant-burnell-c0f392` (every `uv run --with` starts offline). The gen3d-on-Python-3.9 test task left no branch.

**Open bugs:** ~~the 39 review findings~~ (all merged, above) · the office chip flicker (1/15) · rapid-mlx never lands the paste prime (~4.5k tokens re-read) · ~~the thread bugs and their follow-ups~~ (merged, above) · img2img edits are subtle (the real instruction editor needs the 3D engine) · ~~empty class compartment; class arrows side-on; line/area redraw~~ (fixed) · the OmniSVG catalog repo (Lavanuke/OmniSVG1.1_4B-GGUF) does not exist on the Hub, so a fresh install cannot download it (needs a write token) · Ladle build excluded (`68cf0219`), to confirm in the next packaged bundle.

## Overnight 2026-09-24/25 — the visual-output push (the user: "start working on the visuals (high priority) the model can produce …")
Merged on main (`bacdca5f` … `2c794eae`), unit suites 8,234 pass (the 2 gen3d Python tests on system Python 3.9 still fail — a separate task is fixing that):

| Area | What landed | Verified by |
|---|---|---|
| Inside the thinking block | What a turn makes stays in its work (240px, clickable, no hover controls); only what the model PRESENTS comes out as the full card; chart/diagram tools present what they draw; the handover into the chain is one animated box | turn-cards-look, pending-card-look, image-viewer-probe |
| SVG | The OmniSVG-only fence is gone: the model writes icons, logos with a name, patterns and page glyphs; `present` renders an SVG back as a picture (it went back as source text); OmniSVG is for organic art and tracing | handwritten-svg tests; the 9B baseline that exposed it |
| Diagrams (VQ-10) | `diagram` / `diagram_edit` on bundled Mermaid, six design kits (VQ-04), inline card | inline-diagram-probe 17/17; 4B flow brief 19–23 s → 1 card (was: 420 s cap) |
| Sources | Citation chips (favicon + site, "+N"), hover card, Sources card with Show all, compact search rows in the chain | sources-look; a real 4B research run with a Nature chip |
| Office (XP-16, WF-06) | Bundled OFL fonts; `office.py render --spec` with citations, a Sources block/slide/sheet, multi-sheet workbooks | pytest 166; office-render-probe 14/15 (see open issues) |
| Paste / drop | Any files, folders and pictures natively (real paths; pixels saved once); your own pictures open in the viewer; the custom-instructions re-prefill fixed (5,050 → 133 tokens) | attach-anything-probe, image-viewer-probe |
| Evaluation | `visual-suite-probe.mjs`: one fresh chat per request across every kind + a quick-email control, screenshots, engine accounting; stops a capped turn | — |

Prefill after everything: CLI 3,419 of 3,537 cached, schemas 5,091 of 5,209, 118 computed each (unchanged).

**Not done:** the per-type live verification. The first suite run (9B) lost seven tasks to one stuck turn (fixed in the probe); the second (4B) was stopped at 08:14 on its first task to respect the time cap. Ming-Image-0.1-Design was not started (the agent was stopped before downloading). Inline HTML widgets (presented .html in the chat) are a small, clear next piece: `InlineWidget` already renders html and the harness runs scripts.

## 📌 PINNED HIGH PRIORITY — Visual quality (office, charts, HyperFrames) — the user, 2026-09-24
Order of work:
1. ✅ **Wave 1 landed on main, verified (2026-09-24 night, `d15ee83b` + `97e9ed82`)** — the eval harness judged main and the merged branch with the same ruler: "22M" drew as **3** and "$1.2M" errored → 22,000,000 and $1.2M/$2.4M; the HyperFrames title card printed the whole prompt → "Tidewell" + tagline; a deck's bars read a bare "GW" → 1,200 GW…; two chart calls overwrote one file → two files; overlaps 3→1, contrast fails 63→56, palette fails 5→3. Prefill: the opening prefix is byte-identical in both tool modes (CLI 3,377 of 3,495 tokens cached, 341→341 ms; schemas 5,087 of 5,205, 343→338 ms); a chart turn now takes one tool round trip (457 tokens computed) where main took two (388 + 976). Unit suites 7,461 pass.
   Was: **Land Wave 1 on main, verified** — VQ-00 eval harness, VQ-01 office renderer correctness (`push/vq-office-w1`), VQ-02 chart hardening, VQ-03 palette checks, VQ-11L HyperFrames title card (`push/vq-kit-w1`). Today they exist only in the installed candidate, unverified. Before/after renders from the eval harness for every sample prompt, and the owed prefill/TTFT check on VQ-02's prompt delta (+~0.8k chars per mode).
2. ✅ **VQ-08 anti-fabrication on main (`10f0cc9e`)** — replayed on the four captured 4B specs: invented source lines removed ("Data sourced from internal company metrics", a fake allrecipes URL); "2.5B+ daily consumers", an invented "Tea Lover's Perspective" quote, "Total 28" where the brief's years add to 68 and a mislabelled "83% YoY" flagged to the chat model; kickers that describe the slide dropped; brief parts no slide carries named. pytest 98/98. Tool results only — the prompt prefix is unchanged.
3. **Wave 2 — building now (two agents, one per lane):** VQ-04 design kit → VQ-10 `diagram` tool (kit lane); XP-16 bundled OFL fonts → WF-06 render-from-spec with citations, sources, multi-sheet (office lane). VQ-05 HTML → native emitters follows in the office lane (deliverables/research/PLAN.md §10).

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

**The two tracks — merged and installed (`496971b0`, `4b10d749`, `bfd43b10`; candidate `1ad52471`):**
| Request (the user) | Before | After | Proof |
|---|---|---|---|
| Intermediate generations "should be embedded in thinking blocks, not the generating card, that stays out" | four finished edits stacked full size below the generating card, then above the reply | each result files into the thinking chain under its own row; the generating card stays out, below the chain; when the turn ends the chain folds and only what the turn produced stays out (drafts a later edit used stay in) | `turn-cards-look.mjs` |
| "pressing enter on a chat should take you to the bottom" | the view stayed 7,200px up | re-pins and follows the reply; scrolling up mid-reply still lets go | `send-follow-probe.mjs` |
| ⌘Z within 3 s of sending, input empty, "should unsend+rewind the chat" | ⌘Z left the message sent and its reply running | the message leaves the thread, its turn is aborted, pi's session is forked at it, the text goes back in the box; a queued message just comes off the queue. Prefill after an unsend: 13 of 3,460 tokens computed, 213 ms (the fork now keeps its frozen prompt — it was re-reading 3,451) | `unsend-probe.mjs`, `unsend-prefill-probe.mjs` |
| "clicking on a card … does not expand/open it" | a click did nothing | the picture opens the viewer | `image-viewer-probe.mjs` |
| "copy and then attempting pasting into our own apps input bar doesn't work" | pictures vanished on ⌘V | a card's copy, a screenshot or an outside PNG attaches as a picture; the newest copy wins over a copied chip | `image-viewer-probe.mjs` (private clipboard — the system pasteboard is never written by a run now) |
| "images clicked on/fullscreened should have the new studio like ui … a centered bottom 'edit image' input bar" | the old centred overlay | tool rail on the left (Copy, Export, Show in Finder, Send to chat, Open in Image Studio), picture centred, "Edit image" bar with a Low/Medium/High Change picker, History after the first edit; a real edit ran twice on Qwen-Image 2.1 (82 s Medium, 147 s High) | `image-viewer-probe.mjs` (REAL=1 for the real edit) |
| (found by the tracks) the Image Studio's Edit never edited | `gen:generate` dropped the input image, strength and guidance | forwarded; an edit's waiting card says "Editing your image…" | `image-edit.test.ts`, `pending-phases.test.ts` |

**Now building:**
- "why not handle this natively so that any image(s)/files/folders… can be pasted into the input box" (the user) — attachments become real files: Finder files and folders (one or many) keep their paths, pasted pixels are saved once, PDFs/zips/folders stop being "skipped" and reach the model as paths; your own images open in the viewer. One agent.
- ✅ (installed, main `ed415a13`) The task tray lists downloads and model loads (the user: "headers for 'Downloads' 'Loading' … a sort of clean thin blue progressbar w/ % or ngb/rgb red X on the side below some white text that says the running operation"): each row is the operation in primary ink, a 3px blue bar (the hub bars' blue track), "1.3 / 5.7 GB" or a %, and a red X; a model download keeps its ETA and Pause. A load has no counter anywhere, so its bar walks at how long this model took to load here last time and never reaches 100 before it is ready; a first load or an engine compile sweeps. The separate download icon is retired. Probe `tray-transfers-look.mjs` (every button caught in main), light + dark, before/after.
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
- ✅ **Image Studio's Edit never edited**: fixed 09-24 (`0d79eaf5`, gen:generate forwards inputImage/strength/guidance; a real Qwen-Image edit kept the input's layout, luminance r = 0.91).
- ✅ **3D studio**: the generating stage ran under the floating Generate card's Finish row (any job with the card open, not only view-only) — it now centres in the clear part between the card and the view controls, and the slim bar starts where the card ends (`ed415a13`, installed).
- A stale Ladle (component browser) build ships inside the app bundle, ~3 MB. Minor.
- **Research answers:** the 4B often writes its research into `notes.md` instead of answering in chat (3 of 4 real runs), so no chips; suspected trigger: the `notes.md` example path in the always-on prompt (capability-prompt.ts:340) — unmeasured. It also glues links onto words ("NeuroglancerCell") where the page was not one it read.
- ✅ (fixed `420ea136`) **Docs made by Bobble open with "Missing document fonts: Cambria, Calibri (substitutes shown)"** in the canvas status bar, although every run is set in Helvetica Neue / Georgia. The canvas font check (vendor/genoffice font-check.ts `collectDocFonts`) counts docDefaults and EVERY style's font, and python-docx's default template declares Calibri/Cambria in styles the report never uses. Fix either side (office-gen writes its own fonts into docDefaults + the heading styles, or the check counts only styles in use). Seen in the render-from-spec report screenshot; cause read from source, not yet confirmed by a fix.
- **office-render-probe**: 1 of 15 fails on main only — the composer's model chip takes a hover-like highlight for ~300 ms twice while the canvas opens office files (probably the parked pointer over a shifting layout; unconfirmed).
- The rapid-mlx engine (the 4B's default) never lands the attachment prime (llama.cpp-only endpoints): a paste is re-read on Enter (~4.5k tokens, 2.4 s). **Understood (read from rapid-mlx 0.14.1's source, 2026-09-25):** the 4B is a hybrid (recurrent) model, whose cache cannot be trimmed, so rapid-mlx reuses only snapshots it takes itself at the end of the last user message, closed. A prime of the draft can never be a prefix of the real turn (the pasted text sits inside the message the user is still typing), `/v1/completions` takes no snapshot at all, and its priming flag (`_rapid_mlx_transient_priming`) is server-internal. It can only land if a paste is sent as its own user message (the typed text in the next), which changes what every model sees — a design decision, and an A/B on AC.
- ✅ (fixed `16e519e3`) The gen3d-engine Python tests ran on the system `python3` (3.9.6, no `tomllib`, no tarfile `filter`) — they run on uv's 3.12 now, 104/104.
- From the thread track: a finished card moves into the chain (and remounts) when the next tool call starts; a picture the model also embeds in its reply shows twice (older); ⌘Z into a turn already producing output aborts it and keeps the partial reply; an image-only message cannot be rewound out of pi's session.
- From the images track: the edit re-renders toward the words (img2img), so a Medium lighting change is subtle; the true instruction editor (Mage-Flow-Edit) needs the Bobble 3D engine.

## Blocked on the user
- Testing + feedback on the candidate and the prototypes.
- CI runs need a push to the public GitHub repo (XP-03/04).
- Heavy downloads / GPU jobs (PLAN.md Q1) — none ran.
