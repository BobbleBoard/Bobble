/**
 * A GENERATED CLIP, WITH A TRANSPORT THIS APP DREW.
 *
 * The native `<video controls>` bar was fine and is not what the user asked for: it
 * looks like nothing else in the app, it sizes itself differently per platform,
 * and it takes the keyboard on its own terms. A card that appears both in a
 * studio and in the middle of a conversation has to behave the same in both, and
 * the transport is most of what "behaves" means for a clip.
 *
 * THE KEYS ARE THE POINT (the user's spec, verbatim in behaviour):
 *
 *   Space, K        play / pause
 *   ← / →           back / forward 5 seconds
 *   J / L           back / forward 10 seconds
 *
 * They are bound to the PLAYER, not the window. A global handler would eat the
 * spacebar while someone is typing a prompt two hundred pixels below — this only
 * listens while the surface itself has focus, or while the expanded view is up
 * and nothing else can have it.
 */
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { clockTime } from '../chat/thread-media';

export interface VideoSurfaceProps {
  readonly src: string;
  /** Larger transport + always-visible controls, for the expanded view. */
  readonly large?: boolean;
  readonly testid?: string;
}

/** The seek a key asks for, in seconds. Null for keys we do not own. */
export function seekForKey(key: string): number | 'toggle' | null {
  switch (key) {
    case ' ':
    case 'Spacebar':
    case 'k':
    case 'K':
      return 'toggle';
    case 'ArrowLeft':
      return -5;
    case 'ArrowRight':
      return 5;
    case 'j':
    case 'J':
      return -10;
    case 'l':
    case 'L':
      return 10;
    default:
      return null;
  }
}

export function VideoSurface({ src, large = false, testid }: VideoSurfaceProps): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(0);

  const toggle = useCallback((): void => {
    const v = ref.current;
    if (v === null) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const nudge = useCallback((by: number): void => {
    const v = ref.current;
    if (v === null || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + by));
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      /*
       * NOT WHEN A CONTROL OWNS THE KEY. Focus on the scrubber makes ← a range
       * decrement, and focus on Play makes Space a click — intercepting those
       * would fire both the control's action and ours, so a single arrow press
       * would seek twice. The shortcuts belong to the picture.
       */
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'BUTTON') return;
      const want = seekForKey(e.key);
      if (want === null) return;
      // Only OUR keys are swallowed; Tab, Escape and everything else still
      // reach whatever is listening for them.
      e.preventDefault();
      e.stopPropagation();
      if (want === 'toggle') toggle();
      else nudge(want);
    },
    [toggle, nudge],
  );

  useEffect(() => {
    const v = ref.current;
    if (v === null) return;
    const sync = (): void => {
      setPlaying(!v.paused);
      setAt(v.currentTime);
      if (Number.isFinite(v.duration)) setTotal(v.duration);
    };
    for (const ev of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ended']) {
      v.addEventListener(ev, sync);
    }
    return () => {
      for (const ev of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ended']) {
        v.removeEventListener(ev, sync);
      }
    };
  }, []);

  const pct = total > 0 ? (at / total) * 100 : 0;

  return (
    /*
     * The wrapper is the keyboard target, not the <video>: the transport row
     * below is part of the same instrument, and focus that jumps between the
     * picture and its buttons would make ← mean two different things depending
     * on where you last clicked.
     */
    /*
     * The handler is on a plain wrapper because it is a RELAY, not an
     * interaction: every key it forwards belongs to the <video> that has focus
     * inside it, and every control here is separately reachable. The rule
     * assumes a handler on a div is a control someone cannot reach.
     */
    // biome-ignore lint/a11y/noStaticElementInteractions: relays keys to the focused <video> inside.
    <div
      className="pd-media-video"
      data-large={large ? 'true' : undefined}
      data-testid={testid}
      /*
       * The handler is HERE and the tab stop is on the <video> below.
       *
       * Keydowns bubble, so this still sees them wherever inside the player
       * they happened — but the focusable element is the video itself, which is
       * interactive content and can legally hold a tab stop. Putting the stop on
       * this wrapper instead meant claiming a role for it, and there is no role
       * that is honestly "a video and its transport".
       */
      onKeyDown={onKeyDown}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: a generated clip has no caption track to offer. */}
      <video
        ref={ref}
        className="pd-media-video-el"
        data-testid="media-video-el"
        src={src}
        preload="metadata"
        playsInline
        tabIndex={0}
        onClick={toggle}
      />
      <div className="pd-media-transport">
        <button
          type="button"
          className="pd-media-play pd-focusable"
          data-testid="media-play"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={toggle}
        >
          {playing ? <GlyphPause /> : <GlyphPlay />}
        </button>
        {/*
          A range input rather than a drawn bar: scrubbing is a drag with a
          keyboard equivalent and a screen-reader value, and re-implementing all
          three to look 4px different is not worth what it costs.
        */}
        <input
          className="pd-media-scrub pd-focusable"
          data-testid="media-scrub"
          type="range"
          min={0}
          max={Math.max(0.01, total)}
          step={0.01}
          value={at}
          aria-label="Seek"
          style={{ ['--pd-media-pct' as string]: `${pct}%` }}
          onChange={(e) => {
            const v = ref.current;
            if (v !== null) v.currentTime = Number(e.target.value);
          }}
        />
        <span className="pd-media-time" data-testid="media-time">
          {clockTime(at)} / {clockTime(total)}
        </span>
      </div>
    </div>
  );
}

function GlyphPlay(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <title>Play</title>
      <path d="M5 3.2l8 4.8-8 4.8z" fill="currentColor" />
    </svg>
  );
}

function GlyphPause(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <title>Pause</title>
      <rect x="4" y="3.2" width="3" height="9.6" rx="1" fill="currentColor" />
      <rect x="9" y="3.2" width="3" height="9.6" rx="1" fill="currentColor" />
    </svg>
  );
}
