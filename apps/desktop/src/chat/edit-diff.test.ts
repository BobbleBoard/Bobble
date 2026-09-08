import { describe, expect, it } from 'vitest';
import { editDiffFile, editDiffLines } from './edit-diff';

/**
 * the user: "editing/writing tool calls a lot of the time show up as red."
 *
 * The old shape put every line of `old_string` in as a deletion and every line
 * of `new_string` in as an addition — so the ordinary str_replace, which quotes
 * its surroundings to make the match unique, rendered almost entirely red. The
 * first test here is the one that fails on that code.
 */
describe('editDiffLines', () => {
  it('marks only the changed line, not the whole quoted hunk', () => {
    const before = ['<svg viewBox="0 0 16 16">', '  <path d="M1 1h14" />', '</svg>'].join('\n');
    const after = ['<svg viewBox="0 0 16 16">', '  <path d="M2 2h12" />', '</svg>'].join('\n');
    const { lines, added, deleted } = editDiffLines(before, after);

    expect(added).toBe(1);
    expect(deleted).toBe(1);
    // The two lines that did NOT change are context, not a deletion + addition.
    expect(lines.filter((l) => l.kind === 'context').map((l) => l.text)).toEqual([
      '<svg viewBox="0 0 16 16">',
      '</svg>',
    ]);
    expect(lines.filter((l) => l.kind === 'del')).toHaveLength(1);
    expect(lines.filter((l) => l.kind === 'add')).toHaveLength(1);
  });

  it('does not paint an unchanged hunk at all', () => {
    const same = 'one\ntwo\nthree';
    const { lines, added, deleted } = editDiffLines(same, same);
    expect(added).toBe(0);
    expect(deleted).toBe(0);
    expect(lines.every((l) => l.kind === 'context')).toBe(true);
  });

  it('is all additions for a whole-file write (no old side)', () => {
    const { lines, added, deleted } = editDiffLines(undefined, 'a\nb');
    expect(added).toBe(2);
    expect(deleted).toBe(0);
    expect(lines.map((l) => l.kind)).toEqual(['add', 'add']);
  });

  it('draws the deletions alone while the replacement is still streaming', () => {
    const { lines, added, deleted } = editDiffLines('gone\naway', undefined);
    expect(added).toBe(0);
    expect(deleted).toBe(2);
    expect(lines.map((l) => l.kind)).toEqual(['del', 'del']);
  });

  it('counts a pure insertion as additions only', () => {
    const { added, deleted } = editDiffLines('a\nb', 'a\nnew\nb');
    expect(added).toBe(1);
    expect(deleted).toBe(0);
  });

  it('counts a pure deletion as deletions only', () => {
    const { added, deleted } = editDiffLines('a\nb\nc', 'a\nc');
    expect(added).toBe(0);
    expect(deleted).toBe(1);
  });

  it('collapses a long unchanged run rather than listing it', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const before = [...filler, 'target'].join('\n');
    const after = [...filler, 'changed'].join('\n');
    const { lines } = editDiffLines(before, after);
    expect(lines.some((l) => l.kind === 'hunk')).toBe(true);
    // …and it still shows the neighbourhood of the change.
    expect(lines.filter((l) => l.kind === 'context').length).toBeLessThan(filler.length);
    expect(lines.filter((l) => l.kind === 'context').length).toBeGreaterThan(0);
  });

  it('falls back to block-for-block on a rewrite too large to diff', () => {
    const big = Array.from({ length: 900 }, (_, i) => `l${i}`).join('\n');
    const { lines, added, deleted } = editDiffLines(big, big);
    expect(deleted).toBe(900);
    expect(added).toBe(900);
    expect(lines).toHaveLength(1800);
  });
});

describe('editDiffFile', () => {
  it('carries the real ±stat into the header', () => {
    const file = editDiffFile('file-icon.svg', 'a\nb\nc', 'a\nB\nc');
    expect(file.path).toBe('file-icon.svg');
    expect(file.added).toBe(1);
    expect(file.deleted).toBe(1);
  });
});
