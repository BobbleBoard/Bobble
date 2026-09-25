/**
 * `create_production_hierarchy` as a NORMAL-CHAT tool (the user: the corp system is an
 * OPTION the model opts into at high/max effort — "still just a tool" — not a mode
 * that hijacks every prompt).
 *
 * The corp orchestration itself is main-process-only (engineers as real agent
 * loops, the situation-room event stream, the browser bridge). The pi child that
 * runs this tool can't reach any of that. So the tool does the ONE thing it can
 * from the child: it validates the model's promotion (reason + divisions) and
 * publishes the intent to the renderer over the per-turn UI status channel
 * ({@link PROMOTE_STATUS_KEY}); the renderer watches that key and launches the
 * existing corp run (`startCorpTask`), reusing 100% of the wired corp pipeline.
 *
 * Visibility is NOT effort-gated. It was once (high/max only) and the gate did
 * more harm than good — see `corpToolEnabled` below for why it was removed and
 * why the seam is still there. Everything in this file that still speaks of
 * "high/max only" is describing the past.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Static, Type } from '@sinclair/typebox';
import type { EffortLevel } from '../effort/effort.js';
import type { PlanItem } from '../state.js';
import { type CorpRunRequest, type CorpRunResult, corpBridgeRunFromEnv } from './bridge-client.js';
import {
  CREATE_PRODUCTION_HIERARCHY,
  CREATE_PRODUCTION_HIERARCHY_TOOL,
  HIERARCHY_CREATED_ACK,
  parseCreateHierarchyArgs,
} from './promotion.js';
import { classifyVerification, END_USER_TEST, extractClaims, finalCheck } from './verification.js';

/**
 * The `ctx.ui.setStatus` key the tool publishes the promote intent on. The desktop
 * renderer mirrors this string (see apps/desktop `harness-status.ts`) and, on a new
 * `id`, launches the corp run with the user's original prompt.
 */
export const PROMOTE_STATUS_KEY = 'harness-promote';

/**
 * What comes back when the CEO delegates without having done anything.
 *
 * Deliberately the WORKFLOW and nothing else — no scolding, no restatement of
 * what the tool is. It arrives as the answer to a call the model is waiting on,
 * which is the only place a 4B reliably reads.
 */
export const STANDING_START_REFUSAL = [
  'Not yet — you have not looked at anything.',
  '',
  'Before you hand this over, work a checklist:',
  '',
  '1. Call `update_plan` with one item per QUESTION you cannot answer about what this',
  '   should look like, behave like, or resemble. Questions, not build steps — "what',
  '   formats does it convert, and how does the page lay them out?", not "implement the',
  '   converter". THREE TO SIX of them. More than six and they are not all worth asking.',
  '2. Answer them one at a time — search, fetch the page, read the docs, look at the',
  '   thing itself; a specialist can go and look for you. Mark each one `done` in',
  '   `update_plan` as you answer it. A done item is CLOSED. Do not check it again.',
  '3. When the list is done, call this again with what you found in the brief and the',
  '   files you gathered in `files`.',
  '',
  /*
   * A START CONDITION NEEDS A STOP CONDITION, AND THE LIST IS BOTH.
   *
   * MEASURED, run 14 (aborted at 4m06s, 58 tool calls, 0 files, 0 delegations).
   * This refusal fired and the CEO did go and research — 3 searches, a fetch of
   * cloudconvert.com, then a real environment sweep that narrowed properly and
   * found `7zz` in the Cellar. Then it slid: `which ls find`, answered at call
   * 28 (`/bin/ls`), re-asked at call 47, and `ls /opt/homebrew/bin/ls` twice
   * byte-identical, `ls /opt/homebrew/bin/unzip` twice byte-identical.
   *
   * It was not that it checked too much. It never wrote down WHAT it was trying
   * to learn, so nothing could be finished — every answer was disposable and
   * re-askable. "Close those unknowns one at a time" named no unknowns.
   *
   * A written list is the scope (bounded at six), the consistency (an answered
   * question is struck off, not re-opened) and the accountability (what is still
   * open travels to the manager in the brief — see openQuestionsFor).
   */
  'The list is the scope. Nothing left on it means nothing left to find out — come',
  'straight back here even if you still feel underinformed; the team finds out the',
  'rest, and whatever is still open on your list goes to them with the brief.',
  '',
  'The manager has never spoken to the user and knows only what you write. A brief',
  'written before the unknowns are closed is a list of your assumptions, and it gets',
  'built exactly as written.',
].join('\n');

