/**
 * THEME 3 in the thread. Segments one assistant turn's blocks into render
 * units: visible text, standalone thoughts, and collapsed tool/thinking
 * CHAINS. A chain is a maximal run of consecutive thinking + tool-call blocks
 * with no text between them — it renders as a single dim past-tense summary
 * (ActivityChain) that expands to a stacked step list, then per-step content.
 *
 * Round-6 UNIFY: a thinking-ONLY run (no tools) is ALSO routed through the
 * ActivityChain so it gets the chain chrome (clock-icon "Thought for X" step +
 * connector line + "Done ✓" terminal) instead of a bare thought. Both a chain
 * and a thinking-only run are EXPANDED + live while the turn streams and this is
 * its trailing block, then COLLAPSE to their summary the moment the run is done
 * (the response text begins, or the turn ends) — driven by the `active` flag.
 * Media/preview steps route to a canvas tab via the shared controller.
 */

import { useCanvasTabs } from '@pi-desktop/canvas';
import type { ToolResultMsg } from '@pi-desktop/engine';
import { ActivityChain } from '@pi-desktop/ui';
import { type ReactNode, useMemo, useRef } from 'react';
import { useCanvasStore } from '../state/canvas-store';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import {
  type ActivityBlock,
  chainRunningFlags,
  isEmptyThinking,
  type MappedStep,
  mapThinkingStep,
  mapToolStep,
} from './activity-mapping';
import { appIconSrc, useAppIconStore } from './app-icons';
// Local module (NOT a package barrel) — keep the open-in-canvas action off the
// renderer-forbidden barrels (the gotcha); `openFileInCanvas` reads via IPC.
import { openFileInCanvas } from './canvas/file-tabs';
import { ChainThumbs, type ChainVisual } from './chain-visuals';
import {
  PREFILL_STATUS_KEY,
  parsePrefillPercent,
  prefillLabel,
  useHarnessStatus,
} from './harness-status';

export { segmentBlocks } from './activity-mapping';

/**
 * Rough thinking-time estimate for a thinking-only chain. The engine carries no
 * per-block timestamps, so approximate the reasoning length at the live token
 * throughput (~4 chars/token). Honest-but-estimated; omitted when no throughput
 * is known or the estimate rounds below a second (→ a plain "Thought" pill).
 */
function estimateThoughtMs(text: string, tps: number | undefined): number | undefined {
  if (tps === undefined || tps <= 0) return undefined;
  const tokens = Math.max(1, Math.round(text.length / 4));
  const ms = Math.round((tokens / tps) * 1000);
  return ms >= 1000 ? ms : undefined;
}

/** Resolve a tool-arg path to an absolute one (join with the session cwd when it
 * arrived relative) so `openFileInCanvas`'s `fs:read-file` can find it. */
function resolveAbsPath(path: string, cwd: string | undefined): string {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  if (cwd !== undefined && cwd.length > 0) return `${cwd.replace(/\/+$/, '')}/${path}`;
  return path;
}

/**
 * A collapsed tool/thinking chain wired to the canvas controller for media
 * steps. Also renders a thinking-ONLY run (no tools) so every thought gets the
 * chain chrome. `streaming` marks this as the live trailing block of the turn —
 * it drives BOTH the per-step running state AND the chain's `active` (expanded +
 * live) state, so the chain collapses to its summary the instant the run ends.
 */
/**
 * A call the model has finished writing: its arguments are parsed (the engine
 * finalises them at toolcall_end), or its raw text closes as JSON. A call
 * still being typed is neither — it is generating, which is a kind of running.
 */
