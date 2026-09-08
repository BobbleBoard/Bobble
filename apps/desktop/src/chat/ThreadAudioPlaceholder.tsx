/**
 * The card a sound occupies while it is still being made.
 *
 * the user: "for audio you can show some pulsing waveforms that eventually at the
 * end form into a real waveform that's playable."
 *
 * So it is one card in two states, not two cards:
 *
 *  1. PULSING. Ninety-six bars at a stand-in shape, with a slow swell running
 *     along them. It is deliberately smooth and symmetrical — a stand-in must
 *     not be mistakable for a measurement — and it is the same bar count, the
 *     same gap and the same box the finished transport uses, so nothing moves
 *     sideways later.
 *  2. RESOLVING. The moment the engine names the file it produced, the clip is
 *     decoded and every bar travels from its stand-in height to its real peak.
 *     Then the tool result lands, {@link MediaCard} mounts the playable
 *     transport over the same geometry, and it settles rather than appears.
 *
 * WHY IT WEARS THE MEDIA CARD'S OWN CLASSES. The point of the exercise is that
 * the thing you wait for and the thing you get are the same object. Reusing
 * `.pd-media-frame` / `.pd-thread-audio` rather than styling a lookalike is what
 * makes that true under every future change to either — a bespoke placeholder
 * agrees with the card exactly once, on the day it is written.
 *
 * Under `prefers-reduced-motion` the swell stops and the bars simply sit at
 * their stand-in heights. The resolve still happens: that is content arriving,
 * not decoration.
 */
import { type JSX, useEffect, useState } from 'react';
import { idleWave, peaksOf, WAVE_BUCKETS } from './audio-peaks';

const IDLE = idleWave(WAVE_BUCKETS);

export function ThreadAudioPlaceholder({
  /** The finished clip, once the engine has one — what the bars resolve onto. */
  resolveSrc,
  label = 'Generating audio',
}: {
  resolveSrc?: string | undefined;
  label?: string;
}): JSX.Element {
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    if (resolveSrc === undefined || resolveSrc === '') return;
    const ac = new AbortController();
    peaksOf(resolveSrc, WAVE_BUCKETS, ac.signal)
      .then(setPeaks)
      /* A clip that will not decode still finished; the bars just stay where
         they are and the real transport arrives a moment later. Never let the
         picture of the sound become a failure state. */
      .catch(() => undefined);
    return () => ac.abort();
  }, [resolveSrc]);

  const heights = peaks ?? IDLE;
  const resolved = peaks !== null;

  return (
    <figure
      className="pd-media-card"
      data-kind="audio"
      data-testid="audio-placeholder"
      data-state={resolved ? 'resolved' : 'pulsing'}
      aria-label={label}
      aria-busy={resolved ? undefined : 'true'}
    >
      <div className="pd-media-frame">
        <div className="pd-thread-audio pd-audio-pending">
          {/*
            The transport's own button, held open and inert. There is nothing to
            play yet, so it does not offer to — but the space it will occupy is
            the space it occupies now, which is what keeps the waveform beside it
            from shifting when the real card arrives.
          */}
          <span className="pd-thread-audio-play pd-audio-pending-play" aria-hidden="true" />
          <div className="pd-thread-audio-wave" data-testid="audio-pending-wave">
            {heights.map((h, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length bucket list
                key={i}
                className="pd-thread-audio-bar pd-audio-pending-bar"
                style={{
                  height: `${Math.max(8, Math.round(h * 100))}%`,
                  // The swell travels along the row; a small negative step per
                  // bar is what makes it a wave rather than a whole row breathing.
                  ['--pd-wv-i' as string]: String(i),
                }}
              />
            ))}
          </div>
          <span className="pd-thread-audio-time tabular-nums">--:--</span>
        </div>
      </div>
    </figure>
  );
}
