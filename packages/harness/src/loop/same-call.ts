/**
 * The SAME call, made again, with the same answer.
 *
 * The loop detector counts turns and fires at 75 — the right threshold for "the
 * model is going round in circles across a task". It is far too patient for the
 * other shape, which is a single call repeated verbatim: identical tool,
 * identical arguments, identical result. MEASURED across three runs on this
 * machine, each one died on it — twelve `edit` calls returning the same "File
 * not found", then twelve `write` calls all reporting success on the same
 * thirteen bytes. Nothing was failing, so nothing complained, and the run spent
 * its whole budget writing one file over and over.
 *
 * Repetition that changes nothing is not progress at any count. Two is a
 * coincidence; three is a stall, and the third result is where saying so is
 * cheapest — the model is about to read it anyway.
 *
 * This is a NUDGE, not a fence: the call still runs and still returns what it
 * returned. All that is added is the one fact the model cannot see from inside
 * a single result — that it has been here before, and nothing moved.
 */

/** How many identical calls in a row before the result says so. */
export const SAME_CALL_LIMIT = 3;

/** A tiny, order-insensitive digest of a call and what it answered. */
export function callSignature(tool: string, args: unknown, result: string): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  };
  return `${tool} ${stable(args)} ${result.trim()}`;
}

export interface SameCallState {
  signature: string | null;
  count: number;
}

export function newSameCallState(): SameCallState {
  return { signature: null, count: 0 };
}

/**
 * Record a call and say whether this is the point to speak up.
 *
 * Returns the note to append, or null. Speaks ONCE per run of repeats — saying
 * it on the fourth and fifth as well would be the same mistake the model is
 * making.
 */
export function noteRepeatedCall(
  state: SameCallState,
  tool: string,
  args: unknown,
  result: string,
): string | null {
  const signature = callSignature(tool, args, result);
  if (signature !== state.signature) {
    state.signature = signature;
    state.count = 1;
    return null;
  }
  state.count += 1;
  if (state.count !== SAME_CALL_LIMIT) return null;
  return (
    `\n\n[You have now made this exact \`${tool}\` call ${SAME_CALL_LIMIT} times and got this ` +
    'exact answer each time. Repeating it will not change it. If this was the work, it is ' +
    'done — move to the next step or finish. If it was not, the answer is somewhere else: ' +
    'a different tool, or a different question.]'
  );
}
