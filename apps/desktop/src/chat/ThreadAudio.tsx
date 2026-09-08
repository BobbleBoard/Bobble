/**
 * A generated sound, playable where it was made.
 *
 * WHY A CUSTOM TRANSPORT AND NOT `<audio controls>`. The native control is a
 * grey pill that looks like nothing else in this app, sizes itself differently
 * on every platform, and — the real problem — shows a *progress bar*, which
 * tells you where you are and nothing about what the sound IS. A four-second
 * door slam and four seconds of silence are the same rectangle.
 *
 * The waveform is the point: it makes the clip legible at a glance, so a row of
 * three SFX candidates can be compared without playing all three. It is drawn
 * from the decoded samples rather than faked, because a fake one is worse than
 * none — it would imply information it does not have.
 *
 * DECODE IS BEST-EFFORT. A file that fails to decode still plays; it just falls
 * back to a plain bar. Never let the picture of the sound stop the sound.
 */
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { peaksOf, WAVE_BUCKETS } from './audio-peaks';
import { clockTime } from './thread-media';

/*
 * THE DECODE LIVES IN audio-peaks.ts NOW. The generating card draws the same
 * waveform from the same measurement as it resolves (the user: "pulsing waveforms
 * that eventually at the end form into a real waveform that's playable"), and
 * two copies of the bucketing would put the bars in two different places at the
 * one moment the two cards have to agree.
 */
const BUCKETS = WAVE_BUCKETS;

export function ThreadAudio({ src, name }: { src: string; name?: string }): JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);

  useEffect(() => {
    const ac = new AbortController();
    peaksOf(src, BUCKETS, ac.signal)
      .then(setPeaks)
      .catch(() => setPeaks(null));
    return () => ac.abort();
  }, [src]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (el === null) return;
    if (el.paused) void el.play();
    else el.pause();
  }, []);

  /** Click anywhere on the waveform to seek there. */
  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (el === null || !Number.isFinite(el.duration)) return;
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
    el.currentTime = ratio * el.duration;
  }, []);

  const progress = duration !== undefined && duration > 0 ? at / duration : 0;

  return (
    <div className="pd-thread-audio" data-testid="thread-audio">
      <button
        type="button"
        className="pd-thread-audio-play pd-focusable"
        aria-label={playing ? 'Pause' : 'Play'}
        data-testid="thread-audio-play"
        onClick={toggle}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <title>Pause</title>
            <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
            <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <title>Play</title>
            <path
              d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.2-4.8a.6.6 0 0 0 0-1l-7.2-4.8A.6.6 0 0 0 5 3.2Z"
              fill="currentColor"
            />
          </svg>
        )}
      </button>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the play button above is
          the keyboard affordance; this is a pointer-only seek surface. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same reason. */}
      <div
        className="pd-thread-audio-wave"
        data-testid="thread-audio-wave"
        /* SETTLE, don't appear. The pulsing placeholder that was here a moment
           ago had bars in these exact positions; growing them into their real
           heights makes the swap read as the wave resolving rather than as one
           card being replaced by another. See .pd-thread-audio-wave[data-settle]. */
        data-settle={peaks === null ? undefined : 'true'}
        onClick={seek}
        style={{ ['--pd-wave-progress' as string]: String(progress) }}
      >
        {peaks === null ? (
          <div className="pd-thread-audio-flat" />
        ) : (
          peaks.map((p, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length bucket list
              key={i}
              className="pd-thread-audio-bar"
              data-on={i / BUCKETS <= progress ? 'true' : undefined}
              // A floor so silence is still a visible line rather than a gap —
              // a waveform with holes in it reads as a broken render.
              style={{ height: `${Math.max(8, Math.round(p * 100))}%` }}
            />
          ))
        )}
      </div>

      <span className="pd-thread-audio-time tabular-nums">
        {clockTime(at)} / {clockTime(duration)}
      </span>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        aria-label={name ?? 'Generated audio'}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
      >
        <track kind="captions" />
      </audio>
    </div>
  );
}
