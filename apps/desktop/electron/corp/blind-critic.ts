/**
 * A CRITIC THAT HAS NEVER SEEN THE WORK BEING DEFENDED.
 *
 * Every check this harness already runs is deterministic — `runtimeCheck` opens
 * the project, `testSuiteReport` runs the suite, `orphanReport` asks what nothing
 * points at. Those are the cheap blind critics and they are why "the harness
 * performs the check rather than asking for it" keeps working: code has no
 * context to be talked out of.
 *
 * This is the part code cannot do — is the thing any GOOD, does it do what was
 * actually asked — and today that judgement is made by roles which are the
 * opposite of blind. `finalCheck` is handed `extractClaims(finalText)`: the
 * implementer's own account of its work, graded by a manager that watched the
 * whole build. Two failure modes follow, and both are measured in this repo:
 *
 *   1. THE IMPLEMENTER GRADES ITS OWN HOMEWORK. Run 9's mesh returned
 *      `(there is no "ceo" to talk to.)` as its product and the final check
 *      wrapped that string as claim #1 and walked it through the ceremony.
 *   2. A CRITIC THAT WATCHED THE DRAFTS GRADES IMPROVEMENT, NOT THE BAR. After
 *      two bump cycles the interesting question stops being "does this meet the
 *      ask" and quietly becomes "is this better than last time" — which a broken
 *      thing can pass.
 *
 * So: a session with NO history, NO claims, NO previous drafts, and NO ability to
 * fix what it finds. It gets the original ask and the workspace, and it has to go
 * and look.
 *
 * COST, because on this machine it is the whole objection. A fresh context cannot
 * reuse the KV prefix, so this pays a full prefill — the thing that made run 10
 * look hung for twelve minutes. That is why it runs ONCE, at handback, and never
 * per iteration: one prefill, not N. It is also why it is off unless asked for.
 */
import { createLogger } from '@pi-desktop/shared';
import type { CorpModelHandle } from './role-agent';
import { openRoleSession } from './role-agent';

const log = createLogger('desktop:corp');

/** Opt-in. Off by default until a run shows it earns its prefill. */
export function blindCriticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PI_BLIND_CRITIC;
  return v === '1' || v === 'true';
}

/**
 * Deliberately says nothing about what KIND of thing is being judged.
 *
 * The user's rule for this whole test cycle is that a fix has to hold across every
 * benchmark — "you can't test, fix something and retest with the same prompt,
 * this forces you to never, not even accidentally, fix something task specific".
 * A critic prompt that mentioned CSVs, or scenes, or slides, would be exactly
 * that mistake wearing a new hat.
 */
export const BLIND_CRITIC_PROMPT = `You are auditing a finished piece of work for the person who asked for it.

You have NEVER seen this work before. There is no earlier version, no progress to
credit, and nobody's account of what they built — deliberately. You are here to
answer one question: does what is actually on disk do what was actually asked?

Judge the BAR, not the effort. "Better than it was" is not a thing you can see and
not a thing you care about. Either the ask is met or it is not.

GO AND LOOK. Do not review this from the file names. Open the files. RUN it — the
way the person who asked would run it. If it is a program, execute it. If it takes
input, give it the real input. If it claims to handle something awkward, hand it
something awkward. An opinion formed without running the thing is worth nothing
here, and you have the tools to run it.

You CANNOT change anything. Every file is read-only to you and any command that
writes will be refused. That is on purpose: your job is to report, and a critic
who fixes what they find has stopped being able to see it.

Report, briefly:
  WHAT WORKS - only what you personally saw work, and what you did to see it.
  WHAT DOES NOT - each with the exact evidence: the command, the error, the wrong
    number next to the right one.
  MISSING - anything in the ask that nothing on disk addresses at all.
  VERDICT - "MEETS THE ASK" or "DOES NOT MEET THE ASK", and one sentence why.

If you could not run it at all, say that plainly and say what stopped you. Do not
soften a failure and do not pad a success. Nobody benefits from a generous audit.`;

export interface BlindCriticInput {
  readonly handle: CorpModelHandle;
  readonly cwd: string;
  /** The ORIGINAL ask — the bar. Never the implementer's restatement of it. */
  readonly task: string;
  readonly thinking?: boolean;
}

/**
 * Run the critic once and return its report, or '' when there is nothing to say.
 *
 * SILENT ON FAILURE, like `testSuiteReport` and `orphanReport`. A critic that
 * cannot run must not block a handback or inject an excuse into it — the
 * deterministic checks still stand on their own, and a missing opinion is much
 * cheaper than a fabricated one.
 */
export async function blindCriticReport(input: BlindCriticInput): Promise<string> {
  const task = input.task.trim();
  if (task === '') return '';
  let open: Awaited<ReturnType<typeof openRoleSession>> | null = null;
  try {
    open = await openRoleSession(input.handle, {
      // Charged to the budget as a review turn, and labelled as one in the log.
      purpose: 'review',
      systemPrompt: BLIND_CRITIC_PROMPT,
      /*
       * READ AND RUN, NEVER WRITE. `bash` is here on purpose — "go and look"
       * means executing the thing, which is the only way to tell a program that
       * works from one that merely parses. `mayWriteFiles: false` on the turn
       * makes every write refused, bash included, so the critic cannot quietly
       * repair the defect it is supposed to be reporting.
       */
      tools: ['read', 'ls', 'grep', 'find', 'bash'],
      cwd: input.cwd,
      thinking: input.thinking ?? false,
      // Judgement plus running things, without a thinking budget it does not
      // need — the audit is decided by what the commands print, not by how long
      // it deliberates first.
      samplingMode: 'instruct-reasoning',
      // NO `session` key: in-memory, discarded on dispose. That omission IS the
      // blindness — there is no file for a later critic to resume and inherit
      // this one's opinions from.
    });
    const res = await open.prompt(
      [
        'This is what the person asked for, in their words:',
        '',
        task,
        '',
        `The work is in: ${input.cwd}`,
        '',
        'Go and look, run it, and report.',
      ].join('\n'),
      /*
       * The option is `mayWriteFiles`, and it was written here as `canWrite` —
       * a name RoleTurnOptions has never had. TypeScript said so and nobody was
       * listening: `apps/desktop` had two standing typecheck errors, both from
       * this file, so the critic shipped with writes ENABLED (the default) while
       * its own comment claimed they were refused. The read-only auditor could
       * repair the defect it was sent to report.
       */
      { mayWriteFiles: false },
    );
    const text = res.finalText.trim();
    if (text === '') return '';
    return ['AN AUDITOR WHO HAS NOT SEEN YOUR WORK BEFORE WENT AND LOOKED:', '', text].join('\n');
  } catch (err) {
    log.info('blind critic did not run', { err: String(err) });
    return '';
  } finally {
    try {
      open?.dispose();
    } catch {
      // a failing dispose must never break a handback
    }
  }
}
