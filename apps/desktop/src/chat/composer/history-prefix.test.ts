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
import { historyAsMessages, historyIsRenderable, residentHistory } from './attachment-prefill';

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

  it("carries a reply's thoughts, calls and results the way the provider does", () => {
    // MEASURED 2026-09-13: a reply carried as bare text rendered an EMPTY think
    // block where the turn had its thoughts; the prime rewrote the slot from
    // the first reply on, and the next turn re-read it.
    const rows = [
      user('run it'),
      assistant([
        { type: 'thinking', thinking: 'I should run it.\n' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
      ]),
      {
        kind: 'toolResult',
        id: 'tr',
        toolCallId: 'c1',
        toolName: 'bash',
        text: 'a.txt\n',
        isError: false,
        timestamp: 3,
      } as unknown as Row,
      assistant([{ type: 'text', text: 'Done: a.txt' }]),
    ];
    expect(historyAsMessages(rows)).toEqual([
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should run it.\n',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'a.txt\n' },
      { role: 'assistant', content: 'Done: a.txt' },
    ]);
  });

  it("does not trim: the bytes are the provider's bytes", () => {
    expect(historyAsMessages([user('hi \n')])[0]?.content).toBe('hi \n');
    expect(historyAsMessages([assistant([{ type: 'text', text: ' ok\n' }])])[0]?.content).toBe(
      ' ok\n',
    );
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

  it('accepts a turn that called a tool, now that the call and result render exactly', () => {
    expect(
      historyIsRenderable([
        assistant([{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }]),
        {
          kind: 'toolResult',
          id: 'tr',
          toolCallId: 't1',
          toolName: 'bash',
          text: 'ok',
          isError: false,
          timestamp: 3,
        } as unknown as Row,
      ]),
    ).toBe(true);
    // …but not one whose call is still streaming, or whose result was an image
    // (the provider adds a user turn for it that this rendering does not have).
    expect(historyIsRenderable([assistant([{ type: 'toolCall', id: 't1', name: '' }])])).toBe(
      false,
    );
    expect(
      historyIsRenderable([
        {
          kind: 'toolResult',
          id: 'tr',
          toolCallId: 't1',
          toolName: 'browser_snapshot',
          text: '[image returned by browser_snapshot]',
          isError: false,
          timestamp: 3,
        } as unknown as Row,
      ]),
    ).toBe(false);
  });

  it('refuses a turn that carried an image', () => {
    expect(historyIsRenderable([user('look', { images: ['data:image/png;base64,xx'] })])).toBe(
      false,
    );
  });
});

describe('the wire copy the harness publishes', () => {
  const wire = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: [{ type: 'text', text: 'Working folder: /x.' }] },
    { role: 'assistant', content: 'hello', reasoning_content: 'greet' },
  ];
  const transcript = [
    user('hi'),
    assistant([
      { type: 'thinking', thinking: 'greet' },
      { type: 'text', text: 'hello' },
    ]),
  ];

  it("is used as-is when its last reply is the transcript's last reply", () => {
    // The hidden workspace note is in it; the transcript never had it.
    expect(residentHistory(JSON.stringify(wire), transcript)).toEqual(wire);
  });

  it('is refused when it describes another conversation, a turn in flight, or nothing', () => {
    expect(
      residentHistory(JSON.stringify(wire), [
        user('hi'),
        assistant([{ type: 'text', text: 'bye' }]),
      ]),
    ).toBeNull();
    const streaming = [
      user('hi'),
      { ...(assistant([{ type: 'text', text: 'hello' }]) as object), isStreaming: true } as Row,
    ];
    expect(residentHistory(JSON.stringify(wire), streaming)).toBeNull();
    expect(residentHistory('', transcript)).toBeNull();
    expect(residentHistory('not json', transcript)).toBeNull();
    expect(
      residentHistory(JSON.stringify([{ role: 'user', content: 'x' }]), transcript),
    ).toBeNull();
  });
});
