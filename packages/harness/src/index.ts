/**
 * @pi-desktop/harness — the Pi Desktop agent-harness pi extension (workstream W5).
 *
 * Loaded into a pi session via `-e /abs/path/to/packages/harness/src/index.ts`
 * (the default export is the extension factory). It wires:
 *
 *  - a tier-1 task classifier + toolset presets (setActiveTools per task),
 *  - an always-available `tool_search` tool,
 *  - permission modes (bypass / reviewer / review-all) on the tool_call gate,
 *  - the `/harness` command protocol + a published status JSON,
 *  - small-model warnings + a running-task timer.
 *
 * Repair ladder rungs 3–5 are exported (not auto-wired) — W3 plugs
 * {@link createHarnessExtraRungs} into the llama-server provider's `extraRungs`.
 *
 * Everything reusable is re-exported from this module so other workstreams and
 * CLI pi users can consume the pieces directly.
 */

import { appendFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { createBashToolDefinition } from '@mariozechner/pi-coding-agent';
import {
  type AsyncClassifier,
  type ClassifyInput,
  type ClassifyMessage,
  classify,
  TASK_CLASSES,
  type TaskClass,
} from './classify/classify.js';
import { createClassifierEscalation } from './classify/escalation.js';
import { modelTierForClass } from './classify/tier.js';
import { corpToolEnabled, registerCreateHierarchyTool } from './corp/promote-tool.js';
import { CREATE_PRODUCTION_HIERARCHY } from './corp/promotion.js';
import { effortKnobs, isEffortLevel } from './effort/effort.js';
import { HANDBACK_NUDGE, isChoiceHandback } from './loop/handback.js';
import { createLoopDetector, type LoopDetector, loopDetectorConfig } from './loop/loop-detector.js';
import { parseModelParams, smallModelWarning } from './model/model-size.js';
import { type CallModel, callModelFromEnv } from './model-call/call-model.js';
import { warmSystemPrompt } from './model-call/warmup.js';
import { createBashFlagger } from './permissions/flag-bash.js';
import {
  isPermissionMode,
  type PermissionController,
  registerPermissions,
} from './permissions/modes.js';
import { capabilityForTool } from './presets/capabilities.js';
import { resolvePresetTools } from './presets/presets.js';
import { augmentSystemPrompt } from './prompt/capability-prompt.js';
import { connectRepairBridge, type LiveRepairDeps } from './repair/bridge.js';
import { createToolCallFixer, withRepairAttempts } from './repair/fixer.js';
import {
  createHarnessExtraRungs,
  type HarnessRepairDeps,
  relaxToolSchema,
  type ToolSchemaLike,
} from './repair/rungs.js';
import { adversarialCheck, reviewOutput } from './review/review.js';
import { registerSkillInstructions } from './skills/skill-instructions.js';
import {
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_LOOP_ENTRY,
  HARNESS_REPAIR_ENTRY,
  HARNESS_REVIEW_ENTRY,
  HARNESS_TITLE_ENTRY,
  HARNESS_VERIFY_ENTRY,
  type HarnessConfig,
  type HarnessStage,
  type HarnessStatus,
  type PlanItem,
  restoreConfig,
  type StoredEntryLike,
  updateConfig,
} from './state.js';
import { subagentBridgeRunChildFromEnv } from './subagent/bridge-client.js';
import { detectBudget } from './subagent/budget.js';
import { type SchedulerSnapshot, SubagentScheduler } from './subagent/scheduler.js';
import { specialistFromEnv, specialistToolset } from './subagent/specialist-env.js';
import { registerSubagentTool } from './subagent/subagent-tool.js';
import { registerScheduledTaskTool } from './scheduled/schedule-tool.js';
import {
  HARNESS_SUBAGENTS_STATUS_KEY,
  type HarnessSubagentsStatus,
  MAX_SUBAGENT_DEPTH,
  readSubagentDepth,
} from './subagent/types.js';
import { registerAskUser } from './tools/ask-user.js';
import { registerCapabilityTool } from './tools/capability-tool.js';
import { diagnoseEditFailure } from './tools/edit-diagnosis.js';
import { wouldHang } from './tools/hang-guard.js';
import { registerImageTools } from './tools/image-tools.js';
import { applyBias, lastAssistantThought, planBias } from './tools/intent-bias.js';
import { detectOpenedApp, openedAppNote } from './tools/opened-app.js';
import { registerPlanTool } from './tools/plan-tool.js';
import { registerPresentTool } from './tools/present.js';
import { presentBridgeFromEnv } from './tools/present-bridge.js';
import { withRepeatNotice } from './tools/repeat-notice.js';
import { registerSandboxFileTools, resolveWorkspaceRoot } from './tools/sandbox-fs.js';
import { truncateToolOutput } from './tools/tool-output-truncate.js';
import { captureRegisteredTools } from './tools/tool-registry.js';
import { registerUseTool } from './tools/use-tool.js';
import { readmeIn, undemonstrated, workRootOf } from './verify/documented.js';
import {
  detectProjectCheck,
  emptyOutputs,
  makeExecBashRunner,
  makeFsProbe,
  neverExercised,
  type ProjectCheck,
  runVerifyPass,
  type VerifyBashRunner,
} from './verify/verify.js';

/** Seconds a command gets before the harness takes control back. */
export const DEFAULT_BASH_TIMEOUT_S = 300;

/**
 * EVERY COMMAND COMES BACK.
 *
 * pi's bash says so itself: "Timeout in seconds (optional, no default
 * timeout)". A command the model runs without one can block forever, and a
 * blocked command blocks the turn, and a blocked turn blocks the run.
 *
 * MEASURED, run 7: an engineer ran `electron .`, which opens a window and waits
 * for a human to close it. The run died at 66 minutes having never reached the
 * CEO's verification turn — five roles and nine contracts ended by one
 * foreground window.
 *
 * The first fix was a list of launcher names to refuse — electron, npm start,
 * yarn dev. the user killed it, correctly: "the deterministic guard here is again
 * something we need to let go of, how can you make this general and reliable."
 * A blocklist only ever catches the ones somebody already thought of, and it
 * refuses commands that might have been fine.
 *
 * A CLOCK CATCHES ALL OF THEM. It does not care what the command is, whether it
 * is a GUI, a server, an infinite loop, a wedged mount or something nobody has
 * seen yet — if it has not returned, control comes back anyway, pi kills the
 * process tree, and the model is told what happened and how to ask for longer.
 * That is general by construction, and it assumes nothing about the task.
 *
 * The model can still pass its own `timeout` for a genuinely long build; this
 * only supplies one when it did not.
 */
/**
 * BACKGROUND, AS A THING THE TOOL OFFERS.
 *
 * the user: "do all bash commands have background parameter set in the tool call
 * inputs by the way? that could be helpful. background true if this runs in the
 * background and doesn't block."
 *
 * pi's bash takes only `command` and `timeout`, so the ONLY way to background
 * something was to type `&` yourself — nothing in the tool's shape suggested
 * it, and a model that did not think of it discovered the problem by hanging.
 * A declared parameter is a prompt: it tells the model, at the point of use,
 * that "this one does not return" is an option it can choose deliberately.
 *
 * It rewrites rather than re-implements: `nohup <cmd> &` detaches the process,
 * output goes to a log the model is told about, and the call returns at once.
 */
export function withBackgroundOption<
  T extends { parameters?: unknown; execute: (...a: never[]) => unknown },
>(base: T): T {
  const params = base.parameters as
    | { properties?: Record<string, unknown>; type?: string }
    | undefined;
  const parameters =
    params?.properties === undefined
      ? base.parameters
      : {
          ...params,
          properties: {
            ...params.properties,
            background: {
              type: 'boolean',
              description:
                'Run this in the background and return immediately. Use it for anything that ' +
                'does not finish on its own — a server, a watcher, a GUI. Output goes to a log ' +
                'file whose path comes back in the result.',
            },
          },
        };
  return {
    ...base,
    parameters,
    async execute(...args: never[]) {
      const p = args[1] as Record<string, unknown> | undefined;
      if (p?.background === true && typeof p.command === 'string') {
        const log = `/tmp/pi-bg-${Date.now()}.log`;
        const { background: _drop, ...rest } = p;
        (args as unknown[])[1] = {
          ...rest,
          command: `nohup sh -c ${JSON.stringify(p.command)} > ${log} 2>&1 & echo "started in background (pid $!), output: ${log}"`,
        };
      }
      return (base.execute as (...a: never[]) => Promise<unknown>)(...args);
    },
  } as T;
}

export function withDefaultTimeout<T extends { execute: (...a: never[]) => unknown }>(
  base: T,
  seconds: number = DEFAULT_BASH_TIMEOUT_S,
): T {
  return {
    ...base,
    async execute(...args: never[]) {
      const params = args[1] as Record<string, unknown> | undefined;
      if (params !== undefined && params.timeout === undefined) {
        (args as unknown[])[1] = { ...params, timeout: seconds };
      }
      try {
        return await (base.execute as (...a: never[]) => Promise<unknown>)(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/^timeout:/.test(msg)) throw e;
        throw new Error(
          `That command did not finish within ${seconds}s, so it was stopped and control ` +
            'came back to you. Commands that open a window or start a server never return ' +
            'on their own — run those in the background with `&`, or drive the thing ' +
            'headlessly instead. If this is a genuinely long build, run it again and pass ' +
            'a bigger `timeout`.',
        );
      }
    },
  } as T;
}

export const packageName = '@pi-desktop/harness';

/**
 * Extension-status key carrying whether the system-prompt prefix is RESIDENT:
 * `'warming'` while the warm-up runs, `'ready'` once it has (or has failed).
 *
 * A named export because both ends must agree on the exact string and they live
 * in different processes — a renderer watching `harness-prefix-warm` while the
 * harness publishes `harness-warm-prefix` would simply never fire, and would
 * look exactly like a warm-up that never finished.
 */
export const PREFIX_WARM_STATUS = 'harness-prefix-warm';

interface HarnessRuntime {
  config: HarnessConfig;
  /**
   * THE WORKSPACE. One value, decided once per chat, that every tool resolves
   * against — write, edit, read, ls, bash, and anything a role or subagent runs.
   *
   * MUTABLE ON PURPOSE. It used to be fixed at spawn (the env / pi's cwd), so
   * changing the composer's folder dropdown mid-chat could not move the work
   * without respawning pi. the user: "you don't have to restart pi ... it's not like
   * functionally anything should need a restart just because we're essentially
   * typing into a terminal session cd '<changed working directory path>'."
   *
   * He is right, and pi supports it: our file tools already override pi's by
   * name and resolve their root per call, and pi's bash takes a `spawnHook` that
   * can rewrite cwd per command. So the root is a live value here, set by
   * `/harness workspace <path>` over the same channel that already carries
   * effort changes. Null until the app sets one — then the old spawn-time
   * resolution is the fallback, never the override.
   */
  workspaceRoot: string | null;
  activeClass: TaskClass | null;
  /** Conversation title from the classify+title piggyback (computed once). */
  title: string | null;
  /**
   * The STABLE system prompt reused byte-for-byte on every turn (and by the
   * warm-up), captured once at model-select / turn 1. pi regenerates its
   * tool-usage guidance non-deterministically per turn (lines reorder / add /
   * drop), which shifts the ~7k-char prompt and forces a FULL KV re-prefill on
   * EVERY message — the "slow prefill" the user hit. Freezing the system prompt keeps
   * the prefix identical so follow-ups (and the warmed first message) reuse it.
   */
  canonicalSystemPrompt: string | null;
  activeTools: string[];
  taskStart: number | null;
  turnIndex: number;
  model: { id: string; name?: string } | null;
  permission: PermissionController;
  statusTimer: ReturnType<typeof setInterval> | null;
  /** Latest event ctx, captured so repair rungs (fired inside the provider's
   * stream) can reach ctx.abort / ctx.ui.confirm for the active turn. */
  currentCtx: ExtensionContext | null;
  /** The prompt of the in-flight turn, for the reviewer pass. */
  lastPrompt: string;
  /** Skip the reviewer for the next turn (it's a revision we ourselves triggered). */
  suppressNextReview: boolean;
  /** The live task checklist from the `update_plan` tool (null before first use). */
  plan: PlanItem[] | null;
  /** Optional heading for the plan panel. */
  planTitle: string | null;
  /** Latest subagent scheduler snapshot (null until the first spawn_subagent). */
  subagentSnapshot: SchedulerSnapshot | null;
  /** Coarse lifecycle stage of the current turn (published in HarnessStatus). */
  stage: HarnessStage;
  /** Per-turn loop / no-progress detector (rebuilt each turn from effort knobs). */
  loopDetector: LoopDetector | null;
  /** Files the current agent loop wrote/edited (for the verify syntax fallback). */
  touchedFiles: string[];
  /** Commands this turn actually ran — the other half of "did you exercise it". */
  ranCommands: string[];
  /** This turn handed work to a subagent, whose commands never reach
   *  `ranCommands` — so "nothing was run" cannot be concluded. */
  delegatedThisTurn: boolean;
  /** One handback nudge per session — see the agent_end hook. */
  nudgedHandback: boolean;
  /** One-shot: the output-limit steer has already been sent this session. */
  nudgedOutputLimit: boolean;
  /** Remaining REAL-verify fix steers allowed in the active verify sequence. */
  verifyFixesRemaining: number;
  /** True while inside a self-triggered verify fix sequence (so the budget isn't reset). */
  verifyActive: boolean;
}

/** Options for {@link wireHarness}. All optional; the app passes none (`-e` load). */
export interface WireHarnessOptions {
  /**
   * The utility-model call powering the fixer, reviewer, and classifier
   * escalation. Omitted → built from env (`PI_DESKTOP_UTILITY_*`); still absent →
   * every model-dependent feature degrades to heuristic/skip.
   */
  readonly callModel?: CallModel;
  /**
   * Seams for the effort-gated REAL verify (fix #4). Omitted → built from
   * `pi.exec` + a node:fs probe over `ctx.cwd`. Tests inject a fake bash runner
   * and a stubbed check detector so the bounded-fix loop is exercised offline.
   */
  readonly verify?: {
    /** Run a shell command in the working dir. Default: `pi.exec` via `sh -c`. */
    readonly runBash?: VerifyBashRunner;
    /** Detect the project check for a cwd. Default: {@link detectProjectCheck}. */
    readonly detectCheck?: (cwd: string) => ProjectCheck | null;
  };
  /**
   * How long to wait after a reply before post-turn work (naming, the reviewer)
   * may touch the model. Default {@link POST_TURN_DELAY_MS}; tests pass 0 to run
   * it immediately.
   */
  readonly postTurnDelayMs?: number;
}

/** A handle returned by {@link wireHarness} for tests + programmatic wiring. */
export interface HarnessHandle {
  readonly controller: PermissionController;
  getConfig(): HarnessConfig;
  getStatus(ctx: ExtensionContext): HarnessStatus;
  applyPreset(cls: TaskClass, ctx: ExtensionContext): void;
  /** The live repair deps currently pushed to the provider (for tests/telemetry). */
  buildRepairDeps(): LiveRepairDeps;
  /** Run the reviewer/adversarial passes for a finished turn (effort-gated). */
  /** Critique the output and steer a revision if it finds real problems. Never
   * forced by an effort level any more — pass `request` to actually run passes. */
  reviewTurn(
    output: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    request?: { readonly passes?: number; readonly adversarial?: boolean },
  ): Promise<boolean>;
  /**
   * Run the effort-gated REAL verify for a finished coding/file-ops turn. Returns
   * true when it steered a fix back to the model (bounded per turn).
   */
  verifyTurn(ctx: ExtensionContext): Promise<boolean>;
}

function getEntries(ctx: ExtensionContext): StoredEntryLike[] {
  const sm = ctx.sessionManager as unknown as { getEntries?: () => StoredEntryLike[] };
  return sm.getEntries?.() ?? [];
}

/** Restore a persisted conversation title (last write wins), or null. */
function restoreTitle(entries: readonly StoredEntryLike[]): string | null {
  let title: string | null = null;
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== HARNESS_TITLE_ENTRY) continue;
    const data = e.data as { title?: unknown } | undefined;
    if (typeof data?.title === 'string' && data.title.length > 0) title = data.title;
  }
  return title;
}

