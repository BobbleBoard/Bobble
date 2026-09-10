/**
 * Harness surfacing:
 *
 *  - {@link ThreadStatusIndicator} — the ONE live status indicator (the user
 *    blind-test #1). Rendered in the thread only, it reads "Thinking" while the
 *    model reasons and "Working" while it acts, with the harness lifecycle stage
 *    (classifying/reviewing/verifying/…) folded in subtly as a muted detail word.
 *    It replaces the old trio — the duplicate thread working-label, the composer
 *    footer HarnessStatusCluster, and the "switching…" pill — with a single
 *    element, so there is exactly one place that shows run status.
 *  - {@link HarnessChecklistPanel} — the live task checklist the model maintains
 *    via the `update_plan` tool, pinned above the thread so the user watches items
 *    flip pending → in_progress → done with the TaskChecklist animation.
 */
import {
  ContextGauge,
  TaskChecklist,
  type TaskChecklistItem,
  type TaskState,
  ToolIcon,
} from '@pi-desktop/ui';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
import { useLlmStore } from '../state/llm-store';
import { useModelSelectionStore } from '../state/model-selection-store';
import { usePiStore } from '../state/pi-slice';
import {
  CAPABILITY_LABEL,
  modelReadyStage,
  type PlanItem,
  PREFILL_STATUS_KEY,
  PREFIX_WARM_STATUS,
  parsePrefillPercent,
  prefillLabel,
  showProcessing,
  useHarnessStatus,
} from './harness-status';

/** A plan longer than this starts collapsed so it doesn't crowd the thread. */
const LONG_PLAN_THRESHOLD = 6;

/** Map a plan item's status (+ roadmap flag) to a TaskChecklist state. */
function toTaskState(item: PlanItem): TaskState {
  if (item.roadmap === true && item.status !== 'done') return 'roadmap';
  if (item.status === 'in_progress') return 'in-progress';
  if (item.status === 'done') return 'done';
  return 'pending';
}

/**
 * The processing ring (the user): a context-gauge-style circle that FILLS with the
 * prompt-ingest percent, next to a shimmering "N% processing" label (same sweep
 * as the old working/thinking text). Indeterminate (a soft pulse) while the model
 * loads or before the first prefill frame; the arc fills smoothly as % climbs
 * (the ContextGauge arc already transitions). At 100% it holds full, then the
 * whole thing fades out (see {@link ThreadStatusIndicator}).
 */
function ProcessingRing({
  percent,
  label,
  fading,
  elapsedMs,
  capability,
}: {
  percent: number | null;
  label: string;
  fading: boolean;
  /** When this wait is a capability loading, the capability's name — the ring
   * then wears its colour and glyph instead of the generic arc. */
  capability?: string;
  /** Live elapsed time in the processing phase — a visible prefill/TTFT timer
   * (the user) so the "processing circle" duration is readable, e.g. "45% processing
   * · 2.3s". */
  elapsedMs?: number;
}): ReactElement {
  const value = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100));
  const mark = capability === undefined ? null : CAPABILITY_MARK[capability];
  /* Lowercased because every label here is a fragment of one running phrase —
     "45% processing · 2.3s" reads as a status where "45% Processing" reads as a
     heading. */
  const shown = label.toLowerCase();
  const base = percent === null ? shown : `${Math.round(percent)}% ${shown}`;
  const timer =
    elapsedMs !== undefined && elapsedMs >= 100 ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : '';
  const text = `${base}${timer}`;
  return (
    <div
      className={`pd-processing${fading ? ' pd-processing--fading' : ''}`}
      data-testid="thread-processing"
      data-capability={capability ?? undefined}
      style={
        mark === undefined || mark === null
          ? undefined
          : ({ '--pd-cap-tint': mark.tint } as CSSProperties)
      }
    >
      {mark === undefined || mark === null ? (
        <ContextGauge
          value={value}
          size={15}
          className={`pd-processing-ring${percent === null ? ' pd-processing-ring--indeterminate' : ''}`}
          label={text}
        />
      ) : (
        /* The capability's own glyph inside its own ring. A generic arc for
           "loading computer use" tells you the same nothing the word
           "processing" did; the mark is what makes the wait legible at a
           glance. */
        <span className="pd-processing-cap" aria-label={text}>
          <ContextGauge
            value={value}
            size={19}
            className={`pd-processing-ring pd-processing-ring--cap${
              percent === null ? ' pd-processing-ring--indeterminate' : ''
            }`}
            label={text}
          />
          <span className="pd-processing-cap-glyph" aria-hidden="true">
            <ToolIcon kind={mark.icon} size={10} />
          </span>
        </span>
      )}
      <span className="pd-working-label">{text}</span>
    </div>
  );
}

