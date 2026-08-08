import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseEdit, diagnoseEditFailure, nearestMiss } from './edit-diagnosis.js';

/* The real fixture from run G, verbatim — the file the model failed to edit six
 * times. Keeping the actual bytes means these tests fail if the diagnosis stops
 * working on the case that motivated it. */
const APP = `import tkinter as tk
from tkinter import ttk
import os

class ConvertApp:
    def __init__(self, root):
        self.root = root
        root.title("TinyConvert v0.9 BETA")
        root.geometry("520x300")
        self.status = tk.StringVar(value="Ready")

    def handle_drop(self, path):
        self.listbox.insert("end", os.path.basename(path))
        self.convert(path)
`;

describe('nearestMiss', () => {
  /* THE run G failure: an underscore where the file has a space, 38 characters
   * into one line of a 1165-character file. It re-read the file four times and
   * never found this. */
  it('finds the one character that differs and names both sides', () => {
    const miss = nearestMiss(APP, '        root.title("TinyConvert v0.9_BETA")\n');
    expect(miss).not.toBeNull();
    expect(miss?.line).toBe(8);
    expect(miss?.expected).toContain('space');
    expect(miss?.actual).toContain('_');
    // Column points at the offending character, not the start of the line.
    expect(miss?.modelLine[(miss?.column ?? 1) - 1]).toBe('_');
  });

  it('reports the differing line inside a multi-line block, not the anchor', () => {
    const miss = nearestMiss(
      APP,
      '    def handle_drop(self, path):\n        self.listbox.insert("end", path)\n',
    );
    expect(miss?.line).toBe(13); // the second line of the block, not line 12
  });

  it('catches an indent mismatch, which is invisible in a plain error', () => {
    const miss = nearestMiss(APP, '      root.title("TinyConvert v0.9 BETA")\n');
    expect(miss?.line).toBe(8);
    expect(miss?.column).toBe(7);
  });

  /* Non-ASCII look-alikes are the other half of the family — a curly quote next
   * to an ASCII one is genuinely indistinguishable on screen. */
  it('flags a look-alike character as non-ASCII', () => {
    const miss = nearestMiss(APP, '        root.title(“TinyConvert v0.9 BETA”)\n');
    expect(miss?.actual).toContain('not ASCII');
  });

  it('stays silent when nothing in the file is close', () => {
    expect(nearestMiss(APP, 'def totally_unrelated_function(a, b, c):\n')).toBeNull();
  });

  it('stays silent when the text does match', () => {
    expect(nearestMiss(APP, '        root.geometry("520x300")')).toBeNull();
  });
});

describe('diagnoseEdit', () => {
  /* Run G's actual last attempt: edits[0] was correct, edits[1] had the
   * underscore. The batch is atomic, so BOTH were discarded — and the model,
   * told only about edits[1], rewrote edits[0] from memory next round and lost
   * it again. Six times. */
  it('says which entries were already correct, so they are not re-derived', () => {
    const note = diagnoseEdit(
      APP,
      [
        { oldText: 'from tkinter import ttk\nimport os\n', newText: 'x' },
        { oldText: '        root.title("TinyConvert v0.9_BETA")\n', newText: 'y' },
      ],
      'app.py',
    );
    expect(note).toMatch(/1 of 2 would have matched/);
    expect(note).toMatch(/send them again UNCHANGED/);
    expect(note).toContain('edits[1]');
    expect(note).not.toContain('edits[0] —');
  });

  /* Attempts 5 and 6 failed on edits[3], then edits[1] — one discovery per
   * round-trip, minutes apart. Every bad entry has to come back at once. */
  it('reports every failing entry in one go, not just the first', () => {
    const note = diagnoseEdit(
      APP,
      [
        { oldText: '        root.title("TinyConvert v0.9_BETA")\n', newText: 'a' },
        { oldText: '        self.status = tk.StringVar(value="ready")\n', newText: 'b' },
      ],
      'app.py',
    );
    expect(note).toContain('edits[0]');
    expect(note).toContain('edits[1]');
  });

  it('names an ambiguous match instead of a missing one', () => {
    const twice = 'a = 1\nb = 2\na = 1\n';
    expect(diagnoseEdit(twice, [{ oldText: 'a = 1', newText: 'a = 3' }], 'x.py')).toMatch(
      /appears more than once/,
    );
  });

  it('adds nothing when every entry matches — no noise on a real failure', () => {
    expect(
      diagnoseEdit(APP, [{ oldText: '        root.geometry("520x300")', newText: 'z' }], 'app.py'),
    ).toBe('');
  });

  it('ignores entries whose oldText is not a string', () => {
    expect(diagnoseEdit(APP, [{ oldText: undefined, newText: 'z' }], 'app.py')).toBe('');
  });

  /* Over-indented, so it genuinely cannot be found — an UNDER-indented oldText is
   * still a substring of the real line and the tool accepts it. */
  it('renders whitespace visibly so an indent error can be seen at all', () => {
    const note = diagnoseEdit(
      APP,
      [{ oldText: '          root.title("TinyConvert v0.9 BETA")\n', newText: 'q' }],
      'app.py',
    );
    expect(note).toContain('·');
    expect(note).toMatch(/\^/);
  });
});

describe('diagnoseEditFailure', () => {
  const args = (p: string) => ({
    path: p,
    edits: [{ oldText: '        root.title("TinyConvert v0.9_BETA")\n', newText: 'q' }],
  });

  /*
   * THE TILDE, for the third time. `py_compile` ran on a quoted `~` and silently
   * checked nothing; `present` stat'd a literal `~` and rendered an empty card.
   * The model writes `~/...` constantly — if this reads the wrong file it finds
   * no near-miss and says nothing, which looks exactly like "no problem here".
   */
  it('expands ~ before reading, or it silently diagnoses nothing', () => {
    const seen: string[] = [];
    const note = diagnoseEditFailure(args('~/bobble-testbed/buggyapp/app.py'), undefined, (f) => {
      seen.push(f);
      return APP;
    });
    expect(seen[0]?.startsWith('~')).toBe(false);
    expect(seen[0]).toBe(path.join(os.homedir(), 'bobble-testbed/buggyapp/app.py'));
    expect(note).toContain('Column');
  });

  it('resolves a relative path against the workspace, not the process cwd', () => {
    const seen: string[] = [];
    diagnoseEditFailure(args('app.py'), '/work/space', (f) => {
      seen.push(f);
      return APP;
    });
    expect(seen[0]).toBe('/work/space/app.py');
  });

  /* A failed edit is already a bad moment; a throwing diagnostic would replace a
   * real error message with a worse one. */
  it('says nothing when the file cannot be read', () => {
    expect(
      diagnoseEditFailure(args('/nope/app.py'), undefined, () => {
        throw new Error('ENOENT');
      }),
    ).toBe('');
  });

  it('says nothing when the arguments are not an edit call', () => {
    expect(diagnoseEditFailure({ path: 'a.py' }, undefined, () => APP)).toBe('');
    expect(diagnoseEditFailure({ edits: [] }, undefined, () => APP)).toBe('');
  });
});
