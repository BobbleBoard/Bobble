# Harness LoRA: a Qwen3.5-4B tuned for Bobble's CLI harness

Track 6 of the 2026-09-23 push. **Research only**: no code was changed, nothing was
launched, no model server or training job was run. The one local measurement was
reading the header of the shipped GGUF (§2.4). Base commit `c9fe7098`.

**Short version**

- **Base model:** Qwen3.5-4B is still the right base. No newer small dense Qwen exists
  (Qwen3.6 and Qwen3.8 start at 27B). Its weakest published score is exactly our
  problem: BFCL-V4 **50.3**, against 66.1 for the 9B and 68.5 for the 27B.
- **Recommendation:** build a pipeline that can be rerun, not a one-off checkpoint:
  1. An open-weight teacher with the same tokenizer and an Apache-2.0 licence
     (Qwen3.8-27B or Qwen3.5-27B) drives **the real harness code** headlessly in
     sandboxes.
  2. Successful trajectories are rendered with **the exact patched template the app
     sends** (`enable_thinking` and `preserve_thinking` on).
  3. A bf16 LoRA on all language layers is trained on a rented GPU.
  4. It is then on-policy distilled.
  5. It is merged with the **MTP head re-attached and re-tuned**.
  6. It ships as a catalog model ("Bobble 4B"), but only after passing measured gates
     that reuse the probes we already have.
- **Biggest finding, part 1: training-data fidelity.** The model must see exactly what
  the app sends. That is:
  - a prompt that changes by machine (groups appear only when their tools are
    registered);
  - a CLI surface that changes weekly;
  - a template patched so every past `<think>` block is kept.

  So the data has to come from the live harness, not a hand-written prompt. The
  preserved-thinking patch has a useful side effect: a whole trajectory renders as one
  sequence whose every assistant span has exactly its inference-time context.
- **Biggest finding, part 2: MTP is dropped silently.** Hugging Face `transformers`
  discards `mtp.*` weights on load (`_keys_to_ignore_on_load_unexpected = [r"^mtp.*"]`).
  A naive merge-and-convert therefore ships a model without its MTP head. On llama.cpp
  that costs about **26%** of decode speed (48.5 → 36 tok/s, measured here). Keeping
  the head, and re-tuning it for the new weights, is a named work package.
- **Cost:** a full iteration is roughly **$100–300 of rented GPU time** (estimate) plus
  overnight evals on the Mac while it is plugged in. Training on the M5 Pro itself is
  possible for experiments but not for the real runs (§3.6).

---

## 1. Goal

The user, verbatim: *"specialized model (lora of qwen3.5 4b i'm thinking) tuned to out of
the box work with our cli based harness really really well."*

### What that means precisely

1. **A model artifact** that the app downloads and selects like any catalog model. It is
   Qwen3.5-4B plus a LoRA, merged, exported as GGUF (Q8_0 / Q6_K) and as an MLX twin.
2. **The target configuration is the app's defaults:**
   - tool interface `bash-cli` (`apps/desktop/electron/settings/settings-logic.ts:130`);
   - thinking on, with preserved thinking;
   - the app's sampling (temp 0.8 / top-p 0.9 / top-k 50 + DRY);
   - llama.cpp with MTP, or rapid-mlx;
   - vision on (new default as of today, `STATUS.md` item 2).
3. **What "well" means.** On Bobble tasks the tuned model must, compared with the stock
   `qwen3.5-4b-mtp` it replaces:
   - finish more tasks;
   - take fewer turns;
   - trigger fewer **harness interventions** (guards, redirects, translations, loop
     steers);
   - present its work;
   - not claim things it did not do.
4. **"Out of the box" means the same prompt every other model gets.** No per-model
   harness fork. This follows the user's rule that prompt pressure *is* the mechanism
   (`user-prompt-pressure-not-enforcement`). The LoRA moves the distribution; the
   harness keeps every guard it has.
5. **Nothing it already serves may regress:**
   - plain chat (every chat runs under the harness prompt);
   - vision through the projector;
   - the utility lanes the same 4B serves: title generation, the repair fixer, the bash
     safety reviewer, compaction summaries;
   - the corp worker role (`CORP_MODEL_ID`, `apps/desktop/electron/inference/llm-main.ts:259`);
   - decode speed (MTP);
   - prefill (the prompt is unchanged, so TTFT must be too).
6. **It must be re-trainable.** The CLI surface and prompt change every few days. The
   deliverable is the pipeline plus its gates. A checkpoint is one output of it.

**Not goals for v1:** reinforcement learning; new tools; Windows/Linux-specific
behaviour; training on anyone's personal sessions; shrinking the system prompt for this
model.

---

## 2. What exists today

### 2.1 What the model actually sees in tool-CLI mode

The chain, from setting to tokens:

| Step | Where | What happens |
|---|---|---|
| Setting | `settings-logic.ts:130` default `toolInterface: 'bash-cli'`; UI `apps/desktop/src/settings/panels/HarnessPanel.tsx:272` | CLI mode is the default |
| Env | `apps/desktop/electron/pi/pi-main.ts:188` `buildPiEnv` | Sets `PI_DESKTOP_TOOL_CLI=1` (specialists: `specialistToolInterface`, l.354) and `PI_DESKTOP_FS_FENCE`, `PI_DESKTOP_WORKSPACE_ROOT`, `PI_DESKTOP_GEN_MEDIA`, `PI_OMNISVG_READY`, `PI_BOBBLE_3D_READY`, `PI_DESKTOP_VISION` |
| Advertised tools | `packages/harness/src/index.ts:916` `TOOL_CLI_PINNED`, applied in `applyPreset` l.3039 | Exactly **`read`, `write`, `edit`, `bash`** |
| Shims | `packages/harness/src/tools/tool-cli-bridge.ts` `registerToolCli` | One POSIX shim per group in a 0700 temp dir at the front of PATH, dispatching over a token-gated Unix socket to the in-process registry. It also installs:<ul><li>decoys: `say`/`espeak`/`festival` point to `media generate speech`; `afplay`/`ffplay`/`mpv`/`vlc`/`mplayer` point to `coordinate present`;</li><li>an `open` wrapper that translates `open -a` → `mac launch`, a URL → `browser navigate`, and a folder → `ls -la`.</li></ul> |
| Command grammar | `tools/tool-cli.ts` `resolveCli`, `parseArgv`, `coerceArgs` | `--help` pages are generated from each tool's own schema (`renderRootHelp` / `renderGroupHelp` / `renderCommandHelp`), so they cannot drift |
| Groups | `presets/capabilities.ts` plus `tools/tool-cli-groups.ts` | Capability groups: `browser`, `mac` (computer-use), `chrome`, `personal`, `web`, `media`, `svg`, `chart`, `office`, `3d`, `mcp`. Extras: `coordinate` (ask / plan / delegate / manager / present / schedule), `machine` (python / search), `file` |
| System prompt | `index.ts:2792` `canonicalPrompt()` = `toolCliPreamble()` (l.2889) **first**, then `augmentSystemPrompt(…, {toolInterface:'bash-cli', commandFor, guidelines, workingDirectory})` (`prompt/capability-prompt.ts:430`) | See the list below this table |
| Provider | `packages/provider-llamacpp/src/stream.ts` `buildChatCompletionsRequest`; MLX: `packages/provider-mlx/src/stream.ts` | Sends an OpenAI body. Each assistant `reasoning_content` is carried back. Tool results go as `role:"tool"`. A tool-returned image goes as a following **user** turn `[image returned by X]` (or a text note on a blind server). MLX engines get `chat_template_kwargs {enable_thinking:true, preserve_thinking:true, …}` |
| Server | `packages/inference/src/supervisor.ts` `assembleServerArgs` | `--jinja --chat-template-file <official Qwen/Qwen3.5-4B template, patched>`, `--reasoning-preserve`, reasoning budget −1, DRY (1.0 / 1.75 / 70), temp 0.8 / top-p 0.9 / top-k 50, `draft-mtp`. The projector is loaded alongside MTP (measured 43.42 vs 43.80 tok/s) |
| Template patch | `packages/inference/src/chat-template.ts` `patchReasoningContentGate` + `patchPreserveThinking` | **Every** past assistant turn is rendered with its `<think>` block, the same bytes it was generated as. This exists for KV-cache reuse |

**How the system prompt is assembled** (the "System prompt" row above):

- The CLI preamble is first. It lists one line per group, then:
  - the anti-shopping lines;
  - "run `--help` the FIRST time";
  - "choose defaults, never ask twice";
  - "never say unable";
  - the `coordinate present` rule;
  - "use `write` / `edit`, not redirection".
- The pi identity and pi-docs text are stripped, and pi's tool catalog is removed.
- pi's guidelines are named, pruned, and retargeted to command names.
- The `Current working directory` line becomes the folder by name, plus
  `SHELL_CWD_TRUTH`.
- The schema-only lines are removed.
- Then `capabilityPromptForCli()` and `VERIFY_PROMPT` follow.
- The result is frozen per session and warmed at model-select.

**The group list depends on the machine.** The preamble lists
`buildCli(toolCliGroups(), cliVisibleTools())` minus `file`. A group appears only if
its tools are registered *and* runnable:

- `media` needs `PI_DESKTOP_GEN_MEDIA`;
- `svg` needs OmniSVG on disk;
- `3d` needs the 3D connector;
- `mcp` needs configured connectors.

So the prompt differs from machine to machine, and the training data must cover every
combination.

**Rendered result.** Tokens abbreviated. The template puts the tool block *before* our
system text:

```text
<|im_start|>system
# Tools

You have access to the following functions:

<tools>
{"type":"function","function":{"name":"read",…}}
{"type":"function","function":{"name":"write",…}}
{"type":"function","function":{"name":"edit",…}}
{"type":"function","function":{"name":"bash",…}}
</tools>

If you choose to call a function ONLY reply in the following format with NO suffix:
<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
…
</IMPORTANT>

These commands are your abilities. Run them with the `bash` tool.

  browser — Drive the app's own built-in browser: …
  mac — Computer use: see and control any app on the user's Mac — …
  web — Search the web and fetch a page as readable text.
  media — Create images, video, speech, music and sound effects on-device. …
  office — Make a real slide deck (.pptx), document (.docx), … never python-pptx …
  coordinate — Ask the user something, publish your plan, hand work to a subagent, …
  machine — Run Python on this Mac, and search everything on it by name or contents.
  …(only the groups registered on this machine)

They are the ONLY way to do what they do. … The FIRST time you use a command in a
session, run `<command> --help` … Whatever you make … show it with
`coordinate present <path>` as your last step …

Guidelines:
- Use `edit` for precise changes (edits[].oldText must match exactly) …
- For any task with more than one step, call `coordinate plan` early …
Current date: …
Current working directory: the chat's working folder `<name>`. Every path … relative …
Every shell command already starts in that folder, in a fresh shell …

# You are a local agent with real tools — use them
… VERIFY BEFORE YOU SUBMIT. …<|im_end|>
<|im_start|>user
Make me a picture of a red fox asleep in tall grass and show it to me.<|im_end|>
<|im_start|>assistant
<think>
…
</think>

<tool_call>
<function=bash>
<parameter=command>
media generate image --help
</parameter>
</function>
</tool_call><|im_end|>
<|im_start|>user
<tool_response>
Usage:
  media generate image [--key value …]
  media generate image "prompt"   (positional: fills --prompt)
…
</tool_response><|im_end|>
<|im_start|>assistant
<think>
…            ← preserved on every later turn (patched template)
</think>

<tool_call>
<function=bash>
<parameter=command>
media generate image "a red fox asleep in tall grass" --save_to fox.png
…
```

