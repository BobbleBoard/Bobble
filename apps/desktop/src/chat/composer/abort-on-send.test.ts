/**
 * A prime the turn begins with must survive the send — the user's rule that waiting
 * for an attachment costs you only what is LEFT of it, never the whole thing
 * again. These are the four cases that decide it.
 */
import { describe, expect, it } from 'vitest';
import { abortsOnSend } from './attachment-prefill';

const PREFIX = 'Attached file `notes.txt`:\n```\nhello\n```';

describe('abortsOnSend', () => {
  it('keeps a prime the turn begins with', () => {
    expect(
      abortsOnSend({ prefix: PREFIX, turns: 0 }, { body: `${PREFIX}\n\nwhat is this?` }, 0),
    ).toBe(false);
  });

  it('keeps a prime when the turn is the attachment alone', () => {
    expect(abortsOnSend({ prefix: PREFIX, turns: 2 }, { body: PREFIX }, 2)).toBe(false);
  });

  it('cancels a prime for an attachment that is no longer being sent', () => {
    expect(abortsOnSend({ prefix: PREFIX, turns: 0 }, { body: 'just a question' }, 0)).toBe(true);
  });

  it('cancels a prime rendered against a different conversation', () => {
    // Same text, but a reply landed since — the primed history is not this one.
    expect(abortsOnSend({ prefix: PREFIX, turns: 0 }, { body: `${PREFIX}\n\nhi` }, 2)).toBe(true);
  });

  it('cancels when the caller does not say what it is sending', () => {
    expect(abortsOnSend({ prefix: PREFIX, turns: 0 }, undefined, 0)).toBe(true);
  });

  it('is a no-op decision when nothing is priming', () => {
    expect(abortsOnSend(null, { body: PREFIX }, 0)).toBe(true);
  });
});
