/**
 * The rule that keeps the attachment spinner alive across send — and, just as
 * importantly, the three ways it is forced to clear.
 *
 * the user asked for the spinner to survive send; he also drew the line: an
 * indicator that never clears is worse than none. Both halves are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { PREFILL_MIN_CHARS } from './composer/prefill-gate';
import { awaitingReplyAfterLatestTurn, sentAttachmentsPrefilling } from './sent-prefill';

const big = (id: string) => ({ id, text: 'x'.repeat(PREFILL_MIN_CHARS + 10) });
const small = (id: string) => ({ id, text: 'x'.repeat(PREFILL_MIN_CHARS - 10) });

const sending = {
  files: [big('0:notes.md')],
  isLatestTurn: true,
  awaitingReply: true,
  turnPrefilling: true,
};

describe('sentAttachmentsPrefilling', () => {
  it('keeps the spinner on the just-sent turn while the prompt is being read', () => {
    expect([...sentAttachmentsPrefilling(sending)]).toEqual(['0:notes.md']);
  });

  it('clears it the moment the turn is past prefill', () => {
    // `turnPrefilling` goes false on the first token — the same signal the
    // thread's processing ring stands down on.
    expect(sentAttachmentsPrefilling({ ...sending, turnPrefilling: false }).size).toBe(0);
  });

  it('never spins on an older turn', () => {
    expect(sentAttachmentsPrefilling({ ...sending, isLatestTurn: false }).size).toBe(0);
  });

  it('never spins on a turn that has already been answered', () => {
    // The guard that matters: a chat REOPENED from disk, whose last question
    // carried a big file, must not spin because a warm-up left a flag raised.
    expect(sentAttachmentsPrefilling({ ...sending, awaitingReply: false }).size).toBe(0);
  });

  it('uses the prefill threshold, so a chip that never spun does not start now', () => {
    const mixed = sentAttachmentsPrefilling({
      ...sending,
      files: [big('0:big.md'), small('1:tiny.txt')],
    });
    expect([...mixed]).toEqual(['0:big.md']);
  });

  it('returns one stable empty set, so an idle thread does not churn identities', () => {
    const a = sentAttachmentsPrefilling({ ...sending, turnPrefilling: false });
    const b = sentAttachmentsPrefilling({ ...sending, isLatestTurn: false });
    expect(a).toBe(b);
  });
});

describe('awaitingReplyAfterLatestTurn', () => {
  const user = { kind: 'user' as const };
  const done = { kind: 'assistant' as const, isStreaming: false };
  const live = { kind: 'assistant' as const, isStreaming: true };

  it('is true in the gap between the send and the first assistant message', () => {
    expect(awaitingReplyAfterLatestTurn([user, done, user])).toBe(true);
  });

  it('is true while the assistant has started but not settled', () => {
    // The pre-first-token window — exactly what the spinner is about.
    expect(awaitingReplyAfterLatestTurn([user, live])).toBe(true);
  });

  it('is false once the turn has an answer', () => {
    expect(awaitingReplyAfterLatestTurn([user, done])).toBe(false);
  });

  it('is false on an empty thread — nothing was sent, nothing is being read', () => {
    expect(awaitingReplyAfterLatestTurn([])).toBe(false);
  });

  it('looks past rows that are neither question nor answer', () => {
    const notice = { kind: 'notice' as const };
    const tool = { kind: 'toolResult' as const };
    expect(awaitingReplyAfterLatestTurn([user, notice, tool])).toBe(true);
    expect(awaitingReplyAfterLatestTurn([user, done, notice])).toBe(false);
  });
});
