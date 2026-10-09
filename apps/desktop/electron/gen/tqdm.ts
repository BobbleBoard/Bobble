/**
 * A STEP COUNTER HIDING IN AN ENGINE'S LOG.
 *
 * Some workers report their denoise steps as structured `progress` events; others
 * (the image-edit path the user was using on 2026-09-24) only print tqdm to stderr —
 * `46%|████▋     | 11/24 [01:01<01:06,  5.08s/it]` — and that line reached the
 * card verbatim, under a sweeping bar with no number, which the user called "that
 * terminal logging style text". The counter was there the whole time.
 *
 * Only a STEP counter counts: two integers before the timing bracket. A download
 * ticker (`1.23G/2.67G [00:10<00:12, 120MB/s]`) carries units and is not a step,
 * and a line with carriage returns carries several frames of which only the last
 * is now.
 */
export interface TqdmStep {
  readonly step: number;
  readonly total: number;
}

const STEP_RE = /\|\s*(\d+)\/(\d+)\s*\[/;

export function parseTqdm(text: string): TqdmStep | undefined {
  const frames = text.split(/[\r\n]+/).filter((l) => l.trim().length > 0);
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const m = STEP_RE.exec(frames[i] as string);
    if (m === null) continue;
    const step = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0 || step > total)
      return undefined;
    return { step, total };
  }
  return undefined;
}
