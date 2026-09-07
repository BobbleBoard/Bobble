import { describe, expect, it } from 'vitest';
import { sameWording } from './same-wording';

describe('sameWording', () => {
  it('is true for the identical prompt', () => {
    expect(sameWording('a\nb\nc', 'a\nb\nc')).toBe(true);
  });

  it('is true when the same lines come back in another order', () => {
    expect(sameWording('alpha\nbeta\ngamma', 'gamma\nalpha\nbeta')).toBe(true);
  });

  it('is false when a line actually changed', () => {
    // Same length, different words — a new date, a different working folder.
    expect(sameWording('today is 2026-09-06', 'today is 2026-09-07')).toBe(false);
  });

  it('is false when something was added or removed', () => {
    expect(sameWording('alpha\nbeta', 'alpha\nbeta\ngamma')).toBe(false);
  });

  it('looks past indentation and blank lines, which change no instruction', () => {
    expect(sameWording('alpha\n beta', ' beta\nalpha')).toBe(true);
  });

  it('will not call two prompts the same when one is longer', () => {
    // Cheap and decisive: reordering cannot change the character count, so a
    // different length always means something was rewritten.
    expect(sameWording('alpha\nbeta', 'alpha\nbeta ')).toBe(false);
  });
});
