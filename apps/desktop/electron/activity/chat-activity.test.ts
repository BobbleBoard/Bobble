import { describe, expect, it, vi } from 'vitest';
import { createChatActivity } from './chat-activity';

describe('chat activity (the W0 skeleton)', () => {
  it('is busy while any source is, and idle again when the last one ends', () => {
    let t = 1000;
    const act = createChatActivity(() => t);
    expect(act.busy()).toBe(false);
    const endChat = act.begin('chat', 'a.jsonl');
    const endGen = act.begin('gen', 'job-1');
    expect(act.busy()).toBe(true);
    expect(act.snapshot().active.map((m) => m.kind)).toEqual(['chat', 'gen']);
    t = 2000;
    endChat();
    expect(act.busy()).toBe(true);
    t = 3000;
    endGen();
    expect(act.snapshot()).toEqual({ busy: false, active: [], idleSince: 3000 });
  });

  it('tells listeners about transitions, not about every begin and end', () => {
    const act = createChatActivity(() => 0);
    const seen: boolean[] = [];
    act.onChange((s) => seen.push(s.busy));
    const a = act.begin('chat', 'a');
    const b = act.begin('subagent', 'b');
    a();
    b();
    expect(seen).toEqual([true, false]);
  });

  it('an end is idempotent', () => {
    const act = createChatActivity(() => 0);
    const listener = vi.fn();
    act.onChange(listener);
    const end = act.begin('chat', 'a');
    end();
    end();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('measures quiet from the moment it went idle', () => {
    let t = 0;
    const act = createChatActivity(() => t);
    const end = act.begin('chat', 'a');
    t = 10_000;
    expect(act.quietFor(0)).toBe(false); // busy is never quiet
    end();
    t = 12_000;
    expect(act.quietFor(2_000)).toBe(true);
    expect(act.quietFor(2_001)).toBe(false);
  });

  it('delivers a preempt synchronously to every listener, even past one that throws', () => {
    const act = createChatActivity();
    const got: string[] = [];
    act.onPreempt(() => {
      throw new Error('listener bug');
    });
    const off = act.onPreempt((r) => got.push(r));
    act.preempt('user-prompt');
    expect(got).toEqual(['user-prompt']);
    off();
    act.preempt('prefill');
    expect(got).toEqual(['user-prompt']);
  });
});
