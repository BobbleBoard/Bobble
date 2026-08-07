/**
 * What makes this critic worth its prefill is exactly what these pin down: it
 * never sees the claims, it cannot fix what it finds, and it stays quiet when it
 * fails. Lose any of those and it becomes another role agreeing with the build.
 */
import { describe, expect, it } from 'vitest';
import { BLIND_CRITIC_PROMPT, blindCriticEnabled, blindCriticReport } from './blind-critic';
import type { CorpModelHandle } from './role-agent';

describe('the blind critic is opt-in', () => {
  // A fresh context cannot reuse the KV prefix, so this costs a full prefill on a
  // single-slot machine. It stays off until a run shows it earns that.
  it('is off unless asked for', () => {
    expect(blindCriticEnabled({})).toBe(false);
    expect(blindCriticEnabled({ PI_BLIND_CRITIC: '0' })).toBe(false);
    expect(blindCriticEnabled({ PI_BLIND_CRITIC: '1' })).toBe(true);
    expect(blindCriticEnabled({ PI_BLIND_CRITIC: 'true' })).toBe(true);
  });
});

describe('what the critic is told', () => {
  it('is told to judge the bar, not the improvement', () => {
    // The second of the two failure modes: after a couple of bump cycles the
    // question quietly becomes "better than last time?", which a broken thing
    // passes.
    expect(BLIND_CRITIC_PROMPT).toMatch(/Judge the BAR, not the effort/);
    expect(BLIND_CRITIC_PROMPT).toMatch(/never seen this work before/i);
  });

  it('is told to run the thing, not review the file names', () => {
    expect(BLIND_CRITIC_PROMPT).toMatch(/RUN it/);
    expect(BLIND_CRITIC_PROMPT).toMatch(/without running the thing is worth nothing/);
  });

  it('is told it cannot change anything', () => {
    // A critic who fixes what they find has stopped being able to see it.
    expect(BLIND_CRITIC_PROMPT).toMatch(/CANNOT change anything/);
  });

  it('names no task type — it must hold for every benchmark', () => {
    /*
     * the user's rule for this cycle: a fix must hold across all tasks, never be
     * shaped to the one in front of it. A critic prompt naming CSVs (the
     * benchmark it was built during) would be precisely that mistake.
     */
    for (const leak of [/csv/i, /godot/i, /slide/i, /\bscene\b/i, /spreadsheet/i, /tkinter/i]) {
      expect(BLIND_CRITIC_PROMPT).not.toMatch(leak);
    }
  });
});

describe('the critic never blocks a handback', () => {
  const handle = {} as CorpModelHandle;

  it('says nothing when there is no task to judge against', async () => {
    // No bar means no audit. Inventing one would be worse than silence.
    expect(await blindCriticReport({ handle, cwd: '/tmp', task: '   ' })).toBe('');
  });

  it('says nothing when it cannot run at all', async () => {
    /*
     * Same discipline as testSuiteReport and orphanReport: a check that fails
     * returns '' rather than injecting an excuse into the handback. The
     * deterministic critics still stand on their own, and a missing opinion is
     * far cheaper than a fabricated one. `handle` here is deliberately junk, so
     * openRoleSession throws.
     */
    const out = await blindCriticReport({ handle, cwd: '/nonexistent-xyz', task: 'build a thing' });
    expect(out).toBe('');
  });
});
