/**
 * DIVISIONS — what an agent is told when it joins a team that is already working.
 *
 * THE FAILURE THIS EXISTS FOR. A 90-minute run with a manager and four engineers
 * produced ~4,000 lines of on-topic, non-degenerate code and never converged:
 * three conversion engines, two UIs, and `src/core/converters/` rebuilt from
 * scratch an hour later as `src/core/conversers/` — a different architecture, not
 * a copy, by an engineer that had never been shown the first one. 37 of 53 files
 * ended up on paths nothing referenced.
 *
 * That is not a reasoning failure. Every agent was coherent inside its own
 * context; each one re-reads its contract as message one, which is exactly why it
 * never drifts — and exactly why it cannot know what anyone else built. The
 * missing thing was never intelligence, it was ORIENTATION: nobody was told what
 * already existed, and nobody looked before writing.
 *
 * the user: "work formally split as 'divisions' … 'a team of developers is/has been
 * working here, you are assigned to the <division> which is responsible for
 * <work>' … <briefing on what's been done, what's to do, and or an overview (most
 * important part)>".
 *
 * TWO RULES THIS FILE IS WRITTEN UNDER.
 *
 * 1. NOTHING TASK-SPECIFIC. No framework, no language, no file layout, no tool
 *    that only some projects have. `git` appears once, hedged, because most
 *    codebases have some history mechanism and "or whatever this project uses" is
 *    a general instruction. Anything narrower would train the team on the last
 *    benchmark instead of the next one. {@link DIVISION_PRACTICE} is asserted
 *    against a banned-word list in the tests for exactly this reason.
 *
 * 2. SHORT AND PLAIN. the user: "don't complicate the prompts as much as possible.
 *    complication/unclean and non straightforward writing is really really bad
 *    especially at this 4b size." Short sentences, concrete nouns, one idea per
 *    line. A clause a 4B has to unpick is a clause it will skip.
 */

/**
 * A named area of the work. The manager creates these and assigns people to them.
 *
 * `name`/`responsibility` are OPTIONAL together, and that is deliberate: the
 * manager already names the area in the first line of its contract ("CONTRACT:
 * React + Tailwind CSS UI Framework"), so requiring a structured field would mean
 * threading one through the whole mesh to restate what the prose says. When they
 * are absent the block still does its real job — you are not alone, here is what
 * exists, here is how not to trample it.
 */
export interface Division {
  /** Short name, as the team refers to it — "UI", "conversion engine". */
  readonly name?: string;
  /** One line: what this division is responsible for. Pairs with `name`. */
  readonly responsibility?: string;
  /**
   * What already exists here, WITH PATHS. Required, and required for a reason:
   * this is the field that prevents the duplicate, so an assignment must not be
   * issuable without somebody having answered it. Optional, it would be blank on
   * exactly the runs that need it. Pass "Nothing yet." for a genuinely empty area.
   */
  readonly overview: string;
  /** What is still outstanding in this division. */
  readonly todo?: string;
  /** Division-wide items everyone assigned here is held to. */
  readonly checklist?: readonly string[];
}

/**
 * The standing practice every division member reads, whatever their role.
 *
 * Each line is here because a run lost time to its absence. Kept general on
 * purpose: these are the habits of working in a tree somebody else is also
 * working in, which is true of every project this harness will ever be pointed at.
 */
export const DIVISION_PRACTICE = `BEFORE YOU WRITE
- List the whole tree once. Other people have been here, and their work is not where you were about to look.
- If what you were asked to build already exists, do not build it again. Extend that file and say so.
- Check the project's history if it keeps any (git, or whatever this one uses).

WHILE YOU WORK
- Put your work where this division's work already lives.
- Never make a second copy under a new name. Both copies look finished and only one is wired up.
- Change the files your contract covers. Say in your reply what else needs changing.
- Read what is there before any large delete or replace.`;

/** Render the checklist block, or nothing when the division has no items. */
function checklistBlock(items: readonly string[] | undefined): string {
  if (items === undefined || items.length === 0) return '';
  return `\n\nTHIS DIVISION IS HELD TO\n${items.map((i) => `- ${i}`).join('\n')}`;
}

/** Render a section only when it has content — an empty heading is noise a 4B still reads. */
function section(heading: string, body: string | undefined): string {
  const text = (body ?? '').trim();
  return text === '' ? '' : `\n\n${heading}\n${text}`;
}

/**
 * The first thing an agent assigned to a division sees.
 *
 * Order: WHERE YOU ARE, WHAT IS ALREADY TRUE, HOW NOT TO BREAK IT, then THE
 * CONTRACT — last, because the last thing read before generating should be the
 * thing to act on. An earlier draft put the practice block after the contract,
 * so a 4B's final input was six caution bullets ending in "stop and check";
 * against a model already prone to answering instead of building, that is the
 * wrong note to end on.
 *
 * An agent that reads only the first two lines still learns it is not alone in
 * the tree, which is the single fact whose absence produced the duplicates.
 */
export function divisionBriefing(division: Division, contract: string): string {
  const assigned =
    division.name !== undefined && division.responsibility !== undefined
      ? ` You are assigned to the ${division.name} division, which is responsible for ${division.responsibility}.`
      : ' Other people are working in this tree at the same time as you.';
  return (
    `A team is working in this project.${assigned}` +
    section('WHAT ALREADY EXISTS HERE', division.overview) +
    section('STILL TO DO IN THIS DIVISION', division.todo) +
    checklistBlock(division.checklist) +
    `\n\n${DIVISION_PRACTICE}` +
    section('YOUR CONTRACT', contract)
  );
}
