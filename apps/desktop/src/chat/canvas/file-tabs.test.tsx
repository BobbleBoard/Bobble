// @vitest-environment jsdom
/**
 * A file you click must SHOW you something.
 *
 * the user, on a report a subagent wrote and handed back: "it just shows up blank in
 * the canvas sidebar… it was unable to be read or clicked on or viewed by me."
 * The write parsed, the +N line counter climbed, and the tab opened empty —
 * because a failed read set no artifact at all. A blank pane is the worst answer
 * available: it reads as an empty FILE, so you go hunting for a bug in whatever
 * wrote it instead of looking at the path.
 */
import { describe, expect, it } from 'vitest';
import { fileArtifact, presentEdit, unreadableFileArtifact } from './file-tabs';

describe('unreadableFileArtifact', () => {
  const art = unreadableFileArtifact('/Users/user/bobble-testbed/run/report.md');

  it('says it could not read the file, rather than showing nothing', () => {
    expect(art.content.kind).toBe('text');
    expect((art.content as { text: string }).text).toContain('Could not read this file');
  });

  it('names the PATH it actually tried — "not found" is useless without it', () => {
    expect((art.content as { text: string }).text).toContain(
      '/Users/user/bobble-testbed/run/report.md',
    );
  });

  it('titles the tab with the filename, like any other file tab', () => {
    expect(art.title).toBe('report.md');
    expect(art.filename).toBe('report.md');
  });

  it('does not claim the file was empty or that anything was lost', () => {
    const text = (art.content as { text: string }).text.toLowerCase();
    expect(text).not.toContain('empty file');
    expect(text).toContain('nothing has been lost');
  });

  it('shares the tab identity of the real artifact, so it REPLACES cleanly', () => {
    // Same id as a successful read of the same path — when the file appears, the
    // explanation is replaced rather than accumulating a second tab.
    const ok = fileArtifact('/Users/user/bobble-testbed/run/report.md', {
      text: '# hi',
      binary: false,
      tooLarge: false,
      bytes: 4,
    } as never);
    expect(art.id).toBe(ok.id);
  });
});

/**
 * HOW AN EDIT IS SHOWN — the motion whenever it can be played, the diff only
 * when it cannot. the user asked for the file with the edit happening in it, not a
 * diff being typed out; the diff is what is left when there is nowhere to stand
 * the caret.
 */
describe('presentEdit', () => {
  const base = ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n');
  const hunk = { oldText: 'const b = 2;', newText: 'const b = 22;' };

  it('plays the motion when the file and the hunk are both known', () => {
    const shown = presentEdit('/x/a.ts', base, [hunk], hunk);
    expect(shown.kind).toBe('animate');
    if (shown.kind !== 'animate') return;
    expect(shown.plan.baseText).toBe(base);
    expect(shown.plan.finalText).toBe(base.replace(hunk.oldText, hunk.newText));
    expect(shown.plan.hunks).toHaveLength(1);
  });

  it('orders several hunks down the file, whatever order the tool listed them', () => {
    const shown = presentEdit(
      '/x/a.ts',
      base,
      [
        { oldText: 'const c = 3;', newText: 'const c = 30;' },
        { oldText: 'const a = 1;', newText: 'const a = 10;' },
      ],
      { oldText: 'const c = 3;', newText: 'const c = 30;' },
    );
    expect(shown.kind).toBe('animate');
    if (shown.kind !== 'animate') return;
    expect(shown.plan.hunks.map((h) => h.oldText)).toEqual(['const a = 1;', 'const c = 3;']);
  });

  it('falls back to a diff when the file could not be read', () => {
    const shown = presentEdit('/x/a.ts', undefined, [hunk], hunk);
    expect(shown.kind).toBe('diff');
    if (shown.kind !== 'diff') return;
    expect(shown.diff[0]?.path).toBe('a.ts');
  });

  it('falls back to a diff when the old text is not in the file', () => {
    const shown = presentEdit('/x/a.ts', base, [{ oldText: 'const nowhere = 9;', newText: 'x' }], {
      oldText: 'const nowhere = 9;',
      newText: 'x',
    });
    expect(shown.kind).toBe('diff');
  });

  it('falls back to a diff while the arguments are still arriving (no hunks yet)', () => {
    const shown = presentEdit('/x/a.ts', base, undefined, hunk);
    expect(shown.kind).toBe('diff');
  });
});