/** Flatten a message's content (string | content blocks) to plain text. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Assemble the live conversation as [system, …user/assistant turns, current
 * prompt] so the tier-2 classify+title piggyback SHARES the exact prefix the
 * real turn will process — reusing the single-slot llama-server's KV cache
 * (round-10 #8). Tool-result / thinking blocks are dropped (they aren't
 * user/assistant text): a minor prefix-fidelity limit on tool-heavy turns; plain
 * text turns share fully. The heuristic tier-1 ignores this field.
 */
function buildConversationPrefix(
  entries: readonly StoredEntryLike[],
  systemPrompt: string,
  currentPrompt: string,
  /**
   * Whether to guarantee `currentPrompt` is the last message. True for callers
   * that run BEFORE the turn (pi may not have persisted the prompt as an entry
   * yet). False for post-turn callers — after the turn the entries already end
   * `[…user: prompt, assistant: reply]`, and appending the prompt again would
   * send it twice.
   */
  ensureLastUser = true,
): ClassifyMessage[] {
  const messages: ClassifyMessage[] = [];
  if (systemPrompt.trim().length > 0) messages.push({ role: 'system', content: systemPrompt });
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const msg = (e as { message?: { role?: unknown; content?: unknown } }).message;
    const role = msg?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(msg?.content).trim();
    if (text.length === 0) continue;
    messages.push({ role, content: text });
  }
  // Ensure the current user prompt is the LAST message — pi may not have
  // persisted it as an entry yet when before_agent_start fires.
  const last = messages.at(-1);
  if (ensureLastUser && !(last?.role === 'user' && last.content === currentPrompt)) {
    messages.push({ role: 'user', content: currentPrompt });
  }
  return messages;
}

/**
 * True when a prompt carries a folded attachment block (`Attached file
 * \`name\`:\n```\n…`, the shape the composer's buildAgentMessage produces for a
 * pasted block or dropped text file).
 *
 * Such a turn uses the DETERMINISTIC base
 * preset. Two reasons: (1) scoring a document's prose — or even a short "summarize
 * this" request — pulls in false-positive tools (a doc about arctic terns loaded
 * `web_search`; "summarize the key themes" loaded the whole browser pipeline via
 * `browser_read`); (2) any added tool grows the turn's tool block, which chat
 * templates render BEFORE the user message, shifting the attachment and breaking
 * ATTACHMENT PREFILL's KV reuse (the prefill primes the base preset, so a bigger
 * turn tool set → the whole attachment re-prefills). The model can still
 * tool_search for a genuinely-needed tool. Pure.
 */
export function hasAttachedFileBlock(prompt: string): boolean {
  return /Attached file `[^`\n]*`:\n```/.test(prompt);
}

function countRepairFailures(entries: readonly StoredEntryLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== HARNESS_REPAIR_ENTRY) continue;
    const data = e.data as { toolName?: unknown; ok?: unknown } | undefined;
    const toolName = typeof data?.toolName === 'string' ? data.toolName : undefined;
    if (toolName === undefined) continue;
    // Only the authoritative per-call outcome (onRepair) carries `ok`; count the
    // failures. Rung-trace and relaxed/success entries (no `ok:false`) are skipped
    // so a single failed tool call is counted exactly once.
    if (data?.ok !== false) continue;
    counts[toolName] = (counts[toolName] ?? 0) + 1;
  }
  return counts;
}

/**
 * How long after a reply lands before post-turn work (naming, the reviewer) may
 * touch the model.
 *
 * It shares ONE llama-server slot with the chat, so anything running here is
 * something the user's next message waits behind. Aborting on send is not enough
 * on its own: by then the request is already on the server, which finishes the
 * batch it started. A short pause first means a fast follow-up — the user's case,
 * "I typed a really quick follow up message and it took 1.5 seconds" — arrives
 * while nothing is running at all, and the work is simply cancelled before it
 * ever begins.
 */
const POST_TURN_DELAY_MS = 2500;

/** Join the assistant text across a turn's messages (for the reviewer pass). */
function extractAssistantText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        const block = b as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}

const HELP = [
  'Usage: /harness <command>',
  '  status                     show + republish the harness status',
  '  set-mode <bypass|reviewer|review-all>',
  '  effort <low|medium|high|max>',
  `  preset <auto|${TASK_CLASSES.join('|')}>`,
  '  classify <text>            debug: classify a prompt',
].join('\n');

/**
 * Wire the full harness onto a pi session. Returns a handle used by tests and
 * (in the app) by the code that also needs the permission controller.
 */
/** The text of the LAST assistant message in a finished run (its final reply). */
/**
 * Did the last assistant turn stop because it ran out of OUTPUT budget?
 *
 * `stopReason: 'length'` means the reply is a prefix of what the model meant to
 * say — cut mid-token, not finished. Read off the last assistant message so it
 * works whatever produced it.
 */
export function endedAtOutputLimit(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as {
      role?: unknown;
      stopReason?: unknown;
      usage?: { input?: number; output?: number; totalTokens?: number };
    };
    if (m?.role !== 'assistant') continue;
    if (m.stopReason !== 'length') return false;
    /*
     * `length` MEANS TWO DIFFERENT THINGS, and only one of them is this steer's.
     *
     * MEASURED, run 16, both in the same session:
     *   manager  out=8192  tot=23040  → hit the OUTPUT cap with context to spare.
     *                                   Narration. The steer is right.
     *   CEO      out=3309  tot=49152  → hit the CONTEXT ceiling (-c 49152) with a
     *                                   small reply. Not verbosity at all.
     *
     * Sending "you wrote too much, use `write`" into a FULL context is worse than
     * silence: the advice is wrong, and the message itself consumes room the
     * model does not have — it lands and is immediately truncated again. That is
     * what happened at 04:41:28, the last entry before the run stalled out.
     *
     * A reply that is small relative to its own turn is a context problem, not an
     * output problem. Compaction owns that; this does not.
     */
    const usage = m.usage;
    if (usage === undefined) return true;
    const output = usage.output ?? 0;
    const total = usage.totalTokens ?? 0;
    // Output tokens a trivial share of the turn ⇒ the ceiling was the context.
    return !(total > 0 && output > 0 && output / total < 0.25);
  }
  return false;
}

/**
 * What to say to a turn that spent its whole budget PRINTING code.
 *
 * MEASURED, run 16 (Qwen3.8-27B). After twelve sensible environment probes the
 * CEO wrote "Alright, let's write all the application files. I'll write them one
 * by one." and then began emitting the entire application as prose — 20,541
 * output tokens, 28 minutes at 16 tok/s, straight into the 49,152-token ceiling.
 * `stopReason: 'length'`. Not one `write` call, not one file, and the run was
 * over: nothing in the main-chat path notices a turn that dies this way.
 *
 * The truncated-call guard for exactly this (`lastStopReason === 'length'`)
 * exists in `corp/role-agent.ts` and covers the corp ROLES only — the fourth
 * "guard on one door" found today. This is the chat side of it, and it has to
 * be a different message because the CEO made no call at all: the failure is
 * not a cut-off tool call, it is having narrated instead of acted.
 *
 * ONE nudge per session, like the handback nudge beside it: a model that does
 * it twice is telling us something a third message will not fix.
 */
/*
 * Say only what the harness actually KNOWS.
 *
 * This used to open its second paragraph with "Looking at it: you were writing
 * file contents into the reply." That was true of the run it was written from
 * (run 16's CEO printed an application into the chat), and it is asserted here
 * unconditionally — the firing condition is only "hit the output limit and made
 * no tool calls", which a long analysis satisfies just as well. So on any other
 * cause the harness states a confident falsehood about what the model just did,
 * and the model then "corrects" behaviour it never exhibited.
 *
 * What is genuinely known at this point: the turn ended at the output cap, it
 * saved nothing, and it made no tool calls. The remedy is offered against the
 * likely cause rather than asserted as fact — same pressure, no invention.
 */
export const OUTPUT_LIMIT_NUDGE =
  'Your last turn hit the output limit and was cut off mid-sentence, so none of ' +
  'it took effect and nothing was saved. It made no tool calls.\n\n' +
  'If you were writing file contents into the reply: a reply is not a file, and ' +
  'printing one costs the whole budget without putting anything on disk. Use ' +
  '`write` to put each file where it belongs, ONE call per file, and say nothing ' +
  'about the contents in the reply itself.\n\n' +
  'Either way, start with the single most important next action rather than ' +
  'restating the plan.';

function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role !== 'assistant') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((c): c is { type: string; text: string } => {
        const b = c as { type?: unknown; text?: unknown };
        return b?.type === 'text' && typeof b.text === 'string';
      })
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

/**
 * The environment a MODEL's command should run in — ours, minus the parts that
 * only make sense for us.
 *
 * A pi child is launched through the Electron helper with
 * `ELECTRON_RUN_AS_NODE=1` (see resolve-pi.ts: it is how the bundled CLI runs
 * without a separate Node, and how the child avoids taking a dock tile). Every
 * bash command that child runs inherits it — including commands that launch
 * ANOTHER Electron.
 *
 * That is poison for exactly the thing a team is most often asked to build. An
 * agent that runs `npm start` on the desktop app it just wrote gets an Electron
 * whose renderer dies on startup:
 *
 *     Electron sandboxed_renderer.bundle.js script failed to run
 *     TypeError: Cannot destructure property 'preloadScripts' of
 *     'binding.startupData' as it is null.
 *
 * Measured twice in run 4 — both attempts died around the sixteen-minute mark
 * while the team was building an Electron app. Whether or not that is what
 * crashed OUR window (the role transcripts do not persist, so it is not provable
 * from what survives), handing an agent a variable that breaks the kind of app it
 * was asked to build is a defect on its own.
 *
 * Only OUR variables are stripped. The model's own environment is otherwise
 * untouched: it needs PATH, HOME and everything else to work.
 */
const HOST_ONLY_ENV = ['ELECTRON_RUN_AS_NODE'] as const;

export function cleanChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of HOST_ONLY_ENV) delete out[key];
  return out;
}

