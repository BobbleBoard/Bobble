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

import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { createBashToolDefinition } from '@mariozechner/pi-coding-agent';
import { sharedTool, sharedToolNames } from '@pi-desktop/tool-bus';
import { registerCompactionGate } from './compaction-gate.js';
import { corpToolEnabled, registerCreateHierarchyTool } from './corp/promote-tool.js';
import { CREATE_PRODUCTION_HIERARCHY } from './corp/promotion.js';
import { effortKnobs, isEffortLevel } from './effort/effort.js';
import { announcedNextStep, announcedStepNudge } from './loop/announced-step.js';
import { HANDBACK_NUDGE, isChoiceHandback } from './loop/handback.js';
import { createLoopDetector, type LoopDetector, loopDetectorConfig } from './loop/loop-detector.js';
import { newSameCallState, noteRepeatedCall } from './loop/same-call.js';
import { silentEnd, silentEndNudge } from './loop/silent-end.js';
import { unfinishedPlan, unfinishedPlanNudge } from './loop/unfinished-plan.js';
import { emptyTally, noteResult } from './modality';
import { parseModelParams, smallModelCapabilityWarning } from './model/model-size.js';
import { type CallModel, callModelFromEnv } from './model-call/call-model.js';
import { warmSystemPrompt } from './model-call/warmup.js';
import { createOfflineLatch, NETWORK_TOOLS, OFFLINE_TOOL_NOTE } from './net/offline.js';
import { createBashFlagger } from './permissions/flag-bash.js';
import { forbiddenReason, forbiddenTools } from './permissions/forbidden.js';
import {
  isPermissionMode,
  type PermissionController,
  registerPermissions,
} from './permissions/modes.js';
import { capabilityForTool } from './presets/capabilities.js';
import { resolveBaseTools } from './presets/presets.js';
import { augmentSystemPrompt, SHELL_CWD_TRUTH } from './prompt/capability-prompt.js';
import { sameWording } from './prompt/same-wording.js';
import { connectRepairBridge, type LiveRepairDeps } from './repair/bridge.js';
import { createToolCallFixer, withRepairAttempts } from './repair/fixer.js';
import {
  createHarnessExtraRungs,
  type HarnessRepairDeps,
  relaxToolSchema,
  type ToolSchemaLike,
} from './repair/rungs.js';
import { adversarialCheck, reviewOutput } from './review/review.js';
import { registerScheduledTaskTool } from './scheduled/schedule-tool.js';
import { registerSkillInstructions } from './skills/skill-instructions.js';
import {
  HARNESS_SKILL_NOTE,
  loadTeachSkill,
  teachGiven,
  teachNote,
  wantsTeaching,
} from './skills/teach-skill.js';
import {
  DEFAULT_CONFIG,
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
import {
  HARNESS_SUBAGENTS_STATUS_KEY,
  type HarnessSubagentsStatus,
  MAX_SUBAGENT_DEPTH,
  readSubagentDepth,
} from './subagent/types.js';
import {
  type ConversationTitler,
  createConversationTitler,
  type TitleInput,
  type TitleMessage,
} from './title/conversation-title.js';
import { registerAskUser } from './tools/ask-user.js';
import { bashWrites } from './tools/bash-writes.js';
import { registerCapabilityTool } from './tools/capability-tool.js';
import { CHART_TOOL, projectChartKit, registerChartTool } from './tools/chart-tool.js';
import {
  coercedEditRefusal,
  coercedSearchRefusal,
  coercedWriteEscalation,
  coercedWriteRefusal,
  isCoercedEdit,
  isCoercedSearch,
  isCoercedToolCall,
} from './tools/coerced-write.js';
import { degenerateCommandRefusal } from './tools/degenerate-command.js';
import { DIAGRAM_TOOL, registerDiagramTool } from './tools/diagram-tool.js';
import { diskWalkRefusal, wouldWalkDisk } from './tools/disk-walk.js';
import { diagnoseEditFailure } from './tools/edit-diagnosis.js';
import { withForegroundServerStop } from './tools/foreground-server.js';
import { handmadeChartRefusal, isHandmadeChart } from './tools/handmade-chart.js';
import { mathFigureMarkup } from './tools/handmade-math.js';
import {
  handmadeMediaRefusal,
  isHandmadeMedia,
  type MediaKind,
  mediaFileKind,
  mediaFileRefusal,
} from './tools/handmade-media.js';
import { handmadeOfficeRefusal, isHandmadeOffice } from './tools/handmade-office.js';
import {
  countInlineDrawnSvgs,
  handwrittenDiagramRefusal,
  handwrittenInlineSvgRefusal,
  handwrittenMathRefusal,
  handwrittenSvgRefusal,
  handwrittenSvgRoute,
  inlineSvgRoute,
} from './tools/handwritten-svg.js';
import { wouldHang } from './tools/hang-guard.js';
import { registerImageTools } from './tools/image-tools.js';
import { applyBias, lastAssistantThought, planBias } from './tools/intent-bias.js';
import {
  drawWrittenSpec,
  looksLikeMathSpec,
  MATH_TOOL,
  type MathToolDeps,
  projectMathKit,
  registerMathTool,
} from './tools/math-tool.js';
import { registerModelTools } from './tools/model-tools.js';
import {
  OFFICE_MAKE_TOOL,
  officeGenDir,
  registerOfficeTools,
  withOfficeFormats,
} from './tools/office-tool.js';
import { detectOpenedApp, openDidNotHappen, openedAppNote } from './tools/opened-app.js';
import { registerPlanTool } from './tools/plan-tool.js';
import { PRESENT_TOOL_NAME, registerPresentTool } from './tools/present.js';
import { presentBridgeFromEnv } from './tools/present-bridge.js';
import { rawPageFetchRefusal, rawPageFetchUrl } from './tools/raw-page-fetch.js';
import { withRepeatNotice } from './tools/repeat-notice.js';
import {
  registerSandboxFileTools,
  resolveWorkspaceRoot,
  WORKSPACE_ROOT_ENV,
} from './tools/sandbox-fs.js';
import { buildCli, commandLineForCall, commandNameFor, pathFor } from './tools/tool-cli.js';
import { protectShimDollars, registerToolCli } from './tools/tool-cli-bridge.js';
import { toolCliGroups, toolCliShimCommands } from './tools/tool-cli-groups.js';
import { truncateToolOutput } from './tools/tool-output-truncate.js';
import { type CapturedTool, captureRegisteredTools } from './tools/tool-registry.js';
import { registerUseTool } from './tools/use-tool.js';
import { wouldDestroyWorkspace } from './tools/workspace-guard.js';
import { type Checkpoint, capture, prune, restore } from './verify/checkpoints.js';
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
 * …and a generation command (`media generate video`, `svg`, `3d …` in CLI mode)
 * gets this long. A command bash kills now stops the job behind it (the tool
 * hears the hang-up, the app cancels it), and a video took 521 s MEASURED — so
 * at 300 s every long render would be cancelled on the model's behalf, where
 * before it ran on out of sight and the model's retry queued a second one.
 */
export const MEDIA_BASH_TIMEOUT_S = 1800;

/**
 * Does a shell command run one of these commands — as its first word, or the
 * first word after a `;`, `&&`, `||` or `|`? Pure.
 */
export function runsCommand(command: string, names: readonly string[]): boolean {
  return command
    .split(/;|&&|\|\||\|/)
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .some((word) => names.includes(word));
}

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
  clock: number | ((command: string) => number) = DEFAULT_BASH_TIMEOUT_S,
): T {
  return {
    ...base,
    async execute(...args: never[]) {
      const params = args[1] as Record<string, unknown> | undefined;
      const command = typeof params?.command === 'string' ? params.command : '';
      const seconds = typeof clock === 'number' ? clock : clock(command);
      if (params !== undefined && params.timeout === undefined) {
        (args as unknown[])[1] = { ...params, timeout: seconds };
      }
      try {
        return await (base.execute as (...a: never[]) => Promise<unknown>)(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        /* pi's bash rethrows its clock as the output so far and then "Command
           timed out after N seconds" — never the bare `timeout:N` its exec
           raises inside — so this explanation matched nothing and the model
           read only the raw line (MEASURED: the visual suite's http.server
           run). What it printed is kept; the why and the way out follow. */
        const clocked = /\n*Command timed out after \d+ seconds\s*$/;
        if (!/^timeout:/.test(msg) && !clocked.test(msg)) throw e;
        const printed = msg
          .replace(clocked, '')
          .replace(/^timeout:\d+$/, '')
          .trimEnd();
        throw new Error(
          `${printed === '' ? '' : `${printed}\n\n`}` +
            `That command did not finish within ${seconds}s, so it was stopped and control ` +
            'came back to you. Commands that open a window or start a server never return ' +
            'on their own — run those with `background: true`, or drive the thing ' +
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
  /**
   * The working folder the model has been TOLD — by the frozen prompt's own
   * line, or by the note a turn carried when the folder moved. Compared against
   * `workspaceRoot` at every turn start; see the note in before_agent_start.
   */
  announcedWorkspace: string | null;
  /** The working folder the frozen prompt itself names (null when it names none). */
  promptWorkspace: string | null;
  /** The capability just switched on, named while its re-prefill runs. */
  loadingCapability: string | null;
  /** Conversation title, produced by the background titler (computed once). */
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
  /**
   * THE MESSAGES THAT ACTUALLY WENT OVER THE WIRE on the turn's last provider
   * request — the provider's own shape, after every hook (the canvas block, the
   * workspace note pi keeps as a hidden custom message, the tool loop's steps).
   * Anything that later shares the conversation's resident KV — the titler, the
   * reviewer, the composer's prime of the next message — must send THESE bytes
   * followed by the reply, not a rendering of its own: MEASURED 2026-09-13, a
   * prefix rebuilt from the transcript missed the hidden workspace note and
   * rewrote the single slot from the first user message on, so every second
   * message of every chat re-read the conversation.
   */
  lastRequestMessages: readonly Record<string, unknown>[] | null;
  /** The finished turn's messages (agent_end), for the reply that followed. */
  lastTurnMessages: readonly unknown[];
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
  /** What each of those files looked like BEFORE this turn touched it. */
  checkpoints: Checkpoint[];
  /** Commands this turn actually ran — the other half of "did you exercise it". */
  ranCommands: string[];
  /** This turn handed work to a subagent, whose commands never reach
   *  `ranCommands` — so "nothing was run" cannot be concluded. */
  delegatedThisTurn: boolean;
  /** One handback nudge per session — see the agent_end hook. */
  nudgedHandback: boolean;
  /** One small-model caveat per session — see the tool_call hook. */
  warnedSmallModel: boolean;
  /** One-shot: the output-limit steer has already been sent this session. */
  nudgedOutputLimit: boolean;
  /** One-shot: the model was told its own plan still had steps left in it. */
  nudgedUnfinished: boolean;
  /** The announced-next-step nudge has fired this session (loop/announced-step.ts). */
  nudgedAnnounced: boolean;
  /** The one "you ended without a word" steer this session has (loop/silent-end.ts). */
  nudgedSilent: boolean;
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
  applyPreset(ctx: ExtensionContext): void;
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

/** Everything the chat has said to the model: the person's messages and every tool result. */
function chatTextOf(entries: readonly StoredEntryLike[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const msg = (e as { message?: { role?: unknown; content?: unknown } }).message;
    if (msg?.role === 'user' || msg?.role === 'toolResult') parts.push(messageText(msg.content));
  }
  return parts.join('\n');
}

/**
 * The folder the model was last told about on this branch: the last workspace
 * note's (its details say which), else the folder the frozen prompt names. A
 * note from before notes said which folder is taken to be the one carried.
 */
export function announcedOnBranch(
  entries: readonly StoredEntryLike[],
  promptWorkspace: string | null,
  carried: string | null,
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'custom_message' || e.customType !== HARNESS_WORKSPACE_NOTE) continue;
    const root = (e.details as { root?: unknown } | undefined)?.root;
    return typeof root === 'string' ? root : carried;
  }
  return promptWorkspace;
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

/** A content block of the given type (structural). */
function isBlock(b: unknown, type: string): boolean {
  return typeof b === 'object' && b !== null && (b as { type?: unknown }).type === type;
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
): TitleMessage[] {
  const messages: TitleMessage[] = [];
  if (systemPrompt.trim().length > 0) messages.push({ role: 'system', content: systemPrompt });
  /*
   * THE PROVIDER'S OWN SHAPE, message for message: untrimmed text, the turn's
   * thoughts as `reasoning_content`, its tool calls, and each tool result as a
   * `tool` message. This prefix is sent to share the conversation's resident
   * KV, and it only shares what renders IDENTICALLY — a reply carried as bare
   * text rendered with an empty think block where the turn had its thoughts,
   * and the slot was rewritten from there (MEASURED 2026-09-13: 160 tokens
   * prefilled again on the next turn, every chat).
   */
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const msg = (e as { message?: { role?: unknown; content?: unknown } }).message;
    const role = msg?.role;
    if (role === 'user') {
      const text = messageText(msg?.content);
      if (text.length > 0) messages.push({ role, content: text });
    } else if (role === 'assistant') {
      const blocks = Array.isArray(msg?.content) ? (msg.content as unknown[]) : [];
      const text = messageText(msg?.content);
      const reasoning = blocks
        .filter((b): b is { type: 'thinking'; thinking?: string } => isBlock(b, 'thinking'))
        .map((b) => b.thinking ?? '')
        .join('');
      const toolCalls = blocks
        .filter((b): b is { type: 'toolCall'; id: string; name: string; arguments: unknown } =>
          isBlock(b, 'toolCall'),
        )
        .filter((b) => typeof b.name === 'string' && b.name.length > 0)
        .map((b) => ({
          id: String(b.id ?? ''),
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.arguments ?? {}) },
        }));
      if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue;
      messages.push({
        role,
        content: text,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === 'toolResult') {
      const m = msg as { toolCallId?: unknown; toolName?: unknown; content?: unknown };
      messages.push({
        role: 'tool',
        tool_call_id: typeof m.toolCallId === 'string' ? m.toolCallId : '',
        name: typeof m.toolName === 'string' ? m.toolName : '',
        content: messageText(m.content),
      });
    }
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
/**
 * A pi assistant message as provider-llamacpp / provider-mlx put it on the wire
 * (buildChatCompletionsRequest): joined text (null when empty), the thoughts as
 * `reasoning_content`, named tool calls as `tool_calls`.
 */
function assistantAsWire(msg: { content?: unknown }): Record<string, unknown> | undefined {
  const blocks = Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => isBlock(b, 'text'))
    .map((b) => b.text)
    .join('');
  const reasoning = blocks
    .filter((b): b is { type: 'thinking'; thinking?: string } => isBlock(b, 'thinking'))
    .map((b) => b.thinking ?? '')
    .join('');
  const toolCalls = blocks
    .filter((b): b is { type: 'toolCall'; id: string; name: string; arguments: unknown } =>
      isBlock(b, 'toolCall'),
    )
    .filter((b) => typeof b.name === 'string' && b.name.length > 0)
    .map((b) => ({
      id: String(b.id ?? ''),
      type: 'function' as const,
      function: { name: b.name, arguments: JSON.stringify(b.arguments ?? {}) },
    }));
  if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) return undefined;
  return {
    role: 'assistant',
    content: text.length > 0 ? text : null,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * What the slot holds after a turn: the turn's last request, verbatim, and the
 * reply that was generated onto it. `null` until a request has gone out.
 */
function residentConversation(
  lastRequest: readonly Record<string, unknown>[] | null,
  turnMessages: readonly unknown[],
): Record<string, unknown>[] | null {
  if (lastRequest === null) return null;
  const last = [...turnMessages]
    .reverse()
    .find((m) => (m as { role?: unknown }).role === 'assistant') as
    | { content?: unknown }
    | undefined;
  const reply = last === undefined ? undefined : assistantAsWire(last);
  return reply === undefined ? [...lastRequest] : [...lastRequest, reply];
}

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
  '  restore [path]             list what this turn changed, or put one file back',
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

/**
 * WHAT IS ALREADY RESIDENT IN THE MODEL SERVER'S KV — remembered for the PROCESS,
 * because that is what the KV belongs to.
 *
 * pi re-wires this extension for every session: MEASURED with a per-wiring tag,
 * one pi child answering three new chats produced three different wirings, so
 * every closure-scoped memory of "we already warmed this prefix" and "this is
 * the prompt we froze" started empty each time. The visible cost was a full cold
 * warm-up per new chat (~9.7k tokens, ~8s here) — and worse than the time, that
 * warm-up lands on the single slot AFTER the composer has primed an attachment
 * into it, so a prime that had already finished was thrown away and the send
 * re-read every token of it.
 *
 * There is one llama-server behind all of those wirings, so the record of what
 * it is holding lives beside it, not inside whichever wiring happened to ask.
 */
interface ResidentPrefix {
  canonical: string | null;
  warmedKey: string | null;
}

/*
 * ON globalThis, DELIBERATELY.
 *
 * Module scope is not process scope here: pi re-imports this extension for each
 * session, so a module-level `let` starts empty in every new chat exactly like a
 * closure variable does (MEASURED: three wirings, three module instances, three
 * cold warm-ups). The llama-server is the thing that is genuinely per-process,
 * and a well-known symbol is the only place with that lifetime. Nothing else
 * belongs here — this is a note about ONE server's KV, not a store.
 */
/** The custom message that tells the model its working folder moved. */
const HARNESS_WORKSPACE_NOTE = 'harness-workspace';

const RESIDENT = Symbol.for('pi-desktop.harness.residentPrefix');
const processGlobals = globalThis as unknown as Record<symbol, ResidentPrefix | undefined>;
function processResidentPrefix(): ResidentPrefix {
  const existing = processGlobals[RESIDENT];
  if (existing !== undefined) return existing;
  const fresh: ResidentPrefix = { canonical: null, warmedKey: null };
  processGlobals[RESIDENT] = fresh;
  return fresh;
}
const residentPrefix = processResidentPrefix();

/** Forget what the server is holding — for tests, and for a genuinely new server. */
export function forgetResidentPrefix(): void {
  residentPrefix.canonical = null;
  residentPrefix.warmedKey = null;
}

/**
 * WHAT A FORK MUST NOT FORGET — the conversation's frozen prompt and its folder.
 *
 * pi's `fork` (editing a message; taking one back with ⌘Z) continues the SAME
 * conversation on a branch: a new session file, and so a new wiring of this
 * extension (see RESIDENT above), which starts with nothing — no workspace
 * (the app pushes `/harness workspace` when a chat opens or first sends, and a
 * fork is neither) and no frozen prompt. It rebuilt the prompt from what it
 * had, and that differed from the one the conversation had been sending
 * whenever the two disagreed about the folder, in EITHER direction. MEASURED
 * 2026-09-24 (unsend-prefill-probe, qwen3.5-4b on rapid-mlx):
 *
 *  - session frozen WITH the folder's name (its first message beat the
 *    warm-up): the branch dropped it — 9,446 → 9,411 characters, first
 *    difference at char 6,685 — and the next message re-read its whole
 *    3,451-token prompt, where an ordinary follow-up re-reads ~40;
 *  - session frozen WITHOUT it (the folder arrived later, as a note): handing
 *    the branch the folder alone made it name it — the same divergence the
 *    other way, 193 tokens re-read.
 *
 * The prompt is frozen for the life of a session precisely so it cannot move
 * under the cache, and a branch is that session continued. So it takes the
 * prompt itself, byte for byte, with the folder its tools work in and what the
 * model has already been told about it (so the folder is not announced twice).
 * Every other session boundary is another chat and starts from nothing, as
 * before. Same lifetime argument as RESIDENT: the only scope that outlives a
 * wiring is the process.
 */
interface ForkCarry {
  prompt: string | null;
  workspaceRoot: string | null;
  announcedWorkspace: string | null;
  promptWorkspace: string | null;
}
const FORK_CARRY = Symbol.for('pi-desktop.harness.forkCarry');
const carryGlobals = globalThis as unknown as Record<symbol, ForkCarry | undefined>;
function processForkCarry(): ForkCarry {
  const existing = carryGlobals[FORK_CARRY];
  if (existing !== undefined) return existing;
  const fresh: ForkCarry = {
    prompt: null,
    workspaceRoot: null,
    announcedWorkspace: null,
    promptWorkspace: null,
  };
  carryGlobals[FORK_CARRY] = fresh;
  return fresh;
}
const forkCarry = processForkCarry();

export function wireHarness(pi: ExtensionAPI, options: WireHarnessOptions = {}): HarnessHandle {
  /*
   * FIRST, before anything registers: wrap `pi.registerTool` so every tool that
   * follows — this harness's own, and web-tools / browser-use / the mac
   * extensions, which all load after us — is captured WITH its `execute`. That
   * registry is what `use` dispatches through, which is what lets a capability
   * be pure text and cost no re-prefill. See tools/tool-registry.ts.
   */
  /*
   * ONE TOOL. the user, watching the mode loop on `ask_user` with a mangled
   * `<parameter=mode>` payload jammed into its question: "everything in this
   * mode should be cli at this point."
   *
   * He is right, and the loop is the argument. Leaving two structured tools
   * beside `bash` left the model a structured surface to fail on — which is the
   * one thing this mode exists to remove. Asking a question and updating a plan
   * are commands now (`ask user "…"`, `plan update "…"`), so there is exactly
   * one call shape in the whole session.
   */
  /*
   * ...AND THE FILE TOOLS, which is a correction to the paragraph above.
   *
   * the user, looking at the advanced panel in CLI mode: "read write and edit
   * native pi tools are not active which they should be as well as the bash
   * tool, otherwise it has to write read and such via bash." He is right and
   * the reasoning above does not apply to them: `ask_user` and `update_plan`
   * were removed because they were STRUCTURED surfaces the model kept failing
   * on with mangled payloads. Reading and writing a file are neither exotic nor
   * failure-prone, and doing them through `bash` means heredocs, quoting and
   * escaping — strictly more ways to get it wrong than `edit` has.
   */
  const TOOL_CLI_PINNED = ['read', 'write', 'edit', 'bash'] as const;

  /*
   * THE GROUPS THEMSELVES LIVE IN ./tools/tool-cli-groups.ts — the two
   * non-capability groups (`coordinate`, `file`) and their join with
   * CAPABILITIES. They moved out of this closure so the DESKTOP can read the
   * same registry: the Activity tab has to know whether a bash line is a shim
   * invocation (`mac snapshot`) or a real shell command (`ls -la`), and the
   * only truthful answer is the list of shims this registry produces.
   */

  /**
   * Where a turn's file checkpoints live.
   *
   * Under the app's own directory rather than the workspace: a `.checkpoints`
   * folder appearing inside someone's project is litter, and it would end up in
   * their commits. The app allowlists this path for writes.
   */
  function checkpointRoot(): string {
    return join(homedir(), '.pi', 'desktop', 'checkpoints');
  }

  /**
   * The tools the CLI may list AND run — one source, used by both the command
   * surface and the system prompt's command list.
   *
   * ONLY WHAT WE CAN ACTUALLY RUN, and that used to be very little. `ToolInfo`
   * — what `getAllTools()` returns — has no `execute`, so this extension could
   * see every tool in the process and run none but its own. `browser click`,
   * `mac snapshot`, `media generate image` and every connector command were
   * listed, documented by `--help`, and answered "not registered in this
   * build". Filtering them out made the CLI honest and nearly empty: a live run
   * with generation on offered `media edit image` and nothing else, and the
   * model correctly concluded it could not make a sound effect.
   *
   * `@pi-desktop/tool-bus` closes it. Every extension publishes its executors
   * into one process-level map as it registers them, so the CLI can dispatch
   * across the boundary. The registry capture stays as the first source — it is
   * this extension's own tools, and it is authoritative for them.
   *
   * A SPECIALIST NARROWS THIS, not the pinned tool list. Only `bash` is
   * advertised in this mode, so pinning a specialist's toolset onto
   * `setActiveTools` would say nothing — the narrowing has to happen where the
   * model actually sees the surface. Without it an image specialist opened the
   * CLI and found the whole app in it, which is the "goes and reads source
   * instead of making the picture" failure the pin was built to prevent.
   */
  /** The executor for a tool name: ours if we registered it, the bus otherwise. */
  function cliRunnable(name: string): CapturedTool | undefined {
    return toolRegistry.get(name) ?? (sharedTool(name) as CapturedTool | undefined);
  }

  function cliVisibleTools(): ReturnType<typeof pi.getAllTools> {
    const all = pi.getAllTools();
    const registered = all.filter(
      (t) => cliRunnable(t.name) !== undefined && !forbidden.has(t.name),
    );
    /* WHY A COMMAND IS MISSING, in one line: what pi knows, what we can run, and
       what the bus holds. Without all three, "the browser commands are not in
       the help" is a guess between three different causes. */
    const dbg = process.env.PI_ADV_DEBUG_TOOLS;
    if (dbg !== undefined && dbg.length > 0) {
      try {
        appendFileSync(
          dbg,
          `cliVisibleTools: all(${all.length})=${all.map((t) => t.name).join(',')}\n` +
            `  runnable(${registered.length})=${registered.map((t) => t.name).join(',')}\n` +
            `  bus(${sharedToolNames().length})=${sharedToolNames().join(',')}\n`,
        );
      } catch {
        /* a diagnostic must never break a turn */
      }
    }
    const specialist = specialistFromEnv();
    if (specialist === undefined) return registered;
    const allowed = new Set(
      specialistToolset(
        specialist,
        registered.map((t) => t.name),
      ),
    );
    // Zero matches means this build registered none of the specialist's tools;
    // an agent with an empty CLI can do nothing, so leave it whole.
    const narrowed = allowed.size > 0 ? registered.filter((t) => allowed.has(t.name)) : registered;
    if (dbg !== undefined && dbg.length > 0) {
      try {
        appendFileSync(
          dbg,
          `  specialist(${specialist}) commands(${narrowed.length})=${narrowed.map((t) => t.name).join(',')}\n`,
        );
      } catch {
        /* diagnostic only */
      }
    }
    return narrowed;
  }
  const toolCliMode = process.env.PI_DESKTOP_TOOL_CLI === '1';
  /** The call in flight, so a result can tell whether it is a verbatim repeat. */
  let lastCallInput: { tool: string; input: unknown } | null = null;
  /* the user: what the model actually looked at, per session — see ./modality.ts.
     Published on `harness-modality` so a run can read the real split instead of
     the advertised one. */
  const modality = emptyTally();
  const sameCall = newSameCallState();
  /**
   * How a capability tool is actually invoked in this session: its command line
   * when the CLI is the interface, null when it is called by name.
   *
   * Shared by `use` (so its one dead end becomes a redirect) and by the note
   * appended when bash opens an app (so the instruction it gives is one the
   * model can follow). Both used to point at `use`, which cannot reach another
   * extension's tools at all.
   */
  const cliCommandForTool = toolCliMode
    ? (toolName: string): string | null => {
        for (const spec of toolCliGroups()) {
          if (!spec.tools.includes(toolName)) continue;
          const group = commandNameFor(spec.name);
          return [group, ...pathFor(group, toolName)].join(' ');
        }
        return null;
      }
    : undefined;

  /** Tools this run may not call at all — see permissions/forbidden.ts. */
  const forbidden = forbiddenTools();

  const toolRegistry = captureRegisteredTools(pi);
  const runtime: HarnessRuntime = {
    config: DEFAULT_CONFIG,
    workspaceRoot: null,
    announcedWorkspace: null,
    promptWorkspace: null,
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
    lastRequestMessages: null,
    lastTurnMessages: [],
    suppressNextReview: false,
    plan: null,
    planTitle: null,
    subagentSnapshot: null,
    stage: 'idle',
    loopDetector: null,
    touchedFiles: [],
    loadingCapability: null,
    checkpoints: [],
    ranCommands: [],
    delegatedThisTurn: false,
    warnedSmallModel: false,
    nudgedHandback: false,
    nudgedOutputLimit: false,
    nudgedUnfinished: false,
    nudgedAnnounced: false,
    nudgedSilent: false,
    verifyFixesRemaining: 0,
    verifyActive: false,
  };

  /*
   * NO INTERNET ⇒ NO WEB TOOLS (the user). Latched by their own failures rather than
   * by a probe — see net/offline.ts for why that is the honest signal here.
   */
  const offline = createOfflineLatch();

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
  /*
   * ── THE SLOT HAS MORE THAN ONE WRITER ──────────────────────────────────
   *
   * llama-server holds ONE KV sequence. Four things write to it: the real turn,
   * the composer's predictive prefill, and — invisibly to the renderer — this
   * harness's own background calls (the prefix warm-up, post-turn naming, the
   * reviewer, classifier escalation). Whoever writes last wins, and the
   * background writers are the ones the user cannot see.
   *
   * MEASURED, and it is why this exists: at app open the warm-up takes ~17s on
   * this machine. Paste an attachment inside that window and the composer primes
   * it, the warm-up lands afterwards with [system][tools], and the attachment is
   * gone — the send then re-read every token of it (5542 of 15261) after a prime
   * that had already finished. From the renderer that is indistinguishable from
   * "the prime was wrong".
   *
   * The fix is deliberately not a lock or a protocol between two processes,
   * because that is the kind of thing that quietly stops being true. Every call
   * that lands on the slot bumps an epoch the renderer can see; the composer
   * treats a bump as "someone else touched it" and primes again. Re-priming an
   * unchanged prefix is a full cache hit, so the correction is nearly free, and
   * nothing here has to know WHICH background writer it was — which is what
   * keeps it working when the next one is added.
   */
  let slotEpoch = 0;
  const announceSlotWrite = (ctx?: ExtensionContext): void => {
    slotEpoch += 1;
    const target = ctx ?? runtime.currentCtx;
    if (target?.hasUI !== true) return;
    target.ui.setStatus('harness-slot-epoch', String(slotEpoch));
  };
  /** Wrap a utility call so finishing it announces that the slot moved. */
  const watchSlot = (fn: CallModel): CallModel => {
    return async (req) => {
      /*
       * Opt-in trace of every background write, sharing PI_ADV_DEBUG_WARM's
       * file. A slot number alone cannot say WHICH background caller landed on
       * the model between a prime and the send it was meant to serve, and that
       * is exactly the question when a completed prime turns out not to help.
       */
      const dbg = process.env.PI_ADV_DEBUG_WARM;
      const label = (req.prompt ?? req.messages?.at(-1)?.content ?? '').slice(0, 60);
      const started = Date.now();
      if (dbg !== undefined && dbg.length > 0) {
        try {
          appendFileSync(dbg, `slot: ${started} utility call starts — ${JSON.stringify(label)}\n`);
        } catch {
          /* a diagnostic must never break a turn */
        }
      }
      try {
        return await fn(req);
      } finally {
        if (dbg !== undefined && dbg.length > 0) {
          try {
            appendFileSync(
              dbg,
              `slot: ${Date.now()} utility call done in ${Date.now() - started}ms — ${JSON.stringify(label)}\n`,
            );
          } catch {
            /* a diagnostic must never break a turn */
          }
        }
        announceSlotWrite();
      }
    };
  };
  const fromOptions = options.callModel ?? callModelFromEnv();
  let resolvedCallModel: CallModel | undefined =
    fromOptions === undefined ? undefined : watchSlot(fromOptions);
  const currentCallModel = (): CallModel | undefined => {
    if (resolvedCallModel !== undefined) return resolvedCallModel;
    const fresh = callModelFromEnv();
    resolvedCallModel = fresh === undefined ? undefined : watchSlot(fresh);
    return resolvedCallModel;
  };
  const callModel: CallModel | undefined = resolvedCallModel;
  // Debounce the preemptive warm-up by the CANONICAL prompt content: warm each
  // unique system+tools prefix once. Keyed on content (not model id) because it
  // fires on BOTH session_start and model_select — a new chat on the same model
  // (no model_select) still needs the prefix resident, and a cwd change (new
  // canonical) must re-warm.
  /** When the warm-up first claimed the "Loading model" label (null = not yet). */
  let warmClaimedAt: number | null = null;
  /** The prefix seen on the PREVIOUS attempt — warm only once it repeats. */
  let pendingWarmKey: string | null = null;
  /* Identifies THIS wiring, so a repeated note can be told apart from a second
   * copy of the extension keeping its own state beside the first. */
  const wireId = Math.random().toString(36).slice(2, 7);
  /** How long to keep claiming it with no endpoint in sight before giving up. */
  const WARM_CLAIM_GRACE_MS = 20_000;
  // Last-published predictive-prefill context (deduped so a per-turn applyPreset
  // that changed nothing doesn't re-push the ~7k-char system + tool schemas).
  /** The system prompt seen on the PREVIOUS tick, for the settle rule above. */
  let pendingCanonicalPrompt: string | null = null;
  let publishedPrefillSystem: string | null = null;
  let publishedPrefillTools: string | null = null;
  /** In-flight post-turn background work (naming, reviewer). Aborted the moment
   * the user starts a new turn — see the agent_end block for why. */
  let postTurnWork: AbortController | null = null;
  /** Timer for the deliberate pause before post-turn work starts. */
  let postTurnTimer: ReturnType<typeof setTimeout> | null = null;
  /** Note what a branch of this session must keep (ForkCarry) — called
   * wherever the frozen prompt or the folder changes. */
  const rememberForFork = (): void => {
    forkCarry.prompt = runtime.canonicalSystemPrompt;
    forkCarry.workspaceRoot = runtime.workspaceRoot;
    forkCarry.announcedWorkspace = runtime.announcedWorkspace;
    forkCarry.promptWorkspace = runtime.promptWorkspace;
  };
  const titler: ConversationTitler | undefined =
    callModel !== undefined ? createConversationTitler(callModel) : undefined;

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

  /**
   * Give back the "Getting ready" label.
   *
   * It is claimed on the first tick of a wiring, before we know whether a
   * warm-up is needed, because the alternative — claiming it only once the
   * warm-up starts — leaves a window where the composer looks ready and a send
   * queues behind a warm-up that had not begun. The cost of claiming early is
   * that EVERY path which ends with "no warm-up is coming" has to hand it back,
   * including the ones that do nothing at all.
   */
  function releaseWarmLabel(ctx: ExtensionContext): void {
    if (ctx.hasUI !== true) return;
    ctx.ui.setStatus(PREFIX_WARM_STATUS, 'ready');
  }

  function maybeWarmPrefix(ctx: ExtensionContext): void {
    const warmCall = currentCallModel();
    /* Opt-in diagnostic: WHY a warm-up did not happen. Four different silent
     * returns look identical from outside, and the difference decides the fix. */
    const dbg = process.env.PI_ADV_DEBUG_WARM;
    const note = (why: string): void => {
      if (dbg === undefined || dbg.length === 0) return;
      try {
        /* The pid matters: a note that repeats "waiting a tick for the system
         * prompt to settle" every session reads like churn in one process and
         * like a fresh process each time — and only one of those is a bug. */
        appendFileSync(dbg, `warm[${process.pid}#${wireId}]: ${why}\n`);
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
      releaseWarmLabel(ctx);
      return;
    }
    const fresh = canonicalPrompt(ctx.getSystemPrompt());
    if (fresh.trim().length === 0) {
      note('empty system prompt');
      releaseWarmLabel(ctx);
      return;
    }
    // NOTE: the debounce key is completed BELOW, once the tool set is known — the
    // prefix is [system][tools], so warming is only redundant when BOTH match.

    /*
     * FREEZE MEANS FREEZE — and this line was quietly thawing it every second.
     *
     * The turn-time site says why the prompt is frozen: "pi regenerates its
     * tool-usage guidance non-deterministically per turn (reorders / adds /
     * drops lines), which shifts the ~7k-char prompt and forces a FULL KV
     * re-prefill on EVERY message." It then reads
     * `runtime.canonicalSystemPrompt ?? build()` — a freeze that only works if
     * nothing else writes that field. This did, on the 1s status tick, with a
     * freshly built prompt.
     *
     * MEASURED with the real model: a conversation's system prompt went
     * 17,646 → 17,356 characters between two turns, and the second turn came
     * back `reused 41 of 9,883` — a complete re-read of a prompt that had been
     * resident. That is a full re-prefill on an ordinary follow-up, from a
     * change nobody asked for.
     *
     * TWO TICKS BEFORE ADOPTING, because pi builds its guidance lazily and the
     * first tick can catch a half-built prompt — the same reason the tool set
     * below waits for a tick to settle. Afterwards the frozen value is what gets
     * warmed, published and sent, so all three agree by construction. A new
     * session clears it (session_start), which is where a genuinely different
     * prompt — a new day, another working folder — legitimately arrives.
     */
    if (runtime.canonicalSystemPrompt === null) {
      /*
       * A NEW CHAT IS NOT A NEW PROMPT, usually.
       *
       * The session boundary above is where a legitimately different prompt is
       * allowed in — a new day's date, another working folder. What actually
       * arrives most of the time is the same prompt again, sometimes with its
       * lines in another order, and adopting that costs the entire cached
       * prefix for a difference nobody can read. MEASURED: three new chats in
       * one run each built 17,646 characters and each re-warmed ~9.7k tokens
       * from cold. `residentPrefix` remembers what the server is holding across
       * wirings; `sameWording` decides whether this is really something new.
       */
      const resident = residentPrefix.canonical;
      if (resident !== null && sameWording(fresh, resident)) {
        note('the same prompt as the one already resident — keeping it, not re-reading it');
        runtime.canonicalSystemPrompt = resident;
      } else {
        if (pendingCanonicalPrompt !== fresh) {
          pendingCanonicalPrompt = fresh;
          note('waiting a tick for the system prompt to settle');
          return;
        }
        runtime.canonicalSystemPrompt = fresh;
      }
      residentPrefix.canonical = runtime.canonicalSystemPrompt;
    } else if (fresh !== runtime.canonicalSystemPrompt) {
      note(
        `pi rebuilt its system prompt (${runtime.canonicalSystemPrompt.length}→${fresh.length} chars); ` +
          'keeping the frozen one so the KV prefix survives',
      );
    }
    const canonical = runtime.canonicalSystemPrompt;
    if (runtime.announcedWorkspace === null) {
      runtime.announcedWorkspace =
        /^Current working directory: (.*)$/m.exec(canonical)?.[1] ?? null;
      runtime.promptWorkspace = runtime.announcedWorkspace;
    }
    rememberForFork();
    // Build the tool list in the SAME ORDER a real turn does (applyPreset unions
    // resolveBaseTools' order), NOT pi.getAllTools() registry order.
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
    /*
     * THE TURN'S OWN LIST, IN THE TURN'S OWN ORDER, once there is one.
     *
     * The preset order is a GUESS at what the next turn will advertise, and it
     * is only right before the first turn has run. After that, `activeTools` is
     * the truth: `applyPreset` unions the preset onto the existing list and
     * APPENDS what is missing, precisely so a growing set never moves a tool
     * that is already in the prompt. Rebuilding the warm from the preset threw
     * that away and warmed a different ORDER of the same tools.
     *
     * MEASURED, turning a capability on mid-conversation (18 tools → 22):
     * the warm advertised `read,write,edit,ls,find,grep,bash,python_run,
     * capability,use,…` while the turn advertised `capability,use,read,write,
     * edit,bash,…,ls,find,grep,python_run`. Chat templates emit tools
     * positionally, so those are two different prompts that share nothing past
     * the first schema — and the turn came back `read 10514 of 10514, reused 0`
     * after 46.8 seconds, on a TWO-MESSAGE conversation. The turn after it,
     * with the set settled, was 306ms.
     */
    /*
     * IN CLI MODE THE TURN ADVERTISES THE FOUR PINNED TOOLS AND NOTHING ELSE
     * (applyPreset) — the manager is reached as `coordinate manager`, a
     * command. The warm-up used to add `talk_to_manager` here anyway, so it
     * primed a five-tool prefix the four-tool turn could never hit: MEASURED
     * on a fresh CLI chat, `reused=0 (0%)`, first token at 5.7 s against 3.3 s
     * in schemas mode with a 98% hit — and the useless prime, started late,
     * held the single slot while the real turn queued behind it.
     */
    const cliPinned = toolCliMode ? TOOL_CLI_PINNED.filter((t) => available.includes(t)) : [];
    const warmNames =
      cliPinned.length > 0
        ? cliPinned.slice()
        : runtime.activeTools.length > 0
          ? runtime.activeTools.slice()
          : resolveBaseTools(available);
    if (
      cliPinned.length === 0 &&
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
    /* The MODEL is part of the key: switching models starts a different server
     * with an empty KV, and this memory now outlives the wiring that filled it. */
    const warmKey = `${runtime.model?.id ?? ''}\u0000${canonical}\u0000${warmNames.join(',')}`;
    /*
     * TELL THE RENDERER WHAT THE PREFIX IS — every tick, and with the tools the
     * TURN will carry rather than the warm-up's guess. Two separate bugs, one
     * line, so both are written down here.
     *
     * (1) This publish used to sit at the bottom of the function, after the
     * "already warmed" early return, so it ran once per distinct prefix per
     * process. A session boundary DROPS the renderer's copy (every `harness*`
     * status key is cleared so a stale checklist cannot leak into a new chat),
     * and these two are caught by that net — so switching chats once left the
     * renderer with no system prompt and no tool list for the rest of the
     * session, silently disabling predictive prefill entirely. Nothing logged,
     * nothing wrong on either side alone. Publishing here is free:
     * `publishPrefillContext` compares before it sends.
     *
     * (2) `warmTools` is the preset for the class the warm-up ASSUMES. The turn
     * uses `runtime.activeTools` — that preset unioned onto whatever earlier
     * turns activated, carried across session boundaries on purpose (the set is
     * append-only so a new class cannot move tools already in the prompt). Once
     * a turn has run, the accumulated set is the truth, and chat templates
     * render tools at the START: priming the wrong FIRST tool costs the entire
     * prefix. Publishing the guess every tick would overwrite the accurate list
     * a turn had just published.
     */
    publishPrefillContext(
      ctx,
      runtime.activeTools.length > 0 ? orderedToolDefs(runtime.activeTools) : warmTools,
    );
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
    if (warmKey === residentPrefix.warmedKey) {
      note('already warmed (same prompt + tools)');
      /*
       * AND SAY SO. The label is claimed on the first tick of every wiring —
       * and pi makes a new wiring for every chat — so a new chat that finds its
       * prefix already resident claims "Getting ready" and, without this, never
       * takes it back. MEASURED by a probe that reads the composer pill at the
       * moment of sending: "Getting ready · 6:56" on a send that took 4.4s,
       * because the label had been up since seven minutes earlier. A promise
       * that is always on screen tells the user nothing.
       */
      releaseWarmLabel(ctx);
      return;
    }
    residentPrefix.warmedKey = warmKey;
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
    /* The prompt itself, so "it warmed again" can be turned into "…and here is
     * the line that differed". Opt-in, next to the trace it belongs to. */
    if (dbg !== undefined && dbg.length > 0) {
      try {
        appendFileSync(`${dbg}.canonical`, `\n===== WARM ${Date.now()} =====\n${canonical}\n`);
      } catch {
        /* a diagnostic must never break a turn */
      }
    }
    const warmStartedAt = Date.now();
    void warmSystemPrompt(warmCall, canonical, { tools: warmTools })
      .then((ok) => note(`warm result ok=${ok} in ${Date.now() - warmStartedAt}ms`))
      .finally(() => {
        if (ctx.hasUI === true) ctx.ui.setStatus(PREFIX_WARM_STATUS, 'ready');
      });
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
      /*
       * A COMMAND LINE TYPED AS A TOOL NAME, in bash-CLI mode.
       *
       * MEASURED 2026-09-15: the model emitted `media generate image` as a
       * structured call with the command's flags as its arguments, and pi
       * said "not found". The words are the command and the arguments are the
       * flags, so the call becomes the `bash` line the shell would have run —
       * through the same shim, socket and dispatcher a typed command uses, so
       * the Activity tab shows it as the tool it is. Only OUR shims translate;
       * anything else stays "not found". Deferred to call time on purpose:
       * `pi.getAllTools()` is an action method and this deps object is first
       * built during activate, where action methods are refused.
       */
      ...(toolCliMode
        ? {
            resolveUnknownTool: (name: string, args: Record<string, unknown>) => {
              const command = commandLineForCall(
                buildCli(toolCliGroups(), cliVisibleTools()),
                name,
                args,
                toolCliShimCommands(toolCliGroups()),
              );
              return command === undefined ? undefined : { name: 'bash', arguments: { command } };
            },
          }
        : {}),
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
      // targets whatever turn is active.
      /*
       * AND IT SAYS WHEN AN INGEST IS DONE.
       *
       * The value used to be capped at 99 — "the renderer drives the final 100"
       * — so completion was never signalled on the channel at all. Clearing it
       * at the turn boundaries was not enough: a turn is many tool calls and
       * many ingests, so the channel sat on the first ingest's last percentage
       * for the whole turn. MEASURED while instrumenting it: "1 ingest, 257.6s"
       * on a run whose ingests were each a fraction of a second.
       *
       * An ingest that finished is no ingest. Now the channel can be read for
       * what it claims to report, per ingest, which is what makes a long one
       * findable.
       */
      onPromptProgress: (fraction) => {
        const ctx = runtime.currentCtx;
        if (ctx?.hasUI !== true) return;
        const done = !Number.isFinite(fraction) || fraction >= 1;
        /*
         * THE NUMBER IS THE NUMBER. the user: "it lingers at 99% for the last few
         * seconds which seems like a lie to me and not actual prefill % being
         * reported... just a suspicsion."
         *
         * Half right, and worth having measured. Traced straight off
         * llama-server on a 9,805-token prompt, it reports in 2048-token
         * batches — 0, 20.9, 41.8, 62.7, 83.5, 94.7, 100 — so the STEPS are
         * real and coarse, and the last one is small and can be slow on a big
         * prompt. That is where "it sat at 99" comes from.
         *
         * But the clamp WAS a lie: `Math.min(99, round(...))` turned a genuine
         * 99.96% and a genuine 100% into the same "99". Flooring reports what
         * was actually measured and still never shows 100 before it is true,
         * which is the property the clamp was there for.
         */
        ctx.ui.setStatus('harness-prefill', done ? '' : String(Math.floor(fraction * 100)));
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
      priorMessages:
        (residentConversation(runtime.lastRequestMessages, runtime.lastTurnMessages) as
          | TitleMessage[]
          | null) ??
        buildConversationPrefix(getEntries(ctx), runtime.canonicalSystemPrompt ?? '', task, false),
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
      /*
       * WHAT THE TURN TOUCHED, not what a classifier guessed it would be. The
       * gate used to read `activeClass === 'coding' || 'file-ops'` — a keyword
       * guess made before the turn ran, and one that has been pinned to a
       * constant since the classifier was switched off, so in practice this
       * whole branch was permanently false. Files actually written is the
       * signal it always wanted.
       */
      runtime.touchedFiles.length === 0 ||
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
      /*
       * THE STEER IS BACKGROUND WORK, NOT AN ANNOUNCEMENT.
       *
       * the user, watching one fire mid-reply: "that loop guard going in the middle
       * of a message and making the user totally confused as there's a banner
       * that just appeared, but the play button is still going in the input bar,
       * and then a few seconds later a new thinking chain appears again, this
       * should be totally background if anything at all."
       *
       * He is right that the banner explains nothing to the person it interrupts:
       * it names an internal mechanism, arrives while the reply is still
       * streaming, and is followed by the model apparently starting over. The
       * correction itself is worth doing silently; a nudge the user has to
       * interpret is worse than a nudge they never see. The entry is still
       * appended, so a run can be traced afterwards.
       */
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
    /*
     * …AND THEY KNOW THE OFFICE FORMATS. `write deck.pptx <text>` makes the
     * deck through the pipeline, `edit deck.pptx` edits it there, `read
     * deck.pptx` is its outline — see withOfficeFormats for the twelve `edit`
     * calls that made this necessary.
     */
    ...(officeGenDir() !== null
      ? {
          wrap: (tool) =>
            withOfficeFormats(tool as never, {
              bridge: readSubagentDepth(process.env) === 0 ? presentBridgeFromEnv() : null,
              root: (ctxCwd) => runtime.workspaceRoot ?? resolveWorkspaceRoot(ctxCwd),
            }) as never,
        }
      : {}),
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
  // A generation command's clock is MEDIA_BASH_TIMEOUT_S; every other command's the default.
  const generationCommands = ['generation', 'svg', '3d'].map(commandNameFor);
  const bashClock = (command: string): number =>
    toolCliMode && runsCommand(command, generationCommands)
      ? MEDIA_BASH_TIMEOUT_S
      : DEFAULT_BASH_TIMEOUT_S;
  pi.registerTool(
    withRepeatNotice(
      withDefaultTimeout(
        /* A command that turns out to be a server is stopped once that is
           certain (its own process listening, the command quiet), not when the
           clock runs out — see foreground-server.ts. */
        withForegroundServerStop(
          withBackgroundOption(
            createBashToolDefinition(process.cwd(), {
              spawnHook: (c) => ({
                ...c,
                /* `$412,000` in an `office` brief must reach the pipeline as
                 written — see protectShimDollars. Only our own commands. */
                command: toolCliMode
                  ? protectShimDollars(c.command, toolCliShimCommands(toolCliGroups()))
                  : c.command,
                cwd: liveRoot(),
                env: cleanChildEnv(c.env),
              }),
            }),
          ),
        ),
        bashClock,
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
    /* Through the one helper, so the CLI-mode rule is stated once — see
     * `activateCapability` for why activation is a no-op there. */
    onActivate: (added, capability) => activateCapability(added, capability),
    /* Present ONLY in CLI mode, which is what tells the tool to describe itself
     * (and its result) as lookup rather than activation. */
    ...(toolCliMode ? { cliCommandFor: commandNameFor } : {}),
  });
  registerUseTool(pi, {
    registry: toolRegistry,
    active: () => runtime.activeTools,
    /*
     * A tool `use` cannot reach may still be one command away. In CLI mode
     * every capability tool IS a command, so the one dead end this fallback
     * can produce becomes a redirect instead — see the note on the option.
     */
    cliCommandForTool,
    /* `tool_call` fired for `use`, not for the tool it runs — see admitToolCall. */
    admit: (toolName, args) => admitToolCall({ toolName, input: args }, runtime.currentCtx)?.reason,
  });

  /*
   * THE COMMANDS THEMSELVES, when the bash-cli interface is on.
   *
   * Installed once per session: a 0700 shim dir prepended to PATH, one
   * executable per capability group plus `tools`, and a token-gated socket back
   * into this process. It grants nothing new — every command routes to a tool
   * `use` could already dispatch — and it is removed on shutdown.
   *
   * `pi.getAllTools()` rather than our own capture, for the reason written on
   * the capability tool above: each extension gets its own api object, so a
   * capture only ever sees its own tools, and a CLI that could not reach the
   * browser or the mac tools would be the same false-availability bug in a new
   * costume.
   */
  /*
   * THE CLI IS A MODE. the user, correcting a hybrid I had built here: "the entire
   * point of the bash cli *mode* is that it's a mode, we can toggle this on and
   * off and it turns any mcp/toolset ALL OF THEM into just being behind a cli
   * based tool, it's not like this needs to be done for 2 tools but keep some
   * others as the always loaded schemas."
   *
   * Exactly right, and the hybrid was worth reverting even though it measured
   * well: a prefix saving bought by special-casing four tools is a saving that
   * has to be re-argued for every tool after them, and it leaves the app with
   * two half-answers to "how are tools offered" instead of one switch.
   */
  if (toolCliMode) {
    const handle = registerToolCli(
      {
        tools: cliVisibleTools,
        groups: () => toolCliGroups(),
        call: async (name, args, signal) => {
          const target = cliRunnable(name);
          if (target === undefined) {
            return { text: `${name}: not registered in this build.`, isError: true };
          }
          /*
           * …HELD TO THE SAME RULES AS THE TOOL CALL. pi's `tool_call` fired for
           * the `bash` line, not for this tool, so its per-tool rules run here
           * — see admitToolCall. A refusal is this command failing, and
           * dispatchToolCli says any tool it names as a command.
           */
          const refused = admitToolCall({ toolName: name, input: args }, runtime.currentCtx);
          if (refused !== undefined) return { text: refused.reason, isError: true };
          /*
           * THE CONTEXT IS AN ARGUMENT, and dropping it crashed real tools.
           *
           * pi calls a tool as `execute(id, params, signal, update, ctx)`, and
           * anything that has to ask the person something reads that last one —
           * the Mac tools gate every action on `ctx.hasUI` before touching the
           * machine. Calling with two arguments handed them `undefined`, so in
           * CLI mode every one of them died with "Cannot read properties of
           * undefined (reading 'hasUI')" — which the model then treated as a
           * syntax error and spent a turn guessing new argument shapes against.
           *
           * AND SO IS THE SIGNAL. `undefined` here meant a Stop killed the bash
           * command and never reached the tool behind it: the turn ended while a
           * picture sat at its module gate, unasked-for. The bridge fires it
           * when the command's shim goes away (tool-cli-bridge.ts).
           */
          const res = (await target.execute(
            'tool-cli',
            args,
            signal,
            undefined,
            runtime.currentCtx ?? undefined,
          )) as {
            content?: { type: string; text?: string; data?: string; mimeType?: string }[];
            isError?: boolean;
          };
          noteResult(modality, name, args, res.content ?? []);
          if (name === 'mac_launch' && typeof args.app === 'string' && res.isError !== true) {
            controlledApp = args.app;
          }
          /*
           * AND THE PICTURE HAS TO SURVIVE THE PIPE.
           *
           * A command's result comes back to the model as the bash tool's stdout,
           * which is text — so an image part was being rendered as the literal
           * string "[image]" and thrown away. MEASURED consequence: in CLI mode
           * the model never saw a single screenshot. On an app with an
           * Accessibility tree that is a handicap; on one without (Blender draws
           * its own interface and exposes three elements) it is acting blind, and
           * the run would have measured our pipe rather than the model.
           *
           * The parts are held here and re-attached to the bash tool_result that
           * this dispatch produced, which is the one place downstream that can
           * still carry them. Same shape as `lastOpened` below: written by the
           * cause, consumed once by the result.
           */
          const images = (res.content ?? []).filter((c) => c.type === 'image' && c.data);
          if (images.length > 0) cliImages = images;
          const text = (res.content ?? [])
            .map((c) =>
              c.type === 'text'
                ? (c.text ?? '')
                : c.type === 'image'
                  ? '[screenshot attached below]'
                  : `[${c.type}]`,
            )
            .join('\n');
          return { text, isError: res.isError === true };
        },
      },
      {
        /*
         * Past the bash tool's own limit for a generation command, so a long
         * generation is never reported as a failure while it is still running.
         * Derived from the same constant the bash clock uses, so raising one
         * cannot silently strand the other.
         */
        dispatchTimeoutMs: (MEDIA_BASH_TIMEOUT_S + 120) * 1000,
        // So the `open` wrapper can name the way to SHOW a file to the user.
        presentCommand: cliCommandForTool?.(PRESENT_TOOL_NAME) ?? null,
      },
    );
    /* pi's ExtensionAPI has no shutdown hook, so the disposer rides the process
       it belongs to. `once` so a double signal cannot double-unlink. */
    process.once('exit', () => handle.dispose());
  }

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
  /**
   * Turn tools on for real — or, in CLI mode, do nothing, on purpose.
   *
   * IN CLI MODE THERE IS NOTHING TO ACTIVATE. The advertised set is `['bash']`
   * and every tool is already a command on PATH (`cliVisibleTools` reads
   * `pi.getAllTools()`, not the active set), so "activating" one grants exactly
   * nothing the model could not already run. What it DOES do is replace the
   * advertised set mid-conversation — and chat templates render tools at the
   * START of the prompt, so that is a full KV re-prefill bought for no
   * capability at all. It would also make the mode a lie: the whole argument for
   * the CLI is that the advertised surface is one tool and stays one tool.
   *
   * the user, on exactly this: "tool being appended mid conversation is fine, but
   * not during cli mode, because during cli mode a tool happening mid
   * conversation is just a little tidbit at the end of the message saying 'user
   * activated <tools>, these are now able to be used via bash'." That tidbit is
   * `connectorActivationLine` on the app side; it costs the tokens of one
   * sentence at the END of the prompt instead of the whole conversation.
   *
   * In SCHEMAS mode the activation is real and still costs one re-prefill,
   * which is the bounded price of a tool the model genuinely could not call.
   */
  const activateCapability = (added: readonly string[], capability = ''): void => {
    if (toolCliMode) return;
    const next = Array.from(new Set([...runtime.activeTools, ...added]));
    if (next.length === runtime.activeTools.length) return;
    runtime.activeTools = next;
    pi.setActiveTools(next);
    /*
     * DID IT LAND? Ask, rather than assume.
     *
     * `setActiveToolsByName` looks each name up in the session's registry and
     * SILENTLY IGNORES the ones it does not find, so a capability can report
     * itself on, this function can run to completion, and the advertised set can
     * be exactly what it was. MEASURED, and this is the bug it was added to
     * catch: 34 provider requests after `capability computer-use` came back "on
     * … mac_launch, mac_snapshot, mac_click", every request carried the same 14
     * tools and not one mac tool among them.
     */
    /*
     * NAME THE WAIT THIS JUST CAUSED. Appending tools rewrites the front of the
     * prompt, so the next request re-ingests the whole conversation; without
     * this the user gets a long, unexplained "Processing 12%".
     */
    runtime.loadingCapability = capability;
    if (runtime.currentCtx !== null) publishStatus(runtime.currentCtx);
    const landed = pi.getActiveTools();
    const missing = added.filter((t) => !landed.includes(t));
    const dbgPath = process.env.PI_ADV_DEBUG_TOOLS;
    if (dbgPath !== undefined && dbgPath.length > 0) {
      try {
        appendFileSync(
          dbgPath,
          `activateCapability: asked(${added.length})=${added.join(',')} ` +
            `landed(${landed.length}) missing(${missing.length})=${missing.join(',')}\n`,
        );
      } catch {
        /* a diagnostic must never break a turn */
      }
    }
  };
  /** Say that no prompt is being ingested. See the call in `agent_end`. */
  const clearPrefillStatus = (ctx: ExtensionContext): void => {
    if (ctx.hasUI === true) ctx.ui.setStatus('harness-prefill', '');
  };

  /* One-shot guard for the tool-cost diagnostic below: it is the same on every
   * request of a run, and a per-request dump would bury the file. */
  let toolCostLogged = false;
  pi.on('before_provider_request', (e) => {
    const payload = e.payload;
    if (typeof payload !== 'object' || payload === null) return payload;
    const body = payload as Record<string, unknown>;
    if (!Array.isArray(body.messages)) return body;
    // The bytes on the wire, kept for whoever shares this prefix next.
    runtime.lastRequestMessages = body.messages as Record<string, unknown>[];
    /*
     * WHAT EACH ADVERTISED TOOL COSTS, IN BYTES, ON EVERY SINGLE REQUEST.
     *
     * The tool-set argument keeps being had in the abstract — "the media tools
     * ride every turn", "the prompt is too big" — and the number that settles
     * it was never on the table. This prints it: the system prompt's size and
     * each tool's serialized schema, largest first, once per run.
     *
     * `PI_ADV_DEBUG_TOOLCOST=<file>`. Opt-in, never throws, and reads the body
     * that is actually about to go over the wire rather than a registry we hope
     * matches it.
     */
    const costPath = process.env.PI_ADV_DEBUG_TOOLCOST;
    if (!toolCostLogged && costPath !== undefined && costPath.length > 0) {
      toolCostLogged = true;
      try {
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const rows = tools
          .map((t) => {
            const name = (t as { function?: { name?: unknown } }).function?.name;
            return { name: typeof name === 'string' ? name : '?', bytes: JSON.stringify(t).length };
          })
          .sort((a, b) => b.bytes - a.bytes);
        const system = body.messages.find(
          (m): m is { role: string; content: unknown } =>
            typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'system',
        );
        const systemBytes = typeof system?.content === 'string' ? system.content.length : 0;
        const toolBytes = rows.reduce((n, r) => n + r.bytes, 0);
        appendFileSync(
          costPath,
          `system: ${systemBytes} chars\ntools: ${rows.length} costing ${toolBytes} chars\n` +
            `${rows.map((r) => `  ${String(r.bytes).padStart(6)}  ${r.name}`).join('\n')}\n` +
            `TOTAL PREFIX: ${systemBytes + toolBytes} chars\n`,
        );
      } catch {
        /* a diagnostic must never break a turn */
      }
    }
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
        activateCapability(group.length > 0 ? group : plan.inject, cap?.name ?? '');
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
  // The Bobble 3D connector's tools (generate_3d / refine_3d), on the same
  // bridge — registered only when the app says the connector is on and an
  // engine that can make a mesh is on this Mac (PI_BOBBLE_3D_READY).
  registerModelTools(pi);

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
      // A relative path means the working folder — the one `write` just used.
      resolvePath: (p) => join(liveRoot(), p),
      readText: (p) => readFile(p, 'utf8').catch(() => null),
      chatText: () =>
        runtime.currentCtx === null ? '' : chatTextOf(getEntries(runtime.currentCtx)),
      listDir: (dir) => readdir(dir),
      stat: async (target) => {
        try {
          return { isDirectory: (await stat(target)).isDirectory() };
        } catch {
          return null;
        }
      },
    });
  }

  /*
   * `office` — the document pipeline (tools/office-gen) as a tool in EVERY
   * chat, not only inside a corp run. the user: "model should not be using
   * python-pptx, there is a dedicated subagent for each pptx/docx/xlsx creation
   * and editing right?" Registered only where the scripts exist, so a plain pi
   * never advertises a command that can only fail. A child agent gets the tool
   * without the canvas half: presenting is the top-level model's alone, so the
   * child reports the file up and its parent shows it.
   */
  if (officeGenDir() !== null) {
    registerOfficeTools(pi, {
      bridge: readSubagentDepth(process.env) === 0 ? presentBridgeFromEnv() : null,
      root: (ctxCwd) => resolveWorkspaceRoot(ctxCwd),
      chatText: () =>
        runtime.currentCtx === null ? '' : chatTextOf(getEntries(runtime.currentCtx)),
    });
  }

  /*
   * `chart` — a data visual drawn from its numbers, in the chat (chart-tool.ts).
   * Pure TypeScript, so it is in EVERY chat with no pipeline to check for; a
   * child agent draws the file and reports it up, the top-level model's card
   * is the one the user sees.
   */
  registerChartTool(pi, {
    bridge: readSubagentDepth(process.env) === 0 ? presentBridgeFromEnv() : null,
    root: (ctxCwd) => resolveWorkspaceRoot(ctxCwd),
    kit: (root) => projectChartKit(root),
  });

  /*
   * `math` — a maths or physics visual from a spec: plots with sliders,
   * figures, steps tied to them, one standard page, checked (math-tool.ts,
   * @pi-desktop/mathviz). Pure TypeScript like the chart, so in every chat.
   */
  const mathDeps: MathToolDeps = {
    bridge: readSubagentDepth(process.env) === 0 ? presentBridgeFromEnv() : null,
    root: (ctxCwd) => resolveWorkspaceRoot(ctxCwd),
    kit: (root) => projectMathKit(root),
  };
  registerMathTool(pi, mathDeps);

  /* pi's auto-compaction, held to the window we run (compaction-gate.ts). */
  registerCompactionGate(pi, (line) => console.error(line));

  /*
   * `diagram` — a flowchart, a sequence, an org chart… from Mermaid, drawn in
   * the chat (diagram-tool.ts, VQ-10). The drawing is the APP's (its bundled
   * Mermaid, in a hidden window), so it is registered only where the app's
   * bridge is: a plain pi never advertises a command that can only fail. Any
   * depth may draw — a child writes the file and reports it up — and only the
   * top-level model's card is shown, like a chart's.
   */
  const diagramBridge = presentBridgeFromEnv();
  if (diagramBridge?.diagram !== undefined) {
    const drawDiagram = diagramBridge.diagram;
    registerDiagramTool(pi, {
      render: (req) => drawDiagram(req),
      bridge: readSubagentDepth(process.env) === 0 ? diagramBridge : null,
      root: (ctxCwd) => resolveWorkspaceRoot(ctxCwd),
      settingsKit: () => process.env.PI_DESKTOP_DESIGN_KIT,
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
      loadingCapability: runtime.loadingCapability,
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
      // What this turn changed, and whether each file existed beforehand.
      changedFiles: runtime.checkpoints.map((c) => ({
        path: c.target,
        created: c.backup === null,
      })),
      workspaceRoot: runtime.workspaceRoot,
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

  /*
   * BASH-CLI TOOL INTERFACE — the user's experiment, off by default.
   *
   * When the desktop setting is on, the model is advertised ONE tool (`bash`)
   * and reaches everything else as a command on PATH. What stays advertised
   * beside it is only the plumbing a command line cannot express: asking the
   * user a question and updating the plan are UI round-trips, not shell verbs.
   *
   * MEASURED before wiring this: a model handed a bare terminal and told to go
   * looking answers "I only have access to shell commands" and never runs
   * `tools` — so the command list goes into the system prompt, where it is ~40
   * stable tokens rather than N schemas that change per turn.
   */

  /**
   * THE SYSTEM PROMPT A TURN ACTUALLY SENDS — one definition, two callers.
   *
   * This existed twice, and the copies disagreed. The warm-up froze
   * `runtime.canonicalSystemPrompt` from `augmentSystemPrompt(...)` alone at
   * model-select, and the turn read `runtime.canonicalSystemPrompt ?? (mode ?
   * augmented + preamble : augmented)` — so the `??` short-circuited on a value
   * computed before the preamble existed, and the bash-CLI instructions were
   * NEVER on the wire. MEASURED with PI_ADV_DEBUG_PROMPT on a real turn: tools
   * correctly pinned to [bash, ask_user, update_plan], and not one clause of
   * the preamble in 16,743 characters of system prompt.
   *
   * the user, before any of this was measured: "often the issue is that the
   * instructions we for whatever reason actually just [are] not appended to the
   * system prompt."
   *
   * The duplication was also a live performance bug. The warm-up exists to
   * prime the server's KV with the exact prefix the first turn will send;
   * priming a DIFFERENT string means turn one pays the full cold prefill the
   * warm-up was added to avoid.
   */
  /**
   * Whose guideline is whose: every tool this extension registered, with the
   * bullets it contributes to pi's "Guidelines:" block — so the block can be
   * rebuilt with each tool NAMED and the absent ones pruned (guidelines.ts).
   * The captured definition is the original object, guidelines and all.
   */
  function guidelineSources(): { name: string; guidelines: string[] }[] {
    return toolRegistry.names().map((name) => {
      const def = toolRegistry.get(name) as { promptGuidelines?: unknown } | undefined;
      const raw = def?.promptGuidelines;
      const list = Array.isArray(raw)
        ? raw.filter((g): g is string => typeof g === 'string')
        : typeof raw === 'string'
          ? [raw]
          : [];
      return { name, guidelines: list };
    });
  }

  /** The tools a turn will advertise — the same list the warm-up uses. */
  function advertisedNow(): Set<string> {
    const available = pi.getAllTools().map((t) => t.name);
    const names =
      runtime.activeTools.length > 0 ? runtime.activeTools.slice() : resolveBaseTools(available);
    if (toolCliMode) for (const t of cliVisibleTools()) names.push(t.name);
    return new Set(names);
  }

  function canonicalPrompt(base: string): string {
    {
      const dbg = process.env.PI_ADV_DEBUG_TOOLS;
      if (dbg !== undefined && dbg.length > 0) {
        try {
          appendFileSync(
            dbg,
            `cwd: process=${process.cwd()} workspace=${runtime.workspaceRoot ?? '-'} env=${process.env.PI_DESKTOP_WORKSPACE_ROOT ?? '-'} promptLine=${/Current working directory: (.*)$/m.exec(base)?.[1] ?? '-'}\n`,
          );
        } catch {
          /* diagnostic */
        }
      }
    }
    // The prompt names the folder it was built with (by name, not path); the
    // seeds below used to read the path back off the prompt line.
    if (runtime.workspaceRoot !== null && runtime.announcedWorkspace === null) {
      runtime.announcedWorkspace = runtime.workspaceRoot;
      runtime.promptWorkspace = runtime.workspaceRoot;
    }
    const augmented = augmentSystemPrompt(base, {
      toolInterface: toolCliMode ? 'bash-cli' : 'schemas',
      // In CLI mode, pi's own guidance names tools by their TOOL name — it
      // renders usage lines for every registered tool, advertised or not — so
      // it is retargeted onto the commands that actually reach them.
      ...(toolCliMode ? { commandFor: toolCliCommandNames() } : {}),
      /* the user, reading the block: "so much explanation which I can't figure out
         what it's explaining about" — every bullet said "it" about a different
         tool, two of which the model did not have. Named and pruned. */
      guidelines: { sources: guidelineSources(), active: advertisedNow() },
      /* The tools' root, not pi's boot directory — see the workspace command. */
      ...(runtime.workspaceRoot !== null ? { workingDirectory: runtime.workspaceRoot } : {}),
    });
    /*
     * THE COMMAND LIST GOES FIRST.
     *
     * MEASURED, ling-3.0-tiny, six tasks: with the preamble appended AFTER pi's
     * base prompt it scored 2/6 — four tasks where it never called anything. It
     * opened by checking for PIL, numpy, ffmpeg, moviepy and imagemagick, then
     * degenerated into repeating `ls`. The same model on the same tasks with a
     * ~20-line prompt whose first words are the command list: 5/6.
     *
     * The anti-DIY paragraph is identical in both. What differs is that ~4,500
     * characters of "you are an expert coding assistant… executing commands,
     * editing code" arrive first, and a small model acts on the framing it read
     * first rather than the list it read last.
     *
     * Ordering does not touch the KV prefix — the prompt is frozen per session.
     */
    return toolCliMode ? `${toolCliPreamble()}\n\n${augmented}` : augmented;
  }

  /** Tool name → the command line that runs it, straight from the CLI model. */
  function toolCliCommandNames(): Map<string, string> {
    const map = new Map<string, string>();
    for (const group of buildCli(toolCliGroups(), cliVisibleTools()).groups) {
      /*
       * THE FILE TOOLS KEEP THEIR OWN NAMES.
       *
       * read / write / edit stay pinned as ordinary pi tools with their own
       * schemas — every accumulated write and edit safety fix hangs off them —
       * so pi's own guidance about them ("Use `edit` for precise changes;
       * edits[].oldText must match exactly") is about a tool the model really
       * has. Renaming it to `file edit` pointed that guidance at a command,
       * advertising one capability under two names. the user: "keep the native pi
       * file read write and edit tool format those don't go as any special cli
       * tools."
       */
      if (group.name === 'file') continue;
      for (const command of group.commands) {
        map.set(command.tool.name, [group.name, ...command.path].join(' '));
      }
    }
    return map;
  }

  /**
   * The command list, as the system prompt states it. Built from the registry.
   *
   * TUNED AGAINST MEASURED FAILURES, not taste. Each line answers something a
   * real model did in tests/e2e/tool-cli-eval.mjs across six local models:
   *
   *   "these are the ONLY way" + the named temptations — Ling-3.0-tiny treated
   *   the shell as a real Unix box and went shopping: `say`, `festival`,
   *   `which ffmpeg`, `pip list`, `ls /usr/bin`, PIL, for three turns before it
   *   ever read its own help. When your tools look like commands, the whole
   *   command ecosystem looks like your tools.
   *
   *   "never say you are unable" — several models answered "I only have access
   *   to shell commands" and never looked. 14 such refusals without the list.
   *
   *   "reading the help is not finishing" — two models ran `--help`, found the
   *   right command, and stopped without running it.
   *
   * MEASURED: this wording took the interface from 31/36 with one refusal to
   * 34/36 with none, and five of the six models to a clean sweep. Kept short on
   * purpose — it rides in every request.
   */
  function toolCliPreamble(): string {
    const cli = buildCli(toolCliGroups(), cliVisibleTools());
    const presentCommand = cli.groups.some((g) =>
      g.commands.some((c) => c.tool.name === PRESENT_TOOL_NAME),
    )
      ? (cliCommandForTool?.(PRESENT_TOOL_NAME) ?? null)
      : null;
    return [
      /*
       * NAMES ONLY — the command TREE is deliberately not here, and removing it
       * is the single largest saving anywhere in this prompt.
       *
       * It used to paste `renderRootHelp(cli)`: every group, every command,
       * every summary — the same information the JSON schemas carry, in prose.
       * MEASURED with tests/e2e/tool-mode-cost-probe.mjs, same model, same
       * question: 21 tools as schemas cost 10,309 prompt tokens, and the CLI
       * WITH the tree cost 10,309 as well. Identical. The interface was buying
       * nothing, because nothing had been left out of it.
       *
       * Names alone: 1,506 tokens. 86% smaller, and at the cold prefill rate
       * this app measures, about 1.7 seconds before a first message instead of
       * twelve.
       *
       * The tree was never what the evaluation justified either: tool-cli-eval's
       * CLI arms gave the model "one paragraph saying the commands exist and how
       * to look them up" and scored 86% listed / 94% tuned against 97% for
       * schemas. The tree was added on top of an arm that had already earned its
       * number without it.
       *
       * the user, proposing exactly this: "you don't preload anything per tool into
       * context, all bash tools are active and available and parsable, but the
       * model doesn't know anything but their name until they call them with
       * --help".
       *
       * Every line below the list stays, because every line below the list was
       * tuned against something a real model actually did.
       */
      'These commands are your abilities. Run them with the `bash` tool.',
      '',
      /*
       * NAME + ONE LINE, not the whole tree and not the bare name.
       *
       * Bare names MEASURED a regression on the smallest model: ling-3.0-tiny
       * went 6/6 with schemas and 3/6 with names alone, and the transcripts show
       * exactly why — asked for a picture it ran `ls /usr/bin/`, `which python3`
       * and `import PIL`; asked for a sound effect, `which ffmpeg` and `which
       * sox`. It reached `media --help` on turn 3 and ran out of turns. The
       * anti-shopping lines below were already there and did not stop it.
       *
       * With the full tree it could SEE `media generate image` and just run it.
       * The summary is the cheap half of that: enough to know whether a group is
       * worth opening, without the commands, the arguments or the flags. About
       * 170 tokens against the tree's ~8,800.
       */
      /*
       * ONE LINE PER GROUP, not per command.
       *
       * Every command used to get its own line with its own one-sentence
       * description — effectively `--help` for `mac` and `browser` pre-pasted
       * into every prompt. the user: "I notice for some reason you pre advertise as
       * if it ran --help on mac and browser ... when there should just be 1
       * about the overarching tool". He is right that it is the same content
       * twice: the instruction below already says to run `--help` first, and the
       * translated `open -a` prints the whole of `mac --help` at the moment a
       * model is actually reaching for an app.
       *
       * The FILE tools are not listed at all. read / write / edit stay pinned as
       * ordinary pi tools with their own schemas — every accumulated write and
       * edit safety fix hangs off them — so listing `file read` beside them
       * would advertise one capability under two names.
       */
      ...cli.groups.filter((g) => g.name !== 'file').map((g) => `  ${g.name} — ${g.summary}`),
      '',
      'They are the ONLY way to do what they do. Do not look for other programs —',
      'ffmpeg, sox, say, festival, imaging libraries and the like are not how this',
      'works. Do not check whether anything exists first; just run the command.',
      '',
      /*
       * FIRST USE, NOT ONLY WHEN UNSURE. the user: "add to the system prompt a
       * suggested --help before using any initially."
       *
       * "If you are unsure" leaves the model to judge its own certainty, and a
       * model that has never seen a command is rarely uncertain about it — it
       * guesses a plausible shape. MEASURED, watching one meet `mac`: three
       * invented argument forms in a row (`--app "TextEdit"`, positional,
       * `--key app="TextEdit"`), each one read as a syntax error, before it got
       * anywhere near the help it needed. One `--help` first would have cost a
       * line and saved the turn.
       */
      'The FIRST time you use a command in a session, run `<command> --help` before',
      'the real call — you have its name and one line, not its arguments. After that',
      'you know it; just run it. Reading the help is not finishing the task.',
      '',
      /*
       * MEASURED: asked for a picture, the model called `ask_user` about STYLE
       * seven times in a row, thinking "they keep dismissing my questions" and
       * asking again. A question is the one action that cannot fail, so a model
       * unsure of a detail can loop on it forever. Detail choices are the
       * generator's job and a person who wanted to specify one would have.
       */
      'Choose sensible defaults for details the user did not specify — style,',
      'length, voice, size — and run the command. Ask only when the request',
      'cannot be carried out at all without an answer, and never ask twice.',
      '',
      'Never tell the user you are unable to do something one of these commands does.',
      '',
      /*
       * SHOWING IS A COMMAND. the user (2026-09-15): "guide the model via system
       * prompt to always utilize the present tool to display files to the
       * user." MEASURED the same day: asked to "present it", a 4B ran `open`,
       * was refused, and told the user the picture was "now visible" without
       * anything having been shown. See PRESENT_RULE for the schemas-mode
       * twin; here it names the command, and only when the command exists (a
       * subagent has no `present`).
       */
      ...(presentCommand === null
        ? []
        : [
            'Whatever you make or change for the user — a picture, a page, a document, a',
            `clip, a model, a script — show it to them with \`${presentCommand} <path>\` as`,
            'your last step. A path in prose is not showing it; the command opens it beside',
            'the chat and hands you a preview of what they will see — look at that before',
            'you say you are done.',
            '',
          ]),
      /*
       * The file commands are fenced and self-repairing (write fence, dropped
       * root slash, stray markdown fence, edit diagnosis); shell redirection is
       * none of those. `bash` already runs in the workspace root, so relative
       * redirection lands correctly — the loss is the repairs, and absolute
       * paths. Naming the preferred path is the part a prompt can do.
       */
      'To create or change a file, use the `write` / `edit` tools rather than shell',
      'redirection — they land in the right place and repair common mistakes.',
    ].join('\n');
  }

  function applyPreset(ctx: ExtensionContext, extraTools: readonly string[] = []): void {
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
    if (toolCliMode) {
      const pinned = TOOL_CLI_PINNED.filter((t) => available.includes(t));
      if (pinned.length > 0) {
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

    const specialist = specialistFromEnv();
    if (specialist !== undefined) {
      const pinned = specialistToolset(specialist, available);
      if (pinned.length > 0) {
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
    // Forbidden tools are blocked at `tool_call` regardless; dropping them here
    // as well means the model is never offered one, so it never spends a turn
    // being refused.
    const preset = [...resolveBaseTools(available), ...extraTools].filter((t) => !forbidden.has(t));
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
            `  prompt=${JSON.stringify(String(runtime.lastPrompt ?? '').slice(0, 120))}\n` +
            `  available(${available.length}): ${available.join(',')}\n` +
            `  target(${target.length}): ${target.join(',')}\n`,
        );
      } catch {
        /* a diagnostic must never break a turn */
      }
    }
    /*
     * THE WEB TOOLS COME OFF THE TABLE WHEN THERE IS NO WEB.
     *
     * the user: "model still has search and web tools even when there's no internet,
     * and gets confused looping in them." Telling it not to would not work —
     * llama-server pins the emitted tool name to the ADVERTISED list, so a model
     * that wants to look something up and can see `web_search` will keep calling
     * `web_search`. Removing it is the only thing that ends the loop; the tool
     * result that tripped the latch says why (OFFLINE_TOOL_NOTE).
     */
    if (offline.offline()) target = target.filter((t) => !NETWORK_TOOLS.has(t));
    if (wantCorp && !target.includes(CREATE_PRODUCTION_HIERARCHY)) {
      target.push(CREATE_PRODUCTION_HIERARCHY);
    } else if (!wantCorp && target.includes(CREATE_PRODUCTION_HIERARCHY)) {
      target = target.filter((t) => t !== CREATE_PRODUCTION_HIERARCHY);
    }
    // Only touch the tool set (and thus the cached prefix) when it actually
    // changed — by length OR membership (the corp tool can be added or removed).
    const changed =
      target.length !== runtime.activeTools.length ||
      target.some((t, i) => t !== runtime.activeTools[i]);
    if (changed) {
      pi.setActiveTools(target);
      runtime.activeTools = target;
    }
    // Keep the renderer's predictive-prefill tools in sync with what's now
    // resident on the slot (deduped ⇒ a no-op when the set didn't grow).
    publishPrefillContext(ctx, orderedToolDefs(runtime.activeTools));
    publishStatus(ctx);
  }

  /**
   * The ≤12B caveat, keyed off a capability the model actually REACHED FOR.
   *
   * It used to key off the task class, and per-turn classification is gone —
   * `cls` is the preset, and under the default Auto that is always `'coding'`,
   * which is not an advanced class. So the warning the brief asked for could
   * never fire on the case it was written for. What the model reaches for is
   * better evidence than a guess about the prompt, and it reads the same in
   * both tool interfaces: a schema-mode tool name maps through
   * `capabilityForTool`, and a CLI-mode `bash` command starts with the group
   * word, which IS the capability's command name.
   *
   * Once per session. It is a caveat, not an alarm.
   */
  function warnIfSmallModelForCapability(
    toolName: string,
    input: unknown,
    ctx: ExtensionContext,
  ): void {
    if (runtime.warnedSmallModel || runtime.model === null || !ctx.hasUI) return;
    const capability =
      toolName === 'bash' ? capabilityForCliCommand(input) : capabilityForTool(toolName)?.name;
    if (capability === undefined) return;
    const warning = smallModelCapabilityWarning(runtime.model, capability);
    if (warning === null) return;
    runtime.warnedSmallModel = true;
    ctx.ui.notify(warning, 'warning');
  }

  /** The capability behind a CLI-mode bash command, via its leading group word. */
  function capabilityForCliCommand(input: unknown): string | undefined {
    if (!toolCliMode) return undefined;
    const command = (input as { command?: unknown })?.command;
    if (typeof command !== 'string') return undefined;
    const head = command.trim().split(/\s+/)[0];
    if (head === undefined) return undefined;
    return toolCliGroups().find((g) => commandNameFor(g.name) === head)?.name;
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
  pi.on('session_start', (event, ctx) => {
    runtime.currentCtx = ctx;
    const isFork = (event as { reason?: string } | undefined)?.reason === 'fork';
    /*
     * REPUBLISH THE PREFILL CONTEXT — the renderer just threw its copy away.
     *
     * A session boundary drops every `harness*` status key in the renderer (so a
     * stale checklist cannot leak into a new chat), and `harness-prefill-system`
     * / `-tools` are caught by that net. These two caches then say "already
     * sent", so on a switch to a chat with the same system prompt they were
     * never re-sent — and predictive prefill was DEAD for the rest of the
     * session after the first chat switch, silently, because nothing on either
     * side is wrong on its own.
     *
     * Clearing them here makes the next publish (the 1s tick below, or the first
     * turn) a real one. The renderer's own gate refuses to prime while they are
     * missing, so the window costs a prime rather than a poisoned slot.
     */
    publishedPrefillSystem = null;
    publishedPrefillTools = null;
    // Another chat's wire bytes are not this one's: until a request goes out
    // here, the prime renders from the transcript (its fallback).
    runtime.lastRequestMessages = null;
    runtime.lastTurnMessages = [];
    /*
     * ...and a new session builds its system prompt again. It is frozen for the
     * life of a session (see maybeWarmPrefix) precisely so it cannot churn under
     * the KV; a session boundary is where a legitimately different one — a new
     * day's date, another working folder — is allowed in.
     */
    runtime.canonicalSystemPrompt = null;
    pendingCanonicalPrompt = null;
    // …and what the model has been told about its folder starts over with it.
    runtime.announcedWorkspace = null;
    runtime.promptWorkspace = null;
    /*
     * …EXCEPT ON A FORK, which is not a new session but the same one continued
     * on a branch: it keeps the prompt it froze, the folder its tools work in
     * and what the model was told about it — see ForkCarry for what forgetting
     * them cost. Before anything below publishes or warms, so the warm-up at
     * the end of this handler warms the prompt the server already holds.
     */
    if (isFork) {
      runtime.canonicalSystemPrompt = forkCarry.prompt;
      runtime.workspaceRoot = forkCarry.workspaceRoot;
      runtime.promptWorkspace = forkCarry.promptWorkspace;
      /*
       * …but what the model was TOLD is what this branch still holds. A ⌘Z or
       * an edit forks from before the message it takes back; when that was the
       * turn that carried the workspace note, the note went with it, and the
       * branch's model knows only the folder its prompt names. MEASURED (the
       * thread track's unsend probe, C4b): the note gone from the context and
       * never sent again. So: the last note on the branch, else the prompt's own.
       */
      runtime.announcedWorkspace = announcedOnBranch(
        getEntries(ctx),
        forkCarry.promptWorkspace,
        forkCarry.announcedWorkspace,
      );
    } else {
      rememberForFork();
    }
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
    // …and a fresh session starts hopeful about the network.
    offline.reset();
    runtime.touchedFiles = [];
    runtime.checkpoints = [];
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

  pi.on('session_shutdown', (event) => {
    if (runtime.statusTimer !== null) {
      clearInterval(runtime.statusTimer);
      runtime.statusTimer = null;
    }
    /*
     * A FORK REWINDS THE TURN THIS WIRING WAS ABOUT TO TIDY UP AFTER.
     *
     * Post-turn work (naming, review) waits POST_TURN_DELAY_MS after a turn —
     * including a turn that was stopped — and nothing cancelled it when the
     * session moved on. After a fork that turn is gone from the conversation:
     * an edit replaced its message, ⌘Z took it back. MEASURED
     * (unsend-prefill-probe): 2.5 s after ⌘Z the old wiring still sent the
     * naming request — the conversation INCLUDING the message the user had
     * just taken back — onto the single model slot, right as the next message
     * was going out; left alone it would have titled the chat after that
     * message. Only a fork: switching chats leaves the old one's naming to
     * finish, as before.
     */
    if ((event as { reason?: string } | undefined)?.reason === 'fork') {
      if (postTurnTimer !== null) clearTimeout(postTurnTimer);
      postTurnTimer = null;
      postTurnWork?.abort();
      postTurnWork = null;
    }
  });

  // Classify each task and load its preset before the agent loop runs. When a
  // utility model is configured, ambiguous heuristics escalate to a tier-2
  // double-check (classifyWithEscalation); otherwise the pure heuristic stands.
  // The teach skill's text, read once from the app's bundled skills (or null).
  let teachBody: string | null | undefined;
  const teachSkillText = (): string | null => {
    if (teachBody === undefined) teachBody = loadTeachSkill(process.env);
    return teachBody;
  };

  pi.on('before_agent_start', async (event, ctx) => {
    /* PI_ADV_DEBUG_TIMING=1: how long this hook holds the turn before the
       provider is even asked — the part of TTFT that is ours, not the model's. */
    const hookT0 = Date.now();
    const timing = (process.env.PI_ADV_DEBUG_TIMING ?? '').length > 0;
    /* A new turn deserves the full explanation again — the escalation is about
       one turn's refusal to take an answer, not a grudge. */
    fencedWhileDriving = 0;
    coercedRefusals = 0;
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
    /*
     * WHAT THE TURN ACTUALLY SENDS, for the prefill probes only.
     *
     * Predictive prefill primes `[system, …history, {user: attachment}]` and is
     * only worth anything if the turn's own user message BEGINS with that same
     * attachment, byte for byte. Nothing in the renderer can see the string pi
     * finally sends, so a divergence there is invisible — and a prime that
     * diverges does not merely miss, it evicts the prefix that would have been
     * reused. Behind an env flag because it is the whole message, every turn.
     */
    if (ctx.hasUI === true && (process.env.PI_ADV_DEBUG_PREFILL ?? '').length > 0) {
      ctx.ui.setStatus('harness-prefill-lastuser', event.prompt);
    }
    // Fresh agent loop: a new loop detector (effort-scaled cap/streaks) and an
    // empty touched-file set. Reset per turn (fix #3). NOTE: the verify fix budget
    // is deliberately NOT reset here — a self-triggered fix revision is also a new
    // before_agent_start, and verifyTurn manages that budget via `verifyActive`.
    runtime.loopDetector = createLoopDetector(
      loopDetectorConfig(effortKnobs(runtime.config.effort)),
    );
    runtime.touchedFiles = [];
    /* A fresh turn's checkpoints. The ones on DISK survive (that is the point —
       you notice a bad change a few turns later), pruned to KEEP_TURNS below. */
    runtime.checkpoints = [];
    prune(checkpointRoot());
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
      runtime.canonicalSystemPrompt ?? canonicalPrompt(event.systemPrompt);
    runtime.canonicalSystemPrompt = augmentedSystemPrompt;
    if (runtime.announcedWorkspace === null) {
      runtime.announcedWorkspace =
        /^Current working directory: (.*)$/m.exec(augmentedSystemPrompt)?.[1] ?? null;
      runtime.promptWorkspace = runtime.announcedWorkspace;
    }
    /*
     * THE FOLDER MOVED SINCE THE MODEL WAS LAST TOLD — say so, in the turn.
     *
     * the user, reading a fresh chat's prompt: "the working directory is by
     * default users/the user when in no project??? not a sandbox..." Two things
     * were wrong. pi was spawned in HOME (fixed in the app's cwd resolver:
     * a new chat's not-yet-written session read as "nothing to defer to"),
     * and a projectless chat gets its own folder — `~/Bobble/<first words>` —
     * on its FIRST message, after the prompt has been frozen and warmed with
     * the boot folder. Rewriting the frozen prompt would say the truth at the
     * price of the whole warmed prefix (MEASURED: 6.3 s first token against
     * 2 s). A note beside the user's message says the same truth for ~30
     * tokens, persists in the conversation, and leaves the prefix alone.
     */
    const workspaceNote = workspaceMoveNote();
    /* The teach skill beside a message that asks to learn — once per chat,
       top-level only (skills/teach-skill.ts). */
    const teach =
      readSubagentDepth(process.env) === 0 &&
      wantsTeaching(event.prompt) &&
      !teachGiven(getEntries(ctx)) &&
      teachSkillText() !== null
        ? teachNote(teachSkillText() as string)
        : null;
    // The prompt this turn froze, and what the model now knows of its folder.
    rememberForFork();
    // Classification REMOVED from the turn path (the user: "we seldom use it at all,
    // let's just completely remove"). The turn-1 {title,class} piggyback cost
    // ~2.5s of TTFT — an awaited utility call before the model could even start.
    // Instead use a fixed default preset: deterministic, and it matches the
    // model-load warm-up ('coding') so the KV prefix is reused. Conversation naming is now a
    // post-turn background pass (agent_end) that never blocks the reply. Re-add
    // per-task classify later if the routing proves worth the latency.
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
    applyPreset(ctx);
    // A new turn starts at no-ingest, not at whatever the last one reached.
    clearPrefillStatus(ctx);
    if (timing) console.error(`[pi-timing] before_agent_start ${Date.now() - hookT0}ms`);
    // Replace the turn's system prompt with the capability-affirming version.
    return {
      systemPrompt: augmentedSystemPrompt,
      ...(workspaceNote !== null || teach !== null
        ? {
            message: {
              // One hidden note per turn: the folder's, the skill's, or both.
              customType: workspaceNote !== null ? HARNESS_WORKSPACE_NOTE : HARNESS_SKILL_NOTE,
              content: [workspaceNote, teach].filter((n) => n !== null).join('\n\n'),
              display: false,
              details: {
                // Which folder it announced — read back off a branch (session_start, fork).
                ...(workspaceNote !== null ? { root: runtime.announcedWorkspace } : {}),
                // Given once per branch (teachGiven).
                ...(teach !== null ? { skill: 'teach' } : {}),
              },
            },
          }
        : {}),
    };
  });

  /** The note for a folder the model has not been told about yet, or null. */
  function workspaceMoveNote(): string | null {
    const root = runtime.workspaceRoot;
    if (root === null) return null;
    const same = (a: string, b: string | null): boolean => {
      if (b === null) return false;
      const real = (p: string): string => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };
      return real(a) === real(b);
    };
    if (same(root, runtime.announcedWorkspace)) return null;
    runtime.announcedWorkspace = root;
    /*
     * Say what a relative path looks like from INSIDE it. SEEN 2026-09-13: told
     * "cwd ~/Bobble" by the prompt and "working folder ~/Bobble/hi-8" by this
     * note, the model wrote every file as `hi-8/<name>` — the folder's own name
     * first — and the tools nested the folder inside itself. The example is
     * the folder's real name, so there is nothing to translate.
     */
    const own = basename(root);
    // By name, never by its full path (see workingFolderLine): the model says
    // paths the way it hears them.
    return (
      `Working folder: \`${own}\` — this is your current directory now. Relative paths ` +
      `resolve inside it (write \`notes.md\`, not \`${own}/notes.md\`), and that is where ` +
      `files belong unless the user names somewhere else; say paths that way too. ${SHELL_CWD_TRUTH}`
    );
  }

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
    runtime.lastTurnMessages = event.messages;
    /*
     * PUBLISH THE RESIDENT CONVERSATION for the composer's prime of the next
     * message: the last request's messages + this reply, in the provider's
     * shape. The renderer used to rebuild the history from its own transcript,
     * which cannot see a hidden custom message (the workspace note) or a canvas
     * block — and a prime that differs from the turn does not miss, it evicts.
     */
    if (ctx.hasUI === true) {
      const resident = residentConversation(runtime.lastRequestMessages, event.messages);
      ctx.ui.setStatus(
        'harness-prefill-history',
        resident === null ? '' : JSON.stringify(resident),
      );
    }
    // The re-prefill it named is over with the turn.
    runtime.loadingCapability = null;
    /*
     * AND THE INGEST IS OVER TOO — say so.
     *
     * `harness-prefill` was only ever SET, capped at 99 because "the renderer
     * drives the final 100". Nothing ever wrote that 100, so the channel kept
     * its last value for the life of the session: a reader sees a turn that has
     * been ingesting since it finished, and the NEXT turn opens showing the
     * PREVIOUS turn's percentage until a real progress frame replaces it.
     *
     * Found by instrumenting it — a demo run measured "1 ingest, 252.1s", which
     * was the whole run rather than any ingest.
     */
    clearPrefillStatus(ctx);
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
    // Which steers had fired before this turn ended — so the last nudge below
    // can tell "another one fired just now" from "one fired turns ago".
    const steeredBefore = [
      runtime.nudgedHandback,
      runtime.nudgedOutputLimit,
      runtime.nudgedUnfinished,
    ].join();
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
    /*
     * A TURN THAT ENDS WITH THE MODEL'S OWN CHECKLIST UNFINISHED.
     *
     * the user, round 3: "long running tasks where you can't accept an 'I can't do
     * this' needs to truly run until completion." The two nudges above catch a
     * turn that stopped by ASKING and one the decoder cut off; neither catches
     * the commonest ending — three of eight things done, a good summary of the
     * three, and a stop. It reads like success, which is why it survives
     * everything else.
     *
     * Built only from what the model itself asserted (see unfinished-plan.ts):
     * the harness cannot know whether a task is done, but `update_plan` is the
     * model saying what the task consists of, and a step left pending is its own
     * statement that something remains.
     *
     * Last of the three and gated on both, so one turn can never send two
     * steers, and once per session like its neighbours.
     */
    if (!runtime.nudgedHandback && !runtime.nudgedOutputLimit && !runtime.nudgedUnfinished) {
      const left = unfinishedPlan(runtime.plan);
      if (left !== null) {
        runtime.nudgedUnfinished = true;
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'steer', cause: 'unfinished-plan' });
        pi.sendUserMessage?.(unfinishedPlanNudge(left));
      }
    }
    /*
     * A TURN THAT ENDS ON "LET ME PRESENT IT" — AND DOESN'T. See
     * announced-step.ts: the 4B's icon set ended on a promise to present what it
     * drew, and the person was left with nothing to see. Once per session; and
     * only when no other steer went out THIS turn (theirs gate on each other's
     * session flags, which would silence this one for good after any of them).
     */
    const steeredNow =
      [runtime.nudgedHandback, runtime.nudgedOutputLimit, runtime.nudgedUnfinished].join() !==
      steeredBefore;
    let announcedNow = false;
    if (!steeredNow && !runtime.nudgedAnnounced && !endedAtOutputLimit(event.messages)) {
      const said = announcedNextStep(lastAssistantText(event.messages));
      if (said !== null) {
        runtime.nudgedAnnounced = true;
        announcedNow = true;
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'steer', cause: 'announced-step' });
        pi.sendUserMessage?.(announcedStepNudge(said));
      }
    }
    /* A TURN THAT ENDS WITHOUT A WORD — see loop/silent-end.ts: the 4B's SHM
       turn ended on "1 command failed, thought for 23s" and nothing else. Once
       per session; only when no other steer went out this turn. */
    if (
      !steeredNow &&
      !announcedNow &&
      !runtime.nudgedSilent &&
      !endedAtOutputLimit(event.messages)
    ) {
      const end = silentEnd(event.messages);
      if (end !== null) {
        runtime.nudgedSilent = true;
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'steer', cause: 'silent-end' });
        pi.sendUserMessage?.(silentEndNudge(end));
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
    // pass so it NEVER blocks the reply. Reuses the cache-sharing title
    // piggyback (the just-run turn's KV is resident, so only the tiny title
    // instruction + answer are new). Fire-and-forget.
    //
    // Gated on the title still being MISSING rather than on turn 1: a fast typist
    // aborts the first attempt, and a chat that never gets a name because the
    // user replied quickly is worse than naming it one turn later.
    if (runtime.title === null && titler !== undefined && runtime.lastPrompt !== null) {
      const namePrompt = runtime.lastPrompt;
      // Use the SAME frozen system prompt the turn ran on so the naming request
      // shares the conversation's resident KV (cheap) instead of re-prefilling.
      const sys =
        runtime.canonicalSystemPrompt ??
        augmentSystemPrompt(
          typeof ctx.getSystemPrompt === 'function' ? ctx.getSystemPrompt() : '',
          {},
        );
      const input: TitleInput = {
        prompt: namePrompt,
        turnIndex: 1,
        // The bytes on the wire + the reply — never a rendering of our own.
        priorMessages:
          (residentConversation(runtime.lastRequestMessages, runtime.lastTurnMessages) as
            | TitleMessage[]
            | null) ?? buildConversationPrefix(getEntries(ctx), sys, namePrompt, false),
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
        void titler(input).then((r) => {
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

  /**
   * THE PER-TOOL HALF OF `tool_call` — every rule keyed on the tool's own name,
   * for a call however it arrived.
   *
   * pi fires `tool_call` for the call the MODEL made, and two dispatchers run a
   * second tool inside that one by calling its `execute` directly: the bash-CLI
   * host (`file write …` at the shell runs `write`) and `use`. The hook only
   * ever saw `bash` or `use`, so everything below was skipped for the tool that
   * actually ran. SEEN during VQ-10: a flow diagram typed as `file write --path
   * flow.svg --content '<svg …>'` went straight to disk, while the same markup
   * through the `write` tool was refused toward `diagram`. All three doors call
   * this before `execute` now.
   *
   * What stays in the hook belongs to the OUTER call and is not redone for the
   * one inside it: `currentCtx`; `lastCallInput`, which the result hook compares
   * with the result it is holding (the bash result, for a command); `lastOpened`;
   * and the loop detector, which has already counted the bash line — counting
   * the tool inside it as well would double every streak.
   *
   * Returns the refusal, or undefined when the call may run — and an admitted
   * call is recorded as the hook always recorded it (touched files, the
   * checkpoint, delegation): a file a command writes needs `/harness restore` as
   * much as one a tool call writes. `ctx` is null only for a command run before
   * any session event.
   */
  function admitToolCall(
    event: { readonly toolName: string; readonly input: unknown },
    ctx: ExtensionContext | null,
  ): { block: true; reason: string } | undefined {
    /*
     * A TOOL THIS RUN MAY NOT CALL, whatever it thinks.
     *
     * FIRST, before anything else here. Not advertising a tool is not a fence:
     * `use` dispatches by name, the bash CLI dispatches by command, and a
     * capability activated mid-turn pulls a whole group in. Every one of those
     * comes through here — the first two call this before they execute — so
     * this is the only place a refusal actually holds.
     *
     * The case it exists for: an unattended scheduled run must not be able to
     * send a message on the user's behalf while they are asleep.
     */
    if (forbidden.has(event.toolName)) {
      return { block: true, reason: forbiddenReason(event.toolName) };
    }
    if (ctx !== null) warnIfSmallModelForCapability(event.toolName, event.input, ctx);
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
        /*
         * …AND A COMMAND THAT IS ONE TOKEN REPEATED IS NOT A COMMAND.
         *
         * MEASURED in the 12-run matrix: the 4B, working in Chrome, emitted
         * `readreadreadreadread…` as a bash command and we RAN it — 36 seconds
         * of a timed run, the activity terminal filling with one word. That is
         * a decoding slip, not an intention, and nothing downstream recovers a
         * run that spends its remaining minutes on it.
         *
         * Deliberately narrow (see degenerate-command.ts): refusing a real
         * command would be far worse than running a silly one, so the WHOLE
         * command has to be a single short unit tiled exactly, many times.
         * The refusal names the repetition, because a model in this state can
         * act on "you repeated 'read' 40 times" where "invalid command" just
         * invites a variation of the same thing.
         */
        const degenerate = degenerateCommandRefusal(cmd);
        if (degenerate !== null) {
          pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'degenerate-command' });
          return { block: true, reason: degenerate };
        }
        /*
         * …AND A COMMAND THAT DELETES THE PLACE THE WORK LIVES.
         *
         * The checkpoint below covers `write` and `edit` — that is the whole
         * "put it back three turns later" safety net — and bash is outside it.
         * MEASURED on a long run: 24 files written, then over six minutes the
         * count went 24 → 0 → 13 → 24 → 0, and at the end the working
         * directory and the home containing it did not exist. Nothing was
         * there to notice. See workspace-guard.ts for why the rule is only
         * about the workspace ROOT and lets every ordinary `rm -rf build`
         * through.
         */
        const destroy = wouldDestroyWorkspace(cmd, runtime.workspaceRoot ?? undefined);
        if (destroy !== null) {
          pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'workspace-delete' });
          return { block: true, reason: destroy };
        }
        /*
         * …AND A DECK BUILT WITH python-pptx IN A HEREDOC WHILE THE PIPELINE
         * IS ONE COMMAND AWAY — see handmade-office.ts. MEASURED in the canvas
         * assessment: twelve `python3 << 'EOF' / from pptx import Presentation`
         * calls in a row, with the document pipeline installed and unreachable
         * from the chat. Now it is reachable, and the reflex is answered with
         * the command that does the job.
         */
        /*
         * …AND A `find /` — see disk-walk.ts. Spotlight is one command away and
         * the walk was still running when the assessment's turn timed out.
         */
        const walk = wouldWalkDisk(cmd);
        if (walk !== null) {
          pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'disk-walk' });
          const spotlight = pi.getAllTools().some((t) => t.name === 'spotlight_search')
            ? (cliCommandForTool?.('spotlight_search') ?? 'the spotlight_search tool with')
            : null;
          return { block: true, reason: diskWalkRefusal(walk, spotlight) };
        }
        /*
         * …BUT A LINE THAT IS A FILE WRITE IS READ AS THE WRITE IT IS. `file
         * write --path plot.py --content '<script>'` carries the file on the
         * command line, and the CLI host holds that write to the write/edit
         * rules below — against the real path and body, with their one escape.
         * Reading the same text here as well put a second refusal with a
         * second escape in front of it: a plotting script the user really asked
         * for took four identical tries, where `write` takes two.
         */
        const lineHead = cmd.trim().split(/\s+/, 2).join(' ');
        const fileLine =
          lineHead === cliCommandForTool?.('write') || lineHead === cliCommandForTool?.('edit');
        const officeAvailable = pi.getAllTools().some((t) => t.name === OFFICE_MAKE_TOOL);
        const handmadeOffice = fileLine
          ? null
          : isHandmadeOffice({ content: cmd, officeAvailable });
        if (handmadeOffice !== null) {
          pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'handmade-office' });
          return {
            block: true,
            reason: handmadeOfficeRefusal(handmadeOffice, { cli: toolCliMode }),
          };
        }
        /*
         * …AND A CHART PLOTTED WITH matplotlib IN A HEREDOC WHILE `chart`
         * DRAWS IT IN THE CHAT — see handmade-chart.ts. The identical command
         * again is the exit: a plotting script can be what the user asked for.
         */
        if (chartScriptRefused === cmd) {
          chartScriptRefused = null;
        } else if (!fileLine) {
          const chartAvailable = pi.getAllTools().some((t) => t.name === CHART_TOOL);
          const handmadeChart = isHandmadeChart({ content: cmd, chartAvailable });
          if (handmadeChart !== null) {
            chartScriptRefused = cmd;
            pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'handmade-chart' });
            return {
              block: true,
              reason: handmadeChartRefusal(handmadeChart, { cli: toolCliMode }),
            };
          }
        }
        /*
         * …AND A MATHS FIGURE TYPED AS SVG INTO A HEREDOC — see bash-writes.ts.
         * Through `write` the same markup meets handwritten-svg's refusal;
         * typed into bash it went round it (MEASURED: the 4B's derivative, a
         * tangent on a parabola, `cat > derivative_tangent.svg << 'EOF'`). The
         * identical command again is the exit, as the identical write is.
         */
        if (mathSvgRefused === cmd) {
          mathSvgRefused = null;
        } else if (!fileLine && pi.getAllTools().some((t) => t.name === MATH_TOOL)) {
          const drawn = bashWrites(cmd).find(
            (w) => /\.svg$/i.test(w.path) && mathFigureMarkup(w.body ?? cmd),
          );
          if (drawn !== undefined) {
            mathSvgRefused = cmd;
            pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'handwritten-math' });
            return { block: true, reason: handwrittenMathRefusal(drawn.path, { bash: true }) };
          }
        }
        /*
         * …AND A PAGE READ WITH curl WHILE `web fetch` IS ONE COMMAND AWAY —
         * see raw-page-fetch.ts. MEASURED: four `curl … | grep height` calls
         * on the Eiffel Tower's Wikipedia page, kilobytes of markup each, and
         * a twelve-minute turn with no answer.
         */
        if (pi.getAllTools().some((t) => t.name === 'web_fetch')) {
          const page = rawPageFetchUrl(cmd);
          if (page !== null) {
            pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'raw-page-fetch' });
            return { block: true, reason: rawPageFetchRefusal(page, { cli: toolCliMode }) };
          }
        }
      }
    }
    /*
     * A WRITE THAT IS REALLY A TOOL CALL — see coerced-write.ts.
     *
     * MEASURED, matrix run 1: `write { path: "read_chrome_url.txt", content:
     * "read the URL of Google Chrome" }`. The grammar had no chrome verb to emit
     * (in bash-cli mode they are commands, not tool names) so the call landed on
     * the nearest advertised name. Blocked HERE rather than annotated after the
     * fact, because the write succeeding is the actual harm: "Successfully wrote
     * 30 bytes" rewards the one action that cannot reach the window.
     */
    /*
     * …AND A SEARCH WRITTEN INTO A FILE — see isCoercedSearch. MEASURED: the
     * 4B's first act on a research question, in two runs, was a `write`
     * whose content began "Searching for …"; the second run made that call
     * 150 times. Only while a web search is actually registered.
     */
    if (event.toolName === 'write' && pi.getAllTools().some((t) => t.name === 'web_search')) {
      const body = (event.input as { content?: unknown })?.content;
      if (typeof body === 'string' && isCoercedSearch(body)) {
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'coerced-search' });
        return { block: true, reason: coercedSearchRefusal(body, { cli: toolCliMode }) };
      }
    }
    if (FILE_TOOLS.has(event.toolName) && controlledApp !== null) {
      const body = (event.input as { content?: unknown })?.content;
      if (typeof body === 'string' && isCoercedToolCall(body, controlledApp)) {
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'coerced-write' });
        coercedRefusals += 1;
        /* Saying it louder is not saying it again — MEASURED, 59 identical
           refusals in one run, none of which changed the next call. */
        return {
          block: true,
          reason:
            coercedRefusals >= 3
              ? coercedWriteEscalation(body, controlledApp, drivingHowTo(), coercedRefusals)
              : coercedWriteRefusal(body, controlledApp, drivingHowTo()),
        };
      }
      /* …and the `edit` spelling of it, which is the one a model reaches for
         when what it wants is to TYPE — see isCoercedEdit. */
      const target = (event.input as { path?: unknown })?.path;
      const first = (event.input as { edits?: { oldText?: unknown; newText?: unknown }[] })
        ?.edits?.[0];
      if (
        typeof target === 'string' &&
        typeof first?.newText === 'string' &&
        isCoercedEdit(target, controlledApp)
      ) {
        pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'coerced-edit' });
        return {
          block: true,
          reason: coercedEditRefusal(
            first.newText,
            typeof first.oldText === 'string' ? first.oldText : '',
            controlledApp,
            drivingHowTo(),
          ),
        };
      }
    }
    /*
     * AN SVG WRITTEN BY HAND WHILE THE DRAWING MODEL IS ON — see
     * handwritten-svg.ts. The escape is IDENTICAL bytes, not the same path:
     * MEASURED on the website scenario, a path-only escape let the model bypass
     * by re-writing the logo with one hex digit changed (junk on disk). A
     * genuine fixture author repeats exact bytes; a model flailing past the
     * guard tweaks and retries — so only a byte-for-byte repeat goes through,
     * and the refusal does not advertise it (advertising "write it again" made
     * re-writing the path of least resistance the first time).
     */
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const input = event.input as {
        path?: unknown;
        content?: unknown;
        edits?: { newText?: unknown }[];
      };
      const tools = pi.getAllTools();
      const svgCommandAvailable = tools.some((t) => t.name === 'generate_svg');
      /* The diagram tool draws what used to be refused toward OmniSVG — boxes,
         arrows and labels (handwritten-svg.ts, VQ-10) — so its presence alone
         is reason to look at an SVG write. */
      const diagramAvailable = tools.some((t) => t.name === DIAGRAM_TOOL);
      const mathAvailable = tools.some((t) => t.name === MATH_TOOL);
      /* Which generators exist RIGHT NOW. With generation off there is nothing
         to redirect a script to, and the script is the only way the model has. */
      const generators = new Set<MediaKind>();
      if (tools.some((t) => t.name === 'generate_image')) generators.add('image');
      if (tools.some((t) => t.name === 'generate_video')) generators.add('video');
      if (tools.some((t) => t.name === 'generate_music' || t.name === 'generate_sfx'))
        generators.add('audio');
      /*
       * `svgCommandAvailable` used to gate this whole block, which quietly made
       * the HAND-MADE MEDIA guard depend on an unrelated tool: with `generate_svg`
       * absent and `generate_image` present, a Pillow script that draws a picture
       * sailed through. MEASURED — asked in chat for a two-second video, a 2B
       * wrote `make_video.py`, drew sixty frames with `ImageDraw`, and nothing
       * stopped it, because the SVG generator was not installed on that machine.
       * Each guard now asks its own question: the SVG ones about `generate_svg`,
       * this one about whether a generator for THAT modality exists — and the
       * chart one about `chart`, which a `file write` line is left to (above).
       */
      const officeAvailable = tools.some((t) => t.name === OFFICE_MAKE_TOOL);
      const chartAvailable = tools.some((t) => t.name === CHART_TOOL);
      if (
        typeof input.path === 'string' &&
        (svgCommandAvailable ||
          diagramAvailable ||
          generators.size > 0 ||
          officeAvailable ||
          chartAvailable)
      ) {
        const abs = isAbsolute(input.path)
          ? input.path
          : join(runtime.workspaceRoot ?? ctx?.cwd ?? process.cwd(), input.path);
        /*
         * A MEDIA FILE WRITTEN AS TEXT — a `.png` "placeholder" (SEEN, twelve
         * times in a row), an empty one, an HTML canvas saved as .png. Before
         * anything reads the body, because an EMPTY body is this mistake too
         * — and it used to fall through to the workspace fence, whose answer
         * ("pass a relative path") was the wrong lesson. Not crossable: there
         * is no right version of this write. Only while the generator for it
         * is registered.
         */
        const mediaFile = event.toolName === 'write' ? mediaFileKind(input.path) : null;
        if (mediaFile !== null && generators.has(mediaFile)) {
          pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'media-file-as-text' });
          return {
            block: true,
            reason: mediaFileRefusal(input.path, mediaFile, { cli: toolCliMode }),
          };
        }
        /* The text this call would put on disk: a write's whole content, or
           what an edit's replacements add. */
        const body =
          event.toolName === 'write'
            ? typeof input.content === 'string'
              ? input.content
              : ''
            : (input.edits ?? [])
                .map((e) => (typeof e.newText === 'string' ? e.newText : ''))
                .join('\n');
        /* A deliberate identical repeat of a refused body is the escape valve —
           consumed on use, so a THIRD write re-evaluates rather than sailing
           through forever. */
        const deliberateRepeat = body !== '' && svgRefused.get(abs) === body;
        if (deliberateRepeat) {
          svgRefused.delete(abs);
        } else if (body !== '') {
          let exists = false;
          try {
            statSync(abs);
            exists = true;
          } catch {
            exists = false;
          }
          /*
           * …AND A CHART — a plotting script written to disk, or the bars typed
           * as <rect>s into a .svg — see handmade-chart.ts. Before the
           * OmniSVG guard: a chart typed as markup is a chart, not a drawing.
           */
          const handmadeChart = isHandmadeChart({
            path: input.path,
            content: body,
            chartAvailable,
          });
          if (handmadeChart !== null) {
            svgRefused.set(abs, body);
            pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'handmade-chart' });
            return {
              block: true,
              reason: handmadeChartRefusal(handmadeChart, {
                cli: toolCliMode,
                edit: event.toolName === 'edit',
                path: input.path,
              }),
            };
          }
          const svgRoute =
            event.toolName === 'write'
              ? handwrittenSvgRoute({
                  path: input.path,
                  content: body,
                  exists,
                  svgCommandAvailable,
                  diagramAvailable,
                  mathAvailable,
                  request: runtime.lastPrompt,
                })
              : null;
          if (svgRoute !== null) {
            svgRefused.set(abs, body);
            pi.appendEntry(HARNESS_LOOP_ENTRY, {
              action: 'block',
              cause:
                svgRoute === 'math'
                  ? 'handwritten-math'
                  : svgRoute === 'diagram'
                    ? 'handwritten-diagram'
                    : 'handwritten-svg',
            });
            return {
              block: true,
              reason:
                svgRoute === 'math'
                  ? handwrittenMathRefusal(input.path)
                  : svgRoute === 'diagram'
                    ? handwrittenDiagramRefusal(input.path, { cli: toolCliMode })
                    : handwrittenSvgRefusal(input.path),
            };
          }
          /*
           * …AND A SCRIPT THAT SYNTHESISES A PICTURE OR A SOUND — see
           * handmade-media.ts. Asked for an image in chat, a 2B wrote a Pillow
           * script that draws a mug out of rectangles, with `media` in its
           * command list and "imaging libraries … are not how this works" in
           * its prompt. Same escape as the SVG guard: identical bytes.
           */
          const handmade =
            event.toolName === 'write'
              ? isHandmadeMedia({ path: input.path, content: body, available: generators })
              : null;
          if (handmade !== null) {
            svgRefused.set(abs, body);
            pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'handmade-media' });
            return {
              block: true,
              reason: handmadeMediaRefusal(input.path, handmade, { cli: toolCliMode }),
            };
          }
          /*
           * …AND A SCRIPT THAT WRITES AN OFFICE FILE WITH A LIBRARY — see
           * handmade-office.ts. Same escape as the two above: identical bytes.
           */
          const handmadeOffice = isHandmadeOffice({ content: body, officeAvailable });
          if (handmadeOffice !== null) {
            svgRefused.set(abs, body);
            pi.appendEntry(HARNESS_LOOP_ENTRY, { action: 'block', cause: 'handmade-office' });
            return {
              block: true,
              reason: handmadeOfficeRefusal(handmadeOffice, { cli: toolCliMode }),
            };
          }
          const inlineRoute = inlineSvgRoute({
            path: input.path,
            content: body,
            svgCommandAvailable,
            diagramAvailable,
            mathAvailable,
            request: runtime.lastPrompt,
          });
          if (inlineRoute !== null) {
            svgRefused.set(abs, body);
            pi.appendEntry(HARNESS_LOOP_ENTRY, {
              action: 'block',
              cause:
                inlineRoute === 'math'
                  ? 'handwritten-inline-math'
                  : inlineRoute === 'diagram'
                    ? 'handwritten-inline-diagram'
                    : 'handwritten-inline-svg',
            });
            return {
              block: true,
              reason:
                inlineRoute === 'math'
                  ? handwrittenMathRefusal(input.path, {
                      inline: true,
                      edit: event.toolName === 'edit',
                    })
                  : inlineRoute === 'diagram'
                    ? handwrittenDiagramRefusal(input.path, {
                        cli: toolCliMode,
                        inline: true,
                        edit: event.toolName === 'edit',
                      })
                    : handwrittenInlineSvgRefusal(
                        input.path,
                        countInlineDrawnSvgs(body),
                        event.toolName === 'edit',
                      ),
            };
          }
        }
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
        /*
         * A COPY BEFORE THE WRITE, so the turn can be put back.
         *
         * Here rather than on the result: the `edit` tool's result hook fires
         * only on `isError`, so a SUCCESSFUL edit would never be captured — and
         * by the time any result exists the previous content is gone.
         *
         * Never throws (see checkpoints.ts): a failed snapshot must not fail
         * the write it was shadowing.
         */
        const cp = capture(checkpointRoot(), runtime.turnIndex, path);
        if (cp !== null) runtime.checkpoints.push(cp);
      }
    }
    return undefined;
  }

  // Loop / no-progress breaking (fix #3), plus touched-file tracking for the
  // verify syntax fallback. Feeds the per-turn detector the identical-call streak
  // (before execution) and the consecutive-error streak (after execution).
  pi.on('tool_call', (event, ctx) => {
    runtime.currentCtx = ctx;
    // Kept for the result hook: a repeat is only a repeat if the ARGUMENTS
    // matched too, and the result event does not carry them.
    lastCallInput = { tool: event.toolName, input: event.input };
    const refused = admitToolCall(event, ctx);
    if (refused !== undefined) return refused;
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
  /** The tools whose refusal is worth redirecting at the app being driven. */
  const FILE_TOOLS = new Set(['edit', 'write', 'read', 'multi_edit']);
  /** What the last bash command opened, if anything — consumed by its result. */
  let lastOpened: ReturnType<typeof detectOpenedApp>;
  /** Image parts a CLI dispatch produced, re-attached to its bash result. */
  let cliImages: { type: string; text?: string; data?: string; mimeType?: string }[] = [];
  /*
   * The app currently being driven, remembered from whichever `mac_launch` the
   * model made — through the CLI or as a tool. Only used to answer a file-tool
   * refusal with something better than more path advice; see FILE_TOOLS below.
   */
  let controlledApp: string | null = null;
  /**
   * The command that READS the app currently being driven — Chrome through its
   * DOM, everything else through Accessibility.
   *
   * Kept next to `controlledApp` because it is only ever meaningful relative to
   * it, and shared by the two redirects below so they cannot drift apart and
   * name different commands for the same situation.
   */
  function drivingHowTo(): string {
    const app = controlledApp ?? '';
    const chrome = /^(?:google\s+)?chrome(?:\s+canary)?$/i.test(app.trim());
    const tool = chrome ? 'chrome_snapshot' : 'mac_snapshot';
    const cli = cliCommandForTool?.(tool) ?? null;
    if (cli === null) return chrome ? 'the chrome_snapshot tool' : 'the mac_snapshot tool';
    return chrome ? `\`${cli}\`` : `\`${cli} --app "${app}"\``;
  }
  /** File-tool refusals in THIS turn while an app was being driven — see the
   * escalation in the tool_result hook. Reset per turn, not per session: a
   * later turn deserves the full explanation again. */
  let fencedWhileDriving = 0;
  /** Coerced write/edit refusals in THIS turn — see coercedWriteEscalation. */
  let coercedRefusals = 0;
  /** path → the exact hand-drawn body last refused for it (handwritten-svg.ts).
   * Re-writing those exact bytes is the deliberate escape; a tweaked retry is a
   * fresh refusal. Per session. */
  const svgRefused = new Map<string, string>();
  /** The last plotting script refused at bash (handmade-chart.ts); the same
   * command again is the deliberate escape — the script may be the ask. */
  let chartScriptRefused: string | null = null;
  /** The last bash line refused for typing a maths figure as SVG; the same line again goes through. */
  let mathSvgRefused: string | null = null;
  pi.on('tool_result', async (event) => {
    /* In CLI mode every call is `bash`, so the real tool name is only known at
       the dispatch (see the CLI host's `call`); tally there instead, or the
       whole split reads as zero. */
    if (!toolCliMode) noteResult(modality, event.toolName, lastCallInput?.input, event.content);
    const mctx = runtime.currentCtx;
    if (mctx?.hasUI === true) {
      mctx.ui.setStatus('harness-modality', JSON.stringify(modality));
    }
    /*
     * AN APP IS "BEING DRIVEN" ONLY ONCE IT ACTUALLY LAUNCHED.
     *
     * This was set at the CALL. MEASURED: `open -a "Microsoft PowerPoint"
     * deck.pptx` on a Mac with no PowerPoint became a `mac_launch` that failed
     * ("Unable to find application") — and from then on every write in the
     * turn was answered with "Nothing written to disk reaches Microsoft
     * PowerPoint, and the task is in that window", about a window that never
     * existed. The result is where the answer is.
     */
    if (event.toolName === 'mac_launch' && !toolCliMode) {
      const app = (lastCallInput?.input as { app?: unknown } | undefined)?.app;
      if (typeof app === 'string' && event.isError !== true) controlledApp = app;
    }
    /*
     * A FILE TOOL REFUSED WHILE AN APP IS BEING DRIVEN IS NOT A PATH PROBLEM.
     *
     * MEASURED on a 4B asked to add a cone in Blender: it said "I can see
     * Blender's start screen. I'll click on General", and then called `edit`
     * with path "/testbed" and oldText "This is the root directory" — training
     * residue, not a real path. It was refused, and the refusal explains where
     * the workspace is, so it guessed another path. EIGHT times, without ever
     * calling click.
     *
     * The refusal is right about the sandbox and useless here: the model does
     * not want a different path, it wants the app. Naming the app it launched,
     * and the command that acts on it, points at what it already said it meant
     * to do. The sandbox message is left intact underneath — this is an extra
     * sentence, not a replacement, because the fence still has to be explained
     * to a model that really was trying to write a file.
     */
    /*
     * …AND THE SAME REDIRECT WHEN THE WRITE SUCCEEDS.
     *
     * This fired only on a sandbox REFUSAL, which meant it depended on where the
     * workspace happened to be. MEASURED, matrix run 1: the workspace was
     * writable, so five plan-and-notes files landed on disk and the model was
     * told "Successfully wrote 136 bytes" each time — the dead end confirmed
     * rather than corrected, while Chrome sat untouched for the whole run.
     *
     * A file written while driving an app is no closer to the task than a file
     * refused, so the note is owed in both cases. The write still HAPPENS (the
     * note is appended, nothing is destroyed) — only the blatant tool-call-shaped
     * ones are blocked outright, up in the call hook.
     */
    if (FILE_TOOLS.has(event.toolName) && controlledApp !== null) {
      const said = event.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const fenced = event.isError === true && /outside the workspace|Refusing to /.test(said);
      /*
       * EVERY OUTCOME, not two of the three.
       *
       * This gate first read "refused by the sandbox", then "refused, or
       * succeeded" — and the case it still missed was the ordinary failure,
       * which turned out to be the big one. MEASURED, matrix run 4 (Maps, 4B):
       * 73 of 81 calls were `edit`, every one dying on `EISDIR` or `File not
       * found`, which match neither the fence pattern nor success. So the
       * redirect said nothing for 73 consecutive dead-end calls.
       *
       * Refused, failed, succeeded: none of them reach the window, so the note
       * is owed in all three. `fenced` survives only to pick the wording.
       */
      {
        const how = toolCliMode
          ? `\`mac click --x <x> --y <y>\` (screen points, read off the screenshot)`
          : 'the mac_click tool';
        fencedWhileDriving += 1;
        /*
         * SAYING IT LOUDER IS NOT SAYING IT AGAIN.
         *
         * MEASURED on a Maps run: a 9B was refused, read the redirect, said in
         * its own words "the system is telling me I'm driving the Maps app and
         * should use mac commands directly" — and then wrote the file again.
         * Twenty times, until the run was over. Repeating a paragraph that has
         * demonstrably not worked is the harness talking to itself.
         *
         * So after the second one the sandbox explanation goes: it is advice
         * for a model that genuinely wanted to write a file, and by the third
         * refusal this is not that model. What is left is one sentence about
         * the only thing that can make progress.
         */
        const note =
          `\n\nYou are driving "${controlledApp}" right now. Writing or editing a file does ` +
          `NOT do anything to it — nothing you put on disk reaches that window. Act on the ` +
          `app itself: ${drivingHowTo()} to read it, then ${how}. If you just ` +
          `said what you were about to click, click it.`;
        if (fencedWhileDriving >= 3) {
          /* Say what actually happened — all three outcomes reach here now, and
             telling a model its failed edit "was written" (or that its written
             file was "refused") teaches it something false about the run it is
             in, which is the opposite of the point. */
          const nth = `${fencedWhileDriving}${fencedWhileDriving === 3 ? 'rd' : 'th'}`;
          const what = fenced
            ? `Refused, for the ${nth} time this turn.`
            : event.isError === true
              ? `That failed, and it is the ${nth} file call this turn that could not have helped either way.`
              : `That file was written, and it is the ${nth} one this turn that changes nothing.`;
          return {
            content: [
              {
                type: 'text',
                text:
                  `${what} Nothing written to disk reaches "${controlledApp}", and the ` +
                  `task is in that window. Your next call must act on it — ${drivingHowTo()} ` +
                  `to read it, then ${how} — or say plainly that you cannot.`,
              },
            ],
          };
        }
        return {
          content: event.content.map((part, i) =>
            i === 0 && part.type === 'text' ? { ...part, text: `${part.text}${note}` } : part,
          ),
        };
      }
    }
    /* A math spec just written or edited is drawn there and then: the page, its capture and its checks (math-tool.ts drawWrittenSpec). */
    const isSpec = (abs: string) =>
      existsSync(abs) &&
      (/\.math\.json$/i.test(abs) ||
        (/\.json$/i.test(abs) && looksLikeMathSpec(readFileSync(abs, 'utf8'))));
    const withDrawing = async (abs: string, root: string) => {
      const drawn = await drawWrittenSpec(abs, root, mathDeps);
      const said = drawn.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .filter((t) => t !== '')
        .join('\n');
      const note = drawn.isError === true ? `It does not draw yet — ${said}` : said;
      const first = event.content.findIndex((part) => part.type === 'text');
      return {
        content: [
          ...(first < 0 ? [{ type: 'text' as const, text: note }] : []),
          ...event.content.map((part, i) =>
            i === first && part.type === 'text'
              ? { ...part, text: part.text.trim() === '' ? note : `${part.text}\n\n${note}` }
              : part,
          ),
          ...drawn.content.filter((c) => c.type === 'image'),
        ],
      };
    };
    if ((event.toolName === 'write' || event.toolName === 'edit') && event.isError !== true) {
      const input = ((event as { input?: unknown }).input ?? lastCallInput?.input) as
        | { path?: unknown }
        | undefined;
      const rel = typeof input?.path === 'string' ? input.path : '';
      const root = liveRoot();
      const abs = rel === '' ? '' : isAbsolute(rel) ? rel : join(root, rel);
      /* A spec saved as plain .json is drawn too — MEASURED (the 4B): three
         Pythagorean specs written as pythagorean_proof.json, none drawn. */
      if (rel !== '' && isSpec(abs)) return withDrawing(abs, root);
    }
    /* …and one typed into bash as a heredoc — MEASURED (the 4B's derivative):
       `cat > tangent_deriv.json << 'ENDJSON'`, twice, never drawn (bash-writes.ts). */
    if (event.toolName === 'bash' && event.isError !== true) {
      const input = ((event as { input?: unknown }).input ?? lastCallInput?.input) as
        | { command?: unknown }
        | undefined;
      const cmd = typeof input?.command === 'string' ? input.command : '';
      const root = liveRoot();
      const spec = bashWrites(cmd)
        .map((w) => (isAbsolute(w.path) ? w.path : join(root, w.path)))
        .filter(isSpec)
        .pop();
      if (spec !== undefined) return withDrawing(spec, root);
    }
    /*
     * `read --help` IS BASH'S OWN `read`, AND ALWAYS WILL BE.
     *
     * MEASURED on a matrix run: a 4B knew it wanted the read tool, typed `read
     * --help` into bash the way it types `mac --help`, and got "/bin/bash: line
     * 0: read: --: invalid option" — four times in a row, reasoning about
     * Terminal in between. In CLI mode most tools ARE commands on PATH, so
     * assuming this one is too is the reasonable guess; it is just wrong, and
     * unfixably so, because a shell BUILTIN beats anything on PATH. A shim
     * cannot win that fight, so the failure gets a signpost instead — the same
     * treatment `open` gets, for the same reason: a dead end invites a
     * workaround, a signpost does not.
     */
    if (event.toolName === 'bash' && event.isError !== false) {
      const said = event.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      if (/\bread: (--|-[a-z]?): invalid option|read: usage: read \[/.test(said)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `${said}\n\nThat is the SHELL's built-in \`read\`, not a Bobble command — a ` +
                `builtin always wins over anything on PATH, so there is no version of this that ` +
                `works. Reading a file is a TOOL CALL, not a shell command: call the read tool ` +
                `with a path. \`mac\`, \`chrome\` and \`media\` are real commands; \`read\`, ` +
                `\`write\` and \`edit\` are not.`,
            },
          ],
        };
      }
    }
    /*
     * `activate` RETURNS SUCCESS AND DOES NOTHING — and we knew that.
     *
     * MEASURED this session, written down in Actions.swift: macOS refuses
     * cross-app activation from a BACKGROUND process, and both routes
     * (AppleScript `activate` and setting AXFrontmost) report success while
     * changing nothing. Bobble drives every app from the background by design —
     * the user's standing rule is that a run never takes his screen — so this
     * command can only ever be a silent no-op here.
     *
     * MEASURED, matrix run 1: the 4B ran it four times, got "(no output)" each
     * time, and reasonably read empty output as "Chrome is frontmost now".
     * Nothing had moved. An empty success is the least readable failure there
     * is, so it gets said out loud — together with the thing the model actually
     * needs to hear, which is that it does not need focus at all.
     */
    if (event.toolName === 'bash' && event.isError !== true) {
      const ran =
        typeof lastCallInput?.input === 'object' && lastCallInput?.tool === 'bash'
          ? String((lastCallInput.input as { command?: unknown })?.command ?? '')
          : '';
      if (/osascript/.test(ran) && /\bto\s+activate\b|\bactivate\s*'/.test(ran)) {
        const said = event.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
        return {
          content: [
            {
              type: 'text',
              text:
                `${said}\n\n[That reported success and changed nothing. macOS refuses ` +
                `cross-app activation from a background process, and Bobble runs in the ` +
                `background on purpose — the user's screen is theirs. You do NOT need the app ` +
                `to be frontmost: ${drivingHowTo()} reads it, and the click/type commands act ` +
                `on it, all while it stays in the background. Stop trying to focus it.]`,
            },
          ],
        };
      }
    }
    /*
     * A PATH THAT IS A COMMAND LINE.
     *
     * MEASURED, MiniCPM5: `read { path: "read --help" }`, four times, plus the
     * URL it wanted and the working directory. The tool answered each with
     * ENOENT and the path helpfully joined onto the workspace, which reads as
     * "that file is missing" — so the model kept trying different files. It was
     * not asking for a file at all; it was asking the read TOOL for its usage,
     * in the only syntax it had seen work elsewhere.
     *
     * Say which of the two things it is holding. Cheap to detect: a real path
     * does not contain " --", and a real path is not the name of a command.
     */
    if (FILE_TOOLS.has(event.toolName) && event.isError === true) {
      const target = (event.input as { path?: unknown })?.path;
      const p = typeof target === 'string' ? target.trim() : '';
      const looksLikeCommand =
        p !== '' && (/\s--\w/.test(p) || /^(?:read|write|edit|mac|chrome|browser|media)\b/.test(p));
      if (looksLikeCommand) {
        const said = event.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
        return {
          content: [
            {
              type: 'text',
              text:
                `${said}\n\n[That is a command line, not a path. \`${event.toolName}\` is a TOOL: ` +
                `give it a real file path and nothing else. For usage of a COMMAND, run ` +
                `\`<command> --help\` in bash — \`mac\`, \`chrome\`, \`browser\` and \`media\` are ` +
                `commands; \`read\`, \`write\` and \`edit\` are not.]`,
            },
          ],
        };
      }
    }
    if (event.toolName === 'bash' && cliImages.length > 0) {
      const attached = cliImages.map((c) => ({
        type: 'image' as const,
        data: c.data ?? '',
        mimeType: c.mimeType ?? 'image/png',
      }));
      cliImages = [];
      return { content: [...event.content, ...attached] };
    }
    /*
     * THE SAME CALL, MADE AGAIN, WITH THE SAME ANSWER.
     *
     * The loop detector counts to 75, which is right for circling a task and
     * far too patient for one call repeated verbatim. MEASURED on three runs
     * here: twelve `edit` calls returning the same "File not found", then twelve
     * `write` calls all REPORTING SUCCESS on the same thirteen bytes. Nothing
     * failed, so nothing complained, and the run spent its budget writing one
     * file over and over. See ./loop/same-call.ts.
     */
    const sameNote =
      lastCallInput !== null && lastCallInput.tool === event.toolName
        ? noteRepeatedCall(
            sameCall,
            event.toolName,
            lastCallInput.input,
            event.content
              .map((p) => (p.type === 'text' ? p.text : ''))
              .join('')
              .slice(0, 4000),
          )
        : null;
    if (sameNote !== null) {
      const withNote = event.content.map((part, i) =>
        i === 0 && part.type === 'text' ? { ...part, text: `${part.text}${sameNote}` } : part,
      );
      return {
        content:
          withNote.length > 0 ? withNote : [{ type: 'text' as const, text: sameNote.trimStart() }],
      };
    }
    // The open-an-app note rides on the bash result that caused it (the user: give it
    // the tools and the snapshot immediately, rather than leaving it to guess).
    if (event.toolName === 'bash' && lastOpened !== undefined) {
      const opened = lastOpened;
      lastOpened = undefined;
      /*
       * DO NOT CONTRADICT THE SHIM.
       *
       * In CLI mode the `open` wrapper INTERCEPTS a bare URL and navigates the
       * app's own browser itself, then prints the browser commands. The stray-
       * web-page note below was written for the world where that did not happen,
       * and still fired — so one bash result carried both "Opening it in the app
       * own browser instead" and "This opened your default browser — NOT the
       * built-in browser ... Do that now rather than trying to control what just
       * opened."
       *
       * MEASURED, MiniCPM5: it believed the second one, said so in its own words
       * ("The page opened in the default browser, but I need to use the browser
       * tool"), and spent calls re-navigating a page it already had. A harness
       * that tells a model it failed at the thing it just did is worse than one
       * that says nothing.
       */
      /*
       * AND DO NOT CLAIM WHAT DID NOT HAPPEN. The note describes the command's
       * SHAPE; whether anything opened is in the RESULT. MEASURED in the canvas
       * assessment: the wrapper blocked `open ./media/mug.png` (exit 1, "nothing
       * was opened"), consent for Preview was declined, the file in one case did
       * not even exist — and this note still said "[This opened Preview…]". The
       * model believed the note over the result and told the user "all three
       * files have been successfully opened in their respective apps".
       */
      const resultText = event.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      if (openDidNotHappen(resultText)) return undefined;
      if (opened.strayWebPage !== true || !toolCliMode) {
        const note = openedAppNote(opened, cliCommandForTool);
        const withNote = event.content.map((part, i) =>
          i === 0 && part.type === 'text' ? { ...part, text: `${part.text}${note}` } : part,
        );
        const content =
          withNote.length > 0 ? withNote : [{ type: 'text' as const, text: note.trimStart() }];
        return { content };
      }
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
    /*
     * A WEB TOOL THAT FAILED BECAUSE THERE IS NO NETWORK SAYS SO, ONCE.
     *
     * The raw failure is `TypeError: fetch failed` — which reads, to a model, as
     * something worth retrying. It retried; the user watched it loop. The note names
     * the real situation and says what to do instead, and the same failure pulls
     * the tools out of the advertised set (see applyPreset) so the retry it might
     * still want is not available to make.
     */
    if (NETWORK_TOOLS.has(event.toolName)) {
      const text = event.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
      if (offline.note(event.toolName, event.isError === true, text)) {
        return {
          content: event.content.map((part, i) =>
            i === 0 && part.type === 'text'
              ? { ...part, text: `${part.text}\n\n${OFFLINE_TOOL_NOTE}` }
              : part,
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
    description: 'Configure the harness: set-mode, effort, status, restore.',
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

        /*
         * `/harness restore <path>` — put one file back the way this turn found
         * it.
         *
         * A command rather than a tool: this is the USER undoing the model, and
         * a tool would let the model undo itself, which is the opposite of a
         * safety net.
         */
        case 'restore': {
          const target = rest.trim();
          if (target === '') {
            ctx.ui.notify(
              runtime.checkpoints.length === 0
                ? 'This turn changed no files.'
                : `This turn changed:\n${runtime.checkpoints
                    .map((c) => `  ${c.target}${c.backup === null ? ' (new)' : ''}`)
                    .join('\n')}\n\nRestore one with: /harness restore <path>`,
            );
            return;
          }
          const cp = runtime.checkpoints.find((c) => c.target === target);
          if (cp === undefined) {
            ctx.ui.notify(`No checkpoint for ${target} in this turn.`, 'warning');
            return;
          }
          const res = restore(cp);
          ctx.ui.notify(
            res.ok
              ? cp.backup === null
                ? `Deleted ${target} — this turn created it.`
                : `Restored ${target}.`
              : `Could not restore ${target}: ${res.error ?? 'unknown reason'}`,
            res.ok ? 'info' : 'warning',
          );
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
          applyPreset(ctx);
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
          // …and a branch of this conversation keeps it (ForkCarry).
          rememberForFork();
          /*
           * AND THE OTHER EXTENSIONS LEARN IT TOO. gen-tools, web-tools and
           * the rest live in this same process and cannot read `runtime`;
           * they resolve a relative path against WORKSPACE_ROOT_ENV, which the
           * app set at spawn — before this chat's folder existed. MEASURED
           * 2026-09-15: "Working folder: …/image-of-a-cow" in the prompt,
           * `--save_to=cow-on-the-moon.png` saved one level up, and the
           * model's `present cow-on-the-moon.png` found nothing. The env is
           * the one channel every extension already reads.
           */
          process.env[WORKSPACE_ROOT_ENV] = dir;
          /* The model learns of the move at its next turn — as a note in the
             conversation, not a rewrite of the frozen prompt (see
             before_agent_start: the prefix the server holds stays reusable). */
          publishStatus(ctx);
          ctx.ui.notify(`workspace → ${dir}`);
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
  inspectModelSize,
  isSmallModel,
  type ModelLike,
  type ModelSizeInfo,
  parseModelParams,
  SMALL_MODEL_THRESHOLD_B,
} from './model/model-size.js';
export {
  isModelTier,
  MODEL_TIERS,
  type ModelTier,
  TIER_LABEL,
} from './model/tier.js';
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
  FORBID_TOOLS_ENV,
  forbiddenReason,
  forbiddenTools,
} from './permissions/forbidden.js';
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
  type ResolvePresetOptions,
  resolveBaseTools,
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
  BOBBLE_3D_READY_ENV,
  GENERATE_3D_TOOL,
  modelToolResult,
  REFINE_3D_TOOL,
  registerModelTools,
} from './tools/model-tools.js';
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
