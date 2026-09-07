import { describe, expect, it, vi } from 'vitest';
import { deleteAdjacentPill } from './pill-delete';

const pill = () => ({ remove: vi.fn() });

describe('deleteAdjacentPill', () => {
  it('removes the pill behind the caret on Backspace, in one press', () => {
    const p = pill();
    expect(deleteAdjacentPill({ before: p }, 'backward')).toBe(true);
    expect(p.remove).toHaveBeenCalledOnce();
  });

  it('removes the pill in front of the caret on Delete', () => {
    const p = pill();
    expect(deleteAdjacentPill({ after: p }, 'forward')).toBe(true);
    expect(p.remove).toHaveBeenCalledOnce();
  });

  /* Direction is the whole point: Backspace must not eat what is ahead of it. */
  it('does not reach across the caret', () => {
    const ahead = pill();
    expect(deleteAdjacentPill({ after: ahead }, 'backward')).toBe(false);
    expect(ahead.remove).not.toHaveBeenCalled();
  });

  it('lets ordinary text deletion through when no pill is adjacent', () => {
    expect(deleteAdjacentPill({}, 'backward')).toBe(false);
    expect(deleteAdjacentPill({ before: null, after: null }, 'forward')).toBe(false);
  });

  /*
   * Lexical still selects a decorator in some paths (a click, arrow-key nav).
   * Once it is selected the user has aimed at it, so either key finishes it.
   */
  it('removes an already-selected pill on either key', () => {
    for (const dir of ['backward', 'forward'] as const) {
      const p = pill();
      expect(deleteAdjacentPill({ selected: p }, dir)).toBe(true);
      expect(p.remove).toHaveBeenCalledOnce();
    }
  });

  it('prefers the selected pill over a neighbour', () => {
    const sel = pill();
    const near = pill();
    deleteAdjacentPill({ selected: sel, before: near }, 'backward');
    expect(sel.remove).toHaveBeenCalledOnce();
    expect(near.remove).not.toHaveBeenCalled();
  });
});
