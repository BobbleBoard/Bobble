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
        {item !== undefined ? (
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
