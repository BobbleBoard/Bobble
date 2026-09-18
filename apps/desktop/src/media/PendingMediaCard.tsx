/**
 * THE CARD BEFORE THERE IS ANYTHING IN IT — which is the same card.
 *
 * the user, on the row this replaces (a thumbnail, a sentence about the engine, an
 * elapsed clock and a Stop button):
 *
 *   "no, but this type of card is not what I want, just the same final video
 *    card, same final image card, same final 3d card … just that container you
 *    have the animations in and then below it, just floating, a white progress
 *    bar … scaled to a rounded corner large square/rect so that by default it
 *    can simply smoothly fade out with one of the animations eg. the diagonal
 *    cascade when it's ready can do it's thing, but as it goes reveal the actual
 *    produced image/video/3d. seamless besides a quick smooth resize."
 *
 * So this is not a loading card that gets replaced by a result card. It IS the
 * result card, mounted early and empty: same `pd-media-card` / `pd-media-frame`
 * as {@link MediaCard}, same radius, same ground. The mark plays at card scale
 * inside the frame, and the only other thing on screen is a bare white bar
 * floating under it.
 *
 * ## The handover
 * When the result arrives it is mounted UNDERNEATH the still-running canvas and
 * the loader is told to exit. The closing sweep (`exitSceneAt`) takes the blocks
 * away along the user's diagonal, and the very same number (`exitReveal`, handed up
 * through `onSweep`) drives a mask that uncovers the picture along that line. One
 * value for both, so the edge the blocks leave and the edge the picture arrives
 * on are the same edge. Then `onRevealed` lets the owner swap in the real card —
 * by which point the pixels are already identical, so the swap has nothing left
 * to show.
 *
 * ## The resize
 * The frame takes the job's aspect ratio as soon as anything knows it, and
 * transitions between shapes. A 16:9 clip that loaded in a square box would jump
 * the column under the reader at the exact moment they are looking at the result;
 * the user allowed "a quick smooth resize", and this is it.
 */
import { type CSSProperties, type JSX, useEffect, useRef, useState } from 'react';
import { idleWave, peaksOf, WAVE_BUCKETS } from '../chat/audio-peaks';
import { BobbleLoader } from '../chat/BobbleLoader';
import type { LoaderVariant } from '../chat/bobble-anim';
import { pdFileUrl } from '../chat/canvas/file-preview';
import { ThreadAudio } from '../chat/ThreadAudio';
import type { ThreadMediaItem } from '../chat/thread-media';
import { subscribeToDenoise } from '../chat/useDenoisePreview';
import { ModelSurface } from './ModelSurface';
import { VideoSurface } from './VideoSurface';

/** What the finished thing will be — the same kinds {@link MediaCard} takes. */
export type PendingKind = 'image' | 'video' | 'model' | 'audio';

/**
 * WHAT THE CARD SAYS WHILE IT WAITS — the user (2026-09-14): "inside the card the
 * shining text similar to the 'thinking' or 'using a tool' shimmering text
 * that cycles between things like 'creating your image...' 'Drafting...'
 * 'Finalizing...' of course in a sensical order."
 *
 * The order is the job's own order. With the engine's step counter the phase
 * is READ off the fraction, so the words never run ahead of the work; without
 * one (the model still loading, a backend with no counter) the words advance
 * on a clock but stop short of the last phase, which only the result — or a
 * counter near the end — can earn. Never backwards.
 */
export const PENDING_PHASES: Record<PendingKind, readonly string[]> = {
  image: ['Warming up…', 'Creating your image…', 'Drafting…', 'Refining…', 'Finalizing…'],
  video: ['Warming up…', 'Creating your clip…', 'Drafting frames…', 'Refining…', 'Finalizing…'],
  model: ['Warming up…', 'Creating your model…', 'Shaping…', 'Texturing…', 'Finalizing…'],
  /* A strip, not a plate: three words that fit beside a waveform (the user,
     2026-09-17: the audio wait "needs reword so it makes sense and fits the
     dimensions and size of the card"). */
  audio: ['Warming up…', 'Composing…', 'Mixing…', 'Finishing…'],
};

/** The stand-in shape the pulsing bars hold before there is a sound. */
const IDLE_WAVE = idleWave(WAVE_BUCKETS);

/**
 * THE AUDIO WAIT IS A WAVEFORM. the user (2026-09-11): "for audio you can show some
 * pulsing waveforms that eventually at the end form into a real waveform
 * that's playable." The mark's board never fitted a 50px strip; this is the
 * transport's own box with its bars pulsing at a stand-in shape and the phrase
 * where the clock will be. When the clip lands the bars travel to its real
 * peaks (`data-state="resolved"`, the swell damping out under them), and then
 * the playable transport takes the same geometry — one card, two states.
 */
