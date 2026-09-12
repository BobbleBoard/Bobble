/**
 * Renderer-side reader for the harness status the pi extension publishes via
 * `ctx.ui.setStatus('harness', <json>)` and `setStatus('harness-task', '⏱ Xs')`.
 * Those land in the pi-slice `extensionStatus` map (via the event-router); this
 * module parses the JSON blob into the typed {@link HarnessStatus} so the footer
 * status cluster, the checklist panel, and the Agent settings can read the live
 * active-class, running timer, repair counts, and plan.
 *
 * Type-only import from the harness package (erased at build — no runtime pull).
 */
import type { HarnessStage, HarnessStatus, PlanItem, PromoteSignal } from '@pi-desktop/harness';
import { useMemo } from 'react';
import { usePiStore } from '../state/pi-slice';

export type { HarnessStage, HarnessStatus, PlanItem, PromoteSignal };

/** Parse the published harness status JSON, tolerating absence/garbage. */
export function parseHarnessStatus(raw: string | undefined): HarnessStatus | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as HarnessStatus;
  } catch {
    return null;
  }
}

/** Live parsed harness status, or null when the harness hasn't published yet. */
export function useHarnessStatus(): HarnessStatus | null {
  const raw = usePiStore((s) => s.extensionStatus.harness);
  return useMemo(() => parseHarnessStatus(raw), [raw]);
}

/**
 * WHAT THIS PARTICULAR WAIT IS, in words that name its cause.
 *
 * the user, watching a run: the prefill row "initially shows 'working' ... staying
 * at 0% for 14 seconds", and later a ten-second gap ends with "of all things
 * 'processing the prompt'" when what was actually happening was a toolset being
 * switched on. "this initial one i'd like to say 'starting up' or something
 * like that if it's the first message or 'loading model' or changing between
 * the two accurately."
 *
 * So the label is chosen by cause, most specific first: a model that is still
 * loading, then a capability whose tools just arrived (turning them on
 * re-ingests the whole prompt, which IS this wait), then the first prefill of a
 * session, and only then the generic mechanism.
 */
export function prefillLabel(inp: {
  readonly modelPhase?: string | null;
  /** The chat server is parked to make room for a generation (LlmStatus.parked). */
  readonly parked?: boolean;
  readonly loadingCapability?: string | null;
  readonly firstOfSession?: boolean;
  /** What to say when the wait is just the prompt — the caller's own wording,
   * because the thread says "Reading your conversation" (a name the tester
   * earned) and the chain says something shorter. */
  readonly generic?: string;
}): string {
  // The most specific cause first. A model stopped on purpose for a picture
  // is not "loading" — it is making room, and comes back when the picture does.
  if (inp.parked === true) return 'Making room for a generation';
  const phase = inp.modelPhase ?? null;
  if (phase !== null && phase !== 'ready' && phase !== 'idle') return 'Loading model';
  const cap = inp.loadingCapability ?? null;
  if (cap !== null && cap !== '') return `Loading ${CAPABILITY_LABEL[cap] ?? cap} tools`;
  if (inp.firstOfSession === true) return 'Starting up';
  /* the user: "change 'processing the prompt' to just 'Processing'". The long
     form named the mechanism; by the time a person reads it they only want to
     know the machine is busy. */
  return inp.generic ?? 'Processing';
}

/** Human label for a task class (falls back to the raw id, dashes → spaces). */
export function classLabel(cls: string | null | undefined): string | null {
  if (cls === null || cls === undefined) return null;
  return cls.replace(/-/g, ' ');
}

/**
 * The pi status key the host publishes prefill progress under while llama-server
 * is still ingesting a big prompt (before the first token). The value is a
 * percent string ("0".."100"); absent/cleared once the first token streams. Read
 * off the same generic `extensionStatus` channel the harness uses for everything
 * else, so no engine/store plumbing is required. Prefixed `harness` so a session
 * switch drops it with the rest of the harness panels (see pi-slice
 * `setMessagesExternal`). Source: provider-llamacpp's `prompt_progress` frames
 * (`return_progress`), forwarded by the inference lane exactly like TPS.
 */
export const PREFILL_STATUS_KEY = 'harness-prefill';

