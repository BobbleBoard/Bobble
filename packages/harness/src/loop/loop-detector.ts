/**
 * Per-turn loop / no-progress detector (harness fix #3).
 *
 * Rung-5 abort (repair/rungs.ts) only fires on ARG-repair failures — malformed
 * tool-call JSON. A model that emits WELL-FORMED tool calls but keeps calling the
 * SAME thing, or keeps hitting tool-execution ERRORS, was never caught, and there
 * was no max-iteration cap anywhere. This detector closes both gaps:
 *
 *   - identical-call streak: N consecutive tool calls with the same name + args
 *     (a stable signature) → one corrective steer. The user set N to 75: a model
 *     that calls the same thing three times is usually retrying, not stuck, and
 *     the yellow "nudging" bar firing that early was noise on real work.
 *   - consecutive-error streak: N consecutive tool executions that ERROR → same
 *     escalation (steer once, then abort).
 *   - unproductive-wandering cap: N consecutive READ-ONLY / exploration calls
 *     (read/ls/find/grep/tool_search/update_plan) with NO concrete action in
 *     between — the failure the signature streak MISSES, because reading ten
 *     DIFFERENT files is ten different signatures. One "you've explored enough,
 *     act now" steer, then abort past a higher, effort-scaled threshold.
 * There is NO per-turn tool-call cap. The user: "remove the tool call cap." A cap
 * cannot tell a long job from a stuck one — it only ever fires on the long job,
 * because a genuinely stuck turn trips the repeat guard or its wall clock first.
 * `maxSteps` survives as an explicit opt-in for tests (and mirrors the mesh's
 * `maxStepsPerMessage`); nothing in the live harness sets it.
 *
 * It is a pure state machine: the wiring (index.ts) feeds it the `tool_call` and
 * `tool_execution_end` events and acts on the returned {@link LoopSignal} (send a
 * steer / call ctx.abort). Reset per user turn. Fully unit-testable without a live
 * session — see loop-detector.test.ts.
 */

import type { EffortKnobs } from '../effort/effort.js';

/** Why the detector escalated. */
export type LoopCause = 'identical' | 'error' | 'cap' | 'wander' | 'repeat-text';

/** The action the wiring should take after feeding an event. */
export type LoopSignal =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'steer';
      readonly cause: LoopCause;
      readonly reason: string;
      readonly message: string;
    }
  | { readonly kind: 'abort'; readonly cause: LoopCause; readonly reason: string };

const NONE: LoopSignal = { kind: 'none' };

/** The one steer for a prose loop: name it and demand the next concrete act. */
const REPEAT_TEXT_STEER =
  'You have written the same sentence several times in a row. Saying it again ' +
  'will not move it forward. Do the next CONCRETE thing instead — make the tool ' +
  'call, write the file, or say plainly that you are stuck and why.';

/** Thresholds driving the detector. `abortAfter` must be > `steerAfter`. */
export interface LoopDetectorConfig {
  /** Consecutive tool ERRORS that fire the single corrective steer. */
  readonly steerAfter: number;
  /**
   * Consecutive IDENTICAL calls (same name + args) that fire the repeat guard's
   * steer — the yellow "nudging" bar. Omitted → {@link DEFAULT_REPEAT_STEER_AFTER}.
   */
  readonly repeatSteerAfter?: number;
  /** Consecutive ERRORS that fire the abort. (The identical-call abort is now
   * WALL-CLOCK — see {@link repeatWallMs} — not this count, per the user: a genuine
   * loop is "the same call still repeating minutes later", and a fast burst of a
   * few identical calls is not yet a loop.) */
  readonly abortAfter: number;
  /**
   * Wall-clock window (ms) for the identical-call abort: the SAME tool call
   * (name + args) must keep repeating for at least this long before it aborts.
   * Reading DIFFERENT files never trips this (each is a distinct signature that
   * restarts the streak + its clock). Omitted → {@link DEFAULT_REPEAT_WALL_MS}.
   */
  readonly repeatWallMs?: number;
  /** Clock source (injectable for tests). Omitted → {@link Date.now}. */
  readonly now?: () => number;
  /**
   * OPT-IN per-turn tool-call cap. Omitted (the live harness always omits it) →
   * no cap at all, per the user. Left in the type so a test can still build one.
   */
  readonly maxSteps?: number;
  /**
   * Consecutive read-only/exploration calls (no concrete action between them)
   * that fire the single "act now" steer. Omitted → {@link DEFAULT_WANDER_STEER_AFTER}.
   */
  readonly wanderSteerAfter?: number;
  /**
   * Consecutive read-only/exploration calls that abort the turn. Must be >
   * `wanderSteerAfter`. Omitted → {@link DEFAULT_WANDER_ABORT_AFTER}.
   */
  readonly wanderAbortAfter?: number;
  /** Rolling recent-signature window kept for telemetry/introspection. Default 8. */
  readonly windowSize?: number;
}

