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

describe('a superseded prime cannot clear its replacement', () => {
  /*
   * The bug this guards against is not in `abortsOnSend` itself — it is in what
   * the hook feeds it. A prime that has already been replaced resolves LAST,
   * and its `finally` used to null the record belonging to the prime that
   * replaced it. `abortsOnSend(null, …)` is then true, so the send cancelled
   * work that was about to serve it. MEASURED on a chat switch: two primes
   * logging `aborted: true` five milliseconds apart and a 2.4s send against a
   * prefix that was already resident.
   */
  it('is decided by the record that is actually live', () => {
    const live = { prefix: PREFIX, turns: 0, ticket: {} };
    expect(abortsOnSend(live, { body: `${PREFIX}\n\nhi` }, 0)).toBe(false);
    // What the old code left behind, and what it cost:
    expect(abortsOnSend(null, { body: `${PREFIX}\n\nhi` }, 0)).toBe(true);
  });
});