/**
 * Whether the system-prompt prefix is RESIDENT yet: `'warming'` while the
 * warm-up runs, `'ready'` once it has finished (or failed — a failed warm-up
 * must still release the UI).
 *
 * "Loading model" waits for this, because the label's real promise is "the next
 * message is instant", and llama-server answering is only half of that. Declared
 * here rather than imported from the harness barrel, which drags node-only deps
 * into the renderer bundle (see auto-router.ts); a test pins the two strings
 * together so they cannot drift apart silently.
 */
export const PREFIX_WARM_STATUS = 'harness-prefix-warm';

/**
 * Should the "Loading model" label still be showing?
 *
 * True while the server is coming up, AND while it is up but the system-prompt
 * prefix is not yet resident — because the label's real promise is "the next
 * message is instant", and llama-server answering is only half of that. the user:
 * "when that finishes, I want any prompt I send in to be instantaneous… the
 * instant 'loading model' disappears."
 *
 * Only extends the label when we have actually SEEN `'warming'`. A build with no
 * harness warm-up never publishes the key, and must behave exactly as before
 * rather than wait forever on a signal that is never coming — the same reason
 * the harness releases the label in `finally` rather than `then`.
 */
export type ReadyStage = 'loading' | 'preparing' | null;

/**
 * WHICH of the two waits this is — because they are not the same wait, and
 * calling them both "Loading model" was a lie the user could see through.
 *
 * `loading`   llama-server is coming up and reading weights off disk.
 * `preparing` the model is UP and the system prompt + tools are being prefilled.
 *
 * The second is the longer of the two and used to wear the first one's label.
 * MEASURED on a cold start: the model was ready at 6.4s and the screen still
 * read "loading model · 18.6s" while it was already generating an answer. The
 * hold itself is right — the label's promise is "when this goes, a message is
 * instant", and `phase === 'ready'` arrives seconds before that is true — so the
 * fix is the words, not the timing.
 */
export function modelReadyStage(phase: string, prefixWarm: string | undefined): ReadyStage {
  if (phase === 'starting') return 'loading';
  return phase === 'ready' && prefixWarm === 'warming' ? 'preparing' : null;
}

/** Whether either wait is in progress. Kept as the boolean the call sites that
 * only need "is the model not ready yet" already ask for. */
export function showLoadingModel(phase: string, prefixWarm: string | undefined): boolean {
  return modelReadyStage(phase, prefixWarm) !== null;
}

/**
 * The pi status key the harness publishes a corp-promotion intent on when the
 * model calls `create_production_hierarchy` in normal chat (offered only at
 * high/max effort). The value is a JSON {@link PromoteSignal}; ChatApp watches it
 * and launches the corp run with the user's original prompt. Prefixed `harness`
 * so a session switch drops it with the rest of the harness panels. MUST equal
 * the harness's `PROMOTE_STATUS_KEY`.
 */
export const PROMOTE_STATUS_KEY = 'harness-promote';

/** Parse the promote-intent JSON, tolerating absence/garbage; requires an `id`. */
export function parsePromoteSignal(raw: string | undefined): PromoteSignal | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as PromoteSignal;
    return typeof parsed?.id === 'string' && parsed.id.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse the prefill percent published under {@link PREFILL_STATUS_KEY} into a
 * 0..100 number, or null when absent/garbled/complete. `>= 100` collapses to
 * null (prefill is done — hand off to Thinking/Working). Pure + node-testable.
 */
export function parsePrefillPercent(raw: string | undefined): number | null {
  if (raw === undefined || raw.length === 0) return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0) return null;
  return pct >= 100 ? null : pct;
}

/** Presentational view of the harness lifecycle {@link HarnessStage}. */
export interface StageDisplay {
  /** Short verb label the footer renders, e.g. "Classifying". */
  readonly label: string;
  /**
   * Whether the stage is still in flight (`Classifying…`, subtle live tone) vs a
   * terminal one (`Done`). Drives the trailing ellipsis and the success tint.
   */
  readonly live: boolean;
}

/**
 * The user-facing verb for each stage the harness publishes. `idle` maps to
 * `null` (nothing to surface — hide the label). The keys are exhaustive over
 * {@link HarnessStage} so a newly added stage is a compile error until it gets a
 * label here — we never render a raw enum value, and never invent a stage the
 * harness doesn't publish.
 */
