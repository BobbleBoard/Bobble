/**
 * ONE CLOCK FOR ONE WAIT, wherever it is shown.
 *
 * The boot wait moved out of the pill above the composer and into the middle of
 * the top bar (the user: "remove the 'starting up' pill and put it instead in the
 * top bar centered ... between new chat and canvas controls/advanced
 * settings"). The clock had to come with it — and it cannot be duplicated,
 * because it does not only count: when the wait ends it RECORDS how long it
 * took, and two copies would record every boot twice and skew "usually about 8s
 * on this Mac" downward forever.
 */
import { useEffect, useRef, useState } from 'react';
import { recordBootWait } from './boot-history';

/**
 * Milliseconds in the current wait, and — when it ends — how long it took.
 *
 * The clock is what makes the spinner honest ("the changing digits are what
 * reassures me"), and finishing is where the estimate for NEXT time comes from,
 * so both live in one hook: it counts up, then writes the result down.
 */
/** A blink shorter than this is the same wait resuming, not a new one. */
const SAME_WAIT_GAP_MS = 2500;

export function useWaitClock(stage: 'loading' | 'preparing' | null): number | null {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const prev = useRef<'loading' | 'preparing' | null>(null);

  /*
   * ONE WAIT, ONE CLOCK.
   *
   * The user, watching a run start: "getting ready shows for 10s, then dissapears
   * for a second then immeidately reappears and counts to 10 again."
   *
   * The stage really does blink — the prefix warm-up can run more than once
   * around a model switch — and every blink restarted the counter, so a single
   * 20-second wait was shown as two 10-second ones and nothing looked like it
   * was making progress. A gap shorter than {@link SAME_WAIT_GAP_MS} is treated
   * as the SAME wait: the clock keeps running and the measurement is not
   * recorded until the wait has actually finished.
   */
  const endedAt = useRef<number | null>(null);
  useEffect(() => {
    if (stage === prev.current) return;
    if (stage === null) {
      // Do not conclude anything yet — it may come straight back.
      endedAt.current = Date.now();
      prev.current = stage;
      return;
    }
    const resumed = endedAt.current !== null && Date.now() - endedAt.current < SAME_WAIT_GAP_MS;
    endedAt.current = null;
    prev.current = stage;
    if (!resumed) {
      setSince(Date.now());
      setNow(Date.now());
    }
  }, [stage]);

  /* The wait is over once the gap outlives the grace period — that is the point
     at which it is a measurement worth keeping ("usually about 8s on this Mac"). */
  useEffect(() => {
    if (stage !== null || since === null) return;
    const t = setTimeout(() => {
      if (endedAt.current === null) return;
      recordBootWait(
        prev.current === 'loading' ? 'model-load' : 'prompt-load',
        (endedAt.current - since) / 1000,
      );
      setSince(null);
    }, SAME_WAIT_GAP_MS);
    return () => clearTimeout(t);
  }, [stage, since]);

  useEffect(() => {
    if (stage === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stage]);

  return stage === null || since === null ? null : now - since;
}
