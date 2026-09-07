/**
 * WHAT THE MODEL ACTUALLY HAS, versus what the screen shows.
 *
 * The composer primes `[system, …history, {user: attachment}]` into the model
 * server's single KV slot. If that history is not what the real turn will send,
 * the prime does not merely miss — it OVERWRITES the correct prefix, and the
 * next turn re-reads the whole conversation.
 *
 * MEASURED before the fix, on a transcript grown with ~3.2k-token pastes:
 *
 *   turn   prompt   read    reused
 *      1   12912    3192     9720
 *      2   16113    6896     9217
 *      3   19314   10101     9213
 *
 * Reuse flat at the system+tools size while the prompt grows: every turn paying
 * for the entire conversation again. That is what these two functions are for.
 */
import { describe, expect, it } from 'vitest';
import { historyAsMessages, historyIsRenderable } from './attachment-prefill';

type Row = Parameters<typeof historyAsMessages>[0][number];
const user = (text: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'user', id: 'u', text, timestamp: 1, ...extra }) as unknown as Row;
const assistant = (blocks: unknown[]) =>
  ({ kind: 'assistant', id: 'a', blocks, timestamp: 2 }) as unknown as Row;

describe('the history the prime renders', () => {
  it('sends what pi holds, not what the bubble shows', () => {
    // A pasted block: the echo is the typed line, pi's copy has the file folded in.
    const rows = [
      user('How many lines was that?', {
        agentText:
          'Attached file `pasted content`:\n```\nline 0\nline 1\n```\n\nHow many lines was that?',
      }),
    ];
    expect(historyAsMessages(rows)[0]?.content).toContain('line 0');
  });

  it('falls back to the visible text when there is no separate copy', () => {
    expect(historyAsMessages([user('just a question')])[0]?.content).toBe('just a question');
  });

  it('drops empty turns rather than sending blank messages', () => {
    expect(historyAsMessages([user('   ')])).toEqual([]);
  });

  it('joins an assistant turn into one message', () => {
    const rows = [
      assistant([
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
      ]),
    ];
    expect(historyAsMessages(rows)[0]).toEqual({ role: 'assistant', content: 'one two' });
  });
});

describe('whether the transcript can be rendered exactly', () => {
  it('accepts a plain conversation', () => {
    expect(historyIsRenderable([user('hi'), assistant([{ type: 'text', text: 'hello' }])])).toBe(
      true,
    );
  });

  it('accepts thinking, which the turn re-renders the same way', () => {
    expect(historyIsRenderable([assistant([{ type: 'thinking', thinking: 'hmm' }])])).toBe(true);
  });

  it('refuses a turn that called a tool', () => {
    // The call and its result are in the model's copy and not in ours; priming
    // over them writes a different conversation into the slot.
    expect(historyIsRenderable([assistant([{ type: 'toolCall', id: 't1' }])])).toBe(false);
  });

  it('refuses a turn that carried an image', () => {
    expect(historyIsRenderable([user('look', { images: ['data:image/png;base64,xx'] })])).toBe(
      false,
    );
  });
});
