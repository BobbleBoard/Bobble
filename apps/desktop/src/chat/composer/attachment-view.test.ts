import { describe, expect, it } from 'vitest';
import {
  attachmentMeta,
  EMPTY_SELECTION,
  estimateTokens,
  extensionOf,
  formatBytes,
  pruneSelection,
  selectClick,
} from './attachment-view';

describe('formatBytes', () => {
  it('reads the way a Finder row reads', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(940)).toBe('940 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(10_590_617)).toBe('10.1 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 3.5)).toBe('3.5 GB');
  });

  it('drops a trailing .0, because "42.0 MB" reads like a measurement', () => {
    expect(formatBytes(1024 * 1024 * 42)).toBe('42 MB');
    expect(formatBytes(1024 * 1024 * 106)).toBe('106 MB');
  });

  it('renders nothing rather than NaN for a size we do not have', () => {
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});

describe('extensionOf', () => {
  it('takes the tail, upper-cased', () => {
    expect(extensionOf('screenshot.png')).toBe('PNG');
    expect(extensionOf('Q3 report.final.docx')).toBe('DOCX');
  });

  it('answers FILE rather than collapsing the row it sits in', () => {
    expect(extensionOf('Makefile')).toBe('FILE');
    expect(extensionOf('.gitignore')).toBe('FILE');
  });
});

describe('attachmentMeta', () => {
  it('gives a text file a size, an extension and a token count', () => {
    const m = attachmentMeta({
      name: 'notes.md',
      kind: 'text',
      bytes: 10_590_617,
      text: 'x'.repeat(9920),
    });
    expect(m.size).toBe('10.1 MB');
    expect(m.ext).toBe('MD');
    expect(m.tokens).toBe('2,480 tokens');
  });

  /*
   * NOT AN OMISSION. Images are excluded from prefill on purpose, and their cost
   * in tokens depends on a projector we do not measure. A number we cannot stand
   * behind is worse than a blank.
   */
  it('gives an image no token count', () => {
    expect(attachmentMeta({ name: 'shot.png', kind: 'image', bytes: 2048 }).tokens).toBeNull();
  });

  it('leaves the size blank rather than guessing one', () => {
    expect(attachmentMeta({ name: 'a.txt', kind: 'text', text: 'hi' }).size).toBe('');
  });
});

describe('estimateTokens', () => {
  it('is the same four-chars-per-token the thread already uses', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('a plain click replaces the selection and moves the anchor', () => {
    const s = selectClick(EMPTY_SELECTION, order, 'b', {});
    expect(s).toEqual({ ids: ['b'], anchor: 'b' });
    expect(selectClick(s, order, 'd', {})).toEqual({ ids: ['d'], anchor: 'd' });
  });

  it('shift extends from the anchor, in either direction', () => {
    const s = selectClick(EMPTY_SELECTION, order, 'c', {});
    expect(selectClick(s, order, 'a', { shift: true }).ids).toEqual(['a', 'b', 'c']);
    expect(selectClick(s, order, 'd', { shift: true }).ids).toEqual(['c', 'd']);
  });

  /*
   * THE ANCHOR STAYS PUT under shift. Sweeping a shift-selection back and forth
   * must measure from where it started — an anchor that follows the last click
   * is the bug nobody reports and everybody feels.
   */
  it('keeps the anchor where the plain click put it', () => {
    let s = selectClick(EMPTY_SELECTION, order, 'b', {});
    s = selectClick(s, order, 'd', { shift: true });
    expect(s.anchor).toBe('b');
    expect(selectClick(s, order, 'a', { shift: true }).ids).toEqual(['a', 'b']);
  });

  it('cmd-click toggles one without disturbing the rest', () => {
    let s = selectClick(EMPTY_SELECTION, order, 'a', {});
    s = selectClick(s, order, 'c', { meta: true });
    expect(s.ids).toEqual(['a', 'c']);
    s = selectClick(s, order, 'a', { meta: true });
    expect(s.ids).toEqual(['c']);
  });

  it('shift with no anchor behaves like a plain click', () => {
    expect(selectClick(EMPTY_SELECTION, order, 'c', { shift: true })).toEqual({
      ids: ['c'],
      anchor: 'c',
    });
  });

  it('ignores a click on something that is not there', () => {
    expect(selectClick(EMPTY_SELECTION, order, 'zz', {})).toEqual(EMPTY_SELECTION);
  });

  it('prunes ids that have been removed, and the anchor with them', () => {
    const s = { ids: ['a', 'b'], anchor: 'b' };
    expect(pruneSelection(s, ['a'])).toEqual({ ids: ['a'], anchor: null });
    // Unchanged selections keep their identity so React does not re-render.
    expect(pruneSelection(s, order)).toBe(s);
  });
});
