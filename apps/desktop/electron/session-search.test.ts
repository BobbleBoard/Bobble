/**
 * b7: sidebar search reaches the words in a conversation, not just its title.
 *
 * The title is the first user message cut to 80 characters, so the chat you
 * remember by something SAID in it was exactly the one you could not find.
 */
import { describe, expect, it } from 'vitest';
import { excerptAround } from './fs-handlers';

const around = (text: string, needle: string) =>
  excerptAround(text.toLowerCase(), text, needle.toLowerCase());

describe('excerptAround', () => {
  it('returns null when the phrase is absent', () => {
    expect(around('nothing to see', 'kubernetes')).toBeNull();
  });

  it('windows ±80 characters and marks the trimmed edges', () => {
    const text = `${'a'.repeat(200)} NEEDLE ${'b'.repeat(200)}`;
    const out = around(text, 'needle');
    expect(out).not.toBeNull();
    expect(out).toContain('NEEDLE');
    expect(out?.startsWith('…')).toBe(true);
    expect(out?.endsWith('…')).toBe(true);
    // Bounded: the window, the needle, and the two ellipses.
    expect((out ?? '').length).toBeLessThan(200);
  });

  it('does not mark an edge it did not trim', () => {
    const out = around('needle at the very start of a short line', 'needle');
    expect(out).toBe('needle at the very start of a short line');
  });

  it('collapses whitespace so a wrapped excerpt stays one line', () => {
    const out = around('the\n\n  needle   was\there', 'needle');
    expect(out).toBe('the needle was here');
  });

  it('is case-insensitive through the lowered haystack', () => {
    expect(around('The Needle', 'NEEDLE')).toContain('Needle');
  });
});
