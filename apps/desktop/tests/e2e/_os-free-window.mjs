/**
 * WHAT THE OS SAID AROUND A READING, not one look after it.
 *
 * guardian-reading-probe.mjs checks that the guardian's graded figure is the
 * OS's own. It used to compare it with ONE look at the OS taken after the
 * window heard about the reading. On a quiet machine that is the same number.
 * Beside a heavy job it is not, and every lane of the push shares this Mac
 * with one: SEEN 2026-09-23, an image generation running in another worktree,
 * the guardian quoted 55% free and the look taken a moment later said 65%.
 * The reading was right; the machine had moved.
 *
 * So the OS is traced for the whole wait, and the quoted figure is held
 * against what it said in the seconds around the reading. On a quiet machine
 * that span is a point or two wide and the check is as tight as before. A
 * figure the OS never said in that span (the page-cache fiction `os.freemem()`
 * is on a Mac, a /proc that was not read) still fails.
 */

/**
 * Look at the OS every `everyMs` until stopped.
 *
 * `read` answers a percentage, or undefined when it cannot tell; those looks
 * are not kept. The first look is taken at once, so a trace started just
 * before a reading has a sample from before it.
 */
export function startOsFreeTrace(read, { everyMs = 100, now = Date.now } = {}) {
  const samples = [];
  const look = () => {
    const pct = read();
    if (typeof pct === 'number' && Number.isFinite(pct)) samples.push({ at: now(), pct });
  };
  look();
  const timer = setInterval(look, everyMs);
  // A trace nobody stopped (the probe threw mid-wait) must not keep the probe,
  // and the lock slot it holds, alive after the app is closed.
  timer.unref?.();
  return {
    samples,
    stop: () => clearInterval(timer),
  };
}

/**
 * Did the OS say `quoted` (within `slack` points) around `at`?
 *
 * The span is `beforeMs` before `at` — the reading is taken before the window
 * hears of it — to `afterMs` after. Answers the span's range and how many
 * looks fell in it, so a failure can say what the OS did say.
 */
export function quotedMatchesOs(
  quoted,
  samples,
  at,
  { beforeMs = 2000, afterMs = 500, slack = 5 } = {},
) {
  const inSpan = samples.filter((s) => s.at >= at - beforeMs && s.at <= at + afterMs);
  if (inSpan.length === 0) return { ok: false, n: 0, lo: undefined, hi: undefined };
  const pcts = inSpan.map((s) => s.pct);
  const lo = Math.min(...pcts);
  const hi = Math.max(...pcts);
  return { ok: quoted >= lo - slack && quoted <= hi + slack, n: inSpan.length, lo, hi };
}
