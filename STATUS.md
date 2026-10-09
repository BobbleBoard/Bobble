# Bobble — status

Updated: 2026-10-09 (on AC) · the user: "anything like this … red text that's just a real unknown error or something that doesn't have handling attached to it … just can't exist anymore" + the picture hover and lightbox slivers

## Backlog — everything discussed and not yet done (consolidated 2026-10-08)

Gathered from every message the user wrote since 2026-09-25, every open list in this file, ROADMAP-LATEST.md, the plan notes, and the branches not on main. Deduplicated; each item says its state and where it came from.

### 1. Finished branches — MERGED to main 2026-10-08 (the user: "yes merge them all and install")
Cherry-picked onto main (the branches' own STATUS-only commits left out), then typecheck, every unit suite (desktop 3,610, ui 449, harness 1,919, engine 146, providers 276, gen-tools 63), the build, the branches' own five headless probes (all OK) and `ship:local`.
| What it fixes | On main | From |
|---|---|---|
| "show me a picture" of maths goes to `math`, not text-to-image; a made picture always shows in the chat | `bd3506bf` | student comparison, 10-01 |
| the reviewer stops flagging work in the chat's own folder; a flag must name a harm | `0feb29b3` | student comparison, 10-01 |
| a price is not a formula ("$1.10 … $" no longer renders as maths); `\(…\)` and `\[…\]` render as maths | `03ff44c2`, `dd4d0870` | 27B check, 10-02 |
| a stream that goes silent is sent again once, unless the engine is still working | `ee08abc3` | maths run 6, 09-26 |
| Quick Download decides on the hub's host (as Top Recommended does), not on total RAM | `dd72a443` | 09-25 |
| a repo's card counts what is on disk under any entry; "Use" starts what is on disk (+ the model-fit UI probe) | `bfef3afe`, `3a86c0c3`, `ec11a7e4`, `4a54ccbe` | 09-25 |
| unit tests no longer leak a scratch library folder per file | `8fec2b06` | 09-18 |
| the generated theme CSS still said a 1.25 icon stroke after the 1px change (the themes test caught it) | `c78acccf` | 10-08 icon work |
| a text recipe's Download asks for the file it names: Ling 3.0's "tiny · Q4" fetched the 11 GB Q8_K_XL (quick-download-probe's one failure, older than the branch) | `db49897b` | 10-08 merge check |

Still to check before dropping (not merged): `claude/practical-dhawan-bf1d62` (09-17 code-block frame; later code-card work may supersede it), `claude/loving-driscoll-74b4e8` (fixed differently on main, `16e519e3`), `push/vq-office-w1`, `push/w0-b`, `push/wf-00b`, `bench/bench-1` (unverified WIP from 09-23), two old agent worktrees (09-17 design candidates, 07-26 3D workspace look).

### 2. Waiting on the user's decision
| Decision | Options / note | From |
|---|---|---|
| The guardian parks the 27B between turns (each turn reloads it cold: first token 17–26 s) | (a) keep; (b) let an idle chat model stay loaded unless swap/stall; (c) a smaller 27B quant; (d) fewer apps | 10-02 |
| Thinking can eat the whole output budget (27B thought 20k chars, three `length` stops) | cap thinking at the output limit minus room for the reply (llama.cpp ships it off) | 10-01 |
| A model-driven Blender run that **changes** a scene | needs your OK to touch your open Blender; the read-only path is verified | 10-07 |
| The 10 design prototypes (`deliverables/gallery.html`: image editor click-to-comment, Devices, Workflows + Deep research, Memory, Bobble help) | waiting on your critique since 09-23 | 09-23 |
| CI | needs a push to the public GitHub repo (XP-03/04) | 09-23 |
| "Got it!" | the cards say "Got it" (the voice rule bans exclamation marks); one word to change back | 10-08 |

### 3. The agreed roadmap (ROADMAP-LATEST.md, in order)
| # | Item | State |
|---|---|---|
| 1 | **Corp harness**: done only when the full 3D-game prompt runs end to end, autonomously | never completed end to end. The mesh is built (phases 1, 2a–c); phase 3 open: emergent dispatch concurrency, live mid-tool-call injection, file attachments. Also open: xhigh/max effort = coarser decomposition; inter-agent Q&A with aggressive KV/context caching |
| 2 | Lemonade (AMD inference server) as a backend behind `baseUrl` | not started |
| 3 | Connectors / skills / scheduled tasks with zero user instructions (one click injects e.g. a Blender or Unity extension) | partly: connectors are named in the prompt, CLI-shaped, + › Connectors switches, Blender as a command (10-07). One-click injection not designed |
| 4 | Access from anywhere / universal hotkey UI | not started |
| 5 | Ubuntu + Windows native, then clustering over Tailscale | uv installer per platform only; Tailscale Devices backend merged, no UI |
| 6 | Autonomous fine-tuning (strictly after 5) | plan only |

### 4. Ideas from the strategy talk (10-06/07), not yet acted on
| Idea | State |
|---|---|
| Long-running tasks: per-step reliability is the lever (30 steps at 95% finish 21% of the time, at 99% 74%) | this IS the corp-harness work (§3.1) |
| Blender / Godot through code, not screenshots (UE5 doesn't fit in 24 GB) | Blender command built; a Godot connector not started |
| CLI over MCP (models are trained on bash and `--help`) | connectors run in bash-CLI mode; continue making every connector CLI-shaped |
| Hot-swapping LoRAs (llama.cpp loads adapters at launch and switches them per request) | not built; the harness LoRA is plan only |
| Long-video semantic search with a multimodal embedding model (embeddinggemma2): embed and search a 2-hour film instead of tokenizing it | not started |
| d1 decision models: tune d1-3B for grounding (grid zoom 9/20 untuned; directional moves 0/20) | tested untuned (10-07); tuning not started. d1-omni-600M (audio-visual) noted for later |
| A memory system: Hindsight (the user: "a good pick") | not built (a Memory prototype in the gallery) |
| A 5–10× decode advantage; sublinear attention in the next Qwen/Gemma | watch items, no work |
| Context Language Models (arXiv 2609.37725, Meta/UW, 2026-09-29): the model edits its own context as a file; Suffix Cache Reuse re-rotates RoPE to reuse KV after edits (SGLang patch, code at facebookresearch/context-language-models). Tested at a 32K window; zero-shot works on Qwen3.6-27B, weaker on Qwen3.5-9B until RL (28.8 vs 34.7, 42.5 after) | watch item (the user 10-08: "something to keep an eye on"), no work |
| The reliability bar ("none of this ever happens on OAI/Anthropic any more") | the open gaps are §7 |

### 5. Design language → the app (wired 2026-10-08 on the user's "you can wire the design language into the app")
- Done: the tokens (teal accent, muted `#69696e`, teal focus), Fraunces on screen titles, the three hues on "what it makes" tags, the intro card (3D Studio, Computer use), the pop-out (Segment on the 3D rail, Connectors on the composer's +), the tour on the pop-out's anatomy.
- Done 2026-10-08 late: Try it plays on every connector's page (the connector demo card).
- Still to do: the Made card, the toolbar.
- the user's wider list (10-07): connector explore demos for each connector; the rendering of tables, visuals, office documents and inline cards at the same level.

### 6. Visual quality (pinned since 09-24), what is still open
| Kind | State |
|---|---|
| Website, app-like UI screens | not worked on beyond SVG unblocking |
| pptx / docx / xlsx, charts | renderer fixes done; no model-driven run since |
| HyperFrames animations, interactive widgets | partial (title card; widgets built, no model run) |
| SVG icons / art | OmniSVG's catalog repo (`Lavanuke/OmniSVG1.1_4B-GGUF`) does not exist on the Hub, so a fresh install can't download it |
| Images: observe and improve loop | a small look-back only |
| 3D for games (generate, rig, retopo) | not touched in the push |
| Mixes (a deck with diagrams, data, images and animation; a site with images, SVG and UI) | not started |
| Ming 0.1 for design + the image → editable pptx idea (ling-cookbook) | not started (engine spike only) |
| One generation per kind "you're proud of"; the quick-email control | not done |

### 7. Reliability gaps still open
- A 2B looped 26 minutes with no identical calls: the loop guard needs a wall-clock "no progress" budget.
- The guardian's park → resume → swap ping-pong on the 27B: back off after two parks.
- The 27B's first send waits ~122 s "starting up" (the select-time warm-up doesn't cover it).
- Compaction summarizes nothing on a small window and still costs a model call.
- "Thought for 1m 28s" over ~20 minutes of thinking (same family as the fixed "Worked for").
- The renderer page was replaced mid-turn under swap (10–13% free).
- An inline maths page isn't rebuilt after an app restart.
- The 4B writes research into `notes.md` instead of answering (3 of 4 runs).
- "What time is it" sometimes runs `date` instead of the connector.

### 8. Smaller known bugs
The office chip flicker (1 of 15 probe runs) · rapid-mlx never lands the paste prime (~4.5k tokens re-read) · img2img edits are subtle (the instruction editor needs the 3D engine) · a finished card remounts into the chain when the next tool call starts · a picture embedded in the reply shows twice · ⌘Z into a turn already answering keeps the partial reply · an image-only message can't be rewound · the Ladle build in the bundle (excluded `68cf0219`, unconfirmed) · ~60 unused old icon files in the design artifact's storage.


## Report — 2026-10-09: no more raw red errors, a way in for dictation, and the pictures' hover card and lightbox slivers

An audit (an agent read the whole app) found the four named examples' causes and about sixty places that put an exception's own words on screen. Every one now says what happened in plain words and carries its fix; the ones the app can fix itself, it does.

| Asked | Done | Checked on screen |
|---|---|---|
| "The local model server returned an error. Please try again." (red, no way on) | A turn that did not finish gets a card instead of red text: the cause in words (out of memory, too long for the model, stalled, engine not running, engine error, unexpected) and the fix as a button — Try again, Restart the model and try again, Choose a smaller model / one that reads more (opens the model menu), Continue in a new chat; the engine's words under Details with Copy | turn-problem-look: a real HTTP 500 through real pi → the card, no red text; Try again → the answer; every kind draws its own card |
| "fetch failed" | The main cause was systemic: a model that failed to start was never reported and the message went to a server that was not there. Now the send HOLDS the message under its bubble with why (no model on this Mac, short of memory, offline, engine or files missing, slow load) and Try again / Choose another model / Open Models; a model coming up sends it by itself. The MLX engine now waits for a server on its way back, as llama.cpp did. A refused send and a picture no model can see are held the same way (Send without the picture) | held-send-look: a fresh Mac with no model → "hello" held under "There is no model on this Mac", Open Models goes there; each reason draws its card |
| "the voice model is not installed" | Dictation had NO way in — nothing anywhere installed it. A Dictation module now does (uv, a Python venv with parakeet-mlx, the speech model, each step skipped when done); the mic shows its Download card and starts listening when it lands. A denied mic opens Privacy › Microphone; no mic, busy mic, nothing heard each say so with Try again | dictation-look: card on a fresh Mac; REAL_INSTALL=1 pressed Download for real (environment built in ~5 s here — the model was already in your library), dictation started by itself, listened, "Nothing was heard" |
| "this file couldn't be found" (a file that is there) | The reasons it happened, each fixed: a path under a folder the chat no longer uses (fs:locate finds it by name in the chat's folders), `cd x && … > out.md` (read under the cd), `~/…` joined onto the chat folder, a file still being written (watched for a minute; the tab fills when it lands). Open with / Show in Finder look too. What is left says which case (not there after looking / macOS did not allow / a folder / held by another app) | file-locate-look: a read of /old/place/reports/summary.md opens the real file; a file not yet written fills in by itself |
| "anything of that sort … red text that's just a real unknown error" | plainError (@pi-desktop/shared) turns an error's raw words into what to do (offline, disk full, busy, refused, missing, not allowed, too slow, damaged, not installed); applied on the Models page, the model menu, Storage, the tray, engines, onboarding, connectors (an add that failed was silent), skills (silent), the studios, image edits, the 3D studio (a failed stage now says why; weights downloads say why and offer Try again), previews (moved vs outside Bobble's folders vs unreadable), charts, office editors (Open in its app), crash screens (details folded). Toasts are amber with a title and a line, and can carry a button (Try again on a chat that would not open, a failed delete). Error text is no longer red anywhere it was a status | unit tests on the real strings; turn-problem-look photographs the toasts; the full lint/typecheck/test run |
| Hover a chain picture: a larger version "like shown in the image" | A floating card under the thumbnail, right edges lined up, up to 520×380, swapping at once between thumbnails | chain-visuals-look: 520 px card against a 44 px thumbnail, right edges equal, below |
| Lightbox: the pictures either side, greyed and cut off, a sliver; hover highlights; click scrolls to it like the arrow | A track: the picture centred, each neighbour pushed out until 64 px shows, greyed; a hovered sliver lifts; a click slides it to the middle; the track stops at the ends (› off) | chain-visuals-look: slivers 64 px each side at 0.4 opacity, 0.62 on hover; click → slides (measured mid-way) → 3 of 3 |

Kept on purpose: a failed tool step inside an expanded chain stays red with its raw output — your earlier spec ("expanded tool calls show fails as red … copy raw"), and the model reads and handles those itself.

Checks: lint clean in every package, typecheck, every unit suite (the all-packages run's failures were load timeouts — each file passes alone), the build, nine probes on the final build (chain-visuals, turn-problem, held-send, file-locate, dictation, chart-reentry, connector-demo, inline-move, canvas-edges), `ship:local` (installed). Images: deliverables/errors-and-pictures-2026-10-08/.

## Report — 2026-10-08 late: a connector demo card, tool chains collapsed, pictures beside the chain, and the chat-area fixes

| Asked | Done | Checked on screen |
|---|---|---|
| Connectors: a prominent card — the ask slides up, "Sure, I'll use <connector> to do this", the Used row, a sped-up Worked for, Done | Every connector's page opens with Try it playing: the user's bubble slides up, the reply's line, the real chain row with the connector's own mark ("Using …" while it runs, then "Used …"), a "Worked for" that counts to 1m 12s in 1.7 s, then Done; Replay plays it again; Reduce Motion shows the finished exchange | connector-demo-look: each phase photographed, the final words checked, Replay restarts it |
| Tools collapsed by default | A chain is folded while it runs too; `autoExpandLive` on ActivityChain brings back open-while-running for a future setting | unit tests + every chat probe |
| The > beside a tool chain shown without hover | Always shown, muted, ink on hover | chain-visuals-look |
| Pictures worked with in a chain: small at the right, level with it; hover bigger; click opens it, with the others either side | Up to four thumbnails (+N) at the right of the chain's summary row, level with it; hover grows one 2.6×; click opens a lightbox — the picture, its name, ‹ 2 of 3 ›, arrow keys, Esc, click outside; a picture that will not load is left out | chain-visuals-look: three thumbnails level with the row, hover, lightbox steps 2→3→2, Esc |
| Nothing full size inside an expanded chain | Pictures in a chain row are 72 px previews (they open the lightbox); players and other cards are capped | chain-visuals-look: tallest picture in the open chain 72 px |
| A radar chart, then a failed turn; back in the chat the chart showed at the bottom (twice) | Two causes: a card was placed by message id, and ids differ live and reloaded, so a reopened chat lost the anchor and put a copy at the end; and a chat's folder was owned per window, so a restart made `<name>-2`. Cards are now anchored by their tool-call id (stable both ways) and a lost one is re-anchored, not copied; a saved chat keeps its folder across launches (`~/.pi/desktop/chat-workspaces.json`) | chart-reentry-probe, real pi + a scripted server, three ways (in place, pi restarted, app restarted): one card, after the asking message, one folder |
| The inline ⇄ canvas move "not totally seamless" | Measured four faults and fixed each: the rail animated its own width, so the morph aimed at a half-open layout and the card jumped 440 px / 220 px at the end; a moved chart replayed its entrance; leaving the chat the card flew UNDER the rail, so the panel stood empty ~200 ms; the two snapshots cross-faded the whole flight (a wide card's bars ghosting through the tall panel's) | inline-move-film: the morph's planned end against where the card settles, dx 0 both ways; real screenshots every ~40 ms after the click, both directions |
| The address bar should search, not open https://<words> | Words go to a Google search; an address still opens (https, or http for localhost and IPs) | address unit tests; browser-search-probe: "best pizza near me" → google.com/search?q=… |
| The tab's curves heavier than its sides; a stray rounded corner where the canvas meets the chat | The curves are drawn by the same border as the sides (were a gradient ring, 2–2.5 px at 47 against crisp 2 px at 57); the docked canvas has square corners. Found while checking: where a flare's edge fell between pixels, a 1 px seam notched the strip's line (a clip-path is not pixel-snapped) — the flare is now two snapped boxes | canvas-edges-look at device pixels, light and dark: one line value all round, no lone column |
| (later note) "this square on the 'done' — it used to be a clean circle" | The icon backing that segments the chain's line was the chat's colour; on the connector card it showed as a square. It now takes its surface's colour | connector-demo-look: base-coloured pixels inside the card 2,812 → 0 |

Also: `ship:local` follows an unheard quit with SIGTERM after 10 s — the same quit, through the app's quit hold — instead of giving up at 30 s (the Apple Event went unanswered tonight; SIGTERM quit Bobble in ~1 s with no stray model server).

Checks: lint clean in every package, typecheck, every unit suite (the 9 desktop and 1 harness failures in the all-packages run were timeouts under load; each file passes alone), the build, the eight probes above, `ship:local` (installed). Commits on main: `3e7d14dc` → `8f33d0a7` (12).

Not done / known: Google answers the AUTOMATED test browser with its bot check (`/sorry/`) after the search lands — Playwright runs Electron with `navigator.webdriver` true; a Bobble you open yourself does not. Not bypassed.

## Report — 2026-10-08: the design language in the app, a friendlier Models page, the quick tour

| Asked | Done | Checked on screen |
|---|---|---|
| Wire the design language into the app | Accent and focus are teal (light `#0a7272` with white text, dark a mid `#16a3a3` with dark ink: the mark's neon `#2bd0d0` made a column of Download buttons the loudest thing on the page); muted text `#69696e` (4.6:1, was 3.3:1); Fraunces bundled (OFL) and softened, on the Models, Extensions and Scheduled titles and the hub's section heads; the three hues as tokens, on every "what it makes" tag (text teal, pictures sun, video/3D/sound pink); system blue now only on Bobble's cursor | tour-look checks Fraunces is loaded with SOFT 100 / WONK 0; light and dark shots |
| Intro cards / pop-outs | The language's intro card opens centred the first time the 3D Studio opens (a picture becomes a model) and the first time Bobble drives an app (its cursor types and presses; Choose apps, Got it); the pop-out opens on first hover beside Segment (the lamp splits into its parts) and above the composer's + (Connectors live in +, with the catalog's own marks) | tour-look photographs each; Got it closes and remembers |
| Quant dropdown hover "really thin" | Rows 30 px → 36 px, the wash 4 px from the panel edge, 7% ink (light was 4%, barely visible) | hub-polish-look: hovered row 419×36 |
| "Model hub" reads as a technical page; filters dumped together | Named "Models" (sidebar, top bar, palette); one display title and a plain line; Discover / On this Mac / Storage are the first, largest control; the machine's specs fold into "This Mac"; Datasets moved into the ⋯ menu; format, capabilities, sort, size and layout behind one Filters button with a count; friendlier copy; On this Mac without models says so and offers Discover; Storage's "Measured in" readout moved to a tooltip | hub-polish-look (both themes), model-fit-ui-probe and quick-download-probe still OK |
| A guided tour from the bottom-left menu | "Take a quick tour": spots each control of the screen you are on (chat 9 steps, Models 8, 3D Studio 6, Extensions, Scheduled), skips what is not on screen, the language's pop-out with the notch, step count, Back, Next / Got it, Esc | tour-look walks every step: card inside the window, beside its target, Got it and Esc close it |

## Report — 2026-10-08: lint clean in every package, two flaky tests fixed

| What | Fix | Commit |
|---|---|---|
| `pnpm lint` failed in desktop, ui, canvas, gen-service (warnings in gen-tools, harness) | 0 findings of any level in all 39 packages: fixture SVG/HTML not linted, dead code removed, CSS state rules below their base rules, false positives suppressed with the reason | `5546fc4e` |
| The 3D studio's Image-stage picture sat under the floating card (lint found a `padding-left: 312px` cancelled by a later `padding`) | pads by the measured cover, as the empty state does; image-stage-look.mjs: before FAILED (picture 409 px, card ends 670), after OK (711–966) | `235892f4` |
| canvas: "window is not defined" after a green run | `dispose()` cancels the queued measurement and settle timer; new test failed before (measured 1) | `587268cb` |
| pi-mac: EPIPE test read "Cannot call write after a stream was destroyed" | the test raced the first write; reproduced 3/3 with a stall after spawn, now waits for the helper to say it closed stdin | `7a97ced0` |

Checked: three full `pnpm test --force` runs back to back, 39/39 each, no unhandled errors; typecheck 39/39; installed.

## Report — 2026-10-08: one icon family, Hugeicons at 1px

**The ask.** the user liked 1px icons beside 13px text, and preferred Hugeicons over the hand-drawn ones (the connector icon "really low quality"). Measured first: SF 13px regular stems are ~1.23px, 14px ~1.33, 13px medium ~1.48. The app drew every icon at 1.25px from two systems: 35 Hugeicons glyphs (24-grid) and 56 + 27 hand-drawn 16-grid icons. Evidence: `deliverables/icon-review-2026-10-08/` (every icon as drawn, 6x magnified, candidate sheets, before/after in the app).

| Change | Where | Commit |
|---|---|---|
| `@hugeicons/core-free-icons` 4.3.5 (MIT), one module per icon | packages/ui | `fccc658d` |
| All 56 `icons.tsx` icons drawn from Hugeicons, every export name kept, so no call site moved; where an idea is already a glyph (chat, image, video, audio, puzzle, folder, compass), the icon is that glyph | packages/ui icons.tsx | `fccc658d` |
| Connector is a real plug (Plug01); Gauge (a filling pie) and Speed (a speedometer) read apart in the message bar; gears became a wrench | icons.tsx | `fccc658d` |
| GitHub: the brand's own mark (simple-icons), not a drawn copy | icons.tsx | `fccc658d` |
| The second hand-drawn set (settings/icons.tsx, 27) re-exports the shared set; 18 new shared icons cover what only it had | apps/desktop | `fccc658d` |
| One-offs moved onto the set: "Show" folder, the generic-app and canvas marks, ModelsView's view toggles (now with accessible names) and download count, MediaCard's corner controls | ui + desktop | `fccc658d` |
| `--pd-icon-stroke` defaults to **1** in every flavor; a settings file saved under the old 1.25 default moves to 1 once (`iconStrokeRev`), a later 1.25 is kept | themes, settings | `fccc658d` |
| Kept on purpose, a step heavier: icons lying on pictures (1.6, scoped on `.pd-media-btn`); the models download count (1.25, the user's "slightly thicker") | global.css, ModelsView | `fccc658d` |
| Kept as they are: the filled warning badge over photos, the audio player's filled play/pause, the file glyph's letterforms and the project folder morph (already Hugeicons-based or the user's drawings) | — | — |
| Design language: Icons assets re-rendered (115), its cards use the same drawings at 1px (`.bb-icon`), Iconography rules rewritten, backdrops retaken from the new build; artifact v6 | design/language | this commit |

**Follow-up (the user: "the top left buttons for the computer use icon have a bit of mushiness").** The window's three lights were stroked rings of r 0.7, 2.2 apart, under a bar at 6. At 16px each rounded into a 1.9px blob, 1.5px from the next and against the top edge, so they ran into one bar. Now they are solid dots of r 0.9, 3 apart, with the bar at 6.75, aligned to whole pixels on a 2x screen (`b303f8ea`, test `079053e5`; a test holds the spacing). Installed; design language v7. Images: `11-computer-use-lights-before-after.png`, `12-…-variants.png`.

**Checked.** ui 431 and desktop 3,568 tests (a new one for the migration), typecheck clean. `tests/e2e/icons-look.mjs` ran headless before and after: sidebar, + menu with Connectors, a tool chain with its message actions, Extensions, Models, Settings. The before/after crops are in the deliverables. No icon needed drawing by hand: every concept had a Hugeicons drawing that fits.


## Report — 2026-10-08: example cards, in place on the real app

**The ask.** Example cards and where they appear: centre-screen popups the first time a feature is used, a connector page showing a sample message sent and done with the tool, and pop-out cards with a "<" notch on hover, an animation on top and Got it bottom right. All of it is in the Design System artifact ((private link), v5) under **In the app** and **Anatomy**. Each in-app card sits over the real app, photographed headless at 2x by `apps/desktop/tests/e2e/design-moments-probe.mjs`. Evidence: `deliverables/design-language-in-app-2026-10-07/`.

| Card | Where | What plays |
|---|---|---|
| Intro: Computer use | centred over a new chat, the first time Bobble asks to use an app | the Computer use demo (Bobble's real cursor, "Typing" and "Clicking" pill); "Choose apps" + **Got it** |
| Intro: 3D Studio | centred over the studio the first time it opens | a flat lamp picture, three dots, the lamp model building from the ground up; **Got it** |
| Pop-out: Segment | from the studio rail's real Segment button, "<" notch pointing at it | your cursor hovers, the card opens out of the notch, the lamp colours part by part and comes apart, Got it closes it |
| Pop-out: Connectors | rising from the composer's +, notch pointing down | the + menu, small: Google Calendar's switch flips on beside Gmail (official marks copied from the app) |
| Try it | Google Calendar's page (a stand-in server, so it shows the working state) | the sample ask is sent, two rows "Used <mark> Google Calendar <action>" spin then finish, Done, the answer, a day with the free hour in teal |
| Intro card, Pop-out (anatomy) | — | numbered parts; the notch in all four directions |

**New in the language.** `.bb-intro` + `.bb-scrim` (the bobble flavor's own scrim: 35% / 50% black, 8px blur; new `scrim` token), `.bb-popout` with `--left/--down/--up/--right` and `--notch`, `.bb-btn` (primary in ink, quiet). In-app loops may run to 6.4 s with a 1.8 s hold, because a conversation needs reading time (motion.md).

**Checked.** Every card rendered headless in light and dark and looked at; the animated ones as six-frame strips seeked to exact times (pop-outs open, play, and close on Got it; Try it runs ask, rows, Done, answer); Reduce Motion stills show the open card or the finished exchange. The connector row copies `activity-chain.tsx` exactly (22px icon box, "Used" muted, the app's 14px mark, name at 550, action secondary). The live page itself was not checked; the built-in browser is not signed in.

**Words.** "Got it" without the exclamation mark, per the voice rule ("no exclamation marks").


## Report — 2026-10-07: Bobble's design language (a Design System artifact)

**The ask.** Bobble's own design language at Anthropic's level, its building blocks and anatomy, without the components yet. Built as a Design System artifact, private to the user: (private link) (source in `design/language/project/`, mirrored byte for byte). Evidence: `deliverables/design-language-2026-10-07/` (every card, light and dark, plus frame strips of each demo).

### What it holds
| Part | What | Source |
|---|---|---|
| Tokens | the shipping neutrals, radii, shadows; the mark's three hues with a tint and an ink each; `on-hue`; `agent` blue; 8 durations, 7 curves | `packages/themes` bobble flavor; `bobble-tiles.ts` before 13028e18; `agent-cursor.ts`; `global.css` loader |
| Type | Fraunces (OFL, variable, `SOFT 100`, `WONK 0`) names things; the system face does the rest; 12 styles | new; font file in `fonts/` |
| Building blocks (8) | Tile, Line, Frame, Picture, Chart, Cells, Cursor, Chip: one `bundle.css` (`.bb-*`) | new, except the cursor (the user's drawing, pasted) |
| Brand (3) | Mark (clear space, hues, app icon), Hues (one job each), Type | the mark and icon copied |
| Motion (2) | Curves (each verb doing its verb), Slide (the mark's puzzle, rule-checked frame by frame) | the loader's own curve and beat |
| Scenes (3) | Kinds (doc, deck, sheet, design), Month (marks landing on the diagonal), Trend | new |
| Demos (3) | Edit (select, ask, rewritten), Computer use (the real cursor's 300 ms glide, 150 ms squeeze, "Typing"/"Clicking" pill), Parts (a lamp tinted part by part, then taken apart) | timings from `agent-cursor.ts` |
| Anatomy (3) | Made card, Demo card (a connector's explore card), Toolbar | new |
| Brand book | README (principles, colour, type, shape, voice with real app copy, iconography) + Pictures + Motion sections; a README per card | — |
| Assets | 4 logos, 2 cursors, 90 icons (the 34 Hugeicons glyphs + 56 control icons, rendered from `packages/ui`; GitHub's mark excluded), 2 licences | copied |

### Decisions for the user
| # | Change | Why |
|---|---|---|
| 1 | **Accent is teal** (`teal-ink` light / `teal` dark), not the shipping system blue `#0071e3` | the hues are the brand; blue is now the agent's alone |
| 2 | **Muted text `#69696e`** replaces `#86868b` | `#86868b` is 3.3:1 on ground; the new one is 4.6:1 or more on every surface, both themes |
| 3 | **Hue jobs:** teal = words and numbers, sun = pictures and pages, pink = things that move (video, 3D) | one hue per picture, so a colour says what kind of thing it is |
| 4 | **Display face Fraunces, softened** | the system face had no voice for titles; Soft 100 rounds the terminals toward the tile corner |
| 5 | The language **copies the shipping cursor**; my first pink-heeled pointer and press ring were wrong and are gone | `agent-cursor.ts`: "nothing else may carry its own copy" |

### Checked
- every card rendered headless (Playwright, the page's own tokens.css compile) in light and dark and LOOKED at; the demos as six-frame strips seeked to exact times; Reduce Motion stills show each result
- contrast: every text pair the README names holds 4.5:1 (focus 3:1) in both themes
- not checked: the live page itself; the built-in browser is not signed in to claude.ai


## Report — 2026-10-06/07: connectors that work, a + › Connectors menu, Blender as a command

**The question.** "are the connectors seamless and working at all?" — measured, the first time a real model met a real MCP server in the real app (`connector-call-probe.mjs`, Qwen 3.5 4B, the official Time server): the bridge worked, but **the model was never told a connector existed** (asked the time in Tokyo it ran `date` and tried curl), `pi-tool list` taught the wrong commands, a Finder-launched Bobble could not even start `npx`/`uvx` servers, and the Blender connector could never work with the add-on installed.

### Fixed
| # | Found | Fix | Commit | Verified |
|---|---|---|---|---|
| 1 | The prompt never names a connector the person added | mcp-lite publishes the enabled connectors (tool bus) from the registry before any server starts; the CLI prompt lists them, one line each: `pi-tool time — Current time and timezone conversions. (a connector)` | `dc71ecbc` | live (4B): asked plainly, it ran `pi-tool time` → `--help` → the call and answered **6:21 AM Thursday in Tokyo**; turn 1 read **3,790 / 3,930** prompt tokens from the warmed cache, each later request ~97% |
| 2 | `pi-tool list` told a CLI model to use `mcp_call`/`mcp_schema`; `pi-tool time --help` was an error | CLI wording; `pi-tool <id>` / `--help` lists that connector's tools | `b0e2b584` | tests; live `pi-tool list` |
| 3 | Finder PATH: `spawn npx ENOENT` for 27 of 29 catalog servers | look in Homebrew, `~/.local/bin`, cargo, Volta, Bun, newest nvm; that folder in front of the server's PATH; a missing `uvx` runs on the app's own uv; no Node → "This connector runs on Node.js (`npx`), which isn't installed on this Mac…" | `5e1f6599` | tests; the live run above **under the bare Finder PATH** |
| 4 | The 4B called a tool named `time` ("Tool time not found") | a connector named as a tool runs as the `pi-tool` line it meant | `de91cffa` | tests (the 4B's exact calls); the rerun went straight to `pi-tool time` |
| 5 | the user: "+ menu … turn (installed) on and off … their actual app / connector icon" | **+ › Connectors**: Browse, Manage, a rule, every installed connector with its real mark and a switch (`DropdownMenuSwitchItem`, one focus stop, stays open); a flip re-opens this chat's session once it is idle | `87d104b6` | `connectors-menu-look.mjs` OK (rows, marks, switch state = registry, flip lands in the file, Manage opens the screen) — `deliverables/connectors-2026-10-06/plus-menu-connectors-*.png` |
| 6 | Blender: the catalog ran `uvx blender-mcp`, a third-party server whose messages Blender Lab's add-on (the one installed) rejects ("Unknown request type") — every call failed; it also carried telemetry and cloud asset tools | **`blender scene | run | render`** — a small command on the add-on's own wire (NUL-terminated `{"type":"execute"}`), registered only where Blender is installed; built-in card shown only where detected | `9f39811a`, `5a8919a5` | fake-add-on tests; the code in Blender 5.2 background (scene read; quick render 1 s, EEVEE 2.7 s at 25%); a **read-only** scene query against the user's running Blender: ok in 452 ms, errors come back as tracebacks |
| 7 | the user: "standing no emoji's rule" (a wrench emoji on a custom server) | a connector without a mark gets the neutral connector glyph; rule saved | `c2093226` | menu look, zoomed |

**State.** suites: desktop 3,566 (+1 known timing flake under the full parallel run, passes alone) · ui 431 · harness 1,907 · mcp-lite 110 · mac-connectors 81 · tool-bus 6 · inference 404 · providers 209 / 32 · typecheck clean.

### Not done / the user's call
| Item | Why |
|---|---|
| A model-driven Blender run that **changes** a scene | it would edit the user's open Blender session; the read-only path is verified |
| Natural "what time is it" sometimes still goes to `date` | `date` is a right answer too; named or not, the connector is now reached |

## Addendum — 2026-10-02: Qwen3.8 27B thinks at medium effort (the user: "it's xhigh by default, set it to medium")

| What | How | Verified by |
|---|---|---|
| The 27B's thinking effort pinned to **medium** | `CatalogModel.chatTemplateKwargs: { reasoning_effort: 'medium' }`, merged into the one `--chat-template-kwargs` the launch carries (`{"preserved_thinking":true,"reasoning_effort":"medium"}`); the MLX twin's template default set to medium; a request that names an effort still wins — `61ede173` | unit tests (launch args, catalog, template patch); llama.cpp b10603's own `/apply-template` on Qwen's template, froggeric v22 and v22.5: **xhigh → medium on the first two**, medium on v22.5 (which had already changed its default) |
| A prefill trap the pin closes | the warm-up prime renders with thinking off, which drops xhigh's "Reasoning effort is set to xhigh…" line from the system turn — so under an xhigh template the primed prefix never matched the turn | same render: prime ≠ turn before, prime = turn after |
| **Live, on the real 27B** (headless, on AC) | `effort-prefill-probe.mjs` | launch carries `{"preserved_thinking":true,"reasoning_effort":"medium"}`; the server renders medium, and xhigh when a request names it; **thoughts 30–350 chars, "Thought for 10s / 13s", both turns answered correctly** (the day before, at xhigh: 6k–20k-char thoughts that ran into the output limit) — `deliverables/effort-prefill-2026-10-02/qwen38-27b-medium-two-turns.png` |

### Prefill — what the check found, and what was fixed
| # | Found (server's own log, `[pi-diag-usage]` + `[llama]` slot lines) | Fix | Commit | Verified |
|---|---|---|---|---|
| 1 | Every side call sent with `enable_thinking:false` (warm-up, prime, title, reviewer, fixer) parted from the chat **right after the tool list**: froggeric's Qwen 3.8 template writes its tool instructions differently when thinking is off. Server: `f_sim_best = 0.224` | the system turn follows the conversation's thinking, not one request's switch (`patchSystemTurnThinking`, in every cached template's patch set); the warm-up and the prime send no switch of their own (Gemma 4's `<|think|>` sits at the top of its system turn — the same trap) | `1919d1c1` | through llama-server's own renderer: title shares **21% → 100%** of the chat's prompt; live 27B: title `f_sim 0.983`, turn 1 **96%** from the warmed prefix |
| 2 | "Getting ready" cleared one tick after the warm-up **started** (~14 s before the prefix was resident) — turn 1, 96% cached, still waited 12.7 s | the label waits for the in-flight warm-up | `3bee16cd` | test fails without / passes with; live: label up 4.2 s → **20.7 s** (the warm-up's real length) |
| 3 | Launched beside another model, the 27B answered every request with an in-stream `{"error":"Compute error."}` — read as an **empty reply**, then nudged, then titled, chat stuck on nothing | both providers turn an error frame into an error the person sees ("short of memory…") | `0582d0f6` | tests (llama.cpp + MLX) |
| 4 | Re-prefills were invisible in the app's logs | llama-server's slot/LCP/checkpoint lines are logged (and written beside `PI_DIAG_PROMPTS`) | `9573d023` | every run above |
| — | Qwen 3.5 4B, the full flow after the fixes | — | — | **effort-prefill OK**: turn 1 **96%**, first token **426 ms**; turn 2 **98%**, **321 ms**; same server both turns |

### Found, not fixed — the user's call
| Finding | Measured | Options |
|---|---|---|
| **The guardian unloads the 27B between turns** on this 24 GB Mac. It loads to ~16 GB (free 82% → 14–15%, with or without the vision projector, at a 12k window), under the guardian's 15% pause line; 20 readings later it sheds and parks (stops) the model, so each turn reloads it and reads its prompt cold: **first token 17–26 s, `cached_tokens=0`** (4 runs). The cache itself works when the server stays up (#1). | `qwen38-27b-guardian-log.txt`: `PARK the chat model: 14% of memory is free — paused for 20 readings and it did not come back` | (a) keep it — the machine comes first; (b) let an idle chat model stay loaded while nothing swaps or stalls (sheds at 8% / swap+tight / stall unchanged); (c) a smaller 27B quant (~10–11 GB); (d) fewer apps open. A window-sizing change was tried and **reverted** (`cd63e23c`): the window was already 12k — not the lever. |
| Currency `$…$` in a reply renders as inline maths ("$1.10, then x + … = 1.10$") | 4B turn 2 screenshot | filed as a separate task |


Installed (`pnpm ship:local`, packaged smoke OK); the installed bundle carries the pin and the four prefill fixes. Images, reports and server logs: `deliverables/effort-prefill-2026-10-02/`.

## Report — 2026-10-01: a visual-learner student, Bobble × five local models vs ChatGPT (logged out)

**the user's asks.** (1) "drive bobble visually as a user and go and ask for some explanation of some math problem, as a visual learner, maybe 1-3 turns … then … go to the chatgpt.com website and see if you think bobble does better … also test with a few others, gemma4-12b, ling 3 tiny, minicpm 2b and then feasibly comparable to oais model: qwen3.8-27b"; (2) mid-run: "explanation shoudl be inline and inline card should be at the bottom also!"; (3) on the reviewer's "Run this command?" modal: "put this sort of permission popup just as a little card same width as the input bar floating directly above it (not on top of), and make the 'ask user' question modals and any user inputs from the model or for the chat just appear there".

**How it was run.** One student, the same opening for every system: *"hi! im a really visual learner and i never got why the area of a circle is πr². like where does the r squared even come from?? can you show me so it actually makes sense"*, then follow-ups a confused student would really send, adapted to what each answer showed. Bobble was driven headless (`apps/desktop/tests/e2e/drive-server.mjs`) by clicks, typing and full-window screenshots only — the one thing read from the page is whether Stop is showing. ChatGPT in the built-in browser, logged out, no account.

**State.** main `9c72996b` (14 commits today, `e0d414d1` … `9c72996b`) · **installed** (`pnpm ship:local`, packaged smoke OK: 3 extensions, pi from the bundle, a maths page from the asar, pd-preview) · suites: desktop 3,565 · ui 431 · harness 1,901 · canvas 392 · mathviz 93 · provider-llamacpp 208 · provider-mlx 31 · top-level typecheck clean · e2e: permission, round9-harness, tasklist, notif-redesign, dialog-focus, turn-cards, ask-card-look all OK · no change to any system prompt or tool schema (tool-result text and nudges only), so the prompt prefix — and prefill — are untouched.

**Images:** `deliverables/student-comparison-2026-10-01/` — `chatgpt-*`, `bobble-<model>-*`, `ui-ask-card-*`.

### C1. Who explained it — the student's view
| System | Turn 1 | Turn 2 | Turn 3 | Resolved the confusion? |
|---|---|---|---|---|
| **ChatGPT** (logged out, web) | 10 s · clear, correct text with typeset maths; ASCII "pictures" (a diamond for the circle, a trapezoid for the rectangle); one small formula card (a circle, r = 3, A = 28.27) that shows no rearranging | asked for an actual picture → "Creating image" → **login wall**, no text | asked again → **login wall** | a 4th, text-only ask: excellent (whole circumference split top/bottom, a rope analogy, "correction to my earlier explanation") — yes, in words; it never showed a picture |
| Bobble · Qwen 3.5 4B | 166 s · no chat reply; an ASCII doc with a wrong row; an error toast | 218 s · no reply; another ASCII doc | 361 s · a doc + a third-person reply, halves right | partly |
| Bobble · Gemma 4 12B | 167 s · flowchart (raw `$\pi r$` in its nodes), the explanation written twice, and a page that plays 4 steps (wedged circle beside a separate box) | 288 s · an "onion" flowchart, top/bottom explained **wrong**, a generated image (a woven disc) that never reached the chat | 26 s · **empty reply** (548 tokens out, none shown) | no |
| Bobble · Ling 3.0 Tiny | 21.5 min · the hand-drawn-figure refusal read as a tool bug; three SVG tries; "too long for the context window" | 8 s · the chat could never send again | new chat, 16 min · 53 reads of one file, the loop guard's abort, "Done" over nothing | no |
| Bobble · MiniCPM 5 2B | 26.5 min · 25+ files (charts, maths, four "final answer" .md files), the window froze; Stop could not be clicked | — | — | no |
| Bobble · Qwen 3.8 27B | 617 s · **correct, clear text and an interactive page in the chat** (wedges, "cut & rearrange", a πr × r rectangle, slices and r sliders), the page at the reply's foot | ~23 min · "You're right — that box was a cheat. Let me actually draw the wedges rearranged…", then three thinks (20k, 6k, 19k characters) each cut off at the **output limit** — nothing drawn; compaction summarized nothing, twice | — (stopped there: a student would have left) | turn 1, yes, in words and a page; the picture it promised for turn 2, no |

**Verdict.** ChatGPT's words are faster and steadier (10–20 s a turn, always correct), but a logged-out visual learner never gets a picture — two asks for one ended at a login wall. Bobble with Qwen 3.8 27B is the only system that put a real, moving, interactive explanation in front of the student — and its words were as good as ChatGPT's first answer — at ten minutes a turn on this 24 GB Mac, at the edge of its memory. The small models (Ling, MiniCPM) never explained anything; Gemma 12B explained turn 1 well and then went wrong.

### C2. Fixed today — every one found by the student runs, each reproduced first
| # | Found (model, what the student saw) | Fix | Commit | Verified by |
|---|---|---|---|---|
| 1 | Gemma · the page sat on step 1 for good | canvas: a page whose scripts ran restarts on a changed snapshot; the same snapshot changes nothing; the host resends to a fresh frame | `e0d414d1` | harness repro (stuck → 1→2→3); in the app Gemma's page told all four steps |
| 2 | Gemma · an empty reply, nothing under the question; 4B · "Agent is already processing" toast | harness: the empty-reply nudge fires without a tool too (not on its own private steers); all five agent_end steers wait for idle | `ebf7d12d` | tests fail without, pass with |
| 3 | Gemma · 548 tokens settled to nothing, no trace | providers: `[pi-ctx]` names an empty reply / a cut call, with what was cut | `edc1ae96` | tests |
| 4 | Gemma · `$\pi r^2$`, `\times` in flowcharts and the page's card | `texPlain` (mathviz): titles and diagram labels read as πr², × — node ids and indents untouched | `be1c91a2` | tests (the Gemma labels verbatim) |
| 5 | Ling · the chat could never send again | llama.cpp overflow: after tool results, older calls' long arguments are elided (sizes kept), then older thoughts | `7cf5d72a` | test (Ling's shape) |
| 6 | Ling · read the refusal as a tool bug, never ran `--help` | the hand-drawn-figure refusal carries a whole small spec; a test proves mathviz accepts it | `7bc977ab` | tests |
| 7 | Ling · "Done" over nothing after the loop guard's abort | after an abort, once idle: "You were stopped: … answer in words" | `983c600b` | wiring test |
| 8 | MiniCPM · the window froze (126 % CPU, 1.7 GB; the inspector could not attach) | rows memoized on stable step data; a row's details made when first opened | `3d9c1ac1` | replayed offline: an update 130 ms → 1 ms at 183 steps, DOM 11.7k → 3.3k |
| 9 | Qwen 27B · "fetch failed" ×2, "working" forever with 79 % free | the guardian resumes the model it parked; a parked model is woken before a send | `19b42a23` | test; rerun: the park was refused mid-request and the turn answered |
| 10 | the user · "explanation should be inline" | the math command's page is an inline Explanation card (any size), its raw view the spec | `f38dbfb0` | Qwen 27B's turn 1 (screenshot) |
| 11 | the user · "inline card should be at the bottom" | finished cards stand at the reply's foot, after its words | `483d1595` | test; Qwen 27B's turn 1 |
| 12 | the user · permission modal → a card above the input | AskCard: permission, yes/no, ask_user, select/input — one card the composer's width, in the flow above it; Escape = Don't | `67733bbc` | ask-card-look (width = composer's, bottom above its top), 5 suite probes |
| 13 | Ling · "Worked for 52s" over a sixteen-minute turn | "Worked for" is never less than the chain's wall-clock span (its first request to its last result) | `9c72996b` | test |
| — | the drive tooling | drive-server (+ /quit stops the model first), fetch-models-probe | `1a179826` | used for every run |

### C3. Found, not fixed yet
| Finding | Where | Note |
|---|---|---|
| The reviewer flags harmless work as dangerous ("lists a private system path" for `ls` of the chat's own folder; "DANGER" for writing an SVG into it) | permissions/flag-bash | partly the probe's home under `/private/var/folders`; needs a check on a real home before changing the prompt |
| "Show me a picture" of maths → text-to-image (a decorative woven disc), and a generated image not presented never shows in the chat | routing / turn cards | should go to math (or svg figures); an unpresented result should still be visible |
| The same explanation written twice (before and after the tool call) | Gemma | prompt pressure, not enforcement |
| First send on a 27B: "starting up · 122 s" | prefill warm-up | the select-time warm-up does not cover it |
| A 2B looping 26 minutes with no identical calls → the loop guard never trips | loop detector | a wall-clock budget for "no progress" |
| The renderer page was replaced mid-turn on the 27B under swap (the driver's handle died; CDP drove on) | app / memory | 10–13 % free throughout |
| An inline maths page is not rebuilt after an app restart (its result text is "Drew …", not "Presented …") | present-store rehydration | small |
| **Thinking eats the whole output budget**: Qwen 27B thought 20k characters, hit `length`, three times, no answer | llama.cpp launch: `--reasoning-budget -1` (off by default, by design) | proposal: cap thinking at the output limit minus room for the reply, with the budget message — a defaults change, so the user's call |
| Compaction summarized nothing ("(none) — No conversation content was provided to summarize") and cost a model call each time | pi compaction on a small window | the known "frees nothing" (`pi-desktop-compaction-defaults`) |
| "Thought for 1m 28s" over ~20 minutes of thinking | ThreadActivity thought estimate | the token estimate uses the live tps; same family as the "Worked for" fix |
| A 27B on this 24 GB Mac: park → resume → swap → park (two cycles in one turn) | guardian | the resume works; a backoff (stop auto-resuming after two parks; the next send still wakes it) would end the ping-pong |

## Report — 2026-09-26 day: maths explanations the model makes itself

**the user's asks.** (1) "it should really feel like there's an explanation going on … like a 3b1b explanation … smooth move/scale/slide … it has to show direction … little nudges … visual cause and effect … a real teacher"; (2) on the SHM page and the proof: "focus on the math animations and explanations right now, generated by the model itself, everything should be clean and clear, there's some faded text … triangles could be a solid color".

**How it was judged.** Only pages the 4B wrote itself (qwen3.5-4b-mtp, headless visual suite, 5-minute cap per task), filmed at 1 s … 48 s of their telling. Every failure became a general reader or harness fix — never a hand-made page — and the 4B's own specs were then redrawn with the new reader for before/after. A library of worked examples for the model to copy was considered and rejected: it would be my pages, not the model's.

**State.** main `63d038a7` (11 commits today, `abe13463` … `63d038a7`) · **installed** at 13:52 (`pnpm ship:local`, packaged smoke OK: 3 extensions load, pi spawns from the bundle, pd-preview serves) · suites: harness 1,893 · mathviz 90 · gen-tools 64 · top-level typecheck clean · the six lesson fixtures draw clear.

**Images:** `deliverables/visual-quality/math-2026-09-26/` — `model-pages-now.png` (the 4B's own pages as the app draws them now), `ba*.png` (before/after per spec, runs 4, 6, 7), `run6-*-as-drawn.png`.

### M1. The page tells itself (the user's brief) — `abe13463`
| What | Verified by |
|---|---|
| Step 1 alone, then each step's words appear while the figure moves to that step's values (1.1 s, eased); Pause / Show all while it plays; then sliders, Back, Next, Play again; any control ends the telling | math-visual-probe (the app, scripted model); filmstrips |
| Direction: each moving object gets an orange arrow from where it was and a faint copy left there — along the curve it took when the move curves (`0ee16491`) | filmstrips (the unit circle's point, the projectile) |
| Cause and effect: a step's `nudge` wiggles a slider around its resting value while what depends on it follows | SHM fixture, step 3 |
| Text never fades (dimmed labels turn mute grey; a label of a fading part is whole-and-muted or gone); solid role fills for objects, pale `-light` fills for areas | tests on the SVG; fixtures looked at |
| Narrow canvas: the step being read is a caption pinned at the foot | narrow screenshot |

### M2. The 4B's rounds — what its own pages lost, and the general fix
| Round | What its pages showed | Fix | Commit |
|---|---|---|---|
| 1–3 | kinds in its own words, sliders as `"a = 3"`/dicts, a path as a Python list; 30 "outside" reports for a clipped tangent; `edit` given its edits as JSON text ×3; its page presented 15× running; SHM ended on an empty reply | read from what they carry; lines clipped, not reported; five fixes at a time; a repair rung for structure sent as text; present answers a maths page; a silent turn is steered on | `9293ce24` `a879e315` `33656c0a` `ecd57eda` |
| 4 | the mass under the view's floor; A·cos(ωt), A = 80, in a −1.2..1.2 plot (an empty grid); y = mx + c flat in −60..100; "a² = 6400" resting at 20 % ink; a solid square hiding its triangles; the lever never reached math (Mermaid ×3 → `svg --figure "<svg…>"` → a painted seesaw); the derivative's spec typed into a bash heredoc, never drawn | views and y-ranges fitted to what the steps show; labels whole or gone; leader lines; ground areas pale; heredoc specs drawn and heredoc maths SVG refused like a write; a switch then a word keeps the word; failed physics flowcharts and seesaw image prompts point at math | `a5130510` |
| 5 | (cut short: the lid closed, the Mac slept) a ball r = 0.5 in a view 100 wide that never moved; `"endpoints"`; its dimensions and captions in their own lists, dropped | still steps take the play slider through its range; discs ≥ 6 px; parts listed by kind; a zero-length "tangent" said with where a tangent belongs; **present names a maths page's open problems once** | `709978b9` |
| 6 | a unit circle refused for `"x in 0..6.28"` alone; the derivative's point and tangent listed as `"elements"` beside `"function": "f(x) = x^2"`, dropped; every curve dimmed by steps that pointed elsewhere; two unnamed curves | ranges with no start; x/y sliders in a figure; graph elements read (a point on the curve, its tangent, "slope {m}"), framed on the slider; per-panel dimming; curves named | `0ee16491` |
| 7 | the projectile's flight a ripple along the top of −75..25; a ball that never left the launch point (three sliders, none played); `"set": {"ball": {…}}` refused twice, then every set deleted; squares by `"size"` and legs by angle + length refused; sliders under `"controls"`; a slider under `"point"` and captions under `"labels"`, silently dropped | the frame on the story; the slider called t is the story's time; a part's "set" left out and said; the forms read; what went unread is said, with the forms that draw it | `85aa9c60` `63d038a7` |

### M3. The runs (the real 4B, 5-minute cap)
| Run | Code | Pages drawn | What the pages were |
|---|---|---|---|
| 4 | `33656c0a`+ | 4 of 6 | lever → a painted PNG; derivative never drawn (heredoc) |
| 5 | `a5130510` | — | stopped: the lid was closed (13-minute silences), numbers meaningless |
| 6 | `709978b9` | 6 of 7 | projectile lost to a model-server stall (143 chunks, then 5 min of keepalives); **the lever reached math** via the diagram pointer; Pythagoras was pushed back at present and fixed its page; SHM's heredoc spec drawn in the bash result — a moving mass beside its graph |
| 7 | `0ee16491` | 6 of 7 | Pythagoras refused twice (fixed in round 7); the line page had no steps and the model hand-wrote HTML after; the derivative's slider hid under "point" (now said) |

**What is still weak — honestly.** The 4B's physics and geometry are its own: the Pythagoras pages are never a correct proof (Garfield's trapezoid with the wrong corners; squares all centred on the origin); the projectile's `theta/deg` flies the ball at 45 radians; the lever's torques are mis-multiplied in the words. The reader draws what it wrote, cleanly; it cannot make it right. Pages move and read clearly now; whether they teach depends on the model.

### M4. Harness and app findings
| Finding | Fix | Verified by |
|---|---|---|
| A 978 s "5-minute" task: the lid was closed and the Mac slept (a 13-minute silence in the app log; pmset sleep / DarkWake) | run stopped cleanly (model server first, then the app; no crash report); keep-awake requested; rerun with the lid open | pmset log |
| A model-server stream stalled after 143 chunks and sent only keepalives for 5 minutes — nothing notices a silent stream | offered as a separate task (a stall watchdog) — a session picked it up | app log |
| A bash heredoc went round both the spec drawing and the hand-drawn-figure refusal | `bash-writes.ts`: what a bash line writes meets the write's rules | wiring test through the hooks; run 6's SHM drew from one |
| `svg --figure "<svg…>"` lost its markup (`figure: false`) | a switch followed by a word: switch on, word positional | CLI tests |
| A maths page with open problems was presented and the turn ended | present names them once, then lets it through | run 6: Pythagoras fixed its page after the push |

## Report — 2026-09-26 00:30 (hard stop): the showcase, the math extension, OmniSVG 1.1, VFIG, the blue kit

**the user's asks this round.** (1) the math extension: "a standard style and control such that we can deterministically have it iterate when things look off"; (2) "remove token limit on vfig"; (3) "are we using omnisvg 1.1? … check the 8b model @ q8"; (4) "this greenish/pale blue isn't that great … keep using [the app's blue]"; (5) "if asked for pythagorean theorem explanation visually, do you have text that appears side by side as the triangles are rearranged"; (6) wrap-up: one fresh prompt per visual kind, screenshots, this report.

**State.** main `db67f548` (38 commits since `741d317d`), dist rebuilt at `db67f548` (headless launch checked) · installed build still `c034085d` — **not installed tonight** (hard stop; `pnpm ship:local` is the next step) · suites: harness 1,878 · mathviz 49 · gen-tools 64 · design-kit 41 · charts 130 · office-gen 184 (Python) · the desktop files touched 116 · top-level typecheck clean.

### S. The showcase — eleven prompts never run before, the real 4B, headless (qwen3.5-4b-mtp, rapid-mlx, 160 s cap each)
Sheet: `deliverables/visual-quality/showcase-2026-09-26.png` (the products, looked at). 8 of 11 gave the user a real product; 7 hit the 160 s cap, most after presenting.

| Kind | Prompt (fresh) | Outcome | What is wrong in it |
|---|---|---|---|
| Math (the model) | projectile motion, animated | ❌ capped, no page: it sent a data dump (`"history": [{t, x, y}…]`) instead of a spec, got the new error, then thought out the turn | the 4B still does not reach a working spec unaided on a new physics prompt; the Pythagorean page in the sheet is the FIXTURE, not the model |
| Chart | café sales, two weeks | ✅ 72 s, drawn | four one-week charts, not one grouped chart; its reply got Wed's change backwards (+6 said −6); inline charts wear their look's mauve, not the app's blue |
| Diagram | library holds, 7-day expiry | ✅ 29 s | good: decisions, yes/no branches, the expiry path |
| Word | first-flat tenancy checklist | ✅ presented (capped after) | the four section headings are missing; 4 pages for "one page" |
| Excel | York trip for 28 students | ✅ 74 s | designed well; the numbers disagree (4,852 vs a grand total of 6,944; the pie is of quantities; percentages sum to 143) |
| PowerPoint | 9:15 school start, 6 slides | ✅ 82 s | the strongest product; its statistics are invented, not sourced |
| Website | Tidy Paws grooming van | ✅ presented (capped after) | good look; emoji dogs as the service icons |
| Website + deck | charity 5k: page and sponsor deck | ⚠️ page made and shown; deck FAILED — `office make` flags in one quoted string ("--kind=pptx --brief=…"), then "no slide plan" | the CLI's quoted-flags case, and the office planner's empty reply |
| HyperFrames | podcast title card | ✅ presented (capped after) | calm, dark; the whole title blurs in, not letter by letter as asked |
| Image | Tokyo tea shop in rain | ✅ Qwen-Image 2.1, saved | excellent picture; the cap ended the turn before it was presented |
| SVG | hot-air balloon over hills | ✅ OmniSVG 4B, presented | simple and a little crude (the basket's shape) |

### H. The math extension (`math`, `@pi-desktop/mathviz`)
| What | Commit | Verified by |
|---|---|---|
| A spec → one standard page (light/dark, KaTeX with fonts inlined, no cards, no coloured text); checks measured in every step's state; the checks come back with "fix it in X and run math again" | `66547d62` … `298e692a` | 49 tests; five lesson fixtures looked at |
| STEM run 2 (4B): every visual task reached for `math`, no spec got through — bare ranges, `@path`, invented keys, undeclared names, 3D points | `a3533846`, `a325ad60`, `db72ab0e` | tests; in the app with the mock |
| STEM run 3 (4B, 5 tasks): physics — 5 specs refused (a view as one number, a box sized `[0.4, 0.4, 0.4]`); SHM — copied the error's one example (a sine curve), nothing moved, then told the user to "adjust the amplitude and period sliders" (there were none); calculus — wrote the spec 5×, never ran math, presented the JSON, hand-drawn SVG refused toward Mermaid, then **image generation** ("sos(x)" on the axis) | `7edd1ce5` | the 4B's own specs re-drawn: all six physics specs draw; its unit circle's crowding and doubled arrows are now said |
| …the fixes: an unreadable view is **fitted to the shapes** (every slider setting and step); `[w, h, d]` boxes; title optional; the no-plot error shows a moving example; the result says what the page has ("Nothing on it moves — it has no sliders"); **a written `.math.json` is drawn in the write's own result**; a hand-drawn maths SVG is refused toward math; a maths-figure image prompt is answered with math | `7edd1ce5` | 27 harness + 45 gen-tools + 5 mathviz tests |
| New checks: labels with no clear spot (on a point or a solid disc, crossed by a line) said as one list; two arrows on the same ends; labels keep off solid discs | `7edd1ce5` | the five fixtures stay clear; the 4B's circle at a 3.2-wide view names fewer labels |
| Motion: `lerp`, `ease`, `between`, `clamp`; any part's `opacity` as an expression; dimming drawn as opacity; the **Pythagorean rearrangement** fixture (Next slides each triangle; c² fades out, a² and b² fade in) | `8a120df6` | tests (Node = page JS); steps 1/3/5 looked at |
| the user's brief (2026-09-26): "like a 3b1b explanation … smooth move/scale/slide … show direction … little nudges … visual cause and effect … a real teacher" | `abe13463` | BUILT — the 2026-09-26 day report above |

### I. OmniSVG 1.1 — "fails this badly" was our image path
| Finding | Fix | Evidence |
|---|---|---|
| The picture never reached the model; the marker came before the instruction; no 448×448 on white (alpha dropped: RGBA inputs reached it on black) | `1ac2de2e`, `56ab06e5`, `bb451110` | server log; TS vs the authors' Python on 20 inputs |
| The pick kept scraps | `8373ed8f` overlap with the picture's ink | re-pick of the 30-task run |
| 4B vs 8B at Q8_0: the 8B GGUF's end token was Qwen's (151645), not OmniSVG's (196999) — every 8B sample ran to the cap | GGUF patched (`gguf_set_metadata`) | EOS-fixed re-run, 13 image tasks × 3 before it was stopped for the showcase: 9 of 39 samples end on their own, 19 hit 1,536 tokens, 11 loop — **the 8B at Q8_0 is not the showcase's quality either**; the disparity with the authors' gallery is not model size on our path |

### J. VFIG behind `svg` — no token limit
| What | Commit | Verified by |
|---|---|---|
| Model-card prompt, greedy, n_predict −1, a loop cut where it began, a cut reply closed into a valid file; its own llama-server (32k, q8_0 cache); `svg --figure / --edit` route to it | `a9fcaf6d`, `b17cbd43`, `fe5fa8c4` | 9 + 3 + routing tests |
| A reply that has stopped drawing (defs with no shapes) is cut — lifting the limit had made the 48-icon grid a 17-minute failure, not a success | `86491bde` | 2 tests |
| In the app, real model: Fig. 3.1 → SVG with 4 `<text>` in 38 s; "make the flame gold" edited logo.svg in place | — | vfig-svg-probe OK |
| `svg` lost from the tool bus (bash-CLI "no such command") | `8959e23d` + a test for every gen command | found by that probe |

### K. Harness and app bugs this round
| Bug | Fix | Verified by |
|---|---|---|
| **27 s first token** on a new chat: pi's cloud compaction defaults fired at half our 32k window after a 23k task, summarised one message (1,532 tokens of thinking, 35 s), freed nothing; the next chat queued behind it | `43945a21` the corp roles' rule for chats: compact within an eighth of the window and only when it frees a tenth; a person's Compact always runs | 4 tests; live on the next heavy run |
| **The app crashed at launch** after `43945a21` (main loaded pi, ESM, to read one string) — the crash dialogs the user saw were this and a llama-server I killed by its parent | `db67f548` the string alone, no imports | main.js has no top-level pi require; headless launch reaches the composer |
| A string field given an object (write's content as JSON) failed validation 3× | `a325ad60` | 2 tests |
| `present name` without its extension | `f2275fbc` | 3 tests |
| A traced picture's folder named after its path (`var-folders-4h-…`) | `64b39427` | in dist now |

### L. UI/UX
| Item | State |
|---|---|
| The house kit's teal → the app's blue (#0071E3 / #0A84FF) for every generated page: maths, diagrams, charts, documents, decks | ✅ `5ca9bfef` Paper & blue, all gates (contrast, colour-blind pairs, no purple); maths pages looked at light and dark |
| A reply linking an image that does not exist shows a broken-image glyph (SHM run: the model linked `…mass-on-a-spring.png`) | open |
| The chat shows "compacting" for a frame when the gate holds a compaction | open (cosmetic) |

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