**Sizes:**

- CLI mode (measured 2026-09-06, `tool-mode-cost-probe`): system 5,345 + one tool 786
  = 6,131 chars, about **1,770 tokens**. Schemas mode: 32,506 chars, about 8,185 tokens.
- The 2026-09-09 verbatim capture (`scratchpad/system-prompt-cli.md`) is 5,893 chars of
  system text with four tools.
- Everything a command takes (flags, enums, shapes) is **not in context** until the
  model runs `--help`.
- Bash output is capped at about 1,500 tokens (`tools/tool-output-truncate.ts`).

**What comes back to the model:**

- help pages;
- resolution errors that name the nearest commands (`resolveCli`);
- tool results rewritten to name commands (`dispatchToolCli` → `retargetToolNames`);
- guard refusals;
- private harness steers delivered as user turns. These are the `agent_end` nudges
  (choice handback, output limit, unfinished plan) and the verify steer (`followUp`).

**Forms the parser already accepts** (so a trained model need not be perfect at them):

- `--k v`, `--k=v`, `-k v`;
- positionals that fill required arguments;
- `--save-to` read as `save_to`;
- `x:500` keyed words;
- `[2]` as an index;
- a word with a file extension read as `--out`;
- `--image` / `--visual` read as `--screenshot`;
- a structured call **named** like a command, translated into the bash line by the
  provider (`repair.ts` `resolveUnknownToolName` → `commandLineForCall`).

**Engine difference that matters for training.** llama.cpp's tool grammar pins the tool
*name* to the four advertised tools (`pi-desktop-grammar-coercion`). rapid-mlx runs
unconstrained (`RAPID_MLX_CONSTRAIN_TOOLS=0`). On MLX the model's own format
discipline is therefore the only guard. That is where "`media generate image` as a
tool name" happened.

### 2.2 The measured failure catalogue

These are what the tuned model has to stop doing. Every row was measured in this repo,
with the source memory note or code comment named.

| # | Failure (what a small model did) | Measured in | Harness mitigation today | Training signal |
|---|---|---|---|---|
| 1 | Emitted the command as a structured tool name: `{"name":"media generate image",…}`, also `chrome`, `mac snapshot` | 4B on rapid-mlx, `pi-desktop-tool-surface-2026-09-15` | provider translation into the bash line | always `bash` + command line |
| 2 | "Shopping trip": `say`, `festival`, `which ffmpeg`, `pip list`, `ls /usr/bin`, `import PIL` before reading its own help | ling-3.0-tiny / 2B, `tool-cli-eval.mjs`, `index.ts` preamble comments | anti-shopping preamble + decoy shims | first action = `<group> --help` or the command |
| 3 | False refusal: "I only have access to shell commands" | Qwen3.5-4B, `tool-cli-eval` discovery arm | "never tell the user you are unable" | refusal-bait tasks |
| 4 | Read `--help`, found the command, stopped without running it | two models, `tool-cli-eval` | "Reading the help is not finishing" | help → call continuations |
| 5 | Invented argument forms: `--key app="TextEdit"`, `x:500 y:400`, `menu:"File > New Tab"`, `mac type [2] "…"`, `mac click 660 558` | 4B, 27B, MiniCPM5 (comments in `tool-cli.ts`) | tolerant parser | the canonical form `--help` prints |
| 6 | Output file name went into the prompt slot: `svg "--prompt=…" bicycle.svg` | 4B, `pi-desktop-deep-tasks-2026-09-16` | a positional with an extension fills `--out` | explicit `--out` |
| 7 | Made the artifact by hand instead of calling the tool:<ul><li>a PIL "cow";</li><li>a picture built from rectangles;</li><li>a synthesised door slam;</li><li>a `<svg><circle>` heart;</li><li>`python-pptx` loops;</li><li>`media generate image "bar chart…"`</li></ul> | 2B / 4B, `capabilities.ts` comments, deep tasks | `handmade-media.ts`, `handmade-office.ts`, `handmade-chart.ts`, `handwritten-svg.ts`, `dataChartPrompt` | the right command per artifact type |
| 8 | Did not present its work: `open <file>`, then "the image is now visible". It reached the canvas in **3 of 23** asks; `ffplay` blocked for 300 s | 4B, `pi-desktop-canvas-assessment` | `open` wrapper, player decoys, present rule first in the preamble | `coordinate present <path>` as the last step, then read the preview |
| 9 | `ask_user` loop: asked about style 7 times; asked 4 more times after "dismissed" | preamble comment; `pi-desktop-computer-use-2026-09-15` | "never ask twice", no-answer wording | choose defaults; a simulated user answers only where asking is right |
| 10 | Grammar-coerced write: `write "Searching for …"` ×150 | schemas mode, deep tasks run 2 | `coerced-write.ts`, small-cycle abort | web via `web search` |
| 11 | Failed-edit loop: 6 rejected edits over a 1-character difference; file left byte-identical; 10 minutes lost | run G, `pi-desktop-failed-edit-loop` | `edit-diagnosis.ts` reports per entry | recovery states: resend the matching entries unchanged |
| 12 | Degenerate repetition: 75× `write screenshot.png`; byte-identical `ls` loops | `pi-desktop-calibration-engines`, `user-measurement-mistakes` #8 | loop detector, same-call, repeat notice | failing turns loss-masked; DPO "rejected" |
| 13 | `curl -s wikipedia \| grep height` ×4 (HTML flood) | deep tasks "web" 3/7 | `raw-page-fetch.ts` | `web search` → `web fetch` |
| 14 | Path confusion: `cd <folder> &&` every command; `hi-8/hi-8/…`; `--save_to=/cow.png`; a trailing dot in a path | `pi-desktop-harness-tool-truth`, tool-surface, corp findings | folder-by-name prompt, `SHELL_CWD_TRUTH`, `resolveWorkspacePath` | relative paths, no `cd` |
| 15 | Thought says "use coordinate delegate", call is `write task_sea.md` | deep tasks "subagents" 2/7 | prompt fixes (6/7 by run 3) | `coordinate delegate` |
| 16 | Narrated a whole app as prose: 20,541 tokens, zero writes | Qwen3.8-27B run 16, `pi-desktop-inference-knobs` | `OUTPUT_LIMIT_NUDGE` | files via `write` |
| 17 | False completion: "The LocalConvert app is now running!" when it could not run | 9B, `pi-desktop-long-task-completion` | `VERIFY_PROMPT`, verify steer, tester specialist | keep only inspect → act → verify trajectories; the judge penalises unverified claims |
| 18 | No plan on a 24-part task, so the unfinished-plan nudge could not fire | 9B, `pi-desktop-long-task-completion` | the nudge exists but needs a plan | `coordinate plan` early |
| 19 | Whole answer inside `<think>`, no `</think>` | 4B on rapid-mlx, `pi-desktop-calibration-engines` | `settle-reply.ts` promotes it | clean think/answer separation, concise thinking |
| 20 | 28 edits trying to get an 8-slide deck back to 4, no reply | 4B, deep tasks "deck" | office `CHECK_LINE`, slide counting | a correct brief first time |
| 21 | `read` on a `.docx` (raw zip bytes); emptied `letter.docx` | canvas assessment | office-aware read/write | `office inspect` / `office edit` |
| 22 | Used the user's Chrome or computer use for ordinary web tasks | The user 2026-09-13 | capability summaries | `browser` / `web` by default; `chrome` only when named |
| 23 | Drove apps with temp files, AppleScript, `pkill -9 Maps`; did Calculator sums in its head | `buildOpenWrapper` comments | `open -a` → `mac launch` + `mac --help` dump | `mac launch` → `mac snapshot` → act |
| 24 | Never weighed delegating a large build (1 of 5 runs delegated) | `capability-prompt.ts` comment (improved to 3/5) | the "YOU HAVE A MANAGER" clause | the delegation decision at the start of large asks (never for trivia) |

**Takeaway.** Nearly every row now has a harness-side catch. Each catch still costs at
least one wasted turn, a prefill, and sometimes the whole task (rows 8, 11, 17, 20).
That makes "interventions per task" the cleanest single measure of what the LoRA buys.

### 2.3 Instruments we already have (and will reuse)

| Instrument | Gives | Reuse here |
|---|---|---|
| `PI_DIAG_PROMPTS=<file>` + `PI_DIAG_PROMPTS_FULL=1` (`provider-llamacpp/src/request-tap.ts`) | the **exact request body** of every call, as JSONL | state library for replay evals, straight from real app runs |
| `PI_ADV_DEBUG_TOOLS` / `_PROMPT` / `_TOOLCOST` / `_WARM` | advertised tools, prompt, per-tool cost, warm-up | parity checks |
| `harness-prefill-system` / `-tools` status channels; `dump-system-prompt.mjs`; `prompt-truth-probe.mjs` | the frozen prompt as sent | golden prompt for the headless runner |
| pi session JSONL (`~/.pi/agent/sessions/<slug>/*.jsonl`) | a tree (`id` / `parentId`) of `session`, `model_change`, `message` records (thinking / text / toolCall blocks, usage, `stopReason`) and `toolResult` records (`isError`) | the trajectory record; intervention analysis |
| `tests/e2e/tool-cli-eval.mjs` | offline llama-server A/B of schemas vs CLI arms, 6 tasks, real `resolveCli`, stubbed results, multi-model | the fastest smoke gate |
| `tool-surface-probe.mjs` (61 commands, 13 groups as of 2026-09-15), `deep-tasks-probe.mjs` (10 plain asks), `long-task-probe.mjs`, `canvas-assess.mjs`, `coordinate-cli-probe.mjs`, `specialist-cli-probe.mjs` | real-app behaviour | release gates |
| `engine-matrix-probe.mjs`, `calibrate-probe.mjs`, `ttft-probe.mjs`, `boot-to-instant-probe.mjs` | engines, tok/s, TTFT | speed/compat gates |
| `corp-headed-run.mjs` + `corp-benchmarks.md` (LocalConvert, verbatim) | long-horizon behaviour | report (see note below) |
| `bench-tasks.json` + `bench-grade.mjs` | 10 HTML tasks graded from artifacts | extra held-out tasks |
| `apps/desktop/electron/corp/role-agent.ts` | a **headless pi `AgentSession`** (`createAgentSession` + `DefaultResourceLoader` + in-process OpenAI provider) | the pattern for the headless gym |
| `apps/desktop/tests/e2e/harness.mjs` `launchApp` | invisible app, throwaway HOME, focus guard | every real-app gate |

On the corp benchmark: the user's rule is to use the prompt verbatim and let the run finish.

### 2.4 Model plumbing today

**The catalog entry** is `QWEN35_4B_MTP` (`packages/inference/src/catalog.ts:784`):

