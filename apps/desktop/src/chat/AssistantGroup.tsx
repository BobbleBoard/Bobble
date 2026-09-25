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
import {
  type AssistantMsg,
  type ContentBlock,
  cleanErrorText,
  type ToolResultMsg,
} from '@pi-desktop/engine';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type PendingKind, PendingMediaCard } from '../media/PendingMediaCard';
import { abortPi } from '../state/pi-connect';
import { segmentGroup } from './activity-mapping';
import { InlineArtifact } from './canvas/InlineArtifacts';
import { useGeneratingJob, useModel3dLive } from './GeneratingMedia';
import { jobSamples, recordJobDuration } from './job-history';
import { LiveSvgCard } from './LiveSvgCard';
import { LongJobCard } from './LongJobCard';
import { effectiveToolName, estimateFor, type JobKind, jobKindForTool, jobView } from './long-job';
import { Markdown } from './markdown';
import { ThreadActivityChain } from './ThreadActivity';
import { ThreadMedia } from './ThreadMedia';
import { mediaFromToolResult, type ThreadMediaItem } from './thread-media';

/**
 * The media a chain segment's generate-tool calls produced.
 *
 * Reads the tool RESULTS rather than the calls: a call that is still running,
 * or that failed, has produced nothing to show, and mounting a player for it
 * would be a broken box in the transcript.
 */
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

function mediaForSegment(
  seg: { kind: string; blocks?: readonly ContentBlock[] },
  resultForBlock: Map<string, ToolResultMsg>,
): ThreadMediaItem[] {
  if (seg.kind !== 'chain' || seg.blocks === undefined) return [];
  const out: ThreadMediaItem[] = [];
  for (const b of seg.blocks) {
    if (b.type !== 'toolCall') continue;
    const result = resultForBlock.get(b.id);
    if (result === undefined) continue;
    // A `bash media generate …` result is the generation tool's result.
    const toolName = effectiveToolName(result.toolName, b.arguments);
    out.push(...mediaFromToolResult(toolName, result.text, result.isError));
  }
  return out;
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
  const rawError = group.find((m) => m.errorMessage !== undefined)?.errorMessage;
  // Clean once: a raw provider blob collapses to a short message, and a
  // user-initiated pause/stop ("aborted"/AbortError) collapses to '' — a clean
  // end renders NOTHING (never a red error row).
  const errorText = rawError !== undefined ? cleanErrorText(rawError) : '';
  let textN = 0;
  let activityN = 0;
  return (
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
        // While an image is being generated its card is NOT empty: the same box
        // the finished picture will occupy shows the model's own intermediate
        // decodes, resolving live (ThreadImagePlaceholder). It renders in the
        // chain that owns the pending call, which is where the finished image
        // would appear, so the swap happens in place.
        const jobHere =
          runningJob !== null &&
          seg.kind === 'chain' &&
          seg.blocks.some((b) => b.type === 'toolCall' && b.id === runningJob?.callId)
            ? runningJob
            : null;
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
            />
            {/* Deliberately unkeyed and rendered from a stable position: the
                placeholder subscribes to the frame stream itself and drives its
                own DOM, so it must MOUNT ONCE per generation. Remounting it
                would replay its entrance animation mid-run. */}
            {/*
              THE WAIT, WITH WORDS ON IT.

              The card wraps whatever the job itself can show — for an image
              that is the live denoise, which is a far better proof of life than
              any spinner. For a video or a 3D build there is nothing to show,
              and the card is all there is: the title, "usually N minutes on
              this Mac", a clock that moves, and a Cancel.

              Same segment test as the image preview so the card sits in the
              chain that started the work, and the finished result replaces it
              in place.
            */}
            {jobHere !== null && jobHere.kind === 'svg' ? (
              /* The drawing, drawn live — see LiveSvgCard. */
              <LiveSvgCard callId={jobHere.callId} />
            ) : jobHere !== null && pendingKindFor(jobHere.kind) !== null ? (
              /*
               * THE CARD THE RESULT WILL OCCUPY, mounted early — the same one the
               * studios use. No title, no clock, no Cancel: the row above says
               * what is being made, the composer's Stop stops it, and the one
               * line under the bar is the engine's own note or, before it has
               * said anything, how long this usually takes on this Mac.
               */
              <PendingMediaCard
                kind={pendingKindFor(jobHere.kind) as PendingKind}
                progressKey={jobHere.callId}
                /* The engine's own frames as they land: a picture's denoise
                   steps, a clip's rendered frames (HyperFrames names each). */
                live={jobHere.kind === 'image' || jobHere.kind === 'video'}
                label={`Generating ${jobHere.kind}`}
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
                  ? { progress: generating.step / generating.total }
                  : live3d?.progress !== undefined
                    ? { progress: live3d.progress }
                    : {})}
                {...(generating?.aspect !== undefined ? { aspect: generating.aspect } : {})}
              />
            ) : jobHere !== null ? (
              <LongJobCard
                kind={jobHere.kind}
                startedAt={jobHere.startedAt}
                onCancel={() => void abortPi()}
                {...(generating?.note !== undefined ? { note: generating.note } : {})}
              />
            ) : null}
            {/* The result, coming out from under the sweep — see `handing`. */}
            {handing !== null &&
            handingLive &&
            handingItem !== undefined &&
            seg.kind === 'chain' &&
            seg.blocks.some((b) => b.type === 'toolCall' && b.id === handing.callId) ? (
              <PendingMediaCard
                kind={pendingKindFor(handing.kind) ?? 'image'}
                live={handing.kind === 'image' || handing.kind === 'video'}
                item={handingItem}
                /* The same job's number and shape, so the handover neither
                   restarts the pill nor reopens the frame square. */
                progressKey={handing.callId}
                onRevealed={() => setRevealed((cur) => new Set([...cur, handingItem.path]))}
              />
            ) : null}
            {/* WHAT THE TURN MADE, under the chain that made it. Generated
                images used to reach the thread only as a 414px markdown embed
                and generated audio/video only as a path in prose; the user wants
                every produced file embedded at full quality with a card to
                reveal it. Keyed off the tool RESULT, so it appears when the
                file exists rather than when the model mentions one. */}
            <ThreadMedia
              items={mediaForSegment(seg, resultForBlock).filter(
                (item) => !(handingLive && item.path === handingItem?.path),
              )}
            />
          </div>
        );
      })}
      {errorText !== '' ? (
        // Defense-in-depth: never render a raw provider blob (an HTTP/JSON error)
        // in the chat — collapse it to a short human message. The provider already
        // emits clean text; this guards replayed transcripts + future paths. An
        // abort (pause/stop) cleaned to '' renders nothing.
        <div className="text-footnote text-status-danger-fg">{errorText}</div>
      ) : null}
    </div>
  );
}
