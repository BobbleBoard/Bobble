/**
 * One assistant response GROUP rendered through the design system — the single
 * render path for streamed assistant output. `segmentGroup` splits the group's
 * blocks into markdown text / inline artifacts / tool+thinking CHAINS, which
 * render via {@link Markdown} + {@link ThreadActivityChain}.
 *
 * Extracted from `ChatThread` (not just exported) so the corp feed can stream a
 * watched agent through the EXACT same path without an import cycle
 * (`ChatThread → CorpChatStream → CorpWorkerPane`). Reusing it gives the corp feed
 * the normal chat's behavior verbatim: append-stable segment keys (a new block
 * never re-mounts the existing chain), the collapsible thinking block WITH its
 * rail while streaming (a thinking run is an ActivityChain, not a component that
 * swaps type when it settles), and real tool/file activity rows.
 */
import { type AssistantMsg, cleanErrorText, type ToolResultMsg } from '@pi-desktop/engine';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type PendingKind, PendingMediaCard } from '../media/PendingMediaCard';
import { abortPi } from '../state/pi-connect';
import type { PresentedRecord } from '../state/present-store';
import { segmentGroup } from './activity-mapping';
import { InlineArtifact } from './canvas/InlineArtifacts';
import { withViewTransition } from './canvas/view-transition';
import { liveSource, pendingDiagramArgs } from './diagram-stream';
import { useGeneratingJob, useModel3dLive } from './GeneratingMedia';
import { jobSamples, recordJobDuration } from './job-history';
import { LiveSvgCard } from './LiveSvgCard';
import { LongJobCard } from './LongJobCard';
import { PresentedCallContext } from './live-handover';
import { effectiveToolName, estimateFor, type JobKind, jobKindForTool, jobView } from './long-job';
import { Markdown, TurnCardsContext } from './markdown';
import { PendingChartCard, pendingChartArgs } from './PendingChartCard';
import { PendingDiagramCard } from './PendingDiagramCard';
import { SourcesCard } from './sources/SourcesCard';
import { TurnSourcesProvider } from './sources/turn-sources';
import { ThreadActivityChain } from './ThreadActivity';
import { ThreadMedia } from './ThreadMedia';
import { mediaFromToolResult, type ThreadMediaItem } from './thread-media';
import { type CardPlace, placeTurnCards, type TurnCall, type TurnCard } from './turn-cards';

/** A View Transition name for one file's card — a CSS ident, stable per path. */
function handoverName(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i += 1) h = (Math.imul(h, 31) + path.charCodeAt(i)) | 0;
  return `pd-handover-${(h >>> 0).toString(36)}`;
}

/*
 * A PRESENTED CARD IS MOVED, NOT REBUILT.
 *
 * turn-cards.ts files a presented card into its chain while the chain works on
 * and brings it back out beneath the chain when it is done. Those are two
 * places in the tree, and React rebuilds a component that changes parents: the
 * card was a NEW card each time, and a chart grew its bars from the axis again
 * on both moves (MEASURED, turn-card-move-look: three elements, 133 frames of
 * entrance each move). STATUS, from the thread track: "a finished card moves
 * into the chain (and remounts) when the next tool call starts".
 *
 * So each presented card is rendered ONCE, through a portal, into a home of its
 * own — a box-less element that belongs to the card — and whichever place the
 * card stands in now adopts that element. Only the element moves.
 */
const lastBox = new WeakMap<HTMLElement, DOMRect>();