/**
 * The efforts at which the corp system is offered as a tool: ALL of them.
 *
 * It used to be high/max only (the user: "max effort just adds this talk to manager
 * tool"). Two things killed that gate.
 *
 * EFFORT MOVES PER MESSAGE. Adaptive effort is decided per turn, so the manager
 * appeared and disappeared between turns of the same conversation — and because
 * chat templates render the tool list at the START of the prompt, every flip threw
 * away the KV prefix. The gate was bought to avoid mid-run changes and was itself
 * the mid-run change.
 *
 * AND A TOOL THAT COMES AND GOES CANNOT BE PLANNED AROUND. the user, after asking why
 * the CEO is not told it has a manager: "yes if the talk to tool isn't loaded,
 * load it." One prompt, one tool list, every effort — which is the property
 * f4c3f02 was after in the first place ("a prompt that never changes is the
 * point"); it just gated the wrong half.
 *
 * The `effort` argument is kept so the seam still reads as a policy decision
 * rather than a deleted line, and so a future gate has somewhere to live.
 */
export function corpToolEnabled(_effort: EffortLevel): boolean {
  return true;
}

const DivisionSpec = Type.Object({
  name: Type.String({
    description: 'Short division name, e.g. "Frontend", "Storyline", "3D Assets".',
  }),
  purpose: Type.String({ description: 'What this division is responsible for producing.' }),
});

const PromoteParams = Type.Object({
  /*
   * A MESSAGE, not a form. `divisions` used to be REQUIRED, which made handing
   * work over an org-design exercise the CEO had to complete before anything
   * could start — and splitting the work is the manager's own first instruction.
   * See TALK_TO_MANAGER in ./promotion.ts for the run this cost.
   */
  message: Type.String({
    description:
      'What you want built, in your own words — the full vision, in as much detail as you have. ' +
      'The manager has not spoken to the user and only knows what you tell them.',
  }),
  reason: Type.Optional(
    Type.String({ description: 'Optional: why this needs a team rather than a single pass.' }),
  ),
  divisions: Type.Optional(
    Type.Array(DivisionSpec, {
      description:
        'OPTIONAL. Only if you already have a shape in mind. Leave it out and the manager ' +
        'splits the work itself.',
    }),
  ),
});
export type PromoteInput = Static<typeof PromoteParams>;

/** The promote-intent payload published on {@link PROMOTE_STATUS_KEY}. */
export interface PromoteSignal {
  /** Unique per call so the renderer fires once per promotion (never re-fires). */
  readonly id: string;
  readonly reason: string;
  readonly divisions: readonly { readonly name: string; readonly purpose: string }[];
}

export interface PromoteToolDeps {
  /** Current effort. Read for reporting, not to decide availability — see
   *  `corpToolEnabled`, which has answered `true` at every level since the
   *  gate was removed. */
  readonly getEffort: () => EffortLevel;
  /** Monotonic id source for the promote signal (tests inject a fixed one). */
  readonly nextId?: () => string;
  /**
   * Run the corporation and RESOLVE WITH WHAT IT DELIVERED. Injected by tests;
   * in the app it comes from {@link corpBridgeRunFromEnv}. Null/absent outside
   * Pi Desktop, where there is no team to wait for.
   */
  readonly runCorp?: ((req: CorpRunRequest, signal?: AbortSignal) => Promise<CorpRunResult>) | null;
  /**
   * How many OTHER tools the model has called this session. Drives the
   * standing-start veto below; omitted → no veto (tests, headless callers).
   */
  readonly otherToolCalls?: () => number;
  /**
   * The CEO's live `update_plan` checklist, if it kept one. Read at hand-back
   * so the questions it never closed travel WITH the brief instead of being
   * silently dropped — see {@link openQuestionsFor}.
   */
  readonly getPlan?: () => readonly PlanItem[] | null;
}

/**
 * The CEO's own unclosed questions, in its own words.
 *
 * The standing-start refusal asks for a checklist of unknowns and says the team
 * finds out the rest. This is the half that makes that true: whatever is still
 * `pending` or `in_progress` when the CEO hands over is named in the brief, so
 * the manager starts knowing which parts of it are assumption.
 *
 * Reading the model's OWN list assumes nothing about the task — it does not
 * check that the questions were good, or that they were about the right thing,
 * only that the CEO said they were open and then stopped.
 */
export function openQuestionsFor(plan: readonly PlanItem[] | null | undefined): string[] {
  if (plan === null || plan === undefined) return [];
  return plan.filter((item) => item.status !== 'done').map((item) => item.text);
}