function AudioPending({
  phrase,
  item,
  onResolved,
}: {
  phrase: string;
  item: ThreadMediaItem | undefined;
  onResolved: () => void;
}): JSX.Element {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (item === undefined) return;
    const ac = new AbortController();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      // The bars' travel is 620ms (see .pd-audio-pending-bar); hand over after.
      setTimeout(onResolved, 680);
    };
    peaksOf(pdFileUrl(item.path), WAVE_BUCKETS, ac.signal)
      .then((p) => {
        setPeaks(p);
        finish();
      })
      /* A clip that will not decode still finished: hand over to the real
         transport rather than pulsing forever over a file that exists. */
      .catch(() => finish());
    return () => ac.abort();
  }, [item, onResolved]);
  const heights = peaks ?? IDLE_WAVE;
  return (
    <div
      className="pd-thread-audio pd-audio-pending"
      data-state={peaks === null ? 'pulsing' : 'resolved'}
      data-testid="audio-pending"
    >
      <span className="pd-thread-audio-play pd-audio-pending-play" aria-hidden="true" />
      <div className="pd-thread-audio-wave" data-testid="audio-pending-wave">
        {heights.map((h, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length bucket list
            key={i}
            className="pd-thread-audio-bar pd-audio-pending-bar"
            style={{
              height: `${Math.max(8, Math.round(h * 100))}%`,
              ['--pd-wv-i' as string]: String(i),
            }}
          />
        ))}
      </div>
      <span className="pd-audio-pending-phrase" data-testid="pending-phase" aria-live="polite">
        <span className="pd-shimmer">{phrase}</span>
      </span>
    </div>
  );
}

/** How long a phase holds when there is no counter to read it from. */
const PHASE_CLOCK_MS = 7000;

/**
 * The phase index for a job: from the fraction when there is one (the last
 * phase from 92% on), else from the clock — capped at the second-to-last so a
 * card with no counter never claims to be finalizing. Pure; monotone in both.
 */
export function pendingPhase(
  count: number,
  progress: number | undefined,
  elapsedMs: number,
  revealing: boolean,
): number {
  const last = count - 1;
  if (revealing) return last;
  if (progress !== undefined) {
    const f = Math.max(0, Math.min(1, progress));
    if (f >= 0.92) return last;
    if (f <= 0.01) return 0;
    // The middle phases share the 1%–92% run evenly.
    const middle = Math.max(1, count - 2);
    return 1 + Math.min(middle - 1, Math.floor(((f - 0.01) / 0.91) * middle));
  }
  return Math.min(last - 1, Math.floor(elapsedMs / PHASE_CLOCK_MS));
}

/** The loader act that belongs to each kind. */
const VARIANT: Record<PendingKind, LoaderVariant> = {
  image: 'image',
  video: 'video',
  model: '3d',
  audio: 'audio',
};

/**
 * The result, once there is one — the same surfaces the finished card mounts, so
 * what is uncovered here and what remains after the swap are the same element
 * type with the same src.
 *
 * Muted and autoplaying for video: the card is mid-reveal, and a play button
 * appearing from under the sweep is chrome arriving before the content has.
 */
function RevealSurface({ item }: { item: ThreadMediaItem }): JSX.Element {
  const src = pdFileUrl(item.path);
  if (item.kind === 'video') return <VideoSurface src={src} large={false} testid="pending-video" />;
  if (item.kind === 'model') return <ModelSurface src={src} testid="pending-model" />;
  /* Audio has no picture to uncover: the sweep clears the blocks and the
     transport is simply there, which is the same gesture with nothing behind it. */
  if (item.kind === 'audio') return <ThreadAudio src={src} name={item.name} />;
  return (
    <img
      className="pd-media-image"
      data-testid="pending-image"
      src={src}
      alt={item.name}
      draggable={false}
    />
  );
}

