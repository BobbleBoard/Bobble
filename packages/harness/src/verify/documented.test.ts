import { describe, expect, it } from 'vitest';
import {
  documentedCommands,
  documentedPromises,
  readmeIn,
  undemonstrated,
  unrunCommands,
} from './documented.js';

/* The real run-H fixture README, verbatim. The promise on the last line is the
 * defect that survived the model's own fourteen-step test plan. */
const README = `# notes

A tiny command-line note keeper.

    notes add "buy milk"
    notes list
    notes done 0
    notes search milk

Running \`notes\` with no arguments prints usage.
Searching is case-insensitive.
`;

describe('documentedCommands', () => {
  it('reads the commands out of an indented block', () => {
    expect(documentedCommands(README)).toEqual([
      'notes add "buy milk"',
      'notes list',
      'notes done 0',
      'notes search milk',
    ]);
  });

  it('reads a fenced block too, and strips the shell prompt', () => {
    expect(documentedCommands('```sh\n$ tool build\n% tool test\n```')).toEqual([
      'tool build',
      'tool test',
    ]);
  });

  it('does not mistake prose for a command', () => {
    expect(documentedCommands('    This sentence is indented but is clearly prose.')).toEqual([]);
  });
});

describe('unrunCommands', () => {
  /* A documented command is never spelled the way it is actually invoked —
   * `notes add` becomes `python3 notes.py add` — so matching is on the
   * subcommand, not the whole line. */
  it('recognises a documented command inside its real invocation', () => {
    const ran = ['python3 notes.py add "buy milk"', 'python3 notes.py list'];
    expect(unrunCommands(README, ran)).toEqual(['notes done 0', 'notes search milk']);
  });

  it('reports everything when nothing was run at all', () => {
    expect(unrunCommands(README, [])).toHaveLength(4);
  });

  it('is silent when every documented command was exercised', () => {
    const ran = ['notes.py add x', 'notes.py list', 'notes.py done 0', 'notes.py search milk'];
    expect(unrunCommands(README, ran)).toEqual([]);
  });
});

describe('documentedPromises', () => {
  /* THE run-H survivor. */
  it('finds the case-insensitivity promise', () => {
    expect(documentedPromises(README).join(' ')).toMatch(/case-insensitive/i);
  });

  it('finds a promise about output', () => {
    expect(documentedPromises(README).join(' ')).toMatch(/prints usage/);
  });

  it('ignores the block of commands and the headings', () => {
    for (const p of documentedPromises(README)) {
      expect(p).not.toContain('notes add');
      expect(p.startsWith('#')).toBe(false);
    }
  });

  it('says nothing about a README that only describes the project', () => {
    expect(documentedPromises('# thing\n\nA small tool for converting files.\n')).toEqual([]);
  });
});

describe('undemonstrated', () => {
  it('names the promise AND demands input that could break it', () => {
    const note = undemonstrated(README, ['notes.py add x', 'notes.py list', 'notes.py done 0']);
    expect(note).not.toBeNull();
    expect(note).toMatch(/case-insensitive/i);
    /* Run H's exact failure was testing with input that passes either way. */
    expect(note).toMatch(/would fail if the promise were broken/);
    expect(note).toContain('notes search milk');
  });

  it('stays silent when there is no README', () => {
    expect(undemonstrated(null, ['x'])).toBeNull();
    expect(undemonstrated('   ', ['x'])).toBeNull();
  });

  /* Silence is the common case — a README with no promises and every command
   * exercised must cost nothing. */
  it('stays silent when the document promises nothing and all ran', () => {
    expect(undemonstrated('# t\n\nA tool.\n\n    t build\n', ['t build'])).toBeNull();
  });
});

describe('readmeIn + the touched-files guard', () => {
  it('finds a README whatever its case or extension', () => {
    for (const name of ['README.md', 'readme', 'Readme.txt', 'README.rst']) {
      expect(
        readmeIn(
          '/w',
          () => 'body',
          () => [name],
        ),
      ).toBe('body');
    }
  });

  it('is null when the folder has none', () => {
    expect(
      readmeIn(
        '/w',
        () => 'body',
        () => ['app.py', 'notes.json'],
      ),
    ).toBeNull();
  });

  it('is null without a workspace root', () => {
    expect(
      readmeIn(
        null,
        () => 'body',
        () => ['README.md'],
      ),
    ).toBeNull();
    expect(
      readmeIn(
        '',
        () => 'body',
        () => ['README.md'],
      ),
    ).toBeNull();
  });

  /* A plain question in a folder that happens to have a README must not draw a
   * lecture about undemonstrated promises. */
  it('says nothing on a turn that wrote no files', () => {
    expect(undemonstrated(README, [], [])).toBeNull();
  });
});