/** Where a presented card stands: adopts the card's home, and glides it in. */
function CardSlot({ home }: { home: HTMLElement }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (slot === null) return;
    slot.appendChild(home);
    /* From where it stood to where it stands, over the move — the chain row is
       smaller than the place beneath it, so the scale says where it went. */
    const card = home.firstElementChild;
    const from = lastBox.get(home);
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (card instanceof HTMLElement && from !== undefined && !reduced && card.animate) {
      const to = card.getBoundingClientRect();
      if (to.width > 0 && (Math.abs(from.top - to.top) > 1 || Math.abs(from.left - to.left) > 1)) {
        /* Above the rows it passes over — they come after it in the page, and
           painted over the card while it travelled (SEEN in the filmstrip). */
        card.style.position = 'relative';
        card.style.zIndex = '1';
        const glide = card.animate(
          [
            {
              transformOrigin: 'top left',
              transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`,
            },
            { transformOrigin: 'top left', transform: 'none' },
          ],
          { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
        const settle = (): void => {
          card.style.position = '';
          card.style.zIndex = '';
        };
        glide.onfinish = settle;
        glide.oncancel = settle;
      }
    }
    return () => {
      // Still in the page here: the next place this card stands glides from it.
      const box = home.firstElementChild?.getBoundingClientRect();
      if (box !== undefined && box.width > 0) lastBox.set(home, box);
      if (home.parentNode === slot) slot.removeChild(home);
    };
  }, [home]);
  return <div ref={ref} className="contents" />;
}

/** The pending card's kind for a job kind, or null for jobs with no media. */
function pendingKindFor(kind: JobKind): PendingKind | null {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'model3d') return 'model';
  if (kind === 'music' || kind === 'speech' || kind === 'sfx') return 'audio';
  return null;
}

/** The arguments of the tool call `callId` in this group, for effectiveToolName. */
function callArgsFor(group: readonly AssistantMsg[], callId: string | undefined): unknown {
  if (callId === undefined) return undefined;
  for (const m of group)
    for (const b of m.blocks) if (b.type === 'toolCall' && b.id === callId) return b.arguments;
  return undefined;
}

/*
 * Job durations are recorded ONCE per tool call, ever. This component re-renders
 * on every token of the surrounding turn and remounts on a chat switch, so
 * without this the same four-minute image would teach the estimator hundreds of
 * times and drown every other sample it has.
 */
const RECORDED = new Set<string>();

export function AssistantGroup({
  group,
  resultByCallId,
  runningToolCalls,
  tps,
  onOpenFile,
  suppressInlineArtifacts = false,
  live,
  recordsByCall,
  renderRecord,
}: {
  group: AssistantMsg[];
  resultByCallId: Map<string, ToolResultMsg>;
  runningToolCalls: string[];
  /** Current throughput from the inference supervisor (assistant footnote). */
  tps: number | undefined;
  /** Override the file-op row opener (the corp feed opens a live corp-peek). */
  onOpenFile?: (path: string) => void;
  /**
   * CORP feed rule (J3): the corp thread is text / thoughts / tool-call rows ONLY.
   * Any THEME-2 inline artifact widget (```html/```svg preview, a generated image)
   * is SUPPRESSED here and opened in the CANVAS instead — `CorpChatStream` detects
   * the same artifacts and routes each to a canvas tab, so a `mockup.html` the CEO
   * writes shows as a tool row + a canvas preview, never a black box inline. Normal
   * chat leaves this false and renders widgets inline (THEME 2), unchanged.
   */
  suppressInlineArtifacts?: boolean;
  /**
   * This agent is mid-turn RIGHT NOW, per whoever owns its state. Overrides the
   * per-message `isStreaming` derivation, which a reconstructed transcript
   * cannot supply. Omit in the ordinary chat, where the live slice sets it.
   */
  live?: boolean;
  /**
   * The cards this turn PRESENTED (a chart, a drawing, a `present`ed file), by
   * the call that handed each one over (turn-cards.ts `attributeRecords`). They
   * are placed exactly like the media the turn generated — in the chain while
   * the work goes on (never at the foot of a turn still working), and at the
   * foot of the reply, after its words, once each is an answer (`foot`).
   */
  recordsByCall?: ReadonlyMap<string, readonly PresentedRecord[]>;
  /** Draws one presented card; the thread owns the canvas handlers it needs. */
  renderRecord?: (record: PresentedRecord) => ReactNode;
}): ReactNode {
  /*
   * A RECONSTRUCTED TRANSCRIPT HAS NO isStreaming, AND THAT READ AS FINISHED.
   *
   * `isStreaming` is set by the live pi slice. A corp role's chat is built from
   * a fetched SNAPSHOT of its session (`transcriptToAssistantView`), so no
   * message carries it — `streaming` came out false, `active` reached the chain
   * as false, and the terminal "Done" row printed the moment the rows went
   * quiet. the user, with the situation room saying "Engineer 1 working… 1:36"
   * beside a chat reading Done: "premature 'done' in the UI while still
   * working… done is a final thing. This tool chain is DONE."
   *
   * `live` lets a caller that KNOWS the agent is mid-turn say so — driving Done
   * from the node's state rather than from rows happening to be still.
   */
  const streaming = live ?? group.some((m) => m.isStreaming === true);
  // Whether this turn was still being written while on screen: what it adds as
  // it finishes (the sources under it) comes up into place then; a turn
  // switched back to is simply there.
  const sawStreaming = useRef(streaming);
  if (streaming) sawStreaming.current = true;
  // Owner-scoped result per tool-call id (avoids a bare-id collision with a
  // provider-reused toolCallId in a later user turn).
  const resultForBlock = new Map<string, ToolResultMsg>();
  for (const m of group) {
    for (const b of m.blocks) {
      if (b.type !== 'toolCall') continue;
      const r = resultByCallId.get(`${m.id}:${b.id}`) ?? resultByCallId.get(b.id);
      if (r !== undefined) resultForBlock.set(b.id, r);
    }
  }

  /*
   * THE JOB THIS GROUP IS WAITING ON — the 293 seconds of silence.
   *
   * ONE SCAN, NOT TWO. There used to be a second one beside it that found only
   * the pending IMAGE call, because only an image had anything to draw while it
   * ran. Now every generated modality does (GeneratingMedia), so the card and
   * the animation inside it are chosen from the same fact: which job is running.
   *
   * `startedAt` is the owning message's timestamp, which is when pi began the
   * call. Wall-clock, so it survives a re-render and a component remount — a
   * timer that restarts at 0:00 halfway through a four-minute wait is worse
   * than no timer, because it says the opposite of what is true.
   */
  let runningJob: {
    kind: NonNullable<ReturnType<typeof jobKindForTool>>;
    callId: string;
    startedAt: number;
  } | null = null;
  if (!suppressInlineArtifacts) {
    for (const m of group) {
      for (const b of m.blocks) {
        if (b.type !== 'toolCall' || runningJob !== null) continue;
        if (!runningToolCalls.includes(b.id) || resultForBlock.has(b.id)) continue;
        const kind = jobKindForTool(effectiveToolName(b.name, b.arguments));
        if (kind === null) continue;
        runningJob = { kind, callId: b.id, startedAt: m.timestamp };
      }
    }
  }

  /*
   * THE ENGINE'S OWN ACCOUNT OF THE JOB, for the card that is showing it.
   *
   * Step counts, the aspect ratio it is rendering at, the worker's last status
   * line, and — for audio — the clip the moment it exists. All of this was
   * already streaming; it went to a canvas tab nobody was told to open (see
   * chat/gen-stream.ts). Asked for once, here, because there is one running job.
   *
   * Absent is ordinary, not an error: the gen3d image path publishes decoded
   * frames without opening a gen stream at all, and the card is complete
   * without it.
   */
  const generating = useGeneratingJob(runningJob?.kind ?? null);
  // A 3D build reports through the studio's own broadcast, not the gen stream.
  const live3d = useModel3dLive(runningJob?.kind === 'model3d');

  /*
   * LEARNING WHAT THIS MAC ACTUALLY DOES.
   *
   * The shipped estimate ranges are a guess about someone else's hardware; the
   * card starts quoting this machine as soon as it has run the job twice. The
   * duration is the span from the tool CALL to its RESULT, so a job that was
   * cancelled — no result — teaches nothing, which is right: a wait the user
   * cut short is not evidence of how long the work takes.
   *
   * In an effect, and guarded by callId, because this component re-renders on
   * every token of the surrounding turn.
   */
  const finished: { kind: JobKind; callId: string; seconds: number }[] = [];
  for (const m of group) {
    for (const b of m.blocks) {
      if (b.type !== 'toolCall') continue;
      const kind = jobKindForTool(effectiveToolName(b.name, b.arguments));
      if (kind === null) continue;
      const result = resultForBlock.get(b.id);
      if (result === undefined) continue;
      finished.push({ kind, callId: b.id, seconds: (result.timestamp - m.timestamp) / 1000 });
    }
  }
  const finishedKey = finished.map((f) => f.callId).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the call ids, which is the identity that matters
  useEffect(() => {
    for (const f of finished) {
      if (RECORDED.has(f.callId)) continue;
      RECORDED.add(f.callId);
      recordJobDuration(f.kind, f.seconds);
    }
  }, [finishedKey]);

  /*
   * THE HANDOVER, IN THE THREAD.
   *
   * the user: "just the same final video card, same final image card, same final 3d
   * card … as it goes reveal the actual produced image/video/3d. seamless."
   * The pending card (PendingMediaCard) IS the finished card's frame; when the
   * tool result lands, the first file it produced is handed to that same card,
   * which plays the closing sweep over it and only then reports `revealed` —
   * at which point ThreadMedia takes over with identical pixels. Until then
   * the first item is held back from ThreadMedia, or the picture would appear
   * twice: once coming out from under the sweep and once below it.
   *
   * `lastRunning` remembers which call the card was standing in for, because
   * by the time the result exists `runningJob` is already null.
   */
  const lastRunning = useRef<{ kind: JobKind; callId: string } | null>(null);
  if (runningJob !== null)
    lastRunning.current = { kind: runningJob.kind, callId: runningJob.callId };
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const handing =
    runningJob === null &&
    lastRunning.current !== null &&
    resultForBlock.has(lastRunning.current.callId)
      ? lastRunning.current
      : null;
  const handingResult = handing === null ? undefined : resultForBlock.get(handing.callId);
  const handingItem =
    handingResult === undefined
      ? undefined
      : mediaFromToolResult(
          effectiveToolName(handingResult.toolName, callArgsFor(group, handing?.callId)),
          handingResult.text,
          handingResult.isError,
        )[0];
  const handingLive = handingItem !== undefined && !revealed.has(handingItem.path);

  const segments = segmentGroup(group);
  const lastSegment = segments[segments.length - 1];
  const groupId = group[0]?.id ?? 'g';

  /*
   * WHERE EACH FINISHED THING THE TURN MADE GOES — in the chain that made it, or
   * beneath it. The rule and why are in turn-cards.ts; this gathers its facts.
   *
   * The live chain is the one the turn is working in RIGHT NOW: the last
   * segment of a streaming turn, and only if that segment is a chain — the
   * same test that holds the chain open (`streaming && seg === lastSegment`).
   */
  const liveChain =
    streaming && lastSegment?.kind === 'chain' ? segments.length - 1 : (null as number | null);
  const turnCalls: TurnCall[] = [];
  segments.forEach((seg, index) => {
    if (seg.kind !== 'chain') return;
    for (const b of seg.blocks) {
      if (b.type !== 'toolCall') continue;
      turnCalls.push({
        id: b.id,
        chain: index,
        tool: effectiveToolName(b.name, b.arguments),
        args: b.arguments,
      });
    }
  });
  /*
   * WHAT THE TURN MADE. Generated images used to reach the thread only as a
   * 414px markdown embed and generated audio/video only as a path in prose;
   * the user wants every produced file embedded at full quality with a card to
   * reveal it. Keyed off the tool RESULT, so a card appears when the file
   * exists rather than when the model mentions one — a call that is still
   * running, or that failed, has made nothing, and a player mounted for it
   * would be a broken box in the transcript.
   */
  const mediaByCall = new Map<string, ThreadMediaItem[]>();
  const turnCards: TurnCard[] = [];
  for (const call of turnCalls) {
    const result = resultForBlock.get(call.id);
    if (result !== undefined) {
      // A `bash media generate …` result is the generation tool's result.
      const items = mediaFromToolResult(
        effectiveToolName(result.toolName, call.args),
        result.text,
        result.isError,
      );
      if (items.length > 0) mediaByCall.set(call.id, items);
      for (const item of items) {
        turnCards.push({
          key: `m:${call.id}:${item.path}`,
          callId: call.id,
          path: item.path,
          kind: item.kind,
        });
      }
    }
    for (const record of recordsByCall?.get(call.id) ?? []) {
      turnCards.push({
        key: `r:${call.id}:${record.path}`,
        callId: call.id,
        path: record.path,
        kind: 'record',
      });
    }
  }
  const placed = placeTurnCards(turnCalls, turnCards, liveChain);
  const placeOf = (kind: 'm' | 'r', callId: string, path: string): CardPlace =>
    placed.get(`${kind}:${callId}:${path}`) ?? 'beneath';
  /* Each presented card's home (see CardSlot), by its card key — kept while the
     card is shown anywhere, so moving it between places never rebuilds it. */
  const homes = useRef(new Map<string, HTMLDivElement>());
  const homeFor = (key: string): HTMLDivElement => {
    let home = homes.current.get(key);
    if (home === undefined) {
      home = document.createElement('div');
      home.style.display = 'contents';
      homes.current.set(key, home);
    }
    return home;
  };
  const shownRecords = turnCards
    .filter((c) => c.kind === 'record' && placed.get(c.key) !== 'none')
    .flatMap((c) => {
      const record = recordsByCall?.get(c.callId)?.find((r) => r.path === c.path);
      return record === undefined ? [] : [{ key: c.key, callId: c.callId, record }];
    });
  const shownKeys = shownRecords.map((r) => r.key).join('\n');
  useEffect(() => {
    const keep = new Set(shownKeys.split('\n'));
    for (const key of [...homes.current.keys()]) if (!keep.has(key)) homes.current.delete(key);
  }, [shownKeys]);
  /* The files this turn shows as a card OUTSIDE its chain — its reply's own copy
     of one is not drawn again (markdown.tsx TurnCardsContext). */
  const outsideKey = turnCards
    .filter(
      (c) => placed.get(c.key) === 'beneath' && (c.kind !== 'record' || renderRecord !== undefined),
    )
    .map((c) => c.path)
    .join('\n');
  const outside = useMemo(
    () => new Set(outsideKey === '' ? [] : outsideKey.split('\n')),
    [outsideKey],
  );
  // The picture still coming out from under the sweep is the pending card's
  // until it is out — see `handing`.
  const heldBack = (path: string): boolean => handingLive && handingItem?.path === path;
  const drawRecord = (record: PresentedRecord): ReactNode =>
    renderRecord === undefined ? null : (
      /* The wrapper the thread's presented cards have always had, so everything
         that finds a card by it (probes, the chat-order reader) still does. */
      <div key={`rec:${record.path}`} className="flex flex-col gap-2" data-testid="presented">
        {renderRecord(record)}
      </div>
    );
  const rawError = group.find((m) => m.errorMessage !== undefined)?.errorMessage;
  // Clean once: a raw provider blob collapses to a short message, and a
  // user-initiated pause/stop ("aborted"/AbortError) collapses to '' — a clean
  // end renders NOTHING (never a red error row).
  const errorText = rawError !== undefined ? cleanErrorText(rawError) : '';
  let textN = 0;
  let activityN = 0;
  /*
   * THE PAGES THIS TURN SAW, for its citations. the user (2026-09-24): "source
   * citing (for research and such, examples from google search summary
   * shown)". Links to them become chips in the text, and a finished answer
   * that used the web ends with a Sources card (./sources). The corp feed
   * (J3: text, thoughts and rows only) keeps the chips, which are text, and
   * leaves out the card, which is a widget.
   */
  const answered = segments.some((s) => s.kind === 'text');
  /*
   * THE CARDS AT THE FOOT OF THE REPLY. the user (2026-10-01, a student's circle
   * reply with the page's card ABOVE the words that explained it): "inline card
   * should be at the bottom also!" A finished result — a presented file, a
   * chart, a drawing, a generated picture — stands after ALL of the reply's
   * words, in the order the calls made them. What is still being made (a
   * generating card, a chart or diagram building) stays under its chain; while
   * that chain is the last thing in the reply, under it IS the foot, so a card
   * taking over from its live one does not move.
   */
  const foot: ReactNode[] = [];
  const body = (
    /*
     * min-w-0 so this flex child can shrink below its content's intrinsic width
     * and the prose reflows when the canvas narrows the column (blindtest #9).
     *
     * max-w-full because min-width:0 is only half of that promise. `.pd-msg` is
     * a flex COLUMN with `align-items: flex-start`, which sizes its children to
     * their own max-content and does NOT clamp them to itself — so a group whose
     * widest thing is wider than the message box (a 96-bar waveform; a long
     * one-line title beside a timer and a Cancel) hung past the right edge and
     * gave the whole conversation a horizontal scrollbar. MEASURED at a 720px
     * viewport: the message box 398px, this child 430px.
     */
    /*
     * w-full as well (the user, 2026-09-17: "the shown card for the svg should be
     * larger, full width"): `.pd-msg` sizes this child to its content, so a
     * card, a code block or a table was only ever as wide as the longest line
     * of prose beside it. The reply takes the whole reading column, as the
     * references' do; the text inside still wraps where it did.
     */
    <div className="flex w-full min-w-0 max-w-full flex-col gap-2">
      {segments.map((seg) => {
        if (seg.kind === 'text') {
          return <Markdown key={`${groupId}-t${textN++}`} text={seg.text} />;
        }
        if (seg.kind === 'artifact') {
          // J3: never render an inline artifact widget in the corp feed — it opens
          // in the canvas instead (routed by CorpChatStream).
          if (suppressInlineArtifacts) return null;
          return <InlineArtifact key={seg.artifact.id} artifact={seg.artifact} />;
        }
        // Round-6 UNIFY: a tool chain AND a thinking-only run both render through
        // ONE ActivityChain, so every thought gets the chain chrome (clock icon +
        // connector line + "Done ✓"). ONE shared counter keys both kinds, so a run
        // that starts thinking-only and later gains a tool call keeps the SAME
        // component instance (no remount → the expand/collapse rolls smoothly).
        // NO inline copy of a finished generated image here.
        //
        // This used to render one beneath the chain (round-5 #7), from before
        // image generation was a tool. Now the same picture arrives up to three
        // ways in one turn: this copy under "Done", the model embedding it in
        // its own reply (a model that has just made a picture says "I should
        // show it to the user" and puts it in the markdown), and the chain row
        // itself, which opens it in the canvas. the user saw it twice at 360px and
        // ~690px in the same turn.
        //
        // The row is the one that belongs to the tool and it opens the canvas,
        // so this copy goes. The model's own embed is capped to 414px in
        // markdown.css — 1.15x the card the picture was generated in.
        //
        // (What DOES sit beneath a chain now is decided per card below — the
        // newest result of a live chain, and the answers of a finished one;
        // see turn-cards.ts.)
        const segIndex = segments.indexOf(seg);
        const inside = new Map<string, ReactNode>();
        const beneath: ReactNode[] = [];
        for (const b of seg.blocks) {
          if (b.type !== 'toolCall') continue;
          const media = (mediaByCall.get(b.id) ?? []).filter((item) => !heldBack(item.path));
          const records = recordsByCall?.get(b.id) ?? [];
          const mediaIn = media.filter((item) => placeOf('m', b.id, item.path) === 'inside');
          const recordsIn = records.filter((r) => placeOf('r', b.id, r.path) === 'inside');
          if (mediaIn.length > 0 || recordsIn.length > 0) {
            inside.set(
              b.id,
              <>
                {mediaIn.length > 0 ? (
                  /* Named for the handover: the result that just came out from
                     under its generating card travels into this row. */
                  <div
                    style={
                      mediaIn.length === 1 && mediaIn[0] !== undefined
                        ? { viewTransitionName: handoverName(mediaIn[0].path) }
                        : undefined
                    }
                  >
                    <ThreadMedia items={mediaIn} />
                  </div>
                ) : null}
                {renderRecord === undefined
                  ? null
                  : recordsIn.map((r) => (
                      <CardSlot key={`rec:${r.path}`} home={homeFor(`r:${b.id}:${r.path}`)} />
                    ))}
              </>,
            );
          }

          /*
           * BENEATH THE CHAIN, IN THE ORDER THE CALLS WERE WRITTEN: a running
           * call's generating card, then a finished call's result — so a card
           * that is waiting and the card that replaces it hold one slot, and a
           * result never moves when it lands.
           *
           * THE GENERATING CARD STAYS OUT. the user: "these should be embedded in
           * thinking blocks, not the generating card, that stays out" — the
           * wait is the one thing the chain folding shut must never hide.
           *
           * Keyed by the call, so a generating card MOUNTS ONCE per
           * generation: it subscribes to the frame stream and drives its own
           * DOM, and a remount would replay its entrance animation mid-run.
           * The keys also keep it mounted while the results of EARLIER calls
           * leave this list for the chain.
           */
          const jobHere = runningJob !== null && runningJob.callId === b.id ? runningJob : null;
          if (jobHere !== null && jobHere.kind === 'svg') {
            /* The drawing, drawn live — see LiveSvgCard. */
            beneath.push(<LiveSvgCard key={`job:${b.id}`} callId={jobHere.callId} />);
          } else if (jobHere !== null && pendingKindFor(jobHere.kind) !== null) {
            /*
             * THE CARD THE RESULT WILL OCCUPY, mounted early — the same one the
             * studios use. No title, no clock, no Cancel: the row above says
             * what is being made, the composer's Stop stops it, and the one
             * line under the bar is the engine's own note or, before it has
             * said anything, how long this usually takes on this Mac. For an
             * image it wraps the live denoise, a far better proof of life than
             * any spinner.
             */
            beneath.push(
              <PendingMediaCard
                key={`job:${b.id}`}
                kind={pendingKindFor(jobHere.kind) as PendingKind}
                progressKey={jobHere.callId}
                /* The engine's own frames as they land: a picture's denoise
                   steps, a clip's rendered frames (HyperFrames names each). */
                live={jobHere.kind === 'image' || jobHere.kind === 'video'}
                label={`Generating ${jobHere.kind}`}
                edit={effectiveToolName(b.name, b.arguments) === 'edit_image'}
                note={
                  generating?.note ??
                  live3d?.note ??
                  jobView(
                    jobHere.kind,
                    Math.max(0, Date.now() - jobHere.startedAt),
                    estimateFor(jobHere.kind, jobSamples(jobHere.kind)),
                  ).estimate
                }
                {...(generating?.step !== undefined &&
                generating.total !== undefined &&
                generating.total > 0
                  ? { progress: generating.step / generating.total, steps: generating.total }
                  : live3d?.progress !== undefined
                    ? { progress: live3d.progress }
                    : {})}
                {...(generating?.aspect !== undefined ? { aspect: generating.aspect } : {})}
              />,
            );
          } else if (jobHere !== null) {
            beneath.push(
              <LongJobCard
                key={`job:${b.id}`}
                kind={jobHere.kind}
                startedAt={jobHere.startedAt}
                onCancel={() => void abortPi()}
                {...(generating?.note !== undefined ? { note: generating.note } : {})}
              />,
            );
          }
          /* The result, coming out from under the sweep — see `handing`. */
          if (handing !== null && handing.callId === b.id && handingLive && handingItem) {
            beneath.push(
              <div
                key={`hand:${b.id}`}
                style={{ viewTransitionName: handoverName(handingItem.path) }}
              >
                <PendingMediaCard
                  kind={pendingKindFor(handing.kind) ?? 'image'}
                  live={handing.kind === 'image' || handing.kind === 'video'}
                  item={handingItem}
                  /* The same job's number and shape, so the handover neither
                   restarts the pill nor reopens the frame square. */
                  progressKey={handing.callId}
                  edit={
                    effectiveToolName(
                      handingResult?.toolName,
                      callArgsFor(group, handing.callId),
                    ) === 'edit_image'
                  }
                  /* THE HANDOVER IS A RESIZE, NOT A JUMP. the user (2026-09-24): the
                   waiting card and the result should be "the same sizes and if
                   not there's a smooth animation for resizing". An un-presented
                   result files into its chain row at the chain's size
                   (turn-cards.ts), so the full-size card travels there under a
                   View Transition (the same name marks both boxes). */
                  onRevealed={() =>
                    withViewTransition(() =>
                      setRevealed((cur) => new Set([...cur, handingItem.path])),
                    )
                  }
                />
              </div>,
            );
          }
          /*
           * THE CHART, WHILE IT IS BEING MADE — a skeleton that builds as the
           * call's values stream, in the slot its finished card takes. It used
           * to hang after the whole reply with the rest of the presented cards;
           * it is a generating card like the others, so it stands beneath the
           * chain that is making it. (Not in the corp feed, which draws no
           * inline widgets at all — see `suppressInlineArtifacts`.)
           */
          /*
           * …AND THE DIAGRAM, WHILE IT IS BEING TYPED (PendingDiagramCard) —
           * from the call's first whole line of Mermaid, drawn by the tool's
           * own renderer and moving from frame to frame.
           *
           * Both step aside the moment the call's card is PRESENTED, not when
           * its answer lands: the card arrives a beat before the answer and
           * is filed under this call already (turn-cards.ts), so the one
           * takes the other's slot in the same frame — never two at once.
           */
          if (
            streaming &&
            !suppressInlineArtifacts &&
            !resultForBlock.has(b.id) &&
            records.length === 0
          ) {
            const args = pendingChartArgs(b);
            if (args !== null) {
              beneath.push(
                <div key={`chart:${b.id}`} className="flex flex-col gap-2" data-testid="presented">
                  <PendingChartCard args={{ ...args, id: b.id }} />
                </div>,
              );
            }
            const diagram = pendingDiagramArgs(b);
            if (diagram !== null && liveSource(diagram.source, diagram.sourceClosed) !== null) {
              beneath.push(
                <div
                  key={`diagram:${b.id}`}
                  className="flex flex-col gap-2"
                  data-testid="presented"
                >
                  <PendingDiagramCard callId={b.id} args={diagram} />
                </div>,
              );
            }
          }
          const mediaOut = media.filter((item) => placeOf('m', b.id, item.path) === 'beneath');
          if (mediaOut.length > 0) {
            foot.push(<ThreadMedia key={`media:${b.id}`} items={mediaOut} />);
          }
          for (const record of records) {
            if (renderRecord === undefined) break;
            if (placeOf('r', b.id, record.path) !== 'beneath') continue;
            // The card itself is drawn once, below, into this home.
            foot.push(
              <CardSlot key={`rec:${record.path}`} home={homeFor(`r:${b.id}:${record.path}`)} />,
            );
          }
        }
        return (
          <div key={`${groupId}-a${activityN++}`} className="flex min-w-0 flex-col gap-2">
            <ThreadActivityChain
              chainKey={`${groupId}-a${activityN - 1}`}
              blocks={seg.blocks}
              resultForBlock={resultForBlock}
              runningToolCalls={runningToolCalls}
              streaming={streaming && seg === lastSegment}
              // Whether the chain is DONE is a fact about the TURN, not about
              // this segment still being the last one — see `turnStreaming`.
              turnStreaming={streaming}
              turnStartedAt={group[0]?.timestamp}
              tps={tps}
              {...(onOpenFile !== undefined ? { onOpenFile } : {})}
              {...(inside.size > 0 ? { attachments: inside } : {})}
            />
            {/* Always mounted and box-less (`contents`): its children lay out
                in this column exactly as they did before it existed, and it is
                never torn down between one card leaving and the next arriving —
                which would remount a generating card mid-run. It exists so the
                cards beneath a chain can be found as such. */}
            <div
              className="contents"
              data-testid="turn-cards"
              data-live={segIndex === liveChain ? 'true' : undefined}
            >
              {beneath}
            </div>
          </div>
        );
      })}
      {/* The foot: always mounted and box-less, like the chains' card lists,
          so a card arriving never remounts its neighbours. */}
      <div className="contents" data-testid="turn-foot">
        {foot}
      </div>
      {errorText !== '' ? (
        // Defense-in-depth: never render a raw provider blob (an HTTP/JSON error)
        // in the chat — collapse it to a short human message. The provider already
        // emits clean text; this guards replayed transcripts + future paths. An
        // abort (pause/stop) cleaned to '' renders nothing.
        <div className="text-footnote text-status-danger-fg">{errorText}</div>
      ) : null}
      {!streaming && answered && !suppressInlineArtifacts ? (
        <SourcesCard arriving={sawStreaming.current} />
      ) : null}
      {/* Every presented card, drawn once into its home — which the place it
          stands now has adopted (CardSlot). With the call it came from, for a
          chart or diagram card taking over from its live one. */}
      {renderRecord === undefined
        ? null
        : shownRecords.map(({ key, callId, record }) =>
            createPortal(
              <PresentedCallContext.Provider value={callId}>
                {drawRecord(record)}
              </PresentedCallContext.Provider>,
              homeFor(key),
              key,
            ),
          )}
    </div>
  );
  return (
    <TurnSourcesProvider group={group} resultFor={resultForBlock}>
      <TurnCardsContext.Provider value={outside}>{body}</TurnCardsContext.Provider>
    </TurnSourcesProvider>
  );
}
