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
 * as {@link MediaCard}, same radius. The mark plays at card scale inside the
 * frame.
 *
 * ## The ground and the number (2026-09-24)
 * the user, with ChatGPT's image card beside ours: "I don't actually think there is
 * a difference between the background color of the generation card and the chat
 * area, what I want here is for there to be a distinct black background card
 * that makes it feel raised, not lowered, but without a border, just quick but
 * noticeable falloff around the edge into the background color" — and "that
 * terminal logging style text below it needs to go, maybe just drop the entirety
 * of the bar and such, show a little bordered pill at the bottom right of the
 * image card that says n%". So the frame has a ground again (global.css), the
 * bar and the engine's line under it are gone, and the number is the pill in the
 * corner ({@link ProgressPill}). The frame is also exactly the box the finished
 * picture will take — it used to fall back to 330px when the job named no size,
 * which is why the waiting card was "significantly smaller than the images
 * generated".
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
import { rememberShape } from './media-shapes';
import {
  finish,
  type ProgressEstimate,
  percentLabel,
  report,
  shownAt,
  startEstimate,
} from './progress-estimate';
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
function RevealSurface({
  item,
  onAspect,
}: {
  item: ThreadMediaItem;
  /** The picture's real width / height, once it has decoded. */
  onAspect?: (aspect: number) => void;
}): JSX.Element {
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
      onLoad={(ev) => {
        const img = ev.currentTarget;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          const a = img.naturalWidth / img.naturalHeight;
          rememberShape(item.path, a);
          onAspect?.(a);
        }
      }}
    />
  );
}

/*
 * ONE NUMBER PER JOB, WHICHEVER CARD IS SHOWING IT. When the result lands the
 * thread swaps the waiting card for the one that sweeps the result in — a new
 * instance, which started its pill at 0% and never reached 100 (MEASURED at the
 * handover). The estimate lives here, keyed by the tool call, so the second card
 * carries on from the number the first one was showing and finishes it.
 */
const ESTIMATES = new Map<string, ProgressEstimate>();
/* …and its shape: by the time the result lands the running job is gone from the
   thread, so the card that sweeps it in cannot be told the aspect — it opened
   square and grew into the picture (MEASURED 362 → 482px at the handover). */
const SHAPES = new Map<string, number>();