/**
 * Did the team actually deliver something?
 *
 * A mesh refusal is a PARENTHETICAL NOTE — `(there is no "x" to talk to.)`,
 * `(the run was stopped …)` — and the mesh reports those as ordinary replies, so
 * a run can "succeed" while its product is an apology. That happened: the entry
 * point named a seat that had been removed, the refusal came back as the
 * product, and the final-check scaffold wrapped it and listed it to the CEO as
 * claim 1 about the finished work. The CEO concluded the manager was
 * unavailable and built the thing itself.
 *
 * Wrapping a failure in a verification ceremony is worse than not verifying:
 * it launders it. An empty or bare-parenthetical reply is not a delivery.
 */
function looksUndelivered(product: string): boolean {
  const t = product.trim();
  return t === '' || (t.startsWith('(') && t.endsWith(')'));
}

/**
 * What the manager actually receives. `message` is the CEO's own words and is
 * what we want; it is OPTIONAL though (a divisions-only call is valid), so a
 * call without one is turned into a brief from whatever the CEO did give rather
 * than handing the manager an empty string to start a production from.
 */
function briefForManager(
  args: {
    readonly message?: string;
    readonly reason: string;
    readonly divisions: readonly { readonly name: string; readonly purpose: string }[];
  },
  openQuestions: readonly string[] = [],
): string {
  const parts: string[] = [];
  if (args.message !== undefined && args.message !== '') parts.push(args.message);
  if (parts.length === 0 && args.reason !== '') parts.push(args.reason);
  /*
   * Only divisions the CEO ACTUALLY named. `parseCreateHierarchyArgs` synthesises
   * a single `Production` division whose purpose is just the message echoed back
   * when none were given — passing that on would hand the manager a fabricated
   * org chart and its own brief twice, when splitting the work is the manager's
   * first job.
   */
  const named = args.divisions.filter(
    (d) => !(d.name === 'Production' && d.purpose === (args.message ?? '')),
  );
  if (named.length > 0) {
    parts.push(
      `Divisions the CEO already has in mind:\n${named
        .map((d) => `- ${d.name}: ${d.purpose}`)
        .join('\n')}`,
    );
  }
  /*
   * Last, because it is the part the manager acts on rather than reads: these
   * are the things the CEO could not answer, so they are the first things to
   * find out — and naming them stops the brief's silence being read as settled.
   */
  if (openQuestions.length > 0) {
    parts.push(
      `The CEO left these questions open — treat the brief as an assumption wherever it ` +
        `touches them, and find out first:\n${openQuestions.map((q) => `- ${q}`).join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Register the normal-chat `create_production_hierarchy` tool. Reuses the tuned
 * tool description + arg validation from the corp promotion module so the model
 * sees exactly the framing it does inside a corp run.
 */
export function registerCreateHierarchyTool(pi: ExtensionAPI, deps: PromoteToolDeps): void {
  /** Hand-backs to the CEO so far — see `round` in the final check. */
  let handbacks = 0;
  let seq = 0;
  // Not `${(seq += 1)}` inline: an assignment buried in a template literal is the
  // one standing lint error this package had, and a known error is how a real one
  // hides (the same way two typecheck errors hid a read-only auditor that could write).
  const nextId =
    deps.nextId ??
    (() => {
      seq += 1;
      return `promote-${Date.now()}-${seq}`;
    });

  pi.registerTool({
    name: CREATE_PRODUCTION_HIERARCHY,
    label: 'Talk to Manager',
    description: CREATE_PRODUCTION_HIERARCHY_TOOL.function.description,
    /*
     * NO EFFORT CLAIM. This said "(high/max effort only)" long after the gate
     * above stopped existing — `corpToolEnabled` returns true at every level —
     * so the one sentence the model reads about this tool told it, falsely,
     * that it could not use the thing sitting in its own tool list. A model
     * that believes a tool is unavailable does not call it, which is the exact
     * failure the gate was removed to prevent.
     */
    promptSnippet:
      'talk_to_manager: hand a large build to your manager and their team of engineers, who deliver it back for your review.',
    promptGuidelines: [
      'Use it for a large, multi-part build that a single pass cannot do well — not for a question, a quick edit, or a one-file task (do those yourself).',
      "Just send the message: say what you want built, in full. You do not need to design divisions — splitting the work is the manager's job.",
    ],
    parameters: PromoteParams,
    async execute(_toolCallId, params: PromoteInput, signal, _onUpdate, ctx) {
      // No effort gate any more — see corpToolEnabled. A tool that is advertised
      // and then refuses on a condition the model cannot see is the phantom-tool
      // failure wearing a different hat.
      const args = parseCreateHierarchyArgs(params);
      if (args === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'talk_to_manager needs a "message" — tell the manager what you want built.',
            },
          ],
          isError: true,
          details: { rejected: 'args' },
        };
      }
      // Cross the process boundary: the pi child can't run corp orchestration, so
      // publish the intent to the renderer. This drives the situation room; it is
      // no longer what starts the work when the bridge is available.
      if (ctx.hasUI === true) {
        const signal: PromoteSignal = {
          id: nextId(),
          reason: args.reason,
          divisions: args.divisions,
        };
        ctx.ui.setStatus(PROMOTE_STATUS_KEY, JSON.stringify(signal));
      }

      /*
       * BLOCK UNTIL THE TEAM DELIVERS.
       *
       * the user: "the ceo calls the manager, this should stop the CEO cold ... the
       * ceo should not get a tool result from the manager until the manager has
       * run everything and is ready to submit the whole working product. as far
       * as the ceo knows they call manager and receive the complete working
       * product."
       *
       * This returned a fixed ack immediately, which is why a CEO could say "your
       * manager has it" eleven seconds in and then — still holding its own tools,
       * as it should — build the whole thing itself while the manager sat queued.
       * Awaiting the run is what stops that, and it takes nothing away from the
       * CEO: a pending tool call suspends it structurally.
       *
       * The CEO's OWN message is the task. The renderer used to start the run
       * from the last USER message instead, so the vision the CEO had just
       * composed for the manager was discarded and the mesh began by re-deriving
       * it from the raw prompt — two CEOs, one of them working from notes it
       * never wrote.
       */
      /*
       * WHICH HAND-BACK IS THIS? Counted here because the harness is the only
       * thing that knows — the CEO's own history may have been compacted, and a
       * model asked to remember how many rounds it has had will guess. Bumped
       * before the run so the first delivery reads as round 1.
       */
      /*
       * A DELEGATION FROM A STANDING START IS REFUSED, ONCE.
       *
       * MEASURED across runs 10, 11 and 12: the CEO made exactly ONE tool call
       * — this one — off one thought about the task being large, and briefed
       * the manager entirely from its own priors about the product. The
       * instruction to close its unknowns first was in the description the
       * whole time; moving it to the very top (run 11) changed nothing, and
       * giving the turn real web tools (run 12) changed nothing either. A model
       * that has decided at the top of the description does not read the rest,
       * whatever it says.
       *
       * the user: "veto the first talk to tool call outright no matter what and
       * just paste these instructions in there as the tool result… maybe only
       * do that if 0 tools have been called prior to the talk to."
       *
       * That last clause is what makes this general rather than a nag: the
       * refusal fires on a fact about the RUN — nothing has been done yet — and
       * never on what the task is. A CEO that has already looked at anything is
       * not stopped. And a tool RESULT is the one surface a model cannot skim
       * past, because it is the answer it was blocked waiting for.
       */
      const nothingDoneYet = handbacks === 0 && (deps.otherToolCalls?.() ?? 1) === 0;
      if (nothingDoneYet) {
        handbacks += 1;
        return {
          content: [{ type: 'text', text: STANDING_START_REFUSAL }],
          isError: true,
          details: { promoted: false, vetoed: true },
        };
      }
      handbacks += 1;
      const runCorp = deps.runCorp ?? corpBridgeRunFromEnv();
      if (runCorp !== null) {
        const brief = briefForManager(args, openQuestionsFor(deps.getPlan?.()));
        /*
         * THE TURN'S SIGNAL GOES TO THE TEAM. pi ends a turn only once this call
         * returns, so a Stop that did not reach it waited for the whole
         * production — tens of minutes to hours. The bridge hangs up at once and
         * the app stops the team: the same "halt all agents" the composer's Stop
         * sends while it still points at the production.
         */
        const result = await runCorp({ message: brief }, signal);
        if (result.stopped === true) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Stopped — this turn was stopped before the team delivered, and the team ' +
                  'was stopped with it. Whatever it had written is still in the workspace.',
              },
            ],
            isError: true,
            details: { promoted: true, delivered: false, stopped: true },
          };
        }
        if (result.ok && !looksUndelivered(result.product)) {
          /*
           * THE FINAL REVIEW RIDES IN THE TOOL RESULT.
           *
           * the user: "that final review does not have to be part of the mesh
           * harness, it's just part of the tool result that the talk to tool
           * gives it — e.g. from the manager 'I've built the requested game...'
           * — the harness then injects into that tool result 'now verify this
           * result as if you were the user testing it before giving it finally
           * back to them'."
           *
           * This is the SAME mechanical lever the engineers and the manager get
           * at submit time — the role's own claims listed back, plus the kinds of
           * proof this job admits — aimed at the one perspective that had nowhere
           * to live once the mesh stopped spawning a CEO of its own: the user's.
           * The real CEO is the only CEO, so it does this review itself, here,
           * before it answers.
           */
          /*
           * WHERE IT IS, before what to do about it.
           *
           * The next instruction is "open it and use it as the user would",
           * which needs an address. Without one the CEO guesses, and run 15
           * shows how: told a hand-off had failed, it searched `~/Bobble/…` and
           * `/Applications`, found neither, and reported to the user that no
           * code existed — while 53 files sat in the chat's own directory. The
           * successful path had the same blind spot; it just had a summary to
           * paper over it.
           */
          const delivered = (result.workspace ?? '').trim();
          const where =
            delivered === ''
              ? ''
              : `\n\nTHE WORK IS HERE. Open it here, not anywhere you think it might be:\n${delivered}`;
          return {
            content: [
              {
                type: 'text',
                text: `${result.product}${where}\n\n${'—'.repeat(20)}\n\n${finalCheck({
                  claims: extractClaims(result.product),
                  profile: classifyVerification(brief),
                  perspective: 'ceo',
                  vision: brief,
                  round: handbacks,
                })}`,
              },
            ],
            details: { promoted: true, delivered: true },
          };
        }
        const why = result.ok
          ? `the team returned nothing usable: ${result.product.trim()}`
          : (result.error ?? 'unknown error');
        /*
         * "NOTHING WAS DELIVERED" HAS TO BE CHECKED, NOT ASSUMED.
         *
         * This message was composed from the team's REPLY being empty — which
         * means the manager never spoke, and says nothing whatsoever about the
         * workspace. MEASURED, run 2: the manager exhausted its step budget
         * mid-coordination and never replied, so the CEO was told "Nothing was
         * delivered" over 18 source files, 2,452 lines and a clean TypeScript
         * build sitting on disk. The inner message even said "Its work may be on
         * disk but none of it was reported" — and this sentence contradicted it
         * two lines later.
         *
         * That is the false-completion failure this project keeps digging out,
         * running backwards, and a false NEGATIVE costs the same: it invites the
         * CEO to throw away real work or start again. So when the host reports a
         * non-empty workspace, say the true thing and show it.
         */
        const tree = (result.workspace ?? '').trim();
        return {
          content: [
            {
              type: 'text',
              text:
                tree === ''
                  ? `The production did not complete: ${why}. ` +
                    'Nothing was delivered. Tell the user plainly what happened — do not ' +
                    'describe the product as finished, and do not quietly build it yourself ' +
                    'instead: say that the hand-off failed.'
                  : /*
                     * A PARTIAL HAND-OFF STILL HAS SOMETHING TO OPEN, so it still
                     * gets the end-user test. This branch used to carry no testing
                     * instruction at all — the CEO was told the work exists and to
                     * ask for a summary, which is reading ABOUT the product again.
                     * Finding out what actually runs is the fastest way to know
                     * what is left, and it is the same question either way.
                     */
                    `The hand-off did not complete: ${why}.\n\n` +
                    /*
                     * The first line of `tree` is the ABSOLUTE directory; the
                     * rest are paths relative to it. Run 15's CEO was told a
                     * hand-off had failed, went looking in `~/Bobble/…` and
                     * `/Applications`, found nothing, and reported to the user
                     * that no code had been produced — over 53 files sitting in
                     * the chat's own folder. A list of filenames is not an
                     * address, so the address goes first and is named as one.
                     */
                    `THE WORK IS STILL THERE. This is where it is, and what is in it —\n` +
                    `look HERE and nowhere else:\n${tree}\n\n` +
                    'Do NOT start again and do NOT throw this away. In this order:\n\n' +
                    '1. Open it and use it yourself — find out what actually works.\n' +
                    `${END_USER_TEST}\n` +
                    '2. If something is missing or broken, call `talk_to_manager` once more\n' +
                    '   with exactly what you did and what you saw. If that comes back empty\n' +
                    '   too, stop asking and go to 3.\n' +
                    '3. Tell the user what you saw with your own eyes — not that it is\n' +
                    '   finished, and not that nothing happened.\n\n' +
                    `WHAT YOU BRIEFED THE TEAM WITH: ${brief}`,
            },
          ],
          isError: true,
          details: { promoted: true, delivered: false },
        };
      }

      /*
       * NO BRIDGE (a headless harness outside Pi Desktop). There is no team to
       * wait for, so the honest thing is the ack — but it must not imply a
       * delivery that cannot happen here.
       */
      return {
        content: [{ type: 'text', text: HIERARCHY_CREATED_ACK }],
        details: { promoted: true, divisions: args.divisions.length },
      };
    },
  });
}
