/**
 * A COMMAND THAT IS ONE TOKEN REPEATED IS NOT A COMMAND.
 *
 * MEASURED in the matrix: a 4B, asked to work in Chrome, emitted
 * `readreadreadreadreadreadread…` as a bash command and the harness ran it —
 * for 36 seconds, while the activity terminal filled with the same word. The
 * model had fallen into token repetition, which is a decoding failure rather
 * than an intention, and nothing downstream can rescue a run that spends its
 * remaining minutes on it.
 *
 * The test is deliberately narrow, because refusing a legitimate command is far
 * worse than running a silly one: the WHOLE command, once trimmed, has to be a
 * single short unit repeated many times over. `ls` is not caught. `yes yes yes`
 * is not caught (it has spaces, and it is a real thing to type). A base64 blob
 * is not caught (its period is not short and it does not repeat exactly).
 *
 * Pure, so the rule can be argued with in a test rather than in a run.
 */

/** Shortest repeating unit worth calling degenerate, and the fewest repeats. */
const MIN_UNIT = 2;
const MAX_UNIT = 12;
const MIN_REPEATS = 8;
/** Below this there is nothing to be sure about. */
const MIN_LENGTH = 40;

/**
 * The unit a string is made of, when it is made of one — `null` otherwise.
 *
 * Only exact tilings count: "abcabcabc" yes, "abcabcab" no. A partial tail is
 * how ordinary text accidentally looks periodic.
 */
export function repeatedUnit(text: string): string | null {
  const s = text.trim();
  if (s.length < MIN_LENGTH || /\s/.test(s)) return null;
  for (let n = MIN_UNIT; n <= MAX_UNIT; n++) {
    if (s.length % n !== 0) continue;
    if (s.length / n < MIN_REPEATS) continue;
    const unit = s.slice(0, n);
    if (unit.repeat(s.length / n) === s) return unit;
  }
  return null;
}

/**
 * What to say instead of running it.
 *
 * Naming the repetition matters more than refusing it: a model in this state
 * has lost the thread, and "you repeated X 47 times" is a fact it can act on,
 * where "invalid command" invites it to try a variation of the same thing.
 */
export function degenerateCommandRefusal(command: string): string | null {
  const unit = repeatedUnit(command);
  if (unit === null) return null;
  const times = command.trim().length / unit.length;
  return (
    `Not run: that command is "${unit}" repeated ${times} times with nothing else in it, ` +
    `which is a decoding slip rather than something you meant. Say what you are trying to do ` +
    `in one short sentence, then write the single command that does it.`
  );
}
