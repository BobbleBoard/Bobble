# Visual output quality — what Bobble makes out of the box, and the system changes that raise it

*Track 10 of the 2026-09-23 push. Research only: no repo file was changed and nothing was committed. Repo HEAD `c9fe7098` (2026-09-21); the working tree carries other agents' uncommitted edits. Samples, renders and the scripts that made them: [`deliverables/visual-quality/`](../visual-quality/).*

> **Recommendation.** Put every fixed-canvas visual (decks, one-pagers, motion, diagrams, page sections) on **one design-token system**, laid out by the Chromium the app already embeds, and feed it **structured content from the chat model** instead of a second, context-free LLM pass. Emit native files through the HTML-to-native emitters that already sit, unused, in `tools/office-gen`. End every render with a **deterministic lint-and-fix pass**, and let image generation fill **declared slots**. The model supplies the content and the choices. The system owns the design.
>
> **Biggest finding.** Most of what looks bad out of the box comes from the system, not the model. Even with a flawless spec, the deck pipeline sets 49% of the text under 14 pt and leaves three slides with empty colour panels. Driven the way the 4B drives it, a title collides with its subtitle and a numeral wraps over its label, and nothing catches either. The renderers also quietly corrupt ordinary inputs: `22M` and `$38k` draw as zero-length bars, only 5 of 10 bars are kept, and a blank table header leaves a broken slide while the tool still reports success. HyperFrames prints the user's prompt as the title (it happened twice in real use). There is no diagram tool at all: hand-written diagram SVGs are refused and redirected to OmniSVG, which cannot draw words.

---

## 1. Goal

The user, verbatim: *"improve quality of visual outputs app produces out of the box, eg. pptx, docx, svg, diagrams, charts. have subagents create some samples of their own on sample prompts and critique what makes theirs better. eg. website design and such when applicable utilizing image generation and refinement passes effectively to make high quality websites or presentations or pages or hyperframes animations … many tools are in place and perhaps most of the work is to now tune a model to use these tools effectively, [but] there is likely quite a ways to go … to better the whole system rather than putting more weight than we need to on the model."*

Restated precisely:

1. **Scope.** Every visual Bobble produces: `.pptx`, `.docx` (and `.pdf`), SVG graphics, diagrams, charts, web pages and sites, and HyperFrames motion. It should look **designed**, be **correct** (nothing dropped, nothing invented, nothing overlapping) and be **consistent** (a deck, its charts and its title card belong together). This has to hold *out of the box*: the default small local model (Qwen3.5-4B class), bash-CLI tool mode, and no steering from the user.
2. **Method, as asked.** Make samples on realistic prompts, then make better versions with the same toolchain and critique them precisely. Turn the gap into **system** changes: design systems and templates baked into the tools, defaults, automatic critique-and-refine passes, where image generation slots in, and what the tools should refuse or auto-correct. Lean on the system before the model. Track 6 (the harness LoRA) complements this work and does not replace it.
3. **Constraints this design respects:**
   - offline by default;
   - one llama-server KV slot, so every extra model call costs TTFT (memory `pi-desktop-ttft-regression`, `pi-desktop-slot-ownership`);
   - mechanism only where it assumes nothing about the task, and prompt pressure everywhere else (`user-prompt-pressure-not-enforcement`);
   - no purple;
   - headless verification with before/after images for anything visual (`user-headless-testing-always`, `user-visual-confirmation-required`);
   - Windows and Linux coming (track 4).
4. **Out of scope here, with the interfaces named:** studios as editors (track 8), the Ming design models (track 9), the image improve-loop itself (track 11), and the LoRA (track 6).

---

## 2. What exists today

### 2.1 The pipelines, as wired

| Output | How a chat reaches it | Code | Who decides layout | Where styling comes from | What the model gets back |
|---|---|---|---|---|---|
| Deck `.pptx` | `office make pptx --brief …`, or `write deck.pptx <text>` (`withOfficeFormats` turns it into a make) | `tools/office-gen/office.py` → `make_deck.outline` + one `make_deck.fill` per slide. These are **second LLM calls** with their own system prompt, so they evict the chat's slot. Then `render_deck.py` + `hero.py` + `viz.py` (1,054 lines) + `textfit.py` | 16 python-pptx layout functions with hand-placed inch/EMU geometry. The planner's `MENU` offers 14 of them; `title`, `bullets` and `two_column` are never offered (`bullets` is also the fallback for any layout that fails) | 5 named `THEMES` in `render_deck.py`; the model picks one by name. **Both captured 4B plans chose `midnight`** | a slide-by-slide summary **of the spec** (not of what was drawn), plus `CHECK_LINE`, plus a capture only if the server can see images |
| Doc `.docx` / `.pdf` | the same, with `docx`/`pdf` | `make_doc.generate` → `doc_render.py` / `pdf_render.py`, with `palette.py` | 9 block types in a flowing layout. The prompt *forces* "Open with `cover`" and "9-14 blocks" | the model picks 2 hex values, `palette.build` derives the rest, WCAG guard | the same |
| Chart | `chart …` (TS tool), or `office make chart` (Python) | `packages/harness/src/tools/chart-tool.ts` → `packages/charts` (`layout.ts`, `svg.ts`, `style.ts`: 11 looks). **A second, separate renderer:** `make_chart.py` → `chart_render.py` | deterministic. The static SVG is always 960×560 | a LOOK per chart. `pickLook` **hashes the title**, so charts in one answer differ on purpose; `chart_render.py` has its own palette | a data line, a look line, `REPLY_LINE`, and an inline card in the chat |
| SVG graphic | `svg <prompt> --out …` | `apps/desktop/electron/gen/omnisvg.ts` (OmniSVG 1.1 4B GGUF) | a generative vector model | — | "Made 1 SVG … N paths" |
| **Diagram** | **no tool.** A hand-written SVG is *refused* by `packages/harness/src/tools/handwritten-svg.ts` and redirected to `svg`. The only diagram primitive is the office `flow` layout (circles on one rail) | — | — | — | — |
| Page / site | the model writes `index.html` itself; `present` returns one 1280×900 capture (`apps/desktop/electron/pi/pi-main.ts` `renderPage`) | — | the model | the model's habit (see §2.2.5) | a screenshot, when the model can see |
| Motion | `media generate video "<prompt>"`: `MOTION_GRAPHICS_RE` in `packages/gen-tools/src/tools.ts` routes it to `hyperframes` | `apps/desktop/electron/gen/video-dispatch.ts` → `hyperframes-still.ts` (`buildSceneDocument`, `seekScript`; an APNG join is in progress in the working tree) | an authored scene, or else **a title card whose `<h1>` is the prompt** | hard-coded navy radial background and white text | poster = frame 0 |
| *Dormant* | — | `html2pptx.py`, `html2docx.py`, `html2pdf.py` (1,078 lines, 2026-08-09): browser-measured element records → native editable shapes or vector PDF. **No live caller**; `office_chart.py` re-implements the record shape for charts only | a browser, if one measured | whatever the HTML says | — |

**Measured timings.** In the replay runs below, the renderers take **0.1–0.5 s**. The rest of an `office make` (≈25–28 s, `pi-desktop-office-pipeline`) is the plan/fill LLM hop. That hop is also where fabrication happens (§2.2.1, §2.2.2), and each call evicts the chat's KV slot.

### 2.2 Six prompts, measured

**How the samples were made. No model ran on this Mac.**

- `office.py` ran for real against a **replay stub** (`_tools/replay_server.py`) that serves canned plan and fill replies. Every habit in them is copied from a captured 4B reply, and the capture is cited next to it.
- The chart tool ran through the harness's own `buildCli`/`resolveCli` and the registered tool, with bash doing the word-splitting and the app's `protectShimDollars` applied (`_tools/chart_cli.mjs`).
- HyperFrames ran through its own `buildSceneDocument`/`seekScript`/`frameTimes`, in a headless Chromium (`_tools/hyperframes_stills.mjs`).
- Decks and docs were rendered by QuickLook (`qlmanage -t`, one single-slide deck per slide; `_tools/split_ql.py`), and pages by Playwright's headless shell (`_tools/page_shot.mjs`).
- Every render checked the frontmost app before and after (`lsappinfo front`); focus never moved.

**REAL** marks something a real model made in the user's app:

- captured specs in `~/.cache/bobble/office-gen/`, copied to `_real-4b-evidence/specs/`;
- chat folders under `~/Bobble/`;
- transcripts in `~/.pi/agent/sessions/--Users-user-Bobble--/`.

The dimensions critiqued are the ones the user named: **layout grid, typography scale, colour, density, imagery, hierarchy, consistency**.

#### 2.2.1 A six-slide pitch deck ("Tidewell", `pitch-deck/`)

Prompt (`pitch-deck/brief.txt`): a smart water-leak sensor startup. It gives the problem ($24k per claim), the solution ($39 sensor plus auto shut-off), traction (42 buildings, 3,100 units, $38k MRR, +18% MoM), the market (22M units), the model ($3/unit/month), the team, and the ask ($2.5M).

![deck a / b1 / c](../visual-quality/pitch-deck/renders/compare-a-b1-c.png)

REAL evidence: the 4B's solar deck (`last_pptx_spec.json`, 2026-09-16), re-rendered by today's renderer. Every bar is labelled **"GW"** instead of its number. Only 5 of 10 years are drawn, and the highlight points at index 9, which no longer exists. The kicker reads "BAR CHART SHOWING CUMULATIVE CAPACITY BY YEAR". The matrix is all-true, and the right 38% of the cover is an empty panel ([sheet](../visual-quality/_real-4b-evidence/renders/solar-deck-4b-real-sheet.png)).

