/**
 * A TURN THAT ENDS WITH THE MODEL'S OWN CHECKLIST UNFINISHED.
 *
 * the user, round 3: "long running tasks where you can't accept an 'I can't do this'
 * needs to truly run until completion."
 *
 * The two nudges beside this one catch a turn that stopped by ASKING
 * (handback.ts) and a turn that stopped because the decoder ran out of room
 * (OUTPUT_LIMIT_NUDGE). Neither catches the commonest way a long task ends
 * early: the model does three of eight things, writes a good summary of the
 * three, and stops. Nothing is broken, nothing was refused, and the reply reads
 * like success — which is exactly why it survives every other check.
 *
 * ## Why the model's own plan, and nothing else
 *
 * The harness cannot know whether a task is finished; that is the task's
 * business, and any rule that tried would be a guess about work it cannot see.
 * But `update_plan` is the model stating, in its own words, what this task
 * consists of — and a step it left `pending` is the model's own assertion that
 * something remains. This is the solo-agent version of what the corp submit
 * gate does with an engineer's claims: quote them back and ask for discharge,
 * rather than inventing a standard.
 *
 * So the mechanism assumes NOTHING about the task. It fires only on evidence
 * the model volunteered, and it says only what that evidence says.
 *
 * ## Why it is narrow
 *
 * - Nothing is pending ⇒ nothing to say. A turn with no plan at all is not
 *   suspicious: most turns do not need one, and the prompt says as much
 *   ("a plan for a single action is noise").
 * - A plan with NOTHING done used to be excluded, on the theory that it was
 *   usually a plan written and then abandoned for a better approach. MEASURED
 *   on the LocalConvert benchmark, that was exactly backwards: the model wrote a
 *   SIXTEEN-step plan, created a directory, had one file write refused, and
 *   stopped — 0/16, nothing on disk, the run idle. A plan at 0/N with the turn
 *   over is the strongest evidence of giving up there is, not the weakest, and
 *   the exclusion silenced this on the very case it was built for. A plan
 *   genuinely superseded is REPLACED, which shows as a different plan rather
 *   than an ended turn.
 * - Once per session, like its two neighbours. A model that stops again after
 *   being told to continue is telling us something real, and a guard that keeps
 *   overriding the same answer is worse than the stall.
 */
import type { PlanItem } from '../state.js';

export interface UnfinishedPlan {
  readonly done: number;
  readonly remaining: readonly string[];
}

/**
 * The unfinished part of the model's own plan, or null when there is nothing to
 * push back on.
 *
 * `null` — rather than an empty result — for every case that is not "made
 * progress, then stopped": no plan, an empty plan, a plan already complete, or
 * one where nothing was ever finished.
 */
export function unfinishedPlan(plan: readonly PlanItem[] | null): UnfinishedPlan | null {
  if (plan === null || plan.length === 0) return null;
  /*
   * ROADMAP ITEMS ARE NOT UNFINISHED WORK. `PlanItem.roadmap` marks a step the
   * model deliberately parked as future — the app renders it dimmer for exactly
   * that reason — so counting it here would turn "I noted what comes next" into
   * "you gave up", and punish the model for the more useful plan.
   */
  const inScope = plan.filter((p) => p.roadmap !== true);
  if (inScope.length === 0) return null;
  const done = inScope.filter((p) => p.status === 'done').length;
  const remaining = inScope.filter((p) => p.status !== 'done').map((p) => p.text);
  if (remaining.length === 0) return null;
  return { done, remaining };
}

/**
 * The nudge, built from the model's own words.
 *
 * It quotes the remaining steps back rather than describing them, for the same
 * reason the corp submit gate quotes an engineer's claims: the model cannot
 * argue with its own checklist, and a generic "keep going" invites a generic
 * "I have completed the main work". Capped at eight lines so a long plan does
 * not become a wall of text in the middle of a run.
 */
export function unfinishedPlanNudge(u: UnfinishedPlan): string {
  const shown = u.remaining.slice(0, 8);
  const more = u.remaining.length - shown.length;
  const list = shown.map((t) => `- ${t}`).join('\n');
  /* Nothing done at all reads differently from "some progress, then stopped",
     and saying "you marked 0 steps done" invites an argument about the marking
     rather than about the work. */
  const opening =
    u.done === 0
      ? `You wrote a plan with ${u.remaining.length} steps and then stopped without finishing any of them:`
      : `You marked ${u.done} step${u.done === 1 ? '' : 's'} done and stopped, but your own plan still has ${u.remaining.length} unfinished:`;
  return [
    opening,
    list + (more > 0 ? `\n- …and ${more} more` : ''),
    '',
    'Nobody is waiting to reply and there is time left. Continue with the next ' +
      'one now and work through the rest, marking each off as it actually ' +
      'completes. If a step turned out to be unnecessary or impossible, say so ' +
      'in one line and drop it from the plan — but do not leave it sitting there ' +
      'while you finish. Only report back when the plan has nothing left in it.',
  ].join('\n');
}