/**
 * A capability's glyph and tint.
 *
 * Reuses the tool-chip icon vocabulary so the ring in the thread and the tool
 * rows it is about to produce are plainly the same subject; the tints are the
 * app's own status/accent tokens rather than new colours, because a status
 * indicator inventing a palette is how a UI starts looking assembled.
 */
const CAPABILITY_MARK: Record<
  string,
  { icon: Parameters<typeof ToolIcon>[0]['kind']; tint: string }
> = {
  browser: { icon: 'browser-navigate', tint: 'var(--pd-accent-primary)' },
  'computer-use': { icon: 'canvas-open', tint: 'var(--pd-accent-primary)' },
  personal: { icon: 'connector', tint: 'var(--pd-status-info-fg, var(--pd-accent-primary))' },
  'web-research': { icon: 'search', tint: 'var(--pd-status-info-fg, var(--pd-accent-primary))' },
  generation: { icon: 'image', tint: 'var(--pd-status-success-fg, var(--pd-accent-primary))' },
  connectors: { icon: 'connector', tint: 'var(--pd-accent-primary)' },
};

/**
 * The ONE live status indicator. During the PROCESSING phase — from the instant
 * the message is sent (server load / dispatch) through prefill, before the first
 * token — it shows the {@link ProcessingRing}. Once the model starts producing
 * (thinking/tokens stream on their own), the ring fills to 100% and fades. The
 * old "Working · Reviewing · Ns" label is gone (the user) — the streamed content and
 * inline tool rows carry the run from there. Renders nothing when idle.
 */