- GGUF from `unsloth/Qwen3.5-4B-MTP-GGUF`: Q8_0 (4,610,580,800 B) and UD-Q6_K_XL;
- `mmproj-F16.gguf` (672 MB);
- `mtpEmbedded: true`;
- MLX twin `mlx-community/Qwen3.5-4B-MLX-8bit` with MLX drafts: MTP sidecar
  `mlx-community/Qwen3.5-4B-MTP-bf16` (about 240 MB) and DFlash `z-lab/Qwen3.5-4B-DFlash`;
- a GGUF DFlash drafter;
- `baseRepo: 'Qwen/Qwen3.5-4B'`, which is where the chat template comes from.

**It is the default nearly everywhere:**

- recommender `UTILITY` (titler / fixer / classifier);
- `primaryFor('8GB')`;
- every `tierTable(*).fast` (`recommender.ts:134–390`);
- `CORP_MODEL_ID` and the corp concurrency constants.

A tuned replacement therefore takes over the fast tier, the utility lane and the corp
worker together.

**Header of the shipped Q8_0**, read for this document with a GGUF parser on
`~/Bobble/Models/LLM/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf`:

| Field | Value |
|---|---|
| arch | `qwen35` |
| `block_count` | **33** (32 trunk + 1 MTP) |
| `nextn_predict_layers` | 1 |
| `blk.32` tensors | 15: a full gated-attention block plus `nextn.eh_proj` (5120→2560), `enorm`, `hnorm`, `shared_head_norm` |
| MTP head size | about 120M parameters |

**Measured speed on this M5 Pro** (`pi-desktop-calibration-engines`, Qwen3.5-4B):

| Engine / lane | tok/s |
|---|---|
| llama.cpp, plain | 36 |
| llama.cpp, MTP | **48.5** (+35%) |
| llama.cpp, DFlash | 29 |
| rapid-mlx, plain | 55 |
| rapid-mlx, + MTP sidecar | 50.6 |
| dflash-mlx | 58 |
| mlx-dspark, DFlash | about 62 |

rapid-mlx's vision lane (`--mllm`) does not honour a speculative decoder
(`packages/inference/src/vision-launch.ts`). With vision on by default, MTP therefore
matters on **llama.cpp** (and so on Linux/Windows, Track 4) far more than on MLX.

### 2.5 What is missing

- **No training code of any kind.** The repo has no LoRA, PEFT, Unsloth or MLX-LoRA
  code. The only mention is roadmap item 6.
- **No way to run the full harness headlessly at volume outside Electron.** The tool
  bridges' host halves live in the app:
  - `pi/present-bridge.ts`, `pi/subagent-bridge.ts`;
  - `gen/gen-manager.ts`, `gen3d/gen3d-bridge.ts`;
  - `mac/mac-agent.ts`;
  - browser agent in `main.ts`;
  - envs `PI_DESKTOP_PRESENT_SOCK`, `PI_GEN_SOCK`, `PI_DESKTOP_GEN3D_SOCK`,
    `PI_DESKTOP_SUBAGENT_SOCK`, `PI_BROWSER_AGENT_SOCK`, `PI_MAC_SOCK`,
    `PI_MCP_CLI_SOCK`.
- **No dataset, no task generator, no verifiers.** There are bench-grade's 10 tasks and
  the probes' ad-hoc checks. Request bodies are tapped but responses are not.
- **No single intervention counter.** Every guard reports in its own way.
- **No state-level (replay) eval.** `tool-cli-eval` covers six tasks in a toy tool
  universe.
- **No export path that keeps MTP.** `transformers` drops `mtp.*` on load.
- **No catalog notion of "tuned for this harness"** and no harness-spec version.
- **No hosting.** The HF token on disk is read-only; this is the same block the OmniSVG
  connector hit.
- **Roadmap conflict.** `ROADMAP-LATEST.md` puts fine-tuning "strictly after" Linux/
  Windows and clustering. The user's request now asks for it (open question Q1).

---

## 3. External research

### 3.1 The base: Qwen3.5-4B

