import { describe, expect, it } from 'vitest';
import { silentEnd, silentEndNudge } from './silent-end.js';

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
    });
    expect(silentEndNudge(end ?? { failed: '' })).toMatch(
      /^Your turn ended without a word to the user, after bash failed: math: the spec needs/,
    );
  });

  it('is left alone when it said something, was stopped, or ran nothing', () => {
    const said = {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Here it is.' }],
    };
    expect(silentEnd([user, failed, said])).toBeNull();
    expect(silentEnd([user, failed, { ...thought, stopReason: 'aborted' }])).toBeNull();
    expect(silentEnd([user, thought])).toBeNull();
  });

  it('with no failure, says only that nothing was said', () => {
    const ok = { role: 'toolResult', toolName: 'write', isError: false, content: 'Wrote it.' };
    expect(silentEnd([user, ok, thought])).toEqual({ failed: '' });
    expect(silentEndNudge({ failed: '' })).toMatch(
      /^Your turn ended without a word to the user\. /,
    );
  });
});