/**
 * Default ERROR-streak thresholds (kept constant across effort — a loop is a loop).
 *
 * The user raised these to 75 for the same reason the user raised the repeat guard: three
 * consecutive tool errors is a model learning a CLI's argument shape, not a
 * loop. He watched it fire on exactly that — three `mac launch` calls in a row
 * that failed on syntax, then a yellow bar in the middle of the reply — and
 * said "after 75 not 3". The wall clock still catches a genuinely stuck turn
 * long before the count gets there.
 */
export const DEFAULT_LOOP_STEER_AFTER = 75;
export const DEFAULT_LOOP_ABORT_AFTER = 100;
/**
 * Repeat guard: consecutive IDENTICAL calls before the one "you're repeating
 * yourself" steer. The user raised this from 5 to 75. Three identical calls is a
 * retry; seventy-five is a loop — and the wall clock below still catches a slow
 * one long before the count gets there.
 */
export const DEFAULT_REPEAT_STEER_AFTER = 75;
/** Wall-clock window for the identical-call abort (the user): the SAME call must keep
 * repeating for 3 minutes before it's treated as a stuck loop and aborted. */
export const DEFAULT_REPEAT_WALL_MS = 3 * 60 * 1000;
/** The small-cycle abort: at least this many calls inside the wall-clock window… */
export const CYCLE_MIN_CALLS = 12;
/** …made up of no more than this many distinct calls. */
export const CYCLE_DISTINCT = 3;

/**
 * Default unproductive-wandering thresholds, used when a {@link LoopDetectorConfig}
 * omits them. The live harness always supplies effort-scaled values via
 * {@link loopDetectorConfig}; these are the fallback for hand-built configs/tests.
 */
export const DEFAULT_WANDER_STEER_AFTER = 6;
export const DEFAULT_WANDER_ABORT_AFTER = 10;

/**
 * Read-only / exploration tools that, on their own, make NO durable progress:
 * reading a file, listing/finding/grepping the filesystem, searching for a tool,
 * or (re)writing the plan. A run built ONLY from these — however many DIFFERENT
 * files it reads — is wandering, not working, and the signature streak can't see
 * it (each read is a distinct signature). Every tool NOT in this set counts as a
 * concrete ACTION (write/edit/bash/answer/a real connector or generation call)
 * that resets the unproductive streak. Kept deliberately narrow: only tools that
 * are unambiguously read-only local exploration. `web_search`/`web_fetch` are
 * intentionally EXCLUDED — for a research task they ARE the work.
 */
export const EXPLORATION_TOOLS: ReadonlySet<string> = new Set<string>([
  'read',
  'read_file',
  'ls',
  'list',
  'list_dir',
  'list_directory',
  'find',
  'glob',
  'grep',
  'tool_search',
  'update_plan',
]);

/**
 * Shell commands that are read-only exploration, by the name they are run under.
 *
 * The point of this list is the bash-CLI tool interface, where EVERY call is
 * `bash` and the tool name says nothing at all about what the turn is doing.
 */
const EXPLORATION_COMMANDS: ReadonlySet<string> = new Set<string>([
  'ls',
  'cat',
  'head',
  'tail',
  'find',
  'grep',
  'rg',
  'wc',
  'file',
  'stat',
  'tree',
  'pwd',
  'which',
  'tools',
]);