- **(a) `office make pptx`, driven the way the 4B drives it** (`a-replies-4b-style.json`, habits cited in its `_note`):
  - The title collides with the subtitle. `hero.py` sizes the title by character count (`58 if len(title) < 46 …`) and puts the subtitle at a fixed 5.05 in.
  - "3,100" wraps into "3,10 / 0" over its own label. `L_stats` sets every value at a fixed 76 pt.
  - The market bar is **empty**, the 3,100 bar is **full**, and both read "units". `_num("22M") == 0`, and `display` carried the unit, exactly as the captured spec's `"display": "GW"` did.
  - All flow nodes are filled, because `bool("false") is True`; raw_fill3/5 sent strings.
  - Business model and team are missing. The plan lists the planner's own rules in order, as `raw_plan.txt` did.
  - The footnote is invented ("Data sourced from internal company metrics"); `raw_fill1` has "Data sourced from IEA and national grids".
- **(b1) The same pipeline with an expert spec** (`b1-replies-expert.json`), using only menu layouts and the brief's own numbers:
  - Nothing collides, but **49% of all text characters are under 14 pt** (51% in a). There are **12 decorative accent bars and stripes** (the rule under every title, the spine) and **3 full-height flat colour panels with nothing in them**: the hero and closing layouts expect a photo, and offline they get a gradient.
  - The natural market table (a blank corner header cell) **crashed `L_table`** (`runs[0]` of an empty cell). The result was a blank, default-blue table slide *plus* a fallback bullets slide: 7 slides, while the summary said 6 and `warnings: []` ([evidence](../visual-quality/pitch-deck/renders/b1-table-crash/)).
