/**
 * THE GUARD'S REASON, IN WORDS.
 *
 * The guardian explains itself in its own measurements — "the machine is
 * swapping hard (10643 pages/s) with 9% of memory free — paused for 20
 * readings and it did not come back" — which is right for the log and wrong
 * for a banner a person reads (SEEN 2026-10-09 over a chat that was rendering
 * a Blender scene). The cause stays; the counters and the mechanism go.
 */
export function plainPressure(reason: string): string {
  const base = reason
    .replace(/\s+—\s+paused for \d+ readings and it did not come back$/, '')
    .trim();
  const pct = /(\d+)% (?:of memory (?:is )?)?free/.exec(base)?.[1];
  const free = pct !== undefined ? `only ${pct}% of memory is free` : 'memory is low';
  if (/swapping/.test(base)) return `your Mac is moving memory to disk, and ${free}`;
  if (/stalled/.test(base)) return `the app stopped responding for a moment, and ${free}`;
  if (/critical memory pressure/.test(base)) return 'macOS says memory is critically low';
  if (/memory pressure|of memory is free|% free/.test(base)) return free;
  return base;
}