export function ThreadStatusIndicator(): ReactElement | null {
  const _isStreaming = usePiStore((s) => s.agent.isStreaming);
  const promptInFlight = usePiStore((s) => s.promptInFlight);
  // Prefill progress rides the generic extensionStatus channel (the REAL
  // processed/total the server reports via provider-llamacpp's `prompt_progress`
  // frames) — no fabricated easing; the ring shows exactly what llama reports.
  const prefillRaw = usePiStore((s) => s.extensionStatus[PREFILL_STATUS_KEY]);
  /*
   * "Loading model" covers the server coming up AND the system prompt becoming
   * resident, because those together are what the label implicitly promises: the
   * moment it goes, a message is instant. `phase = 'ready'` fires when
   * llama-server answers, seconds before the prefix is warm, so on its own it
   * cleared the label while a first message still paid the full prefill.
   *
   * Gated on having SEEN 'warming': a build with no harness warm-up never
   * publishes this key, and must behave exactly as it did rather than sit on
   * "Loading model" waiting for a signal that is never coming.
   */
  const prefixWarm = usePiStore((s) => s.extensionStatus[PREFIX_WARM_STATUS]);
  /* Why this prefill is happening, when the harness knows: a capability whose
     tools just landed at the front of the prompt. */
  const harness = useHarnessStatus();
  /* "Starting up" belongs to a session's FIRST reply; after that the model is
     resident and the wait is something else. */
  const firstOfSession = usePiStore(
    (s) => s.messages.filter((m) => m.kind === 'assistant').length <= 1,
  );
  const readyStage = useLlmStore((s) => modelReadyStage(s.status.phase, prefixWarm));
  const serverStarting = readyStage !== null;
  /* The two waits read differently because they ARE different: one is weights
     coming off disk, the other is the prompt being read. Both are the PILL's
     words now (composer-pill.ts) — this component only needs to know that one
     of them is happening, so it can stand down. */
  const prefillPct = parsePrefillPercent(prefillRaw);
  const messages = usePiStore((s) => s.messages);

  // The CURRENT turn's assistant message while it is STILL EMPTY — i.e. the model
  // has started the turn but not yet produced any content (text / thinking / a
  // tool call). This is the "prefill / pre-first-token" window. It self-clears the
  // instant a token lands (the block gains content) OR the turn ends (the message
  // stops streaming), so — unlike keying off `isStreaming`, which stays true
  // through an ask_user pause or a long multi-step turn — it can never stick.
  const streamingAssistant = messages.find((m) => m.kind === 'assistant' && m.isStreaming === true);
  const hasContent = (m: (typeof messages)[number]): boolean =>
    m.kind === 'assistant' &&
    m.blocks.some((b) =>
      b.type === 'text' ? b.text.length > 0 : b.type === 'thinking' ? b.thinking.length > 0 : true,
    );

  // Has THIS turn produced any content since the last user message? Walk back to
  // the user turn; any assistant content in between means we're past the initial
  // prefill. The ring is ONLY the initial prompt-ingest — the re-prefills between
  // tool calls are near-instant (the cache is reused, just the appended tool
  // result), so showing "processing" there is noise (the user).
  let turnHasContent = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.kind === 'user') break;
    if (hasContent(m)) {
      turnHasContent = true;
      break;
    }
  }

  // Processing = the send is dispatching (promptInFlight) OR the turn's assistant
  // exists but the turn hasn't produced ANY content yet (initial prefill only).
  // Both self-clear, so the ring fades on the first token and never shows on the
  // instant tool-call re-prefills. `prefillPct` drives only the displayed number.
  /*
   * NOTHING WAS SENT, SO NOTHING IS PROCESSING. the user: "I just opened bobble,
   * clicked somewhere, there's no send button even visible and it just showed
   * me this as if i sent something, and it's staying here like this
   * permanently."
   *
   * `promptInFlight` is raised by the dispatch bridge, and the model warm-up on
   * model_select goes through it — so a freshly opened app, with an empty
   * thread and nothing typed, sat on "processing · 7.2s" forever: the flag is
   * normally cleared by agent_start/agent_end, and a warm-up produces neither.
   *
   * A turn the user never started cannot be in progress. Requiring a user
   * message in the thread makes that structurally true, rather than trusting a
   * flag that has at least one path which never clears.
   */
  /*
   * ONCE THIS TURN HAS SPOKEN, THE RING DOES NOT COME BACK.
   *
   * MEASURED by the stress probe's flash detector: `[thread-processing]`
   * mounting and unmounting over and over inside a single turn — 3ms, 8ms,
   * 65ms, 119ms, 174ms — each time as a 660x34 band in the thread flow, so
   * everything under it hopped down and back up. Exactly the "button briefly
   * appearing for a few ms pushing something up then pushing everything back
   * down again" the user asked me to hunt.
   *
   * The cause is that `turnHasContent` is recomputed from the CURRENT message
   * list every render, and a multi-step turn keeps returning to a state with no
   * content yet: pi starts a fresh assistant message after each tool result, and
   * for the frames before its first delta the turn looks like it is prefilling
   * again. The ring's own comment already says those re-prefills should not show
   * ("near-instant … showing 'processing' there is noise").
   *
   * So the answer is a latch, not a threshold: the first time a turn produces
   * anything, remember it for the rest of that turn. Keyed on the last USER
   * message, which is what "this turn" means here — a new user message clears it
   * and the ring is allowed again.
   */
  const turnKey = [...messages].reverse().find((m) => m.kind === 'user')?.id ?? '';
  const spoken = useRef({ key: '', yes: false });
  if (spoken.current.key !== turnKey) spoken.current = { key: turnKey, yes: false };
  if (turnHasContent) spoken.current.yes = true;

  const processing = showProcessing({
    hasUserMessage: messages.some((m) => m.kind === 'user'),
    promptInFlight,
    hasStreamingAssistant: streamingAssistant !== undefined,
    turnHasContent: turnHasContent || spoken.current.yes,
  });

  /*
   * COMPACTION IS VISIBLE NOW.
   *
   * `isCompacting` was set by the router from pi's own `compaction_start` /
   * `compaction_end` and read by nothing, so a compaction — a GENERATION that
   * takes 30 to 120 seconds on a local model — looked exactly like a frozen
   * app. It rides the same ring as everything else, with its own label, because
   * a second progress affordance would be a second thing to learn.
   */
  const isCompacting = usePiStore((s) => s.agent.isCompacting);
  /** The live "switching to <model>…" banner state — see below. */
  const switching = useModelSelectionStore((s) => s.switching);

  // Snap to 100% then fade ONLY once the first token lands (processing → false).
  const [fading, setFading] = useState(false);
  const wasProcessing = useRef(false);
  useEffect(() => {
    if (processing) {
      wasProcessing.current = true;
      setFading(false);
      return;
    }
    if (!wasProcessing.current) return;
    wasProcessing.current = false;
    setFading(true);
    const t = setTimeout(() => setFading(false), 450);
    return () => clearTimeout(t);
  }, [processing]);

  // Live elapsed timer for the processing phase (the user): starts when processing
  // begins, ticks every 100ms, and freezes at its final value through the fade so
  // the prefill/TTFT duration stays readable (e.g. "45% processing · 2.3s").
  const [elapsedMs, setElapsedMs] = useState(0);
  const procStart = useRef<number | null>(null);
  // A model swap and a cold server load are timed too: they are the LONGEST
  // waits in the app (tens of seconds), and an unmoving indicator over one of
  // them is what "everything completely stops" looks like from the outside.
  const timing = processing || switching !== null || serverStarting;
  useEffect(() => {
    if (!timing) return undefined;
    procStart.current = performance.now();
    setElapsedMs(0);
    const id = setInterval(() => {
      if (procStart.current !== null) setElapsedMs(performance.now() - procStart.current);
    }, 100);
    return () => clearInterval(id);
  }, [timing]);

  if (isCompacting) {
    // Indeterminate: pi reports no progress through a compaction, and inventing
    // a percentage for it is the "fake %" this ring already refuses elsewhere.
    return <ProcessingRing percent={null} label="Compacting" fading={false} elapsedMs={0} />;
  }
  /*
   * A MODEL SWAP IS WORK, EVEN THOUGH NOBODY SENT ANYTHING.
   *
   * the user: "changing models mid conversation shows no sign of working … no
   * 'switching to <model>', no 'processing… n%', no 'loading model'." Both of
   * those states were already computed and neither could ever reach the screen,
   * because everything below is gated on `processing` — which requires a turn in
   * flight, and a switch is precisely the case where there isn't one. So the
   * ring showed nothing for the ten-to-a-hundred seconds a model takes to load,
   * and the app looked dead. These two checks sit ABOVE that gate.
   */
  if (switching !== null) {
    return (
      <ProcessingRing
        percent={null}
        label={`Switching to ${switching.toName}`}
        fading={false}
        elapsedMs={elapsedMs}
      />
    );
  }
  /*
   * THE TWO READY STATES LEFT THIS INDICATOR — they are the PILL now.
   *
   * the user: "moving to a new chat shows this 'getting ready' thing that I'd like
   * to move to a pill that floats above the input bar." Right: they are not
   * about a turn, they are about whether the app can answer at all, and they
   * belong next to the thing you type into rather than in the middle of a
   * conversation you are reading. See ComposerPill.
   *
   * The rest of this component — thinking, the panel line, compaction, a model
   * swap — still belongs in the thread, because each of those IS about the turn
   * in front of you.
   */
  if (serverStarting && !processing) return null;
  /*
   * THE PANEL LINE IS GONE. the user, with a screenshot of it alone at the foot of
   * the thread: "◌ Writing svg-icon in the panel → · 1.6s — remove it. It is
   * pinned to the bottom, the elapsed time resets, and it tells me nothing."
   *
   * Both complaints were true and both were structural. It was pinned because
   * this indicator sits at the foot of the thread; the clock reset because its
   * timer restarts whenever `timing` flips, and a write is a run of short
   * streaming tabs rather than one long one, so it re-armed on every file. And
   * it duplicated what two better things already said: the chain row above it
   * names the file being written, and the canvas rail opens itself and shows
   * that file filling in. It was built for a case that no longer exists — a
   * chat column that went silent for 70 seconds — and the chain's live rows
   * closed that hole properly.
   */
  if (!processing && !fading) return null;
  // Cold model LOAD → indeterminate pulse + "Loading model" (no fake %). Ingesting
  // → the REAL prefill % (parsePrefillPercent caps at 99, so it never falsely
  // reads 100 mid-prefill). Completion (first token) → 100 before the fade.
  /*
   * The prefill percentage is REAL (llama's own prompt_progress frames), and it
   * was being thrown away for the whole of the longest wait: `serverStarting`
   * forced it to null, so the one window where a user most needs to know
   * something is happening showed an indeterminate pulse. Only a model still
   * loading off disk has nothing to report.
   */
  const percent = processing ? (readyStage === 'loading' ? null : prefillPct) : 100;
  /*
   * A CAPABILITY LOADING IS A DIFFERENT WAIT, so it gets a different sentence.
   *
   * Turning a group on appends tool schemas, and those render at the FRONT of
   * the prompt — so the request right after an activation re-ingests the whole
   * conversation. Same ring, same percentage, entirely different reason, and
   * "Reading your conversation" is actively misleading about it. the user: "when
   * there's a long prefill because a capability is being loaded instead of
   * 'processing' on that turn make the prefill circle show 'loading
   * <capability>'."
   */
  const loadingCap = harness?.loadingCapability ?? null;
  if (processing && percent !== null && loadingCap !== null && loadingCap !== '') {
    return (
      <ProcessingRing
        percent={percent}
        label={`Loading ${CAPABILITY_LABEL[loadingCap] ?? loadingCap}`}
        fading={fading}
        elapsedMs={elapsedMs}
        capability={loadingCap}
      />
    );
  }
  return (
    /*
     * "READING YOUR CONVERSATION", not "processing".
     *
     * This is the prefill of the message you just sent — the ONE wait in the app
     * with a real, provider-reported percentage — so it stayed in the thread,
     * with the turn it belongs to, when the two BOOT waits left for the pill.
     * The tester caught me moving all three on a categorical argument: "the
     * prefill of the message I just sent absolutely is about that message. You
     * built one component and then made an argument that happens to justify
     * putting three unlike things inside it."
     *
     * The name is hers, and it earns more than disambiguation: prefill gets
     * slower as a conversation gets longer, and an unexplained variable delay is
     * the most alarming kind. Naming the cause makes a long wait stop being
     * frightening. With no percentage there is no conversation being read yet,
     * so it says the honest smaller thing instead.
     */
    <ProcessingRing
      percent={percent}
      /*
       * the user, on the very first wait of a run: "i'd like to say 'starting up'
       * or something like that if it's the first message or 'loading model' or
       * changing between the two accurately." Both are true at different
       * moments — the weights really are loading, and then the session really
       * is starting — so one function decides, and the thread and the tool
       * chain now read from it rather than each naming the wait themselves.
       */
      label={prefillLabel({
        modelPhase: readyStage === 'loading' ? 'loading' : 'ready',
        firstOfSession,
        generic: percent === null ? 'Working' : 'Reading your conversation',
      })}
      fading={fading}
      elapsedMs={elapsedMs}
    />
  );
}

/**
 * The live task checklist, pinned above the thread. Renders nothing until the
 * model publishes a plan via `update_plan`.
 */
export function HarnessChecklistPanel() {
  const status = useHarnessStatus();
  const plan = status?.plan;
  if (plan === undefined || plan === null || plan.length === 0) return null;

  const items: TaskChecklistItem[] = plan.map((p) => ({ label: p.text, state: toTaskState(p) }));

  return (
    <div className="mx-auto w-full max-w-[700px] px-4 pt-2" data-testid="harness-checklist">
      <TaskChecklist
        className="border border-border-subtle bg-surface-raised"
        title={status?.planTitle ?? 'Plan'}
        items={items}
        // Round-14 #6: the pinned panel collapses to just its title header so a
        // long plan can tuck up out of the way. Long plans start collapsed.
        collapsible
        defaultCollapsed={items.length > LONG_PLAN_THRESHOLD}
      />
    </div>
  );
}