- **(c) The same primitives, driven by a design system** (`c-design-system-slides.html` → `_tools/html_to_pptx.mjs` → **the repo's own, unmodified `html2pptx.build`** → native, editable pptx):
  - 25% of text under 14 pt, and only footers and captions at that; 0 empty panels, 0 rules under titles, 0 overlaps.
  - Headings are balanced by the browser (`text-wrap: balance`). It uses 93 native shapes.

| Dimension | (a) today, 4B-driven | (c) same primitives + design system | System change |
|---|---|---|---|
| Layout grid | Hand-placed inches per layout. Content hugs the top 40% of the flow and stats slides; hero and closing reserve 38–40% for a photo that never arrives | 12-col grid on 1280×720, 72 px margins, 8 px rhythm; every slide is composed edge to edge (ripple motif, equation row, 4-up KPI baseline) | HTML templates on a grid (VQ-06); an "empty region" lint (VQ-07); an image slot or a variant without it (VQ-09) |
| Typography scale | Fixed sizes: kicker 10.5 pt, captions 11, labels 12.5, numerals fixed at 76 → wrap | 7-step scale (17/20/22/30/52/84/120 px); the browser measures and breaks lines | Tokens (VQ-04), measured layout (VQ-05), a min-size lint |
| Colour | 5 named themes, and the model always says `midnight`: coral on navy for any subject | One accent from the subject (teal for water); ink, paper, deep and tint roles | Kits plus brand-from-image (VQ-04) |
| Density | One idea per slide, but 30–60% dead area and tiny captions | Same content at a larger scale, no dead panels | Density targets per template |
| Imagery | None offline (a gradient). `image_query` only (picsum when online); no way to pass an image | Drawn motif (native circles) as cover art; slots ready for generated pictures | Image slots + generation (VQ-09) |
| Hierarchy | An ALL-CAPS accent kicker competes with the title; an accent rule under every title, which [Anthropic's pptx guidance](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md) calls an AI-generated-slide hallmark | label → headline → hero number → caption, with one accent use per slide | Kit rules + an AI-tell lint (VQ-07) |
| Consistency | Dark/light alternates by layout, not by narrative; footers only on light slides | One motif (the rings) shared with the motion card (§2.2.6) | One kit per project across all outputs (VQ-04/14) |

#### 2.2.2 A one-page report (docx, `one-page-report/`)

Prompt: summarise Q3 support: 12,480 tickets (+9%), median first response 2h14m (was 3h40m), CSAT 91% against a 90% target, backlog down from 1,900 to 640, three drivers, three recommendations.

![report a / b / c](../visual-quality/one-page-report/renders/compare-a-b-c.png)

REAL evidence:

- The cookie-recipe docx made in the user's app on 2026-09-12 ([page 1](../visual-quality/_real-4b-evidence/renders/cookie-recipe-docx-real-page1.png)). Its title runs to the cover band's edge with no padding, the table collapses to content width, the heading rules are stubby ticks, and it cites a **fabricated source**: `https://www.allrecipes.com/recipe/123456/`.
- The captured docx and PDF specs, which invent numbers and people:
  - "The Art of Tea" invents "2.5B+ daily consumers" and quotes "The Tea Lover's Perspective".
  - "Annual Unit Sales" (brief: 12/19/15/22) states **"Total Units 28"** (the real total is 68) and **"83% YoY"** (its own callout says 46.7%). It adds a whole regional table the brief never had, a quote from a "Director of Operations", and a second `cover` used as the conclusion.

Findings per version:

- **(a)** 13 blocks, because the prompt demands 9–14 and a cover.
  - As a docx, page 1 is 40% cover band. The stats row **collapses to "12,4802h 14m91%640"**: `B_stats` sets only cell widths, while Word lays tables out from `tblW` (`doc_render.py` already has `_tbl_width`, and uses it only for rules). The heading rules render as ~13 pt ticks in QuickLook: the rule's one-cell table has a paragraph mark that keeps the 11 pt Normal size, so Word will likely draw the same. The callout is half width.
  - The same spec through the pipeline's `pdf_render` runs to **3 pages** for a "one-page" ask.
- **(b)** The same pipeline used well: a heading as the masthead, no cover, and the chart tool's hbar put in with `office edit --chart` as a docx picture, palette matched by hand. It **fits one page**, but the stats-row collapse and the stubby rules are renderer bugs a spec cannot avoid. The chart is 3.5 in tall for 3 bars, with ~8 pt labels, because the SVG is always 960×560.
- **(c)** Tokens plus browser layout → the dormant `html2pdf.py` → a one-page vector PDF. It also exposed that `pdf_render`/`html2pdf` use **non-embedded base-14 fonts**: poppler drew no bold at all ([`c-page1-poppler-no-bold.png`](../visual-quality/one-page-report/renders/c-page1-poppler-no-bold.png)), and the output depends on the viewer.

| Dimension | (a) | (b)/(c) | System change |
|---|---|---|---|
| Layout grid | A forced cover, then flowing blocks; no idea of a page | (c) a 12-col page, one page by construction | Page budget + a compact-masthead block (VQ-06/08) |
| Typography | 30 pt cover title; 26 pt stats in collapsed columns | (c) 60 px H1, 64 px numerals over 21 px captions | `tblW` fix (VQ-01); token scale |
| Colour | #1E3A5F/#E63946, the same pair as the captured PDF spec | Teal for good deltas (a semantic colour) | Kit semantic roles (good/bad/neutral) |
| Density | 3 of 13 blocks are generic prose ("This report details…") | Every sentence carries a number from the brief | Planner prompt: no filler; block budget from the page budget (VQ-08) |
| Imagery / data | No chart block in docx (pdf has `bars`) | Chart in the document's palette; (c) native bars | Charts inherit document tokens (VQ-02/04) |
| Hierarchy | ALL-CAPS labels, stubby rules, an italic standfirst on every heading | label → headline → KPI row → section → recommendation | Kit rules |
| Consistency | The chart tool's look and the document's font are unrelated unless set by hand | One kit | Chart look from the kit (VQ-04) |

#### 2.2.3 A flow diagram (`flow-diagram/`)

Prompt: order placed → payment check (fail: email the customer, retry) → pick & pack → quality check (fail: back to pick & pack) → ship → delivered → review request.

![flow a / b / c](../visual-quality/flow-diagram/renders/compare-a-b-c.png)

- **(a) There is no diagram path.**
  - A hand-written `flow.svg`, written the way a 4B writes it (no `<title>`), is **refused** by `handwritten-svg.ts`, which tells the model to run `svg "a red heart…"`. OmniSVG cannot write words: REAL, asked on 2026-09-21 for "an educational SVG … with equations displayed", it drew an abstract shape and a car ([evidence](../visual-quality/_real-4b-evidence/renders/omnisvg-graph-request-real.png)). The four other OmniSVG results on disk (`~/Bobble/generated/*svg*`, the same day) are near-empty, or show the Chinese characters "号线" for a smiley-face request ([sheet](../visual-quality/_real-4b-evidence/renders/omnisvg-generated-folder-real.png)). The same diagram inline in a page is also refused (`a-guard-result.txt`).
  - Routed to the deck pipeline instead, the `flow` layout **keeps `steps[:5]`**: *Delivered* and *Review request* vanish silently. It cannot draw a branch, so the failure loops become captions. Every node is "emphasised" (string booleans), and "Payment Check" touches the circle's edge.
- **(b)** A hand-written SVG (a strong author). Clean, but I routed the retry loop wrong on the first try: hand-routing edges is exactly the job a layout engine exists for.
- **(c) The proposed `diagram` tool, prototyped:** 8 lines of Mermaid for the graph (syntax a 4B already knows; the sample's 7 extra styling lines are what the tool's theme would supply), laid out by dagre, in the house theme, rendered offline in headless Chromium. All 8 nodes and all 3 failure edges are there, with labelled branches and semantic colours (failure orange, done teal). There is a sketch variant too.
  - dagre's placement is less tidy than a hand-routed rail: it drops the start node low. ELK layout and kit spacing are part of VQ-10.
  - Two traps the tool must own: Mermaid 11 dropped a class's label colour when the host page styled `p`, and a dark node needs a light label. The prototype's contrast guard handles both.

| Dimension | (a) office `flow` slide | (c) diagram tool | System change |
|---|---|---|---|
| Layout | 5 circles on one rail; branches impossible; 2 steps dropped | Graph layout, branches, labels on edges | `diagram` tool (VQ-10) |
| Typography | 11.5 pt bold inside 1.24 in circles, touching the edge | 17 px labels in boxes sized to their text | — |
| Colour | Every node accent-filled | Orange = failure path, teal = done, ink = start | Semantic classes from the kit theme |
| Hierarchy | All nodes equal | Distinct start, decision and end shapes; loops read as secondary | — |
| Correctness | Silent truncation, no branches | 8/8 nodes, 3/3 loops | Lint: nodes in = nodes out (VQ-07) |
| Routing | Hand SVG refused → OmniSVG | Mermaid text → `diagram` | Guard routes diagram-shaped markup to `diagram` (VQ-10) |

#### 2.2.4 A chart set (`chart-set/`)

Prompt: a bar chart of MAU by quarter (48k, 61k, 79k, 102k), and a line chart of revenue against costs for 2021–2025 in $M.

![charts: a (top), b (bottom)](../visual-quality/chart-set/renders/sheet-a-top-b-bottom.png)

REAL evidence: "demo all your dataviz skills" (session 2026-09-17 UTC, 17 `chart` calls). The 4B passed JSON arrays, and **all 12 untitled charts were written to `bar-chart.svg`**, one over the other. Its closing message then claimed "10 different charts". `--chart-type=line` was silently ignored. Re-rendered with **today's** code ([sheet](../visual-quality/chart-set/renders/a4-real-4b-specs-rerendered-today.png)): the "User Engagement Metrics" scatter of categories X/Y/Z/W still draws **every point at x = 0** on an axis from 0 to 0.2, and "Product Mix" (percentage shares) is `stacked` with one series, so it draws as plain bars.

- **(a)** The same call shapes, run on today's code:
  - The second chart **overwrote the first** (`bar-chart.svg` both times; the tool said "Drew a bar chart" both times). The requested line came out as grouped pill bars.
  - Neither chart has a title or units, and revenue is red while costs are orange: two warm hues for an opposed pair.
  - `office make chart` for the same MAU data uses a **different renderer with a different look** (navy on cream, a rotated y title restating the title).
- **Input corruption found while testing**, all on today's code:
  - `--values "22M, 3,100"` draws **Market 3, Today 100**: the thousands comma splits the list and "22M" is dropped.
  - `--values "$1.2M, $2.4M"` is refused with "chart needs its data", which names the wrong problem.
- **(b)** The tool used well: insight titles ("MAU more than doubled in 2025", "Revenue passed costs in 2022 — the gap is now $2.2M"), a subtitle carrying unit and period, emphasis (Q1–Q3 grey-blue, Q4 highlighted), one look for the whole set, and a blue/orange opposed pair.
  - The remaining gaps are the tool's, not the call's: the ticks carry no units, the `$M` unit formats as "5.6 $M", the labels are 11 px on a 960 px canvas, the canvas is fixed-size, and there are no end labels.
- **Palette check.** I ran every look through the dataviz method's palette validator (`chart-set/looks-palette-validation.txt`). **All 11 looks fail at least one check, and 7 fail colour-blind separation.** Example: editorial's adjacent `#6B8E23 ↔ #C0504D` has a deutan ΔE of 3.8 (target ≥ 8), and clean's `#9AC05F ↔ #D9B44A` a protan ΔE of 2.0.

| Dimension | (a) | (b) | System change |
|---|---|---|---|
| Form | The requested line became bars; a scatter of categories collapses; one-series stacked | Line for the trend, bars for the quarters | Type aliases + coercions (VQ-02) |
| Titles / naming | None; `bar-chart.svg` overwritten | Insight title + unit/period subtitle | Title from data; unique names (VQ-02) |
| Colour | Warm/warm pair; all 11 looks fail ≥ 1 palette check | Emphasis grey + one highlight; opposed hues | Validated looks (VQ-03) |
| Units / scale | "48, 61, 79, 102", no k; ticks without $ or M | 48,000…; "$ millions" in the subtitle | Units on ticks; `$M`/`k` formatting (VQ-02) |
| Consistency | Two renderers; looks rotate within one answer | One look for the set | One look per conversation/kit (VQ-02/04) |
| Size | Fixed 960×560 whether 3 bars or 30 | Unchanged: the tool has no size knob | Size presets, content-aware height (VQ-02) |

#### 2.2.5 A landing page (`landing-page/`)

Prompt: "Kiln", a Portland pottery studio: a 6-week beginner course at $280, drop-in open studio at $25, with a hero, schedule, pricing and signup.

![landing: real 4B page | (a) house style | (b) designed](../visual-quality/landing-page/renders/compare-real-a-b.png)

REAL evidence: the only two pages the 4B wrote in Bobble chats (`hi-8/racing_simulator_mockup.html`, 2026-09-13, and `demo_animation.html`, 2026-09-22). They share one house style:

- the `#1a1a2e → #16213e → #0f3460` gradient, a `#e94560` accent with a glow `text-shadow`, and an emoji before every heading;
- a centred header with an "Experience the Ultimate …" subtitle, glass cards, check-mark lists, `∞` stat values, and Segoe UI first in the font stack;
- a phone view that **overflows horizontally by 67 px and 105 px**.

The radar request, in a chat with the `chart` tool (whose types include `radar`), became 12 KB of hand-rolled canvas and `requestAnimationFrame` code.

- **(a)** That house style with the Kiln brief (a labelled reconstruction; no model ran). A pottery studio dressed as a gaming site. Emoji stand in for imagery. The schedule and claims are invented ("All materials included", Mon/Wed 6–8 pm) and presented as fact. The phone view overflows by 112 px.
- **(b)** The same toolchain used well: HTML/CSS with tokens, and **the app's own Qwen-Image outputs** (the user's 2026-09 ceramic-mug generations) as hero and gallery.
  - One family, a 7-step scale, an accent sampled from the hero photo, and black primary buttons.
  - Schedule times the brief didn't give are **marked as samples**. The phone view overflows by 0 px.
  - The weakness left is the imagery itself: nine candidates of **one** composition make a repetitive gallery. That is a shot-list problem for the image loop (track 11).

| Dimension | (a) | (b) | System change |
|---|---|---|---|
| Layout | Centred header, 4-up stats, 3 glass cards; +112 px overflow on a phone | Split hero with photo, two offers, schedule table, gallery, signup band; responsive | Section templates + responsive lint (VQ-12/07) |
| Typography | Segoe UI (absent on a Mac), a 3em glowing h1 | Avenir Next/Helvetica stack at 72/40/21/18, display tracking −0.03em | Bundled OFL fonts + a scale (VQ-04) |
| Colour | The same navy/pink for a racing sim and a pottery studio | Ink/paper + one accent from the photo | Kits / palette from image (VQ-04) |
| Imagery | Emoji as icons | Generated photographs | Image slots + generation (VQ-09) |
| Hierarchy | Everything pink and glowing | One primary action, one ghost | — |
| Honesty | Invented schedule and claims | Samples marked | Placeholder marking for facts not in the brief (VQ-12) |

#### 2.2.6 A short motion graphic (`motion-graphic/`)

Prompt: a 6-second title card for the launch, "Tidewell" / "Stop leaks before they start", in brand teal.

REAL evidence: the user's "10-second animated title card with the text 'Launch day'…" (121 frames) and their radar-chart request (121 frames, plus a GIF the model assembled). **Both rendered the prompt itself as the title**, white on navy, with "bright yellow" ignored ([title card](../visual-quality/_real-4b-evidence/renders/hyperframes-launch-day-title-card-real.png), [radar](../visual-quality/_real-4b-evidence/renders/hyperframes-radar-request-real.png)). The model then tried to write the "MP4" with PIL.

![motion a](../visual-quality/motion-graphic/renders/a-text-prompt-title-card-sheet.png)
![motion b](../visual-quality/motion-graphic/renders/b-authored-scene-sheet.png)

- **(a)** Our prompt through the same path: `buildSceneDocument` makes the prompt the `<h1>`. 73 frames: "6-second animated title card for the Tidewell product launch with the tagline …", in white. Two things compound it:
  - `prompt-guidelines.ts` maps `hyperframes` to the VIDEO dialect, so the enhancer makes the printed prose *longer*.
  - The poster is frame 0, which shows the text at 35% opacity.
- **(b)** An authored, seekable scene in the deck's brand: a drop falls, rings spread along a waterline, the wordmark rises, the tagline wipes on, and a slow ring breathes through the hold.
  - The seek pinned 9 animations; 69 of 73 frames are distinct. [GIF](../visual-quality/motion-graphic/renders/b-authored-scene.gif) and [MP4](../visual-quality/motion-graphic/renders/b-authored-scene.mp4).
  - Its frame 0 is empty, so the poster must be the settled frame.

| Dimension | (a) | (b) | System change |
|---|---|---|---|
| Correctness | Prints the instruction as the title (REAL, twice) | The title is the quoted text | Parse the quoted text; never print instructions (VQ-11) |
| Colour | Navy + white; "teal" ignored | Brand teal from the kit | Kit/brand tokens |
| Motion | Rise, glow and sweep, the same for every prompt | Drop → rings → rise → wipe → breathe, timed in seconds | Template catalog (VQ-11) |
| Poster | Frame 0 (a half-faded paragraph) | The settled last frame | Poster from the settled frame |

### 2.3 Defect ledger (every row reproduced, with evidence in `deliverables/visual-quality/`)

| # | Defect | Where | Kind | WP |
|---|---|---|---|---|
| D1 | Hero title sized by character count; subtitle at a fixed y → overlap | `hero.py` `hero_title` | system | VQ-01 |
| D2 | Stat values fixed at 76 pt → "3,10 / 0" wraps over the label | `render_deck.py` `L_stats` | system | VQ-01 |
| D3 | `_num("22M")`, `_num("$38k")`, `_num("1.2B")`, `_num("$24,000")` all return **0** | `render_deck.py` `_num`; `chart_render.py` `_num` lacks k/M | system | VQ-01 |
| D4 | A unit-only `display` replaces the number ("GW", "units") | `L_bars` / `viz.bar_rows` | system (+model) | VQ-01/08 |
| D5 | `"emphasis": "false"` → emphasised | `L_flow` `bool(...)` | system | VQ-01 |
| D6 | Silent truncation: bars/flow/bullets `[:5]`, table rows `[:6]`, stats and closing `[:4]`, matrix `[:6]×[:3]`; docx table `[:12]`, bullets `[:8]`. The summary still reports the untruncated spec | render_deck, viz, doc_render, `office.summary_of` | system | VQ-01 |
| D7 | A failed layout leaves its half-built slide *and* adds a fallback slide; not in `warnings` | `render_deck.build` | system | VQ-01 |
| D8 | An empty table header cell crashes `L_table` | `render_deck.L_table` | system | VQ-01 |
| D9 | `title`/`bullets`/`two_column` are missing from the planner `MENU` | `make_deck.MENU` | system | VQ-06 |
| D10 | Decks cannot take an image (only `image_query`; offline → gradient); hero and closing leave 38–40% empty | `hero.py`, `imagery.py` | system | VQ-06/09 |
| D11 | 5 fixed deck themes; both captured plans chose `midnight` | `render_deck.THEMES`, `make_deck.outline` | system | VQ-04 |
| D12 | An accent rule under every title, spine bars, ALL-CAPS kickers (AI-deck tells) | `render_deck._head`, `L_bullets`, `_kicker` | system | VQ-06 |
| D13 | Docx stats/callout/table widths ignored (no `tblW`) → collapsed columns | `doc_render.B_stats/B_callout/B_table` | system | VQ-01 |
| D14 | Heading rule = a one-cell table whose paragraph mark keeps 11 pt → a ~13 pt tick | `doc_render._rule` | system | VQ-01 |
| D15 | Cover band has no inner padding | `doc_render.B_cover` | system | VQ-01 |
| D16 | Forced cover + 9–14 blocks whatever the length asked → a "one-page" report runs to 3 pages | `make_doc.generate` prompt | system | VQ-06/08 |
| D17 | Base-14 PDF fonts not embedded → viewer-dependent (poppler shows no bold) | `pdf_render.py`, `html2pdf.py` | system | VQ-05 |
| D18 | The plan/fill model invents quotes, attributions, sources, totals and tables (REAL: 4 captured specs + the cookie docx) | `make_deck`, `make_doc` (a second model with no conversation context) | model, unchecked by system | VQ-08 |
| D19 | The model is told what the spec said, not what was drawn | `office.summary_of` | system | VQ-01/07 |
| D20 | Untitled charts are named `<type>-chart.svg`; the next one overwrites the last without warning | `chart-tool.ts` `chartSlug`/`resolveOut` | system | VQ-02 |
| D21 | An unknown `--chart-type` passes through silently → wrong type | `tool-cli.ts` `FLAG_ALIASES` | system | VQ-02 |
| D22 | `"22M, 3,100"` → Market 3, Today 100 | `packages/charts/src/spec.ts` value parsing | system | VQ-02 |
| D23 | `"$1.2M"` → "chart needs its data" | the same | system | VQ-02 |
| D24 | A scatter with non-numeric labels → every point at x = 0 | `spec.ts`/`layout.ts` | system | VQ-02 |
| D25 | Stacked with one series draws as plain bars; % shares are not a donut | `layout.ts` | system | VQ-02 |
| D26 | Integer data gets 2.5-step ticks; ticks carry no units; `$M` → "5.6 $M" | `layout.ts niceStep`, `formatValue` | system | VQ-02 |
| D27 | Static SVG fixed at 960×560; 11 px labels | `svg.ts`/`layout.ts` defaults; the tool passes no size | system | VQ-02 |
| D28 | All 11 looks fail ≥ 1 palette check; 7 fail CVD separation (`mono` is a one-hue ramp, so it fails as a categorical palette by design) | `packages/charts/src/style.ts` | system | VQ-03 |
| D29 | Two chart renderers with different styles; `pickLook` varies looks inside one answer | `chart_render.py` vs `packages/charts`; `withLook` | system | VQ-02/04 |
| D30 | No diagram tool; the guard sends diagrams to OmniSVG, which cannot write words | `handwritten-svg.ts`, capability lines | system | VQ-10 |
| D31 | A HyperFrames text prompt renders as a title card of the prompt (REAL ×2) | `hyperframes-still.ts buildSceneDocument` | system | VQ-11 |
| D32 | HyperFrames poster = frame 0 | `hyperframes-still.ts`, `video-dispatch.ts` | system | VQ-11 |
| D33 | The enhancer treats `hyperframes` as the VIDEO dialect | `prompt-guidelines.ts` | system | VQ-11 |
| D34 | No page kit; the 4B's single house style, phone overflow, emoji icons, invented facts | — | model, with no system support | VQ-12 |
| D35 | Page preview is one 1280×900 viewport: no phone view, no lint | `pi-main.ts renderPage` | system | VQ-07/12 |
| D36 | html2pptx: a leaf's text in one unwrapped box; `50%` radius read as 50 px → rounded square; letter-spacing dropped; SVG `rect`/`line`/`text` and `<img>` ignored; text around inline tags dropped | `html2pptx.measure_js`, `_shape`, `_text` | system | VQ-05 |
| D37 | Galleries repeat one composition (9 candidates of one prompt) | image flow | system | VQ-09 / track 11 |

**Attribution.** 35 of the 37 defects are system: geometry, parsing, truncation, palettes, routing, missing tools and silent reporting. A better model cannot fix them, because they happen *after* the model has spoken. The model-side gaps (D18, D34, and part of D4) are ones the system can *check* without assuming anything about the task: provenance, units in value fields, and facts not in the brief.

---

## 3. External research

| Source | What it is / what it found | License / footprint | What it means for Bobble |
|---|---|---|---|
| **HyperFrames** (HeyGen) — [repo](https://github.com/heygen-com/hyperframes), [research post](https://www.heygen.com/research/html-to-video), [design systems](https://hyperframes.heygen.com/prompting/design-systems.md), [lint](https://hyperframes.heygen.com/packages/lint.md), [docs index](https://hyperframes.heygen.com/llms.txt) | HTML/CSS/GSAP compositions with `data-start`/`data-duration`, `class="clip"`, and paused timelines on `window.__timelines`. Rendered by *seeking* each frame in headless Chrome (`HeadlessExperimental.beginFrame`), then FFmpeg. A per-project **`frame.md`** holds the brand: normative hex/fonts in frontmatter, prose do's and don'ts, and "name what's sacred, let the agent stage the rest". A **catalog** of blocks (lower thirds, animated data charts, transitions). **`@hyperframes/lint`** rules include `non_deterministic_code` and `gsap_timeline_set_initial_hide` (frame-0 state). HeyGen "shaped the simplest version … around what Gemini Flash could reliably author", ran evals across models, and tightened the runtime where models failed. They also found "outputs got safer and more repetitive the more guardrails we added". | Apache-2.0; Node 22+ and FFmpeg | Bobble's seek renderer is already the same idea. Adopt the **conventions** (brand file, templates/catalog, lint on frame 0 and seekability) rather than the runtime. Their "design for the small model" loop *is* this track's method. |
| **Presenton** — [repo](https://github.com/presenton/presenton) | An open-source AI deck generator. Templates are **HTML + Tailwind**, export is "fully editable PPTX", it runs with Ollama/LM Studio, and it can create templates from existing PowerPoint files | Apache-2.0 | Independent confirmation that HTML templates → editable PPTX is the practical route for local models (VQ-05/06). "Template from a pptx" is a later brand feature. |
| **Anthropic skills** — [repo](https://github.com/anthropics/skills), [pptx SKILL.md](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md), [frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | pptx: generate → validate → **render to images → inspect for overflow, overlap and contrast → fix → re-render only the changed slides**. Titles 36–44 pt, body 14–16 pt, margins ≥ 0.5 in. Avoid "accent lines under titles", decorative bars, and cream defaults. frontend-design: names AI-UI clusters (dark ground + acid accents, SaaS card kits with uniform radius and soft shadows, ALL-CAPS labels, cream + terracotta) and asks for "one element … memorable, keep everything around it quiet". | Document skills are **source-available, not redistributable** (the bundled `ATTRIBUTION.md` already excludes them); **frontend-design is Apache-2.0** | Use the pptx skill as a reference for the loop and thresholds (VQ-07); do not vendor it. The frontend-design text can be adapted into a Bobble skill with attribution (VQ-13). Its tells match the 4B's pages one for one. |
| **PPTAgent / PPTEval** — [arXiv 2501.03936](https://arxiv.org/abs/2501.03936), [code](https://github.com/icip-cas/PPTAgent) | Generates by **editing reference slides** (it extracts layouts and content schemas from real decks, then fills them), and evaluates on **content, design and coherence** | open code | Template-by-example beats free generation. Our kits and templates are the "reference slides"; PPTEval's three axes become the eval report's axes (VQ-00). |
| **SlideAudit** (UIST '25) — [arXiv 2508.03630](https://arxiv.org/abs/2508.03630), [data](https://github.com/zhuohaouw/SlideAudit) | 2,400 slides annotated with a flaw taxonomy (typography, layout, colour, imagery). **LLMs detect slide design flaws at F1 0.331–0.655**; taxonomy-guided prompting is best; 82% of slides improved from a generated remediation plan | CC BY 4.0 dataset | A VLM "does this look good?" pass is weak, so **deterministic lint first**, and a taxonomy-scoped VLM pass only as an extra (VQ-07). The dataset can seed a critic or LoRA (track 6). |
| **UICrit** (UIST '24) — [arXiv 2407.08850](https://arxiv.org/abs/2407.08850), [data](https://github.com/google-research-datasets/uicrit) | 3,059 designer critiques of 983 UIs; few-shot plus visual prompting gave a **55% gain** in LLM UI feedback | license not verified here | Critique quality comes from targeted examples, not generic "review this" prompts. |
| **UIClip** (UIST '24) — [arXiv 2404.12500](https://arxiv.org/abs/2404.12500) | A CLIP-based model scoring a screenshot's design quality and relevance to a description; closest to 12 designers' rankings | CLIP-size | A candidate cheap scorer for best-of-N page and image selection (VQ-09/12, track 11). Not needed for v1. |
| **Design2Code** — [arXiv 2403.03163](https://arxiv.org/abs/2403.03163) | Benchmarks screenshot→HTML with CLIP similarity and block/text/position/colour matching | — | Metric ideas for the page eval; not a generator. |
| **Mermaid** — [repo](https://github.com/mermaid-js/mermaid) (v11.17.2 on jsdelivr, 3.5 MB min.js) | 20+ diagram types (flowchart, sequence, class, state, ER, gantt, mindmap, timeline, sankey, C4, architecture, block…), `themeVariables`, `look: 'handDrawn'`, dagre or ELK layout; renders client-side, offline | MIT | Runs in the Chromium we ship, and small models know the syntax. **Prototyped in §2.2.3.** |
| **D2** — [repo](https://github.com/terrastruct/d2) | A diagram language; one Go binary; dagre, ELK or TALA layouts; themes; sketch mode; SVG/PNG/PDF/**PPTX** export; offline | MPL-2.0 | Nicer defaults than Mermaid, but a per-platform binary. Kept as an alternative (§4.7). |
| **Practical Typography** — [summary](https://practicaltypography.com/summary-of-key-rules.html) | Print body 10–12 pt; line spacing 120–145%; 45–90 characters per line; all caps only for less than a line, with 5–12% tracking; centred text sparingly | — | Lint thresholds for documents (VQ-07). |
| **Dataviz method** (the palette validator I ran) | Categorical palettes need adjacent-pair CVD ΔE ≥ 8 (OKLab ×100), normal-vision ΔE ≥ 15, marks ≥ 3:1 on the surface; thin marks, a legend for ≥ 2 series, selective direct labels, no dual axis | method only | Bobble's looks fail it (§2.2.4) → VQ-03 implements the checks natively as a test. |

**Cross-cutting conclusion.** Every team getting good visuals out of models does three things Bobble doesn't yet do together:

1. **Templates and tokens owned by the system**: Presenton, PPTAgent, HyperFrames' catalog and `frame.md`.
2. **A browser as the layout engine**: HTML in Presenton and HyperFrames, and Bobble's own dormant html2*.
3. **Render → inspect → fix loops** that start with mechanical checks: the Anthropic pptx loop, the HyperFrames lint, and SlideAudit's evidence that VLM judgement alone is weak.

---

## 4. Design

### 4.0 Principles (each traced to evidence above)

1. **Structured in, deterministic out.** The chart tool already proved it: one call, 10–17 s, nothing invented (`pi-desktop-inline-data-visuals`). Every visual tool should accept the *content* in structure (a Markdown outline, or JSON slides, sections, nodes or scenes) from the chat model, which **has the facts and the conversation**. The second, context-free LLM hop is kept only for prose briefs, and its output passes validators (D18). This also removes the office pipeline's KV-slot eviction on the structured path.
2. **One design system, as data.** Today there are five disconnected style systems: deck `THEMES`, doc palettes, chart looks, `chart_render` colours, the HyperFrames navy, plus the model's own habits for pages. They collapse into **kits**: tokens for colour roles, type scale, spacing grid, radii, fonts per platform, chart look, motion easing and image style. A **brand** can be derived from a logo or screenshot (`paletteFromPixels` exists) or from a per-project `brand.md` (HyperFrames' `frame.md` idea). **One kit per project**, so the deck, its charts and its title card match; variety comes *across* projects.
3. **The browser does the layout.** Decks, one-pagers, motion scenes, page sections and diagram exports are HTML templates filled from content. The app's offscreen window measures them, and the existing emitters (`html2pptx`/`html2pdf`/`html2docx`) write **native, editable** files. Flowing Word documents stay on python-docx, because reports must reflow when edited, but with the bugs fixed and the tokens applied. Evidence: deck (c) against (b1), same content: 25% vs 49% small text, 0 vs 3 empty panels, 0 overlaps.
4. **Close every render with a deterministic lint and auto-fix.** Overlap, overflow, minimum size, contrast, empty regions, dropped content, page budget, provenance, palette, responsive overflow, motion seekability. Fixes the machine can make, it makes (a shrink ladder, then a split, then an alternate template). The rest goes back to the model as ≤ 5 short lines. A VLM "look" is optional, taxonomy-scoped, and in-conversation (§4.4).
5. **Imagery is a slot, not a hope.** Templates declare image slots. The pipeline fills them from user images, then generated pictures, then procedural grounds. **If none is available, it picks the template variant without the slot: never an empty panel** (D10).
6. **The right tool per class of visual.** Data → `chart`. Process and structure → **`diagram`** (new). Icons and illustrations → `svg` (OmniSVG). Pictures → `generate_image`. Motion → HyperFrames **templates**. Pages → a **page kit**. Documents → `office` with structure. The guards route to these tools rather than to the nearest one (D30).
7. **Tools auto-correct the mechanical and refuse only what they can name.** Parse `22M`/`$38k`/`3,100`; coerce impossible chart forms; never overwrite a different file; report truncation. A refusal names the token and the fix (§4.5). This is the kind of mechanism the user accepts: it assumes nothing about the task.
8. **Measure it.** A visual-quality eval harness renders the fixed prompt set, headless and without a model (replayed captures), and scores it with the lint. It gates renderer changes and exports training pairs for the LoRA (track 6).

### 4.1 Architecture

```
chat model ── writes CONTENT (outline / JSON / chart data / mermaid / scene params) ──┐
                                                                                        ▼
                          ┌──────────── packages/design-kit (tokens, kits, brand, validators) ────────────┐
                          ▼                              ▼                          ▼                        ▼
            packages/visual-compose           packages/charts (+kit look)   diagram-tool (Mermaid)   hyperframes-templates
            content-shape → template          chart_tool                    offscreen render         prompt → template params
            (slides, one-pager, sections)
                          │  HTML + tokens + slots
                          ▼
            PresentBridge.measure (app offscreen window: gen/hyperframes-window.ts)  ──►  element records
                          │
                          ▼
            tools/office-gen: html2pptx / html2pdf / html2docx  (+ python-docx flow for Word reports)
                          │  file
                          ▼
            packages/visual-lint  ── auto-fix loop (≤2: shrink → split → variant) ──► issues left (≤5 lines)
                          │
                          ▼
            present: card + canvas (live reload) ── image slots filled async (klein draft → optional final)
                          │
                          ▼
            tool result to the model: WHAT WAS DRAWN (post-fix) + remaining issues (+ capture if it can see)
```

**Where each piece runs.** Composition and lint are TypeScript, in the harness. Layout is the Electron main process: a new `measure` method on the `PresentBridge`, beside `show`, `preview` and `pixels`, reusing `openStillWindow`. File formats are Python in `tools/office-gen`, through a new deterministic `office.py build <pptx|pdf|docx> --records r.json --out f`. **No new runtime dependency** except bundled Mermaid (MIT, ~3.5 MB) and optional OFL fonts.

### 4.2 Per output type

- **Decks.**
  - `office make pptx` accepts a structured brief, or `write deck.pptx <markdown>` with headings as slides. The **composer** maps content shape to a template:
    - 1–4 labelled numbers → stats N-up;
    - a label/value series ≥ 3 → chart slide (the chart tool's SVG goes in as native shapes, which `office_chart.py` already does);
    - steps with "→" or numbered lines → process (≤ 5 inline; more steps or branches → a diagram slide);
    - a table → table (≤ 6 rows; else split or appendix);
    - two headed lists → comparison;
    - a quote *present in the brief* → quote;
    - people and roles → team;
    - the ask or CTA → closing.
  - About 20 templates in v1, each with variants (with/without image, light/dark).
  - Prose briefs still go through `make_deck.outline`/`fill`, but their JSON feeds the **same composer** and validators. The python-pptx layouts stay as a fallback behind a flag until parity.
- **Documents.**
  - Word reports keep python-docx flow, with D13–D15 fixed and tokens applied, plus a `masthead` block (compact title with no band) and a **page budget**: "one-page" or "N pages" read from the brief like `slides_in`, then enforced by measuring with `textfit` and trimming blocks.
  - One-pagers, posters and briefs can take the HTML → `html2pdf` path (c) with **embedded fonts**.
- **Charts.**
  - VQ-02 fixes: parsing, coercions, unique names, type aliases, integer ticks, units on ticks, size presets, end labels.
  - The look comes from the project kit unless the user names one. VQ-03's validated palettes. `chart_render.py` is retired behind `office make chart` → the TS chart tool.
- **Diagrams.**
  - `diagram <kind> "Title" --source '<mermaid>'` (and `diagram edit`) writes `.svg`, `.diagram.mmd` and an elements sidecar. It shows an inline card (like charts) and can be inserted into decks and docs (`office edit --diagram x.svg --slide N`).
  - Themes come from the kit (clean/sketch). Mermaid syntax errors return the offending line plus a one-line fix.
- **Pages.**
  - A section kit (nav, split hero, image hero, features, pricing, schedule table, gallery, testimonial, CTA/signup, footer) as HTML partials, with a generated `bobble-kit.css` (tokens) and bundled fonts.
  - The model writes the copy and picks sections, or free-writes HTML using `bobble-kit.css` (prompt pressure).
  - `present` on an `.html` runs the lint at 1440 and 390 px.
- **Motion.**
  - A non-scene prompt becomes a **template instance**. Parse the quoted strings (title, tagline), colours ("teal" → kit teal) and duration; pick a template (title card, lower third, kinetic quote, chart build from a chart spec, wordmark reveal, end card).
  - Authored scenes still pass through. The poster is the settled frame (or `data-poster-time`). A lint checks seekability, frame 0, distinct frames, the safe area, and that no instruction words appear in the DOM.
  - The enhancer stops treating `hyperframes` as VIDEO.

### 4.3 Imagery: where generation slots in

- **Slots.** `data-slot="image" data-role="hero|ground|product|portrait|texture" data-aspect="4:5"` in the templates.
- **Fill order:**
  1. user-supplied (attachments, project assets);
  2. generated;
  3. procedural (the `imagery.py` gradient or geometric ground, duotoned to the kit);
  4. the **variant without the slot**.
- **Prompt.** Composed from the slide or section text plus the kit's image style (light, palette hex, "no text, no logos"), passed through the existing enhancer (`IMAGE_NATURAL`).
- **Models.** Draft: FLUX.2 klein (Apache-2.0, seconds). Final: Qwen-Image 2.1 (MEASURED 97 s per 1024², ~7.4 GB of the Mac, and **non-commercial**, per `pi-desktop-qwen-image-21`), and only if the user opts in. The guardian admits every job. Generation **queues behind the user's turn** and never runs while a send is waiting.
- **Async swap.** The file is written immediately with procedural placeholders. Generated pictures replace them when ready, and the open canvas tab reloads by itself (`office-manager.ts`'s `fs.watch` already does this).
- **Selection.** 2–4 candidates, picked by a checklist: the VLM when available, a CLIP-style scorer later. This is shared with track 11. **Galleries need a shot list** (vary subject, angle and scale), not N seeds of one prompt (D37).

### 4.4 The critique loop

| Rule | Threshold (source) | Auto-fix |
|---|---|---|
| L1 text overlap | Any two text boxes intersect > 2 px (observed D1/D2; Anthropic pptx loop) | Template variant → shrink step → report |
| L2 overflow | A box outside its container or canvas | Shrink ladder (one token step at a time, never below L3) → split slide → appendix |
| L3 min size | Slide body ≥ 18 px (≈14 pt; captions ≥ 14 px and ≤ 20% of characters); doc body ≥ 10 pt (Butterick 10–12); chart labels ≥ 11 px **at output size** | Scale up; else choose a larger template |
| L4 contrast | Text ≥ 4.5:1, or ≥ 3:1 at ≥ 24 px (WCAG) | Switch the ink from the kit |
| L5 empty region | A rectangle ≥ 30% of the canvas with no text, image or mark | Variant without the slot |
| L6 dropped content | Items in the spec ≠ items drawn | Split/continue slide; always report |
| L7 provenance | A number, quote, URL or attribution not in the brief (or simple arithmetic on it) | Strip provenance lines; flag the rest (VQ-08) |
| L8 page budget | Pages > asked | Compact variant → trim lowest-priority blocks → report |
| L9 palette | CVD and normal-vision ΔE, marks ≥ 3:1 (VQ-03) | Use kit colours |
| L10 fonts | ≤ 2 families; weights from the scale | Normalise |
| L11 AI tells (report only) | Emoji-as-icon in headings, glow `text-shadow` on headings, a rule under a title, ALL-CAPS labels > 2 words, the `#1a1a2e`/`#e94560` pair, `∞` stat values, "Experience the …" (frontend-design; observed §2.2.5) | Kit templates never produce them; free-written pages get a note |
| L12 responsive | Horizontal overflow at 390 px = 0 | — (report the widest element) |
| L13 motion | Frame 0 non-empty or poster ≠ 0; ≥ 50% frames distinct; text inside the 90% safe area; the DOM title ≠ the prompt | Poster = settled frame; template instead of printed prompt |

**The VLM "look" pass (optional).** It runs only when all four hold:

- effort ≥ high;
- `serverCanSeeImages()` is already true, so there is no vision relaunch (`pi-desktop-deep-tasks-2026-09-16`);
- the call is a continuation of the resident conversation, so the prefix is reused (`pi-desktop-ttft-regression`);
- the lint is clean.

Its prompt is the SlideAudit taxonomy (typography, layout, colour, imagery). It returns ≤ 5 issues, each mapped to an operation the composer can apply (swap template, shrink, reorder, regenerate image), with at most one revision round. Reason: VLM flaw detection sits at F1 0.33–0.66.

### 4.5 What the tools refuse or auto-correct

| Tool | Auto-correct (and say so in one line) | Refuse (naming the token and the fix) |
|---|---|---|
| `office` | Units in value fields → value + unit; string booleans; `22M`/`$38k`/`1.2B`/`$24,000`; blank table headers; overflowing numerals (fit); truncated lists → continue slide; invented provenance lines → stripped | A deck whose asked slide count cannot be filled without inventing (say what is missing) |
| `chart` | `3,100` thousands vs list separators (count against the labels); `$1.2M` → 1.2e6 with unit `$`; a scatter of categories → bar (+ note); one-series stacked → bar (shares summing to ~100 → donut); `--chart-type`/`--kind` → `--type`; untitled → title from the data; a name taken by a different chart → `-2` suffix | A value token that is not a number: "could not read '$1.2M'…" is replaced by the exact accepted forms |
| `diagram` | Label contrast; node overflow → wrap/resize | Mermaid parse errors: the line number + the likely fix |
| `generate_video` (hyperframes) | A text prompt → template (quoted text = content, colours → kit) | — |
| `svg` guard | Diagram-shaped markup (boxes, arrows, labels) or requests → `diagram` in the refusal text, not OmniSVG | Hand-drawn *pictures* still go to `svg` (unchanged) |
| `present` (pages) | — | — (lint report only: overflow px, contrast, tells) |

### 4.6 UI

- **Settings → Design** (new panel, `apps/desktop/src/settings/panels/DesignPanel.tsx`, placed between *Capabilities* and *Experimental* in `SettingsView.tsx`):
  - **Look & feel.** A grid of 6 kit cards. Each is a live thumbnail rendered from its tokens: a cover slide, a chart and a page hero. The selected one gets a check.
  - **Match a brand…** Drop a logo or screenshot, and the palette is extracted offline. Pick fonts from bundled and system families, preview, then save as the project's brand. States: extracting…, "couldn't read colours from that image", saved.
  - **Pictures in documents & pages:** Off · Draft (fast, Apache-2.0) · Final (best, ~1.5 min per picture, non-commercial model). The licence line is shown under the option.
  - **After making something:** Check & fix automatically (default) · Check and tell me · Off.
  - **Look at results with vision:** Auto (when the model can see) · Off.
  - Settings keys (`settings-contract.ts`/`settings-logic.ts`): `design: { kit: string; images: 'off'|'draft'|'final'; lint: 'fix'|'report'|'off'; look: 'auto'|'off' }`. The project brand lives in `<project>/.bobble/brand.md`: frontmatter tokens plus prose, and it wins over `design.kit`.
- **In the chat.** Every artifact card (office, chart, diagram, page, motion) gets a quiet footer: `Kit: Tidewell ▾ · 2 fixes`.
  - `2 fixes` discloses the list ("shrank the slide 4 title one step; continued the table on slide 6").
  - `Kit ▾` re-renders with another kit. This is instant, because the content is structured and the render is deterministic.
  - The footer inherits the existing hover rules: no new colours, no purple.
- **Canvas.** The office tab's op bar gains *Restyle ▾* and *Pictures ↻*. Diagrams get the chart-style *Show in chat / SVG / Open* bar.

### 4.7 Alternatives considered and rejected

- **Keep growing the python-pptx layout menu.** Every layout is hand EMU maths plus character-count heuristics, and each one produced the bugs in §2.3 (collisions, fixed numerals, caps of 5 items). A new look is new code. Kept as the fallback only.
- **Screenshot HTML into slides or docs.** Not editable, which breaks the pipeline's own rule that output is "never a static image" (`html2docx.py`).
- **Let the model write python-pptx or HTML directly with a stronger prompt.** Measured: a 4B loops and invents (`handmade-office.ts` exists for this reason). The system should hold the design.
- **A VLM critique as the main quality mechanism.** F1 0.33–0.66 in SlideAudit; it also evicts the slot, and the vision relaunch flips engines. Kept as an optional pass.
- **pptxgenjs** (Anthropic's route). Viable, but it has the same absolute-positioning problem as python-pptx; browser measurement gives line-breaking and layout for free.
- **D2 instead of Mermaid.** D2 has nicer defaults and native PPTX export, but it needs a Go binary per platform (track 4), and small models know Mermaid better. D2 stays an option behind the same `diagram` tool.
- **The upstream HyperFrames runtime** (`npx hyperframes render`). It needs Node 22 + FFmpeg, and Bobble's seek renderer already works offline. Adopt the conventions, the brand file and a vetted subset of the Apache-2.0 catalog instead.
- **A second "designer" model call to choose layouts.** Slot eviction and nondeterminism. Content-shape inference is deterministic and free.

### 4.8 Hand-offs to other tracks

- **Track 6 (harness LoRA).** Train the model to call `chart`/`diagram`/`office --outline`/hyperframes templates with **structured content** and nothing else. The eval harness exports the pairs (VQ-15). The less design the model must do, the smaller the LoRA's job.
- **Track 8 (studios).** The image studio's "UI" and "mockups" presets should render through the page and slide kits. The kit picker is shared.
- **Track 9 (Ming design models; see `deliverables/research/ming-models.md`).** *Ming-Image-0.1-Design* turns text into design images (UI screens, posters, infographics, RGBA). *-Design-Layer* splits a flat design into RGBA layers. They plug into this system in two places:
  - as an **image-slot filler** for "designed" pictures: poster art, a UI mockup inside a deck or page. Text rendered inside a raster is not editable, so the slot's text stays native HTML on top.
  - as **Layer → html2pptx**: a generated poster, split into layers, placed as separate pictures, so it is partly editable.
- **Track 11 (image improve loop).** Owns candidate generation and selection. This track needs its API: prompt in, ranked images out.
- **Track 4 (Linux/Windows).** QuickLook is Mac-only and must not be a runtime dependency (it is only in the eval harness). Fonts need a per-platform map; bundle OFL fonts.

---

## 5. Work packages

| ID | Title | Size | Depends on |
|---|---|---|---|
| VQ-00 | Visual-quality eval harness (replayed captures, headless renders, lint report, contact sheets) | S | — |
| VQ-01 | Office renderer correctness pass (numbers, booleans, units, truncation warnings, fallback cleanup, fits, docx widths/rules) | M | VQ-00 |
| VQ-02 | Chart tool input hardening and auto-corrections | M | VQ-00 |
| VQ-03 | Palette validation in `packages/charts` + re-stepped looks | M | — |
| VQ-04 | Design kit: tokens as data, 6 kits, brand from image or `brand.md` | M | VQ-03 |
| VQ-05 | HTML→native emitters hardened + `PresentBridge.measure` | L | — |
| VQ-06 | Composer + HTML templates for decks and one-pagers; structured briefs skip the LLM | XL | VQ-04, VQ-05, VQ-07 |
| VQ-07 | Deterministic visual lint + auto-fix, wired into office/chart/diagram/present | M | VQ-00, VQ-05 |
| VQ-08 | Anti-fabrication (provenance check) + content-driven planner prompts | M | VQ-00 |
| VQ-09 | Image slots + generation in the loop (draft/final, async swap, selection) | L | VQ-04, VQ-06 |
| VQ-10 | `diagram` tool (Mermaid, kit themes, inline card, guard routing) | M | VQ-04 (VQ-05 for native export) |
| VQ-11 | HyperFrames templates: text prompt → template, poster, lint, enhancer fix | M | VQ-04 (a lite version first) |
| VQ-12 | Web page kit: sections, `bobble-kit.css`, fonts, responsive and AI-tell lint | L | VQ-04, VQ-07, VQ-09 |
| VQ-13 | Guidance, prompts and skills (routing lines, outlines, kit use; `visual-design` skill) | S | VQ-02, VQ-06, VQ-10, VQ-11 |
| VQ-14 | Settings → Design panel + card and canvas restyle | M | VQ-04 |
| VQ-15 | Eval → training-pair export for the harness LoRA | M | VQ-00, VQ-02, VQ-06, VQ-10, VQ-11 |

Quick wins first (days, not weeks): **VQ-00 → VQ-01, VQ-02, VQ-03, VQ-08**, then a **VQ-11 lite** (stop printing prompts; a title-card template) and the **VQ-10 guard routing** (stop sending diagrams to OmniSVG).

**VQ-00 — Eval harness (S).**
- *Files:* new `tools/visual-eval/` (promote `deliverables/visual-quality/_tools/*`: `replay_server.py`, `office_replay.py`, `split_ql.py`, `chart_cli.mjs`, `hyperframes_stills.mjs`, `page_shot.mjs`, `html_to_pptx.mjs`, `diagram_render.mjs`), `prompts/` (the six briefs + more), `fixtures/captured-4b/` (the specs in `_real-4b-evidence/specs`); a root script `vq:eval`.
- *Acceptance:* one command renders every prompt and variant plus the captured specs into contact sheets and `report.json` (per artifact: slides/pages, % text < 14 pt, overlaps, empty regions, dropped items, font families, palette result) in < 3 min, with no model.
- *Verification:* run twice → identical JSON; non-blank sheets (byte size + pixel variance); the focus guard asserts the frontmost app is unchanged.

**VQ-01 — Office renderer correctness (M).**
- *Files:* `tools/office-gen/numparse.py` (new), `render_deck.py`, `hero.py`, `viz.py`, `doc_render.py`, `pdf_render.py`, `chart_render.py`, `office.py` (warnings + a *drawn* summary); `tools/office-gen/tests/test_regressions.py` (pytest on the office venv).
- *Acceptance:*
  - `pitch-deck/a-replies-4b-style.json` renders with **no text-box intersections** (textfit geometry);
  - the 22M/3,100 bars are proportional and show values;
  - emphasis only where it is `true`;
  - truncation → a `warnings` entry and "5 of 10 shown" in the summary;
  - a failing layout leaves no half slide and appears in `warnings`;
  - a blank header does not crash;
  - docx stats/callout/table honour `tblW`; heading rules ≤ 6 pt tall; the cover band is padded;
  - the Q3 (b) spec fits one page.
- *Verification:* pytest on the captured fixtures; before/after QuickLook sheets from VQ-00 (the visual-confirmation rule); `apps/desktop/tests/e2e/office-shots.mjs` captures two decks in the app's own editor.

**VQ-02 — Chart tool hardening (M).**
- *Files:* `packages/charts/src/spec.ts`, `layout.ts`, `svg.ts`, `style.ts`; `packages/harness/src/tools/chart-tool.ts`; `packages/harness/src/tools/tool-cli.ts` (`FLAG_ALIASES`: `chart-type`, `kind` → `type`).
- *Acceptance:*
  - the REAL dataviz-session calls (17 of them, 12 untitled) each write **their own file** (no overwrite), with the requested types;
  - `"22M, 3,100"` → 22,000,000 and 3,100 (or a refusal naming the ambiguity);
  - `"$1.2M, $2.4M"` → 1.2e6/2.4e6 with unit `$`;
  - a scatter of categories → bar + note; one-series stacked → bar or donut;
  - integer ticks for integer data; units on ticks; `$M` → "$5.6M";
  - `--size card|doc|slide|square`; content-aware hbar height; line end labels for ≤ 4 series;
  - the look is sticky per conversation (or kit) unless named.
- *Verification:* vitest (charts + chart-tool) including the real call list; SVG → PNG sheet; `inline-chart-probe.mjs` + `chart-build-look.mjs` headless for the card.

**VQ-03 — Palette validation + looks (M).**
- *Files:* `packages/charts/src/palette-check.ts` (OKLab, Machado CVD matrices, WCAG); `style.test.ts` (every look passes); `style.ts` palettes re-stepped.
- *Acceptance:* every look has adjacent CVD ΔE ≥ 8 (6–8 only with direct labels, which the look then turns on), normal-vision ΔE ≥ 15, and marks ≥ 3:1 on its ground; the no-purple test still passes; each look keeps its character.
- *Verification:* unit tests; before/after sheets for all 11 looks, light and dark, reviewed by the user.

**VQ-04 — Design kit (M).**
- *Files:* new `packages/design-kit/` (`schema.ts`, `kits/*.json`, `validate.ts`, `brand.ts` using `paletteFromPixels` and `brand.md` parsing, `export.ts` → `tools/office-gen/design_tokens.json`); `packages/charts` `lookFromKit`; the `design` field in `settings-contract.ts`/`settings-logic.ts`.
- *Acceptance:* 6 kits validate (contrast, CVD, no-purple); Python and TS read the same tokens; a "kit sheet" (slide, chart, page hero, motion frame) renders per kit.
- *Verification:* unit tests; kit sheets through the VQ-00 tools.

**VQ-05 — HTML→native emitters + measure bridge (L).**
- *Files:* `tools/office-gen/html2pptx.py`, `html2pdf.py`, `html2docx.py`. Changes: text per **text node and line**, `spc` letter-spacing, ellipse for full radius, SVG `rect`/`line`/`ellipse`/`text`, `<img>` → picture with cover-fit, TTF **embedding** in PDF, a per-platform font map, padded one-line boxes.
- Plus `office.py build`; `PresentBridge.measure` (`packages/harness/src/tools/present.ts` types; the app side next to `renderPage` in `apps/desktop/electron/pi/pi-main.ts`, reusing `gen/hyperframes-window.ts`).
- *Acceptance:*
  - `pitch-deck/c-design-system-slides.html` through the **app bridge** → pptx identical to this research's QuickLook render, and correct in the app's slides editor;
  - `one-page-report/c-design-system-page.html` → a PDF with embedded fonts (`pdffonts` emb = yes) that shows bold under poppler.
- *Verification:* new `apps/desktop/tests/e2e/html-native-probe.mjs` (`launchApp` → measure → build → `office-shots.mjs` capture); geometry asserts (inside the canvas, no overlaps).

**VQ-06 — Composer + templates (XL).**
- *Files:* new `packages/visual-compose/` (`outline.ts` for the Markdown/JSON parser, `deck.ts` for content-shape → template, `doc.ts` for the one-pager, `templates/slides/*.html` (~20, with variants), `templates/one-pager/*.html`); `packages/harness/src/tools/office-tool.ts` (structured-brief detection, compose path, planner fallback); `tools/office-gen/make_deck.py` (its output feeds the composer).
- *Acceptance:*
  - the Tidewell brief as a 6-heading outline → 6 slides, **0 lint issues**, metrics ≥ (c)'s (≤ 25% text < 14 pt, 0 empty regions, 0 overlaps), byte-identical across runs;
  - a structured make takes < 3 s with no LLM call;
  - prose briefs still work;
  - `write deck.pptx <markdown>` takes the outline path.
- *Verification:* golden-outline tests (records snapshots), VQ-00 sheets, `office-live-probe.mjs` with the real 4B on a quiet Mac (before/after sheets), and `ttft-probe.mjs` showing no slot eviction on the structured path.

**VQ-07 — Visual lint + auto-fix (M).**
- *Files:* new `packages/visual-lint/` (`rules/*.ts`); hooks in `office-tool.ts`, `chart-tool.ts`, `present.ts` (pages measured at 1440 and 390 px), the diagram and hyperframes results; the card footer "n fixes".
- *Acceptance:* each defect in §2.3 that is a lint rule has a fixture that triggers it; overlap, overflow and empty-panel cases auto-fix; the results appear in the tool text (≤ 5 lines) and on the card.
- *Verification:* unit tests per rule. An e2e `present` of `landing-page/a-4b-house-style.html` returns "horizontal overflow 112 px at 390 px; emoji headings ×4; glow on h1".

**VQ-08 — Anti-fabrication + planner prompts (M).**
- *Files:* `tools/office-gen/provenance.py` (new), `make_deck.py`, `make_doc.py`, `office.py`; fixtures from `_real-4b-evidence/specs`.
- *Acceptance:*
  - in the captured "Art of Tea", "Annual Unit Sales", cookie and solar specs, every number, quote, URL or attribution not traceable to the brief (or to simple arithmetic on it) is flagged;
  - "Data sourced from …" lines without a source in the brief are stripped;
  - kickers and eyebrows are labels, not descriptions of the slide (lint);
  - plans follow the brief's parts, not the rule list.
- *Verification:* pytest; replay runs; one live 4B run per kind on a quiet Mac, diffed.

**VQ-09 — Image slots + generation (L).**
- *Files:* template slot markup; `packages/visual-compose/src/images.ts`; image-job queue priority in `apps/desktop/electron/gen/`; `design.images`.
- *Acceptance:*
  - a deck or page renders at once with procedural placeholders and swaps generated images in when ready;
  - off or offline → variants without the slot (never an empty panel);
  - the guardian admits every job; nothing runs while a send waits;
  - pictures from a non-commercial model are labelled in the card.
- *Verification:* unit tests (slot resolution); an e2e gated on `PI_DESKTOP_GEN=1` on a quiet Mac with before/after sheets.

**VQ-10 — `diagram` tool (M).**
- *Files:* `packages/harness/src/tools/diagram-tool.ts` (+ a capability line in `presets/capabilities.ts`, a CLI group); `apps/desktop/electron/gen/diagram-render.ts` (bundled Mermaid, offscreen window, contrast guard); a canvas inline card; `handwritten-svg.ts` refusal text routes to `diagram`; the `generate_svg` description says it is not for diagrams, charts or anything with words.
- *Acceptance:* the §2.2.3 brief → one call → all nodes, edges and branches, inline; parse errors name the line; after VQ-05, `office edit deck.pptx --diagram x.svg --slide 3` inserts native shapes.
- *Verification:* unit tests; an inline probe modelled on `inline-chart-probe.mjs`; a live 4B run on this brief.

**VQ-11 — HyperFrames templates (M).**
- *Files:* `apps/desktop/electron/gen/hyperframes-templates.ts` (new), `hyperframes-still.ts` (`buildSceneDocument` uses a template for non-scene prompts; rebase on the in-flight APNG change), `video-dispatch.ts` (poster = settled frame), `prompt-guidelines.ts` (`hyperframes` leaves the VIDEO dialect), `templates/motion/*.html`.
- *Acceptance:*
  - the REAL "Launch day" prompt and the §2.2.6 prompt → frames whose DOM text is exactly the quoted title and tagline, with no instruction words;
  - "teal" honoured; poster = last frame;
  - ≥ 6 templates; lint green.
- *Verification:* `hyperframes-still.test.ts` additions; `apps/desktop/tests/e2e/hyperframes-probe.mjs` headless, with a contact sheet.

**VQ-12 — Web page kit (L).**
- *Files:* `packages/visual-compose/templates/pages/sections/*.html`, a generated `bobble-kit.css`, bundled OFL fonts, section-assembly guidance (or a `page` command), lint hooks from VQ-07.
- *Acceptance:* the Kiln brief with the live 4B → 0 px overflow at 390, no AI-tell hits, images in slots (or variants), facts missing from the brief marked; before/after sheets.
- *Verification:* `page_shot` desktop and phone; lint; a live run.

**VQ-13 — Guidance (S).**
- *Files:* `packages/harness/src/presets/capabilities.ts` (office/chart/svg/generation lines), `apps/desktop/resources/skills/data-visuals/SKILL.md`, a new `visual-design` skill adapted from Anthropic's Apache-2.0 frontend-design (attributed in `ATTRIBUTION.md`).
- *Acceptance:* `tool-surface-probe.mjs` passes; the chart, deck and svg tasks in `deep-tasks-probe.mjs` hold or improve; the prompt prefix grows < 400 tokens, measured (`user-always-check-prefill`).
- *Verification:* the probes + a TTFT check.

**VQ-14 — Design settings + restyle UI (M).**
- *Files:* `apps/desktop/electron/settings/settings-contract.ts`, `settings-logic.ts`, `settings-main.ts`; `apps/desktop/src/settings/panels/DesignPanel.tsx`, `SettingsView.tsx`; card footers (`PresentedInline.tsx`, office cards); the canvas op bar.
- *Acceptance:* a kit switch re-renders the open artifact in < 2 s (structured path); brand-from-image works offline; settings persist.
- *Verification:* settings unit tests; headless before/after screenshots of the panel and a card.

**VQ-15 — Training export (M).**
- *Files:* `tools/visual-eval/export-training.mjs` (the format agreed with track 6).
- *Acceptance:* request → structured-call pairs for chart, diagram, office outline and hyperframes template, plus negative examples labelled with lint rule ids.
- *Verification:* a schema test; a sample reviewed by track 6.

---

## 6. Risks, blockers, open questions

**Risks**

- **Fidelity across renderers.** The native pptx from html2pptx looks right in QuickLook. PowerPoint and Keynote are unverified on this Mac: there is no LibreOffice (the brew shim points to a missing app) and no PowerPoint. Mitigation: the app's own GenOffice editor (`office-shots.mjs`) is what users see; ask the user for one manual PowerPoint check.
- **Fonts.** Helvetica Neue and Avenir Next are Mac-only. Windows and Linux (track 4) need bundled OFL fonts and a per-platform map; PDF must embed them (D17). PowerPoint font embedding is not supported by python-pptx.
- **Imagery.** Cost and licensing: Qwen-Image 2.1 is non-commercial and takes ~97 s and ~7.4 GB per image. Automatic pictures in user documents need an explicit default (question 3).
- **Fabrication.** Small models will still invent where the system can't check (for example, a schedule nobody gave). Provenance and placeholder marking reduce this but cannot eliminate it.
- **Scope collision.** HyperFrames files are being edited concurrently (APNG output, uncommitted), and studios, the image loop and the LoRA touch the same seams. Sequence VQ-11 after that change lands.
- **Taste is not linted.** The lint prevents defects; the kits carry the taste. They need the user's eyes, like the palette work in `pi-desktop-design-palettes`.
- **OmniSVG is unmeasured on its real job.** Its quality on the icons and logos it *is* meant for was not sampled: no model could run here, and every OmniSVG output on disk answers a diagram or text request, where it failed. VQ-00 should add an icon prompt set, run on a quiet Mac.

**Blockers**

- No LibreOffice or PowerPoint here, so Office fidelity can only be proxied (QuickLook + the GenOffice editor).
- This session's web search budget ran out (200/200) mid-research. Not verified here: UICrit's licence. For the Ming models, see track 9's `ming-models.md`.
- The default image model's non-commercial licence blocks turning auto-images on by default until the user decides.

**Open questions for the user**

1. Make HTML templates plus browser layout the **default** engine for decks and one-pagers (`pitch-deck/c`), with the python-pptx layouts kept as a fallback?
2. **Consistency vs variety.** One kit per project, so a deck, its charts and its title card match, and variety only *across* projects. Is that OK, given "we CANNOT have all charts from bobble look the same generic"?
3. Default for **pictures in documents and pages**: off, draft (FLUX.2 klein, Apache-2.0, seconds), or final (Qwen-Image 2.1, ~97 s per image, non-commercial)?
4. Bundle **Mermaid** (MIT, ~3.5 MB) for a `diagram` tool, with a hand-drawn look as an option?
5. **HyperFrames.** Adopt upstream's composition conventions and a vetted subset of its Apache-2.0 catalog, or keep our seek renderer with our own templates only?
6. Bundle **OFL fonts** (e.g. Inter plus one serif) so outputs look the same on Mac, Windows and Linux?
7. **Invented numbers and quotes** in office documents: strip silently, keep and flag them in the reply, or send the model back once?
8. May **auto-fix restructure** the output (split a slide, move rows to an appendix) without asking, provided the card says what it did?

---

## Appendix A — Reproducing the samples (no model, headless)

```bash
cd deliverables/visual-quality
OFFICE_PY=~/.cache/bobble/engines/office-venv/bin/python

# office.py for real, against the replay stub (plan/fill/spec replies from a JSON file)
python3 _tools/office_replay.py pitch-deck/a-replies-4b-style.json /tmp/og make pptx \
  --brief "$(cat pitch-deck/brief.txt)" --out /tmp/a.pptx
$OFFICE_PY _tools/split_ql.py /tmp/a.pptx /tmp/renders a 3      # per-slide QuickLook PNGs + sheet

# the chart tool exactly as the CLI resolves it (bash splitting + protectShimDollars)
node _tools/chart_cli.mjs /tmp/charts 'chart bar "MAU" --labels "Q1, Q2" --values "48k, 61k"'

# HTML -> measured records -> tools/office-gen/html2pptx.build (native pptx)
node _tools/html_to_pptx.mjs $PWD/pitch-deck/c-design-system-slides.html /tmp/rec.json
$OFFICE_PY _tools/html_to_pptx_build.py /tmp/rec.json /tmp/c.pptx

# HyperFrames stills through hyperframes-still.ts's own document/seek/frame-times
node _tools/hyperframes_stills.mjs "a title card …" /tmp/hf 6 12 1280x720

# pages (desktop 1440 + phone 390, reports horizontal overflow)
node _tools/page_shot.mjs $PWD/landing-page/b-designed.html /tmp/kiln

# diagram prototype (Mermaid fetched once: cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js)
node _tools/diagram_render.mjs /path/mermaid.min.js $PWD/flow-diagram/c-diagram-source.mmd /tmp/flow clean
```

The tools use absolute paths from this repo (the jiti and Playwright stores; `chromium_headless_shell-1223`). VQ-00 makes them portable.

## Appendix B — Evidence index

- REAL captured specs: `_real-4b-evidence/specs/`. These are `last_*_spec.json` and `raw_plan.txt` + `raw_fill*.txt` from `~/.cache/bobble/office-gen`, and the six `*.chart.json` from `~/Bobble/demo-all-your-dataviz-skills`.
- REAL renders: `_real-4b-evidence/renders/`:
  - the solar deck through today's renderer;
  - the cookie-recipe docx page 1;
  - the HyperFrames "Launch day" and radar frames;
  - the dataviz demo charts as written on 2026-09-16;
  - the OmniSVG answers to a "graph with equations" request;
  - the Qwen-Image mug candidates.
- REAL transcripts consulted (read-only), in `~/.pi/agent/sessions/--Users-user-Bobble--/`:
  - `2026-09-17T03-43-34-931Z_…jsonl`: the dataviz demo;
  - `2026-09-21T07-34-16-203Z_…jsonl`: the smiley and Desmos graph request;
  - `2026-09-22T06-09-58-302Z_…jsonl`: the radar animation.
- Per prompt: `pitch-deck/`, `one-page-report/`, `flow-diagram/`, `chart-set/`, `landing-page/`, `motion-graphic/`. Each has `brief.txt`, the replay or call inputs, the output files, and `renders/` with a comparison sheet.
- `chart-set/looks-palette-validation.txt`: every chart look through the palette validator.
