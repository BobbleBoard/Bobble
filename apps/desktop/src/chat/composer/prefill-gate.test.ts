import { describe, expect, it } from 'vitest';
import { type PrefillInputs, prefillDecision } from './prefill-gate';

const base: PrefillInputs = {
  system: 'You are a helpful assistant.',
  toolsJson: JSON.stringify([{ name: 'bash' }, { name: 'read' }]),
  serverRunning: true,
  busy: false,
  prefixChars: 0,
  historyTurns: 3,
  focusEpoch: 0,
  minPrefixChars: 400,
};

describe('prefillDecision', () => {
  it('primes a conversation with something in it', () => {
    const d = prefillDecision(base);
    expect(d.prime).toBe(true);
    if (d.prime) expect(d.tools.map((t) => t.name)).toEqual(['bash', 'read']);
  });

  it('waits for the server', () => {
    expect(prefillDecision({ ...base, serverRunning: false })).toMatchObject({ prime: false });
  });

  it('never contends with a turn that is using the slot', () => {
    expect(prefillDecision({ ...base, busy: true })).toMatchObject({ prime: false });
  });

  it('waits for the system prompt', () => {
    expect(prefillDecision({ ...base, system: '' })).toMatchObject({ prime: false });
    expect(prefillDecision({ ...base, system: undefined })).toMatchObject({ prime: false });
  });

  /*
   * THE ONE THAT COST 7.4 SECONDS. Chat templates render tools at the START, so
   * priming without them writes a prompt the turn does not begin with — and the
   * slot holds ONE sequence, so the good prefix is gone. Measured: reused 20 of
   * 9750 tokens on a chat that had been fully resident.
   */
  it('refuses to prime when the turn tools are not known', () => {
    for (const toolsJson of [undefined, '', '[]', 'not json', '{}']) {
      const d = prefillDecision({ ...base, toolsJson });
      expect(d.prime, `toolsJson=${String(toolsJson)}`).toBe(false);
      if (!d.prime) expect(d.because).toMatch(/tools|system/);
    }
  });

  /*
   * MEASURED, twice. An empty chat's prefix is [tools][system], which the
   * harness's own warm-up already made resident through the same request shape a
   * turn uses. Priming it again from here — over the raw path, with a second
   * rendering — replaced a good prefix with one that diverged 41 tokens in, and
   * turned a 200ms send into 7.5 seconds.
   */
  it('never primes an empty chat, however many times the window has come back', () => {
    const empty = { ...base, historyTurns: 0 };
    expect(prefillDecision(empty)).toMatchObject({ prime: false });
    expect(prefillDecision({ ...empty, focusEpoch: 1 })).toMatchObject({ prime: false });
    expect(prefillDecision({ ...empty, focusEpoch: 12 })).toMatchObject({ prime: false });
  });

  /* ...but a conversation with something in it does, on a return: that is where
   * the raw path earns its keep and where it measurably reuses. */
  it('re-primes a conversation with history', () => {
    expect(prefillDecision({ ...base, focusEpoch: 3 })).toMatchObject({ prime: true });
  });

  it('primes for a big attachment even with no history', () => {
    const empty = { ...base, historyTurns: 0 };
    expect(prefillDecision({ ...empty, prefixChars: 399 })).toMatchObject({ prime: false });
    expect(prefillDecision({ ...empty, prefixChars: 400 })).toMatchObject({ prime: true });
  });

  it('says why, every time it says no', () => {
    const d = prefillDecision({ ...base, serverRunning: false });
    if (!d.prime) expect(d.because.length).toBeGreaterThan(0);
  });
});
