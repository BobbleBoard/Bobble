# Track 1 — Long-term memory via Hindsight + a Memory tab

Research doc, 2026-09-23. Base commit `c9fe7098`. Research only: no code changed, nothing installed, no model run.
Numbers marked **MEASURED** were produced for this doc (dependency resolution against PyPI, file sizes from the Hugging Face API). Everything else is either quoted from a primary source (linked) or marked *estimate*.

---

## 1. Goal

the user, verbatim: *"memory (hindsight) integration, one click turn this on and off in settings, Memory tab in settings, uses Hindsight https://github.com/vectorize-io/hindsight"*.

Restated precisely:

1. Bobble gains **long-term memory across chats**: facts about the person and their work are learned from conversations and brought back in later chats.
2. The memory engine is **Hindsight** (vectorize-io), run **locally and offline**, installed and managed by the app. Nobody installs Python, Docker or Postgres by hand.
3. **One click on/off** in Settings. Off means no learning, no recall and no memory process running.
4. A **Memory tab in Settings** shows what is remembered and lets the person forget items, forget everything, export and see status.
5. It must not slow Bobble down. The single llama-server slot, the frozen system prompt, the warmed prefix and the prime/turn alignment are the project's hardest-won properties (memory notes `pi-desktop-ttft-regression`, `pi-desktop-prompt-cache-truth`, `pi-desktop-slot-ownership`, `user-always-check-prefill`). Memory must be designed around them.

---

## 2. What exists today

### 2.1 Memory in the app: none that is live

| Thing | Where | State |
|---|---|---|
| RemotePi-era RAG memory extension (`remember`/`recall` tools, SQLite and cosine search over a remote embed URL) | `~/.pi/agent/extensions/rag-memory.ts`, DB `~/.pi/agent/memory.db` (table `memories(id,text,tags,vec,created)`) | **Dormant.** Bobble spawns pi with `--no-extensions` (`apps/desktop/electron/pi/pi-main.ts`, `extraArgs: ['--no-extensions', '--no-skills']`), so auto-discovered extensions never load. The DB has **0 rows** (checked read-only). Leave it alone. |
| MCP "Memory" knowledge-graph connector (`npx -y @modelcontextprotocol/server-memory`) | catalog entry `packages/mcp-lite/src/detect-apps.ts:192`; example prompt `apps/desktop/src/connectors/model.ts:454` | Optional connector in Extensions, off by default. It is a different thing: the model must call its tools, and it has no automatic recall or learning. |
| Custom instructions ("things to remember") | `settings.customInstructions`, wrapped in `<user-instructions>` and prepended to the FIRST prompt of each new session by `apps/desktop/src/state/pi-connect.ts` (~L99–135) | Static text the person writes. Memory complements it and must not replace it. |
| Chat transcripts | `~/.pi/agent/sessions/**.jsonl` | The raw material for learning, and a possible backfill source (WP-M12). |

The app has no automatic recall, no learning from chats and no Memory UI.

### 2.2 The seams memory plugs into

**Harness turn hooks.** pi 0.68.1, `@mariozechner/pi-coding-agent`. Types are in `dist/core/extensions/types.d.ts`.
- `before_agent_start(event{prompt, images, systemPrompt}) → {systemPrompt?, message?}`. pi runs **every extension's** handler in load order. Returned `message`s are **collected from all extensions** (`ExtensionRunner.emitBeforeAgentStart`, `dist/core/extensions/runner.js:585`) and pushed **after the user's message** as `role: "custom"` entries (`dist/core/agent-session.js` ~L744–770). `convertToLlm` renders a custom message as a **user-role message** (`dist/core/messages.js:89`). They are persisted in the session JSONL.
- The harness already uses exactly this for the workspace note: `HARNESS_WORKSPACE_NOTE` (`packages/harness/src/index.ts:866`) is returned from `before_agent_start` (~L3310–3436) as `{customType, content, display:false}`. The comment there explains why: *"A note beside the user's message says the same truth for ~30 tokens, persists in the conversation, and leaves the prefix alone."*
- `agent_end(event{messages})` (~L3481): post-turn work (naming, reviewer) waits `POST_TURN_DELAY_MS` and is aborted in `before_agent_start` (`postTurnTimer`, `postTurnWork.abort()`). This is the "the user outranks everything behind them" rule.
- `session_start` resets per-session state. **pi re-imports the extension per session** (`pi-desktop-slot-ownership`), so state that must outlive a session lives on `globalThis`/`Symbol.for`, or is rebuilt from `ctx.sessionManager.getEntries()`.
- The canonical system prompt is **frozen per session** and warmed together with the tools (`maybeWarmPrefix`, `canonicalPrompt`). With Qwen/Gemma templates, anything that changes the system text moves everything after it, including the ~5–9k tokens of tool schemas.

**Extension loading.** `apps/desktop/electron/pi/extension-dirs.ts` `BASE_EXTENSION_PACKAGE_DIRS` (provider-llamacpp, provider-afm, provider-mlx, harness, web-tools, browser-use, mac-connectors, mac-computer-use, mcp-lite, and gen-tools). Each dir resolves to `packages/<dir>/src/index.ts` and loads from **source** via `-e`, so a harness-side change needs no rebuild (`pi-desktop-worktrees-and-build`). `toolExtensionPackageDirs()` gives subagents the same set.

**Tool surface.** Tool-CLI mode is the **default** (`DEFAULT_SETTINGS.toolInterface = 'bash-cli'`, `apps/desktop/electron/settings/settings-logic.ts`). Every registered tool becomes a command through `registerToolCli` (`packages/harness/src/tools/tool-cli-bridge.ts:458`), grouped by `CAPABILITIES` (`packages/harness/src/presets/capabilities.ts`). A new `memory` capability gives `memory recall|remember|forget` at the cost of one group name in the preamble. In schema mode those tools sit behind `capability`/`use` and cost no prompt.

**The model endpoint for background work.** `getInferenceUtility()` / `utilityStateFilePath()` (`apps/desktop/electron/inference/llm-main.ts`, file `userData/utility-endpoint.json`) is **the same resident chat server**, not a separate utility model. `buildPiEnv()` hands it to pi as `PI_DESKTOP_UTILITY_BASE_URL`, plus the live `PI_DESKTOP_UTILITY_FILE`. llama-server runs one decoding slot; host-RAM prompt cache is on by default (`--cache-ram 8192`, `--cache-idle-slots`, documented in `packages/inference/src/supervisor.ts:166`).

**Settings.** `apps/desktop/electron/settings/settings-contract.ts` (`DesktopSettings`, `DesktopSettingsPatch`, `settings:get|set`), `settings-logic.ts` (`DEFAULT_SETTINGS`, `clampSettings`, `mergeSettingsPatch`) and `settings-main.ts` (writes `~/.pi/desktop/settings.json` 0600, fenced under `PI_E2E`; side-effect seams such as `onPowerSettingsChanged` / `onEngineLaunchChanged`). UI: `apps/desktop/src/settings/SettingsView.tsx` (union `SettingsSection`, `NAV`, `TITLES`, `SectionBody`), panels in `apps/desktop/src/settings/panels/*.tsx`, and vocabulary in `apps/desktop/src/settings/parts.tsx` (`SettingSection`, `SettingRow`, `SettingGroup`) plus `SegmentedControl` from `@pi-desktop/ui` (see `ComputerUsePanel.tsx`, `ExperimentalPanel.tsx`).

