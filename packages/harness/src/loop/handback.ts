/**
 * A LEAD THAT ENDS ITS TURN ASKING WHICH OPTION TO TAKE.
 *
 * MEASURED, run 3. Sixty minutes in, 120 left, the CEO wrote a status summary and
 * finished:
 *
 *     - A) Build the batch processing module now
 *     - B) Build the app installer and bundle directly
 *     - C) Build both in sequence
 *     Which would you prefer?
 *
 * Then went idle. Nobody was going to answer, and there is no bump on this path —
 * the corp bumps fire on a MESH role's turn end, and the lead is the chat model,
 * outside the mesh. The run held a question for two hours.
 *
 * The prompt already forbids this: capability-prompt.ts has a section titled "Do
 * the task — never hand it back". It did not hold, and a menu is the most
 * plausible-looking way to break it — A/B/C reads like diligence and is
 * indistinguishable from stopping.
 *
 * THE LINE THIS DRAWS, and why it is not "never ask anything": there is a TOOL
 * for asking. `ask_user` is advertised in every preset, it blocks properly, and
 * the app renders it. A model that genuinely needs an answer has a way to get one.
 * Ending a turn with a question in PROSE is a different act — it looks like asking
 * and behaves like quitting. So the rule is about the mechanism, not the content:
 * use the tool if you mean it, and if you did not use the tool, you were not
 * blocked.
 *
 * Deliberately narrow. It fires only when the model has laid out choices it could
 * plainly have made itself, which is the case where continuing is safe: on an
 * ambiguous ordering question either branch is defensible, and the cost of picking
 * wrong is far below the cost of stopping for two hours.
 */

/** A lettered or numbered alternative — "A)", "2.", "- B:" — the shape of a menu. */
const OPTION_LINE = /^\s*(?:[-*]\s*)?(?:\(?[A-Da-d][).:]|[1-4][).:])\s+\S/;

/** Ways a model asks the reader to choose, rather than asking about a fact. */
const CHOOSING = /\b(which (would|do) you|would you (prefer|like)|shall i|should i|do you want)\b/i;

/**
 * Does this reply END by handing the decision back?
 *
 * Requires BOTH a closing question and at least two options laid out — one
 * without the other is ordinary prose. "Should I use tabs or spaces?" mid-summary
 * is not a handback; a menu with a closing "Which would you prefer?" is.
 */
export function isChoiceHandback(reply: string): boolean {
  const lines = reply.trimEnd().split('\n');
  const tail = lines.filter((l) => l.trim() !== '').slice(-12);
  if (tail.length === 0) return false;
  const last = tail.at(-1) ?? '';
  const asks = last.trimEnd().endsWith('?') && CHOOSING.test(last);
  if (!asks) return false;
  return tail.filter((l) => OPTION_LINE.test(l)).length >= 2;
}

/**
 * The one nudge. Short, and it makes the decision for the model in the only way
 * that is always safe: pick, say which, keep going.
 */
export const HANDBACK_NUDGE =
  'You do not need an answer to continue. Pick the option you think is best, say ' +
  'in one line which you picked and why, and carry on — there is time left and ' +
  'nobody is waiting to reply. If you are genuinely blocked on something only the ' +
  'user can decide, call ask_user instead of ending your turn with a question.';
