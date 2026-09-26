/**
 * A TURN THAT ENDS BY SAYING WHAT IT WILL DO NEXT — AND THEN DOESN'T.
 *
 * MEASURED (the visual suite, qwen3.5-4b, 2026-09-25). Asked for six recipe
 * icons, the model's last words were "The svg command seems to have generated
 * something, but I need to check … Let me present the SVG file to see what was
 * generated." — and the turn ended there: nothing presented, nothing shown, the
 * person left looking at a promise. The first website run ended the same way
 * ("Let me open the file properly in the browser to verify it renders").
 *
 * The three nudges beside this one catch a menu handed back, a reply cut off at
 * the output limit and a checklist left unfinished. None of them sees a plain
 * statement of the next step, which reads like progress and is a stop.
 *
 * Deliberately narrow: the LAST two sentences must announce one of a small set
 * of concrete actions — present, open, check, run, fix, draw … — in the first
 * person ("Let me …", "I'll …", "Now I will …"). "Let me know if you want
 * changes" is not an action; a question is not a statement. Once per session,
 * like its neighbours: a model that stops again after being told is telling us
 * something real.
 */

const ACTION_VERBS = [
  'present',
  'show',
  'open',
  'check',
  'verify',
  'test',
  'run',
  'read',
  'write',
  'create',
  'make',
  'fix',
  'update',
  'edit',
  'generate',
  'draw',
  'redraw',
  'render',
  'build',
  'add',
  'try',
  'save',
  'look',
  'view',
  'inspect',
  'examine',
  'rewrite',
  'correct',
  'replace',
  'implement',
];

const ANNOUNCE = new RegExp(
  "\\b(?:let me|let's|i(?:'ll| will|'m going to| am going to)|now i(?:'ll| will)|next,? i(?:'ll| will))\\s+" +
    `(?:now\\s+|first\\s+|quickly\\s+|just\\s+)?(?:${ACTION_VERBS.join('|')})\\b[^.!?\\n]*`,
  'i',
);

/**
 * The announcement a reply ENDS on — "Let me present the SVG file to see what
 * was generated" — or null. Only the last two sentences count, and a reply
 * that ends on a question is not a statement of what comes next.
 */
export function announcedNextStep(reply: string): string | null {
  const text = reply.trim();
  if (text === '' || text.endsWith('?')) return null;
  const sentences = text.split(/(?<=[.!:])\s+|\n+/).filter((s) => s.trim() !== '');
  const tail = sentences.slice(-2).join(' ');
  const m = ANNOUNCE.exec(tail);
  return m === null ? null : m[0].trim();
}

/** The one nudge: do the thing you said, then finish. */
export function announcedStepNudge(said: string): string {
  return `You ended by saying "${said}" — but the turn stopped there. Do it now, then finish the task.`;
}
