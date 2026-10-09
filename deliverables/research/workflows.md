# Track 11: custom workflows (deep research to documents, and the image improve loop)

Research and design only. Base commit `c9fe7098` (main). Written 2026-09-23 by the Track-11 research agent. No code or settings were changed while writing this.

---

## 0. The recommendation on one screen

- **A workflow is a procedure the user chose, so code runs it.** A workflow is a short list of steps stored as JSON, and a deterministic engine in Electron main executes it. The model gets called only for bounded, schema-constrained jobs: plan, pick queries, pull a verbatim quote out of a page, judge an image, write one section. Open-ended steps still run as real harnessed agents: a child pi, which is how subagents already run. This is what Anthropic calls a *workflow* (predefined code paths), as opposed to an *agent*. It is also the only shape that fits a cited 20-source report onto a 4B model with a 32k window and one KV slot.
- **Two flagship templates, both built on the same engine.**
  - **Deep research, delivered as Word, Slides, Sheet and Markdown.** The pipeline is: scope, plan (you can edit it), search wide, read, build an evidence ledger of verified verbatim quotes, loop on gaps, cross-check, outline, write cited sections, run a deterministic citation check, then render through `office.py`.
  - **Improve an image.** It writes a checklist of atomic yes/no checks, then generates, scores with vision, and chooses between edit, re-prompt and re-seed. A candidate is kept only if it beats the incumbent, and this repeats for N passes. That is the user's hill-climb from `specialist-commission.ts`, now run by code instead of left to a 4B's honesty.
- **Nearly everything it needs already exists.** Scheduler, child-agent pool, corp role runtime, `callModel` with `response_format`, web-tools, `office.py`, the gen JobQueue plus guardian, the vision plan, `present`, `LongJobCard`, `TaskChecklist`, the composer pill, and the sticky `<canvas_state>` context-block pattern.
- **UI.**
  - One page for everything that runs by itself or on demand: Scheduled grows into Workflows, and the name is the user's call.
  - A **run card** in the chat thread showing the steps, a live detail line, an estimate "on this Mac", and Stop.
  - An inline **plan approval** for research.
  - A **pass strip** for the improve loop.
  - A simple **vertical step editor**, like Shortcuts rather than a node graph.