Source: the [model card](https://huggingface.co/Qwen/Qwen3.5-4B).

- **Release and licence:** released 2026-03-02 (per the QwenLM release list; the card
  says February 2026), **Apache-2.0**.
- **Architecture:** 32 layers = `8 × (3 × (Gated DeltaNet → FFN) → 1 × (Gated Attention
  → FFN))`; hidden size 2560; FFN 9216.
  - DeltaNet: 32 V heads / 16 QK heads.
  - Gated attention: 16 Q / 4 KV heads, head dimension 256.
- **Tokenizer and context:** vocabulary **248,320** (padded, tied embeddings); native
  context 262,144.
- **Capabilities:** natively multimodal; MTP "trained with multi-steps".
- **Thinking:** on by default; disabled with `chat_template_kwargs:{enable_thinking:false}`.
- **Recommended sampling:**
  - thinking, general: 1.0 / 0.95 / top-k 20 / presence 1.5;
  - thinking, coding: 0.6 / 0.95 / 20 / 0.
- **Tool parser:** `qwen3_coder` (XML `<function=…><parameter=…>`).

**Published agent scores, 4B vs 9B:**

| Benchmark | 4B | 9B |
|---|---|---|
| BFCL-V4 | **50.3** | 66.1 |
| TAU2 | 79.9 | 79.1 |
| IFEval | 89.8 | 91.5 |
| IFBench | 59.2 | 64.5 |
| OSWorld-Verified | 35.6 | 41.8 |

Structured function calling is the 4B's weak spot. That is precisely what this track
targets.

**No newer small base exists.** The [Qwen3.8 repo](https://github.com/QwenLM/Qwen3.8)
lists:

- Qwen3.6: 35B-A3B and 27B;
- Qwen3.8: 27B and 2.4T-A95B.

Nothing is under 10B, so Qwen3.5-4B remains the right base. The pipeline is
model-agnostic and could later train the 2B or the 9B.

### 3.2 Teachers (licence-clean, same tokenizer)

| Teacher | Licence | Tokenizer | Agentic scores | Role |
|---|---|---|---|---|
| [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) | Apache-2.0 | 248,320 (same size) | Terminal Bench 2.1 **73.0**, SWE-bench Pro 61.7, OSWorld-Verified 84.3; `reasoning_effort` xhigh / medium / low | trajectory generation |
| [Qwen3.5-27B](https://huggingface.co/Qwen/Qwen3.5-27B) | Apache-2.0 | 248,320; same template generation as the 4B | BFCL-V4 68.5, Terminal Bench 2 41.6, SWE-bench Verified 72.4 | per-token teacher for on-policy distillation (identical template makes teacher logprobs exact) |
| Qwen3.5-397B-A17B | Apache-2.0 (series) | same | strongest | optional, for a hard-task subset |

**Tokenizer check still to do.** Equal vocabulary size is necessary but not sufficient.
`tokenizer.json` and the special tokens must be hashed and compared (WP-10). Same-family
teachers make logit-level distillation possible, which a different family would not.

**Frontier APIs (Claude, GPT) are excluded as teachers for shipped weights.** Their terms
restrict using outputs to build competing models. For example, the APIGen-MT dataset
card warns that its GPT-4-generated part "should not be used to develop models that
compete with OpenAI"
([card](https://huggingface.co/datasets/Salesforce/APIGen-MT-5k)).

**Pick the teacher by student outcome, not leaderboard.** A June 2026 study of terminal
agents found a "pedagogical paradox": students trained on DeepSeek-V3.2 trajectories
generalised better than students trained on the higher-scoring Claude Opus 4.6's. What
mattered was trajectories with "inspect-act-verify behaviors through harness-visible
interactions" ([arXiv 2606.03461](https://arxiv.org/abs/2606.03461)). 15.3k such
trajectories took Qwen3-32B to 24.3% on Terminal-Bench 2.0. So WP-10 runs a small
teacher bake-off.

### 3.3 Agentic fine-tuning recipes, and what we take from each

**Trajectory SFT with rejection sampling:**

- **SWE-smith** ([arXiv 2504.21798](https://arxiv.org/abs/2504.21798)) synthesises
  50k task instances from 128 repos by breaking tests. SWE-agent-LM-32B reached 40.2%
  on SWE-bench Verified.
  → *We take: generate tasks from the environment, keep only verified successes, and
  inject faults to create recovery tasks.*
- **Tmax** ([arXiv 2606.23321](https://arxiv.org/abs/2606.23321)): a taxonomy of
  difficulty control + personas + diverse verifiers, SFT then outcome-only RL. A 9B
  reached 27% on Terminal-Bench 2.0. Data, models and code are released; the paper is
  CC-BY-4.0, and the dataset's licence still needs checking.
  → *We take: that taxonomy shape.*

**Synthetic multi-turn tasks and simulated users:**

- **APIGen-MT** ([arXiv 2504.03601](https://arxiv.org/abs/2504.03601)): task blueprints
  with ground-truth actions, reviewed by an LLM committee, then turned into trajectories
  by simulated human-agent play. xLAM-2 (1B–70B) beat GPT-4o on τ-bench and BFCL.
  → *We take: a simulated user for `coordinate ask` and follow-up turns.*
- **ToolACE** ([dataset](https://huggingface.co/datasets/Team-ACE/ToolACE), Apache-2.0):
  26,507 synthesised APIs with dual-layer (rule + model) verification.
- **Toucan-1.5M** ([arXiv 2510.01179](https://arxiv.org/abs/2510.01179)): 1.5M
  trajectories from 495 real MCP servers, generated by open teachers (GPT-OSS-120B,
  Kimi-K2, Qwen3-32B) and released permissively.
  → *We take, from ToolACE and Toucan: an optional general tool-use supplement, licence
  permitting.*

**Data composition:**

- **Agent-FLAN** ([arXiv 2403.12881](https://arxiv.org/abs/2403.12881)): format-following
  and reasoning are entangled and learned at different speeds; constructed negative
  samples reduce hallucinated tool use; general ability slightly improves.
- **AgentTuning** ([arXiv 2310.12823](https://arxiv.org/abs/2310.12823)): mix general
  data in, to keep general ability.
- **Unsloth's Qwen3.5 guidance:** keep **≥75% reasoning examples** to preserve thinking.
  → *We take: about 15% no-tool / general turns, under the harness prompt.*

**Learning from failures:**

- **ETO** ([arXiv 2403.02502](https://arxiv.org/abs/2403.02502)): failure trajectories
  become contrastive pairs, trained with DPO, iteratively.
- **KTO** ([arXiv 2402.01306](https://arxiv.org/abs/2402.01306)) handles *unpaired*
  good/bad labels.
- **ORPO** ([arXiv 2403.07691](https://arxiv.org/abs/2403.07691)) is a single-stage
  alternative.
  → *We take: step-level pairs mined at guard firings.*

**On-policy distillation.** In the
[Thinking Machines write-up](https://thinkingmachines.ai/blog/on-policy-distillation/)
(same idea as GKD, [arXiv 2306.13649](https://arxiv.org/abs/2306.13649)), the student
samples and the teacher grades every token by reverse KL. Findings:

- 9–30× cheaper than scaling SFT, or RL, to the same AIME score.
- A LoRA r=32 gap to full fine-tuning shrank from 13% to 6%.
- **After domain training cut IF-eval from 85 to 79, on-policy distillation restored it
  to 83 without losing the new knowledge.**

→ *We take: this as stage B. It is exactly the fix for "tuned on tools, got worse at
chat."*

**Reinforcement learning:**

- **Jan-nano** ([paper](https://huggingface.co/papers/2506.22760)): Qwen3-4B trained with
  multi-stage RLVR using DAPO ([arXiv 2503.14476](https://arxiv.org/abs/2503.14476)), no
  SFT, reached 83.2% SimpleQA via MCP (59.2% base).
- **ART** ([repo](https://github.com/openpipe/art), Apache-2.0) routes the agent's
  completions to an OpenAI-compatible server that runs the *latest LoRA* in vLLM, with
  GRPO and an LLM-judge reward (RULER). It supports Qwen3.8-27B-class hybrids. **This
  matches Bobble's `baseUrl` seam exactly.**
- **verl-agent / GiGPO** ([repo](https://github.com/langfengq/verl-agent)): group
  environments for GRPO.
  → *We take: a later stage for families with verifiable outcomes.*

**LoRA practice** ([LoRA Without Regret](https://thinkingmachines.ai/blog/lora/)):

- LoRA matches full fine-tuning while capacity suffices.
- Apply it to **all** layers, especially the MLPs; attention-only LoRA underperforms.
- The best learning rate is about **10×** the full fine-tuning rate.
- LoRA is **less tolerant of large batches**.
- For RL, even rank 1 works.

### 3.4 Datasets and licences (for shipped weights)

| Dataset | Licence | Usable? |
|---|---|---|
| APIGen-MT-5k / xLAM data | **CC-BY-NC-4.0** + "don't compete with OpenAI" | **No** |
| ToolACE | Apache-2.0 | Yes (general function-calling supplement) |
| Toucan-1.5M | permissive (per paper); open teachers | Yes, after checking the card's licence field |
| Tmax terminal data | released openly; the paper is CC-BY-4.0, the dataset's own licence is **to verify** | Likely, with attribution |
| Our own gym data | ours; teacher Apache-2.0 | Yes: the core |

### 3.5 MTP after a LoRA: can it keep working?

**Yes structurally; not automatically; and acceptance drifts unless re-tuned.**

1. **`transformers` drops the head.** `Qwen3_5PreTrainedModel` declares
   `_keys_to_ignore_on_load_unexpected = [r"^mtp.*"]`
   ([modeling_qwen3_5.py](https://raw.githubusercontent.com/huggingface/transformers/main/src/transformers/models/qwen3_5/modeling_qwen3_5.py)).
   Anything that loads and re-saves through `transformers` loses the head unless the
   exporter copies `mtp.*` from the original shards.
2. **It can survive.** A Qwen3.8-27B LoRA (r=32, Unsloth, merged to 16-bit, converted
   with llama.cpp) reports that "the Multi-Token Prediction head from the base model
   (`blk.64.nextn.*`) survives the LoRA merge and GGUF conversion intact". Decode went
   64.6 → 104.2 tok/s on an H100
   ([card](https://huggingface.co/rico03/Qwen3.8-27B-Claude-Opus-Reasoning-Distilled-GGUF)).
   For our 4B the corresponding tensors are `blk.32.nextn.*` (§2.4).
3. **Acceptance drifts.** The head reads the trunk's last hidden state plus the next
   token's embedding. A LoRA shifts both the hidden states and the target distribution.
   The fix is **FastMTP-style re-tuning** in
   [`speculators` 0.6.0](https://github.com/vllm-project/speculators):
   - it trains the shipped head the way servers use it (recursively), on the **target
     model's own generations**;
   - Qwen3.5 is supported (there is a `mtp_qwen3_5_9b_gsm8k_online.sh` example);
   - 5k samples took 443 s on 2×H200;
   - acceptance at positions 0 / 1 / 2 rose 0.897 → 0.912, 0.719 → 0.776,
     0.476 → 0.616, measured on Qwen3-Next-80B-A3B
     ([Red Hat write-up](https://developers.redhat.com/articles/2026/09/08/optimize-vllm-speculative-decoding-fastmtp-heads)).
4. **MLX-specific traps:**
   - mlx-lm strips MTP at load. Native MTP ([PR #990](https://github.com/ml-explore/mlx-lm/pull/990))
     is **still unmerged** (27B on an M4 Pro: 1.57×, 85–88% acceptance).
   - `mlx_lm.fuse` drops MTP *and* re-quantizes with defaults.
   - Keeping `mtp.*` inline in an MLX checkpoint double-shifts the backbone norms
     ([MLX LoRA write-up](https://dev.to/mihai_leanzero/how-to-fine-tune-qwen38-27b-with-lora-on-a-mac-mlx-fine-tuning-from-scratch-2kl4)).
     So the MTP head stays a **sidecar**. That is what mlx-community does and what
     rapid-mlx expects (`{"method":"mtp","model":<dir>}`).
5. **What it means for us.** MTP is worth +35% on llama.cpp here (36 → 48.5) and slightly
   negative on rapid-mlx (55 → 50.6), so the head is a llama.cpp (and cross-platform)
   concern. The DFlash drafters (`z-lab/…`, `Anbeeld/…`) were trained against the base
   model. Drop them for the tuned model: llama.cpp DFlash was already slower (29 tok/s).
   Retraining an MLX drafter is later work.

### 3.6 Where to train

**Rented GPU with [Unsloth](https://unsloth.ai/docs/models/qwen3.5/fine-tune):**

- Supports Qwen3.5 from 0.8B to 397B.
- **4B bf16 LoRA needs about 10 GB VRAM.**
- 4-bit QLoRA is **not recommended** for Qwen3.5 (quantization error).
- Requires `transformers` v5.
- Exports GGUF (q8_0 / q4_k_m / f16) and merged 16-bit. vLLM ≤0.16 lacks Qwen3.5.
- **Its documented target list** (`q_proj … o_proj`, `gate/up/down_proj`) only reaches
  the 8 full-attention mixers plus the MLPs. The DeltaNet mixers in 24 of 32 layers
  (`in_proj_qkv`, `in_proj_z`, `in_proj_b`, `in_proj_a`, `out_proj`) must be added
  explicitly; we ablate that in WP-13.

**On the Mac with MLX.** mlx-lm 0.31.3 trains LoRA on the hybrid. The reference recipe
(Qwen3.8-27B, rank 32 on 16 layers, including `linear_attn.in_proj_qkv` / `out_proj`):

- 113–117 tok/s on an M3 Ultra with a patch, about 50 stock;
- 11.35 h for 4.6M tokens;
- needs `MLX_DISABLE_COMPILE=1`;
- merge by dequantize → add → requantize, and build 4/6-bit from the merged bf16;
- export gate: KL ≤ 0.067 with ≥90% top-1 agreement;
- filter over-length samples, never truncate.

[mlx-tune](https://github.com/ARahim3/mlx-tune) (Apache-2.0) wraps SFT, DPO, ORPO, KTO
and GRPO behind an Unsloth-like API and lists Qwen3.5.

**Estimated cost of one iteration**, about 10k trajectories, about 80M tokens per epoch:

| Stage | Rented GPU (H100 80 GB, ~$2–4/GPU-h) | M5 Pro 24 GB (MLX) |
|---|---|---|
| Teacher rollouts (Qwen3.8-27B bf16, vLLM; ~80M output tokens) | 12–24 GPU-h → **~$30–100** | not feasible (27B runs at ~16 tok/s here) |
| SFT (4B bf16 LoRA, 2 epochs, ≤32k context) | 3–6 GPU-h → ~$10–25 | ~3–4 days of machine time (extrapolated), and it is the user's machine |
| On-policy distillation (student rollouts + teacher logprobs + update) | 4–8 GPU-h → ~$20–40 | no (needs the teacher) |
| MTP re-tune | <1 GPU-h | no |
| **Per iteration** | **~$100–300** | experiments only |

All figures are estimates to be replaced by WP-10 measurements.

**Conclusion.** Train remotely: a rented box, or a CUDA machine the user owns, reached over
Tailscale (Track 5). The Mac is the real target engine, so it runs the release evals and
overnight student rollouts, but only when plugged in (today's battery incident). This
also honours the roadmap's reason for putting fine-tuning last: "needs the other
hardware".

### 3.7 Export and runtime facts

- **GGUF LoRA adapters are blocked upstream.** `convert_lora_to_gguf.py` fails on
  Qwen3.5 in `_reorder_v_heads` ([llama.cpp #21125](https://github.com/ggml-org/llama.cpp/issues/21125),
  open). **Ship merged weights.** A download-only-the-adapter path waits on that issue.
- llama-server's **`/apply-template`** returns the rendered prompt. That is a byte-parity
  oracle for our training renderer.
- **`/metrics`** exposes `llamacpp:spec_decode_num_accepted_tokens_total` and
  `…num_drafts_total`, which is how MTP acceptance gets measured
  ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)).

### 3.8 External benchmarks (optional, not v1 gates)

- BFCL-V4 and τ2-bench: the Qwen card's own numbers.
- **Terminal-Bench 2.x** via [Harbor](https://github.com/harbor-framework/terminal-bench-2-1).
  A custom agent subclasses `BaseAgent` / `BaseInstalledAgent`, so pi plus the Bobble
  extensions could run as an agent. That gives an outside number for "is the tuned 4B a
  better terminal agent in our harness".

### 3.9 What this means for Bobble

1. **Data must come from our harness running for real.** Our value is in harness-shaped
   supervision: `--help`-first discovery, `present`, the guards' wording, relative paths,
   inspect-act-verify. Generic tool data can at most be a small supplement.
2. **Render with our exact patched template, thinking on and preserved.** Because of the
   preserve-thinking patch, one rendered trajectory is one training sample with the
   correct context for every turn. Qwen's stock template would drop earlier thinking and
   force one sample per turn.
3. **LoRA on all language layers, bf16, remotely. Merged export, MTP kept and re-tuned.
   Projector reused unchanged.**
4. **SFT first, then on-policy distillation** against a same-template teacher, to recover
   chat and IF ability, then preference pairs mined from guard firings. RL later, on
   verifiable families only.
5. **Gate on what users actually get:** the real app, llama.cpp and rapid-mlx, the app's
   sampling, headless.

---

## 4. Design

### 4.1 The pipeline at a glance

```text
              ┌─────────── live repo @ commit X ────────────┐
              │ harness + extensions + CLI + prompts        │
              └──────────────┬──────────────────────────────┘
                             │ (same TS code, no Electron)
 task generator ──tasks──▶ harness-gym (N sandboxes, throwaway HOMEs, headless bridge host,
 (taxonomy, personas,        │         web cassette, fault injection, simulated user)
  verifiers, decontam)       │  OpenAI API
                             ▼
                        traj-proxy ──▶ teacher (vLLM: Qwen3.8-27B / Qwen3.5-27B)
                             │ records {request body, response, usage} per call
                             ▼
             verifier + judge ──▶ keep / mask / mine pairs
                             ▼
        renderer (app's patched Qwen3.5 template, thinking on + preserved) ──▶ SFT set
                             ▼
   A: SFT (bf16 LoRA)  →  B: on-policy distillation  →  C: step-DPO/KTO  →  (D: GRPO later)
                             ▼
   export: merge → re-attach mtp.* → FastMTP re-tune → GGUF Q8_0/Q6_K(imatrix) + mmproj
           → MLX 8-bit (with vision tower) + MTP sidecar → shas + model card
                             ▼
   gates: replay · tool-cli-eval · gym held-out · real app headless · regressions · speed
                             ▼
   catalog `bobble-4b` → recommender / onboarding / quick menu → users
                             ▼
   drift monitor (nightly replay on harness change) ──▶ regenerate + retrain
```

### 4.2 Ground rules

- **Fidelity over convenience.** Training contexts are byte-for-byte what the app sends:
  the same prompt code, the same template patch, the same tools. The acceptance tests
  compare against real app captures (`dump-system-prompt.mjs`, `PI_DIAG_PROMPTS_FULL`),
  not against a hand-written prompt.
- **No per-model harness.** The tuned model gets the prompt every model gets. Guards
  stay. (The user: "a rule that fires 80% of the time on everything beats one that fires
  100% of the time on Godot.")
- **Licence-clean.** Only Apache-2.0 / MIT / CC-BY teachers and data for anything
  shipped. No frontier-API outputs. No NC datasets.
- **No personal data.** the user's ~380 pi sessions (32 MB) may be *mined for failure
  patterns* with their consent (Q8), never used as training text. Personal connectors run
  on mock data. Computer use runs on apps without personal content, or under a dedicated
  macOS user.
- **Never on the user's screen, never on battery.** Every Mac-side run uses `launchApp`
  (invisible, focus guard) or no GUI at all. Runners check
  `pmset -g batt | grep -q 'AC Power'` before starting. Prefill/TTFT is checked
  (`user-always-check-prefill`). UI changes carry before/after screenshots.
- **Benchmarks stay verbatim and held out.** `corp-benchmarks.md`, deep-tasks,
  bench-tasks, tool-cli-eval and canvas-assess prompts never enter training data
  (13-gram plus embedding decontamination).

### 4.3 The environment: `harness-gym` (headless, macOS + Linux)

**A new package, `packages/harness-gym/`.** It runs one task as one sandboxed pi session
with the **same extension paths the app loads**:

- `provider-llamacpp`, `provider-afm`, `provider-mlx`, `harness`, `web-tools`,
  `browser-use`, `mac-connectors`, `mac-computer-use`, `mcp-lite`, `gen-tools`
  (`apps/desktop/electron/pi/extension-dirs.ts`);
- launched with `--no-extensions --no-skills`, exactly like `pi-main.ts`;
- or in-process through `createAgentSession`, like `corp/role-agent.ts`.

**Env mirrors `buildPiEnv`:**

- `PI_DESKTOP_TOOL_CLI=1`;
- `PI_DESKTOP_FS_FENCE=1`;
- `PI_DESKTOP_WORKSPACE_ROOT=<sandbox>`;
- `PI_DIAG_PROMPTS(+_FULL)`;
- the group gates, randomised per task so the prompt varies like real machines.

Each task gets a throwaway HOME (the `probeHome` pattern). It dies on explicit signals:
turn end, a wall-clock cap, the loop-detector abort. It never waits on stillness
(`user-measurement-mistakes` #1).

**The headless bridge host** implements the app's bridge sockets in plain Node:

| Group / bridge | v1 backend | Fidelity note |
|---|---|---|
| `file`, `bash`, `machine python` | real | identical |
| `office` (make / edit / inspect) | real `tools/office-gen` pipeline (Python) | identical |
| `chart` / `chart edit` | real | identical |
| `web search` / `web fetch` | **cassette**: recorded once at a polite rate (or via Brave API, Q12), replayed by key | the real parsers run; DuckDuckGo HTML scraping at scale would be rate-limited |
| `browser` | Playwright headless Chromium behind `PI_BROWSER_AGENT_SOCK`, on local test sites + cassette pages | same protocol (`packages/browser-use/src/protocol.ts`) |
| `media` (image / video / speech / music / sfx / edit) | `PI_GEN_SOCK` host returning canned assets of the right type, through the real gen-tools client | the result text must equal the real service's; golden-captured once from the app |
| `svg` | canned SVGs with OmniSVG's decimal `viewBox` signature | the same result text |
| `3d` | canned `.glb` through `PI_DESKTOP_GEN3D_SOCK` | the same result text |
| `coordinate present` | `PI_DESKTOP_PRESENT_SOCK` host returning the same text preview the app returns on a blind server (office outline, etc.) | |
| `coordinate delegate` / `manager` | the subagent host spawns child gym sessions (`PI_DESKTOP_SPECIALIST`); manager runs capped | |
| `coordinate ask` | **simulated user** (teacher with a user-sim prompt and the task's hidden facts) or the real "No answer came back…" string | from APIGen-MT |
| `personal` (calendar / mail / reminders / contacts / messages) | mock connector DB with synthetic people and events | no real data, ever |
| `mac` / `chrome` | v1: **real-app slice** on the Mac. v2: a simulator replaying recorded Accessibility trees for ~5 apps (`packages/mac-computer-use/src/protocol.ts`) | Linux cannot run `pi-mac` |
| `mcp` | fake MCP servers (a Notion-like and a Jira-like) | |

**Fault injection** is the SWE-smith idea applied to our environment. A task plan can make
a call fail once with the **real** error text:

- guardian shed ("…shed…");
- timeout;
- `missing --prompt` (from `resolveCli`);
- `no such command` with near misses;
- an edit mismatch with the `edit-diagnosis` note;
- EACCES on a slipped root slash.

Trajectories then contain recoveries.

### 4.4 Recording: `traj-proxy`, plus the app's own tap

**An OpenAI-compatible streaming proxy** sits in front of the teacher. Per call it records:

- the task id (from an `x-bobble-task` header the gym sets);
- the **request body as sent** (system prompt, the four tools, messages including private
  steers and compaction summaries);
- the reassembled response (`reasoning_content`, `content`, `tool_calls`, finish reason);
- usage and timings.

It labels warm-up and utility-lane requests (titler, fixer, reviewer) and keeps them
**out** of agent trajectories; they feed the utility regression set instead. It also
shapes fields for vLLM (drops llama.cpp-only fields; provider-mlx's
`shapeForOpenAiServer` already does this for array-form `logit_bias`).

**Segmenting a trajectory.** A session becomes one sample per segment. A new segment
starts whenever the next request's messages are *not* an extension of the previous one
(compaction, context trim). The last request of a segment plus its response is the
sample.

**Real-app runs need no proxy.** `PI_DIAG_PROMPTS_FULL=1` already writes
`<file>.bodies.jsonl`. This is how the replay-state library and the Mac slice are
harvested.

### 4.5 The task generator

**Inputs are taken from the live CLI**, never hand-copied: `tools`, every group's
`--help`, every command's `--help`. The teacher writes user requests from them across:

- personas (the Persona Hub style, [arXiv 2406.20094](https://arxiv.org/abs/2406.20094));
- a difficulty ladder;
- phrasing styles: terse, chatty, typos, "use <app>";
- ambiguity levels.

Every task carries a **verifier spec**:

- expected artifacts (globs + content checks);
- expected command classes (soft);
- a required final `coordinate present` on an existing path;
- forbidden patterns (`python-pptx`, PIL drawing, `open -a`, `curl … | grep`);
- a turn budget;
- for web questions, the answer key from the cassette.

**Target mix for v1** (shares of trajectories):

| Family | Examples | Share |
|---|---|---|
| Single command, fully specified | picture, speech, chart from numbers, docx memo | 15% |
| Single command, **underspecified** (must pick defaults, must not ask) | "a logo for my bakery", "some calm music" | 10% |
| Multi-step within a group | office make → edit → inspect; chart → chart edit | 10% |
| Cross-group workflows | web search → fetch → deck → present; svg assets → site files → present | 15% |
| Coding / shell / data | write + run a script; fix a fixture repo; CSV wrangling | 12% |
| Browser | navigate / read / click / type on local sites | 6% |
| Computer use + Chrome | Calculator / TextEdit / Notes-style (real slice, later simulator) | 6% |
| Personal connectors (mock) | list / create events, reminders, mail search | 4% |
| Coordination | plan for long tasks, delegate subagents, the manager for big builds, schedule | 6% |
| **Recovery** (fault-injected) | shed, timeout, missing flag, edit mismatch, no such command | 8% |
| **No-tool** under the harness prompt | arithmetic, explanations, writing, "what can you do" | 8% |

**Persona overlay:**

- 80% main chat;
- 10% specialists (`tester`, `image`, `document`, `research`, from
  `MESH_SPECIALIST_KINDS`);
- 5% schemas mode (so `specialistToolInterface: 'schemas'` users do not regress);
- 5% utility lanes, thinking off: titles, fixer JSON, bash-review verdicts, compaction
  summaries.

**Prompt variation per task:** date, folder name, which groups are present, effort level,
and whether vision is on.

### 4.6 Filtering, masking and rendering

**Keep a trajectory only if** all of these hold:

- the verifier passes;
- no loop-detector abort;
- the final reply's claims are backed by tool evidence (a teacher-judge pass, matching the
  harness's own verification spec);
- the process is sane: it presented when it produced something, used no forbidden
  pattern, and its reasoning stays within ~1,500 tokens per turn.

On the last point: with `preserve_thinking` on, every past `<think>` stays in a 32k
window, so concise thinking is a correctness issue, not taste.

**Among passing trajectories, prefer inspect → act → verify shapes**, as in the
Terminal-Lego finding.

**Masking:**

- Loss applies to **assistant tokens only**: reasoning + content + tool calls +
  `<|im_end|>`.
- Assistant turns that triggered a guard, or that a later turn undid, stay **in
  context** with **loss masked**. The model learns the recovery, not the mistake. The
  same turns feed the preference data (§4.7 stage C).

**The renderer (`tools/harness-lora/render.py`):**

- the official `Qwen/Qwen3.5-4B` `chat_template.jinja` with **the same two patches**
  `chat-template.ts` applies;
- rendered with `enable_thinking=True, preserve_thinking=True`, or thinking off for
  utility samples;
- tool-call argument JSON strings parsed to objects, as the server does.

Because of the preserved-thinking patch, one rendered trajectory equals the context of
every one of its turns. That is one sample per segment, not one per turn.

**Length:** over-length samples (>32,768 tokens after rendering) are **dropped, never
truncated**.

**Hygiene:** dedupe near-identical tasks; split train/val **by task family and
template**, so validation measures generalisation.

### 4.7 The training recipe

**Stage A: SFT.** Unsloth, bf16 LoRA:

| Setting | Value |
|---|---|
| Rank / alpha | r=64, α=64 |
| Targets | on all 32 language layers: `q_proj`, `k_proj`, `v_proj`, `o_proj` (8 attention layers); `in_proj_qkv`, `in_proj_z`, `out_proj` (+ `in_proj_a/b` in the ablation) (24 DeltaNet layers); `gate_proj`, `up_proj`, `down_proj` (all layers) |
| Frozen | embeddings / `lm_head` (tied, 248k vocab), the vision tower, the MTP head |
| Learning rate | 1e-4 cosine, warmup 3% (the ~10× rule) |
| Effective batch | 16 sequences (LoRA dislikes large batches) |
| Epochs | 2 |
| Max length | 32,768 |

Cross-sample **packing only if a test proves the DeltaNet kernels reset state at sequence
boundaries**: the loss on a packed batch must equal the per-sequence losses. Otherwise
use length-bucketed batches.

Checkpoints are selected by the replay eval (§4.8), not validation loss alone.

**Stage B: on-policy distillation.**

- The SFT student runs in the gym, served by vLLM with the LoRA.
- The Qwen3.5-27B teacher (identical template and tokenizer) scores the student's own
  tokens with `prompt_logprobs`.
- Loss is per-token reverse KL, applied as a policy-gradient advantage (the Thinking
  Machines recipe), or TRL GKD (λ=1, β=1) if the teacher fits beside the student.
- Mixed with 15–20% general prompts under the harness prompt, to recover IF/chat.

**Stage C: step-level preference.**

- From stage-B rollouts and overnight student runs on the Mac, take every guard firing
  followed by a recovery. Each gives a pair: *(state, the recovered action) ≻ (state, the
  guard-triggering action)*.
- DPO with β≈0.1, mixed with an SFT term.
- KTO for unpaired single-turn good/bad labels.

**Stage D (later): GRPO** with ART or verl-agent on verifiable families. The reward is the
verifier result minus small per-turn and per-intervention costs.

**MTP.** Re-tune the head with `speculators` FastMTP on ~5–10k tuned-model generations
(gym prompts). Then map the weights back to HF `mtp.*` names before GGUF conversion.

**Budget.** §3.6: about $100–300 per iteration, expected under $1k for v1 plus v1.1
including retries.

### 4.8 Evaluation and gates

**Evaluation tiers:**

| Tier | What | Where | Cost |
|---|---|---|---|
| 0 | Renderer parity vs llama-server `/apply-template`; mask checks; GGUF header checks | CI-style (pytest / vitest) | minutes |
| 1 | **Replay eval**: about 600 held-out decision states (request bodies from gym runs, real app runs, and the §2.2 failure states, e.g. the exact state where the 4B emitted `media generate image` as a tool name), 3 samples each at the app's sampling. Graded by rules: parse the call, run the real `resolveCli`, compare the action class, check for forbidden patterns | GPU box during iteration; **Mac llama.cpp + rapid-mlx for release** | hours |
| 2 | `tool-cli-eval.mjs` with the `cli-shipped` arm (6 tasks) | Mac | minutes |
| 3 | Gym held-out: 200 tasks × 2 seeds from held-out families and templates | GPU box | hours |
| 4 | Real app, headless: deep-tasks (10 × 3 seeds), tool-surface pass 3, long-task (24 parts), canvas-assess (the present rate), coordinate-cli, specialist-cli, engine-matrix (llama.cpp + rapid-mlx), calibrate, ttft, boot-to-instant | Mac, plugged in, overnight | overnight |
| 5 | Corp LocalConvert verbatim, allowed to finish | Mac | a report, not a gate |
| R | Regressions (see below) | GPU box + Mac | hours |

**The regression set (tier R):**

- IFEval;
- MMLU-Pro (a 500-question subset);
- GSM8K;
- the utility lanes:
  - titles accepted by `parseTitle`;
  - fixer JSON validity on the repair fixtures;
  - `flag-bash` verdict agreement with the base on 200 commands;
  - compaction summaries judged;
- 30 screenshot-QA items through the projector.

**Proposed release gates** (the user sets the final bar, Q11). The tuned model is compared
with the stock `qwen3.5-4b-mtp` under the same settings:

- **G0 format:** byte parity on 200 captured bodies; 0 unparseable tool calls in 1,000
  replay samples on both engines.
- **G1 replay:** acceptable-action rate ≥ base **+15 points**, and ≥ 85% overall.
  Forbidden-action rate ≤ ⅓ of base.
- **G2:** `tool-cli-eval` cli-shipped at 18/18, with 0 refusals.
- **G3 gym:**
  - success ≥ base **+15 points**;
  - **interventions per task ≤ 50% of base**;
  - median turns ≤ base;
  - tokens per task ≤ 1.1× base.
- **G4 real app:**
  - deep-tasks ≥ base on every task, median ≥ 9/10;
  - long-task 24/24;
  - present rate ≥ 18/23 (from 3/23);
  - probes green.
- **G5 no regression:**
  - IFEval ≥ base −1.0;
  - MMLU-Pro ≥ base −1.5;
  - GSM8K ≥ base −1.5;
  - utility lanes ≥ base;
  - vision QA ≥ base −1 item.
- **G6 speed:**
  - llama.cpp MTP acceptance (from `/metrics`) ≥ 90% of base;
  - decode tok/s ≥ 95% of base;
  - TTFT unchanged, since the prompt is identical.

**How interventions are counted.** An analyzer reads session JSONL plus diag logs and
counts the signatures of every catch:

- the `handmade-*` / `handwritten-svg` refusals;
- `coerced-write`;
- `raw-page-fetch`;
- decoy and `open`-wrapper redirects;
- `[pi-diag-unknown-tool]` translations;
- repair rungs;
- same-call, repeat-notice and loop-detector steers or aborts;
- edit diagnoses;
- the output-limit, handback and unfinished-plan nudges.

The same analyzer reports:

- present rate;
- help calls per task;
- turns;
- tokens;
- wall time.

### 4.9 Export and how it ships

**Artifacts** (one HF repo family, versioned by date and harness commit):

| Artifact | How |
|---|---|
| `Bobble-4B-Q8_0.gguf`, `Bobble-4B-Q6_K.gguf` | merged bf16 → `convert_hf_to_gguf.py` → `llama-quantize` with an **imatrix computed on held-out harness trajectories**. This fits the sub-12B policy: Q8_0 default, `Q6_K` is an accepted floor in `SUB12B_FLOOR_QUANTS` |
| embedded MTP | `mtp.*` re-attached, then FastMTP-re-tuned. The check: `block_count` 33, `nextn_predict_layers` 1, 15 `blk.32` tensors |
| `mmproj-F16.gguf` | **byte copy of the base projector** (the vision tower is unchanged), sha-checked |
| `Bobble-4B-MLX-8bit` | merged language weights **plus the base's vision tower**, so rapid-mlx's `--mllm` lane (`mlxTwinHasVision`) still sees. No inline `mtp.*` |
| `Bobble-4B-MTP-bf16` | MTP sidecar in the mlx-community layout |
| `chat_template.jinja` | pinned copy, identical to Qwen's, so a Qwen-side edit cannot silently change our format |
| adapter safetensors + configs + dataset card + scorecard | for reproducibility |

**Catalog entry** in `packages/inference/src/catalog.ts`. Bytes and shas are taken from
hub headers per the `pi-desktop-engine-twins-research` rule:

```ts
const BOBBLE: ModelPublisher = { handle: '<org>', reliable: true };
const BOBBLE_4B: CatalogModel = {
  id: 'bobble-4b',
  displayName: 'Bobble 4B',
  hfRepo: '<org>/Bobble-4B-GGUF',
  baseRepo: '<org>/Bobble-4B', // its chat_template.jinja (= Qwen3.5-4B's)
  files: [
    { name: 'Bobble-4B-Q8_0.gguf', bytes: /*HEAD*/ 0, quant: 'Q8_0', sha256: '…' },
    { name: 'Bobble-4B-Q6_K.gguf', bytes: /*HEAD*/ 0, quant: 'Q6_K', sha256: '…' },
  ],
  mmproj: { name: 'mmproj-F16.gguf', bytes: 672_423_488, quant: 'F16' }, // base projector
  mtpEmbedded: true,
  spec: 'mtp',
  variants: [{ method: 'mtp', embedded: true }], // no DFlash until a drafter is retrained
  mlxRepo: '<org>/Bobble-4B-MLX-8bit',
  mlxDrafts: [{ method: 'mtp', repo: '<org>/Bobble-4B-MTP-bf16' }],
  license: 'Apache-2.0',
  minRamGB: 6,
  contextWindow: 32_768,
  input: ['text', 'image'],
  verified: true,
  engine: 'llamacpp',
  publisher: BOBBLE,
  tier: 'fast',
  quantRange: 'Q6–Q8',
};
```

**Defaults, after the gates pass and the user agrees (Q6):**

- `recommender.ts`: `UTILITY`, `primaryFor('8GB')`, `tierTable(*).fast`;
- `llm-main.ts` `CORP_MODEL_ID`;
- `apps/desktop/src/onboarding/presets.ts` (`planPreset`) for new installs.

Qwen3.5-4B stays in the catalog as a fallback. Architecture and KV are identical, so
`corp/concurrency.ts` needs no new constants.

**What the user sees:**

- **Model hub / Recommended:** a "Bobble 4B" card.
  - Subtitle: "Qwen3.5 4B, tuned to use Bobble's tools".
  - Meta: `4.6 GB · Fast · Vision · Apache-2.0`.
  - A tinted "Tuned for Bobble" dot. Per the Unsloth-UI lesson, badges wrapped rows, so
    it is a dot, not a badge.
  - Our own dart mark. The logo rule forbids drawing others' marks; ours is fine.
- **The card expands to "What changed":** three or four measured lines from the release
  scorecard, e.g. "finished N% of Bobble tasks vs M%", "half as many corrections",
  "same speed".
- **Existing users with Qwen3.5-4B:** a quiet row on that model's card: "A Bobble-tuned
  version is available · Download 4.6 GB". No modal, **no auto-download**. After the
  download, a "Use by default" button rebinds the fast / utility slot; the base stays
  as a backup.
- **States:** Not downloaded · Downloading (the existing progress bar and popover) ·
  Ready · In use · *Update available*. The last appears when a newer harness-matched
  version ships; optionally a `tunedForHarness` field is compared with the app's harness
  spec version.
- **Settings:** nothing new. Tool interface stays where it is. Later, Track 3/7's
  training dashboard lists pipeline runs as a "Harness tune" recipe.
- **UI verification:** `model-card-look.mjs`, `quickmenu-probe.mjs`,
  `onboarding-probe.mjs`, `model-hub-curated-probe.mjs`, headless, with before/after
  screenshots.

### 4.10 Retraining and drift

A **drift monitor** runs the replay eval nightly (GPU box, or the Mac when plugged in)
whenever these change:

- `packages/harness/src/tools/tool-cli*.ts`;
- `presets/capabilities.ts`;
- `prompt/*.ts`;
- the preamble in `index.ts`;
- gen-tools descriptions.

It compares Bobble 4B with the base. If the advantage drops under +5 points, or a
forbidden-action rate rises, it adds a line to `STATUS.md` and the affected families are
regenerated and retrained. Every dataset row carries the harness commit.

**Keeping `--help` first is the generality hedge.** A model that still reads the help on
first use survives flag changes between releases. Q7 asks whether to trade that for speed.

### 4.11 Alternatives considered

| Alternative | Verdict |
|---|---|
| Keep tuning prompts only | **Do both.** Prompt work continues and the LoRA is complementary. The measured ceilings (BFCL-V4 50.3; 31→34/36; present 3/23) and the per-catch cost of guards justify it |
| Full fine-tune | Deferred. Higher forgetting risk for a model that also serves chat and utility; bigger artifacts; LoRA matches full fine-tuning at this data scale |
| QLoRA (4-bit) | Rejected: Unsloth advises against it for Qwen3.5 |
| Train on the M5 Pro (MLX) | Experiments only: days per full run, and it is the user's battery-limited machine |
| Claude/GPT as teacher | Rejected for shipped weights (terms) |
| APIGen-MT / xLAM data | Rejected (NC licence) |
| Ship an existing agent fine-tune (xLAM-2, ToolACE-2, Jan-nano) | Rejected: wrong base, format or licence; no MTP; not our CLI |
| RL first (Jan-nano style) | Later: needs verifiable rewards for every family and a fast environment; SFT and distillation first |
| Adapter-only download on top of the user's Qwen3.5-4B | Blocked upstream (#21125); slower than merged (1.13–1.22× per the MLX report); rapid-mlx adapter support unverified |
| Overwrite the Qwen3.5-4B catalog entry | Rejected: breaks sha verification, user choice and A/B |
| Grammar-constrain `bash` to our CLI | Rejected: the coercion history shows constrained wrong lists produce valid-but-wrong calls, and bash must stay free for real shell work |
| Context-distil the preamble away | Deferred: it forks the harness per model; revisit with v1 measurements |
| Train on the user's sessions | Rejected as text; failure-pattern mining only, with consent |

---

## 5. Work packages (ordered)

Every WP is verified headlessly. No window appears, no focus is taken, nothing runs on
battery.

**WP-01: Decisions and guardrails (S)**
- **Depends on:** none.
- **Files:** `STATUS.md` (a decision line).
- **Scope:** the user answers Q1–Q6: roadmap order, teacher policy, compute, name and
  hosting, licence, default switch.
- **Acceptance:** the answers are recorded.

**WP-02: Intervention and behaviour analyzer (S)**
- **Depends on:** none. It can baseline the stock model from existing probe outputs
  immediately.
- **Files:** `packages/harness-gym/src/analyze/interventions.ts` + tests.
- **Scope:** reads session JSONL, diag logs and bodies JSONL. Counts every guard
  signature listed in §4.8, plus present rate, help calls, turns, tokens and time.
  Guard strings are imported from the guard modules where exported, so they cannot drift.
- **Acceptance:** on 5 archived probe sessions, counts equal a hand count.
- **Verified by:** vitest fixtures taken from each guard's own messages.

**WP-03: harness-gym core runner (L)**
- **Depends on:** none.
- **Files:** `packages/harness-gym/` (new): `src/run-task.ts` (spawns `pi` with the
  app's `-e` list + `--no-extensions --no-skills`, or `createAgentSession` as in
  `role-agent.ts`), `src/env.ts` (a `buildPiEnv` mirror), `src/sandbox.ts` (throwaway
  HOME and workspace), `bin/run.mjs`, `Dockerfile`.
- **Acceptance:**
  - the deep-tasks "code" and "table" tasks complete against the base 4B on a local
    llama-server;
  - the system prompt equals a `dump-system-prompt.mjs` capture for the same settings
    (date and folder normalised);
  - exactly 4 advertised tools;
  - the same run completes in a Linux container.
- **Verified by:** vitest for the pure parts; scripted runs with no Electron and no GUI;
  a focus-guard check on the Mac.

**WP-04: Headless bridge host (L)**
- **Depends on:** WP-03.
- **Files:** `packages/harness-gym/src/host/{present,gen,gen3d,subagent,browser,mcp,personal}.ts`,
  ported from `apps/desktop/electron/pi/present-bridge.ts`, `pi/subagent-bridge.ts`,
  `gen/gen-manager.ts`, `gen3d/gen3d-bridge.ts` and the browser agent in `main.ts`,
  following `packages/browser-use/src/protocol.ts` and `gen-tools/src/gen-contract.ts`.
- **Acceptance:**
  - every command in `tool-surface-probe`'s pass-2 list runs through the gym with no
    "bridge not available";
  - result text matches golden captures from one real app run.
- **Verified by:** vitest golden tests; a gym surface run.

**WP-05: Web cassette (M)**
- **Depends on:** WP-03.
- **Files:** `packages/harness-gym/src/web-cassette/*`.
- **Scope:** record and replay for `web search` / `web fetch` and browser page loads,
  keyed by normalised query or URL; polite-rate or Brave-API recording.
- **Acceptance:** the deep-tasks "web" and "research-deck" tasks replay offline with
  identical tool outputs.
- **Verified by:** vitest; a container run with the network disabled.

**WP-06: traj-proxy (M)**
- **Depends on:** WP-03.
- **Files:** `packages/harness-gym/src/proxy/*`.
- **Scope:** streaming passthrough; per-call records; warm-up and utility labelling;
  vLLM field shaping; segmenting at non-extension points.
- **Acceptance:** for a gym run, the reconstructed trajectory equals the pi session
  JSONL's assistant and tool sequence (ids, arguments, text).
- **Verified by:** vitest with a fake upstream; one real-run diff.

**WP-07: Task generator + verifiers + decontamination (L)**
- **Depends on:** WP-04, WP-05.
- **Files:** `packages/harness-gym/src/tasks/*`, `src/verify/*`, `src/user-sim.ts`,
  `src/faults.ts`.
- **Scope:** the §4.5 taxonomy and shares; tasks generated from live `--help` pages;
  per-task verifier specs; simulated user; fault plans with real error strings; 13-gram
  plus embedding decontamination against every eval prompt set.
- **Acceptance:**
  - 1,000 sampled tasks validate;
  - 50-task spot review ≥90% sensible;
  - zero overlap with eval prompts.
- **Verified by:** vitest (verifiers on fixture workspaces); a decontamination report.

**WP-08: Renderer + dataset builder (M)**
- **Depends on:** WP-06.
- **Files:** `tools/harness-lora/` (new uv project, like `tools/office-gen`):
  `render.py`, `build_dataset.py`, `pyproject.toml`.
- **Scope:** the app's patched template (both `chat-template.ts` patches); thinking on +
  preserved (off for utility samples); argument-JSON → dict; loss masks with bad-turn
  masking; drop over-length samples; dedupe; family and template splits.
- **Acceptance:** byte-identical to llama-server `/apply-template` on 200 captured bodies
  (multi-turn, multi-query, thinking on and off); masks cover assistant spans only.
- **Verified by:** pytest; a parity script against a local llama-server (template only,
  no generation).

**WP-09: Eval harness + baseline (M)**
- **Depends on:** WP-02, WP-03, WP-08.
- **Files:**
  - `tools/harness-lora/eval/replay_eval.py`, plus a state-library builder from
    bodies JSONL;
  - a gym held-out runner;
  - `apps/desktop/tests/e2e/harness-lora-eval.mjs`, which wraps the §4.8 tier-4 probes
    with `MODEL=`, writes `scorecard.md`, and refuses to start on battery;
  - a regression suite (IFEval / MMLU-Pro subset / GSM8K against the llama-server
    OpenAI endpoint; utility fixtures; vision QA);
  - `tool-cli-eval.mjs` `DEFAULT_MODELS` gains the candidate.
- **Acceptance:** the base scorecard is produced twice, with seed variance reported.
- **Verified by:** the scorecard itself; probe screenshots in `SHOT_DIR`.

**WP-10: Teacher bake-off pilot (M)**
- **Depends on:** WP-07, WP-09.
- **Scope:**
  - 300 tasks × {Qwen3.8-27B at medium effort, Qwen3.5-27B} × 2 samples;
  - measure teacher throughput, success and reasoning length;
  - tiny LoRA per teacher, compared **on the student** (replay + gym subset);
  - tokenizer-identity check (hash `tokenizer.json` + special tokens).
- **Acceptance:** a teacher choice with numbers, and the §3.6 cost estimates replaced by
  measurements.

**WP-11: Data generation at scale (L)**
- **Depends on:** WP-10.
- **Scope:** about 4k tasks × 4 samples → about 8–10k kept trajectories plus recovery
  states; the no-tool / general set under the harness prompt; persona overlays; a
  dataset card with licence manifest and harness commit.
- **Acceptance:** family shares within ±3% of target; success rate by family reported;
  only Apache / MIT / CC-BY sources.

**WP-12: Computer-use slice (L)**
- **Depends on:** WP-04, WP-06, and the user's decision on a macOS training user (Q9).
- **Scope:**
  - real app, headless, on the Mac: `launchApp` with a throwaway HOME and the teacher
    reached over HTTPS / Tailscale; apps with no personal data (Calculator, TextEdit on
    fixtures, Maps public places, Finder in a sandbox) or a dedicated macOS user; about
    500 trajectories via `PI_DIAG_PROMPTS_FULL`;
  - v2: an Accessibility-tree simulator for about 5 apps from recorded snapshots.
- **Acceptance:** the focus guard never trips; no personal content in the data (scan);
  simulator outputs match recorded formats.

**WP-13: SFT v1 (M)**
- **Depends on:** WP-08, WP-11.
- **Files:** `tools/harness-lora/train_sft.py`, `configs/sft-v1.yaml`.
- **Scope:** the §4.7 stage-A recipe, plus two ablations: MLP+attention vs +DeltaNet
  projections, and r=32 vs r=64. The packing-equivalence test gates packing.
- **Acceptance:** the chosen checkpoint's replay score ≥ base +10 points, with no NaN or
  skipped steps.
- **Verified by:** training logs + replay eval on the GPU box.

**WP-14: Export with MTP + MLX (M)**
- **Depends on:** WP-13.
- **Files:** `tools/harness-lora/export.py`.
- **Scope:**
  - merge;
  - re-attach `mtp.*` from the base shards if missing;
  - convert to GGUF → Q8_0 / Q6_K with imatrix;
  - copy the base mmproj;
  - MLX 8-bit with the vision tower, plus the MTP sidecar;
  - pinned template, manifest with shas.
- **Acceptance:**
  - GGUF header: `qwen35`, `block_count` 33, `nextn_predict_layers` 1, 15 `blk.32`
    tensors;
  - llama-server with `--spec-type draft-mtp` shows accepted drafts > 0 in `/metrics`;
  - KL(Q8 GGUF vs adapter bf16) ≤ 0.07 with ≥90% top-1 agreement on 200 states;
  - rapid-mlx loads the trunk + sidecar and the `--mllm` lane.
- **Verified by:** the header reader (as used for this doc); server smoke tests with no
  UI.

**WP-15: MTP head re-tune (S)**
- **Depends on:** WP-14.
- **Scope:** `speculators` FastMTP on 5–10k tuned-model generations; map the weights to
  HF `mtp.*`; re-export.
- **Acceptance:** llama.cpp acceptance ≥ 90% of base; decode tok/s ≥ 95% of base
  (`calibrate-probe`).

**WP-16: v1 release gates (M)**
- **Depends on:** WP-09, WP-14, WP-15.
- **Scope:** the full scorecard, candidate vs base, on the GPU box and the Mac (plugged
  in, overnight). Writes `deliverables/harness-lora/scorecard-v1.md` with numbers and
  probe screenshots.
- **Acceptance:** G0–G6 pass, or the user waives specific gates.

**WP-17: Ship (M)**
- **Depends on:** WP-16, WP-01.
- **Files:**
  - `tools/harness-lora/upload.sh` (the OmniSVG `upload.sh` pattern; needs a write
    token) and the model card;
  - `packages/inference/src/catalog.ts` (entry + publisher);
  - `recommender.ts`;
  - `apps/desktop/electron/inference/llm-main.ts` (`CORP_MODEL_ID`);
  - `apps/desktop/src/models/recommended-catalog.ts`;
  - `apps/desktop/src/onboarding/presets.ts`;
  - `catalog.test.ts`, `recommender.test.ts`.
- **Acceptance:**
  - a headless app downloads it, verifies shas, calibrates and answers a real tool turn;
  - `engine-matrix-probe` `MODEL=bobble-4b` 12/12;
  - card states screenshotted before and after.

**WP-18: On-policy distillation, v1.1 (L)**
- **Depends on:** WP-16.
- **Scope:** §4.7 stage B.
- **Acceptance:** replay and gym ≥ v1 +5 points; IFEval ≥ base −0.5; G5 and G6 still
  pass.

**WP-19: Failure mining + step-DPO/KTO (M)**
- **Depends on:** WP-02, WP-18.
- **Scope:** overnight student runs on the Mac (plugged in) plus gym rollouts; pairs
  mined at guard → recovery points.
- **Acceptance:** interventions per task −30% vs v1.1 on the gym held-out set, with no
  gate regressions.

**WP-20: Drift monitor + retrain automation (M)**
- **Depends on:** WP-09, WP-17.
- **Scope:** a nightly replay when harness prompt or CLI files change; a `STATUS.md`
  line; one command to regenerate and retrain; version naming; hooks for the Track 3/7
  training dashboard.
- **Acceptance:** a deliberate command rename on a branch is flagged within one run.

**WP-21: GRPO on verifiable families (XL, optional)**
- **Depends on:** WP-18.
- **Scope:** ART or verl-agent against the gym; the reward is the verifier minus turn and
  intervention costs; reward-hacking audits.
- **Acceptance:** gym success ≥ v1.1 +5 points with no regressions.

**Critical path to a shippable v1:**
WP-01 → WP-03 → WP-04 / WP-05 / WP-06 → WP-07 / WP-08 → WP-09 → WP-10 → WP-11 → WP-13
→ WP-14 → WP-15 → WP-16 → WP-17.

WP-02 can start now and baselines the stock model from existing probe output.

---

## 6. Risks, blockers and open questions

### Blockers

1. **No training or teacher compute here.** The M5 Pro (24 GB) is shared,
   battery-limited, and too slow for the teacher. A rented GPU, or a CUDA machine the user
   owns reached over Tailscale, needs **the user** to set up the account and payment. I
   cannot create accounts or enter payment details.
2. **Publishing needs a Hugging Face write token.** The token at `$HF_HOME/token` is
   read-only; this is the same block the OmniSVG connector is waiting on.
3. **The roadmap says fine-tuning comes "strictly after" Linux/Windows and clustering**
   (`ROADMAP-LATEST.md` §6). The user's request implies a reorder; the user needs to confirm it.
4. **Upstream:** `convert_lora_to_gguf.py` is broken for Qwen3.5 (llama.cpp #21125, open).
   Adapter-only distribution is blocked; the merged path is not.
5. **Computer-use data needs real macOS apps and TCC grants.** Keeping personal data out
   needs a dedicated macOS user, or strictly no-personal-data apps. That is the user's action.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Harness drift.** Commands and prompt change weekly, and a model trained on commit N degrades by N+k | Data comes from the live harness; prompt variants; keep `--help` first; drift monitor (WP-20); cheap retrain; model versions tied to harness commits |
| **Environment fidelity.** Stubbed backends print different text from the real ones | Only the backend is stubbed; tool code is real; result strings are golden-captured from the app; the Mac slice and all release gates run the real app |
| **Vision mismatch.** v1 gym data is text-only while the app now defaults to vision on | Vision is frozen and the projector reused; the vision QA gate; v1.1 adds image-bearing trajectories with the multimodal teacher |
| **Forgetting** (chat, IF, utility lanes, corp role) | LoRA; 15% general mix; on-policy distillation stage (the IF-recovery evidence); G5 gates cover every lane the 4B serves |
| **Verbose teacher thinking** (latency, and context filling under `preserve_thinking`) | Teacher at medium effort; per-turn reasoning cap in filters; tokens/turn gate; OPD shortens toward the teacher's choices |
| **MTP acceptance loss** | FastMTP re-tune; G6 gate; drop DFlash variants until retrained |
| **Packing leaks recurrent state across samples** | Equivalence test gates packing; otherwise length-bucketed batches |
| **Grading against a copy of the target** (`user-measurement-mistakes`) | Decontamination; held-out families; verbatim benchmarks never trained on; release gates on the real app; LocalConvert reported, never tuned against |
| **Web scraping at scale** gets rate-limited, and DuckDuckGo's terms may object | Cassette replay; low-rate recording or an API key |
| **Licence** | Apache/MIT teachers only; dataset licence manifest per release; model card; the Apache-2.0 base carries NOTICE |
| **Distribution (default switch)** | Opt-in first; base kept as fallback; no auto-download |
| **Cost overrun** | WP-10 measures real throughput before scale-up; per-iteration budget cap agreed up front |

### Questions for the user

1. **Roadmap:** this jumps "autonomous fine-tuning" (roadmap item 6) ahead of Linux/
   Windows and clustering. Confirm we start now.
2. **Teacher policy:** open-weight Apache/MIT teachers only (Qwen3.8-27B, Qwen3.5-27B),
   and never Claude/GPT outputs, for anything we ship. Agreed?
3. **Compute:** rent GPUs (estimate ≈$100–300 per iteration, under $1k to v1.1), or do
   you own an NVIDIA machine we can reach over Tailscale (which GPU, how much VRAM)?
   Who sets up the account?
4. **Name and home:** "Bobble 4B"? Which HF account or org (Lavanuke? a new "bobble"
   org?), and will you supply a write token at ship time?
5. **Weights licence:** Apache-2.0, like the base? The repo is GPL-3.0; the weights are a
   separate artifact.
6. **Default:** once the gates pass, should it replace `qwen3.5-4b-mtp` as the
   fast / utility / corp default for new installs, while only being *offered* (never
   auto-downloaded) to existing users?
7. **`--help` first:** keep the trained model reading help on first use (robust to CLI
   changes), or let it skip help (one fewer round-trip per command)? Skipping means a
   prompt change.
8. **Your sessions:** may we mine your ~380 local pi sessions for failure *patterns*
   only, never as training text?
9. **Computer-use slice:** OK to run the real app headlessly on your Mac overnight, while
   plugged in, under a separate macOS user with synthetic data? Would you create that
   user?
10. **v1 scope:** main-chat CLI persona only, or specialists and corp roles and schemas
    mode too? The design includes small shares of each.
11. **Gate bar:** are the proposed thresholds right? (+15 points task success,
    interventions halved, speed within 5%, IFEval within 1 point.)
12. **Web data:** a Brave Search API key (paid) for recording the web cassette, or
    DuckDuckGo at a polite rate?

---

## Sources

**Qwen models:**
- [Qwen3.5-4B card](https://huggingface.co/Qwen/Qwen3.5-4B)
- [Qwen3.5-27B card](https://huggingface.co/Qwen/Qwen3.5-27B)
- [Qwen3.8-27B card](https://huggingface.co/Qwen/Qwen3.8-27B)
- [QwenLM/Qwen3.8 releases](https://github.com/QwenLM/Qwen3.8)

**Training tooling:**
- [Unsloth: Qwen3.5 fine-tuning guide](https://unsloth.ai/docs/models/qwen3.5/fine-tune)
- [transformers `modeling_qwen3_5.py`](https://raw.githubusercontent.com/huggingface/transformers/main/src/transformers/models/qwen3_5/modeling_qwen3_5.py)
- [MLX LoRA on Qwen3.8-27B, pitfalls and numbers](https://dev.to/mihai_leanzero/how-to-fine-tune-qwen38-27b-with-lora-on-a-mac-mlx-fine-tuning-from-scratch-2kl4)
- [mlx-tune](https://github.com/ARahim3/mlx-tune)

**MTP:**
- [rico03 Qwen3.8-27B distilled GGUF: MTP survives merge](https://huggingface.co/rico03/Qwen3.8-27B-Claude-Opus-Reasoning-Distilled-GGUF)
- [Red Hat: FastMTP heads](https://developers.redhat.com/articles/2026/09/08/optimize-vllm-speculative-decoding-fastmtp-heads)
- [vllm-project/speculators](https://github.com/vllm-project/speculators)
- [mlx-lm native MTP PR #990](https://github.com/ml-explore/mlx-lm/pull/990)

**llama.cpp:**
- [llama.cpp #21125: Qwen3.5 LoRA → GGUF conversion bug](https://github.com/ggml-org/llama.cpp/issues/21125)
- [llama.cpp server README: `/apply-template`, `/metrics`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

**Methods (Thinking Machines):**
- [On-policy distillation](https://thinkingmachines.ai/blog/on-policy-distillation/)
- [LoRA Without Regret](https://thinkingmachines.ai/blog/lora/)

**Data and recipe papers:**
- [APIGen-MT](https://arxiv.org/abs/2504.03601) and [APIGen-MT-5k licence](https://huggingface.co/datasets/Salesforce/APIGen-MT-5k)
- [ToolACE dataset](https://huggingface.co/datasets/Team-ACE/ToolACE)
- [Toucan-1.5M](https://arxiv.org/abs/2510.01179)
- [SWE-smith](https://arxiv.org/abs/2504.21798)
- [What makes trajectories effective for terminal agents (Terminal-Lego)](https://arxiv.org/abs/2606.03461)
- [Tmax](https://arxiv.org/abs/2606.23321)
- [ETO](https://arxiv.org/abs/2403.02502)
- [Agent-FLAN](https://arxiv.org/abs/2403.12881)
- [AgentTuning](https://arxiv.org/abs/2310.12823)
- [KTO](https://arxiv.org/abs/2402.01306)
- [ORPO](https://arxiv.org/abs/2403.07691)
- [GKD](https://arxiv.org/abs/2306.13649)
- [Persona Hub](https://arxiv.org/abs/2406.20094)

**RL:**
- [Jan-nano](https://huggingface.co/papers/2506.22760)
- [DAPO](https://arxiv.org/abs/2503.14476)
- [OpenPipe ART](https://github.com/openpipe/art)
- [verl-agent](https://github.com/langfengq/verl-agent)

**Benchmarks:**
- [Terminal-Bench 2.1 / Harbor](https://github.com/harbor-framework/terminal-bench-2-1)
