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

export function usePrefillPill(inFlight: boolean): void {
  useEffect(() => {
    if (!inFlight) {
      dismissPill(PILL_ID);
      return;
    }
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
    }, PREFILL_PILL_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      dismissPill(PILL_ID);
    };
  }, [inFlight]);
}
