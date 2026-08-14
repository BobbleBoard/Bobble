import { describe, expect, it } from 'vitest';
import { DIVISION_PRACTICE, type Division, divisionBriefing, treeDelta } from './division.js';

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

/*
 * NO DIVISION NAMED — the common case at first, because the manager names the
 * area in its contract prose rather than in a structured field. The block must
 * still deliver its real payload: you are not alone, here is what exists, here is
 * how not to trample it.
 */
describe('divisionBriefing without a named division', () => {
  const anon = { overview: 'main.js and a renderer folder exist at the top level.' };

  it('still warns that other people are in the tree', () => {
    const out = divisionBriefing(anon, 'Wire the entry point.');
    expect(out).toMatch(/A team is working in this project/);
    expect(out).toMatch(/Other people are working in this tree at the same time as you/);
    expect(out).not.toContain('undefined');
  });

  it('still carries the tree, the practice and the contract, in that order', () => {
    const out = divisionBriefing(anon, 'Wire the entry point.');
    expect(out).toContain('main.js and a renderer folder exist');
    expect(out.indexOf('WHAT ALREADY EXISTS HERE')).toBeLessThan(out.indexOf(DIVISION_PRACTICE));
    expect(out.indexOf(DIVISION_PRACTICE)).toBeLessThan(out.indexOf('YOUR CONTRACT'));
  });
});

/*
 * THE WIRING CONTRACT, asserted here because the host that does it is Electron
 * code the unit suite cannot import.
 *
 * mesh-host.ts builds every role's incoming message. On FIRST contact with a
 * non-manager it wraps the contract in divisionBriefing with `listProject(cwd)`
 * as the overview; every later message stays bare, because the first message is
 * the KV prefix and a listing that barely changes is not worth re-prefilling.
 *
 * What matters and is easy to lose in a refactor: the contract must survive the
 * wrapping intact, and the tree must arrive with it.
 */
describe('the shape mesh-host relies on', () => {
  const contract = 'CONTRACT: React + Tailwind UI Framework\n\nFILES YOU OWN:\n- ui/framework/';

  it('wraps a real contract without altering a character of it', () => {
    const out = divisionBriefing({ overview: 'main.js\nrenderer/index.html' }, contract);
    expect(out).toContain(contract);
  });

  it('carries the tree listing the host passes in', () => {
    const out = divisionBriefing({ overview: 'main.js\nrenderer/index.html' }, contract);
    expect(out).toContain('main.js');
    expect(out).toContain('renderer/index.html');
  });

  /* An empty workspace is the first engineer's normal case — it must read as a
   * fact, not as a missing section. */
  it('renders an empty workspace as "Nothing yet." rather than a gap', () => {
    const out = divisionBriefing({ overview: 'Nothing yet.' }, contract);
    expect(out).toContain('WHAT ALREADY EXISTS HERE\nNothing yet.');
  });
});

describe('treeDelta', () => {
  const before = 'src/main.ts\nsrc/utils/format/image-formats.ts';

  it('says nothing on first contact, where the full briefing already ran', () => {
    expect(treeDelta(undefined, `${before}\nsrc/new.ts`)).toBe('');
  });

  it('says nothing when the tree has not moved — silence is the common case', () => {
    expect(treeDelta(before, before)).toBe('');
  });

  /* The whole mechanism: the path that would have prevented the duplicate,
   * arriving on the turn it is needed. */
  it('names exactly what appeared, and attributes it to other people', () => {
    const out = treeDelta(before, `${before}\nsrc/renderer/utils/format/formats.ts`);
    expect(out).toContain('APPEARED SINCE YOU LAST WORKED');
    expect(out).toContain('other people wrote these');
    expect(out).toContain('src/renderer/utils/format/formats.ts');
    /* Only the new one — repeating what it already saw is what the cap exists for. */
    expect(out).not.toContain('src/main.ts');
  });

  it('ignores files that disappeared — this answers "what is new", not "what changed"', () => {
    expect(treeDelta(before, 'src/main.ts')).toBe('');
  });

  /* A delta longer than the contract is a delta nobody reads. */
  it('caps the list and says how many it held back', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`).join('\n');
    const out = treeDelta('src/main.ts', `src/main.ts\n${many}`, 5);
    expect(out.split('\n').filter((l) => l.startsWith('src/f'))).toHaveLength(5);
    expect(out).toContain('(+25 more)');
  });
});
