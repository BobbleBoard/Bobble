import { describe, expect, it } from 'vitest';
import { loopAbortNudge, silentEnd, silentEndNudge } from './silent-end.js';

const user = { role: 'user', content: 'Explain SHM with an animation.' };
const failed = {
  role: 'toolResult',
  toolName: 'bash',
  isError: true,
  content: [
    {
      type: 'text',
      text: 'math: the spec needs a "plot" (curves as expressions) or a "figure" (shapes), or both.\n…',
    },
  ],
};
const thought = {
  role: 'assistant',
  stopReason: 'stop',
  content: [{ type: 'thinking', thinking: 'Hmm.' }],
};

describe('a turn that ends without a word', () => {
  it('is caught, with the command that failed (MEASURED: SHM, "1 command failed, thought for 23s", nothing else)', () => {
    const end = silentEnd([user, { role: 'assistant', content: [] }, failed, thought]);
    expect(end).toEqual({
      failed:
        'bash failed: math: the spec needs a "plot" (curves as expressions) or a "figure" (shapes), or both.',
      ran: true,
    });
    expect(silentEndNudge(end ?? { failed: '', ran: true })).toMatch(
      /^Your turn ended without a word to the user, after bash failed: math: the spec needs/,
    );
  });

  it('is left alone when it said something, was stopped, or had nothing to answer for', () => {
    const said = {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Here it is.' }],
    };
    expect(silentEnd([user, failed, said])).toBeNull();
    expect(silentEnd([user, failed, { ...thought, stopReason: 'aborted' }])).toBeNull();
    expect(silentEnd([thought])).toBeNull();
  });

  it('with no failure, says only that nothing was said', () => {
    const ok = { role: 'toolResult', toolName: 'write', isError: false, content: 'Wrote it.' };
    expect(silentEnd([user, ok, thought])).toEqual({ failed: '', ran: true });
    expect(silentEndNudge({ failed: '', ran: true })).toMatch(
      /^Your turn ended without a word to the user\. /,
    );
  });

  it('is caught when nothing ran at all (MEASURED: Gemma 4 12B, 548 tokens out, an empty reply)', () => {
    const question = {
      role: 'user',
      content: [{ type: 'text', text: 'why is the width only half the circumference?' }],
    };
    const empty = { role: 'assistant', stopReason: 'stop', content: [] };
    const end = silentEnd([question, empty]);
    expect(end).toEqual({ failed: '', ran: false });
    expect(silentEndNudge(end ?? { failed: '', ran: false })).toMatch(
      /empty reply to what they just asked\. Answer them now\.$/,
    );
  });

  it("is left alone when the turn answered the harness's own private steer", () => {
    const steer = 'A check failed after your last change: … fix it silently.';
    const turn = [{ role: 'user', content: steer }, thought];
    expect(silentEnd(turn, (t) => t === steer)).toBeNull();
    expect(silentEnd(turn)).toEqual({ failed: '', ran: false });
  });
});

describe('after the loop guard stops a turn', () => {
  it('names why, and asks for the answer in words (MEASURED: Ling 3.0 Tiny, 53 reads, "Done" over nothing)', () => {
    const nudge = loopAbortNudge('stuck cycling between 3 tool calls for minutes without progress');
    expect(nudge).toMatch(/^You were stopped: stuck cycling between 3 tool calls/);
    expect(nudge).toContain('Do not run another tool for this. Answer what the user asked now');
  });
});
