/**
 * THE SHAPE OF A SOUND — decoded once, drawn by whoever needs it.
 *
 * This was inside `ThreadAudio`, which was fine while the finished transport was
 * the only thing that drew a waveform. The generating card draws one too: the user
 * asked for "pulsing waveforms that eventually at the end form into a real
 * waveform that's playable", and "the real waveform" has to be the SAME
 * measurement the transport will show a moment later, or the bars visibly
 * rearrange at the handoff instead of settling.
 *
 * One decoder, one bucket count, one normalisation — so the wave that resolves
 * and the wave you then play are the same picture.
 */

/**
 * How many bars a waveform is drawn with.
 *
 * Shared, and load-bearing: the pulsing placeholder and the finished transport
 * must have the same number of bars in the same places, because the transition
 * between them is a height change on bars that never move.
 */
export const WAVE_BUCKETS = 96;

/** Peak amplitude per bucket, 0..1, from the decoded PCM. */
export async function peaksOf(
  url: string,
  buckets: number,
  signal: AbortSignal,
): Promise<number[]> {
  const res = await fetch(url, { signal });
  const bytes = await res.arrayBuffer();
  // `AudioContext` is only needed to decode; it is closed immediately after.
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  try {
    const buf = await ctx.decodeAudioData(bytes);
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / buckets));
    const out: number[] = [];
    let max = 0;
    for (let b = 0; b < buckets; b++) {
      let peak = 0;
      const start = b * per;
      for (let i = start; i < start + per && i < data.length; i++) {
        const v = Math.abs(data[i] ?? 0);
        if (v > peak) peak = v;
      }
      out.push(peak);
      if (peak > max) max = peak;
    }
    // Normalise so a quiet clip is still readable — the shape matters here, not
    // the absolute level, which the file's own gain already decided.
    return max > 0 ? out.map((p) => p / max) : out;
  } finally {
    void ctx.close();
  }
}

/**
 * The resting height of each bar in the PULSING placeholder, 0..1.
 *
 * Deliberately not a sine and not random-per-render: a sine reads as an
 * equaliser demo and `Math.random()` re-rolls on every re-render, which makes
 * the bars twitch sideways in a wave that is supposed to be travelling along
 * them. This is a small sum of incommensurable sines — smooth, aperiodic across
 * the visible span, and identical every time it is computed, so the animation is
 * the only thing that moves.
 *
 * It is a stand-in and says so by being symmetrical about the middle and never
 * touching either extreme: nobody should mistake it for a measurement.
 */
export function idleWave(buckets: number = WAVE_BUCKETS): number[] {
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const t = i / Math.max(1, buckets - 1);
    const shape =
      0.5 + 0.28 * Math.sin(t * Math.PI * 6.0) + 0.16 * Math.sin(t * Math.PI * 13.7 + 1.1);
    // An envelope that fades both ends, so the block of bars reads as a clip
    // with a beginning and an end rather than as a bar chart.
    const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.55;
    out.push(Math.max(0.1, Math.min(0.92, shape * (0.45 + 0.55 * envelope))));
  }
  return out;
}