export function wireHarness(pi: ExtensionAPI, options: WireHarnessOptions = {}): HarnessHandle {
  /*
   * FIRST, before anything registers: wrap `pi.registerTool` so every tool that
   * follows — this harness's own, and web-tools / browser-use / the mac
   * extensions, which all load after us — is captured WITH its `execute`. That
   * registry is what `use` dispatches through, which is what lets a capability
   * be pure text and cost no re-prefill. See tools/tool-registry.ts.
   */
  const toolRegistry = captureRegisteredTools(pi);
  const runtime: HarnessRuntime = {
    config: DEFAULT_CONFIG,
    workspaceRoot: null,
    activeClass: null,
    title: null,
    canonicalSystemPrompt: null,
    activeTools: [],
    taskStart: null,
    turnIndex: 0,
    model: null,
    permission: { getMode: () => DEFAULT_CONFIG.mode, setMode: () => {} },
    statusTimer: null,
    currentCtx: null,
    lastPrompt: '',
    suppressNextReview: false,
    plan: null,
    planTitle: null,
    subagentSnapshot: null,
    stage: 'idle',
    loopDetector: null,
    touchedFiles: [],
    ranCommands: [],
    delegatedThisTurn: false,
    nudgedHandback: false,
    nudgedOutputLimit: false,
    verifyFixesRemaining: 0,
    verifyActive: false,
  };

  // Effort-gated REAL verify seams (fix #4). Default to pi.exec + a node:fs probe;
  // tests inject a fake bash runner and a stubbed detector.
  const verifyBash: VerifyBashRunner | undefined =
    options.verify?.runBash ??
    (typeof pi.exec === 'function' ? makeExecBashRunner(pi.exec.bind(pi)) : undefined);
  const verifyDetectCheck: (cwd: string) => ProjectCheck | null =
    options.verify?.detectCheck ?? ((cwd) => detectProjectCheck(makeFsProbe(cwd)));

  // The utility model powering fixer + reviewer + classifier escalation. Absent
  // (no PI_DESKTOP_UTILITY_BASE_URL and no injected callModel) → those features
  // degrade to heuristic/skip; the rest of the harness is unaffected.
  /*
   * RE-RESOLVED, not captured once.
   *
   * On a normal app open pi starts BEFORE the model server, so the endpoint env
   * is absent at this line and every consumer below — the fixer, the reviewer,
   * and above all the prefix warm-up — was permanently dead for that process.
   * It only ever worked in the probe, which restarts pi after the server is up.
   * `callModelFromEnv` now also reads the app's live endpoint file, so asking
   * again later is what turns a late server into a working one.
   */
  let resolvedCallModel: CallModel | undefined = options.callModel ?? callModelFromEnv();
  const currentCallModel = (): CallModel | undefined => {
    if (resolvedCallModel !== undefined) return resolvedCallModel;
    resolvedCallModel = callModelFromEnv();
    return resolvedCallModel;
  };
  const callModel: CallModel | undefined = resolvedCallModel;
  // Debounce the preemptive warm-up by the CANONICAL prompt content: warm each
  // unique system+tools prefix once. Keyed on content (not model id) because it
  // fires on BOTH session_start and model_select — a new chat on the same model
  // (no model_select) still needs the prefix resident, and a cwd change (new
  // canonical) must re-warm.
  let warmedCanonical: string | null = null;
  /** When the warm-up first claimed the "Loading model" label (null = not yet). */
  let warmClaimedAt: number | null = null;
  /** The prefix seen on the PREVIOUS attempt — warm only once it repeats. */
  let pendingWarmKey: string | null = null;
  /** How long to keep claiming it with no endpoint in sight before giving up. */
  const WARM_CLAIM_GRACE_MS = 20_000;
  // Last-published predictive-prefill context (deduped so a per-turn applyPreset
  // that changed nothing doesn't re-push the ~7k-char system + tool schemas).
  let publishedPrefillSystem: string | null = null;
  let publishedPrefillTools: string | null = null;
  /** In-flight post-turn background work (naming, reviewer). Aborted the moment
   * the user starts a new turn — see the agent_end block for why. */
  let postTurnWork: AbortController | null = null;
  /** Timer for the deliberate pause before post-turn work starts. */
  let postTurnTimer: ReturnType<typeof setTimeout> | null = null;
  const asyncClassifier: AsyncClassifier | undefined =
    callModel !== undefined ? createClassifierEscalation(callModel) : undefined;

  /**
   * Fire-and-forget: prime the server's KV with the DETERMINISTIC prefix — the
   * canonical system prompt + the initial (default-preset) tool set — so the
   * user's FIRST message only prefills its own few tokens instead of paying a
   * full cold system+tools prefill (~3s at real sizes). Called on session_start
   * AND model_select so it fires whenever a model is ready with the utility
   * endpoint available; debounced per canonical so it primes each prefix once.
   * Also freezes runtime.canonicalSystemPrompt so the first real turn reuses this
   * exact string (before_agent_start prefers it) → the warmed KV is actually hit.
   */
  /**
   * Map ordered tool NAMES to the {name, description, parameters} defs the
   * provider renders, preserving order. Chat templates emit tools positionally, so
   * order is part of the KV-prefix identity — a different order (e.g. registry
   * order vs. a real turn's applyPreset order) reuses NOTHING even with the same
   * tool SET. Unknown names are dropped. Shared by the warm-up and the post-turn
   * naming so both reproduce a real turn's prefix byte-for-byte.
   */
  function orderedToolDefs(
    names: readonly string[],
  ): { name: string; description?: string; parameters?: unknown }[] {
    const byName = new Map(pi.getAllTools().map((t) => [t.name, t] as const));
    return names
      .map((n) => byName.get(n))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  /**
   * PUBLISH the deterministic prefill prefix — the canonical system prompt and
   * the tools resident in the slot, in render order — to the renderer, so the
   * composer can PREDICTIVELY prefill the message being typed (pi:prefill) with a
   * prefix byte-identical to the one the real turn will process. Two keys so a
   * per-turn tool change never re-pushes the (large, unchanging) system prompt;
   * each deduped by content so an unchanged turn publishes nothing. The tools are
   * built with the SAME `orderedToolDefs` the warm-up/naming use, so all three
   * reproduce the turn's prefix identically.
   */
  function publishPrefillContext(
    ctx: ExtensionContext,
    tools: { name: string; description?: string; parameters?: unknown }[],
  ): void {
    if (ctx.hasUI !== true) return;
    const system = runtime.canonicalSystemPrompt ?? '';
    if (system.length > 0 && system !== publishedPrefillSystem) {
      publishedPrefillSystem = system;
      ctx.ui.setStatus('harness-prefill-system', system);
    }
    const toolsJson = JSON.stringify(tools);
    if (toolsJson !== publishedPrefillTools) {
      publishedPrefillTools = toolsJson;
      ctx.ui.setStatus('harness-prefill-tools', toolsJson);
    }
  }

  function maybeWarmPrefix(ctx: ExtensionContext): void {
    const warmCall = currentCallModel();
    /* Opt-in diagnostic: WHY a warm-up did not happen. Four different silent
     * returns look identical from outside, and the difference decides the fix. */
    const dbg = process.env.PI_ADV_DEBUG_WARM;
    const note = (why: string): void => {
      if (dbg === undefined || dbg.length === 0) return;
      try {
        appendFileSync(dbg, `warm: ${why}\n`);
      } catch {
        /* a diagnostic must never break a turn */
      }
    };
    /*
     * CLAIM THE LABEL BEFORE WE CAN WARM, not after.
     *
     * "Loading model" is gated on this status, and the server reaches `ready`
     * seconds before the harness has an endpoint to warm through — so the label
     * cleared, the user sent, and the turn QUEUED BEHIND the warm-up it was meant
     * to benefit from. Measured: first token at 12.6s, matching the warm-up's own
     * 12.5s completion almost exactly. Saying "warming" from the first attempt
     * closes that window.
     *
     * With a deadline, because a promise this makes must be one it can keep: if
     * no endpoint ever appears (no local server at all), release the label rather
     * than holding the composer hostage to a warm-up that is never coming.
     */
    if (ctx.hasUI === true && warmClaimedAt === null) {
      warmClaimedAt = Date.now();
      ctx.ui.setStatus(PREFIX_WARM_STATUS, 'warming');
    }
    if (warmCall === undefined) {
      note('no callModel (no endpoint env and no live file)');
      if (
        ctx.hasUI === true &&
        warmClaimedAt !== null &&
        Date.now() - warmClaimedAt > WARM_CLAIM_GRACE_MS
      ) {
        ctx.ui.setStatus(PREFIX_WARM_STATUS, 'ready');
      }
      return;
    }
    if (typeof ctx.getSystemPrompt !== 'function') {
      note('ctx.getSystemPrompt missing');
      return;
    }
    const canonical = augmentSystemPrompt(ctx.getSystemPrompt());
    if (canonical.trim().length === 0) {
      note('empty system prompt');
      return;
    }
    // NOTE: the debounce key is completed BELOW, once the tool set is known — the
    // prefix is [system][tools], so warming is only redundant when BOTH match.

    runtime.canonicalSystemPrompt = canonical;
    const warmClass: TaskClass =
      runtime.config.preset === 'auto' ? 'coding' : runtime.config.preset;
    // Build the tool list in the SAME ORDER a real turn does (applyPreset unions
    // resolvePresetTools' order), NOT pi.getAllTools() registry order.
    /*
     * THE WARM SET MUST BE THE TURN'S SET, EXACTLY.
     *
     * Chat templates render tools at the START of the prompt, so one extra or
     * missing tool changes the very first tokens and the cached prefix is worth
     * nothing. The corp seam is gated on EFFORT and added by applyPreset, so a
     * warm-up that ignored it warmed 16 tools while a max-effort turn asked for
     * 17 — a prefix that could never be reused, which is why a measured 20× win
     * never once showed up in a real session.
     */
    const available = pi.getAllTools().map((t) => t.name);
    const warmNames = resolvePresetTools(warmClass, available);
    if (
      corpToolEnabled(runtime.config.effort) &&
      available.includes(CREATE_PRODUCTION_HIERARCHY) &&
      !warmNames.includes(CREATE_PRODUCTION_HIERARCHY)
    ) {
      warmNames.push(CREATE_PRODUCTION_HIERARCHY);
    }
    const warmTools = orderedToolDefs(warmNames);
    /*
     * DEBOUNCE ON THE WHOLE PREFIX, not just the system prompt.
     *
     * Keyed on the prompt alone, the first warm-up (default effort, 16 tools)
     * blocked every later one — so when effort rose to max and the turn began
     * advertising a 17th tool (talk_to_manager), the cached prefix no longer
     * matched the turn's first tokens and reused nothing. The retry ticks dutifully
     * reported "already warmed" 19 times while the thing they were meant to warm
     * had changed underneath them.
     */
    const warmKey = `${canonical}\u0000${warmNames.join(',')}`;
    /*
     * WAIT FOR THE SET TO SETTLE before spending a cold prefill on it.
     *
     * The app pushes effort AFTER the session comes up, and effort decides
     * whether the corp seam is advertised — so the first tick sees 16 tools and
     * the turn will want 17. Warming immediately meant priming a prefix the turn
     * could not use, releasing the "Loading model" label on it, and leaving the
     * real 17-tool warm still running when the user sent. Measured: 12.6s.
     *
     * One tick of stability (~1s) is enough for effort to land and costs nothing,
     * because nothing can be sent while the label is still claimed.
     */
    if (warmKey !== pendingWarmKey) {
      pendingWarmKey = warmKey;
      note(`tool set changed (${warmNames.length}) — waiting a tick for it to settle`);
      return;
    }
    if (warmKey === warmedCanonical) {
      note('already warmed (same prompt + tools)');
      return;
    }
    warmedCanonical = warmKey;
    /*
     * SAY WHEN THE PREFIX IS ACTUALLY RESIDENT.
     *
     * The warm-up is fire-and-forget, and the app's "Loading model" indicator
     * clears on `phase = 'ready'` — which fires when llama-server answers, some
     * seconds before this finishes. So the moment the label disappeared, a first
     * message still paid the full prefill. the user: "when that finishes, I want any
     * prompt I send in to be instantaneous… the instant 'loading model'
     * disappears."
     *
     * Publishing 'warming' → 'ready' lets the indicator wait for the thing it
     * was implicitly claiming. `finally`, not `then`: a warm-up that FAILS must
     * still release the label, or a transient error strands the UI on "Loading
     * model" forever with a perfectly usable server behind it.
     */
    note(
      `WARMING ${canonical.length} chars, ${warmTools.length} tools ` +
        `[${warmTools.map((t) => t.name).join(',')}], hasUI=${ctx.hasUI}`,
    );
    const warmStartedAt = Date.now();
    void warmSystemPrompt(warmCall, canonical, { tools: warmTools })
      .then((ok) => note(`warm result ok=${ok} in ${Date.now() - warmStartedAt}ms`))
      .finally(() => {
        if (ctx.hasUI === true) ctx.ui.setStatus(PREFIX_WARM_STATUS, 'ready');
      });
    // Seed the renderer's predictive-prefill context with exactly what the warm-up
    // just made resident ([system][warm preset tools]) — so a first message typed
    // BEFORE any turn (activeTools still empty) prefills against the real prefix.
    publishPrefillContext(ctx, warmTools);
  }

  // A session-stable per-tool failure counter shared by rungs 4 (bump) and 5
  // (read → abort at threshold). Persists across effort changes (which only
  // rebuild the rung array / threshold, not the counts).
  const failureCounts = new Map<string, number>();

  // Per-session RELAXED schemas (rung 4). When a tool's strict schema keeps
  // rejecting otherwise-usable args, rung 4 stores a looser schema here; the
  // provider reads it via `relaxedSchemaFor` so subsequent calls to that tool
  // validate at rung 2 instead of re-escalating. Cleared on session_start.
  const relaxedSchemas = new Map<string, ToolSchemaLike>();

  /**
   * Build the live repair deps the provider's stream ladder consumes: the
   * effort-bounded rung-2 fixer, rungs 3–5 (abort threshold from the effort
   * slider), and telemetry that populates HarnessStatus.repairFailures.
   */
  function buildRepairDeps(): LiveRepairDeps {
    const knobs = effortKnobs(runtime.config.effort);
    const fixer =
      callModel !== undefined
        ? withRepairAttempts(createToolCallFixer(callModel), knobs.repairAttempts)
        : undefined;

    const harnessDeps: HarnessRepairDeps = {
      abortThreshold: knobs.abortThreshold,
      // Rung trace (no `ok` → not counted as a failure). Entering a repair rung is
      // a seam for the 'repairing' stage (fix #5) — the tool-execution-end hook
      // flips it back to 'working' once the retried call resolves.
      onRung: (info) => {
        pi.appendEntry(HARNESS_REPAIR_ENTRY, { rung: info.rung, toolName: info.toolName });
        setStage('repairing', runtime.currentCtx);
      },
      bumpFailureCount: (t) => {
        const n = (failureCounts.get(t) ?? 0) + 1;
        failureCounts.set(t, n);
        return n;
      },
      getFailureCount: (t) => failureCounts.get(t) ?? 0,
      /*
       * NEVER ASK. the user, shown the dialog mid-run: "this popup doesn't need to
       * exist."
       *
       * It read `Relax "edit" schema? — edit args failed schema validation
       * (attempt 1). Accept the arguments as-is?` and it stopped the run dead
       * until somebody clicked. That is an internal repair detail phrased as a
       * decision, and it is not one a person can actually make: the only
       * information a user has is the same string we already decided was a
       * malformed tool call. Whichever button they press, the honest next step
       * is identical — try the call with the looser schema and let the tool
       * itself fail if the arguments are genuinely wrong.
       *
       * Headless and subagent contexts already auto-resolved for exactly this
       * reason (a dialog nobody can answer hangs the run forever). A human
       * watching a build is in the same position; they just had a button.
       */
      confirmRelax: async () => true,
      relaxSchema: ({ toolName, schema }) => {
        // Re-register the tool under a looser per-session schema (same-name): store
        // a maximally-permissive schema keyed by tool name, which the provider
        // reads via `relaxedSchemaFor` (below) so this tool's subsequent calls
        // validate at rung 2 instead of re-escalating through rungs 3–5. The tool's
        // execution is untouched — only its per-session VALIDATION schema loosens.
        relaxedSchemas.set(toolName, relaxToolSchema(schema));
        pi.appendEntry(HARNESS_REPAIR_ENTRY, { toolName, relaxed: true });
      },
      abort: ({ toolName, count }) => {
        pi.appendEntry(HARNESS_REPAIR_ENTRY, { toolName, aborted: true, count });
        runtime.currentCtx?.abort();
      },
    };

    return {
      fixer,
      extraRungs: createHarnessExtraRungs(harnessDeps),
      // Per-session relaxed-schema lookup (rung 4). Closes over the live map, so a
      // relaxation stored after this deps object was pushed is still seen.
      relaxedSchemaFor: (toolName) => relaxedSchemas.get(toolName),
      // Authoritative per-call outcome — the only entry carrying `ok`.
      onRepair: (info) =>
        pi.appendEntry(HARNESS_REPAIR_ENTRY, {
          toolName: info.toolName,
          rung: info.rung,
          ok: info.ok,
        }),
      // Prefill %: the provider (which can't reach a per-turn ctx) forwards its
      // `prompt_progress` fraction here; publish it on the LIVE turn's status
      // channel so the desktop "N% processing" ring shows real prefill progress.
      // Reads runtime.currentCtx at call time, so the static deps object still
      // targets whatever turn is active. Capped 99 (renderer drives the final 100).
      onPromptProgress: (fraction) => {
        const ctx = runtime.currentCtx;
        if (ctx?.hasUI === true) {
          ctx.ui.setStatus('harness-prefill', String(Math.min(99, Math.round(fraction * 100))));
        }
      },
    };
  }

  // Connect the repair bridge to the provider extension over pi.events (handshake
  // is order-independent; no-op if pi.events / the provider isn't present).
  const bridge = connectRepairBridge(pi.events, buildRepairDeps);

  /**
   * Effort-gated reviewer + adversarial passes over a finished turn's output.
   * Returns true when a revision was triggered. Fail-open: no callModel → false.
   */
  /**
   * Critique the turn's output and, if it finds real problems, steer a revision.
   *
   * NOT run by default any more, at any effort (the user: "we don't by default want
   * any reviews/adversarial or anything, especially if the user is just saying hi
   * or asking for some file operation"). The effort knobs are all zero, so the
   * post-turn path calls this and it returns immediately.
   *
   * It survives as something that can be ASKED FOR — `request` overrides the
   * knobs — which is the shape help should take: the model escalates when it
   * judges it needs a second opinion, instead of having one imposed on work that
   * did not need one.
   */
  async function reviewTurn(
    output: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    request?: { readonly passes?: number; readonly adversarial?: boolean },
  ): Promise<boolean> {
    if (callModel === undefined || output.trim().length === 0) return false;
    if (runtime.suppressNextReview) {
      runtime.suppressNextReview = false;
      return false;
    }
    const base = effortKnobs(runtime.config.effort);
    const knobs = {
      ...base,
      ...(request?.passes !== undefined ? { reviewPasses: request.passes } : {}),
      ...(request?.adversarial !== undefined ? { adversarialChecks: request.adversarial } : {}),
    };
    if (knobs.reviewPasses <= 0 && !knobs.adversarialChecks) return false;
    setStage('reviewing', ctx);
    const task = runtime.lastPrompt;
    // Ride the conversation's resident KV instead of evicting it. Same frozen
    // system prompt, same tools in the same order, critique appended as one more
    // user turn — the shape the post-turn naming already uses. Standalone, the
    // reviewer's own {system:"You are a meticulous senior reviewer…"} request
    // diverged at the first token, so llama-server dropped the whole
    // conversation to prefill the critique and the user's NEXT message paid a
    // full cold prefill. MEASURED on the shipped build: first message 274ms,
    // follow-ups 4015-8096ms. This runs after EVERY turn from `medium` up, which
    // is the default — so it was costing seconds on essentially every message.
    const reviewContext = {
      priorMessages: buildConversationPrefix(
        getEntries(ctx),
        runtime.canonicalSystemPrompt ?? '',
        task,
        false,
      ),
      tools: orderedToolDefs(runtime.activeTools),
      ...(signal !== undefined ? { signal } : {}),
    };
    const issues: string[] = [];
    // Run up to `reviewPasses` reviewer passes so a higher effort really does run
    // more passes than a lower one (the knob was inert — medium/high/max all ran
    // exactly once). Stop at the first pass that flags something (it already has
    // the issues to fix); a clean pass proceeds to the next.
    for (let i = 0; i < knobs.reviewPasses; i++) {
      if (signal?.aborted === true) return false;
      const r = await reviewOutput(callModel, { task, output, ...reviewContext });
      if (!r.ok) {
        issues.push(...r.issues);
        break;
      }
    }
    if (knobs.adversarialChecks && signal?.aborted !== true) {
      const a = await adversarialCheck(callModel, { task, output, ...reviewContext });
      if (!a.ok) issues.push(...a.issues);
    }
    // A critique the user overtook is not a verdict — it is a truncated request
    // about a turn they have already moved on from. Never steer a revision off it.
    if (signal?.aborted === true) return false;

    pi.appendEntry(HARNESS_REVIEW_ENTRY, {
      effort: runtime.config.effort,
      reviewPasses: knobs.reviewPasses,
      adversarial: knobs.adversarialChecks,
      flagged: issues.length > 0,
      issues,
    });
    if (issues.length === 0) return false;

    // Trigger a revision turn, and don't review that revision (avoid a loop).
    runtime.suppressNextReview = true;
    setStage('revising', ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(`Refining the result (${issues.length} point(s) to tighten)…`, 'warning');
    }
    // Private steer — deliberately free of any "reviewer"/"harness" vocabulary the
    // model might parrot into its user-facing reply (blind-test item 5). The last
    // clause tells the model to keep this instruction to itself and just deliver
    // the improved result.
    pi.sendUserMessage?.(
      `Before you finish, tighten your last result — fix these points:\n- ${issues.join('\n- ')}\n\nApply the fixes and deliver the improved result directly. This note is internal: do not mention it, a "revision", or these points in your reply.`,
      { deliverAs: 'followUp' },
    );
    return true;
  }

  /**
   * Effort-gated REAL verify (fix #4): after the model finishes a coding/file-ops
   * turn at high/max effort, run the project's OWN checks (test/typecheck/lint) in
   * the working dir. On a genuine failure, steer the output back for a fix —
   * bounded to `verifyFixAttempts` per user turn so it can't loop forever. Safe:
   * timeout + bounded + skipped in review-all (where the user approves every act).
   * Returns true when it steered a fix. Needs NO utility model — it runs real
   * checks, so it works with zero model headroom.
   */
  async function verifyTurn(ctx: ExtensionContext): Promise<boolean> {
    const knobs = effortKnobs(runtime.config.effort);
    // Gate: effort (high/max), class (coding/file-ops only — never chat/trivial),
    // a usable bash seam, and permission mode (skip auto-run in review-all).
    if (
      !knobs.realVerify ||
      verifyBash === undefined ||
      (runtime.activeClass !== 'coding' && runtime.activeClass !== 'file-ops') ||
      runtime.config.mode === 'review-all'
    ) {
      runtime.verifyActive = false;
      return false;
    }
    // A fresh verify sequence (not a self-triggered fix revision) resets the budget.
    if (!runtime.verifyActive) runtime.verifyFixesRemaining = knobs.verifyFixAttempts;

    setStage('verifying', ctx);
    let pass: Awaited<ReturnType<typeof runVerifyPass>>;
    try {
      pass = await runVerifyPass({
        cwd: ctx.cwd,
        runBash: verifyBash,
        detectCheck: verifyDetectCheck,
        touchedFiles: runtime.touchedFiles,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
    } catch {
      runtime.verifyActive = false;
      return false;
    }

    // Nothing to run, or the check passed / was inconclusive → sequence over.
    if (pass.check === null || pass.outcome === null || pass.outcome.status !== 'fail') {
      if (pass.check !== null && pass.outcome !== null) {
        pi.appendEntry(HARNESS_VERIFY_ENTRY, {
          effort: runtime.config.effort,
          kind: pass.check.kind,
          status: pass.outcome.status,
          command: pass.outcome.command,
        });
      }
      /*
       * A PASSING SYNTAX CHECK IS NOT A WORKING PRODUCT. This is where code that
       * parses and was never executed slips out as "done" — measured five times
       * over: the model edits, reasons well, runs nothing, reports success. It
       * costs one steer, from the same budget as a real failure, and only when
       * the turn genuinely wrote executable code and issued no command naming
       * any of it.
       */
      /*
       * Two ways a turn can look finished without being checked: nothing was
       * run at all, or something ran and produced an artifact nobody opened.
       * The second is the one that survives running the code — measured on a
       * converter that generated sample.md at ZERO bytes, which was itself one
       * of the bugs it had been asked to fix.
       */
      /*
       * The THIRD way, and the one that has survived every bench: the code runs,
       * produces real output, and quietly disagrees with its own README.
       *
       * Run H fixed 3 of 4 planted defects. The survivor was "Searching is
       * case-insensitive" — and the model had written itself a FOURTEEN step test
       * plan, run it, and passed, because every search it tried used the exact
       * capitalisation already present in the note. It tested that the code does
       * what the code does.
       *
       * Ordered last: a turn that ran nothing at all has a more basic problem
       * than an undemonstrated promise, and only one steer is spent per turn.
       */
      const unexercised =
        neverExercised(runtime.touchedFiles, runtime.ranCommands, runtime.delegatedThisTurn) ??
        emptyOutputs(runtime.touchedFiles, (fp) => {
          try {
            return statSync(fp).size;
          } catch {
            return null;
          }
        }) ??
        /*
         * `workspaceRoot` is set ONLY by an explicit `/harness workspace`
         * command, so in any session without one it is null and this found no
         * README at all — the check would have been silently inert in exactly
         * the case it was built for. `ctx.cwd` is where the verify pass already
         * runs its commands, i.e. where the work actually is. Caught by the
         * reachability test in wiring.test.ts, before a single benchmark run
         * ever managed to reach a turn end.
         */
        undemonstrated(
          readmeIn(workRootOf(runtime.touchedFiles, runtime.workspaceRoot, ctx.cwd)),
          runtime.ranCommands,
          runtime.touchedFiles,
        );
      if (unexercised !== null && runtime.verifyFixesRemaining > 0) {
        runtime.verifyFixesRemaining -= 1;
        runtime.verifyActive = true;
        pi.appendEntry(HARNESS_VERIFY_ENTRY, {
          effort: runtime.config.effort,
          kind: 'unexercised',
          status: 'fail',
          command: '(nothing was run)',
          fix: true,
        });
        setStage('revising', ctx);
        // Same private-followUp mechanism the failing-check branch uses, so the
        // steer never surfaces as meta narration in the user-facing reply.
        pi.sendUserMessage?.(
          `${unexercised}\n\nDo that now, then stop. This is an internal check — act on it silently and don't mention it in your reply.`,
          {
            deliverAs: 'followUp',
          },
        );
        return true;
      }
      runtime.verifyActive = false;
      return false;
    }

    // A genuine failure. If the fix budget remains, steer the output back.
    if (runtime.verifyFixesRemaining > 0) {
      runtime.verifyFixesRemaining -= 1;
      runtime.verifyActive = true;
      pi.appendEntry(HARNESS_VERIFY_ENTRY, {
        effort: runtime.config.effort,
        kind: pass.check.kind,
        status: 'fail',
        command: pass.outcome.command,
        fix: true,
      });
      setStage('revising', ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`Verify: ${pass.check.label} failed — requesting a fix.`, 'warning');
      }
      // Private steer (blind-test item 5): a plain check-output steer with an
      // explicit "keep this internal" clause so the fix loop never surfaces as
      // meta narration in the user-facing reply.
      pi.sendUserMessage?.(
        `A check failed after your last change:\n\n$ ${pass.outcome.command}\n${pass.outcome.output}\n\nFix the code so this check passes, then stop. This is an internal check — fix it silently and don't mention it in your reply.`,
        { deliverAs: 'followUp' },
      );
      return true;
    }

    // Budget exhausted and still failing → give up (surface it), never loop.
    runtime.verifyActive = false;
    pi.appendEntry(HARNESS_VERIFY_ENTRY, {
      effort: runtime.config.effort,
      kind: pass.check.kind,
      status: 'fail',
      command: pass.outcome.command,
      gaveUp: true,
    });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Verify: ${pass.check.label} still failing after ${knobs.verifyFixAttempts} fix attempt(s).`,
        'warning',
      );
    }
    return false;
  }

  /**
   * Act on a {@link LoopDetector} signal (fix #3): a steer injects one corrective
   * nudge into the live stream; an abort surfaces a reason + calls ctx.abort().
   * Returns true when it aborted (so the tool_call hook can also block the call).
   */
  function handleLoopSignal(signal: ReturnType<LoopDetector['onToolCall']>): boolean {
    const ctx = runtime.currentCtx;
    if (signal.kind === 'none') return false;
    if (signal.kind === 'steer') {
      pi.appendEntry(HARNESS_LOOP_ENTRY, {
        action: 'steer',
        cause: signal.cause,
        reason: signal.reason,
      });
      if (ctx?.hasUI === true) ctx.ui.notify(`Loop guard: ${signal.reason} — nudging.`, 'warning');
      pi.sendUserMessage?.(signal.message, { deliverAs: 'steer' });
      return false;
    }
    // abort
    pi.appendEntry(HARNESS_LOOP_ENTRY, {
      action: 'abort',
      cause: signal.cause,
      reason: signal.reason,
    });
    if (ctx?.hasUI === true)
      ctx.ui.notify(`Loop guard aborted the turn: ${signal.reason}.`, 'error');
    ctx?.abort();
    return true;
  }

  // Skill-instructions framing (Wave B #3b): wrap a SKILL/tool-instructions file
  // the model READS in an explicit `<skill_instructions>` marker on the outgoing
  // context, so it reaches the model as instructions — not as a user turn (the
  // provider folds tool results into a user-role turn for Gemma-class templates).
  registerSkillInstructions(pi);

  // File-spill containment (blind-test round-2 #2): override pi's built-in
  // write/edit/read/ls so a RELATIVE path resolves against the resolved
  // sandbox/project cwd — never HOME — and mutating ops are fenced to the
  // workspace + sandbox roots. No-op unless the desktop set PI_DESKTOP_FS_FENCE=1,
  // so a plain CLI `pi` user keeps the unfenced built-ins. See tools/sandbox-fs.ts.
  /*
   * All four resolve against the LIVE workspace (runtime.workspaceRoot), falling
   * back to the spawn-time resolution only until the app has set one. Per call,
   * so moving the dropdown moves the work immediately.
   */
  registerSandboxFileTools(pi, {
    getRoot: (ctx) =>
      runtime.workspaceRoot ?? resolveWorkspaceRoot(ctx.cwd, process.env, homedir()),
  });

  /*
   * BASH AND THE FILE TOOLS MUST AGREE ON "HERE".
   *
   * Overriding only the file tools left bash running in pi's process cwd, so
   * `write("notes.md")` and `echo > notes.md` could land in different
   * directories — and bash is not fenced, so the second one wins silently. pi's
   * own bash takes a `spawnHook` that may rewrite cwd per command, which is
   * exactly the seam for this: no respawn, and `cd elsewhere && ...` still works
   * because the model is only ever choosing to leave a known place.
   */
  const liveRoot = (): string =>
    runtime.workspaceRoot ?? resolveWorkspaceRoot(undefined, process.env, homedir());
  /*
   * `process.cwd()` for the definition's static cwd, NOT liveRoot().
   *
   * liveRoot() calls resolveWorkspaceRoot, which CREATES its `_fallback`
   * directory when nothing resolves — and at registration time nothing has, so
   * every launch left an empty ~/.pi/desktop/sandbox/_fallback behind. Measured
   * after purging the sandbox: it came straight back.
   *
   * The static value is irrelevant anyway: the spawnHook rewrites cwd on every
   * command, and by the time one runs the workspace has been set.
   */
  /*
   * `withRepeatNotice` is outermost so it sees the FINAL arguments (after the
   * background rewrite and the timeout default) and the final result — the two
   * things whose identity it is asserting.
   */
  pi.registerTool(
    withRepeatNotice(
      withDefaultTimeout(
        withBackgroundOption(
          createBashToolDefinition(process.cwd(), {
            spawnHook: (c) => ({ ...c, cwd: liveRoot(), env: cleanChildEnv(c.env) }),
          }),
        ),
      ),
      'bash',
    ) as never,
  );

  /*
   * CAPABILITIES, not search. the user: "remove tool search entirely, and instead
   * replace with a 'capability' tool … the tools can be computer use, mail,
   * calendar, browser etc.", and "the tool search isn't great and is a source of
   * much looping right now."
   *
   * A named group turned on in one call, instead of a free-text query that
   * activated a tool at a time and scored differently depending on wording.
   */
  registerCapabilityTool(pi, {
    /*
     * WHAT EXISTS, from pi — not from our own capture.
     *
     * MEASURED the hard way: with `available` reading the capture, asking for the
     * browser capability answered "not available in this build" even though the
     * browser tools were plainly loaded. That is the proof that each extension
     * gets its OWN api object, so wrapping ours only ever saw ours. Anything
     * that reports on what EXISTS must ask pi, which sees all of them.
     */
    available: () => pi.getAllTools().map((t) => t.name),
    /*
     * AND THE TOOLS ARE GENUINELY TURNED ON. Same finding, same consequence:
     * `use` can only dispatch what our capture holds, which is our own tools, so
     * it cannot reach browser_snapshot or mac_snapshot. Until the capture spans
     * extensions, activation has to be real — otherwise the model is told it has
     * a tool and then cannot call it, which is exactly how it ended up typing
     * `mac_snapshot` at the shell.
     *
     * Costs one re-prefill per activation. Bounded and rare; not free, and not
     * where this ends.
     */
    onActivate: (added) => {
      const next = Array.from(new Set([...runtime.activeTools, ...added]));
      runtime.activeTools = next;
      pi.setActiveTools(next);
    },
  });
  registerUseTool(pi, {
    registry: toolRegistry,
    active: () => runtime.activeTools,
  });

  /**
   * INTENT BIAS — the model says what it means to do; make that the easy thing.
   *
   * the user: "it's still doing a lot of page reading repeating when it clearly
   * intends not to … so if it says as is common 'i need to click' then it will be
   * biased toward calling the click action and will hopefully stop the looping
   * behavior outright."
   *
   * The A/Bs behind this live in tools/intent-bias.ts. The short version: with
   * `browser_click` advertised the model picks it 5/5 unaided, and with it absent
   * NO bias can rescue the turn — the tool-call grammar has already masked those
   * tokens, and pushing on them measured worse than doing nothing. So the loop is
   * an availability problem, and the primary action is to hand over the tool (and
   * its whole capability, since a model that wants to click is about to want to
   * type). The graded nudge the user asked for rides along on top, for the case where
   * the tool IS present and the model is merely wavering.
   */
  const activateCapability = (added: readonly string[]): void => {
    const next = Array.from(new Set([...runtime.activeTools, ...added]));
    if (next.length === runtime.activeTools.length) return;
    runtime.activeTools = next;
    pi.setActiveTools(next);
  };
  pi.on('before_provider_request', (e) => {
    const payload = e.payload;
    if (typeof payload !== 'object' || payload === null) return payload;
    const body = payload as Record<string, unknown>;
    if (!Array.isArray(body.messages)) return body;
    /*
     * WATCH THE PROSE, NOT JUST THE TOOL CALLS. the user watched a turn write
     * "Actually, I'll just present the app.py." about forty times and nothing
     * stopped it — every loop counter keyed off tool calls, and that loop made
     * none.
     *
     * There is no per-message hook to feed, but every agent step issues a
     * provider request carrying the conversation so far, so the tail assistant
     * message here IS the previous step's output. Reading it costs nothing and
     * needs no new plumbing. Best-effort and never throws: a loop check must not
     * be able to break a turn.
     */
    try {
      const detector = runtime.loopDetector;
      if (detector !== null) {
        const tail = [...body.messages]
          .reverse()
          .find(
            (m): m is { role: string; content: unknown } =>
              typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'assistant',
          );
        const text = typeof tail?.content === 'string' ? tail.content : '';
        const line =
          text
            .trim()
            .split('\n')
            .filter((l) => l.trim() !== '')
            .pop() ?? '';
        if (line !== '') handleLoopSignal(detector.onText(line));
      }
    } catch {
      // never let the loop check break a turn
    }
    try {
      const thought = lastAssistantThought(body.messages);
      if (thought === '') return body;
      const advertised = Array.isArray(body.tools)
        ? (body.tools as Array<{ function?: { name?: unknown } }>)
            .map((t) => (typeof t.function?.name === 'string' ? t.function.name : ''))
            .filter((n) => n !== '')
        : [];
      // Candidates come from pi, which sees every extension — our own capture
      // only ever holds ours (measured; see capability-tool.ts). Descriptions and
      // parameters are what make an injected tool callable rather than a name.
      const all = pi.getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      const plan = planBias(thought, advertised, all);
      if (plan.match === null) return body;
      if (plan.inject.length > 0) {
        // The whole group, not the single tool — same one re-prefill, and it
        // spares the next two turns theirs. This lands on the NEXT run, which is
        // the earliest pi can honour it.
        const wanted = plan.inject[0] ?? '';
        const cap = capabilityForTool(wanted);
        const names = all.map((t) => t.name);
        const group = cap !== undefined ? cap.tools.filter((t) => names.includes(t)) : plan.inject;
        activateCapability(group.length > 0 ? group : plan.inject);
        /*
         * AND IT IS NOT ADDED TO *THIS* REQUEST ANY MORE.
         *
         * It used to be, "so the intent is served on the very next action instead
         * of a turn later" — putting the schema in the outgoing body made the
         * model able to EMIT the name. It was never able to RUN it: pi's executor
         * resolves a call against the tool array snapshotted when the run began
         * (pi-agent-core agent-loop.js:309), which this injection does not touch.
         *
         * MEASURED, and it is the whole bug — the model said it wanted to click,
         * this code handed it `browser_click`, and:
         *     browser_click {index:1} → "Tool browser_click not found"
         * twice, before it fell back to snapshots and then to a selenium script.
         * Injecting a tool the turn cannot execute does not serve the intent, it
         * manufactures the phantom-tool failure this file exists to prevent.
         *
         * Anything a turn genuinely needs belongs in the preset — which is why the
         * browser suite is advertised up front now (ALWAYS_BROWSER_TOOLS).
         */
      } else {
        applyBias(body, plan, all);
      }
    } catch {
      // A steering heuristic must never be able to break a turn.
    }
    return body;
  });

  // Task-list / checklist tool: the model publishes a plan the app renders live.
  registerPlanTool(pi, {
    onUpdate: (plan, title) => {
      runtime.plan = plan.length > 0 ? plan : null;
      runtime.planTitle = title ?? null;
      if (runtime.currentCtx !== null) publishStatus(runtime.currentCtx);
    },
  });

  // Ask-user tool: rich choice / multi-select / slider / free-text questions,
  // routed to the desktop QuestionCard via the input-dialog sentinel channel.
  registerAskUser(pi);

  // Image generation + editing as ordinary chat tools, rendering INLINE in the
  // thread. On-device via the gen3d engine, reached through the app's socket
  // bridge. Registers NOTHING outside Pi Desktop (no bridge env → no tools), so
  // a plain CLI pi never sees a capability this machine can't honour.
  registerImageTools(pi);

  // Real subagents: `spawn_subagent` runs an isolated child pi and returns ONLY
  // its summary. Spawns are memory-scheduled (concurrency bounded by detected
  // RAM/cores, degrading to 1 with no utility model / low RAM / single core).
  /*
   * `present` is the TOP-LEVEL model's alone. the user: "this is only for the top
   * level/original model, no subagent ever has this". A child reports to whoever
   * spawned it, not to the person — a subagent presenting would put an artefact
   * in front of a user nobody decided to show it to.
   */
  if (readSubagentDepth(process.env) === 0) {
    registerPresentTool(pi, {
      bridge: presentBridgeFromEnv(),
      stat: async (target) => {
        try {
          return { isDirectory: (await stat(target)).isDirectory() };
        } catch {
          return null;
        }
      },
    });
  }

  // Only the top-level agent (depth 0) registers the tool — a spawned child
  // (depth >= 1) does not, so subagents can't recursively spawn subagents (v1).
  if (readSubagentDepth(process.env) < MAX_SUBAGENT_DEPTH) {
    const scheduler = new SubagentScheduler({
      budget: detectBudget({ hasUtilityModel: callModel !== undefined }),
      onChange: (snap) => {
        runtime.subagentSnapshot = snap;
        if (runtime.currentCtx !== null) publishSubagents(runtime.currentCtx);
      },
    });
    // Pi Desktop publishes a bridge socket on the env → route spawn_subagent to
    // the APP (it runs the subagent as its own pi, streamed to the sidebar dropdown
    // as a live nested chat, and hands back the summary). Outside the app the env is
    // absent → fall back to the in-process child runner (unchanged behaviour).
    const bridgeRunChild = subagentBridgeRunChildFromEnv();
    registerSubagentTool(
      pi,
      bridgeRunChild !== null ? { scheduler, runChild: bridgeRunChild } : { scheduler },
    );
  }

  /* Scheduled tasks: the model can turn "do this every morning" into something
     the app will actually do, instead of agreeing and forgetting. It writes the
     app's own schedule file, so it works from any harness with no bridge. */
  registerScheduledTaskTool(pi);

  // Corp system as an OPTION (the user): at high/max effort the model can hand a
  // large, professional build to a manager + team via `create_production_hierarchy`
  // — "still just a tool", never a mode that hijacks the prompt. It's registered
  // globally but only ENTERS the active set at high/max (see applyPreset); calling
  // it publishes a promote intent (PROMOTE_STATUS_KEY) the desktop catches to
  // launch the existing corp run.
  /*
   * HOW MANY TOOLS THE MODEL HAS ACTUALLY USED, so `talk_to_manager` can refuse
   * a delegation from a standing start (see STANDING_START_REFUSAL). Counted
   * here because the tool itself cannot see anything but its own call, and
   * asking the model how much work it has done invites it to say "enough".
   * The delegation tool is excluded so it never counts itself.
   */
  let otherToolCalls = 0;
  pi.on('tool_execution_start', (event) => {
    if (event.toolName !== CREATE_PRODUCTION_HIERARCHY) otherToolCalls += 1;
  });
  registerCreateHierarchyTool(pi, {
    getEffort: () => runtime.config.effort,
    otherToolCalls: () => otherToolCalls,
    // The CEO's unknowns checklist, so whatever it left open rides to the manager.
    getPlan: () => runtime.plan,
  });

  // Permission gate. In reviewer mode a scary-bash command is flagged first by
  // the regex rules, then — when a utility model is configured — double-checked
  // by the small model (fail-open to the regex result).
  runtime.permission = registerPermissions(pi, {
    initialMode: runtime.config.mode,
    ...(callModel !== undefined ? { flagBash: createBashFlagger(callModel) } : {}),
  });

  function buildStatus(ctx: ExtensionContext): HarnessStatus {
    const usage = ctx.getContextUsage();
    return {
      ...runtime.config,
      activeClass: runtime.activeClass,
      activeTier: runtime.activeClass !== null ? modelTierForClass(runtime.activeClass) : null,
      title: runtime.title,
      activeTools: runtime.activeTools,
      model: runtime.model?.id ?? null,
      modelParams: runtime.model ? parseModelParams(runtime.model.name ?? runtime.model.id) : null,
      contextPercent: usage?.percent ?? null,
      runningTaskMs: runtime.taskStart !== null ? Date.now() - runtime.taskStart : null,
      repairFailures: countRepairFailures(getEntries(ctx)),
      plan: runtime.plan,
      planTitle: runtime.planTitle,
      stage: runtime.stage,
    };
  }

  function publishStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus('harness', JSON.stringify(buildStatus(ctx)));
    // A short human-readable running-task status for the app's timer.
    ctx.ui.setStatus(
      'harness-task',
      runtime.taskStart !== null
        ? `⏱ ${((Date.now() - runtime.taskStart) / 1000).toFixed(1)}s`
        : undefined,
    );
  }

  /**
   * Set the coarse lifecycle {@link HarnessStage} and republish the status so the
   * app's activity indicator reflects the seam that just fired. De-duped: a no-op
   * when the stage is unchanged (the 1s timer already republishes otherwise).
   */
  function setStage(stage: HarnessStage, ctx: ExtensionContext | null): void {
    if (ctx === null || runtime.stage === stage) return;
    runtime.stage = stage;
    publishStatus(ctx);
  }

  /**
   * Stream the live subagent list over the SAME setStatus channel the plan uses,
   * under a distinct key so the desktop opens/feeds the canvas subagent tab. An
   * empty/null snapshot clears the key (the panel/tab shows nothing).
   */
  function publishSubagents(ctx: ExtensionContext): void {
    const snap = runtime.subagentSnapshot;
    if (snap === null || snap.items.length === 0) {
      ctx.ui.setStatus(HARNESS_SUBAGENTS_STATUS_KEY, undefined);
      return;
    }
    const payload: HarnessSubagentsStatus = {
      subagents: snap.items,
      budget: {
        maxConcurrency: snap.maxConcurrency,
        running: snap.running,
        queued: snap.queued,
        reason: snap.reason,
      },
    };
    ctx.ui.setStatus(HARNESS_SUBAGENTS_STATUS_KEY, JSON.stringify(payload));
  }

  /*
   * Is the delegation tool actually on offer this turn? The team section of the
   * system prompt is gated on the SAME condition that puts `talk_to_manager` in
   * the advertised list — effort, and the tool being registered at all. Prose
   * about a tool the model does not have is the phantom-tool failure that
   * produces a plausible wrong call instead of a clean one.
   */

  /*
   * `syncTeamPrompt` is GONE. It threw away the cached system prompt whenever
   * the team's availability flipped, so the prompt changed underneath a running
   * session and cost a full KV re-prefill. It existed only because the team
   * guidance lived IN the prompt; it lives on the tool description now, so the
   * prompt is the same at every effort and there is nothing to resynchronise.
   * the user: "ensure there's not conflicting 'mid run changes'".
   */

  function applyPreset(
    cls: TaskClass,
    ctx: ExtensionContext,
    extraTools: readonly string[] = [],
  ): void {
    const available = pi.getAllTools().map((t) => t.name);
    /*
     * A SPECIALIST CHILD IS PINNED, not preset. the user: "with just these tools
     * loaded, those subagents are only for that purpose". So its set REPLACES
     * the preset instead of unioning onto it — an image specialist holding the
     * coding preset is an agent that will go and read source instead of making
     * the picture it was commissioned for.
     *
     * Empty means this build registered none of them; leaving the preset alone
     * is the right fallback, because an agent pinned to zero tools can do
     * nothing whatsoever.
     */
    const specialist = specialistFromEnv();
    if (specialist !== undefined) {
      const pinned = specialistToolset(specialist, available);
      if (pinned.length > 0) {
        runtime.activeClass = cls;
        if (
          pinned.length !== runtime.activeTools.length ||
          pinned.some((t, i) => runtime.activeTools[i] !== t)
        ) {
          runtime.activeTools = pinned;
          pi.setActiveTools(pinned);
        }
        return;
      }
    }
    // The class preset PLUS any extra tools the caller named. Unioned
    // append-only below so the KV prefix holds.
    const preset = [...resolvePresetTools(cls, available), ...extraTools];
    // The active tool list is rendered at the START of the prompt (chat templates
    // emit tools before the messages), so it is part of the KV-cached prefix. If
    // we blindly re-set it every turn, a NEW user message churns that prefix and
    // forces a FULL re-prefill — even for a trivial "hi" follow-up — while the
    // re-prefills BETWEEN tool calls (same turn, no before_agent_start) stay
    // instant because the prefix is untouched. That's exactly the asymmetry the user
    // observed. So: keep the set STABLE across turns — union the preset onto the
    // current tools (never drop a tool_search-activated one), APPEND missing ones
    // (so any reused prefix stays a prefix), and only call setActiveTools when the
    // set actually grows. Same class + no new tools ⇒ zero prefix change ⇒ the KV
    // cache is reused and the follow-up prefill is as instant as a tool-call one.
    let target = runtime.activeTools.slice();
    for (const name of preset) if (!target.includes(name)) target.push(name);
    // The corp system is offered as a tool ONLY at high/max effort (the user). Add it
    // at those efforts, strip it below — so lowering effort mid-session hides it
    // again. Kept at the END of the list so its presence/absence never disturbs
    // the cached prefix ahead of it.
    const corpRegistered = available.includes(CREATE_PRODUCTION_HIERARCHY);
    const wantCorp = corpToolEnabled(runtime.config.effort) && corpRegistered;
    /*
     * WHY THE TEAM TOOL IS OR IS NOT THERE — the two conditions, separately.
     *
     * A run where the CEO built a whole product alone turned out to have no
     * `talk_to_manager` in its advertised set at max effort, and the existing
     * dump could not say WHICH condition failed: the effort the harness holds,
     * or whether the tool was ever registered. Reading the gate's source and
     * concluding "it must have been available" is exactly how that run got
     * mis-attributed to the model choosing not to delegate.
     *
     * Opt-in on the same env as the tool dump, appended to the same file, so one
     * switch gives the whole picture.
     */
    const dbgPath = process.env.PI_ADV_DEBUG_TOOLS;
    if (dbgPath !== undefined && dbgPath.length > 0) {
      try {
        appendFileSync(
          dbgPath,
          `applyPreset: effort=${runtime.config.effort} corpEnabled=${corpToolEnabled(
            runtime.config.effort,
          )} corpRegistered=${corpRegistered} wantCorp=${wantCorp}\n` +
            /*
             * WHICH TOOLS PI ACTUALLY KNOWS, and which we are about to advertise.
             * Added while chasing a capability that activated cleanly and still
             * left its tools uncallable: without these two lines the question
             * "is the tool registered but unadvertised, or not registered at
             * all" cannot be answered from outside, and it is the first thing
             * worth knowing.
             */
            `  available(${available.length}): ${available.join(',')}\n` +
            `  target(${target.length}): ${target.join(',')}\n`,
        );
      } catch {
        /* a diagnostic must never break a turn */
      }
    }
    if (wantCorp && !target.includes(CREATE_PRODUCTION_HIERARCHY)) {
      target.push(CREATE_PRODUCTION_HIERARCHY);
    } else if (!wantCorp && target.includes(CREATE_PRODUCTION_HIERARCHY)) {
      target = target.filter((t) => t !== CREATE_PRODUCTION_HIERARCHY);
    }
    runtime.activeClass = cls;
    // Only touch the tool set (and thus the cached prefix) when it actually
    // changed — by length OR membership (the corp tool can be added or removed).
    const changed =
      target.length !== runtime.activeTools.length ||
      target.some((t, i) => t !== runtime.activeTools[i]);
    if (changed) {
      pi.setActiveTools(target);
      runtime.activeTools = target;
    }
    // Warn if the current model is too small for an advanced task.
    if (runtime.model !== null) {
      const warning = smallModelWarning(runtime.model, cls);
      if (warning !== null && ctx.hasUI) ctx.ui.notify(warning, 'warning');
    }
    // Keep the renderer's predictive-prefill tools in sync with what's now
    // resident on the slot (deduped ⇒ a no-op when the set didn't grow).
    publishPrefillContext(ctx, orderedToolDefs(runtime.activeTools));
    publishStatus(ctx);
  }

  function persistConfig(): void {
    pi.appendEntry(HARNESS_CONFIG_ENTRY, runtime.config);
  }

  /**
   * Record + publish the conversation title from the classify+title piggyback.
   * Emits it over the SAME status channel as the plan/repair status: a `title`
   * field in the structured harness status JSON, plus a dedicated `harness-title`
   * key. Persisted so a reloaded session keeps its title. (App-side display is a
   * separate follow-up wave — this just makes the title available.)
   */
  function setTitle(title: string, ctx: ExtensionContext): void {
    const trimmed = title.trim();
    if (trimmed.length === 0 || runtime.title === trimmed) return;
    runtime.title = trimmed;
    pi.appendEntry(HARNESS_TITLE_ENTRY, { title: trimmed });
    ctx.ui.setStatus('harness-title', trimmed);
    publishStatus(ctx);
  }

  // Restore persisted config + start the status timer on session start.
  pi.on('session_start', (_event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.config = restoreConfig(getEntries(ctx));
    runtime.permission.setMode(runtime.config.mode);
    // A new / switched session must NOT inherit the previous session's live
    // checklist or subagent panel. Reset them here (session_start also fires on a
    // switch_session load) so the publish below republishes an EMPTY plan instead
    // of leaking the old chat's tasks into the new one.
    runtime.plan = null;
    runtime.planTitle = null;
    runtime.subagentSnapshot = null;
    // Fresh session → idle stage and cleared per-turn loop/verify state.
    runtime.stage = 'idle';
    runtime.loopDetector = null;
    runtime.touchedFiles = [];
    runtime.ranCommands = [];
    runtime.delegatedThisTurn = false;
    runtime.verifyActive = false;
    runtime.verifyFixesRemaining = 0;
    // A new/switched session must not inherit the previous session's relaxed
    // tool schemas (a per-session weakening of validation must not leak).
    relaxedSchemas.clear();
    // A new/switched session gets a fresh title (recomputed on its first turn).
    runtime.title = restoreTitle(getEntries(ctx));
    // Push repair deps now that the effort level is known (abortThreshold etc.).
    bridge.push();
    if (runtime.statusTimer !== null) clearInterval(runtime.statusTimer);
    /*
     * The tick also RETRIES THE WARM-UP until it takes. session_start fires
     * before the model server exists on a normal app open, so the one-shot
     * attempt below always lost that race; `maybeWarmPrefix` self-guards on the
     * canonical prompt, so re-asking is free once it has succeeded and is the
     * difference between a warm first message and a 12-second one.
     */
    runtime.statusTimer = setInterval(() => {
      publishStatus(ctx);
      maybeWarmPrefix(ctx);
    }, 1000);
    publishStatus(ctx);
    publishSubagents(ctx);
    // Warm the deterministic prefix now that the session (and its model + utility
    // endpoint) is up — covers the common case where model_select never fires
    // (new chat / app restart on the same model).
    maybeWarmPrefix(ctx);
  });

  pi.on('session_shutdown', () => {
    if (runtime.statusTimer !== null) {
      clearInterval(runtime.statusTimer);
      runtime.statusTimer = null;
    }
  });

  // Classify each task and load its preset before the agent loop runs. When a
  // utility model is configured, ambiguous heuristics escalate to a tier-2
  // double-check (classifyWithEscalation); otherwise the pure heuristic stands.
  pi.on('before_agent_start', async (event, ctx) => {
    // FIRST, before anything else: give the user the slot. Post-turn naming and
    // the reviewer share the single llama-server, and until they stop this
    // message is queued behind them. Cancelling the PENDING timer is the case
    // that actually matters — a fast follow-up lands inside POST_TURN_DELAY_MS,
    // so nothing has been sent yet and there is nothing to wait for. The abort
    // covers a slower one that catches work already in flight; both are
    // fire-and-forget, and naming retries at the next turn end.
    if (postTurnTimer !== null) clearTimeout(postTurnTimer);
    postTurnTimer = null;
    postTurnWork?.abort();
    postTurnWork = null;
    runtime.turnIndex += 1;
    runtime.currentCtx = ctx;
    runtime.lastPrompt = event.prompt;
    // Fresh agent loop: a new loop detector (effort-scaled cap/streaks) and an
    // empty touched-file set. Reset per turn (fix #3). NOTE: the verify fix budget
    // is deliberately NOT reset here — a self-triggered fix revision is also a new
    // before_agent_start, and verifyTurn manages that budget via `verifyActive`.
    runtime.loopDetector = createLoopDetector(
      loopDetectorConfig(effortKnobs(runtime.config.effort)),
    );
    runtime.touchedFiles = [];
    runtime.ranCommands = [];
    runtime.delegatedThisTurn = false;
    // Capability-affirming system prompt (fix: the model must KNOW it can act on
    // the machine and must not disclaim abilities it has). pi 0.68.1 applies a
    // `{ systemPrompt }` returned from this handler for the turn (agent-session's
    // emitBeforeAgentStart), chained across extensions — so we augment whatever
    // base/previously-chained prompt arrives.
    // FREEZE it after the first build: pi regenerates its tool-usage guidance
    // non-deterministically per turn (reorders / adds / drops lines), which shifts
    // the ~7k-char prompt and forces a FULL KV re-prefill on EVERY message. Reusing
    // the canonical prompt keeps the prefix byte-identical so follow-ups reuse it.
    // Correct the frozen prompt if the TEAM has appeared or gone since it was
    // built — the freeze below is what made the team section unreachable, because
    // warm-up runs at default effort and the session is raised afterwards.
    const augmentedSystemPrompt =
      runtime.canonicalSystemPrompt ?? augmentSystemPrompt(event.systemPrompt);
    runtime.canonicalSystemPrompt = augmentedSystemPrompt;
    // Classification REMOVED from the turn path (the user: "we seldom use it at all,
    // let's just completely remove"). The turn-1 {title,class} piggyback cost
    // ~2.5s of TTFT — an awaited utility call before the model could even start.
    // Instead use a fixed default preset: deterministic, and it matches the
    // model-load warm-up ('coding') so the KV prefix is reused. Conversation naming is now a
    // post-turn background pass (agent_end) that never blocks the reply. Re-add
    // per-task classify later if the routing proves worth the latency.
    const cls: TaskClass = runtime.config.preset === 'auto' ? 'coding' : runtime.config.preset;
    /*
     * SEMANTIC TOOL PRELOAD IS GONE. the user: "ensure that semantic tool preload is
     * not happening per turn or at all."
     *
     * It scored each message and appended the tools it looked like it needed, to
     * save a `tool_search` round-trip. "Append-only, so the KV prefix survives"
     * was the justification and it was wrong in the way that matters: the tool
     * SCHEMAS sit in the prompt prefix, so appending a tool changes the prefix,
     * and a prefix that changes with the wording of every message is a prefix
     * that is never reused. On one model slot that is the whole cost of a turn.
     *
     * It also made the tool set unpredictable — the same question could arrive
     * with a different set of verbs depending on how it was phrased, which is a
     * plausible contributor to the looping the user has been seeing.
     *
     * The preset alone is deterministic, matches the model-load warm-up prefix,
     * and a role that needs something else can still reach for `tool_search`.
     */
    applyPreset(cls, ctx);
    pi.appendEntry(HARNESS_CLASSIFY_ENTRY, { class: cls, turnIndex: runtime.turnIndex });
    // Replace the turn's system prompt with the capability-affirming version.
    return { systemPrompt: augmentedSystemPrompt };
  });

  // Running-task timer.
  pi.on('agent_start', (_event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.taskStart = Date.now();
    setStage('working', ctx);
    publishStatus(ctx);
  });
  // NOT async by design — see the comment on setStage(settled) below: anything
  // awaited here delays the turn-complete signal reaching the UI.
  pi.on('agent_end', (event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.taskStart = null;
    publishStatus(ctx);
    /*
     * A TURN THAT ENDED BY ASKING WHICH OPTION TO TAKE IS A TURN THAT STOPPED.
     *
     * MEASURED, run 3: sixty minutes in with two hours left, the lead wrote a
     * status summary and finished with "A) … B) … C) … Which would you prefer?"
     * and went idle. Nobody was going to answer. The corp bumps could not help —
     * they fire on a MESH role's turn end and the lead is the chat model, outside
     * the mesh — so the run held a question until the clock ran out.
     *
     * `sendUserMessage` is documented "Always triggers a turn", and the loop
     * detector already uses this path, so one nudge restarts it. ONCE per session:
     * a model that asks again after being told to choose is telling us something
     * real, and a guard that keeps overriding the same answer is worse than the
     * stall. See handback.ts for why this is narrow — `ask_user` exists for a
     * genuine blocker, and using the tool is exactly what separates the two.
     */
    if (!runtime.nudgedHandback) {
      const finalText = lastAssistantText(event.messages);
      if (isChoiceHandback(finalText)) {
        runtime.nudgedHandback = true;
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'steer', cause: 'handback' });
        pi.sendUserMessage?.(HANDBACK_NUDGE);
      }
    }
    /*
     * A TURN CUT OFF AT THE OUTPUT CEILING IS A TURN THAT DID NOTHING.
     *
     * See OUTPUT_LIMIT_NUDGE: run 16's CEO spent 20,541 tokens and 28 minutes
     * printing an application into the chat, hit `stopReason: 'length'`, wrote
     * no files, and the run ended there — silently, because only the corp roles
     * had any handling for this.
     *
     * Checked AFTER the handback nudge and gated on it not having fired, so a
     * single turn can never send two steers.
     */
    if (!runtime.nudgedHandback && !runtime.nudgedOutputLimit) {
      if (endedAtOutputLimit(event.messages)) {
        runtime.nudgedOutputLimit = true;
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'steer', cause: 'output-limit' });
        pi.sendUserMessage?.(OUTPUT_LIMIT_NUDGE);
      }
    }
    // THE USER OUTRANKS EVERYTHING BEHIND THEM. Naming and the reviewer both run
    // on the single llama-server slot, so while either is in flight the user's
    // next message queues behind it — MEASURED, a follow-up typed the instant a
    // reply finished took 1255ms against 256ms for the chat's first message.
    // before_agent_start aborts this, so sending anything reclaims the slot.
    if (postTurnTimer !== null) clearTimeout(postTurnTimer);
    postTurnWork?.abort();
    const work = new AbortController();
    postTurnWork = work;
    /** Set below when this turn should be named; run after the quiet pause. */
    let nameLater: (() => void) | null = null;
    // Auto-name the conversation after a turn concludes (the user) — now that
    // classification is gone from the turn path, naming is a post-turn background
    // pass so it NEVER blocks the reply. Reuses the cache-sharing {title,class}
    // piggyback (the just-run turn's KV is resident, so only the tiny title
    // instruction + answer are new); we keep only the title. Fire-and-forget.
    //
    // Gated on the title still being MISSING rather than on turn 1: a fast typist
    // aborts the first attempt, and a chat that never gets a name because the
    // user replied quickly is worse than naming it one turn later.
    if (runtime.title === null && asyncClassifier !== undefined && runtime.lastPrompt !== null) {
      const namePrompt = runtime.lastPrompt;
      // Use the SAME frozen system prompt the turn ran on so the naming request
      // shares the conversation's resident KV (cheap) instead of re-prefilling.
      const sys =
        runtime.canonicalSystemPrompt ??
        augmentSystemPrompt(
          typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '',
          {},
        );
      const input: ClassifyInput = {
        prompt: namePrompt,
        turnIndex: 1,
        priorMessages: buildConversationPrefix(getEntries(ctx), sys, namePrompt, false),
        // Same tools the turn ran with (in the same order) so the naming request's
        // prefix matches the resident slot — cheap and non-evicting (see below).
        tools: orderedToolDefs(runtime.activeTools),
        // Fire-and-forget: never blocks the reply, so give it room to finish even
        // if the reasoning model spends a few seconds before the tiny JSON (the
        // 5s default was clipping it → null title).
        timeoutMs: 30000,
        // The user's next message cancels this; it retries at the next turn end.
        signal: work.signal,
      };
      nameLater = () =>
        void asyncClassifier(input, classify(input)).then((r) => {
          if (r?.title !== undefined && work.signal.aborted !== true) setTitle(r.title, ctx);
        });
    }
    const output = extractAssistantText(event.messages);
    const settled: HarnessStage = output.length > 0 ? 'done' : 'idle';
    // Settle the turn NOW. CRITICAL (the user: "the stop/pause buttons persist a few
    // seconds after generation is complete"): pi delivers `agent_end` to its RPC
    // subscribers — i.e. the app — only AFTER every extension handler has resolved
    // (agent-session emits to extensions first, listeners after). The composer's
    // Stop/Pause button is driven by that event, so awaiting post-turn work here
    // pinned the button on Stop for the whole reviewer pass (a blocking utility-LLM
    // call: up to 5s at the default effort, far longer at high/max with real
    // verify). So this handler must never await: the turn's completion signal
    // reaches the UI immediately, and verify/review run DETACHED below.
    setStage(settled, ctx);
    // Post-turn verify/review, off the event-delivery path. A revision still
    // arrives the same way it always did — a private `followUp` steer from
    // verifyTurn/reviewTurn — it just starts as a visible follow-up turn instead of
    // silently holding the turn open.
    const turnAtEnd = runtime.turnIndex;
    // WAIT before touching the model. Everything below shares the chat's single
    // llama-server slot, and a fast follow-up sent while it runs waits behind it.
    // The pause gives the user a window in which nothing is running at all, and
    // before_agent_start clears this timer — so a quick reply cancels the work
    // before it is ever sent, rather than racing it. See POST_TURN_DELAY_MS.
    postTurnTimer = setTimeout(() => {
      postTurnTimer = null;
      if (work.signal.aborted) return;
      nameLater?.();
      void (async () => {
        try {
          // 1) Effort high/max → run the project's REAL checks on coding/file-ops
          //    turns. If it steers a fix, skip the LLM reviewer this cycle (don't
          //    double-steer the same revision — the reviewer runs on the fixed
          //    result next time).
          const fixRequested = await verifyTurn(ctx);
          // 2) Otherwise → reviewer + adversarial critique of the produced result.
          const revisionRequested = fixRequested || (await reviewTurn(output, ctx, work.signal));
          // Stage bookkeeping, but ONLY while this turn is still the current one:
          // verifyTurn/reviewTurn move the stage to 'verifying'/'reviewing', and a
          // NEW user turn may have started while they ran — never stomp its
          // 'working' stage with this turn's leftovers.
          if (runtime.turnIndex !== turnAtEnd) return;
          setStage(revisionRequested ? 'revising' : settled, ctx);
        } catch {
          // Post-turn work is best-effort: never surface as a turn failure.
          if (runtime.turnIndex === turnAtEnd) setStage(settled, ctx);
        }
      })();
    }, options.postTurnDelayMs ?? POST_TURN_DELAY_MS);
    // Node keeps the process alive for a pending timer; this one must never be
    // the reason a CLI pi lingers after its work is done.
    (postTurnTimer as { unref?: () => void }).unref?.();
  });

  // Loop / no-progress breaking (fix #3), plus touched-file tracking for the
  // verify syntax fallback. Feeds the per-turn detector the identical-call streak
  // (before execution) and the consecutive-error streak (after execution).
  pi.on('tool_call', (event, ctx) => {
    runtime.currentCtx = ctx;
    /*
     * A COMMAND THAT NEVER RETURNS TAKES THE WHOLE TURN WITH IT — in the ORDINARY
     * chat, not only inside a corporation.
     *
     * `wouldHang` was wired into the corp role-agent path and nowhere else, so a
     * solo turn was ungated. MEASURED right after that fix landed: asked to fix a
     * tkinter app, the plain chat ran `python3 .../app.py` to see if it worked and
     * sat on root.mainloop() for over five minutes with nothing to close the
     * window. Same failure the corp path had just been protected from, one door
     * along — registered is not reachable.
     */
    if (event.toolName === 'bash') {
      const cmd = (event.input as { command?: unknown })?.command;
      if (typeof cmd === 'string') {
        runtime.ranCommands.push(cmd);
        const hang = wouldHang(cmd, runtime.workspaceRoot ?? undefined);
        if (hang !== null) return { block: true, reason: hang };
      }
    }
    // Remember files this turn writes/edits (for verify's syntax fallback, fix #4).
    /* A subagent's own commands never reach `runtime.ranCommands`, so remember
     * that the turn delegated — see neverExercised(). */
    if (event.toolName === 'spawn_subagent') runtime.delegatedThisTurn = true;
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const input = event.input as Record<string, unknown>;
      const path = input.path ?? input.file_path ?? input.filePath;
      if (typeof path === 'string' && path.length > 0 && !runtime.touchedFiles.includes(path)) {
        runtime.touchedFiles.push(path);
      }
    }
    /*
     * A command that OPENS something hands the work to a real Mac app, and the
     * model gets back an empty stdout and exit 0 — no way to tell a window now
     * exists. Remember what was opened so the result can say which tool sees it.
     */
    if (event.toolName === 'bash') {
      const command = (event.input as { command?: unknown }).command;
      lastOpened = typeof command === 'string' ? detectOpenedApp(command) : undefined;
    }
    /*
     * NAVIGATING IS BROWSING. the user's goal, verbatim: "load browser navigate by
     * default and load the capability suite of browser tools when it's called
     * immediately."
     *
     * This used to activate the rest of the suite here, on the first navigate —
     * the moment wanting to click becomes certain. IT NEVER WORKED. A run's tool
     * array is snapshotted when the run starts (see ALWAYS_BROWSER_TOOLS), so
     * activating mid-run changed nothing at all, and the click turn was spent
     * discovering it could not click — the loop the user kept screenshotting, with
     * this code in place the whole time. The suite is in the preset now, which is
     * the only place that can deliver on what he asked for.
     */
    const detector = runtime.loopDetector;
    if (detector === null) return;
    const signal = detector.onToolCall(event.toolName, event.input);
    if (handleLoopSignal(signal)) {
      // Aborted (identical-call or hard-cap) → also block this final bad call.
      return { block: true, reason: signal.kind === 'abort' ? signal.reason : undefined };
    }
    return;
  });
  pi.on('tool_execution_end', (event, ctx) => {
    runtime.currentCtx = ctx;
    // A completed tool call clears the transient 'repairing' stage (fix #5).
    if (runtime.stage === 'repairing') setStage('working', ctx);
    const detector = runtime.loopDetector;
    if (detector === null) return;
    // Consecutive-error streak → steer once, then abort (can't block post-hoc).
    handleLoopSignal(detector.onToolResult(event.isError === true));
  });

  // Tool-output truncation (the user): cap a runaway tool result (`ls -R`, a huge
  // grep/find, a chatty build) to ~1.5k tokens BEFORE it enters the conversation,
  // so one command can't blow the whole context (the observed 24.5k-token `ls -R`
  // → HTTP 400). Applied to the shell/enumeration tools whose output is
  // disposable; `read` is left alone (its content is the point, and pi already
  // bounds it). Only the text parts are capped — image parts pass through.
  const TRUNCATE_TOOLS = new Set(['bash', 'grep', 'find', 'ls']);
  /** What the last bash command opened, if anything — consumed by its result. */
  let lastOpened: ReturnType<typeof detectOpenedApp>;
  pi.on('tool_result', (event) => {
    // The open-an-app note rides on the bash result that caused it (the user: give it
    // the tools and the snapshot immediately, rather than leaving it to guess).
    if (event.toolName === 'bash' && lastOpened !== undefined) {
      const opened = lastOpened;
      lastOpened = undefined;
      const note = openedAppNote(opened);
      const withNote = event.content.map((part, i) =>
        i === 0 && part.type === 'text' ? { ...part, text: `${part.text}${note}` } : part,
      );
      const content =
        withNote.length > 0 ? withNote : [{ type: 'text' as const, text: note.trimStart() }];
      return { content };
    }
    /*
     * A FAILED EDIT MUST COME BACK WITH THE DIFF ALREADY DONE.
     *
     * Run G: six `edit` calls, all rejected, the file never written, ten minutes
     * gone — and the last one missed by a single character (`v0.9_BETA` for
     * `v0.9 BETA`) inside a 1165-character file. All pi says is "Could not find
     * edits[1] ... must match exactly", so the model re-read the file four times
     * hunting for a difference it cannot see, then hit the loop breaker.
     *
     * The harness holds both strings. It runs the comparison and hands over the
     * line, the column, the two characters and — because the batch is atomic —
     * which entries were ALREADY correct, so the good ones aren't re-derived and
     * re-broken next round. Same shape as every other steer that has actually
     * moved this model: perform the check, don't request it.
     */
    if (event.toolName === 'edit' && event.isError) {
      const note = diagnoseEditFailure(event.input, runtime.workspaceRoot ?? undefined);
      if (note.length > 0) {
        return {
          content: event.content.map((part, i) =>
            i === 0 && part.type === 'text' ? { ...part, text: `${part.text}\n${note}` } : part,
          ),
        };
      }
      return;
    }
    if (!TRUNCATE_TOOLS.has(event.toolName)) return;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== 'text') return part;
      const { text, truncated } = truncateToolOutput(part.text);
      if (!truncated) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });

  // Model changes → small-model warning + status refresh + preemptive warm-up.
  pi.on('model_select', (event, ctx) => {
    runtime.currentCtx = ctx;
    runtime.model = { id: event.model.id, name: event.model.name };
    if (runtime.activeClass !== null) {
      const warning = smallModelWarning(runtime.model, runtime.activeClass);
      if (warning !== null && ctx.hasUI) ctx.ui.notify(warning, 'warning');
    }
    publishStatus(ctx);
    // Preemptively prime the DETERMINISTIC prefix (canonical system prompt + the
    // initial tool set) BEFORE the user's first message, so it only prefills its
    // own few tokens instead of a full cold system+tools prefill (~3s). Shared with
    // session_start (see maybeWarmPrefix) so it fires whether the model CHANGED or
    // a new session just came up on the same model. CRITICAL: chat templates render
    // tools at the START of the prompt, so a system-ONLY warm-up reuses nothing once
    // the real turn carries tools — the tools MUST be in the warm-up.
    maybeWarmPrefix(ctx);
  });

  // /harness command protocol.
  pi.registerCommand('harness', {
    description: 'Configure the harness: set-mode, effort, preset, status, classify.',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(' ');
      const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
      const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

      switch (sub) {
        case '':
        case 'help':
          ctx.ui.notify(HELP);
          return;

        case 'status': {
          publishStatus(ctx);
          ctx.ui.notify(`harness status:\n${JSON.stringify(buildStatus(ctx), null, 2)}`);
          return;
        }

        case 'set-mode': {
          if (!isPermissionMode(rest)) {
            ctx.ui.notify(
              `Unknown mode "${rest}". Options: bypass, reviewer, review-all.`,
              'error',
            );
            return;
          }
          runtime.config = updateConfig(runtime.config, { mode: rest });
          runtime.permission.setMode(rest);
          persistConfig();
          publishStatus(ctx);
          ctx.ui.notify(`permission mode → ${rest}`);
          return;
        }

        case 'effort': {
          if (!isEffortLevel(rest)) {
            ctx.ui.notify(`Unknown effort "${rest}". Options: low, medium, high, max.`, 'error');
            return;
          }
          runtime.config = updateConfig(runtime.config, { effort: rest });
          persistConfig();
          // Re-push repair deps so the new abortThreshold / repairAttempts take
          // effect on the provider's live ladder immediately.
          bridge.push();
          /*
           * RE-DERIVE THE TOOL SET. Effort decides whether the corporation is on
           * offer, but only `applyPreset` ever adds or removes
           * `create_production_hierarchy` — so raising effort used to change the
           * number and nothing else, leaving the tool absent until some later
           * turn happened to reclassify. Adaptive effort now moves per message,
           * which makes that gap the normal case rather than a corner: the user
           * raised effort, asked for a manager, and was told no such tool existed.
           * `applyPreset` only touches the active set when it actually changed,
           * so re-applying the SAME class here is free when nothing moved.
           */
          if (runtime.activeClass !== null) applyPreset(runtime.activeClass, ctx);
          publishStatus(ctx);
          const k = effortKnobs(rest);
          ctx.ui.notify(
            `effort → ${rest} (repairAttempts ${k.repairAttempts}, abortThreshold ${k.abortThreshold}, reviewPasses ${k.reviewPasses}, adversarial ${k.adversarialChecks})`,
          );
          return;
        }

        /*
         * THE WORKSPACE, CHANGED LIVE. the user: "you don't have to restart pi ...
         * it's not like functionally anything should need a restart just because
         * we're essentially typing into a terminal session cd '<path>'."
         *
         * Every tool reads `runtime.workspaceRoot` per call, so this takes effect
         * on the very next one — files and bash together. Sent by the app when a
         * chat opens and whenever the folder dropdown changes.
         */
        case 'workspace': {
          const dir = rest.trim();
          if (dir === '') {
            ctx.ui.notify('Usage: /harness workspace <absolute path>', 'error');
            return;
          }
          runtime.workspaceRoot = dir;
          publishStatus(ctx);
          ctx.ui.notify(`workspace → ${dir}`);
          return;
        }

        case 'preset': {
          const value = rest.toLowerCase();
          if (value !== 'auto' && !(TASK_CLASSES as readonly string[]).includes(value)) {
            ctx.ui.notify(
              `Unknown preset "${rest}". Use auto or: ${TASK_CLASSES.join(', ')}.`,
              'error',
            );
            return;
          }
          runtime.config = updateConfig(runtime.config, {
            preset: value as HarnessConfig['preset'],
          });
          persistConfig();
          if (value !== 'auto') applyPreset(value as TaskClass, ctx);
          else publishStatus(ctx);
          ctx.ui.notify(`preset → ${value}`);
          return;
        }

        case 'classify': {
          if (rest.length === 0) {
            ctx.ui.notify('Usage: /harness classify <text>');
            return;
          }
          const r = classify({ prompt: rest });
          ctx.ui.notify(
            `class: ${r.class}\nconfidence: ${r.confidence.toFixed(2)}${r.ambiguous ? ' (ambiguous)' : ''}\nsignals: ${r.signals.join(', ')}`,
          );
          return;
        }

        default:
          ctx.ui.notify(`Unknown subcommand "${sub}".\n${HELP}`, 'error');
      }
    },
  });

  return {
    controller: runtime.permission,
    getConfig: () => runtime.config,
    getStatus: (ctx) => buildStatus(ctx),
    applyPreset,
    buildRepairDeps,
    reviewTurn,
    verifyTurn,
  };
}

/** pi extension factory (default export loaded via `-e`). */
export default function activate(pi: ExtensionAPI): void {
  wireHarness(pi);
}

// --- Public API re-exports -------------------------------------------------

export {
  type AsyncClassifier,
  type Attachment,
  type ClassifyInput,
  type ClassifyMessage,
  type ClassifyOptions,
  type ClassifyResult,
  classify,
  TASK_CATEGORIES,
  TASK_CLASSES,
  TASK_TIERS,
  type TaskCategory,
  type TaskClass,
  type TaskTier,
} from './classify/classify.js';
export { createClassifierEscalation } from './classify/escalation.js';
export {
  COARSE_TIERS,
  COARSE_TO_MODEL,
  type CoarseTier,
  coarseTier,
  isCoarseTier,
  isModelTier,
  MODEL_TIERS,
  type ModelTier,
  modelTierForClass,
  TIER_LABEL,
} from './classify/tier.js';
export {
  corpToolEnabled,
  PROMOTE_STATUS_KEY,
  type PromoteSignal,
  registerCreateHierarchyTool,
} from './corp/promote-tool.js';
export {
  EFFORT_KNOBS,
  EFFORT_LEVELS,
  type EffortKnobs,
  type EffortLevel,
  effortKnobs,
  isEffortLevel,
} from './effort/effort.js';
export {
  createLoopDetector,
  DEFAULT_LOOP_ABORT_AFTER,
  DEFAULT_LOOP_STEER_AFTER,
  DEFAULT_WANDER_ABORT_AFTER,
  DEFAULT_WANDER_STEER_AFTER,
  EXPLORATION_TOOLS,
  isExplorationTool,
  type LoopCause,
  type LoopDetector,
  type LoopDetectorConfig,
  type LoopSignal,
  type LoopSnapshot,
  loopDetectorConfig,
  toolCallSignature,
} from './loop/loop-detector.js';
export {
  ADVANCED_CLASSES,
  inspectModelSize,
  isAdvancedClass,
  isSmallModel,
  type ModelLike,
  type ModelSizeInfo,
  parseModelParams,
  SMALL_MODEL_THRESHOLD_B,
  smallModelWarning,
} from './model/model-size.js';
export {
  type CallModel,
  type CallModelRequest,
  callModelFromEnv,
  createOpenAiCompatCallModel,
  type OpenAiCompatConfig,
  UTILITY_API_KEY_ENV,
  UTILITY_BASE_URL_ENV,
  UTILITY_MODEL_ENV,
} from './model-call/call-model.js';
export { createBashFlagger, interpretFlagReply } from './permissions/flag-bash.js';
export {
  type BashFlagger,
  type EvaluateInput,
  evaluateToolCall,
  isPermissionMode,
  PERMISSION_MODES,
  type PermissionController,
  type PermissionMode,
  type RegisterPermissionsOptions,
  registerPermissions,
  type ToolCallDecision,
} from './permissions/modes.js';
export {
  checkScaryBash,
  DEFAULT_SCARY_RULES,
  extendScaryRules,
  SCARY_EXACT,
  SCARY_PATTERNS,
  type ScaryBashRules,
} from './permissions/rules.js';
export {
  ALWAYS_ACTIVE_TOOLS,
  isToolSearchOnly,
  PRESET_TOOLS,
  type ResolvePresetOptions,
  resolvePresetTools,
  SUBAGENT_PRESET_CLASSES,
  TOOL_SEARCH_TOOL_NAME,
} from './presets/presets.js';
export {
  augmentSystemPrompt,
  CAPABILITY_PROMPT,
  CAPABILITY_PROMPT_MARKER,
  TEAM_PROMPT_MARKER,
} from './prompt/capability-prompt.js';
export {
  connectRepairBridge as connectHarnessRepairBridge,
  type LiveRepairDeps,
  REPAIR_BRIDGE_HELLO,
  REPAIR_BRIDGE_READY,
  type RepairBridgeReady,
} from './repair/bridge.js';
export {
  createToolCallFixer,
  extractJsonObject,
  withRepairAttempts,
} from './repair/fixer.js';
export {
  createHarnessExtraRungs,
  createRung3,
  createRung4,
  createRung5,
  createSessionRepairDeps,
  type HarnessRepairDeps,
  type RepairContext,
  type RepairResult,
  type RepairRung,
  relaxToolSchema,
  type ToolCallFixer,
  type ToolSchemaLike,
} from './repair/rungs.js';
export {
  adversarialCheck,
  parseReview,
  type ReviewInput,
  type ReviewResult,
  reviewOutput,
} from './review/review.js';
export {
  isSkillPath,
  registerSkillInstructions,
  SKILL_INSTRUCTIONS_TAG,
  type SkillContextMessage,
  skillNameFromPath,
  withSkillInstructions,
  wrapSkillContent,
} from './skills/skill-instructions.js';
export {
  DEFAULT_CONFIG,
  HARNESS_CLASSIFY_ENTRY,
  HARNESS_CONFIG_ENTRY,
  HARNESS_LOOP_ENTRY,
  HARNESS_REPAIR_ENTRY,
  HARNESS_REVIEW_ENTRY,
  HARNESS_STAGES,
  HARNESS_TITLE_ENTRY,
  HARNESS_VERIFY_ENTRY,
  type HarnessConfig,
  type HarnessStage,
  type HarnessStatus,
  isHarnessStage,
  isPlanItemStatus,
  PLAN_ITEM_STATUSES,
  type PlanItem,
  type PlanItemStatus,
  type PresetSelection,
  restoreConfig,
  type StoredEntryLike,
  updateConfig,
} from './state.js';
export {
  type BudgetInputs,
  buildChildSpawnPlan,
  type ChildAgentResult,
  type ConcurrencyBudget,
  computeConcurrencyBudget,
  deriveSubagentName,
  detectBudget,
  HARNESS_SUBAGENTS_STATUS_KEY,
  type HarnessSubagentsStatus,
  MAX_SUBAGENT_DEPTH,
  type RunChildAgentOptions,
  readSubagentDepth,
  registerSubagentTool,
  runChildAgent,
  type SchedulerSnapshot,
  SPAWN_SUBAGENT_TOOL_NAME,
  SUBAGENT_DEPTH_ENV,
  SubagentScheduler,
  type SubagentStatus,
  type SubagentStatusItem,
} from './subagent/index.js';
export {
  ASK_USER_SENTINEL,
  type AskUserAnswer,
  type AskUserMode,
  type AskUserSpec,
  describeAnswer,
  encodeAskUser,
  registerAskUser,
  specFromParams,
} from './tools/ask-user.js';
export {
  type ImageBridge,
  type ImageBridgeResult,
  imageBridgeFromEnv,
} from './tools/image-bridge-client.js';
export {
  EDIT_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  imageToolResult,
  pdFileUrl,
  registerImageTools,
} from './tools/image-tools.js';
export {
  normalizePlan,
  PLAN_TOOL_NAME,
  type PlanToolOptions,
  planSummary,
  registerPlanTool,
} from './tools/plan-tool.js';
export {
  registerToolSearch,
  type SearchToolsOptions,
  searchTools,
  type ToolLike,
  type ToolMatch,
  type ToolSearchOptions,
} from './tools/tool-search.js';
export {
  type CheckOutcome,
  detectPackageManager,
  detectProjectCheck,
  type ExecLike,
  makeExecBashRunner,
  makeFsProbe,
  type ProjectCheck,
  type ProjectProbe,
  runCheck,
  runVerifyPass,
  syntaxCheckCommand,
  VERIFY_TIMEOUT_MS,
  type VerifyBashRunner,
  type VerifyPassDeps,
  type VerifyPassResult,
} from './verify/verify.js';