function callIsWritten(block: { arguments?: Record<string, unknown>; argsText?: string }): boolean {
  if (block.arguments !== undefined && Object.keys(block.arguments).length > 0) return true;
  const raw = (block.argsText ?? '').trim();
  if (raw === '') return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export function ThreadActivityChain({
  blocks: allBlocks,
  resultForBlock,
  runningToolCalls,
  streaming,
  turnStreaming,
  turnStartedAt,
  tps,
  onOpenFile,
  chainKey,
  attachments,
  visuals,
  chainStartedAt,
}: {
  blocks: ActivityBlock[];
  /** Tool result keyed by tool-call id (owner-scoped by the caller). */
  resultForBlock: Map<string, ToolResultMsg>;
  runningToolCalls: string[];
  streaming: boolean;
  /**
   * Is the whole TURN still going — as opposed to this segment being the live
   * one?
   *
   * MEASURED by the stress probe's bounce detector: the assistant's text block
   * moving 3px and coming back ~97ms later, and behind it the content column
   * collapsing 156→138px mid-reply. A turn that emits text after a tool call
   * starts a new segment, so the previous chain stops being `lastSegment`, its
   * `streaming` goes false, and it ROLLS ITSELF SHUT while the model is still
   * talking — pulling everything below it up, then pushing it back down at the
   * next tool call.
   *
   * the user has reported this shape twice: "no expanding/closing tool / think
   * blocks it stays open until it says done." The per-step running state is
   * rightly scoped to the live segment; whether the chain is DONE is a fact
   * about the turn. Defaults to `streaming` so a caller that knows no better
   * behaves as before.
   */
  turnStreaming?: boolean;
  /** Wall-clock the owning assistant turn began (for the thinking duration). */
  turnStartedAt?: number;
  /** Live throughput (tok/s) used to estimate a thinking-only run's duration. */
  tps?: number;
  /**
   * Override the file-op row's "open in canvas" action (read/edit/skill). The
   * normal chat leaves this unset and opens the file off disk via `fs:read-file`;
   * the corp feed passes its own opener so a live corp-workspace file opens as a
   * streaming corp-peek instead (the workspace has no renderer-addressable path).
   */
  onOpenFile?: (path: string) => void;
  /**
   * What makes THIS chain's step ids unique across the whole app — the owning
   * group and segment (AssistantGroup). A thinking block has no id of its own,
   * and its slot (`thinking:0`) is the same in every chat, while the running
   * timer remembers the first time it saw an id for the life of the renderer:
   * the user (2026-09-23), a new chat two seconds old reading "Thinking for 14m" —
   * the start time of the first thought he saw that session.
   */
  chainKey?: string;
  /**
   * The finished results filed INTO this chain, by the id of the call that made
   * each — drawn under that call's row, and folding away with the chain. Which
   * results belong in here rather than beneath the chain is AssistantGroup's
   * call (turn-cards.ts); this only puts them in their rows.
   */
  attachments?: ReadonlyMap<string, ReactNode>;
  /** The pictures this chain worked with, previewed at the right of its summary row. */
  visuals?: readonly ChainVisual[];
  /** When the request that began this chain was sent — its first block's message. */
  chainStartedAt?: number;
}): ReactNode {
  const canvas = useCanvasTabs();
  // The folder the TOOLS resolve a relative path against (the chat's working
  // folder, from the harness) — pi's cwd can be its parent.
  const piCwd = usePiStore((s) => s.session?.cwd ?? undefined);
  const workspaceRoot = useHarnessStatus()?.workspaceRoot ?? null;
  const cwd = workspaceRoot ?? piCwd;

  // Thinking duration (round-3 #A13/activity): the engine carries no per-block
  // timestamps, so approximate the model's thinking time as the pre-first-tool
  // window — from the turn start to the earliest tool result in the chain. The
  // whole window is attributed to the FIRST thinking step (summarizeActivity
  // sums per kind, so the aggregate reads "thought for Xs" regardless of split).
  /* A thinking block that is only a chat-template marker (`<|channel>thought`)
   * renders as a "Thought" row with nothing under it — the user screenshotted three
   * in a row. Drop them BEFORE the running flags are computed, so the indices
   * stay aligned and they also stop inflating the collapsed summary's count. */
  const blocks = allBlocks.filter((b) => !isEmptyThinking(b));
  /* No key from the caller: this mount's own, so a timer never inherits another
     chain's start (a remount restarts the clock — honest, where a borrowed
     start time is not). */
  const ownScope = useRef(`chain-${Math.random().toString(36).slice(2, 10)}`);
  const chainScope = chainKey ?? ownScope.current;
  const firstToolResultTs = blocks.reduce<number | undefined>((min, b) => {
    if (b.type !== 'toolCall') return min;
    const ts = resultForBlock.get(b.id)?.timestamp;
    if (ts === undefined) return min;
    return min === undefined ? ts : Math.min(min, ts);
  }, undefined);
  const hasTools = blocks.some((b) => b.type === 'toolCall');
  // The chain's span: its first request to its last result — "Worked for" is that long.
  const lastToolResultTs = blocks.reduce<number | undefined>((max, b) => {
    if (b.type !== 'toolCall') return max;
    const ts = resultForBlock.get(b.id)?.timestamp;
    if (ts === undefined) return max;
    return max === undefined ? ts : Math.max(max, ts);
  }, undefined);
  const wallMs =
    !streaming && chainStartedAt !== undefined && lastToolResultTs !== undefined
      ? Math.max(0, lastToolResultTs - chainStartedAt)
      : undefined;
  // Thinking-only run: no tool result to bound the window, so estimate from the
  // thought length + live throughput (round-6 unify — same estimate the old
  // standalone-thought path used, now feeding the chain summary "Thought for X").
  const thinkingText = blocks
    .filter((b): b is Extract<ActivityBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('');
  /*
   * DO NOT REPORT A DURATION THIS CHAIN DID NOT TAKE.
   *
   * `firstToolResultTs - turnStartedAt` measures from the start of the whole
   * TURN, which is only this chain's own thinking time when the chain is the
   * first thing in the turn. For a chain eight minutes into a long turn it
   * reports the entire turn. the user, on a three-second thought: "that thought
   * block did not take 7 minutes? it was like 3 seconds" — the label read
   * "Thought for 7m 55s", off by more than a hundredfold.
   *
   * There is no per-block timestamp to fix this properly and no prop saying
   * which chain this is, but the token estimate IS per-chain: it comes from this
   * chain's own thinking text. So use the wall-clock delta only when the two
   * agree in scale; when the delta dwarfs the estimate it is measuring the wrong
   * window, and the estimate — imprecise but attributable — is the honest number.
   */
  const estimated = estimateThoughtMs(thinkingText, tps);
  const wallDelta =
    turnStartedAt !== undefined && firstToolResultTs !== undefined
      ? Math.max(0, firstToolResultTs - turnStartedAt)
      : undefined;
  const wallIsPlausible =
    wallDelta !== undefined &&
    (estimated === undefined || wallDelta <= Math.max(estimated * 4, estimated + 15_000));
  const thinkingMs = wallIsPlausible
    ? (wallDelta ?? 0)
    : hasTools
      ? (estimated ?? 0)
      : (estimated ?? 0);
  const firstThinkingIdx = blocks.findIndex((b) => b.type === 'thinking');

  /*
   * The REAL prompt-ingest percent, off the same channel the thread indicator
   * reads (provider-llamacpp's `prompt_progress` frames). Not a second source
   * and not an easing curve — the chain shows exactly what llama reports, or an
   * indeterminate ring when it has not reported yet.
   */
  /** Output streamed by tools that have not returned yet, keyed by call id. */
  const partials = usePiStore((st) => st.toolOutputPartials);
  const prefillRaw = usePiStore((st) => st.extensionStatus[PREFILL_STATUS_KEY]);
  const prefillPct = parsePrefillPercent(prefillRaw);
  /* The wait's CAUSE, so the row can name it — see prefillLabel. */
  const harness = useHarnessStatus();
  /* "Starting up" belongs to the FIRST reply of a conversation — after that the
     model is resident and the wait is something else. */
  // Subscribe so a newly-arrived icon repaints the rows that wanted it: a new
  // resolver identity is what tells a memoized row (ActivityChain) to look again.
  const icons = useAppIconStore((st) => st.icons);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the icons are the resolver's identity.
  const resolveAppIcon = useMemo(() => (app: string) => appIconSrc(app), [icons]);
  const firstAssistantTurn = usePiStore(
    (st) => st.messages.filter((m) => m.kind === 'assistant').length <= 1,
  );
  /* The real server phase, from the inference store — 'starting' while weights
     load, which is the 27-second wait the user saw on the first message. */
  const llmPhase = useLlmStore((st) => st.status.phase);
  const llmParked = useLlmStore((st) => st.status.parked !== undefined);
  const label = prefillLabel({
    modelPhase: llmPhase ?? null,
    parked: llmParked,
    loadingCapability: harness?.loadingCapability ?? null,
    firstOfSession: firstAssistantTurn,
  });

  // E1: only the LAST block of a live chain is present-tense; every settled prior
  // step stays past-tense (a new action must not re-present the ones before it).
  const runningFlags = chainRunningFlags(blocks, {
    streaming,
    hasResult: (id) => resultForBlock.get(id) !== undefined,
    runningToolCalls,
  });
  /* A thinking block that is only a chat-template marker renders as a "Thought"
   * row with nothing under it — the user saw three in a row. Drop them before they
   * become steps, so they also stop inflating the collapsed summary's count. */
  /*
   * A SETTLED STEP KEEPS ITS DATA OBJECT across renders, so its row (memoized
   * in ActivityChain) is skipped while the turn streams on below it — MEASURED
   * (MiniCPM 5 2B, 183 steps): every token re-mapped and re-rendered every row,
   * 130 ms an update, until the window stopped painting. A step is mapped again
   * only when something it is made from moved.
   */
  const stepCache = useRef(new Map<string, { inputs: readonly unknown[]; step: MappedStep }>());
  const steps: MappedStep[] = blocks.map((block, i) => {
    const running = runningFlags[i] ?? false;
    const id = block.type === 'thinking' ? `${chainScope}:thinking:${i}` : block.id;
    const attachment = block.type === 'toolCall' ? attachments?.get(block.id) : undefined;
    const inputs: readonly unknown[] =
      block.type === 'thinking'
        ? [block, running, !streaming && i === firstThinkingIdx ? thinkingMs : undefined]
        : [
            block,
            resultForBlock.get(block.id),
            running,
            running ? partials[block.id] : undefined,
            runningToolCalls.includes(block.id),
            attachment,
          ];
    const hit = stepCache.current.get(id);
    if (
      hit !== undefined &&
      hit.inputs.length === inputs.length &&
      hit.inputs.every((v, k) => Object.is(v, inputs[k]))
    ) {
      return hit.step;
    }
    const mapped =
      block.type === 'thinking'
        ? mapThinkingStep(
            block,
            running,
            !streaming && i === firstThinkingIdx ? thinkingMs : undefined,
          )
        : mapToolStep(
            block,
            /*
             * A RUNNING TOOL SHOWS WHAT IT HAS PRINTED SO FAR.
             *
             * pi streams a tool's output while it runs; until now that stream was
             * discarded, so a command that had been going for a minute could show
             * you nothing but a spinner. the user, on exactly that row: "nor the live
             * output that I should be able to see."
             *
             * The real result still wins the moment it exists — this only fills
             * the gap before it, which is the only time it can say anything the
             * result cannot. Shaped as a ToolResultMsg so `mapToolStep` needs to
             * know nothing about where the text came from.
             */
            resultForBlock.get(block.id) ??
              (running && partials[block.id] !== undefined
                ? ({
                    kind: 'toolResult',
                    id: `${block.id}:partial`,
                    toolCallId: block.id,
                    toolName: block.name,
                    text: partials[block.id] as string,
                    isError: false,
                    timestamp: 0,
                  } satisfies ToolResultMsg)
                : undefined),
            running,
            /*
             * QUEUED: written in full, not started, nothing back. The model puts
             * several calls in one message; the harness runs them one at a time
             * and names the one it is on (runningToolCalls). The others are not
             * "executing all at once" (the user) — they are waiting their turn, and
             * the row says so instead of spinning.
             */
            running &&
              !runningToolCalls.includes(block.id) &&
              resultForBlock.get(block.id) === undefined &&
              callIsWritten(block),
          );
    // Give each step an identity that outlives its LABEL. ActivityChain keys its
    // rows on `id`, falling back to `kind:label` — and the label flips tense the
    // instant a step settles ("Editing a file" → "Edited a file"), which re-keyed
    // the row and remounted it. Worse, the fallback's duplicate suffix reshuffled
    // (`read:Reading a file#1` → `read:Reading a file`) whenever an earlier
    // same-kind row settled, remounting a row that was still RUNNING and
    // restarting its spinner mid-turn. A tool call's id never moves; a thinking
    // block has none, so its slot in the append-only block list stands in.
    const step: MappedStep = {
      ...mapped,
      data: { ...mapped.data, id, ...(attachment !== undefined ? { attachment } : {}) },
    };
    stepCache.current.set(id, { inputs, step });
    return step;
  });

  return (
    <ActivityChain
      data-testid="activity-chain"
      steps={steps.map((s) => s.data)}
      defaultExpanded={false}
      {...(visuals !== undefined && visuals.length > 0
        ? { summaryAside: <ChainThumbs items={visuals} /> }
        : {})}
      /*
       * EXPANDED WHILE THIS CHAIN IS THE LIVE ONE — not for the whole turn.
       *
       * This read `turnStreaming ?? streaming`, which is a fact about the TURN,
       * so a chain stayed open while the model typed its reply underneath it,
       * and stayed open again while the NEXT chain ran. the user: "thinking / tool
       * chains need to collapse when they finish and the model starts typing
       * actual response, even if a new one starts right after, the old one is
       * then collapsed."
       *
       * `streaming` is already the segment's own answer (AssistantGroup passes
       * `streaming && seg === lastSegment`), so the moment any later segment
       * exists — the reply, or a fresh chain — this one is no longer live and
       * folds. `complete` still asks the turn, because "Done" is a claim about
       * the work finishing rather than about who is on screen.
       */
      active={streaming}
      /* The turn's own answer to "is this over", so Done is never inferred from
         rows going quiet between two tool calls (the user: "done is a final thing"). */
      complete={!(turnStreaming ?? streaming)}
      /*
       * PREFILL, as the chain's last row. A turn that is ingesting a long prompt
       * produces nothing — no running step, no tokens — so the chain looked
       * exactly like a finished one and printed "Done" over a working model.
       * the user: "we need to have an idea of what's going on at all times."
       *
       * Conditions, deliberately strict: this run is streaming, NO step is
       * running, and llama is reporting a percent BELOW 100. A finished ingest
       * reports 100 and generation begins, so `< 100` is what separates "still
       * reading the prompt" from "producing" — without it the row would sit
       * there through ordinary text generation, which is the opposite of
       * telling you what is going on.
       *
       * The moment a real tool call or thought starts, that row IS the answer
       * and this one clears — the replacement the user asked for.
       */
      /*
       * AND THE GAPS WHERE NOTHING WAS SHOWN AT ALL.
       *
       * the user, timing one: "from 1:00 when it initally shows the tool as
       * finished to 1:11, there is no user feedback, no processing % ring, no
       * thinking, nothing, then it finally at ~1:12 shows 99% instantly ...
       * the bunch of waits, especially times without any processing circle or
       * tool executing are not good and really what makes a user think
       * something's broken."
       *
       * The row required a REPORTED percent, and llama reports nothing until it
       * starts the ingest — so the whole run-up (assembling the prompt, the
       * tool schemas changing, the server picking the request up) was silent.
       * An indeterminate ring covers it now: the same row, spinning, from the
       * moment the model owes us a reply.
       *
       * Still not shown during generation — the last block being a FINISHED
       * tool call is what says the model has not started answering yet, so the
       * text streaming in is never talked over.
       */
      /* Real app icons: subscribing to the cache is what re-renders the row
         when the picture arrives, since it is fetched after the first paint. */
      resolveAppIcon={resolveAppIcon}
      {...(wallMs !== undefined ? { wallMs } : {})}
      {...(streaming &&
      !runningFlags.some(Boolean) &&
      (prefillPct === null ? blocks.at(-1)?.type === 'toolCall' : prefillPct < 100)
        ? { prefill: { percent: prefillPct, label } }
        : {})}
      onOpenCanvas={(_step, index) => {
        const spec = steps[index]?.tabSpec;
        if (spec?.key === undefined) return;
        canvas.upsertTab(spec.key, spec);
        // upsertTab creates and FOCUSES the tab; it does not reveal the panel.
        // With the canvas collapsed that made clicking a media row look like it
        // did nothing at all — the tab was there, behind a closed drawer
        // (the user: "clicking that focuses the image in the canvas but doesn't
        // slide it open if it's closed"). Every other path that puts something
        // in the canvas on the user's behalf opens it too (corp stream,
        // subagent routing, browser agent); this one was the exception.
        //
        // GENERATED MEDIA NO LONGER ARRIVES HERE AT ALL: an image / video /
        // audio the app made renders inline as its own card and its row carries
        // no tabSpec, so this handler is for the media a THIRD-PARTY tool
        // returns, which has no card to be a second copy of.
        useCanvasStore.getState().setCanvasOpen(true);
      }}
      // A read/edit/skill row's primary click opens that file in the canvas
      // (deliverable A2). The full path lives on `step.detail`; resolve it against
      // the session cwd when it arrived relative so the IPC read can find it. When
      // the caller supplies an opener (the corp feed), defer to it instead.
      onOpenFile={(step) => {
        const path = step.detail;
        if (path === undefined || path.length === 0) return;
        if (onOpenFile !== undefined) {
          onOpenFile(path);
          return;
        }
        void openFileInCanvas(canvas.controller, resolveAbsPath(path, cwd), cwd);
      }}
    />
  );
}
