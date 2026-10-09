/**
 * ONE SENTENCE, EVERY VERIFICATION INSTRUCTION IN THE HARNESS.
 *
 * The user, 2026-08-09: "all verification instructions ever passed in any prompt
 * across the entire harness (not just the corp harness) need to say explicitly,
 * 'rigorous verification including non negotiably visually where applicable'."
 *
 * WHY IT IS A CONSTANT AND NOT A SENTENCE TYPED INTO EACH PROMPT. The harness
 * has verification language in at least a dozen places — the corp role prompts,
 * the submit gate, the reviewer, the CEO's own hand-back, the solo-agent verify
 * pass. Every one of them was worded separately, so every one drifted, and a
 * rule that lives in twelve paraphrases is a rule nobody can change. Import it,
 * and changing the standard is one edit.
 *
 * WHY "VISUALLY, NON-NEGOTIABLY". Two corp runs in a row ended with every task
 * marked done and a product that did not load. In both, the only "verification"
 * on record was a shell line whose success and failure printed the same string.
 * Nobody looked at anything. A model can talk itself into believing a command
 * passed; it cannot talk itself into a screenshot that shows a working window.
 * "Where applicable" is doing real work in that sentence — a parser has no
 * visual surface — but the moment there IS one, looking is not optional.
 */

/** The standard, verbatim. Any prompt that asks for verification must carry it. */
export const RIGOROUS_VERIFICATION =
  'rigorous verification including non negotiably visually where applicable';

/**
 * The standard as a full instruction, for prompts that want a sentence rather
 * than a phrase to splice in.
 */
export const RIGOROUS_VERIFICATION_INSTRUCTION =
  `Verification means ${RIGOROUS_VERIFICATION}. ` +
  'If the thing has any visible surface — a window, a page, a document, a ' +
  'rendered frame, a chart — you must LOOK at it, and say what you saw. A ' +
  'command that exited zero is not a substitute for having looked, and neither ' +
  'is a description of what you expect it would show.';

/**
 * The check → fix → CHECK AGAIN round, required of every role before it hands
 * anything back as finished.
 *
 * The user: "ensure every step has the secondary prompting to check -> fix -> final
 * check before submitting as a final round when they initially submit their
 * tasks (all engineers, managers, ceo)".
 *
 * The failure this closes, from the run-2 trace: an engineer fixed the thing it
 * had been told was broken and submitted on the strength of the FIX, never
 * re-running the check that had failed. The manager did the same one level up,
 * and the CEO handed back a menu of options against a project it had never
 * opened. A fix is a hypothesis until the check that failed passes.
 */
export const CHECK_FIX_CHECK =
  'BEFORE YOU HAND THIS BACK, RUN THE ROUND: check, fix, then CHECK AGAIN.\n' +
  `1. CHECK — ${RIGOROUS_VERIFICATION}. Run it, open it, look at it.\n` +
  '2. FIX — repair everything that check found. If it found nothing, say what ' +
  'you ran and what it printed.\n' +
  '3. CHECK AGAIN — re-run the SAME check, after the fix, and report what it ' +
  'printed the second time. This is the step that gets skipped, and skipping it ' +
  'is how work that was never repaired gets handed back as repaired. A fix you ' +
  'have not re-checked is a guess.\n' +
  'If the second check still fails, do not hand it back as finished. Say plainly ' +
  'what still fails and what you tried.';