export function PendingMediaCard({
  kind,
  aspect,
  width,
  live,
  progress,
  note,
  label = 'Working',
  item,
  onRevealed,
}: {
  kind: PendingKind;
  /** width / height, as soon as the job says — the box takes it immediately. */
  aspect?: number;
  /** The requested width in px. The frame takes it, capped by the column the
   * same way the finished card is, so the handover changes nothing. */
  width?: number;
  /** 0..1 from the engine's own counter. Undefined → the bar sweeps instead. */
  progress?: number;
  /** What the engine last said it was doing. Shown only if there is no number. */
  note?: string;
  label?: string;
  /** The finished media. Its arrival is what starts the closing sweep. */
  item?: ThreadMediaItem;
  /**
   * Show the engine's own decoded steps as they arrive (the thread's live
   * denoise). The FIRST frame starts the sweep — the picture resolving is a
   * better answer than the mark once there is one — and later frames replace
   * it in place. Off for the studio, which has its own preview rail.
   */
  live?: boolean;
  /** Called once the sweep has cleared the board and the result is fully out. */
  onRevealed?: () => void;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [swept, setSwept] = useState(false);
  /*
   * THE LATEST DECODED STEP, when the engine sends them. Local state on
   * purpose: only this card re-renders when a frame lands (~1.3 s apart),
   * never the thread around it — the reason the old placeholder drove its DOM
   * by hand. The canvas effect's deps do not include this, so the loop is
   * untouched by a frame.
   */
  const [preview, setPreview] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (live !== true) return;
    let latest = -1;
    const off = subscribeToDenoise({
      onFrame: (_jobId, frame) => {
        if (frame.step <= latest) return;
        latest = frame.step;
        setPreview(frame.dataUri);
      },
      onDone: () => undefined,
    });
    return () => off?.();
  }, [live]);

  // The first thing that can be shown — the result, or a decoded step — is
  // what starts the sweep. After it the card is content, not a loader.
  const revealing = item !== undefined || preview !== undefined;

  /* Revealed means the RESULT is out from under a finished sweep — whether the
     sweep ran over the result itself or over a step preview the result then
     replaced. One place decides that, once. */
  const revealedRef = useRef(false);
  useEffect(() => {
    if (!swept || item === undefined || revealedRef.current) return;
    revealedRef.current = true;
    onRevealed?.();
  }, [swept, item, onRevealed]);

  const pct =
    progress === undefined ? undefined : Math.round(Math.max(0, Math.min(1, progress)) * 100);

  /* The phase line's clock, ticking only while there is no counter to read. */
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (progress !== undefined || revealing) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAt.current), 1000);
    return () => clearInterval(id);
  }, [progress, revealing]);
  const phases = PENDING_PHASES[kind];
  /* Never backwards: a counter that dips (a second candidate starting) or a
     clock that resets keeps the furthest phrase the card has already said. */
  const furthest = useRef(0);
  const phaseNow = pendingPhase(phases.length, progress, elapsed, revealing);
  if (phaseNow > furthest.current) furthest.current = phaseNow;
  const phrase = phases[furthest.current] ?? phases[0] ?? '';

  return (
    <figure
      className="pd-media-card pd-media-card--pending"
      data-kind={kind}
      data-revealing={revealing ? 'true' : undefined}
      data-swept={swept ? 'true' : undefined}
      data-testid="pending-media-card"
      aria-busy={swept ? undefined : 'true'}
    >
      <div
        ref={frameRef}
        className="pd-media-frame"
        style={
          {
            ...(aspect !== undefined && aspect > 0
              ? { '--pd-pending-aspect': String(aspect) }
              : {}),
            ...(width !== undefined && width > 0 ? { '--pd-pending-w': `${width}px` } : {}),
          } as CSSProperties
        }
      >
        {/* Underneath from the moment it exists, so the sweep uncovers something
            that is already laid out and decoded rather than mounting a fresh
            element into the hole the blocks just left. */}
        {item !== undefined && (kind !== 'audio' || swept) ? (
          <div className="pd-pending-reveal">
            <RevealSurface item={item} />
          </div>
        ) : preview !== undefined ? (
          <div className="pd-pending-reveal">
            {/* A step, not the picture: the same layer, so the sweep uncovers it
                the same way, and the finished file replaces it in place. */}
            <img
              className="pd-media-image"
              data-testid="pending-preview"
              src={preview}
              alt=""
              draggable={false}
            />
          </div>
        ) : null}
        {kind === 'audio' ? (
          swept ? null : (
            <AudioPending phrase={phrase} item={item} onResolved={() => setSwept(true)} />
          )
        ) : (
          <>
            {/* The phase, shimmering like a thought — at the top, inside the frame,
                and gone with the loader the moment the picture starts to show. */}
            {revealing ? null : (
              <div className="pd-pending-phase" data-testid="pending-phase" aria-live="polite">
                <span className="pd-shimmer">{phrase}</span>
              </div>
            )}
            <BobbleLoader
              fill
              bare
              variant={VARIANT[kind]}
              label={label}
              exit={revealing}
              onSweep={(p) => {
                /* Straight onto the element: this runs at display rate, and putting
                   a mask position through React state would re-render the card a
                   hundred times during a one-second reveal. */
                frameRef.current?.style.setProperty('--pd-pending-sweep', p.toFixed(4));
              }}
              onExitDone={() => setSwept(true)}
            />
            {/* The soft edge a waiting picture wears — see .pd-pending-falloff. */}
            <div className="pd-pending-falloff" aria-hidden="true" />
          </>
        )}
      </div>
      {/*
        THE BAR, AND NOTHING ELSE. No title (the prompt is already above), no
        elapsed clock, no Stop — the user asked for "just floating, a white progress
        bar". It leaves as soon as the sweep starts, because by then the card is
        showing the answer rather than waiting for it.
      */}
      <div
        className="pd-pending-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        {...(pct === undefined ? {} : { 'aria-valuenow': pct })}
      >
        <div
          className="pd-pending-fill"
          data-indeterminate={pct === undefined ? 'true' : undefined}
          style={pct === undefined ? undefined : { width: `${pct}%` }}
        />
      </div>
      {/* The number when there is an honest one — the user: "a progressbar at the
          bottom with % otherwise loading is good". Kept to one short line so the
          card stays the card and not a status panel. */}
      <span className="pd-pending-pct" data-testid="pending-pct">
        {pct === undefined ? (note ?? 'Loading') : `${pct}%`}
      </span>
    </figure>
  );
}
