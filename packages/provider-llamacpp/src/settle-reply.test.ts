import { describe, expect, it } from 'vitest';
import { type ReplyBlock, settleNote, settleReply } from './settle-reply.js';

const thought = { type: 'thinking' as const, thinking: 'Let me look.' };
const call = { type: 'toolCall' as const, id: 'c1', name: 'bash', arguments: { command: 'ls' } };

describe("settleReply — the reply as llama.cpp's parser would hand it over", () => {
  it('drops the newlines the template puts between </think> and the answer, and a whitespace-only text', () => {
    expect(settleReply([thought, { type: 'text', text: '\n\nHere it is.' }])).toEqual([
      thought,
      { type: 'text', text: 'Here it is.' },
    ]);
    // MEASURED 2026-09-13 rapid-mlx: thinking | text "\n\n" | toolCall.
    expect(settleReply([thought, { type: 'text', text: '\n\n' }, call], 'toolUse')).toEqual([
      thought,
      call,
    ]);
  });

  it('keeps a plain answer as it is', () => {
    const text = { type: 'text' as const, text: '\n\nLeading newlines with no thought stay.' };
    expect(settleReply([text])).toEqual([text]);
  });

  it('cuts an unfinished written tool call the engine flushed as content, keeping the prose before it', () => {
    // rapid-mlx, stopping a looping call with finish_reason=length, hands the
    // buffered `<tool_call>` fragment over as content — the user saw it in the bubble.
    const leaked = `Let me check.\n\n<tool_call>\n{"name": "bash", "arguments": {"command"${' '.repeat(40)}`;
    expect(settleReply([{ type: 'text', text: leaked }], 'length')).toEqual([
      { type: 'text', text: 'Let me check.' },
    ]);
    expect(settleReply([{ type: 'text', text: '<tool_call>\n{"name": "bash"' }], 'length')).toEqual(
      [],
    );
    // A complete written call is rung 0's business, not a leak: left alone here.
    const whole = {
      type: 'text' as const,
      text: '<tool_call>{"name":"bash","arguments":{}}</tool_call>',
    };
    expect(settleReply([whole])).toEqual([whole]);
  });

  it('a reply the model ended with nothing but a thought IS the reply', () => {
    // MEASURED 2026-09-13: Qwen3.5-4B wrote the whole answer inside the
    // <think> the template opened, never closed it, and stopped — 258 tokens
    // the thread showed as an empty turn.
    const answer = "\nHere's what it reports about this Mac:\n\n- **CPU**: Apple M5 Pro\n";
    expect(settleReply([{ type: 'thinking', thinking: answer }], 'stop')).toEqual([
      { type: 'text', text: answer.trim() },
    ]);
    // With the "\n\n" the engine left as content, the same.
    expect(
      settleReply(
        [
          { type: 'thinking', thinking: answer },
          { type: 'text', text: '\n\n' },
        ],
        'stop',
      ),
    ).toEqual([{ type: 'text', text: answer.trim() }]);
  });

  it('a thought the engine cut off stays a thought, and a thought before a call or an answer stays too', () => {
    const cut = [{ type: 'thinking' as const, thinking: 'Still working out the' }];
    expect(settleReply(cut, 'length')).toEqual(cut);
    expect(settleReply([thought, call], 'toolUse')).toEqual([thought, call]);
    expect(settleReply([thought, { type: 'text', text: 'Done.' }])).toEqual([
      thought,
      { type: 'text', text: 'Done.' },
    ]);
    expect(settleReply([{ type: 'thinking', thinking: '  ' }], 'stop')).toEqual([
      { type: 'thinking', thinking: '  ' },
    ]);
  });
});

describe('settleNote — what settling took, said out loud', () => {
  it('names a reply that settled to nothing though tokens came out (MEASURED: Gemma 4 12B, 548 tokens)', () => {
    const before: ReplyBlock[] = [
      { type: 'text', text: '<tool_call>{"name": "bash", "arguments": {"command": "media gen' },
    ];
    const after = settleReply(before, 'stop');
    expect(after).toEqual([]);
    expect(settleNote(before, after, 548, 'stop')).toBe(
      `548 tokens out and an empty reply (finish stop) — cut: ${JSON.stringify(before[0]?.type === 'text' ? before[0].text : '')}`,
    );
  });

  it('names text cut at an unfinished written call, with what was cut', () => {
    const before: ReplyBlock[] = [
      { type: 'text', text: 'Here is the picture.\n<tool_call>{"name": "bash", "argum' },
    ];
    const after = settleReply(before, 'stop');
    const note = settleNote(before, after, 40, 'stop');
    expect(note).toMatch(/^cut \d+ chars from the reply \(finish stop\) — cut: "<tool_call>/);
  });

  it('says nothing when settling only trimmed whitespace or took nothing', () => {
    const plain: ReplyBlock[] = [{ type: 'text', text: 'All done.' }];
    expect(settleNote(plain, settleReply(plain, 'stop'), 3, 'stop')).toBeNull();
    const spaced: ReplyBlock[] = [
      { type: 'thinking', thinking: 'ok' },
      { type: 'text', text: '\n\nAll done.' },
    ];
    expect(settleNote(spaced, settleReply(spaced, 'stop'), 5, 'stop')).toBeNull();
  });
});