/** A first guess at speed for the very start of a run — the last run's own. */
const PRIOR_KEY = (kind: PendingKind): string => `pd-progress-prior:${kind}`;
function priorFor(kind: PendingKind): number | undefined {
  try {
    const v = Number(localStorage.getItem(PRIOR_KEY(kind)));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}
function rememberPrior(kind: PendingKind, msPerUnit: number | undefined): void {
  if (msPerUnit === undefined || !Number.isFinite(msPerUnit) || msPerUnit <= 0) return;
  try {
    localStorage.setItem(PRIOR_KEY(kind), String(Math.round(msPerUnit)));
  } catch {
    /* private window or blocked storage: the next run just starts without a guess */
  }
}

/**
 * THE NUMBER, IN A PILL IN THE CARD'S CORNER.
 *
 * the user (2026-09-24): "that terminal logging style text below it needs to go,
 * maybe just drop the entirety of the bar and such, show a little bordered pill
 * at the bottom right of the image card that says n% and smoothly goes up". The
 * engine's steps are a staircase; `progress-estimate` turns them into a slope at
 * this run's measured speed without ever claiming a step before it is reported
 * (its rules, and why, are there).
 *
 * The number moves at display rate, so it is written straight into the pill's
 * text from its own frame loop: the card around it does not re-render sixty
 * times a second for a digit. It appears with the first real report (the phase
 * line says what the warm-up is doing; a 0% sitting through a 90-second cold
 * load would be exactly the stuck number he does not want), runs to 100 when the
 * result lands, and leaves with the reveal.
 */
function ProgressPill({
  kind,
  progress,
  done,
  label,
  progressKey,
  steps,
}: {
  kind: PendingKind;
  progress: number | undefined;
  done: boolean;
  label: string;
  /** The job this number belongs to — a later card for the same job continues it. */
  progressKey?: string;
  /** How many steps the engine counts, when it counts them. */
  steps?: number;
}): JSX.Element {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const est = useRef<ProgressEstimate | null>(
    progressKey === undefined ? null : (ESTIMATES.get(progressKey) ?? null),
  );
  const [seen, setSeen] = useState(est.current !== null);
  useEffect(() => {
    if (progress === undefined) return;
    const now = performance.now();
    const unit = steps !== undefined && steps > 0 ? 1 / steps : undefined;
    est.current = report(est.current ?? startEstimate(now, priorFor(kind)), progress, now, unit);
    setSeen(true);
  }, [progress, kind, steps]);
  useEffect(() => {
    if (!done || est.current === null) return;
    est.current = finish(est.current, performance.now());
    rememberPrior(kind, est.current.msPerUnit);
  }, [done, kind]);
  useEffect(() => {
    let raf = 0;
    let lastLabel = '';
    const tick = (): void => {
      const e = est.current;
      const el = textRef.current;
      if (e !== null && el !== null) {
        const { value, next } = shownAt(e, performance.now());
        est.current = next;
        if (progressKey !== undefined) ESTIMATES.set(progressKey, next);
        const text = percentLabel(value);
        if (text !== lastLabel) {
          lastLabel = text;
          el.textContent = text;
          el.parentElement?.setAttribute('aria-valuenow', String(Math.floor(value * 100)));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [progressKey]);
  /* A finished job's number is not needed once its card has shown 100. */
  useEffect(() => {
    if (!done || progressKey === undefined) return;
    const t = setTimeout(() => ESTIMATES.delete(progressKey), 4000);
    return () => clearTimeout(t);
  }, [done, progressKey]);
  return (
    <span
      className="pd-pending-pill"
      data-testid="pending-pct"
      data-visible={seen || done ? 'true' : undefined}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span ref={textRef}>{est.current === null ? '0%' : percentLabel(est.current.shown)}</span>
    </span>
  );
}

export function PendingMediaCard({
  kind,
  aspect,
  width,
  live,
  progress,
  label = 'Working',
  item,
  onRevealed,
  progressKey,
  steps,
}: {
  kind: PendingKind;
  /** width / height, as soon as the job says — the box takes it immediately. */
  aspect?: number;
  /** The requested width in px. The frame takes it, capped by the column the
   * same way the finished card is, so the handover changes nothing. */
  width?: number;
  /** 0..1 from the engine's own counter. Undefined → the bar sweeps instead. */
  progress?: number;
  /** What the engine last said it was doing. No longer printed — the user asked for
   * the engine's lines to go ("that terminal logging style text below it needs
   * to go"); kept so callers need not change, and for a future tooltip. */
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
  /** The job (tool call) this card shows — so the card that sweeps the result in
   * continues the waiting card's number rather than starting one of its own. */
  progressKey?: string;
  /** The engine's step count, when `progress` is steps / total. */
  steps?: number;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [swept, setSwept] = useState(false);
  /* The picture's own shape once it has decoded: a job that never said its size
     (an edit keeps its input's) still eases into the right box during the sweep,
     so the finished card that replaces this one lands on exactly this frame. */
  const [realAspect, setRealAspect] = useState<number | undefined>(undefined);
  const frameAspect =
    realAspect ?? aspect ?? (progressKey === undefined ? undefined : SHAPES.get(progressKey));
  useEffect(() => {
    if (progressKey !== undefined && frameAspect !== undefined)
      SHAPES.set(progressKey, frameAspect);
  }, [progressKey, frameAspect]);
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
      data-done={item !== undefined ? 'true' : undefined}
      data-swept={swept ? 'true' : undefined}
      data-testid="pending-media-card"
      aria-busy={swept ? undefined : 'true'}
    >
      <div
        ref={frameRef}
        className="pd-media-frame"
        style={
          {
            ...(frameAspect !== undefined && frameAspect > 0
              ? { '--pd-pending-aspect': String(frameAspect) }
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
            <RevealSurface item={item} onAspect={setRealAspect} />
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
            <ProgressPill
              kind={kind}
              progress={progress}
              done={item !== undefined}
              label={label}
              {...(progressKey !== undefined ? { progressKey } : {})}
              {...(steps !== undefined ? { steps } : {})}
            />
          </>
        )}
      </div>
    </figure>
  );
}
