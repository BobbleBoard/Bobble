/**
 * "WHEN I DON'T SEE ANYTHING I GET AN INSTANT RESPONSE."
 *
 * That is the user's rule for the whole latency effort, and it only holds if the app
 * says something during every window where a send would NOT be instant. The two
 * boot waits already speak (composer-pill.ts); this is the third — the seconds
 * between adding something and its tokens being resident.
 *
 * A prefill usually takes a couple of hundred milliseconds because the prefix is
 * already there, and a pill that flashed for that would be noise on every window
 * return. So it waits: nothing is said until the prime has been running long
 * enough that pressing enter into it would actually cost you something.
 */
import { useEffect } from 'react';
import { dismissPill, showPill } from './pill-store';

const PILL_ID = 'prefill-in-flight';
/**
 * How long a prime may run before it is worth mentioning.
 *
 * A warm re-prime of a resident prefix measures 200-400ms on this machine, and
 * a cold one runs into seconds. 700ms sits above the first and well below the
 * second, so the pill appears when — and only when — there is a wait behind it.
 */
export const PREFILL_PILL_DELAY_MS = 700;

/**
 * Above this, a wait is something a person notices rather than something that
 * simply happened. It is the threshold the pill uses to decide whether to
 * announce itself at once or wait out the anti-flicker delay first.
 */
export const PERCEPTIBLE_MS = 220;

/**
 * How long to wait before saying a prime is happening.
 *
 * Zero when the machine's own measured rate says the wait will be felt — the
 * pill's absence is a promise that nothing is pending, and a delay breaks that
 * promise for exactly the primes worth knowing about. The anti-flicker delay
 * otherwise, including when the rate is not known yet, because guessing that an
 * unmeasured prime is slow would put a pill on the screen for every keystroke.
 */
export function prefillPillDelay(estimatedMs: number | null): number {
  return estimatedMs !== null && estimatedMs >= PERCEPTIBLE_MS ? 0 : PREFILL_PILL_DELAY_MS;
}

export function usePrefillPill(inFlight: boolean, estimatedMs: number | null = null): void {
  useEffect(() => {
    if (!inFlight) {
      dismissPill(PILL_ID);
      return;
    }
    /*
     * THE ABSENCE OF THE PILL IS A PROMISE. the user: "if that pill dissapears, that
     * means the entire conversation up to the point I have started typing and
     * sent in that turn is already prefilled and will not have to be prefilled
     * at all when I send my next message."
     *
     * A fixed delay before showing broke that promise for exactly the primes
     * worth knowing about: a four-second prefill said nothing for the first
     * quarter of a second, which is the window in which someone hits send. So a
     * prime the machine's own measured rate says will be FELT announces itself
     * at once; one too short to perceive keeps the delay, because a wait nobody
     * can notice is not the wait the promise is about — and showing it would
     * flicker a pill on every keystroke.
     */
    const delay = prefillPillDelay(estimatedMs);
    const timer = window.setTimeout(() => {
      showPill({
        id: PILL_ID,
        text: 'Getting this ready',
        tone: 'busy',
        spinner: true,
        // Below the boot waits (100) and the re-prefill warning (80): a model
        // that cannot answer at all outranks one that is nearly ready.
        priority: 40,
      });
    }, delay);
    return () => {
      window.clearTimeout(timer);
      dismissPill(PILL_ID);
    };
  }, [inFlight, estimatedMs]);
}