const STAGE_LABELS: Record<HarnessStage, string | null> = {
  idle: null,
  classifying: 'Classifying',
  working: 'Working',
  repairing: 'Repairing',
  reviewing: 'Reviewing',
  revising: 'Revising',
  verifying: 'Verifying',
  done: 'Done',
};

/**
 * Map a published harness {@link HarnessStage} to its footer display, or `null`
 * when there's nothing to show (idle, absent, or an unknown value from an older /
 * garbled status payload — the lookup tolerates keys outside the enum). Pure, so
 * the mapping is unit-tested without rendering.
 */
export function stageDisplay(stage: HarnessStage | null | undefined): StageDisplay | null {
  if (stage === null || stage === undefined) return null;
  const label = STAGE_LABELS[stage];
  if (label === null || label === undefined) return null;
  return { label, live: stage !== 'done' };
}

/**
 * Stages during which the model is ACTING (touching tools / running an
 * effort/repair pass) rather than reasoning — so the ONE live indicator reads
 * "Working" instead of "Thinking" even when no tool call is momentarily in flight.
 */
const ACTING_STAGES: ReadonlySet<HarnessStage> = new Set<HarnessStage>([
  'working',
  'repairing',
  'reviewing',
  'revising',
  'verifying',
]);

/**
 * The refinement word folded in beside the primary label for the stages that add
 * information the "Thinking/Working" word doesn't already carry. `classifying` is
 * gated to Auto mode (see {@link threadStatusView}); `working`/`done`/`idle` add
 * nothing over the primary word, so they carry no detail.
 */
const STAGE_DETAIL: Partial<Record<HarnessStage, string>> = {
  classifying: 'Classifying',
  repairing: 'Repairing',
  reviewing: 'Reviewing',
  revising: 'Revising',
  verifying: 'Verifying',
};

/** Inputs to {@link threadStatusView} (mirrors the live pi/settings/switching state). */
export interface ThreadStatusInputs {
  /** Whether a turn is actively streaming (pi-slice `agent.isStreaming`). */
  readonly isStreaming: boolean;
  /** The retry banner state, or null. */
  readonly retry: { attempt: number; maxAttempts: number } | null;
  /** Whether any tool call is currently executing (`runningToolCalls.length > 0`). */
  readonly toolRunning: boolean;
  /** The harness lifecycle stage, or null when the harness hasn't published. */
  readonly stage: HarnessStage | null | undefined;
  /** Whether the model selection is Auto (gates the "Classifying" detail — #5). */
  readonly isAuto: boolean;
  /**
   * The friendly tier label of an in-flight model switch (pre-stream llama
   * restart), or null. Surfaced ONLY when not yet streaming, so the single
   * indicator also covers the seconds-long model swap the footer no longer shows.
   */
  readonly switchingToTier: string | null;
  /**
   * Prefill progress percent (0..99) while the local server is still ingesting
   * the prompt before the first token, or null when not prefilling / done. When
   * present it PRECEDES Thinking/Working — a big prompt on a cold cache can take
   * seconds, and this fills that otherwise-silent gap with "Processing N%".
   */
  readonly promptProgress: number | null;
  /**
   * The capability whose tools were just switched on, or null.
   *
   * It explains the prefill happening right now: tool schemas render at the
   * front of the prompt, so turning a group on re-ingests the whole
   * conversation. Naming it turns an unexplained wait into a sentence.
   */
  readonly loadingCapability?: string | null;
}

/** The single consolidated thread indicator's rendered view, or null when idle. */
export interface ThreadStatusView {
  /** The primary status word ("Processing" / "Thinking" / "Working" / "Retrying
   * (n/m)…" / "Switching…"). */
  readonly label: string;
  /** A subtle, static folded stage word, or undefined. */
  readonly detail?: string;
  /** Whether to render the elapsed "· Ns" counter (off during a pre-stream switch). */
  readonly showElapsed: boolean;
  /** The capability being loaded, when that is what this wait is — so the ring
   * can wear its colour and glyph rather than the generic one. */
  readonly capability?: string;
}

/**
 * How a capability is NAMED to a person, and what colour it wears.
 *
 * The harness's own names are slugs ("web-research", "computer-use"); a status
 * line reading "Loading computer-use" is a machine talking. The colours are the
 * ones the tool chips already use for the same kinds of work, so the ring in the
 * thread and the chips below it are plainly about the same thing.
 */
