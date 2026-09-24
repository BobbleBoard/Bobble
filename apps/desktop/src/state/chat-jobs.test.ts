import { describe, expect, it } from 'vitest';
import { ownerOfJob } from './chat-jobs';

describe('ownerOfJob — which chat a generation belongs to', () => {
  const idle = { bgRun: null, viewed: '/s/viewed.jsonl' };

  it("a subagent's job belongs to the chat that owns the subagent", () => {
    expect(ownerOfJob({ ...idle, agent: 'kid-1', childParent: '/s/parent.jsonl' })).toBe(
      '/s/parent.jsonl',
    );
    // An unknown child names no chat — never the one on screen by accident.
    expect(ownerOfJob({ ...idle, agent: 'kid-9', childParent: undefined })).toBeNull();
  });

  it("the chat's own pi works for the chat running in the background, when there is one", () => {
    expect(
      ownerOfJob({
        agent: undefined,
        childParent: undefined,
        bgRun: { sessionFile: '/s/bg.jsonl', streaming: true },
        viewed: '/s/viewed.jsonl',
      }),
    ).toBe('/s/bg.jsonl');
  });

  it('…and otherwise for the chat on screen', () => {
    expect(ownerOfJob({ ...idle, agent: undefined, childParent: undefined })).toBe(
      '/s/viewed.jsonl',
    );
    expect(
      ownerOfJob({
        agent: 'main',
        childParent: undefined,
        bgRun: { sessionFile: '/s/bg.jsonl', streaming: false },
        viewed: '/s/viewed.jsonl',
      }),
    ).toBe('/s/viewed.jsonl');
  });
});
