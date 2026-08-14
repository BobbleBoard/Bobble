import { describe, expect, it } from 'vitest';
import { DIVISION_PRACTICE, type Division, divisionBriefing } from './division.js';

const UI: Division = {
  name: 'UI',
  responsibility: 'everything the user sees and clicks',
  overview: 'A component library and both themes exist under the UI folder.',
  todo: 'The main window is not wired to the entry point yet.',
  checklist: ['Every screen works in both themes.'],
};

describe('divisionBriefing', () => {
  it('says a team is here and names the division and its responsibility', () => {
    const out = divisionBriefing(UI, 'Build the drop zone.');
    expect(out).toMatch(/A team is working in this project/);
    expect(out).toContain('UI division');
    expect(out).toContain('everything the user sees and clicks');
  });

  /* The most important field. The duplicate-tree failure was an agent that did
   * not know the thing it was about to build already existed. */
  it('leads with what already exists, and ENDS with the contract', () => {
    const out = divisionBriefing(UI, 'Build the drop zone.');
    expect(out.indexOf('WHAT ALREADY EXISTS HERE')).toBeLessThan(out.indexOf('YOUR CONTRACT'));
    expect(out).toContain('A component library and both themes exist');
    /* The last thing read before generating must be the thing to act on — not a
     * caution list. A 4B that ends on "read what is there" tends to go and read. */
    expect(out.indexOf(DIVISION_PRACTICE)).toBeLessThan(out.indexOf('YOUR CONTRACT'));
    expect(out.trimEnd().endsWith('Build the drop zone.')).toBe(true);
  });

  it('carries the contract and the standing practice', () => {
    const out = divisionBriefing(UI, 'Build the drop zone.');
    expect(out).toContain('Build the drop zone.');
    expect(out).toContain(DIVISION_PRACTICE);
  });

  it('renders the division checklist when there is one', () => {
    expect(divisionBriefing(UI, 'x')).toContain('- Every screen works in both themes.');
  });

  /* An empty heading is noise, and a 4B reads noise as instruction. `overview` is
   * required so it is never one of these — an empty area says "Nothing yet." */
  it('omits every optional section it has no content for', () => {
    const bare = divisionBriefing(
      { name: 'Core', responsibility: 'the engine', overview: 'Nothing yet.' },
      'Ship it.',
    );
    expect(bare).not.toContain('STILL TO DO');
    expect(bare).not.toContain('THIS DIVISION IS HELD TO');
    expect(bare).toContain('WHAT ALREADY EXISTS HERE');
    expect(bare).toContain('YOUR CONTRACT');
  });
});

describe('DIVISION_PRACTICE', () => {
  /*
   * THE WHOLE TREE, not the path you were heading for.
   *
   * The first draft said "List the files where you are about to work" — and a
   * duplicate is BY DEFINITION somewhere you were not about to work. An engineer
   * heading for `conversers/` lists `conversers/`, finds it empty, and builds the
   * second copy. The bullet could not catch the failure it was written for.
   */
  it('sends them to the WHOLE tree, not just where they intend to write', () => {
    expect(DIVISION_PRACTICE).toMatch(/List the whole tree once/);
    expect(DIVISION_PRACTICE).toMatch(/not where you were about to look/);
    expect(DIVISION_PRACTICE).not.toMatch(/where you are about to work/);
    expect(DIVISION_PRACTICE).toMatch(/do not build it again/);
  });

  /*
   * NOTHING THAT RESOLVES TO "END YOUR TURN".
   *
   * "ask the person who owns it" was unfollowable AND harmful: engineers cannot
   * reach each other (roster peers are the manager and specialists), and the
   * manager is unreachable mid-task by design, so the only way to obey it was to
   * stop. It also forbade the fix for half the measured failure — wiring your work
   * into an entry point means touching a file outside your division. The
   * non-blocking form says it in the reply instead.
   */
  it('never tells an agent to ask permission or stop, since neither is reachable', () => {
    expect(DIVISION_PRACTICE).not.toMatch(/ask the person who owns it/);
    expect(DIVISION_PRACTICE).not.toMatch(/^- Stop and check/m);
    expect(DIVISION_PRACTICE).toMatch(/Say in your reply what else needs changing/);
  });

  /* An imperative, not an observation about cost. A 4B obeys orders, not claims. */
  it('gives the duplicate rule as an order', () => {
    expect(DIVISION_PRACTICE).toMatch(/Never make a second copy under a new name/);
  });

  it('demands a read before a large delete', () => {
    expect(DIVISION_PRACTICE).toMatch(/Read what is there before any large delete or replace/);
  });

  /*
   * NO OVERFITTING. the user: "just ensure it's not task specific … i'm not going to
   * tell you you're overfitting to any task because many projects don't use git"
   * — so `git` is allowed ONCE and only hedged, and nothing narrower is allowed
   * at all. This test is the guard: a future edit that reaches for a framework or
   * a file layout to make one benchmark pass fails here.
   */
  it('names no language, framework, tool or layout that only some projects have', () => {
    const banned = [
      'npm',
      'node',
      'python',
      'react',
      'electron',
      'godot',
      'tailwind',
      'vite',
      'src/',
      '.scratch',
      'package.json',
      'index.html',
      'jsx',
      'css',
    ];
    const lower = DIVISION_PRACTICE.toLowerCase();
    for (const word of banned) expect(lower, `must not mention ${word}`).not.toContain(word);
  });

  /* the user allows `git` explicitly, hedged: "it's ok to say check git, but with an
   * if applicable and 'or equivalent'". Kept as an IMPERATIVE with the hedge
   * inside it — "Skip this if it has none" was a separate sentence granting
   * permission to ignore the line, which is the shape that makes a hedge read as
   * "optional". */
  it('hedges the one history mechanism it names, without making the line optional', () => {
    expect(DIVISION_PRACTICE).toMatch(/git, or whatever this one uses/);
    expect(DIVISION_PRACTICE).toMatch(/^- Check the project's history/m);
  });

  /*
   * SHORT ENOUGH TO BE READ. Complication is the failure mode at 4B, so the
   * practice block is budgeted rather than left to grow one clause at a time.
   */
  it('stays short — every line one instruction, no line a paragraph', () => {
    const lines = DIVISION_PRACTICE.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(DIVISION_PRACTICE.split(/\s+/).length).toBeLessThan(200);
    for (const line of lines) expect(line.split(/\s+/).length, line).toBeLessThan(45);
  });
});