export const CAPABILITY_LABEL: Record<string, string> = {
  browser: 'the browser',
  'computer-use': 'computer use',
  personal: 'your calendar & mail',
  'web-research': 'web research',
  generation: 'media generation',
  connectors: 'connectors',
};

/**
 * The ONE live status indicator (the user blind-test #1). Reduces the whole
 * status surface — the duplicate thinking/working labels, the footer stage
 * cluster, the switching pill — to a single thread-rendered view that reads
 * "Processing N%" while the server ingests the prompt (prefill), then "Thinking"
 * while the model reasons and "Working" while it acts (a running tool OR an
 * acting harness stage), with the harness lifecycle stage FOLDED IN subtly as a
 * muted detail word. Classification is only surfaced in Auto mode (#5). A
 * pre-stream model switch borrows the same indicator so the swap isn't silent.
 * Returns null when there is nothing to show. Pure + unit-tested.
 */
export function threadStatusView(inp: ThreadStatusInputs): ThreadStatusView | null {
  // Pre-stream model swap (Auto routing / explicit tier pick): the ONE indicator
  // covers it so the footer/bar can stay clean. Only while NOT yet streaming, and
  // it wins over prefill — the swap (llama restart) happens before any ingestion.
  if (!inp.isStreaming && inp.switchingToTier !== null) {
    return { label: `Switching to ${inp.switchingToTier}…`, showElapsed: false };
  }

  // Prefill: the server is ingesting the prompt before the first token. This
  // PRECEDES Thinking/Working (and shows whether or not the turn has flipped to
  // streaming yet) so a long cold-cache prefill isn't a silent dead spot.
  if (inp.promptProgress !== null) {
    const pct = Math.round(Math.max(0, Math.min(99, inp.promptProgress)));
    /*
     * SAY WHY, when there is a why. the user: "when there's a long prefill because a
     * capability is being loaded instead of 'processing' on that turn make the
     * prefill circle show 'loading <capability>'." This IS that prefill — the
     * tools that just arrived are what moved the prompt's prefix — so the wait
     * gets named after its cause rather than its mechanism.
     */
    const cap = inp.loadingCapability ?? null;
    if (cap !== null && cap !== '') {
      return {
        label: `Loading ${CAPABILITY_LABEL[cap] ?? cap}`,
        detail: `${pct}%`,
        showElapsed: true,
        capability: cap,
      };
    }
    return { label: 'Processing', detail: `${pct}%`, showElapsed: true };
  }

  // Idle (not streaming, not switching, not prefilling): nothing to show.
  if (!inp.isStreaming) return null;

  if (inp.retry !== null) {
    return {
      label: `Retrying (${inp.retry.attempt}/${inp.retry.maxAttempts})…`,
      showElapsed: true,
    };
  }

  const stage = inp.stage ?? null;
  const acting = inp.toolRunning || (stage !== null && ACTING_STAGES.has(stage));
  const label = acting ? 'Working' : 'Thinking';

  // Fold the stage in subtly. "Classifying" only in Auto — a pinned tier never
  // classifies for routing, so surfacing it there would be wrong (#5).
  let detail = stage !== null ? STAGE_DETAIL[stage] : undefined;
  if (stage === 'classifying' && !inp.isAuto) detail = undefined;

  return { label, detail, showElapsed: true };
}

/**
 * Should the "processing" ring show at all?
 *
 * THE BUG: the user opened Bobble, clicked around, and got "processing · 7.2s" on
 * an empty thread — permanently, with nothing sent. `promptInFlight` is raised
 * by the dispatch bridge and cleared by agent_start/agent_end, and the model
 * warm-up on model_select raises it while producing NEITHER, so the flag never
 * came down.
 *
 * A turn the user never started cannot be in progress. Requiring a user message
 * makes that structurally true rather than trusting a flag with a path that
 * never clears. Pure so it can be tested without a renderer.
 */
export function showProcessing(input: {
  readonly hasUserMessage: boolean;
  readonly promptInFlight: boolean;
  readonly hasStreamingAssistant: boolean;
  readonly turnHasContent: boolean;
}): boolean {
  if (!input.hasUserMessage) return false;
  return input.promptInFlight || (input.hasStreamingAssistant && !input.turnHasContent);
}