- **Three ways to create one:** templates; "Save this as a workflow" from any chat (a deterministic skeleton built from the chat's tool trace, with the model only naming the inputs); or describe it in a sentence (the model drafts it and you review before anything is saved).
- **The chat stays first.** There is one model slot. The engine never starts a model call while your chat turn is running, or within 2.5 s after it ends. A workflow can delay your message by one bounded call at most.

---

## 1. Goal

**The user, 2026-09-23 (verbatim):** "workflows, custom created, eg. deep research w/ docs/slides/sheet/whatever outputs able to be done intelligently. image generation improve loop."

**Earlier, same intent (`roadmap.md` item 3, his file):** "specailists/workflows eg. vlm see and prompt for edits/regen image + mark and save best, presnet best up to n iterations loops working to be called as tools from regular chat/corp as specialists."

**His image-loop spec, recorded in `packages/harness/src/subagent/specialist-commission.ts`:** "for n iterations, model generates an initial image, decides, edit or try again from scratch at each iteration and also at each iteration indicates if the newest one is better than the current best, if so, replace it, otherwise discard (initial one from raw user prompt starts as the current best)".

### Restated precisely

| # | Goal |
|---|---|
| G1 | **Custom.** A person can make, edit, re-run, schedule and share (as a file) their own multi-step workflows without writing code. They can start from a chat that worked, from a template, or from a one-line description. |
| G2 | **Deep research, done intelligently.** A question goes in. Researched, cross-checked, **cited** deliverables come out in whatever formats were asked for (docx, pptx, xlsx, md). Effort scales to the question, the plan is visible and editable, and the gaps are stated honestly. |
| G3 | **Image improve loop.** N passes of generate, look (vision), decide whether to edit or regenerate, and keep the result only if it beats the incumbent. Deliver the best image and the pass log. |
| G4 | **Reliable on the default local model** (Qwen3.5-4B class, 32k window, one decoding slot, 24 GB M5 Pro). Offline-first except for the web access research needs. |
| G5 | **Visible and controllable.** An estimate, live evidence of life, stop and resume, and approvals where a human decision helps. |
| G6 | **Reachable from everywhere.** The chat (the + menu, and the model's own tool), the Workflows page, a schedule, and the corp mesh and specialists as a tool (roadmap item 3). |

**Non-goals for v1:**
- a node-graph canvas;
- event triggers other than time and manual (a folder watch comes later);
- two workflows decoding in parallel on one slot;
- changing how agentic the chat or the corp are.

**Feature-level "done" (measurable):**
1. A standard-depth deep research run on the default 4B produces a `.docx` where:
   - every factual sentence cites a page that was actually fetched during the run;
   - every quoted piece of evidence verifies verbatim against that page's text;
   - there are 0 fabricated URLs, because URLs can only come from fetches.

   The same evidence can also produce `.pptx` and `.xlsx`. Wall-clock time is measured and quoted "on this Mac". Target ≤ 15 min, to be confirmed in WP-00.
2. The improve loop never returns an image its own scorer rates below the starting incumbent. It stops at N passes or on a plateau, and shows every pass.
3. A workflow saved from a chat re-runs with new inputs and produces the same kind of deliverable.
4. A chat message sent while a workflow runs reaches first token within one bounded call of normal TTFT. This is checked with `ttft-probe.mjs` at `GAP_MS=0`.

---

## 2. What exists today

### 2.1 Seams a workflow engine builds on

| Need | What exists (file / symbol) | What it gives | Gap for workflows |
|---|---|---|---|
| Clock, run records, headless runs | `apps/desktop/electron/scheduled/scheduled-main.ts` (30 s tick, `~/.pi/desktop/scheduled-tasks.json`, directory watch so `create_scheduled_task` writes appear live); `schedule-logic.ts` (`nextRun`, `dueTasks`, `normalizeTask`); `scheduled-runner.ts` (serialised queue, `RUN_TIMEOUT_MS` 20 min, `KEEP_RUNS_PER_TASK` 20, `scanArtifacts`, `stop`); `scheduled-contract.ts` (`tasks:*` IPC, `TaskRun`); `pi-main.ts` `createScheduledRunBridge` (throwaway top-level pi, `FORBID_TOOLS_ENV` = `messages_send`) | One prompt runs headless in a fresh pi and leaves a run record | A task is **one prompt**. No steps, typed inputs, structured outputs, approvals or resume |
| Scheduled UI | `apps/desktop/src/scheduled/`: `ScheduledView.tsx` (list page and task page, `Routines | Templates` segmented control since 506c62f4), `TaskEditor.tsx` (`TaskDialog`), `RunLedger.tsx`, `derive.ts` (states), `templates.ts` (9 templates, with the rule *never offer a template for something the app cannot do*), `tasks-store.ts` | The list, detail and ledger shape the user approved after "similarly overcomplicated" | No step list, no inputs form |
| Harnessed sub-agents | `apps/desktop/electron/pi/child-agents.ts` (`spawnAndWait`), `subagent-bridge.ts` (token-authed unix socket; methods `spawn` and `corp`), `packages/harness/src/subagent/` (`spawn_subagent`, `SubagentScheduler` with its RAM budget, `specialist-env.ts` pins an exact kit via `PI_DESKTOP_SPECIALIST`, `specialist-commission.ts` with 13 charters including `research`, `document`, `image` plus `imageLoopProtocol`) | A goal goes to a child pi with the chat's harness or a pinned specialist kit, and its final text comes back. Viewable as a nested chat (MP1–MP6) | Returns prose only (no schema). One goal per spawn |
| In-process role sessions | `apps/desktop/electron/corp/role-agent.ts`: `openRoleSession`, `runRoleAgent` (sampling modes, `maxSteps` + `freeTools`, `perCallTimeoutMs`, `additionalExtensionPaths` = the chat's tool surface, `onActivity`) | A scoped `AgentSession` in main | Configuration is corp-shaped |
| Bounded model calls | `packages/harness/src/model-call/call-model.ts`: `callModel` with `responseFormat`, `tools`, `timeoutMs`, `extraBody`. Already used by the titler (`title/conversation-title.ts`, constrained to `{"title"}`), the reviewer and the fixer | One OpenAI-compatible call, optionally constrained | No validate-and-retry wrapper. Engines differ (see §2.4) |
| Endpoint and vision state | `apps/desktop/electron/inference/llm-main.ts`: `getInferenceUtility()`, `getInferenceVisionReady()`, `getLoadedModel()`; `packages/inference/src/vision-launch.ts` (new: vision plan, `BlindReason`); `electron/inference/vision-want.ts`; setting `loadVision` (default on, in flight) | Which server is up, and whether it can see | The image judge needs vision |
| Multimodal raw completion | `packages/gen-service/src/omnisvg-request.ts`: `POST /completion` with `multimodal_data` | A working precedent for image plus prompt requests on this llama.cpp build, which is also where `n_probs` lives | None |
| Web | `packages/web-tools/src/search.ts` (DuckDuckGo html/lite POST floor, Brave and Tavily through `settings.search.{brave,tavily}`); `fetch.ts` `fetchReadable` (Readability to markdown, 40k-char cap); `BrowserSearchFn` fallback; harness `raw-page-fetch.ts` guard | Search, plus readable page text, as pure Node exports main can import | No query cache, no pacing, no PDF text, no source ranking. The DDG floor already detects anti-bot pages (`anomaly-modal`) |
| Documents | `tools/office-gen/office.py make|edit|inspect` plus `packages/harness/src/tools/office-tool.ts` (`runOffice`, `sameBrief`, `briefTooThin`). Renderers: `doc_render.py` (blocks cover/heading/body/callout/stats/table/quote/bullets/pagebreak), `make_deck.py` (plan then fill **from a report**; its rules forbid inventing numbers), `render_deck.py`, `sheet_render.py` (one sheet: kpis/headers/rows/chart), `pdf_render.py`, `office_chart.py` | Designed files, where the model writes the words and code owns the bytes | **No render-from-spec entry**: `make` always runs its own LLM plan. No sources block, citations or hyperlinks. xlsx is single-sheet, and its brief path tells the model to make data "realistic" — it **invents rows** |
| Charts | `packages/charts` plus the `chart` tool (`chart-tool.ts`) and its `.chart.json` / `.chart.elements.json` sidecars, which feed into pptx/docx/xlsx/pdf through `office edit --chart` | Deterministic charts from real numbers | None |
| Images | `packages/gen-tools/src/tools.ts` (`generate_image` over the gen bridge `generate`); `packages/harness/src/tools/image-tools.ts` (`edit_image`, Mage-Flow-Edit); `apps/desktop/electron/gen/gen-manager.ts` (`handleGenerate`, JobQueue, `GenQueueControl` which exposes only `run3d`); Qwen-Image 2.1 is the default and FLUX.2 klein is the fast pick | Generation and instruction edits, admitted through the guardian | No main-side `generateImage` for a non-socket caller |
| Prompt enhancer | `electron/gen/prompt-enhancer.ts` plus `prompt-guidelines.ts` (per-model dialects, `cleanEnhanced`); `src/studio/use-enhancer.ts`; `tests/enhance/enhance-probe.mjs` (the method: tune with generation switched off) | The re-prompt step's house style | None |
| Present | `electron/pi/present-bridge.ts`, `present-inline.ts`, `src/state/present-store.ts` (`claimUnsaved`, `rehydratePresented`: cards that persist per chat) | A card plus a canvas tab for a file, surviving reloads | None |
| Machine safety | `packages/inference/src/guardian.ts`, `electron/gen/guardian-main.ts`, `electron/gen/pausables.ts` (`guardRun`), memory guard (`memoryGuard` setting) | Admission by footprint; pause, resume, terminate | Workflow runs must register |
| Progress UI | `src/chat/LongJobCard.tsx` plus `long-job.ts` (the blind tester's three rules: a card immediately, evidence of life, say when the estimate is blown; ranges "on this Mac" after two runs); `packages/ui` `TaskChecklist` (used by `HarnessChecklistPanel`); favicon search cards (`electron/canvas/favicons.ts`); sidebar dots (blue = finished, orange = needs input) | Most of a run card, already built | No multi-step card |
| Composer entry | `packages/ui/src/components/add-menu.tsx`: `ComposerAddMenu` has an **unwired `onResearch` slot** (ChatComposer passes only files and the four gen actions). `src/chat/composer-gen-actions.ts` (pill scaffolds); `apiRef.insertPill` | The + menu inserts a pill into the box | None |
| Telling the model what happened | `packages/browser-use/src/canvas-context.ts` (one `<canvas_state>` block per user turn, sticky, stored in a ledger persisted as custom entries, **so history stays byte-identical**); harness `before_agent_start` hidden `HARNESS_WORKSPACE_NOTE` | A cache-safe channel for "a workflow finished, here are the files" | None |
| Tool surface | `packages/harness/src/tools/tool-cli-groups.ts` (`coordinate`, `machine`, `file`), `packages/harness/src/presets/capabilities.ts` (`web-research`, `office`, `chart`, `generation`, …), `capability` / `use` | Where a `workflow` group and capability go | None |
| Research method as prose | `apps/desktop/resources/skills/web-research/SKILL.md` (plan, gather, verify each claim across ≥2 independent sources, synthesise with citations), but the chat runs `--no-skills` | The method the user's app already believes in | Nothing executes it |

### 2.2 Small workflows already in the code

- **`make_deck.py`** plans N slides from a report, fills each slide with one JSON call, then renders. That is deterministic orchestration plus bounded calls, and it works on the 4B. It proves the pattern.
- **`imageLoopProtocol()`** is the user's hill-climb written as ~30 lines of prompt for the image specialist. It works only as well as a 4B follows a procedure and stays honest about what it can see ("BE HONEST ABOUT YOUR EYES").
- **The chat's research-deck path** (deep-tasks probe, 2026-09-16): web search, then web fetch ×2, then office make, then present, in 149 s. It works, with **two** sources.
- **The corp `research` and `document` specialists** (charters in `packages/harness/src/corp/corp-mesh.ts`): the right instincts, but written as prompts.

### 2.3 What is missing

1. A workflow definition format and a store for it.
2. An engine that handles inputs, steps, loops, approvals, a journal and resume.
3. A structured-output wrapper that is robust across engines.
4. A research pipeline:
   - query cache and pacing;
   - source ranking;
   - PDF text;
   - a quote-verified evidence ledger;
   - a gap loop and a cross-check.
5. Cited writing with a deterministic citation check.
6. `office.py` render-from-spec, plus sources, citations and multi-sheet support.
7. Image scoring:
   - the checklist;
   - VLM yes/no;
   - pairwise comparison in both orders;
   - the loop controller.
8. Programmatic image generation from main.
9. UI: the run card, plan approval, pass strip, editor, and page integration.
10. Chat integration: dispatch, the context block, and the harness tool / CLI group / capability.
11. A schedule that points at a workflow.
12. e2e mocks for a model server and the web.

### 2.4 Measured platform constraints (from the memory notes)

| Fact | Number | Source note |
|---|---|---|
| Qwen3.5-4B prefill | llama.cpp ~1.3–1.4k tok/s; rapid-mlx and mlx-dspark ~1.8–2.0k tok/s | `pi-desktop-calibration-engines` |
| Qwen3.5-4B decode | 36–58 tok/s depending on engine and speculation | same |
| Context | 32k window. Pi compaction fires at ~16.8k with the corp fix. The canvas assessment saw compaction every 2–3 turns | `pi-desktop-compaction-defaults`, `pi-desktop-canvas-assessment` |
| KV | One decoding slot. `--cache-ram 8192` plus idle-slot saving keep ~6 conversations' KV, and returning to one costs ~120–175 tokens. **Cliff:** at 1024 MiB reuse falls to 0% | `pi-desktop-prompt-cache-truth` |
| Background calls | Do not evict (the prompt cache absorbs them) but **hold** the slot, so a user message queues behind them. Fix precedent: `POST_TURN_DELAY_MS = 2500` | `pi-desktop-ttft-regression` |
| Images in prompts | The ViT encoding is redone **on every request** (measured on b9934). There is no image KV reuse | `pi-desktop-latency-harness` |
| Constrained decoding | llama.cpp compiles `response_format` json_schema to a grammar. rapid-mlx's constrained tool calling looped and is switched off (`RAPID_MLX_CONSTRAIN_TOOLS=0`). json_schema support per MLX engine is **unverified** | `pi-desktop-calibration-engines` |
| Image generation | Qwen-Image 2.1: 88–97 s at 1024², 49 s at 768², ~7.4 GB OS drop. FLUX.2 klein ~24 s | `pi-desktop-qwen-image-21`, `pi-desktop-tool-surface-2026-09-15` |
| 4B on long single-agent tasks | Wrote **no plan** for a 24-part task. The web task looped 179 calls before the guards. Research-deck used 2 fetches | `pi-desktop-long-task-completion`, `pi-desktop-deep-tasks-2026-09-16` |

**What this means:** the flagship cannot be one long agent turn. A 20-source report does not fit in 32k, and the 4B does not keep a plan unprompted. It needs many small calls with small contexts, where code holds the plan and the evidence.

---

## 3. External research

### 3.1 How other products let users define agent workflows

| System | Shape | Pattern worth taking | Pattern to avoid | License / footprint |
|---|---|---|---|---|
| **Anthropic, "Building effective agents"** ([link](https://www.anthropic.com/engineering/building-effective-agents)) | Separates **workflows** (LLMs and tools orchestrated by predefined code paths) from **agents** (the LLM directs its own process). Five patterns: prompt chaining, routing, parallelization, orchestrator-workers, **evaluator-optimizer** | Deep research is chaining plus orchestrator-workers with code as the orchestrator. The image loop *is* evaluator-optimizer. Their advice: start simple, add complexity only when it measurably helps | Frameworks that hide the calls | n/a |
| **Claude Code workflow scripts** (the Workflow tool reference, read in this session) | Plain JS: `agent(prompt, {schema})` returns a validated object; `pipeline`, `parallel`, `phase`, `log`; **resume** replays the longest unchanged prefix of calls from a journal; no `Date.now()` or `Math.random()` in scripts so replay is exact; named, parameterised workflows; "no silent caps" | Schema-validated step outputs, the resume journal, progress declared as phases, logging whatever was dropped | Asking users (or a 4B) to write code | n/a |
| **OpenAI Agent Builder** ([guide](https://developers.openai.com/api/docs/guides/agent-builder), [nodes](https://developers.openai.com/api/docs/guides/node-reference)) | A visual canvas with typed edges. Nodes: Start, Agent, Note, File search, Guardrails, MCP, If/else and While (CEL expressions), Human approval, Transform, Set state. Templates, preview traces, versions, export to Agents SDK | **Typed edges**, **human approval**, templates, versions | **OpenAI is deprecating it; shutdown is scheduled for 30 Nov 2026** (per the guide). Its successor, [workspace agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business), is instructions + tools + schedules + approvals, created by describing them | Proprietary |
| **n8n** ([AI Workflow Builder](https://docs.n8n.io/advanced-ai/ai-workflow-builder/), [pin data](https://docs.n8n.io/data/data-pinning/), [retries](https://docs.n8n.io/integrations/builtin/rate-limits/)) | Node graph plus an AI agent node. The builder turns a description into a draft workflow and you refine it by chatting | **Pinned data** (freeze a step's output and iterate on later steps), per-node **retry on fail** (max tries, wait between) | Graph complexity. Server plus database | Sustainable Use License, not OSI (GitHub `NOASSERTION`) |
| **Zapier** ([Copilot](https://help.zapier.com/hc/en-us/articles/23503999825421-Build-Zaps-faster-using-AI-powered-Copilot-Beta), [AI by Zapier](https://zapier.com/blog/ai-by-zapier-guide/)) | Describe the automation and Copilot drafts the steps. The AI step returns **named output fields** that later steps map | Draft-from-description; typed AI outputs instead of prose | Cloud-only | Proprietary |
| **LangGraph** ([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)) | State graphs with a checkpointer that saves every super-step; `interrupt()` pauses for a human and resumes by thread id | Checkpoint per step; pause for approval that survives a restart | A second agent runtime next to pi | MIT (LangGraph.js) |
| **Dify** ([parameter extractor](https://docs.dify.ai/en/use-dify/nodes/parameter-extractor), [workflow as tool](https://dify.ai/blog/dify-ai-blog-workflow-major-update-workflows-as-tools)) | Nodes for LLM, iteration, a **parameter extractor** (text to structured parameters), template transform (Jinja2), and **publish a workflow as a tool** | A structured-extraction step; workflows callable as tools (roadmap item 3, exactly) | Docker, Postgres, Redis | Modified Apache (GitHub `NOASSERTION`) |
| **ComfyUI** ([workflow metadata](https://docs.comfy.org/development/api-development/workflow-metadata)) | Node graph for generation. Only nodes downstream of a change re-execute. The workflow is **embedded in every output** (PNG `tEXt`, WebP EXIF, video metadata) and dragging an output back in restores it | A cache keyed by inputs; "this file knows how it was made" | The graph editor as the primary UI | GPL-3.0; already inside Bobble's gen stack |
| **Raycast AI Commands** ([manual](https://manual.raycast.com/ai/ai-commands), [placeholders](https://manual.raycast.com/dynamic-placeholders)) | Prompt plus `{selection}`, `{clipboard}`, `{argument name="…"}` placeholders, with a per-command model, creativity and output behaviour. Shareable, importable as JSON | Named arguments as inputs; per-step model and temperature; share as a file | Single-step only | Proprietary |
| **Apple Shortcuts "Use Model"** ([Apple](https://support.apple.com/en-ie/guide/mac-help/mchl91750563/26/mac/26), [MacStories](https://www.macstories.net/notes/i-have-many-questions-about-apples-updated-foundation-models-and-the-great-use-model-action-in-shortcuts/)) | An AI action inside a vertical action list. Output can be a **Dictionary** that later actions read. **Follow Up** pauses mid-run so you can refine | A vertical list of sentences as the editor; typed output; a mid-run human pause | None | Proprietary |
| **AnythingLLM Agent Flows** ([docs](https://docs.anythingllm.com/agent-flows/overview)) | Local desktop app. No-code flows made of blocks (flow variables, web scraper, API call, LLM instruction) that become agent skills | Precedent that a local-first desktop app ships a simple block editor | Scraper-only research | MIT |

**What this means for Bobble.**
1. The market is moving away from node canvases (Agent Builder shuts down November 2026) toward "describe it, it runs with guardrails". A 4B cannot be trusted to run open-ended, so Bobble should compile the description into a **closed vocabulary of steps** that code executes.
2. Take typed step outputs (Zapier, Shortcuts, Agent Builder), human approval as a step (Agent Builder, LangGraph, Shortcuts' Follow Up), and a journal with resume and pinned outputs (Claude Code, n8n, ComfyUI).
3. Workflows should be callable as tools (Dify).
4. Outputs should remember how they were made (ComfyUI).
5. Sharing is a single JSON file (Raycast).
6. Do not embed n8n, Dify or LangGraph. Their licenses, servers and second runtimes buy nothing that a few hundred lines of pure TypeScript in this repo's own style would not (compare `corp/mesh.ts` and `subagent/scheduler.ts`: pure cores with injected runners).

### 3.2 What makes deep research good

| Practice | Evidence |
|---|---|
| **Clarify intent before researching** | OpenAI deep research runs an intent-clarification step and then rewrites the prompt before research begins ([FAQ](https://help.openai.com/en/articles/10500283-deep-research-faq), [API guide](https://developers.openai.com/api/docs/guides/deep-research)) |
| **Show a plan the user can edit before spending the time** | Gemini Deep Research: "Edit plan", then "Start research"; the report exports to Docs ([help](https://support.google.com/gemini/answer/15719111)) |
| **Scale effort to the question; start wide, then narrow; parallel sub-researchers** | Anthropic's research system scales from 1 agent with 3–10 tool calls for a fact, to 2–4 subagents with 10–15 calls each for comparisons, to 10+ for complex work. Parallelism cut research time by up to 90% on complex queries. Token usage alone explains ~80% of BrowseComp variance ([post](https://www.anthropic.com/engineering/multi-agent-research-system)) |
| **Prefer authoritative sources; watch for content farms** | The same post saw agents pick SEO content farms over academic PDFs and personal blogs, and fixed it with source-quality heuristics |
| **Iterate on knowledge gaps** | local-deep-researcher runs a query, searches, summarises, **reflects on gaps**, writes a new query, and repeats (default 3 loops). DuckDuckGo is the default backend, and there are fallbacks for models that cannot emit JSON ([repo](https://github.com/langchain-ai/local-deep-researcher), MIT) |
| **Compress each sub-topic before writing** | open_deep_research: scope, brief, supervisor, researchers, **compression**, final report. RACE 0.4344 on DeepResearch Bench ([repo](https://github.com/langchain-ai/open_deep_research), MIT) |
| **Outline first, from multiple perspectives** | STORM: perspective-guided questions and simulated grounded conversations, then an outline, then a cited article. Supports SearXNG and DuckDuckGo retrievers ([repo](https://github.com/stanford-oval/storm), MIT). An independent comparison reports its articles are more often judged well-organised ([digitalapplied](https://www.digitalapplied.com/blog/open-source-deep-research-agents-2026-guide)) |
| **A separate citation pass, and verification** | Anthropic uses a dedicated CitationAgent. On ALCE, even the best models lacked complete citation support about half the time on ELI5 ([paper](https://arxiv.org/abs/2305.14627)). In deep-research agents, 3–13% of cited URLs are **fabricated**, and a liveness tool cut non-resolving URLs to under 1% ([paper](https://arxiv.org/abs/2604.03173)) |
| **Judge with a rubric on a small real query set** | Anthropic's rubric covers factual accuracy, citation accuracy, completeness, source quality and tool efficiency, over ~20 real queries. DeepResearch Bench measures report quality with RACE and citation trustworthiness and effective citations with FACT ([paper](https://arxiv.org/abs/2506.11763)) |
| **Resumable, checkpointed runs** | Anthropic: resume from the point of failure rather than restarting, plus regular checkpoints |

**Small local models can do this, under the right structure:**
- Local Deep Research reports **Qwen3.5-9B at 91.2% on SimpleQA** (182/200) with its agentic strategy, and Qwen3.6-27B at 95.7%. Its caveats are small samples and grader noise ([repo](https://github.com/LearningCircuit/local-deep-research), MIT).
- **Jan-nano**, a Qwen3-4B fine-tune for tool-driven research (Apache-2.0), reports 83.2% versus 59.2% for base Qwen3-4B on its MCP SimpleQA setup ([card](https://huggingface.co/Menlo/Jan-nano), [report](https://arxiv.org/abs/2506.22760)).

These are **short-answer** benchmarks, not long cited reports. But they show a 4B–9B can drive search-and-read loops, and that fine-tuning moves it a lot. That is relevant to Track 6: the bounded steps below would make clean SFT data.

**What this means for Bobble:**
- The pipeline in §4.5 is these practices made deterministic.
- The citation guarantee comes from construction, not trust: URLs only enter the report from pages the run actually fetched, and quotes are string-verified against those pages.

### 3.3 Image improve loops

| Work | Finding | What it means for Bobble |
|---|---|---|
| **Idea2Img** (ECCV 2024) ([paper](https://arxiv.org/abs/2310.08541)) | An LMM revises the T2I prompt, **selects the best draft**, gives **one concrete improvement** per round, and keeps a memory of past attempts. Default T=3 rounds. SDXL user preference rose from 13.5% (manual prompts) to 56.7%. **LLaVA-1.5-13B failed**: it repeated the same prompt without real revision | Use memory of the pass history and a deterministic guard against repeated prompts. Keep a small VLM's job narrow |
| **DSG, Davidsonian Scene Graph** (ICLR 2024) ([paper](https://arxiv.org/abs/2310.18235), [code](https://github.com/j-min/DSG), Apache-2.0) | Decompose a prompt into **atomic yes/no questions** with a dependency graph, so a child question is skipped when its parent is "no" | This is the checklist. A 4B VLM answers "is there a red umbrella?" far more reliably than "critique this image" |
| **VQAScore** (ECCV 2024) ([paper](https://arxiv.org/abs/2404.01291), [t2v_metrics](https://github.com/linzhiqiu/t2v_metrics), Apache-2.0) | Score = **P("Yes")** to "Does this figure show '{text}'?". Agrees with humans better than CLIPScore | Read `n_probs` or logprobs on a one-token yes/no answer to get a continuous score for hill-climbing, instead of a coarse pass/fail |
| **OPT2I** (TMLR 2024) ([paper](https://arxiv.org/abs/2403.17804)) | An LLM rewrites the prompt to maximise a DSG consistency score: up to +24.9% DSG, robust to the choice of LLM | Re-prompt only on **failed checks**, and measure the result, not a vibe |
| **ReflectionFlow** (ICCV 2025) ([paper](https://arxiv.org/abs/2504.16080)) | On GenEval, FLUX.1-dev scored 0.67. **Noise-level search (seeds plus a verifier) took it to 0.85.** Prompt-level added a little (0.87) and reflection-level took it to 0.91. Hard prompts went from 0.10 to 0.81 | **Re-seeding with a good verifier is the cheapest big lever.** Re-prompting and editing are for structural or local faults |
| **Inference-time scaling for diffusion** (CVPR 2025) ([paper](https://arxiv.org/abs/2501.09732)) | Searching over noises with verifiers scales, but no one verifier or algorithm is best for every task | Keep the scorer pluggable |
| **Plateaus without external models** ([paper](https://arxiv.org/abs/2506.12633)) | Gains saturate | Stop on a plateau (2 passes without improvement) |
| **Position bias in MLLM judges** ([study](https://www.researchgate.net/publication/394593412_Identifying_and_Mitigating_Position_Bias_of_Multi-image_Vision-Language_Models)) | Pairwise judges favour one position. The fix is to judge both orders and aggregate | A pairwise A/B is only trusted when both orders agree |
| **Small local judges** | **UnifiedReward-2.0-qwen3vl-2b**: Qwen3-VL-2B based, MIT, pairwise rank plus pointwise score ([card](https://huggingface.co/CodeGoat24/UnifiedReward-2.0-qwen3vl-2b)); no GGUF published. **HPSv3**: Qwen2-VL preference model, MIT code ([repo](https://github.com/MizzenAI/HPSv3)) | Optional dedicated judge for blind engines. It needs a GGUF conversion and a quality check. **Not** the default |

### 3.4 Structured output on small local models

- **Grammar-constrained JSON** is mature. JSONSchemaBench evaluates 10k real schemas across Guidance, Outlines, llama.cpp, XGrammar and others ([paper](https://arxiv.org/abs/2501.10868)). llama-server accepts `response_format` `{type:"json_schema"|"json_object", schema}` and `/completion` accepts `json_schema` and `grammar`. `n_probs` returns top-token probabilities, and `/v1/chat/completions` accepts `image_url` with `--mmproj` ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)).
- **"Let Me Speak Freely?"** (EMNLP 2024) ([paper](https://arxiv.org/abs/2408.02442)): JSON-mode constraints **hurt reasoning** but **help classification**. Constrain judgements and extractions, and let writing run free. Put a bounded `reason` field **before** the verdict field.

### 3.5 Licenses and footprints of anything we might use or bundle

| Candidate | License | Footprint | Use |
|---|---|---|---|
| Our own engine (pure TS) | this repo | ~1–2k lines | **Yes** |
| LangGraph.js | MIT | npm deps plus a second runtime | No (§4.11) |
| n8n / Dify | not OSI (`NOASSERTION`) | server plus DB | No |
| SearXNG ([repo](https://github.com/searxng/searxng)) | AGPL-3.0 | Python server | Optional **endpoint** the user runs, never bundled |
| DSG / t2v_metrics | Apache-2.0 | code only (method) | Borrow the method, not the code |
| UnifiedReward-2.0-qwen3vl-2b | MIT | ~2B params (~1.5–2.5 GB as a GGUF with its projector, estimated) | Optional judge, behind a download card |
| Jan-nano | Apache-2.0 | 4B | Input to Track 6 (not a dependency here) |

---

## 4. Design

### 4.1 The stance, and how it fits the user's principles

Anthropic's split is the right frame: a **workflow** is a predefined path, and an **agent** directs itself. Bobble's chat and corp are agents on purpose. The user: "EVERYTHING SHOULD JUST BE AN AGENT RUNNING WITH TOOLS", and "prompt pressure is as good as we need". A workflow is different in kind. **The user (or the template they picked) has already stated the procedure**, so running it in code is not the harness assuming something about a task. It is the harness doing what it was told:

- The rule the user objected to was harness machinery that "names a runtime, a file layout or a command" for arbitrary work (`user-prompt-pressure-not-enforcement`). A workflow step list is the user's own specification. The image loop's incumbent rule is the user's own spec, quoted in §1.
- "**Every corp role must run as a scoped pi agent … never a bare completion**" (`pi-desktop-roles-in-harness`). That rule is kept, and open-ended steps (`agent`) run as a child pi with tools. The bounded calls (`plan`, `extract`, `judge`, `section`) are the shape the app already uses for the titler, the reviewer, the prompt enhancer and `make_deck.py`. They have thinking off, grammar-constrained output and capped tokens, which removes the runaway-overthinking failure mode that rule exists to prevent.
- Model judgement stays **inside** each step. The code decides only order, repetition, the incumbent, retries and budgets.

### 4.2 Concepts and data model

**Workflow (definition).** One JSON file per workflow, at `~/.pi/desktop/workflows/<slug>.workflow.json`, with schema id `bobble.workflow/1`.

That location is beside `scheduled-tasks.json`, which is the same "any harness can write it" argument as `create_scheduled_task`. The name is deliberately distinct from ComfyUI "workflow" templates (`studio-workflow.ts`, `gen-service/comfy-workflow.ts`).

```json
{
  "schema": "bobble.workflow/1",
  "id": "wf_mz3k2a",
  "name": "Market brief",
  "description": "Researches a market and writes a cited Word brief, with slides if asked.",
  "icon": "research",
  "inputs": [
    { "id": "topic", "label": "Topic", "kind": "text", "required": true, "example": "home battery storage in the EU" },
    { "id": "depth", "label": "Depth", "kind": "choice", "options": ["quick", "standard", "deep"], "default": "standard" },
    { "id": "slides", "label": "Also make slides", "kind": "toggle", "default": false }
  ],
  "steps": [
    { "id": "research", "type": "research", "question": "{{topic}}", "depth": "{{depth}}", "sources": "web", "approvePlan": true },
    { "id": "write",    "type": "write",    "from": "research", "form": "report", "length": "medium", "audience": "a busy executive" },
    { "id": "docx",     "type": "make",     "from": "write", "kind": "docx" },
    { "id": "deck",     "type": "make",     "from": "write", "kind": "pptx", "slides": 10, "when": "{{slides}}" },
    { "id": "deliver",  "type": "deliver",  "files": ["docx", "deck"], "present": true }
  ],
  "trigger": { "kind": "manual" },
  "createdFrom": { "kind": "template", "ref": "deep-research-word" },
  "revision": 3
}
```

Interpolation is `{{input}}` and `{{step.output.field}}` only. There is no code in templates. The idea comes from Raycast placeholders and Dify variables, restricted on purpose.

**Step vocabulary (v1): a closed menu, each shown in the editor as a sentence.**

| Type | Sentence in the editor | What runs | Model use | Output (typed) |
|---|---|---|---|---|
| `research` | "Research *topic* (standard)" | §4.5 pipeline | Bounded calls (plan, queries, extract, gaps, compress) | `Evidence` (sources, notes, findings, limits) |
| `write` | "Write a report from *research*" | §4.5 steps 4–6 | Bounded calls (outline, sections, summary) plus deterministic checks | `Doc` (a DocModel: one spec, many readers, the `packages/charts` idea) |
| `make` | "Make a Word document" | `office.py render --spec` (new) or `make` | None, or the pipeline's own | `File` |
| `image` | "Generate an image of *…*" | Gen JobQueue via the guardian | None | `Image[]` |
| `improve` | "Improve *image* (3 passes)" | §4.6 controller | Bounded vision calls | `Image` plus a `PassLog` |
| `agent` | "Ask Bobble to *…* (with Files, Web)" | A child pi, `spawnAndWait`, optionally a pinned specialist kit | A full harnessed agent, bounded by steps and time | `Text` plus `File[]` |
| `check` | "Check: is *X* under 100 words?" | Deterministic predicate (words, contains, exists, number compare), or a model yes/no | Optional bounded call | `Verdict` |
| `repeat` | "For each *item* in *list* …" / "Until *check* passes (max 3)" | Code | None | Array / last value |
| `approve` | "Let me review *plan* before continuing" | Pauses the run | None | The edited value |
| `deliver` | "Show the files and save to *folder*" | Present bridge, copy, open in chat, optional Reminder (`personal`) | None | None |

Inputs are declared at the top, like Shortcuts' "Receive input" or Agent Builder's Start node. The kinds are `text`, `longtext`, `choice`, `number`, `toggle`, `file`, `folder` and `image`.

**Run record.** It lives at `~/.pi/desktop/workflow-runs/<workflowId>/<runId>/run.json`. Next to it sit `journal.jsonl`, `evidence.json` and an `artifacts/` link. It is modelled on `TaskRun`:

```json
{
  "id": "wr_mz3l0c_x1", "workflowId": "wf_mz3k2a", "revision": 3,
  "trigger": "chat", "chat": "~/.pi/agent/sessions/…/abc.jsonl",
  "inputs": { "topic": "home battery storage in the EU", "depth": "standard", "slides": true },
  "status": "running",
  "startedAt": 1790000000000,
  "model": { "id": "qwen3.5-4b-mtp", "displayName": "Qwen3.5 4B" },
  "steps": [
    { "id": "research", "status": "running", "detail": "Reading 7 of 18 sources: iea.org", "startedAt": 1790000004000 },
    { "id": "write", "status": "pending" }
  ],
  "limits": ["3 search results skipped: rate-limited by DuckDuckGo (retried twice)"],
  "outDir": "~/Bobble/chats/eu-batteries/"
}
```

Run statuses: `queued | waiting-chat | running | needs-input | waiting-memory | ok | error | stopped`.

**Journal.** One line per completed unit of work: `{step, unit, key: sha256(stepDef + resolvedInputs + upstreamKeys), output}`. **Resume** replays every unit whose key is unchanged and runs live from the first changed or failed one. This combines Claude Code's resume, ComfyUI's cache and n8n's pinned data. "Re-run from here" on any step is the same mechanism.

**Evidence ledger** (the `research` output). It is the single source of truth every renderer reads:

```json
{
  "question": "…", "brief": "…",
  "subquestions": [{ "id": "q1", "text": "How much home storage was installed in the EU in 2025?" }],
  "sources": [{ "id": "S3", "url": "https://…/report.pdf", "title": "…", "site": "iea.org", "published": "2026-03", "fetchedAt": 1790000123000, "kind": "pdf" }],
  "notes": [{ "id": "N12", "source": "S3", "q": "q1", "claim": "EU residential storage additions reached …", "quote": "…verbatim sentence from the page…", "numbers": ["…"] }],
  "findings": [{ "q": "q1", "bullets": [{ "text": "…", "notes": ["N12", "N14"], "status": "corroborated" }] }],
  "limits": ["Could not confirm 2026 forecast: only one source (S9)."]
}
```

**DocModel** (the `write` output). Sections hold paragraphs of `{text, cites:["S3","S7"]}`, plus optional `stats`, `table` (every cell can carry cites) and `quote`. There is also `summary`, `keyNumbers`, `limits` and `sources`. Every renderer (md, docx, pptx, xlsx) reads this one object.

### 4.3 Architecture

```
 renderer (apps/desktop/src/workflows/*)       main (apps/desktop/electron/workflows/*)            engines / services
 ─────────────────────────────────────         ───────────────────────────────────────            ──────────────────
 + menu "Research" / "Workflows ›" ─┐          workflows-main.ts  (IPC, triggers, window events)
 Workflows page / editor ───────────┼─invoke─▶ workflow-store.ts  (~/.pi/desktop/workflows/*.json, watch)
 WorkflowRunCard (thread) ◀─────────┼─events── run-store.ts       (~/.pi/desktop/workflow-runs/…)
 PlanApproval / PassStrip ──────────┘          host.ts ──▶ packages/workflows executor (pure, tested)
                                                        │    runners/model.ts  ─ structuredCall ─▶ llama-server | MLX engine
 chat model: `workflow run …`  ── subagent-bridge ─────▶│    runners/agent.ts  ─ childAgents.spawnAndWait ─▶ child pi (+ specialist kit)
 (harness tool / CLI group)      socket, method        │    runners/web.ts    ─ web-tools search/fetch + cache + pacing
                                  'workflow'            │    runners/office.ts ─ runOffice / office.py render --spec
 scheduled-runner (task.workflow) ────────────────────▶│    runners/image.ts  ─ GenQueueControl.generateImage / edit
                                                        │    runners/vision.ts ─ judge: resident VLM | dedicated | refuse
                                                        │    runners/present.ts─ present bridge
                                                        ├─ chat-activity.ts  (yield: main chat turn in flight?)
                                                        └─ guardRun (memory guard, light) · journal on disk
```

**New files.**
- `packages/workflows/src/`: `schema.ts` (typebox; the same schema is the json_schema used when the model drafts a workflow), `validate.ts`, `interpolate.ts`, `executor.ts`, `journal.ts`, `events.ts`, `defaults.ts`, and `steps/{research,write,improve}.ts`. The steps are pure controllers with every IO injected, so they unit-test like `corp/mesh.ts`.
- `apps/desktop/electron/workflows/`: `workflows-contract.ts`, `workflows-main.ts`, `workflow-store.ts`, `run-store.ts`, `host.ts`, `chat-activity.ts`, `drafts.ts`, and `runners/*.ts`.
- `packages/harness/src/workflows/workflow-tool.ts`. It also touches `tool-cli-groups.ts`, `presets/capabilities.ts` and `subagent/bridge-client.ts`.
- `apps/desktop/src/workflows/`: `workflows-store.ts`, `WorkflowRunCard.tsx`, `PlanApproval.tsx`, `PassStrip.tsx`, `WorkflowEditor.tsx`, `WorkflowPage.tsx`, `templates.ts`, `results-context.ts`.
- `tools/office-gen/`: an `office.py render` subcommand, a `doc_render.py` `sources` block with citation superscripts and hyperlinks, `sheet_render.py` multi-sheet with hyperlinks, and a `render_deck.py` sources slide.

**Existing files touched.**
- `apps/desktop/electron/ipc-contract.ts`: merge `WORKFLOWS_INVOKE_CHANNELS`, the same way as `SCHEDULED_INVOKE_CHANNELS`.
- `main.ts`: register the handlers beside `registerScheduledHandlers`.
- `pi/subagent-bridge.ts`: a `workflow` method beside `spawn` and `corp`.
- `pi/pi-main.ts`: feed `chat-activity` from `createPiSessions`' `sendEvent`, which sees every `agent_start` and `agent_end`.
- `gen/gen-manager.ts`: add `generateImage` / `editImage` on `GenQueueControl`, beside `run3d`, "through the same door".
- `scheduled/schedule-logic.ts` and `scheduled-runner.ts`: an optional `workflow` on a task.
- `packages/ui/src/components/add-menu.tsx`: a Workflows submenu.
- `src/chat/ChatComposer.tsx`: wire `onResearch`.
- `src/scheduled/*`: list integration.

**IPC** (following the naming of `tasks:*`):

| Kind | Channel | Request → Response |
|---|---|---|
| invoke | `workflows:list` | → `{workflows}` |
| invoke | `workflows:get` | `{id}` → `{workflow}` |
| invoke | `workflows:save` | `{workflow}` → `{workflow, errors?}` |
| invoke | `workflows:delete` | `{id}` → `{ok}` |
| invoke | `workflows:import` / `workflows:export` | `{path}` → `{workflow}` / `{path}` |
| invoke | `workflows:run` | `{id \| inline, inputs, chat?}` → `{runId}` |
| invoke | `workflows:stop` | `{runId}` → `{ok}` |
| invoke | `workflows:resume` | `{runId, fromStep?}` → `{runId}` |
| invoke | `workflows:approve` | `{runId, stepId, value}` → `{ok}` |
| invoke | `workflows:list-runs` | `{workflowId \| chat}` → `{runs}` |
| invoke | `workflows:draft-from-chat` | `{sessionFile}` → `{draft}` |
| invoke | `workflows:draft-from-text` | `{text}` → `{draft}` |
| event | `workflows:changed` | `{workflows}` |
| event | `workflows:run-updated` | `{run}` (step detail throttled to ≤4 Hz) |

### 4.4 Rules that make it reliable on a 4B

1. **One job per call.** The instruction comes first, because a 4B reads the top. Input stays under ~8k tokens (one page chunk, or one section's notes). Output is capped at 256–1024 tokens.
2. **Structured where the job is extraction, classification or judgement.**
   - `structuredCall()` sends `response_format: {type:"json_schema", schema}` when the engine honours it. That is probed once per server start with a 1-token schema request and cached per `launchFingerprint`.
   - Otherwise it asks for JSON only, parses tolerantly (office's closure-repair `parse_json`, chart's `salvageJson`), validates against the schema, and retries **once** quoting the validation error.
   - If that fails too, the unit is marked *degraded*, logged in `limits`, and never faked.
   - Schemas put a short `reason` field before the verdict.
3. **Free text where the job is writing**, followed by deterministic checks (§4.5 step 5).
4. **Thinking off for bounded calls** (`chat_template_kwargs.enable_thinking:false`). This is honoured by the forced Qwen template, and it is what the reviewer fix measured. WP-14 A/B-tests thinking on the writing steps only.
5. **One fixed system prompt per step kind, with the variable part last**, so the prompt cache (8 GB LRU) keeps every step kind's prefix warm. `callModel` already carries `tools: []` shapes. There is no per-call churn.
6. **Validate every output deterministically and retry within bounds.** This is n8n-style *retry on fail* (max 2), and the error the user sees is plain words.
7. **Journal every unit.** Resume and "re-run from here" come free.
8. **Yield to the user.**
   - Never start a model call while the main chat has a turn in flight, or within `POST_TURN_DELAY_MS` (2.5 s, the measured rule) after one.
   - `chat-activity.ts` tracks `agent_start` and `agent_end` per window from `pi-main.ts`.
   - When the user presses Enter, the in-flight bounded call is aborted. It is idempotent and journaled, so it simply re-runs.
   - The card says "Paused while you chat".
9. **No silent caps.** Anything a budget drops (sources unread, passes skipped, rate limits) goes on the card *and* into the report's "Limits" section.
10. **Web text is data, not instructions.**
    - Page text only enters **bounded extraction calls that have no tools**. `agent` steps receive the ledger, never raw pages.
    - Unattended runs keep `FORBID_TOOLS_ENV` (no `messages_send`).
    - A quote that is not verbatim in the page is dropped, which also defeats injected "facts".
11. **Fail honestly.** A step that cannot do its job ends the run with a reason ("the model cannot see images; turn on Vision in the engine menu"). It never produces a fake success. This is the `looksUndelivered` lesson from `pi-desktop-single-ceo-delegation`.
12. **Memory.**
    - Every run registers with `guardRun` (light, like a pi child).
    - Image jobs go through the guardian's `fits()` admission.
    - A hold shows "Waiting for memory: the image model needs ~7 GB" and never fails the run.
    - Heavy scheduled workflows obey a battery policy (question Q8).

### 4.5 Deep research: the pipeline

| # | Step | Model? | Schema / output | Deterministic parts | Standard-depth count |
|---|---|---|---|---|---|
| 0 | **Scope** | 1 call | `{kind: fact\|comparison\|survey\|howto\|news, recency, deliverables[], clarify: [≤3 {q, default}]}` | Defaults the plan and the depth. In chat the clarifications appear as a small form with the defaults filled in; unattended runs take the defaults | 1 |
| 1 | **Plan** (approve) | 1 call | `{brief, subquestions: [{q, why}], outline_hint[]}`: 3/5/8 sub-questions by depth | `approve` step: the Gemini-style editable plan. Skipped in unattended runs | 1 |
| 2a | **Queries**, per sub-question | 1 call | `{queries: [2–4 short queries], sites?: []}`, starting wide | Duplicate-query guard | 5 |
| 2b | **Search** | none | none | `runWebSearch` paced (≥2 s plus jitter), cached for 24 h in `~/.cache/bobble/research/search/`, deduplicated by canonical URL, **ranked**: a primary-source class boost (.gov/.edu, standards bodies, official docs, arxiv, wikipedia, the vendor), a content-farm pattern penalty, ≤2 results per domain, snippet overlap. Top K taken | 15 queries |
| 2c | **Read** | none | none | `fetchReadable` (cached by URL), PDF text via `pypdf` in the office venv (already provisioned by `office-gen-env.ts`), boilerplate strip, chunks of ≤6k tokens, best 1–2 chunks by lexical overlap | ~20 pages |
| 2d | **Extract** | 1 call per chunk | `{relevant: bool, notes: [{claim, quote, numbers[], date?}]}` | **The quote must appear verbatim in the chunk** (after normalising whitespace, quotes and dashes), or the note is dropped and counted. Source records `S#` are minted by code from the fetch response | ~25 |
| 2e | **Gap check** | 1 call per loop | `{answered: bool, missing: string, next_queries[]}` | Loops ≤ depth.loops. New queries run 2a–2d again | 5–10 |
| 2f | **Compress** | 1 call | `{bullets: [{text, notes[]}]}` per sub-question, 5–10 bullets (open_deep_research) | Notes cited must exist | 5 |
| 3 | **Cross-check** | ≤1 call per conflict | `{statement}` describing a disagreement | Numeric claims are clustered by metric and unit. Values outside tolerance across sources are marked **contested**, claims with one source **single-source**, and agreeing ones **corroborated** | 0–5 |
| 4 | **Outline** | 1 call | `{sections: [{heading, findings[], form: prose\|table\|stats\|comparison}]}` (STORM outline-first) | Every finding is used at most twice | 1 |
| 5 | **Write**, per section | 1 call | Free text with `[S3]` markers, given **only** that section's notes (id, claim, quote) | **Citation check:** every marker exists in this section's sources; every sentence with a digit has a marker whose note contains that number; no URL appears in prose. Violations get **one** repair call that quotes the offending sentences. A sentence still failing is removed and logged in *Limits* | 6 |
| 6 | **Summary** | 1 call | Executive summary, key numbers (with markers), "What we could not confirm" | Same check | 1 |
| 7 | **Render** | none | `report.md` always; `docx` / `pptx` / `xlsx` / `pdf` as asked | DocModel to spec to `office.py render --spec` (new). docx: citation superscripts hyperlinked to a **Sources** block (title, site, date, URL link, accessed date). pptx: a stats slide from `keyNumbers`, one slide per section, "Sources: 3, 7" footers, and a sources slide. xlsx: **Findings** (claim, status, sources), **Sources** (HYPERLINK), **Data** (tables) | 1–4 files |

**Depth presets** (all numbers to be tuned in WP-00 and WP-14):

| Preset | Sub-questions | Queries each | Pages read each | Gap loops | Rough estimate on the 4B |
|---|---|---|---|---|---|
| Quick | 3 | 2 | 3 | 1 | 3–5 min |
| Standard | 5 | 3 | 4 | 2 | 8–14 min |
| Deep | 8 | 4 | 5 | 3 | 20–35 min |

The estimate is arithmetic from measured rates:
- extraction ≈ 6k-token prefill at 1.3–2k tok/s plus ~200 tokens decoded at 40–55 tok/s, so ~7–10 s per chunk;
- small calls ~2–4 s;
- sections ~10–15 s;
- plus network time.

It is an **estimate, not a measurement**. The card quotes the `long-job.ts` "on this Mac" range once two runs exist.

**Why this is "intelligent", not just long:**
- the scope call picks the depth, recency and deliverables;
- the gap loop pursues what is missing;
- the cross-check says where sources disagree instead of averaging;
- *Limits* tells you what could not be confirmed. The `web-research` SKILL.md's rule ("note disagreement … state remaining uncertainty") becomes code.

**Other options:**
- **Local sources.** `sources: web | folder | both`. Folder files (md/txt/pdf/docx/xlsx through `office inspect`) run through the same extraction, so a report can cite your own documents.
- **Topic watch** (scheduled). The previous run's ledger (URLs plus claims) is passed as *known*, so the report covers only what is new since then.
- **Copyright hygiene.** Verbatim quotes live in the ledger. The rendered prose paraphrases with citations, and callout quotes are capped at ~25 words.

### 4.6 Image improve loop

**Controller** (pure, in `packages/workflows/src/steps/improve.ts`, with all IO injected):

```
checks = checklist(prompt, userCriteria)      // DSG-lite: ≤10 atomic yes/no, parent→child deps,
                                              // must-have flags (×3 weight) + 1–3 universal quality checks
prompt0 = enhancer(prompt)                    // existing prompt-enhancer dialect, when the enhancer is on
cands  = generate(prompt0, seeds = k0)        // noise-level search first (ReflectionFlow's biggest lever)
inc    = best(score(c) for c in cands)        // the incumbent
for pass in 1..N:
  if mustHavesPass(inc) and inc.score >= 0.9: stop("done")
  fault  = diagnose(inc, failedChecks)        // ONE concrete fault (Idea2Img)
  action = decide(fault, history)             // edit | reprompt | reseed  (schema, enum)
  cand   = make(action)                       // edit_image(inc, instr) | generate(newPrompt, newSeed) | generate(prompt, newSeed)
  if action == reprompt and nearDuplicate(newPrompt, history): action = reseed   // sameBrief-style 90% overlap guard
  if better(score(cand), inc): inc = cand; log("kept")  else: log("discarded")
  if lastTwoPassesNoGain: stop("plateau")
deliver(inc, strip = all candidates with scores, log)
```

**Scoring.**
- **Continuous (preferred):** VQAScore-style P("Yes") per check, via `/completion` with `multimodal_data` and `n_probs`. That is the request shape `omnisvg-request.ts` already uses on this llama.cpp build.
- **Fallback:** a constrained `{"answer":"yes"|"no"|"unsure"}` scored as 1 / 0 / 0.5.
- **Per-check calls or one batched JSON array per image?** Decided by the WP-00 measurement, because b9934 re-encodes the image on every request. At N checks, per-check calls cost N image encodes.
- **Judge resolution:** images are downscaled to the judge's native resolution first (e.g. 672 px long edge) to bound vision tokens.
- **Score:** a weighted mean, where must-haves count ×3.
- **`better()`** is true when `cand.score > inc.score + 0.03`, **or** the scores are within ±0.03 **and** a pairwise A/B prefers the candidate in **both** orders (position-bias fix).

**Who judges** (a `vision.ts` runner resolves this at run start):
1. **The resident chat model with vision.** This is the default, and vision is on by default (in flight: `loadVision`, `vision-launch.ts`). No extra memory.
2. **A dedicated small VLM judge**, for when the running engine is blind (e.g. the rapid-mlx MTP text lane). It is started short-lived through the same pattern `omnisvg.ts` uses. Candidate: UnifiedReward-2.0-qwen3vl-2b (MIT, 2B), which first needs a GGUF conversion and a quality check in WP-08. It is gated behind a Download card.
3. **Otherwise: an honest refusal** that names the fix: "the loop needs a model that can see; turn on Vision in the engine menu".

**Cost** (measured generation times; judging estimated at ~5–15 s per image):

| Preset | Model | First round | Per pass | 3 passes |
|---|---|---|---|---|
| Fast | FLUX.2 klein (Apache, ~24 s at 1024²) | 4 seeds | 1–2 candidates | ~4–6 min |
| Quality | Qwen-Image 2.1 (default, 88–97 s at 1024²; 49 s at 768²) | 2 seeds | 1 candidate | ~8–10 min |

**The same loop in four places:**
1. **Image Studio:** an **Improve ×3** action on a result, with the pass strip underneath. Track 8 owns the studio layout; this track provides the engine and the strip component.
2. **Chat:** "Improve an image" from Workflows ›, or the model's `workflow run improve-image`.
3. **As an `improve` step** inside any custom workflow.
4. **The `image` specialist:** it gets `workflow_run` in its kit, so `imageLoopProtocol` can hand the procedure to code and keep its own eyes for `diagnose` and `decide`.

### 4.7 Creating workflows

1. **Templates**, on the Templates tab. The v1 set:

   | Template | Steps |
   |---|---|
   | Deep research → Word report | research, write, make docx |
   | Research deck | research, write (form deck), make pptx |
   | Comparison spreadsheet | research options × criteria, write (form comparison: a table with per-cell cites), make xlsx |
   | Improve an image | image, improve |
   | Topic watch (weekly) | research new since last run, write brief, make md/docx; scheduled |

   `templates.ts`'s rule applies: **never offer a template for something the app cannot do**. Improve is hidden with no image model, and research is marked as needing the network.
2. **Save from a chat.**
   - The trigger is "Save as workflow…" in the thread's ⋯ menu, or the model hearing "save this as a workflow" and calling `workflow save`.
   - `drafts.ts` reads the session JSONL and builds a **deterministic skeleton from the tool trace**:
     - `web_search` and `web_fetch` become `research`;
     - `office_make` becomes `make(kind)`;
     - `chart` becomes `make chart`;
     - `generate_image` becomes `image`, and a run of `edit_image` calls becomes `improve`;
     - anything else becomes an `agent` step with the user's ask as its instruction.
   - One bounded call then names the inputs (for example, "home batteries in the EU" becomes `{{topic}}`) and writes a one-line sentence per step.
   - **The editor opens prefilled, and nothing is saved until the user presses Save.**
3. **Describe it.** Press New workflow and answer "What should it do?". One bounded call drafts JSON under the workflow schema (grammar-constrained on llama.cpp; the schema is the typebox `schema.ts`), and the editor opens. This matches the n8n AI Workflow Builder and Zapier Copilot, but with a small closed vocabulary a 4B can fill.
4. **Share.**
   - Export and import a `.bobble-workflow.json` file.
   - Outputs carry the workflow id, revision and inputs in metadata (docx core properties, PNG `tEXt`), after the ComfyUI idea. Opening a file offers "Run again".

### 4.8 Where it lives, and what you see

**Navigation (recommended; the name is Q1).** "Scheduled" becomes **Workflows**. The `Routines | Templates` segmented control stays, since it is the user's word. A row reads `tile · name · "By hand" | "Weekdays at 7:30 AM · next tomorrow" · trailing state`. A legacy scheduled prompt renders as a one-step workflow. The data does not move (§4.9).

**Run card, in the chat thread.** It is built from `LongJobCard` (estimate "on this Mac", a moving timer, evidence of life, Cancel) and `TaskChecklist` (step states and their animation):

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ◎ Deep research · "home battery storage in the EU"        4:12 · Stop    │
│   usually 9–13 min on this Mac                                            │
│   ✓ Plan            5 questions                                    ▸      │
│   ◌ Research        Reading 7 of 18 sources  [iea][ec][ember][+4]         │
│                     "Checking whether ember-climate.org answers q2"       │
│   ○ Write           6 sections                                            │
│   ○ Make            Word · Slides                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

**Plan approval.** The card expands in place. The sidebar row gets the **orange** needs-input dot, which is existing semantics.

```
│ Plan: edit anything, then start                                           │
│  1  How much home storage was installed in the EU in 2025?          ✕    │
│  2  What drives adoption: tariffs, subsidies, prices?               ✕    │
│  3  Who are the leading vendors and at what prices?                 ✕    │
│  +  Add a question                                                        │
│  Depth  ( Quick | ●Standard | Deep )    Make  [✓ Word] [✓ Slides] [ Sheet] │
│                                             Cancel   ▶ Start research     │
```

**Improve pass strip:**

```
│ Improve · "a red bicycle leaning on a blue door, sign reads BOBBLE"  2/3  │
│  [C0 0.62 ●kept] [C1 0.58 ✕] [C2 0.81 ●kept] [C3 … generating 0:41]       │
│  C2: fixed "sign reads BOBBBLE" (edit)   ·  C1: re-prompt made it worse   │
```

**States.** Every state has a probe screenshot in WP-07 and WP-09.

| Status | Card | Sidebar row |
|---|---|---|
| queued | "Waiting to start: another workflow is running" | none |
| waiting-chat | "Paused while you chat" (a quiet label, not an error) | none |
| running | Steps, detail line, timer | spinner |
| needs-input | Plan / clarify form | orange dot |
| waiting-memory | The guardian's sentence ("Waiting for memory: needs about 7 GB…") | spinner |
| ok | Deliverable cards (the present cards open in the canvas), "Sources (23) ▸", Run again, Save as workflow, Open folder | blue dot if unviewed |
| error | The step's plain-words error, **Resume from this step** | none |
| stopped | "Stopped at Write (2 of 4)", **Resume** | none |

**Composer.**
- The shared menu's unwired `onResearch` slot becomes **+ › Research**, and **+ › Workflows ›** lists saved workflows plus "Improve an image". Picking one inserts a **pill** through `insertPill`, the same mechanism the gen actions use.
- The typed text becomes the main input.
- **Enter dispatches the run directly**: `workflows:run` with `chat` set, and **no model turn**. The thread shows the user's line and the run card. The chat stays free.
- Optional (Q4): a quiet `ComposerPill` suggestion when a draft reads like a research-plus-deliverable ask: "Run as Deep research? cited Word report, ~10 min".

**The Workflows page.**
- **List.** As Scheduled today.
- **Workflow page.** `‹ All workflows`, a header with **Run · Edit · switch**, the inputs with defaults, the steps as sentences, the trigger, and a **Runs** ledger. That is `RunLedger` extended: each run expands to its steps, its deliverables and its *Limits*.
- **Editor.** One Radix dialog, following the TaskDialog anatomy:

```
┌ New workflow ─────────────────────────────────────────────────────────────┐
│ What should it do?  [research a market and give me a cited Word brief   ] │
│                                                       ✦ Draft the steps   │
│ Inputs   [Topic · text · required]  [Depth · choice]  [+ Input]           │
│ Steps                                                                      │
│  ⋮⋮ 1  Research {Topic} (standard) · web                          ⋯      │
│  ⋮⋮ 2  Write a report for a busy executive                         ⋯      │
│  ⋮⋮ 3  Make a Word document                                        ⋯      │
│       + Add a step                                                        │
│ When   ( By hand | On a schedule … )                                      │
│                                         Cancel   Test run   Save          │
└───────────────────────────────────────────────────────────────────────────┘
```

  Each step's ⋯ opens its knobs: depth and sources for research; form, length and audience for write; kinds for make; passes, preset and criteria for improve; instruction and toolkit for agent. Validation is inline ("Write needs research or files to write from"), and `from` only offers type-compatible steps, which is Agent Builder's typed edges.

### 4.9 Scheduling and unattended runs

- `ScheduledTask` gains an optional `workflow?: {id, inputs}`. `normalizeTask` preserves it, and `schedule-logic.ts` is otherwise unchanged. `scheduled-runner.ts` `execute()` branches: a prompt task runs in the pi bridge as today, and a workflow task runs through the workflow host.
- There is **one serialised queue** for heavy work, shared by the scheduler and workflows. Runs never overlap, which is the runner's existing rule ("how a scheduled task becomes a swap storm").
- **Unattended policy:**
  - `approve` steps take the defaults and record that they did;
  - `agent` steps run with `FORBID_TOOLS_ENV` (`messages_send`);
  - outputs go to `~/Bobble/workflows/<slug>/<YYYY-MM-DD HHmm>/`, a new `bobbleDir('workflows')`;
  - a finished run posts the usual notification.
- `create_scheduled_task` can target a workflow: `workflow` is an optional field in its schema.

### 4.10 Chat and model integration

- **Results reach the model through a context block.** It is `<workflow_results>`, one per user turn, **sticky** and persisted as custom session entries, using the exact pattern in `canvas-context.ts`. It lists runs in this chat that finished since the last turn:
  - name and inputs;
  - files as workspace-relative paths (`pathForModel`);
  - a 3-line summary;
  - the source count.

  So "make the deck shorter" works as a follow-up, and history stays byte-identical turn to turn (checked with `prompt-diff.mjs`).
- **Tools for the model.** A capability `workflows` and a CLI group `workflow`:
  - `workflow list`
  - `workflow run <name> [--<input>=…] [--wait]`
  - `workflow save [--name …]`

  Runs are **non-blocking** by default: the tool returns "started, the card is in the thread". `--wait` blocks like `talk_to_manager` and is used by specialists and the corp.
- **Transport.** The subagent-bridge socket with method `workflow`. When the app is absent, `bridge-client` returns null and the tool says workflows are unavailable here.
- **The prompt paragraph renders from the live CLI map.** This is the `coordinatePrompt` lesson: a prompt naming a command that does not exist is false availability.
- **Specialists.** `document` and `research` get `workflow_run` in `specialistToolsFor`, and `image` gets it for `improve-image`. That closes roadmap item 3: workflows callable from chat and corp as specialists.
- **Prefix cost.** Measure with `PI_ADV_DEBUG_TOOLCOST`. CLI mode adds a group name; schemas mode adds one schema, estimated at ~0.6–0.9k chars. Warm-up tools must stay in `resolvePresetTools` order (`pi-desktop-latency-harness`).

### 4.11 Alternatives considered

| Alternative | Why rejected, or kept only as a fallback |
|---|---|
| **Workflows as prompts** (SKILL.md, prompt templates, the chat agent follows a playbook) | Measured 4B behaviour: no volunteered plan on long tasks, compaction every 2–3 turns at 32k, a 179-call search loop before the guards, 2 sources on research-deck. Citations would come from memory. **Kept as the "Do it in chat instead" fallback.** |
| **Workflows as corp mesh runs** | The mesh is emergent and heavy, and it exists to *build products*. A workflow is a known procedure. The corp **calls** workflows instead. |
| **A node-graph canvas** (ComfyUI, n8n, Agent Builder) | Too much apparatus for the user's bar. OpenAI is shutting Agent Builder down. A 4B cannot author graphs. The internal model is still a DAG (steps with `from`), so a graph view can come later. |
| **Embed n8n, Dify or LangGraph** | License (n8n and Dify are not OSI), a server plus DB (Dify), a second agent runtime beside pi (LangGraph), and none of them know about pi, office.py, the guardian or the one-slot rule. |
| **Let the model write a JS workflow script** (the Claude Code style) | Sandboxing user code, and a 4B writing orchestration code reliably. The *semantics* are taken (schema'd outputs, journal, phases, no silent caps); the *authoring* is not. |
| **Blocking `workflow run` through the model for + menu launches** | It costs a model turn, keeps the chat busy for 10–30 min, and depends on a 4B calling the tool (the grammar-coercion failures). Direct dispatch plus the context block is more reliable. **Kept** as `--wait` for agents. |
| **A dedicated judge model by default** | Extra download and memory on 24 GB, when the resident chat model can see. Kept for blind engines only. |
| **Generated imagery in research decks** | `imagery.py` records the user's call: stock or procedural grounds, never generated pictures that "illustrate data". Asked as Q5 rather than overridden. |

---

## 5. Work packages (ordered)

Sizes: **S** ≤1 agent-day · **M** 2–4 days · **L** 1–2 weeks · **XL** more than 2 weeks.

**Rules for every WP:**
- all probes use `apps/desktop/tests/e2e/harness.mjs` `launchApp` (hidden window, throwaway `HOME`, focus guard, mock pi through `PI_BIN`);
- real-model runs are env-guarded (`REAL=1`), run on **AC power** only, and are never part of the default e2e chain;
- UI changes need screenshots that were **looked at** (`user-visual-confirmation-required`);
- anything touching the chat needs prefill and TTFT logged (`user-always-check-prefill`).

**MVP slice:** WP-00 through WP-07 (deep research from the + menu, with its card). **Then:** WP-08 and WP-09 (improve), then WP-10 through WP-13 (custom workflows end to end). WP-14 runs throughout.

### WP-00 · Spike measurements that set the defaults (S)
- **Files:** scratch probes only (`apps/desktop/tests/spikes/workflows-*.mjs`), and a results table recorded into `packages/workflows/src/defaults.ts` in WP-01.
- **Depends on:** none.
- **Measures:**
  1. whether `response_format` json_schema is honoured on each installed engine (llama.cpp b10603, rapid-mlx, mlx-lm): a 1-token probe plus a 3-field schema;
  2. extraction latency for a 6k-token chunk on the 4B (llama.cpp and rapid-mlx);
  3. the VLM yes/no path: `n_probs` through `/completion` plus `multimodal_data`; per-check versus batched cost; image-encode cost at 512, 672 and 1024 px;
  4. DuckDuckGo tolerance to paced fan-out (≤30 queries total, 2–5 s pacing);
  5. child-pi spawn-to-first-token for a pinned specialist in CLI mode.
- **Acceptance:** a table with numbers for 1–5, and a chosen default for each branch point (structured-output strategy per engine, scoring mode, pacing, chunk size).
- **Verify:** each probe prints JSON and is re-runnable. No app window. The model server is started from the real cache only when on AC, and its PID is reaped after (the orphan-server note).

### WP-01 · `packages/workflows`: schema, validation, interpolation, executor, journal (M)
- **Files:** `packages/workflows/{package.json,src/schema.ts,validate.ts,interpolate.ts,executor.ts,journal.ts,events.ts,defaults.ts,index.ts}` and tests.
- **Depends on:** WP-00 (for the defaults only; it can start in parallel).
- **Acceptance:**
  - a typebox schema for `bobble.workflow/1`;
  - `validate()` returns plain-words errors (for example "Write needs research or files to write from");
  - `{{}}` interpolation only over inputs and step outputs;
  - the executor runs `input → steps` sequentially with `when`, `repeat` (for-each, and until-check with max N plus an optional incumbent), `approve` (pause and resume with an edited value), cancellation, and per-unit retries;
  - the journal keys are stable, and resume replays the unchanged prefix;
  - budgets and drops are logged into `limits` (no silent caps).
- **Verify:** vitest covers:
  - order and `when` skipping;
  - resume = 100% cache hit on the same definition and inputs;
  - editing step 3 re-runs from step 3;
  - stop mid-unit finalises as `stopped`;
  - approve pause and resume;
  - the loop incumbent is never replaced by a lower score;
  - validation messages (snapshot).

### WP-02 · The main-side host: store, runs, IPC, bindings, yield, guard (L)
- **Files:**
  - new: `apps/desktop/electron/workflows/{workflows-contract.ts,workflows-main.ts,workflow-store.ts,run-store.ts,host.ts,chat-activity.ts,runners/{agent.ts,web.ts,office.ts,present.ts}.ts}`;
  - touched: `electron/ipc-contract.ts`, `electron/main.ts`, `electron/pi/pi-main.ts` (feed `chat-activity`), `electron/pi/subagent-bridge.ts` (the `workflow` method stub).
- **Depends on:** WP-01, WP-03.
- **Acceptance:**
  - every `workflows:*` channel in §4.3 works;
  - definitions live at `~/.pi/desktop/workflows/*.json` with a directory watch (the `lastWritten` echo guard copied from `scheduled-main.ts`);
  - runs live at `~/.pi/desktop/workflow-runs/…`, keeping 20 per workflow;
  - `agent` steps go through `childAgents.spawnAndWait` (with an optional specialist) and appear as nested child chats;
  - yield: no model call while the main chat streams or within 2.5 s after it ends, and an in-flight bounded call aborts on send;
  - `guardRun` registration;
  - runs serialise with the scheduler through a shared heavy-work queue.
- **Verify:**
  - unit tests with fake runners (IPC handlers, store round-trip, the yield gate using fake `agent_start`/`agent_end`);
  - e2e `workflows-host-probe.mjs`: mock pi plus a new `tests/e2e/_mock-model-server.mjs` (scripted JSON keyed by a step marker in the system prompt, which also logs requests). It runs a 3-step inline workflow over IPC and asserts:
    - the records on disk;
    - `workflows:run-updated` events in order;
    - that a fake chat turn (a mock-pi fixture) holds the next model call until 2.5 s after `agent_end`.

### WP-03 · `structuredCall`: engine-aware constrained output with validation (M)
- **Files:** `apps/desktop/electron/workflows/runners/model.ts` (it wraps `packages/harness/src/model-call/call-model.ts`), a capability probe cache keyed by the server's launch fingerprint, and tests.
- **Depends on:** WP-00.
- **Acceptance:**
  - json_schema on engines that honour it, with fallback to JSON-only, then tolerant parse, validation, and one retry that quotes the error, then *degraded*;
  - `enable_thinking:false` by default with a per-step override;
  - `timeoutMs` per kind;
  - fixed system prompts per step kind (a unit test asserts byte-stability).
- **Verify:**
  - vitest against a fake fetch: a malformed-then-valid pair recovers; a double failure returns degraded rather than throwing;
  - a real-engine check (`REAL=1`) runs the WP-00 probe schema on llama.cpp and rapid-mlx and passes on both.

### WP-04 · The `research` step (L)
- **Files:** `packages/workflows/src/steps/research.ts` (the pure controller); `apps/desktop/electron/workflows/runners/web.ts` (search cache in `~/.cache/bobble/research/`, pacing, canonical URLs, ranking, a PDF path through the office venv's `pypdf`); `packages/web-tools/src/search.ts` (a test-only endpoint override env, like `HF_ENDPOINT`); fixtures under `packages/workflows/test/fixtures/web/`.
- **Depends on:** WP-01, WP-02, WP-03.
- **Acceptance:**
  - the §4.5 steps 0–3 produce an evidence ledger;
  - quotes are verified verbatim (normalised), and unverifiable notes are dropped and counted;
  - `S#` ids are minted only from fetch responses (**no URL enters from model output**);
  - the gap loop is bounded by depth;
  - the cross-check marks corroborated, single-source or contested;
  - rate-limit pages (`isDuckDuckGoChallenge` in `search.ts`) become paced retries, then an entry in *Limits*;
  - the browser-backed search remains the fallback.
- **Verify:**
  - vitest with fixture pages and a scripted model: ranking order (primary above content farm), the quote verifier (curly quotes, NBSP and ellipsis cases), dedupe, gap-loop termination, cross-check clustering;
  - e2e with the `_mock-web.mjs` loopback serving DDG-shaped results and articles: `workflows-research-probe.mjs` asserts the ledger's contents and that zero ledger URLs lie outside the served set.

### WP-05 · The `write` step and citation checker (M)
- **Files:** `packages/workflows/src/steps/write.ts`, `packages/workflows/src/citations.ts`, `report-md.ts`, and tests.
- **Depends on:** WP-04.
- **Acceptance:**
  - outline, then per-section writing given only that section's notes, then a summary;
  - the checker enforces: markers ∈ the section's sources; a sentence containing a digit has a marker whose notes contain the number; no raw URLs in prose;
  - one repair call; then removal with an entry in *Limits*;
  - DocModel plus `report.md` with a Sources list.
- **Verify:** vitest.
  - The checker flags seeded violations: an unknown `[S9]`, a number not present in any cited note, a pasted URL.
  - Repair is invoked exactly once per failing section.
  - A golden `report.md` from fixtures.

### WP-06 · office-gen: render-from-spec, citations, sources, multi-sheet (M). Coordinate with Track 10.
- **Files:** `tools/office-gen/office.py` (a `render <kind> --spec <file> --out` subcommand and `--brief-file` for make); `doc_render.py` (a `sources` block, citation superscripts hyperlinked to the list, optional TOC); `sheet_render.py` (multiple sheets, `HYPERLINK` cells, a per-cell note); `render_deck.py` (a `sources` layout and a small footer line); `packages/harness/src/tools/office-tool.ts` (`runOffice` accepts `render`); python tests in `tools/office-gen/tests/`.
- **Depends on:** none (it can start in parallel); consumed by WP-07.
- **Acceptance:**
  - the render path makes **no model call** and invents nothing;
  - `office inspect` outlines show the sources with URLs;
  - docx hyperlinks work in Word and LibreOffice and in the vendored viewer;
  - the xlsx Sources sheet has live links;
  - existing `make` behaviour is unchanged.
- **Verify:**
  - `python3 -m unittest` in the office venv (spec in, `inspect` out, links present);
  - `office-embed-probe.mjs`-style composite screenshots of the rendered docx, xlsx and pptx in canvas tabs (native views captured through `office:capture`), and looked at.

### WP-07 · Deep research end to end: template, + › Research, run card, plan approval (L)
- **Files:**
  - `apps/desktop/src/workflows/{workflows-store.ts,WorkflowRunCard.tsx,PlanApproval.tsx,results-context.ts}`;
  - `src/chat/ChatComposer.tsx` (wire `onResearch` with a pill; dispatch on Enter);
  - `packages/ui/src/components/add-menu.tsx` (the Workflows submenu);
  - `src/chat/ChatThread.tsx` (slot the card in call order, with records persisted and rehydrated like `src/state/present-store.ts`);
  - `apps/desktop/electron/workflows/templates/deep-research.json`;
  - the `<workflow_results>` context hook in `packages/harness` (`canvas-context.ts`-style ledger);
  - `window.__workflows_store` in e2e mode.
- **Depends on:** WP-02, WP-04, WP-05, WP-06.
- **Acceptance:**
  - from a chat: + › Research, type a topic, Enter; the card appears immediately with an estimate and timer;
  - the plan approval edits sub-questions, depth and outputs; Start;
  - research and write progress with a live detail line and favicons;
  - finish shows the docx (and pptx/xlsx if chosen) as present cards opening in the canvas, plus the Sources list;
  - Stop and Resume work;
  - the orange dot shows while approval waits; the blue dot on finish if unviewed;
  - the next user turn carries `<workflow_results>`, sticky and byte-stable.
- **Verify:**
  - e2e `workflows-research-e2e-probe.mjs` (mock pi, mock model server, mock web): drives the menu and asserts every card state, with screenshots of each state in light and dark at 1440 and 900, looked at;
  - `prompt-diff.mjs` over two consecutive turns shows no change in the earlier history;
  - `ttft-probe.mjs` `GAP_MS=0` with a run in progress (the real model, `REAL=1`) stays within one bounded call of baseline;
  - `workflows-research-real-probe.mjs` (`REAL=1`, AC) runs 3 fixed questions and writes a results.md with timings, source counts, verified-quote ratio and citation-check pass rate.

### WP-08 · Image scoring and the improve controller (L)
- **Files:**
  - `packages/workflows/src/steps/improve.ts` (the pure controller), `checklist.ts` (DSG-lite schema and dependency skipping);
  - `apps/desktop/electron/workflows/runners/{image.ts,vision.ts}`;
  - `apps/desktop/electron/gen/gen-manager.ts` (`GenQueueControl.generateImage` / `editImage`);
  - an optional dedicated judge launch modelled on `electron/gen/omnisvg.ts`.
- **Depends on:** WP-01, WP-02, WP-03 (and the vision-by-default work in flight).
- **Acceptance:**
  - the checklist has ≤10 atomic checks with must-haves;
  - scoring by P(yes) when available, else constrained yes/no/unsure;
  - pairwise in both orders only within the tie band;
  - edit, re-prompt or re-seed decided by the model with a near-duplicate prompt guard;
  - **the incumbent is only replaced on a better score**;
  - stops on done, N, plateau, or budget;
  - an honest refusal when nothing can see;
  - every job goes through the guardian's admission.
- **Verify:**
  - vitest with a fake generator and judge: never worse, plateau stop, duplicate-prompt forced to re-seed, `unsure` handling, dependency skipping;
  - a judge-accuracy eval (`REAL=1`) over a small **labelled fixture set** of images with known defects (wrong count, wrong colour, misspelled sign text) created in this WP: report the judge's agreement per check type, and pick batched versus per-check from it;
  - no diffusion is needed to tune the judge (the enhance-probe method: "tune with generation OFF").

### WP-09 · Improve UI: pass strip, studio action, chat card (M). Coordinate with Track 8.
- **Files:** `apps/desktop/src/workflows/PassStrip.tsx`; an Image Studio hook (`src/studio/ImageStudio.tsx`, with the placement owned by Track 8); `WorkflowRunCard` for the improve kind; a Workflows › "Improve an image" entry.
- **Depends on:** WP-08, WP-07.
- **Acceptance:**
  - Improve ×N on a studio result shows a live strip (score rings, kept or discarded, the one-line fault) and ends on the incumbent;
  - the same strip appears in the chat card;
  - Stop works mid-generation (a guardian-safe cancel).
- **Verify:** e2e `improve-card-look.mjs` seeds run records through `__workflows_store` and screenshots each state; a `REAL=1` probe runs 2 passes of FLUX.2 klein at 512² on AC and checks the files, strip and log. Both are looked at.

### WP-10 · Chat and model integration: tool, CLI group, capability, specialists (L)
- **Files:**
  - `packages/harness/src/workflows/workflow-tool.ts` (`workflow_run`, `workflow_list`, `workflow_save`);
  - `packages/harness/src/subagent/bridge-client.ts` (the `workflow` method);
  - `packages/harness/src/tools/tool-cli-groups.ts` (the `workflow` group);
  - `packages/harness/src/presets/capabilities.ts` (`workflows`);
  - `packages/harness/src/corp/corp-mesh.ts` (`specialistToolsFor`: document, research, image);
  - `apps/desktop/electron/pi/subagent-bridge.ts`.
- **Depends on:** WP-02, WP-07.
- **Acceptance:**
  - `workflow run deep-research --topic="…"` from the model starts a run, non-blocking, with its card in that chat;
  - `--wait` blocks and returns the summary and files;
  - `workflow save` opens the editor prefilled (WP-12);
  - the CLI preamble renders from the live map;
  - `cli-coverage.test.ts` includes the new tools;
  - prefix cost is measured.
- **Verify:**
  - harness unit tests for the bridge request shapes and the refusal when the app is absent;
  - `coordinate-cli-probe.mjs`-style `workflow-cli-probe.mjs` runs every `workflow` command through `pi:bash`;
  - `PI_ADV_DEBUG_TOOLCOST` before and after in schemas and CLI modes;
  - `boot-to-instant-probe.mjs` shows no warm-up regression beyond the measured prefix delta.

### WP-11 · Workflows page, editor and templates (L)
- **Files:**
  - `apps/desktop/src/workflows/{WorkflowPage.tsx,WorkflowEditor.tsx,templates.ts}`;
  - `src/scheduled/ScheduledView.tsx`, `shared.tsx`, `RunLedger.tsx` (the row kind, and step lists in runs);
  - `src/chat/SessionSidebar.tsx` (the nav label, pending Q1);
  - the glyph taken from the existing Hugeicons set (`packages/ui` glyph), never drawn.
- **Depends on:** WP-02, WP-07.
- **Acceptance:**
  - list rows for workflows beside scheduled prompts, sorted by attention;
  - the workflow page (Run, Edit, switch, inputs, steps, trigger, runs);
  - the editor dialog: inputs, then steps (add, reorder, remove, knobs), with typed `from` choices and inline validation; Test run; Save;
  - the templates tab lists the 5 templates, hiding any the app cannot do;
  - export and import of the JSON file.
- **Verify:**
  - vitest for the editor reducer and validation copy;
  - e2e `workflows-page-probe.mjs`: create from a template, edit a step, test run (mock), schedule it, see the run in the ledger, export, import, delete;
  - `workflows-design-probe.mjs` screenshots every state in both themes at 1440, 1172 and 900, plus films of open, back and the editor, all looked at;
  - `biome check` clean for the new files.

### WP-12 · Create from a chat, and from a description (M)
- **Files:** `apps/desktop/electron/workflows/drafts.ts` (the trace-to-skeleton mapper and the naming call); the thread ⋯ "Save as workflow…" entry; the editor "Draft the steps" button.
- **Depends on:** WP-10, WP-11.
- **Acceptance:**
  - from a real research-deck session JSONL, the mapper yields research, write, make pptx with a `{{topic}}` input;
  - from "research a market and give me a cited Word brief", the drafted JSON validates against the schema on the first or second try;
  - nothing is saved without the user pressing Save.
- **Verify:**
  - vitest over **recorded session fixtures** (the deep-tasks sessions: research-deck, chart, docx, improve-like edit chains) with snapshot drafts;
  - `REAL=1` drafting from 10 descriptions reports the schema-valid rate;
  - e2e: Save as workflow… opens the editor prefilled (mock).

### WP-13 · Scheduling integration and the unattended policy (S)
- **Files:** `apps/desktop/electron/scheduled/{schedule-logic.ts,scheduled-runner.ts,scheduled-contract.ts}` (the optional `workflow`); `packages/harness/src/scheduled/schedule-tool.ts` (an optional `workflow` field); `electron/bobble-paths.ts` (`bobbleDir('workflows')`); a topic-watch "since last run" in `research.ts`.
- **Depends on:** WP-02, WP-11.
- **Acceptance:**
  - a scheduled workflow fires on time, takes defaults at approvals, never sends messages, writes to `~/Bobble/workflows/<slug>/<date>/`, and appears in both ledgers;
  - existing scheduled prompts are untouched: `schedule-logic.test.ts` and `scheduled-runner.test.ts` are unchanged and green.
- **Verify:** unit tests (`normalizeTask` round-trips `workflow`; the runner branches); the `scheduled-probe.mjs` extension covers a due workflow task (mock) that produces a run record with steps.

### WP-14 · Evaluation sets and real-model runs (M, continuous)
- **Files:** `apps/desktop/tests/eval/workflows/{research-questions.json,rubric.md,score.mjs}`, the image checklist set, `results/`.
- **Depends on:** WP-07, WP-08.
- **Acceptance:**
  - about 20 real research questions (the Anthropic guidance), across fact, comparison, survey and news;
  - deterministic metrics per run: sources read, verified-quote ratio, sentences with citations, unsupported numbers after repair, domain diversity, time, limits count;
  - rubric scores (accuracy, citation accuracy, completeness, source quality) assigned during development by fleet review;
  - A/B thinking on the writing steps; depth presets tuned;
  - image loop: check pass-rate before and after, and judge agreement.
- **Verify:** `REAL=1` on AC only, never in the default chain. Results tables are committed beside the eval (the deep-tasks results.md format).

### WP-15 · Settings, help and docs (S)
- **Files:**
  - `apps/desktop/electron/settings/settings-contract.ts` and `settings-logic.ts`, with new keys `workflows.yieldToChat` (default true), `workflows.defaultDepth`, `workflows.battery` (policy, Q8), `workflows.judge` (`chat-model | dedicated`);
  - the Settings section;
  - the Track 2 "bobble help" knowledge entry;
  - `src/chat/slash-commands.ts` `HELP_TEXT` gets a line.
- **Depends on:** WP-11.
- **Acceptance:** settings persist and take effect on the next run; help explains workflows in one screen.
- **Verify:** unit tests for the settings normalisation; an e2e settings screenshot.

---

## 6. Risks, blockers and open questions

### Risks and blockers

1. **One model slot.** Workflows and chat share the decoder. The yield rule keeps the chat fast, but a user who chats constantly slows a workflow down (the card says so). `--parallel 2` would help but costs KV memory and a server restart. It is a later knob, not v1.
2. **Report depth is capped by the model.** Structure fixes grounding, not insight. A 4B writes serviceable but plain prose. A bigger model for `write` only is a clear knob, and Track 6's LoRA should train on these bounded steps.
3. **Search throttling.** DuckDuckGo challenges heavy fan-out. Mitigations: pacing, a 24 h cache, the existing browser fallback, the Brave and Tavily keys the app already stores, and an optional user-run SearXNG endpoint (AGPL, never bundled). WP-00 measures the real tolerance.
4. **Vision availability.** Vision-by-default is in flight, and the rapid-mlx MTP lane is blind. A relaunch to see costs time, and a dedicated judge costs a download plus memory. The improve loop refuses honestly otherwise.
5. **Memory on 24 GB.** Chat model (~7 GB) plus Qwen-Image (~7.4 GB OS drop) plus an optional judge is tight. It relies on the guardian's admission and pause. A 3-pass quality loop takes ~8–10 min at 1024².
6. **Image re-encoding on every request** (b9934), and **logprobs through `/completion` with images is unverified.** Per-check scoring may be slow. WP-00 decides.
7. **json_schema on MLX engines is unverified.** The fallback path exists but is weaker. WP-00 decides the per-engine strategy.
8. **Battery.** Long runs drained the Mac on 2026-09-23. Heavy scheduled workflows need a power policy (Q8).
9. **Prompt injection from the web.** Contained by design: no tools in page-reading calls, verbatim quote verification, and no sending in unattended runs. The residual risk is low but non-zero for `agent` steps a user points at the web.
10. **Principle tension.** Deterministic orchestration versus "everything is an agent" and prompt pressure. This doc argues it is the user's procedure, not harness machinery, but the user has to bless it (Q2).
11. **Naming collision.** "Workflow" already means ComfyUI graphs in `studio-workflow.ts` and `comfy-workflow.ts`. Hence the distinct schema id (`bobble.workflow/1`) and directories.
12. **Coordination.**
    - Track 10 owns renderer quality (WP-06 must merge with it).
    - Track 8 owns the Image Studio layout (WP-09).
    - Track 2 adds another + menu entry (share `add-menu.tsx` edits).
    - Track 6 can consume workflow step logs as training data (opt-in only).

### Questions for the user

1. **Name and place.**
   - Recommended: rename the "Scheduled" nav to **Workflows** and keep your "Routines | Templates" inside it. A scheduled prompt then shows as a one-step workflow.
   - Alternatively, keep Scheduled and add a separate Workflows item.
2. **The stance.** Do you bless "workflows are the user's procedure, so code sequences the steps and the model does bounded jobs inside them", with chat and corp staying agentic? Or should workflows run as prompted agents?
3. **Plan approval for deep research.** Should it always wait for "Start research" (Gemini), or start immediately with the plan editable mid-run?
4. **When a normal chat message reads like "research X and make me a deck":**
   - run the workflow automatically;
   - show a quiet "Run as Deep research?" suggestion (recommended);
   - or leave it to the chat.
5. **Generated imagery in research decks.** `imagery.py` records your call (stock or procedural, never generated pictures that "illustrate data"). Should a separate "presentation with generated abstract imagery" template exist, or not?
6. **Search.** Keep DuckDuckGo-only by default (no keys, private)? Or suggest a Brave key or a local SearXNG in onboarding for heavier research?
7. **Improve loop defaults.**
   - 3 passes; Fast (klein) or Quality (Qwen-Image) as the default preset?
   - May it judge with the resident chat model (needs Vision on), or should it offer the small dedicated judge (UnifiedReward-2.0-qwen3vl-2b, MIT, 2B) as a download?
8. **Battery.** Should heavy scheduled workflows defer when unplugged (below some %), or run anyway with pacing, like "low power never stops a generation"?
9. **+ menu launch.**
   - Recommended: dispatch directly, with no model turn, so the chat stays free and results reach the model as a context block.
   - Alternatively, route it through the chat model calling `workflow run`.

---

## Appendix: sources

**Workflow systems**
- Anthropic, *Building effective agents*: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, *How we built our multi-agent research system*: https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI Agent Builder: https://developers.openai.com/api/docs/guides/agent-builder
- OpenAI Agent Builder node reference: https://developers.openai.com/api/docs/guides/node-reference
- OpenAI, *Introducing AgentKit*: https://openai.com/index/introducing-agentkit/
- OpenAI workspace agents (help): https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business
- n8n AI Workflow Builder: https://docs.n8n.io/advanced-ai/ai-workflow-builder/
- n8n data pinning: https://docs.n8n.io/data/data-pinning/
- n8n rate limits and retries: https://docs.n8n.io/integrations/builtin/rate-limits/
- Zapier Copilot: https://help.zapier.com/hc/en-us/articles/23503999825421-Build-Zaps-faster-using-AI-powered-Copilot-Beta
- AI by Zapier: https://zapier.com/blog/ai-by-zapier-guide/
- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- LangGraph.js (MIT): https://github.com/langchain-ai/langgraphjs
- Dify parameter extractor: https://docs.dify.ai/en/use-dify/nodes/parameter-extractor
- Dify, workflows as tools: https://dify.ai/blog/dify-ai-blog-workflow-major-update-workflows-as-tools
- ComfyUI workflow metadata: https://docs.comfy.org/development/api-development/workflow-metadata
- Raycast AI Commands: https://manual.raycast.com/ai/ai-commands
- Raycast Dynamic Placeholders: https://manual.raycast.com/dynamic-placeholders
- Apple Shortcuts, Use Model: https://support.apple.com/en-ie/guide/mac-help/mchl91750563/26/mac/26
- MacStories on the Use Model action: https://www.macstories.net/notes/i-have-many-questions-about-apples-updated-foundation-models-and-the-great-use-model-action-in-shortcuts/
- AnythingLLM Agent Flows: https://docs.anythingllm.com/agent-flows/overview

**Deep research**
- OpenAI deep research FAQ: https://help.openai.com/en/articles/10500283-deep-research-faq
- OpenAI deep research API guide: https://developers.openai.com/api/docs/guides/deep-research
- Gemini Deep Research: https://support.google.com/gemini/answer/15719111
- local-deep-researcher (MIT): https://github.com/langchain-ai/local-deep-researcher
- open_deep_research (MIT): https://github.com/langchain-ai/open_deep_research
- GPT Researcher (Apache-2.0): https://github.com/assafelovic/gpt-researcher
- STORM (MIT): https://github.com/stanford-oval/storm
- Local Deep Research (MIT): https://github.com/LearningCircuit/local-deep-research
- Comparison of four open-source deep research agents: https://www.digitalapplied.com/blog/open-source-deep-research-agents-2026-guide
- DeepResearch Bench: https://arxiv.org/abs/2506.11763 and https://deepresearch-bench.github.io/
- ALCE (citation evaluation): https://arxiv.org/abs/2305.14627
- Citation URL hallucination and urlhealth: https://arxiv.org/abs/2604.03173
- Jan-nano model card: https://huggingface.co/Menlo/Jan-nano
- Jan-nano technical report: https://arxiv.org/abs/2506.22760
- SearXNG (AGPL-3.0): https://github.com/searxng/searxng

**Image loops and judges**
- Idea2Img: https://arxiv.org/abs/2310.08541 and https://idea2img.github.io/
- OPT2I: https://arxiv.org/abs/2403.17804
- DSG: https://arxiv.org/abs/2310.18235 and https://github.com/j-min/DSG
- VQAScore: https://arxiv.org/abs/2404.01291 and https://github.com/linzhiqiu/t2v_metrics
- ReflectionFlow: https://arxiv.org/abs/2504.16080
- Inference-time scaling for diffusion models: https://arxiv.org/abs/2501.09732
- Performance plateaus without external models: https://arxiv.org/abs/2506.12633
- Position bias in multi-image VLMs: https://www.researchgate.net/publication/394593412_Identifying_and_Mitigating_Position_Bias_of_Multi-image_Vision-Language_Models
- UnifiedReward-2.0-qwen3vl-2b: https://huggingface.co/CodeGoat24/UnifiedReward-2.0-qwen3vl-2b and https://github.com/CodeGoat24/UnifiedReward
- HPSv3: https://github.com/MizzenAI/HPSv3 and https://arxiv.org/abs/2508.03789

**Structured output**
- JSONSchemaBench: https://arxiv.org/abs/2501.10868
- *Let Me Speak Freely?*: https://arxiv.org/abs/2408.02442
- llama.cpp server README: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

**In-repo references**

The memory notes: `pi-desktop-scheduled-simplified`, `pi-desktop-agent-mesh`, `pi-desktop-single-ceo-delegation`, `pi-desktop-child-agents`, `pi-desktop-office-pipeline`, `pi-desktop-studios-and-enhancer`, `pi-desktop-qwen-image-21`, `pi-desktop-deep-tasks-2026-09-16`, `pi-desktop-long-task-completion`, `user-prompt-pressure-not-enforcement`, `pi-desktop-roles-in-harness`, `pi-desktop-prompt-cache-truth`, `pi-desktop-ttft-regression`, `pi-desktop-slot-ownership`, `pi-desktop-latency-harness`, `pi-desktop-calibration-engines`, `pi-desktop-guardian`, `pi-desktop-memory-guard`, `pi-desktop-inline-data-visuals`, `pi-desktop-grammar-coercion`, `pi-desktop-prompt-prefix-cost`.

Plus `roadmap.md` item 3 and `corp-benchmarks.md` §2 (Research deck).