/**
 * True when a tool call is pure read-only exploration.
 *
 * IN BASH-CLI MODE THE TOOL NAME IS ALWAYS `bash`, which is not in
 * {@link EXPLORATION_TOOLS} — so every call RESET the unproductive streak and
 * the wander guard could never fire. `tools`, `media --help`, `ls`, repeated
 * until the step cap, looked like productive work to the detector because each
 * one arrived under the name of a tool that usually does something.
 *
 * So a bash call is classified by its command instead: the first bare word, or
 * anything asking for `--help`, which is discovery by definition.
 */
export function isExplorationTool(toolName: string, args?: unknown): boolean {
  if (EXPLORATION_TOOLS.has(toolName)) return true;
  if (toolName !== 'bash') return false;
  const command = (args as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (/(^|\s)(--help|-h)(\s|$)/.test(trimmed)) return true;
  const head = trimmed.split(/[\s;|&]+/)[0] ?? '';
  return EXPLORATION_COMMANDS.has(head.split('/').pop() ?? head);
}

/**
 * Build a detector config from the effort knobs: the identical/error streak
 * thresholds are fixed (a 3-in-a-row repeat is a loop regardless of effort),
 * while the hard step cap AND the unproductive-wandering thresholds scale with
 * effort (a "max" run may gather more context / grind far longer than a "low" one).
 */
export function loopDetectorConfig(knobs: EffortKnobs): LoopDetectorConfig {
  return {
    steerAfter: DEFAULT_LOOP_STEER_AFTER,
    abortAfter: DEFAULT_LOOP_ABORT_AFTER,
    repeatSteerAfter: DEFAULT_REPEAT_STEER_AFTER,
    // No `maxSteps`: there is no per-turn tool-call cap (the user).
    wanderSteerAfter: knobs.wanderSteerAfter,
    wanderAbortAfter: knobs.wanderAbortAfter,
  };
}

/** A live, per-turn snapshot for telemetry / tests. */
export interface LoopSnapshot {
  readonly steps: number;
  readonly identicalStreak: number;
  readonly errorStreak: number;
  /** Consecutive read-only/exploration calls since the last concrete action. */
  readonly unproductiveStreak: number;
  readonly steered: boolean;
  readonly lastSignature: string | null;
  readonly recent: readonly string[];
}

/** Deterministic stringify: sorts object keys so key order can't change the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit hash → short hex. Keeps signatures compact for large args. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable signature of a tool call: name + a hash of its (key-order-independent) args. */
export function toolCallSignature(toolName: string, args: unknown): string {
  return `${toolName}#${hashString(stableStringify(args ?? null))}`;
}

const STEER_IDENTICAL =
  "You've called the same tool with the same arguments several times in a row without making progress. Stop repeating that call — try a different approach, different arguments, or a different tool. If you're stuck, say so or ask the user.";
const STEER_ERROR =
  'Your last several tool calls all failed with errors. Stop and reconsider before trying again — a different approach or a different tool is likely needed, or you may need to ask the user for help.';
const STEER_WANDER =
  "You've spent several tool calls only reading, listing, and searching — you haven't taken any concrete action yet. You've explored enough. Do the task NOW: if it asks you to write or create something, write the file with your write tool; if it needs a specific capability (calendar, mail, etc.), call that tool directly. Stop reading more files and act.";

/**
 * The per-turn loop detector. Create one per user turn (or call {@link reset}).
 * Feed it every tool call and every tool-execution outcome; act on the signal.
 */
export interface LoopDetector {
  /**
   * Record a tool call BEFORE it executes (hook `tool_call`). Counts a step
   * against the hard cap and tracks the identical-call streak.
   */
  onToolCall(toolName: string, args: unknown): LoopSignal;
  /**
   * Record a tool-execution outcome AFTER it runs (hook `tool_execution_end`).
   * Tracks the consecutive-error streak.
   */
  onToolResult(isError: boolean): LoopSignal;
  /**
   * Record a settled line of ASSISTANT TEXT. Catches the loop no tool-call
   * counter can see — see {@link createLoopDetector}'s textStreak.
   */
  onText(line: string): LoopSignal;
  /** Clear all per-turn state (call at the start of each user turn). */
  reset(): void;
  /** Introspection for telemetry / tests. */
  snapshot(): LoopSnapshot;
}

/** Human-readable escalation reason per cause (differs slightly steer vs abort). */
function reasonFor(cause: LoopCause, streak: number, aborting: boolean): string {
  switch (cause) {
    case 'repeat-text':
      return aborting
        ? `writing the same sentence over and over (${streak}×) instead of acting`
        : `repeating itself (${streak}×)`;
    case 'identical':
      return aborting
        ? `stuck repeating the same tool call for minutes without progress (${streak}×)`
        : `same tool call repeated ${streak}×`;
    case 'error':
      return aborting
        ? `${streak} consecutive tool executions failed`
        : `${streak} consecutive tool errors`;
    case 'wander':
      return aborting
        ? `explored ${streak} read-only calls in a row without taking a concrete action`
        : `${streak} read-only/exploration calls with no concrete action yet`;
    case 'cap':
      return `exceeded the per-turn tool-call cap`;
  }
}

export function createLoopDetector(config: LoopDetectorConfig): LoopDetector {
  const windowSize = Math.max(1, config.windowSize ?? 8);
  const wanderSteerAfter = config.wanderSteerAfter ?? DEFAULT_WANDER_STEER_AFTER;
  const repeatSteerAfter = config.repeatSteerAfter ?? DEFAULT_REPEAT_STEER_AFTER;
  // Absent → no cap. `Infinity` makes the comparison below a no-op rather than
  // a branch we have to remember to guard at every call site.
  const maxSteps = config.maxSteps ?? Number.POSITIVE_INFINITY;
  const repeatWallMs = config.repeatWallMs ?? DEFAULT_REPEAT_WALL_MS;
  const now = config.now ?? Date.now;
  let steps = 0;
  let identicalStreak = 0;
  // Wall-clock start of the CURRENT identical-call streak (reset whenever the
  // signature changes — a different tool OR different args, e.g. reading a
  // different file, starts a fresh streak + clock).
  let identicalStreakStart = now();
  let errorStreak = 0;
  /*
   * REPEATED TEXT. The user watched a turn emit "Actually, I'll just present the
   * app.py." roughly forty times in a row, and nothing stopped it: every counter
   * here watches TOOL CALLS, and that loop made none. A model can stall entirely
   * in prose, which is both the most visible failure to a user and the one the
   * harness was blind to.
   *
   * Compared on a normalised line so trivial drift does not reset the streak —
   * the observed loop varied ("I'll just", "I_ll just", "!ll just") as sampling
   * jittered around the same sentence.
   */
  let textStreak = 0;
  let lastText: string | null = null;
  // Consecutive read-only/exploration calls since the last concrete action.
  let unproductiveStreak = 0;
  // Exactly ONE corrective steer per turn (across ALL streak causes), matching
  // "inject ONE corrective steer … and, if it continues, abort".
  let steered = false;
  let lastSignature: string | null = null;
  const recent: string[] = [];
  /*
   * A SMALL CYCLE IS THE SAME STALL. The identical-call clock restarts on any
   * different signature, so a model alternating between two writes and a
   * read never trips it: MEASURED on a 4B, 179 calls in twelve minutes —
   * 150 of one `write`, a dozen of one `read`, a few of a second `write` —
   * and the turn ran to its cap. Every call in the last window is kept with
   * its time; when the window holds many calls and only a few distinct ones
   * for the whole wall-clock period, the model is going round, whatever the
   * order. Assumes nothing about the task: reading twelve different files is
   * twelve signatures, and never looks like this.
   */
  const timed: { sig: string; t: number }[] = [];

  /** Escalate a streak to steer/abort, honoring the one-steer-per-turn rule. */
  function escalate(
    streak: number,
    cause: LoopCause,
    message: string,
    steerAfter: number,
    abortAfter: number,
  ): LoopSignal {
    if (streak >= abortAfter) {
      return { kind: 'abort', cause, reason: reasonFor(cause, streak, true) };
    }
    if (streak >= steerAfter && !steered) {
      steered = true;
      return { kind: 'steer', cause, reason: reasonFor(cause, streak, false), message };
    }
    return NONE;
  }

  return {
    onToolCall(toolName, args) {
      steps += 1;
      const t = now();
      const sig = toolCallSignature(toolName, args);
      if (sig === lastSignature) {
        identicalStreak += 1;
      } else {
        // A different tool OR different args (e.g. a DIFFERENT file read) starts a
        // fresh streak AND restarts its wall clock — so productive exploration
        // across many files never trips the repeat guard (the user).
        identicalStreak = 1;
        identicalStreakStart = t;
      }
      lastSignature = sig;
      recent.push(sig);
      if (recent.length > windowSize) recent.shift();
      timed.push({ sig, t });
      if (timed.length > 400) timed.shift();

      // Productivity tracking: a read-only/exploration call climbs the streak; any
      // concrete action (write/edit/bash/answer/connector/gen call …) resets it.
      unproductiveStreak = isExplorationTool(toolName, args) ? unproductiveStreak + 1 : 0;

      // Only if a caller explicitly opted into a cap (the live harness never does).
      if (steps > maxSteps) {
        return {
          kind: 'abort',
          cause: 'cap',
          reason: `exceeded the per-turn tool-call cap (${maxSteps})`,
        };
      }
      // Identical-call loop (the user): ABORT only once the SAME call (name + args) has
      // been repeating for the wall-clock window — a fast burst of a few identical
      // calls is not yet a stuck loop; a call still repeating minutes later is.
      // This wall clock, not a count, is what actually catches a stuck turn, which
      // is why the count-based steer below can afford to sit all the way at 75.
      if (identicalStreak >= 2 && t - identicalStreakStart >= repeatWallMs) {
        return {
          kind: 'abort',
          cause: 'identical',
          reason: reasonFor('identical', identicalStreak, true),
        };
      }
      // …and the small cycle (see `timed`): the calls of the last wall-clock
      // window, many of them, spanning (nearly) the whole window, and no more
      // than CYCLE_DISTINCT distinct ones among them.
      const inWindow = timed.filter((x) => t - x.t <= repeatWallMs);
      const oldest = inWindow[0];
      if (
        oldest !== undefined &&
        inWindow.length >= CYCLE_MIN_CALLS &&
        t - oldest.t >= repeatWallMs * 0.9
      ) {
        const distinct = new Set(inWindow.map((x) => x.sig)).size;
        if (distinct <= CYCLE_DISTINCT) {
          return {
            kind: 'abort',
            cause: 'identical',
            reason: `stuck cycling between ${distinct} tool calls for minutes without progress (${inWindow.length}× in the window)`,
          };
        }
      }
      if (identicalStreak >= repeatSteerAfter && !steered) {
        steered = true;
        return {
          kind: 'steer',
          cause: 'identical',
          reason: reasonFor('identical', identicalStreak, false),
          message: STEER_IDENTICAL,
        };
      }
      // Unproductive wandering: many DIFFERENT exploration calls with no action.
      // The user: reading different files must NOT abort — so this only ever STEERS
      // (one gentle nudge), never aborts (Infinity abort threshold).
      return escalate(
        unproductiveStreak,
        'wander',
        STEER_WANDER,
        wanderSteerAfter,
        Number.POSITIVE_INFINITY,
      );
    },

    onText(line) {
      const norm = line
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      // Short fragments repeat innocently ("ok", "done", a bare bullet).
      if (norm.length < 12) return NONE;
      if (norm === lastText) textStreak += 1;
      else {
        textStreak = 1;
        lastText = norm;
      }
      // A person notices this by the third or fourth repeat; steering earlier
      // than a tool loop is right, because there is no work being done at all.
      return escalate(textStreak, 'repeat-text', REPEAT_TEXT_STEER, 4, 8);
    },
    onToolResult(isError) {
      errorStreak = isError ? errorStreak + 1 : 0;
      if (errorStreak === 0) return NONE;
      return escalate(errorStreak, 'error', STEER_ERROR, config.steerAfter, config.abortAfter);
    },

    reset() {
      steps = 0;
      identicalStreak = 0;
      identicalStreakStart = now();
      errorStreak = 0;
      unproductiveStreak = 0;
      steered = false;
      lastSignature = null;
      recent.length = 0;
      textStreak = 0;
      lastText = null;
    },

    snapshot() {
      return {
        steps,
        identicalStreak,
        errorStreak,
        unproductiveStreak,
        steered,
        lastSignature,
        recent: [...recent],
      };
    },
  };
}