**Managed Python runtimes.** `apps/desktop/electron/inference/engines-main.ts` uses `ensureUv()` from `@pi-desktop/web-tools`, then `uv venv <root> --python 3.12` and `uv pip install --python <venv> …` under `cacheRoot()` (`~/.cache/bobble`). The gen-module card pattern ("Download · 1.5 GB", progress from uv's own lines, ready markers) is in `apps/desktop/electron/gen/gen-modules.ts` / `gen-modules-main.ts`. Model files go through `downloadRepo()` (`packages/model-store/src/download-repo.ts`: resumable, sha-verified, mirror-aware) into the library `~/Bobble/Models/<shelf>`.

**Process hygiene.** `reapChildProcesses()` (`apps/desktop/electron/main.ts:606`) reaps non-pi children at quit. `guardRun(Pausable)` (`apps/desktop/electron/gen/guardian-main.ts:56`, `kind: 'gen'|'gen3d'|'agent'`) puts a process tree under the memory guard (pause, resume, terminate). Battery state is sampled in `packages/inference/src/pressure.ts` (`onBattery` via `pmset -g ps`).

**Chat activity in main.** `apps/desktop/electron/pi/pi-sessions.ts` sees every pi event (`agent_end` handling at ~L252) and has `onUserPrompt` (~L327). `child-agents.ts` sees subagent turns. `prefill-main.ts` handles the composer's predictive prefill. Together they are everything a "the person is using the model right now" signal needs.

**Rendering.** `packages/engine/src/renderer/rehydrate.ts:93` skips custom messages ("context plumbing, not chat rows"). A memory note is therefore invisible by default, and a "used memories" chip needs a small mapping.

**Probes that settle latency questions** (all present in `apps/desktop/tests/e2e/`): `ttft-probe.mjs`, `ttft-slots-probe.mjs`, `prefill-exactness-probe.mjs`, `prefill-divergence-probe.mjs`, `prompt-diff.mjs`, `multi-conversation-kv-probe.mjs`, `kv-eviction-probe.mjs`, `boot-to-instant-probe.mjs`, `real-send-probe.mjs`, and the launcher `harness.mjs` (`launchApp(name, {realCache, env})`: throwaway HOME, hidden window, focus guard). Wire tap: `PI_DIAG_PROMPTS=<file>` (`packages/provider-llamacpp/src/request-tap.ts`).

### 2.3 What is missing

A memory runtime; its installer and supervisor; a way for a *second* process (Hindsight) to use the model without stealing the slot; recall injection that respects the frozen prefix; turn capture; tools; settings keys; IPC; the Memory tab; chat affordances ("used 3 memories", temporary chat); storage accounting; tests and probes.

---

## 3. External research — Hindsight

### 3.1 What it is

- **Hindsight — "Agent Memory That Learns"** by Vectorize. Repo: <https://github.com/vectorize-io/hindsight>. **MIT** license, 26.5k stars, last push 2026-09-23 (GitHub API). Latest release **v0.10.1, 2026-09-21**. A release comes every 1–2 weeks: v0.8.4 on 07-01, then 0.8.5, 0.8.6, 0.9.0, 0.9.1, 0.9.2, 0.10.0 and 0.10.1 on 09-21. That is eight releases in about twelve weeks.
- Paper: *Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects*, arXiv [2512.12818](https://arxiv.org/abs/2512.12818), also an [ACL 2026 demo](https://aclanthology.org/2026.acl-demo.27/). With an open 20B backbone, LongMemEval accuracy rises from 39% (full-context baseline) to 83.6%, and to 91.4% with a larger backbone.
- **Model:** memories live in **banks**. Facts are typed **world** (about people, places and things, *including the user's preferences*) or **experience** (what the agent itself did). **Observations** are consolidated beliefs synthesised from many facts. **Mental models** and knowledge pages are optional synthesis layers on top. Entities are resolved, and facts are linked by entity, time, meaning and cause ([retain doc](https://hindsight.vectorize.io/developer/retain)).

### 3.2 The three operations and what each costs

| Operation | What it does | Uses the LLM? | Documented latency ([performance](https://hindsight.vectorize.io/developer/performance)) |
|---|---|---|---|
| **retain** `POST /v1/default/banks/{bank}/memories` | LLM fact extraction per chunk (who/what/when/where/why, entities, dates, causal links), then embedding, entity resolution and graph links. `async:true` queues it. **Consolidation** (observations) runs after it in the background. | **Yes, heavily.** | 500–2000 ms per batch on cloud models. The [Ollama guide](https://hindsight.vectorize.io/blog/2026/03/10/run-hindsight-with-ollama) reports **15–20 s per retain call on Apple Silicon** with gpt-oss-20b. |
| **recall** `POST …/memories/recall` | Four arms in parallel (semantic pgvector, BM25, entity/link graph, temporal), fused with RRF, then a cross-encoder **reranker**. | **No.** Pure local search. | **100–600 ms**; the bottleneck is the reranker on CPU. |
| **reflect** `POST …/reflect` | Agentic tool loop over memories that writes an answer. Needs tool calling. | Yes. | 800–3000 ms on cloud models. |

Retain is costly and happens off the critical path. Recall is cheap and needs no model. That split is what makes Hindsight usable next to a single local model: **the chat turn only ever needs recall.**

### 3.3 Runtime, packaging, storage

- **Python ≥ 3.11**, FastAPI/uvicorn. Entry point `hindsight-api` (`--host`, `--port`; SIGTERM handler stops embedded Postgres, see `hindsight_api/main.py`).
- **Defaults to know** (source: `hindsight-api-slim/hindsight_api/config.py` at tag v0.10.1; every env var named in §4.6 was checked to exist at that tag):
  - `DEFAULT_HOST = "0.0.0.0"`. **Bobble must set `HINDSIGHT_API_HOST=127.0.0.1`.** Otherwise memories are exposed to the LAN and macOS may show a firewall dialog.
  - `DEFAULT_PORT = 8888`, `DEFAULT_WORKERS = 1`, `DEFAULT_DATABASE_URL = "pg0"`.
  - Embeddings `local` = sentence-transformers `BAAI/bge-small-en-v1.5` (384-d).
  - Reranker `local` = `cross-encoder/ms-marco-MiniLM-L-6-v2`.
  - LLM `openai` / `gpt-4o-mini`; `DEFAULT_LLM_MAX_CONCURRENT = 32`; `DEFAULT_LLM_TIMEOUT = 120`.
  - `DEFAULT_RETAIN_MAX_COMPLETION_TOKENS = 64000`, `DEFAULT_RETAIN_CHUNK_SIZE = 3000` (chars).
  - `DEFAULT_ENABLE_OBSERVATIONS = True`, `DEFAULT_ENABLE_AUTO_CONSOLIDATION = True`.
  - Embedded worker on, polling the DB every **500 ms**; `DEFAULT_MCP_ENABLED = True`.
  - No telemetry setting exists (OpenTelemetry only if configured).
- **Packages** (manifests in the repo):
  - `hindsight-api` = `hindsight-api-slim[all]`, which adds torch, sentence-transformers, transformers, flashrank, mlx and mlx-lm, onnxruntime and pg0.
  - `hindsight-api-slim` extras: `local-onnx` (onnxruntime + transformers tokenizers, **no torch**), `embedded-db` (`pg0-embedded`), `local-llm` (llama-cpp-python), `local-ml` (torch path).
  - `hindsight-embed` is a small CLI that daemonizes `uvx hindsight-api@<ver>`.
  - `@vectorize-io/hindsight-all` (npm) is a lifecycle wrapper around `uvx hindsight-embed@latest` that **forces CPU embeddings on macOS**.
  - `@vectorize-io/hindsight-client` (npm, MIT, **zero dependencies**, 1.8 MB unpacked).
- **Database:** PostgreSQL + pgvector. **pg0** ([repo](https://github.com/vectorize-io/pg0), [PyPI](https://pypi.org/project/pg0-embedded/) 0.15.2, 2026-09-14) is a single binary bundling **PostgreSQL 18 + pgvector 0.8.5**. It extracts to `~/.pg0/installation/` on first start and keeps data in `~/.pg0/instances/<name>/data`, or a custom `--data-dir`. It needs nothing installed on macOS. Default `shared_buffers=256MB`. Hindsight's URL form `pg0://user:pwd@instance:port` has **no data-dir option**, but the pg0 Python SDK accepts `data_dir`.
- **Local models with no torch:**
  - ONNX embedder (`HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx`), defaulting to `intfloat/multilingual-e5-small`. It takes `…_ONNX_MODEL_PATH` and `…_ONNX_TOKENIZER_NAME_OR_PATH` for fully local files, runs on CPU EP only, and disables the memory arena to bound RSS (`engine/embeddings.py`).
  - Reranker `flashrank` (ONNX; `HINDSIGHT_API_RERANKER_FLASHRANK_MODEL`, `…_CACHE_DIR`), or `rrf` (no neural reranking), or `jina-mlx` (Apple-Silicon MLX, heavier).
- **Offline:**
  - Point the LLM at any OpenAI-compatible server: provider `openai`/`lmstudio` plus `HINDSIGHT_API_LLM_BASE_URL`.
  - Use local ONNX files with `HF_HUB_OFFLINE=1`.
  - pg0 is bundled and needs no download.
  - The tokenizer (`toktok-rs`) ships its vocabularies in the wheel.
  - **One trap:** Hindsight imports litellm, which downloads its price map from raw.githubusercontent.com **at import** unless `LITELLM_LOCAL_MODEL_COST_MAP=True` ([litellm docs](https://docs.litellm.ai/docs/proxy/custom_model_cost_map)). Without it, an offline start waits on a 5 s timeout.
- **Security:**
  - Default tenant = no auth. The built-in `ApiKeyTenantExtension` (`HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension`, `HINDSIGHT_API_TENANT_API_KEY=…`) makes other local processes unable to read memories through the port.
  - **Memory Defense** ([doc](https://hindsight.vectorize.io/developer/memory-defense)) redacts 45 secret/PII patterns on retain. It is per bank and **off by default**; enable with `{"memory_defense":{"enabled":true,"rules":[{"on":"sensitive_data","action":"redact"}]}}`.
- **Curation and privacy API** ([memories API](https://hindsight.vectorize.io/developer/api/memories)):
  - `GET …/memories/list` (filters `type`, `q`, `document_id`, `entity_id`, `state`, time window).
  - `PATCH …/memories/{id}` edits, **invalidates** (soft, reversible, row archived) or restores.
  - `DELETE …/documents/{id}` removes a source and its facts. `DELETE …/memories` clears a bank. `DELETE /v1/default/banks/{bank}` deletes the bank.
  - `POST …/transfer/export|import` (async bank archive).
  - Also `…/stats`, `…/entities`, `…/operations` (async queue status, retry, cancel) and `…/llm-requests` (LLM traces).
- **Retain details that shape the design:**
  - Items carry `content`, `timestamp` (anchors "yesterday"), `context` (who is speaking; this decides world vs experience), `document_id`, `update_mode: "replace"|"append"`, `tags`, `metadata` and an idempotent client `operation_id`.
  - **Delta retain** rewrites only the chunks that changed (`engine/retain/orchestrator.py`, `attempts_delta_retain`). A growing chat can be one document appended to without re-extracting it all.
  - A **retain mission** and **custom extraction mode** steer what is kept ([retain doc](https://hindsight.vectorize.io/developer/retain)).
- **Recall details:**
  - `budget: low|mid|high` sets candidate depth (fixed 100/300/1000); `max_tokens` bounds the output.
  - `types`, `prefer_observations`, `tags` + `tags_match`, `query_timestamp`, `include.entities` (set null to skip), `min_scores`.
  - Each result carries `id, text, type, document_id, mentioned_at, tags, scores`.

### 3.4 Small and local models: what upstream says and what bit people

- Upstream on local setups ([performance → Tuning for Local & Small Environments](https://hindsight.vectorize.io/developer/performance)):
  - Set `HINDSIGHT_API_LLM_MAX_CONCURRENT` to 1–2, because otherwise Hindsight *"will fill every slot and starve any other client sharing the endpoint (your main agent…)"*.
  - Raise the timeout.
  - Turn thinking off (`HINDSIGHT_API_LLM_REASONING_EFFORT=none` where supported).
  - `HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=2`.
  - Rerank fewer candidates (`HINDSIGHT_API_RERANKER_MAX_CANDIDATES=100`), or use `flashrank`.
- [Models page](https://hindsight.vectorize.io/developer/models): other models *"must support at least 65,000 output tokens"*, or you lower `HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS`, which must stay above `…_RETAIN_CHUNK_SIZE`. The tested list is all cloud models plus gpt-oss-20b/120b. The built-in `llamacpp` provider auto-downloads **Gemma 4 E2B** (~3.5 GB).
- **Known small-model failure:** [issue #4280](https://github.com/vectorize-io/hindsight/issues/4280). With a 2.5B-active model on llama.cpp, the *concise* prompt's few-shot examples leaked into memory as fabricated facts ("Emily married Sarah at rooftop garden"): 132 bogus facts, about 2% of a bank, and about 14% of documents affected. It was fixed by a prompt guard in [PR #4284](https://github.com/vectorize-io/hindsight/pull/4284). **The guard text is present at tag v0.10.1 and absent at v0.10.0** (checked in the file at each tag). The PR says it *"does not … eliminate stochastic hallucinations"*. The reporter's validated fallback is `retain_extraction_mode: "custom"`, which sends no examples.
- Hindsight's own **pi integration** exists (`hindsight-integrations/coding-agents/src/harness/pi-extension.ts`). It **appends its injection to the system prompt on every turn** (`return { systemPrompt: \`${event.systemPrompt}\n\n${injection}\` }`) and defaults to `autoInject: "reflect"`, an LLM call before the first prompt. Both are what Bobble's TTFT work removed from its own harness (see §4.3), so **its approach cannot be reused**. It also installs through `~/.pi/agent/settings.json`, which Bobble ignores (`--no-extensions`). Its README does confirm the useful precedent: inject **once, on the session's first prompt**, and the retrieval-only `"recall"` mode *"stays well inside the hook window"*.

### 3.5 Install footprint and platforms — MEASURED by resolution

Environment: `uv pip compile --only-binary :all: --python-version 3.12`. This resolves wheels only, so a successful resolve means **no compiler, Rust or Xcode is needed**. Sizes are the compressed wheels, summed from PyPI JSON.

| Target (Python 3.12) | Set | Result |
|---|---|---|
| **macOS 14+ arm64** | `hindsight-api-slim[local-onnx,embedded-db]==0.10.1` + `flashrank` | ✅ **187 packages, 292 MB download**. Biggest: claude-agent-sdk 92 MB (bundles a CLI; a base dependency), onnxruntime 21.5, litellm 16.7 (the pure-python 1.91.x pin upstream added for macOS), botocore 15.9, magika 13.4, pg0 13.0, numpy 12.0, transformers 11.7, pandas 10.1. |
| macOS 14+ arm64 | `hindsight-api==0.10.1` (full, torch) | ✅ 205 packages, **513 MB**. Adds torch 127 MB, mlx-metal 42.5, scipy 28.7 and scikit-learn. |
| macOS **13** arm64 | slim set | ❌ `pg0-embedded` publishes only `macosx_14_0_arm64` wheels. |
| macOS **Intel** | slim set | ❌ `cryptography>=50` (a Hindsight floor) has no usable x86_64 macOS wheel, so it would need a Rust build. |
| Linux x86_64 / aarch64, glibc ≥ 2.35 | slim set | ✅ 189 packages. |
| Windows x64 | slim set | ✅ 191 packages. |

*Estimates*: installed size about 0.9–1.1 GB (typical unpack ratio). Resident RAM about 0.35–0.6 GB for the API process with ONNX models, plus about 0.1–0.3 GB for Postgres. The full torch build is roughly 1 GB more RAM. **To be measured in WP-M0.**

Local model files (Hugging Face API, **MEASURED**):

| Model | File | Size | License |
|---|---|---|---|
| multilingual-e5-small (384-d, ~100 languages) | `intfloat/…/onnx/model.onnx` | 470 MB | MIT |
| | `Xenova/…/onnx/model_int8.onnx` | **118 MB** | MIT |
| bge-small-en-v1.5 (384-d, English only) | `BAAI/…/onnx/model.onnx` | 133 MB | MIT |
| FlashRank `ms-marco-MiniLM-L-12-v2` | `prithivida/flashrank` zip | **22.7 MB** | model card cc-by-sa-4.0; flashrank library Apache-2.0 |
| FlashRank `ms-marco-TinyBERT-L-2-v2` | zip | 3.4 MB | same |

### 3.6 What this means for Bobble

1. **It can run fully offline on a stock Apple-Silicon Mac (macOS 14+) with no developer tools.** Use the slim build: ONNX embeddings, FlashRank, pg0, CPython 3.12 from our pinned uv. That is about 0.3 GB of wheels plus about 0.14 GB of models.
2. **Recall fits the turn path; retain does not.** Recall is model-free and about 0.1–0.6 s of CPU. Retain and consolidation make many model calls. On Bobble's one-slot server they would **hold the slot** (the exact regression in `pi-desktop-ttft-regression`) unless something outside Hindsight decides *when* they run.
3. **Do not use Hindsight's built-in llama.cpp model** (a second ~3.5 GB model on 24 GB) or the torch build. Use the model Bobble already serves, but only when the person is not using it.
4. **Do not use the upstream pi integration or reflect-on-prompt.** Recall only, placed where the prefix cache survives.
5. **Pin v0.10.1 or later.** It has the few-shot guard, and we use `custom` extraction mode anyway for ≤10B models.
6. Everything Bobble needs for the Memory tab (list, search, forget, restore, export, stats, entities, operation status) is already in the API.

---

## 4. Design

### 4.1 Shape

```
Renderer ─ Settings → Memory tab ─ chat "Remembered 3 things" chip ─ + menu "Temporary chat"
   │ IPC memory:* (invoke)                         ▲ memory:state (event)
   ▼                                               │
Electron main  apps/desktop/electron/memory/
   memory-main.ts ──────────────────────────────────┘
   ├─ memory-install.ts   uv venv (pinned lock) + e5-small ONNX + FlashRank → ready marker
   ├─ memory-service.ts   pg0 (Postgres 18+pgvector, 127.0.0.1:<pg>, data ~/.pi/desktop/memory/db)
   │                      hindsight-api (127.0.0.1:<hs>, tenant key, env block §4.6)
   ├─ llm-gate.ts         127.0.0.1:<gate>/v1  ← Hindsight's only LLM route
   │     holds while the person is active, preempts on pi:prompt / pi:prefill / gen job,
   │     forwards at idle to the LIVE chat endpoint (getInferenceUtility()), thinking off
   ├─ outbox.ts           finished turns → retain(async, append) when idle
   └─ writes userData/memory-endpoint.json  {enabled, recall:{url,key,bank}, turnUrl, token, excluded[]}
                                   │ (live file, re-read per turn, like utility-endpoint.json)
pi child (each chat)               ▼
   packages/memory (new pi extension, loaded after harness)
   ├─ before_agent_start → recall (≤350 ms) → custom message <memory> AFTER the user message (display:false)
   ├─ agent_end          → POST turn to main's outbox (never to the model)
   └─ tools memory_recall | memory_remember | memory_forget  (CLI: `memory recall "…"`)
```

**One rule governs it.** The chat turn only ever *reads* memory. All *writing* that needs the model happens behind a gate the person always outranks.

### 4.2 Why the LLM gate exists and what it does

Hindsight issues its own model calls from its own worker: retain extraction, consolidation, optional mental-model refresh. Bobble cannot cancel them from inside Hindsight. The harness's `postTurnWork.abort()` only covers the harness's own calls. So Hindsight must reach the model **only through a proxy Bobble owns**:

- **Route.** `HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:<gate>/v1`, with a per-launch bearer token passed as `HINDSIGHT_API_LLM_API_KEY`. The gate forwards to whatever `getInferenceUtility()` says **right now**. That fixes the stale spawn-time endpoint problem the utility file already fixed for pi. It rewrites `model` to the served id (`<id>@<engine>` for MLX).
- **Hold.** A request is held while any chat turn, subagent, corp role or scheduled run is in flight (pi events in `pi-sessions.ts` / `child-agents.ts`), while a composer prime is in flight (`prefill-main.ts`), while a generation job runs, and until **N s of quiet** (default 45 s; the harness's own post-turn work fires 2.5 s after `agent_end`). It is also held when no model is loaded. Bobble **never loads a model for memory's sake**.
- **Preempt.** `onUserPrompt` (`pi-sessions.ts`) and `pi:prefill` call `gate.preempt()`, which closes the upstream socket. The gate sends upstream as **`stream:true`** even when Hindsight asked for non-stream, so cancel-on-disconnect is guaranteed. It then re-queues the same request and replays it at the next idle. Hindsight only sees a slow response, so set `HINDSIGHT_API_LLM_TIMEOUT` high (1800 s) and `LLM_MAX_CONCURRENT=1`.
- **Shape.**
  - Inject `chat_template_kwargs {enable_thinking:false}` (belt and braces with `HINDSIGHT_API_LLM_EXTRA_BODY`).
  - Cap `max_tokens`.
  - Keep `cache_prompt` (Hindsight's extraction prefix is fixed, so it caches too).
  - Structured output: pass `json_schema` through on llama.cpp (grammar-enforced, strong for a 4B). For engines without it, fold the schema into the system message, which is Hindsight's own "soft" path.
- **Budget.** Learn on battery only when plugged in or above a threshold (setting). Offer a manual "Pause learning" button. Count model-seconds per hour so the Memory tab can say what it used.
- **Why not the alternatives.** A second slot conflicts with MTP (`-np>1` is illegal with the MTP launch mode, `project-pi-desktop`) and halves context. A second model server costs RAM on 24 GB. Letting Hindsight call llama-server directly is the documented TTFT killer: *"There is ONE slot: while any background call is on it the user's next message queues."*

### 4.3 Recall: prefix-safe by construction

- **Where.** A pi `before_agent_start` handler in the new `packages/memory` extension returns `message: {customType: 'bobble-memory', content, display:false, details:{ids, items}}`. pi appends it **after** the user's message. It is persisted, so every later turn re-sends the same bytes and the history stays byte-identical (the lesson of the `<canvas_state>` fix, `pi-desktop-prompt-cache-truth` cause 1).
- **Never the system prompt.** Nothing per turn goes into the system prompt. The frozen canonical prompt and warm-up are untouched. The only static effect is the `memory` group name in the CLI preamble, which the harness warms along with everything else because the tools register before the first warm-up.
- **Suffix, not prefix.** The composer's prime covers `[system, …history, user-text-prefix]`. A block **after** the user text leaves the prime a true prefix. A block *before* it would diverge at the first user token and waste the prime. Titler and reviewer reuse `residentConversation` (captured wire bytes), so they include the block automatically.
- **Budget.**
  - Turn 1 of a chat: `budget:"low"`, `max_tokens:350`, `types:["observation","world","experience"]`, `prefer_observations:true`, `include:{entities:null}`, `query_timestamp:now`. At most about 8 facts.
  - Later turns: only facts **not already injected in this chat** (ids rebuilt from session entries, since pi re-imports the extension per session), at most 4, and nothing below a score floor.
  - Always drop facts whose `document_id` is **this** chat, because they are already in context.
  - Skip filler messages and turns whose text is only an attachment.
  - Query = the user's text minus the `<user-instructions>` preamble and file bodies, capped at 1,500 chars (Hindsight's `RECALL_MAX_QUERY_TOKENS` is 500).
- **Deadline.** 350 ms (tunable after WP-M0). Past it the turn goes out **without** memory. This is logged, never retried inline. Target is ≤150 ms p50 on 1k facts; the new tokens cost about 0.1–0.2 s of prefill at llama.cpp's ~1.3k tok/s (`pi-desktop-calibration-engines`).
- **Off means off.** No HTTP call when memory is disabled. The live file says so, and there is no socket probe.
- **Framing for small models** (the canvas_state lesson, where a status block read as the user speaking):

  ```
  <memory>
  Automatic memory lookup for this message — not something the user just said. Use only what is relevant; don't announce it.
  - The user prefers answers without emojis. (about the user · Sep 20)
  - You made q3-report.docx for The user in ~/Bobble/q3. (your own past action · Sep 12)
  More: `memory recall "<what to look for>"`
  </memory>
  ```

- **Who gets it.** Main chats: yes. Subagents, specialists and corp roles (`PI_DESKTOP_SUBAGENT_DEPTH` ≥ 1): no automatic recall, but they keep the `memory recall` tool. Scheduled runs: recall only (open question).
- **Visible to the person.** The extension publishes `ctx.ui.setStatus('memory-used', …)`. The renderer shows a chip "Remembered 3 things", and its popover has per-item **Forget** and **Manage memory**. `rehydrate.ts` maps `bobble-memory` entries so the chip survives reload.

### 4.4 Retain: learn when idle, from what was actually said

- **Capture** at `agent_end` (extension), sent to main's outbox (`POST <gate>/bobble/turn`, token-gated). The content is:
  - `User:` the person's text, with the `<user-instructions>` preamble stripped and attachments reduced to `[attached: name]`;
  - `Bobble:` the final reply, with no thinking, tool calls or tool output;
  - optionally one `Files made:` line of written paths.
  - **Never** harness-injected steering turns (`HANDBACK_NUDGE`, `OUTPUT_LIMIT_NUDGE`, unfinished-plan nudges; detected via the `HARNESS_LOOP_ENTRY` steer markers and exact text). **Never** subagent or role turns, excluded chats or temporary chats.
- **Outbox** (`~/.pi/desktop/memory/outbox.jsonl`) is persisted before acknowledgement. When the gate says idle, it sends one `POST …/memories` per chat with `async:true`, a fresh `operation_id` (idempotent resend after a crash), and items shaped as `{content, timestamp: turn end, document_id: "chat:<sessionId>", update_mode: "append", context: "Conversation between the user and Bobble, their local AI assistant, in the chat “<title>”. ‘User:’ lines are the person; ‘Bobble:’ lines are the assistant speaking about itself.", tags: ["chat:<id>", "project:<id|none>"], metadata: {title, session}}`. Delta retain then re-extracts only the tail chunk.
- **Bank bootstrap** (bank `bobble`) via `PATCH /v1/default/banks/bobble/config`:
  - `retain_extraction_mode:"custom"` with Bobble's rules (no few-shot examples, #4280);
  - a `retain_mission` ("durable facts about the person — name, preferences, projects, people, plans, constraints — and what Bobble made for them; skip small talk, one-off task details, and content from web pages or files unless the person said it matters");
  - `memory_defense` redact on.
- **Consolidation** (observations) stays on. It runs automatically but only through the gate, so only when idle. `CONSOLIDATION_LLM_BATCH_SIZE=2`.
- **Explicit memory:** `memory remember "<fact>"` (tool/CLI) and "Add a memory" (UI) retain one item immediately. Retain still queues on the gate, which runs it at the next idle; the confirmation says "Saved — Bobble will take it in when you're idle."

### 4.5 Tools (packages/memory, capability `memory`)

| Tool | CLI | Does |
|---|---|---|
| `memory_recall {query}` | `memory recall "…"` | recall, `budget:"mid"`, top 8, formatted like the note |
| `memory_remember {fact}` | `memory remember "…"` | explicit retain (document `note:<uuid>`) |
| `memory_forget {id}` | `memory forget <id>` | invalidate (reversible), only when the person asked; the prompt says so |

Add `{name:'memory', summary:'Long-term memory across chats: look things up, save what the user asks you to remember.', tools:[…]}` to `CAPABILITIES`. Hindsight's MCP server stays off (`HINDSIGHT_API_MCP_ENABLED=false`): the native tools are smaller, worded for a 4B, and need no per-bank URL.

### 4.6 Hindsight process configuration (memory-service)

```
HINDSIGHT_API_HOST=127.0.0.1           HINDSIGHT_API_PORT=<free port>      HINDSIGHT_API_WORKERS=1
HINDSIGHT_API_LOG_LEVEL=warning        HINDSIGHT_API_MCP_ENABLED=false     HINDSIGHT_API_ENABLE_FILE_UPLOAD_API=false
HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:<random>@127.0.0.1:<pg>/hindsight   # pg0 started by Bobble, --data-dir ours
HINDSIGHT_API_DB_POOL_MIN_SIZE=1       HINDSIGHT_API_DB_POOL_MAX_SIZE=8    HINDSIGHT_API_WORKER_POLL_INTERVAL_MS=2000
HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension
HINDSIGHT_API_TENANT_API_KEY=<random, ~/.pi/desktop/memory/secret 0600>
HINDSIGHT_API_LLM_PROVIDER=openai      HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:<gate>/v1
HINDSIGHT_API_LLM_API_KEY=<gate token> HINDSIGHT_API_LLM_MODEL=bobble-local  HINDSIGHT_API_LLM_MAX_CONCURRENT=1
HINDSIGHT_API_LLM_TIMEOUT=1800         HINDSIGHT_API_LLM_MAX_RETRIES=2     HINDSIGHT_API_SKIP_LLM_VERIFICATION=true
HINDSIGHT_API_LLM_STRICT_SCHEMA=true   HINDSIGHT_API_LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}
HINDSIGHT_API_RETAIN_EXTRACTION_MODE=custom   HINDSIGHT_API_RETAIN_CUSTOM_INSTRUCTIONS=<Bobble rules>
HINDSIGHT_API_RETAIN_CHUNK_SIZE=2000   HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=4096   HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=2
HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID=intfloat/multilingual-e5-small
HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH=~/Bobble/Models/Support/Memory/multilingual-e5-small/onnx/model_int8.onnx
HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH=~/Bobble/Models/Support/Memory/multilingual-e5-small
HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS=384
HINDSIGHT_API_RERANKER_PROVIDER=flashrank   HINDSIGHT_API_RERANKER_FLASHRANK_MODEL=ms-marco-MiniLM-L-12-v2
HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR=~/Bobble/Models/Support/Memory/flashrank   HINDSIGHT_API_RERANKER_MAX_CANDIDATES=100
HF_HUB_OFFLINE=1  TRANSFORMERS_OFFLINE=1  LITELLM_LOCAL_MODEL_COST_MAP=True
```

- **pg0 is started by Bobble**, not by Hindsight, through a tiny helper run in the venv (`python -m bobble_memory_pg start|stop|info`). The helper uses the pg0 SDK's `Pg0(name, port, username='hindsight', password=<random>, database='hindsight', data_dir=…, config={'shared_buffers':'64MB'})`. That gives a data dir Bobble owns, a random password, a known port, a smaller buffer pool, a stop we control, and orphan detection by `postmaster.pid`. Hindsight then sees an ordinary external Postgres. It is the same pg0 binary Hindsight would use itself, so pgvector and the trigram entity lookup behave identically.
- **Start lazily.** Start after the chat model's warm-up has finished, so `boot-to-instant` (10.96 s on the user's Mac) is not taxed. A first message sent before Hindsight is up simply gets no memory.
- **Quit.** SIGTERM Hindsight, then stop pg0 (fast mode), both inside `reapChildProcesses()`. At launch, stop or adopt a leftover Postgres found through `postmaster.pid`.
- **Guard.** Register with `guardRun` (`light:true`). A paused Hindsight only costs a skipped recall.

**Files:**
- runtime `~/.cache/bobble/engines/memory/.venv` (cacheRoot);
- models `~/Bobble/Models/Support/Memory/`;
- data `~/.pi/desktop/memory/{db/, secret, outbox.jsonl, memory.log}` (location is an open question).

### 4.7 Settings keys and IPC

```ts
// settings-contract.ts
export interface MemorySettings {
  enabled: boolean;                 // THE one-click switch (default false — see questions)
  autoRecall: boolean;              // use memories in chats (default true)
  autoRetain: boolean;              // learn from chats automatically (default true)
  learnOnBattery: 'never' | 'above-50' | 'always';   // default 'above-50'
  idleSeconds: number;              // quiet time before learning (default 45, clamp 15–600)
  excludedChats: string[];          // session files never read or written ("temporary"/"don't remember")
}
DesktopSettings.memory: MemorySettings;  DesktopSettingsPatch.memory?: Partial<MemorySettings>;
```

`mergeSettingsPatch` deep-merges one level, like `computerUse`. `settings-main.ts` gains an `onMemoryChanged` seam, beside `onPowerChanged`, that starts or stops the service and rewrites the live file.

New `apps/desktop/electron/memory/memory-contract.ts`, composed into `ipc-contract.ts`:
- invoke:
  - `memory:status`, `memory:install`, `memory:uninstall`;
  - `memory:list {q?, type?, offset, limit}`, `memory:entities`;
  - `memory:remember {text}`, `memory:forget {id}`, `memory:restore {id}`;
  - `memory:forget-chat {sessionFile}`, `memory:forget-all`;
  - `memory:export`, `memory:import`, `memory:reveal`, `memory:pause-learning {minutes}`, `memory:diagnostics`.
- event: `memory:state`.

`MemoryStatus` = `{phase: 'off'|'not-installed'|'installing'|'starting'|'ready'|'learning'|'waiting-model'|'error', percent?, detail?, counts:{facts, observations, chats}, pending:{turns, operations}, diskBytes, lastLearnedAt?, modelSecondsToday, engine:{name:'Hindsight', version}, error?}`.

### 4.8 The Memory tab (Settings → Memory)

It is a new `SettingsSection` `'memory'`, placed after "Custom instructions" in `NAV`, with a new `memory` glyph. Per the glyph-set rules it is a Hugeicons stroke glyph added to `GLYPHS` in `packages/ui/src/components/glyph.tsx`. The panel is `apps/desktop/src/settings/panels/MemoryPanel.tsx`, built from the existing `SettingSection` / `SettingRow` / `SegmentedControl` vocabulary.

```
Memory
┌──────────────────────────────────────────────────────────────────────┐
│ Remember things across chats                          [  On | Off ]  │
│ Bobble learns about you and your work from chats and brings it back  │
│ in new ones. Everything stays on this Mac.                           │
│ ● Ready · 214 memories from 37 chats · 41 MB                         │
└──────────────────────────────────────────────────────────────────────┘
 What Bobble remembers                               [ Search memories… ]
 [All] [About you] [What Bobble did] [Summaries]                Recent ▾
  The user prefers answers without emojis.              Sep 20 · “Logo ideas”  ⋯
  The user's Mac is an M5 Pro with 24 GB.               Sep 18 · “Engines”     ⋯
  …                                                             Load more
  ⋯ = Forget · Edit · Open chat          (Forget → toast "Forgotten · Undo")
 [ Remember that…                                              ] [Add]

 Learning
  Learn from chats automatically                          [ On | Off ]
  Use memories in chats                                   [ On | Off ]
  Learn on battery                          [ Never | Above 50% | Always ]
  (when learning)  Learning from 2 chats · pauses whenever you chat  [Pause]

 Your data
  Export…   Import…   Reveal in Finder                 Forget everything… (red)

 ▸ Advanced   Model that learns: the chat model (Qwen3.5 4B) · Engine: Hindsight 0.10.1 (MIT) · 0.9 GB · Remove
```

The status line walks through these states, each with its own copy and test id:

| State | Status line |
|---|---|
| **Not set up** | "Turning this on downloads the memory engine (0.3 GB)." Flipping **On** starts the install inline with a progress bar, no extra dialog: one click. |
| **Setting up** | "Setting up… 62%" (uv's own lines, tidied as for the module card). |
| **Starting** | "Starting…" |
| **Ready** | "Ready" |
| **Learning** | "Learning from 2 chats…" with a Pause button. |
| **Waiting for the model** | "Learning waits until a model is loaded." |
| **Off** | "Off — 214 memories kept on this Mac" (list still browsable; the service starts on demand while the tab is open). |
| **Problem** | the error sentence and [Retry]. |

- **Forget everything** uses the shared dialog anatomy (`pi-desktop-chat-follow-and-dialogs`) and deletes the bank, then recreates it empty.
- The chat's ⋯ menu gains "Forget what Bobble learned here" (`DELETE …/documents/chat:<id>`) and "Don't remember this chat". The delete-chat dialog gains an "Also forget what Bobble learned from it" checkbox.
- The composer + menu gains **Temporary chat** (no recall, no learning).
- **Naming.** Settings → Experimental already has "Memory guard", which is about RAM. Settings search for "memory" hits both; see the open questions.

### 4.9 Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| Hindsight's official pi extension (`@vectorize-io/hindsight-coding-agents`) | Appends to the **system prompt** every turn. Its default reflect is an LLM call before the first turn. Its config lives in `~/.hindsight`; it installs into `~/.pi/agent/settings.json`, which Bobble ignores. |
| `@vectorize-io/hindsight-all` / `hindsight-embed` daemon | Runs `uvx …@latest` (unpinned, network at start). Detached daemon that *"keeps running until you stop it"*, so orphans and no guard. Forces CPU on macOS. Its profiles live in `~/.hindsight`. Bobble owns a pinned venv and a child process instead, and borrows its health logic. |
| Full `hindsight-api` (torch) | +221 MB download, about 1 GB more RAM, MPS instability (the npm wrapper forces CPU on macOS for this reason). ONNX + FlashRank covers the need. |
| Hindsight's built-in `llamacpp` provider | A second model (Gemma 4 E2B, ~3.5 GB) resident beside the chat model on 24 GB, and a second llama.cpp build. |
| Let Hindsight call llama-server directly | Holds the single slot, so the TTFT regression returns. The gate is non-negotiable. |
| Hindsight MCP server through mcp-lite | No automatic recall or retain. Tool text is not tuned for a 4B. Per-bank URL. |
| Recall injected into the system prompt, or prefixed to the user message | The first invalidates the warmed prefix every turn. The second breaks the composer prime at the first user token. |
| Recall via reflect | An LLM call before every turn. |
| Renderer-side injection (like custom instructions) | Adds renderer→main→Hindsight latency before send. Misses subagents and scheduled runs. Duplicates harness logic. |
| Own SQLite + vector memory (the RemotePi approach) or mem0/Letta/Zep | the user chose Hindsight. None of them brings Hindsight's entity/temporal graph, delta retain, curation API or benchmark record for less runtime. |

---

## 5. Work packages (ordered)

Every probe uses `apps/desktop/tests/e2e/harness.mjs` `launchApp` (hidden window, throwaway HOME, focus guard). Unit tests run with each package's own vitest (`cd <pkg> && ./node_modules/.bin/vitest run`, never `npx vitest`). Every chat-path WP ends with the prefill/TTFT check (`user-always-check-prefill`). Every UI WP ends with screenshots LOOKED at, light and dark (`user-visual-confirmation-required`).

### WP-M0 — Measurement spike (M) · deps: none (needs the user's go: ~0.45 GB download, AC power)
- **Files:** `scratchpad/memory-spike/` only (install.sh, run.sh, bench.mjs, quality.mjs). Nothing shipped.
- **Do:**
  - Install the pinned slim set in a throwaway dir.
  - Start pg0 and Hindsight against the real llama-server (Qwen3.5-4B; then 9B).
  - Retain 30 synthetic chats.
  - Measure install time, disk, RSS (API and Postgres), cold/warm start, recall p50/p95 at 100/1k/10k facts (FlashRank L-12 vs TinyBERT vs `rrf`; e5 int8 vs fp32 vs bge-small), and model-seconds per retained turn.
  - Run `dry-run-extract` in concise vs custom mode, counting fabricated facts (#4280 markers plus facts ungrounded in the input).
  - Run `ttft-slots-probe.mjs` / `multi-conversation-kv-probe.mjs` after a memory burst, to check for cache-ram LRU pressure.
- **Accept:** a numbers table added to this doc. Decisions recorded: embedding file, reranker, extraction mode, recall deadline, idle window. Go/no-go on the 4B as the learning model.
- **Verify:** script outputs (JSON) plus `ps`/`footprint` samples. No app launch.

### WP-M1 — Settings keys (S) · deps: none
- **Files:** `electron/settings/settings-contract.ts` (`MemorySettings`, fields, patch), `settings-logic.ts` (`DEFAULT_SETTINGS.memory`, `clampMemory`, merge), `settings-main.ts` (`onMemoryChanged` seam), `settings-logic.test.ts`.
- **Accept:**
  - An old settings.json without `memory` reads as defaults.
  - Junk clamps.
  - A patch merges one level.
  - Fenced writes under `PI_E2E` still hold.
- **Verify:** vitest (`apps/desktop`).

### WP-M2 — Runtime install / uninstall (L) · deps: M0 (choices), M1
- **Files:** `electron/memory/memory-paths.ts`, `memory-install.ts` (+test), `electron/memory/requirements.lock` (`uv pip compile --only-binary :all: --generate-hashes`, per platform), a Support-shelf entry for the models through `downloadRepo`, and the helper `electron/memory/py/bobble_memory_pg.py`.
- **Accept:**
  - Fresh cache: one click gives a venv plus models.
  - `python -c "import hindsight_api, onnxruntime, flashrank, pg0"` succeeds.
  - **No compiler is ever invoked**: probe PATH stubs `cc/clang/rustc/git/cmake` exit 127, the `gen3d-ootb-probe` trick.
  - Progress streams to the card.
  - Uninstall removes runtime and models and leaves data (a separate button).
  - Honours `HF_ENDPOINT` mirror.
- **Verify:** unit tests with an injected runner. `memory-install-probe.mjs` (`REAL_NET=1` opt-in, throwaway HOME and cache, stub compilers). Card screenshots per state.

### WP-M3 — Service supervisor (L) · deps: M2
- **Files:** `electron/memory/memory-service.ts` (pure state machine + ports, +test), `memory-service-main.ts` (spawn pg0 helper and `hindsight-api`, health `/health` + `/version`, bank bootstrap, backoff restart), `main.ts` (`reapChildProcesses`, launch-time orphan check), `gen/pausables.ts` (`kind` gains `'service'`).
- **Accept:**
  - Cold start ≤ 15 s, warm ≤ 6 s (MEASURE; tighten after M0).
  - `lsof -iTCP -sTCP:LISTEN` shows **only 127.0.0.1** listeners.
  - Requests without the tenant key get 401.
  - Quit leaves no python or postgres.
  - After SIGKILL of the app, the next launch adopts or stops the old Postgres.
  - Toggling Off stops both within 5 s.
  - Bank config applied (custom extraction, mission, memory_defense).
- **Verify:** vitest. `memory-service-probe.mjs` (realCache venv, throwaway data): start, health, key check, quit, `pgrep` for survivors. Focus guard: no firewall dialog.

### WP-M4 — LLM gate + activity signal (L) · deps: M0, M3
- **Files:** `electron/memory/llm-gate.ts` (pure scheduler, +test), `llm-gate-server.ts` (HTTP proxy, stream-upstream, response assembly, model rewrite, thinking off, schema shaping per engine), `activity.ts` (+test; inputs from `pi/pi-sessions.ts` `onUserPrompt` + events, `child-agents.ts`, `prefill-main.ts`, gen queue, `pressure.ts` battery).
- **Accept:**
  1. User prompt or prefill preempts an in-flight memory request in <50 ms, and llama-server `/slots` shows the slot idle within 100 ms.
  2. No memory request reaches the server during a turn or the idle window.
  3. Held work resumes by itself.
  4. Survives a model or engine switch mid-hold.
  5. Battery policy obeyed.
  6. **TTFT:** `ttft-probe.mjs MESSAGES='a||b||c' GAP_MS=0` with a synthetic memory load running is within +50 ms of baseline, and `ttft-slots-probe.mjs` shows only new tokens processed.
- **Verify:** unit tests with a fake upstream (Node http). A live probe against the real server. The rapid-mlx row too (cancel-on-disconnect is unverified there).

### WP-M5 — Outbox + retain policy (M) · deps: M3, M4
- **Files:** `electron/memory/outbox.ts` (+test), `memory-main.ts` endpoints `/bobble/turn` and `/bobble/remember` (token-gated), `electron/memory/retain-shape.ts` (+test: context line, tags, document id, append, operation_id).
- **Accept:**
  - Persisted before ack.
  - Flush only when idle.
  - Idempotent resend after a crash.
  - Excluded and temporary chats and harness nudges are never sent.
  - Memory tab counters are right.
- **Verify:** vitest with a fake Hindsight. `memory-learn-probe.mjs` (real model): a 3-turn chat, then idle, then `memory:list` shows facts from it.

### WP-M6 — The pi extension (L) · deps: M3, M5
- **Files:** new `packages/memory/{package.json, src/index.ts, src/live-config.ts, src/client.ts (fetch; or @vectorize-io/hindsight-client@0.10.1, zero-dep), src/recall-block.ts, src/turn-capture.ts, src/tools.ts}` + tests; `electron/pi/extension-dirs.ts` (add `'memory'` after `harness`); `electron/pi/pi-main.ts` `buildPiEnv` (`PI_DESKTOP_MEMORY_FILE`); `packages/harness/src/presets/capabilities.ts` (`memory` capability).
- **Accept:**
  - Block ≤ budget, suffix-placed, persisted, deduped per chat.
  - Excludes this chat's own facts.
  - Skipped on deadline.
  - Zero HTTP when off.
  - No automatic recall at subagent depth ≥ 1.
  - `memory recall|remember|forget` work in CLI mode and via `capability` in schema mode.
  - **Prefill rule:** `PI_DIAG_PROMPTS` + `prompt-diff.mjs` over 5 consecutive requests shows history byte-identical with only the new user message and memory note appended. `prefill-exactness-probe.mjs` and `prefill-divergence-probe.mjs` are unchanged vs memory-off. `ttft-probe` delta ≤ measured recall time. The warm-up still reports warmed (`PI_ADV_DEBUG_WARM`).
- **Verify:** vitest in `packages/memory`. `memory-recall-probe.mjs` (real model: tell a fact, new chat, ask; screenshot the answer and the chip).

### WP-M7 — Memory tab (L) · deps: M1, M3
- **Files:** `electron/memory/memory-contract.ts` (+ `ipc-contract.ts` composition), `memory-main.ts` handlers, `src/state/memory-store.ts` (+test, `__memory_store` e2e seam), `src/settings/panels/MemoryPanel.tsx` (+ `MemoryList.tsx`, `ForgetAllDialog.tsx`), `src/settings/SettingsView.tsx` (`'memory'` in the union, NAV, TITLES, SectionBody, search keywords "remember"/"memories"), `packages/ui/src/components/glyph.tsx` (`memory` glyph), `tests/e2e/fixtures/fake-hindsight.mjs` (list/recall/retain/forget/stats), seam `PI_DESKTOP_MEMORY_FAKE_URL`.
- **Accept:**
  - Every state in §4.8 renders with its copy.
  - The toggle lands in settings.json and starts or stops the service.
  - Search, filter and paginate work; forget + undo; add; forget everything (dialog); export and import; reveal.
  - Keyboard and Escape behaviour of the floating Settings is intact.
- **Verify:** vitest. `memory-tab-look.mjs` against the fake (screenshots of each state, light and dark, settings.json assertions). A design-parity pass against the Settings spec-book.

### WP-M8 — Chat affordances (M) · deps: M6, M7
- **Files:** `src/chat/MemoryUsedChip.tsx`, `packages/engine/src/renderer/rehydrate.ts` (map `bobble-memory`), chat ⋯ menu items, delete-chat dialog checkbox, composer + menu "Temporary chat".
- **Accept:**
  - The chip shows only when something was injected, lists the items, and Forget works.
  - Reload shows the same chip.
  - A temporary chat sends no recall and no turn.
- **Verify:** rehydrate unit tests with a session fixture containing the custom entry. An e2e with a mock-pi fixture emitting `memory-used`. Screenshots.

### WP-M9 — Storage + diagnostics (M) · deps: M2, M3
- **Files:** `src/models/StorageView.tsx` rows (engine, models, data), `storage` IPC hooks, `memory:diagnostics` (versions, `…/stats`, pending ops, gate counters, last errors), `~/.pi/desktop/memory/memory.log`.
- **Accept:** sizes match `du`; Remove engine works while data stays; diagnostics read truthfully.
- **Verify:** unit tests. Look probe.

### WP-M10 — Quality eval + tuning (L) · deps: M4–M6
- **Files:** `tests/e2e/memory-eval.mjs`, `tests/e2e/fixtures/memory-eval/*.json` (synthetic personas across 5 chats each, with LongMemEval-style questions).
- **Accept (proposed):**
  - Fabricated facts under 1% of facts.
  - At least 70% of memory-dependent questions answered right on the 4B (report the 9B too).
  - TTFT p50 within +150 ms of memory off.
  - Model-seconds per chat reported.
- **Verify:** report plus Memory-tab screenshots after the run.

### WP-M11 — Onboarding, help, copy (S) · deps: M7
- **Files:** onboarding `planPreset` (memory in default/max presets, per the user), settings-assistant knowledge (track 2) for the `memory.*` keys, copy review.
- **Accept:** preset choice persists; "bobble help" can explain and toggle memory.
- **Verify:** unit tests. Onboarding look probe.

### WP-M12 — Learn from existing chats (M, optional) · deps: M5
- **Files:** `electron/memory/backfill.ts` (+test).
- **Do:** after first enable, offer "Learn from your 56 existing chats (runs while you're away)". Feed `~/.pi/agent/sessions/**` through the outbox, with progress and cancel.
- **Accept:** idle-only, resumable, cancellable.
- **Verify:** unit tests. Live probe on a copy of sessions.

**Order:** M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9 → M10 → M11 (→ M12). M1 and M7's UI can run alongside M2–M4 against the fake Hindsight.

---

## 6. Risks, blockers and open questions

**Risks**
1. **Extraction quality on small models.** 4B-class models may fabricate facts or misattribute speakers (#4280). Mitigation: custom mode, strict JSON schema grammar on llama.cpp, a retain mission, and the WP-M0/M10 evals. Longer term, track 6's harness LoRA can include Hindsight's extraction schema as a training task.
2. **Background model work.** Slot holding (solved by the gate). LRU pressure on llama-server's 8 GiB prompt cache, where many extraction prompts could push out older chats' cached states (a cliff, `pi-desktop-prompt-cache-truth`; measure in M0 and M4). Battery drain (the policy handles it). MLX engines: cancel-on-disconnect and `json_schema` support are unverified.
3. **Recall on the turn path.** CPU-bound rerank contends with the UI. A guardian-paused Hindsight means skipped recall. Hence the deadline plus measurement.
4. **Footprint.** About 0.3 GB download, about 1 GB disk and about 0.5–0.9 GB resident RAM (estimates) whenever memory is on.
5. **Platforms.** The binary-only install works on **macOS 14+ Apple Silicon**, Linux glibc ≥ 2.35 and Windows x64. It **fails on macOS 13** (pg0 wheel tag) and **Intel Macs** (cryptography ≥50). Memory must show "not available on this Mac" there. Relevant to track 4.
6. **Upstream churn.** Weekly releases, and removed endpoints (e.g. `/profile`). Pin, keep contract tests against the fake, and run a real smoke probe before bumping.
7. **Privacy semantics.** Hindsight stores raw chat text as document bodies. Per-fact "forget" is a reversible invalidate, not a hard delete. Memory Defense only redacts secrets and PII; there is no prompt-injection filter in open source, so a retained reply quoting a web page could plant an instruction. Mitigations: framing plus user/assistant text only.
8. **pg0 lifecycle.** Orphaned Postgres after a crash. Unsigned-binary behaviour when spawned from the app is unverified.
9. **Ordering with the harness.** The memory extension must load after the harness and must never return `systemPrompt`. Guard this with a wiring test.

**Blockers**
- The measurements this design depends on (WP-M0) need an install of about 0.3 GB of wheels plus about 0.14 GB of models, and model runs. Both are outside this research phase's rules, so they need the user's go and AC power.
- macOS 13 and Intel Macs cannot install the runtime without a compiler (pg0 wheel is macOS 14+; cryptography ≥50 has no x86_64 macOS wheel).

**Questions for the user**
1. Default: memory **off** until turned on (0.3 GB download), or on in the default/max onboarding presets?
2. Learning model: the loaded chat model at idle (recommended), a dedicated small memory model (more RAM), or another device over Tailscale (track 5)?
3. Where memories live on disk: `~/.pi/desktop/memory/` (next to settings and chats), or visible `~/Bobble/Memory/` like Models?
4. Learning on battery: never, above 50% (proposed), or always? Is the 45 s idle window right?
5. Scope: one memory for everything, or project-scoped recall (tags already allow it)?
6. "Forget" semantics: reversible (Hindsight invalidate plus Undo), or hard delete, which only exists per chat or for everything?
7. Show the "Remembered 3 things" chip in chat (Claude/ChatGPT-style), and a "Temporary chat" in the + menu?
8. "Memory guard" (RAM, under Experimental) now shares a word with the Memory tab. Keep both names, or rename the guard?
9. Keep or hide the MCP "Memory" knowledge-graph connector in Extensions once built-in memory exists?
10. Subagents, specialists and scheduled runs: automatic recall on or off? (Proposed: tools only, no automatic injection.)
11. Deleting a chat: also forget what was learned from it by default?

---

## Sources

- Hindsight repo, README, manifests and source @ v0.10.1: <https://github.com/vectorize-io/hindsight> (`hindsight-api-slim/pyproject.toml`, `hindsight_api/config.py`, `main.py`, `pg0.py`, `api/http.py`, `engine/embeddings.py`, `engine/cross_encoder.py`, `engine/providers/openai_compatible_llm.py`, `engine/retain/fact_extraction.py`, `engine/retain/orchestrator.py`, `extensions/builtin/tenant.py`, `hindsight-embed/`, `hindsight-all-npm/`, `hindsight-integrations/coding-agents/src/harness/pi-extension.ts`)
- Docs: configuration <https://hindsight.vectorize.io/developer/configuration> · models <https://hindsight.vectorize.io/developer/models> · performance <https://hindsight.vectorize.io/developer/performance> · retain <https://hindsight.vectorize.io/developer/retain> · memories API <https://hindsight.vectorize.io/developer/api/memories> · memory defense <https://hindsight.vectorize.io/developer/memory-defense>
- Ollama guide (local latency, `MAX_CONCURRENT=1`): <https://hindsight.vectorize.io/blog/2026/03/10/run-hindsight-with-ollama>
- Paper: <https://arxiv.org/abs/2512.12818> · ACL demo: <https://aclanthology.org/2026.acl-demo.27/>
- Small-model issue and fix: <https://github.com/vectorize-io/hindsight/issues/4280> · <https://github.com/vectorize-io/hindsight/pull/4284>
- pg0: <https://github.com/vectorize-io/pg0> · <https://pypi.org/project/pg0-embedded/>
- npm: <https://www.npmjs.com/package/@vectorize-io/hindsight-client> · <https://www.npmjs.com/package/@vectorize-io/hindsight-all>
- Models: <https://huggingface.co/intfloat/multilingual-e5-small> · <https://huggingface.co/Xenova/multilingual-e5-small> · <https://huggingface.co/BAAI/bge-small-en-v1.5> · <https://huggingface.co/prithivida/flashrank>
- litellm offline cost map: <https://docs.litellm.ai/docs/proxy/custom_model_cost_map>
