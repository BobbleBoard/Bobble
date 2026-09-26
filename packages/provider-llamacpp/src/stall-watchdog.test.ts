import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClockAction,
  DEFAULT_STALL_POLICY,
  httpProgressProbe,
  llamaSlotsWorkCounter,
  normalizeStallPolicy,
  rapidMlxWorkCounter,
  StallClock,
  type StallPolicy,
  stallErrorMessage,
  stallPolicyFromEnv,
  watchStream,
} from './stall-watchdog.js';

const S = 1000;
/** The defaults in seconds, so the arithmetic below reads as the policy. */
const P: StallPolicy = DEFAULT_STALL_POLICY; // 90 s / 10 min / probe after 10 s, every 10 s, 5 s timeout

/**
 * Drive a clock the way the driver does: at each step, act on `check()` — send
 * a probe (answered by `answer`), or sleep until the time it asks for. Returns
 * the stall (with the time it fired) or null once `until` passes.
 */
function run(
  clock: StallClock,
  from: number,
  until: number,
  answer: (at: number) => number | null | undefined = () => undefined,
  onProbe?: (at: number) => void,
): { at: number; action: Extract<ClockAction, { type: 'stall' }> } | null {
  let t = from;
  for (let guard = 0; guard < 100_000 && t <= until; guard++) {
    const a = clock.check(t);
    if (a.type === 'stall') return { at: t, action: a };
    if (a.type === 'probe') {
      onProbe?.(t);
      clock.probeStarted(t);
      clock.probeResult(answer(t), t); // answered at once
      continue;
    }
    t += a.ms;
  }
  return null;
}

describe('StallClock — engines that cannot be asked', () => {
  it('never fires while deltas keep arriving', () => {
    const c = new StallClock(P, 0, false);
    for (let t = 0; t <= 3600 * S; t += 2 * S) {
      c.delta('content', t);
      expect(c.check(t).type).toBe('wait');
    }
  });

  it('mid-thought, fires at the short window: no engine holds reasoning back', () => {
    const c = new StallClock(P, 0, false);
    c.delta('reasoning', 1 * S);
    c.delta('reasoning', 4 * S);
    const hit = run(c, 4 * S, 3600 * S);
    expect(hit?.at).toBe(94 * S);
    expect(hit?.action.info).toEqual({
      quietMs: 90 * S,
      phase: 'thinking',
      engine: 'blind',
      deltas: 2,
    });
  });

  it('after text started, waits the LONG window — a tool call may be held back', () => {
    const c = new StallClock(P, 0, false);
    c.delta('reasoning', 1 * S);
    c.delta('content', 3 * S); // the "\n\n" after </think>
    expect(c.check(3 * S + P.stallMs).type).toBe('wait');
    expect(c.check(3 * S + 599 * S).type).toBe('wait');
    const hit = run(c, 3 * S, 3600 * S);
    expect(hit?.at).toBe(603 * S);
    expect(hit?.action.info.phase).toBe('writing');
    expect(hit?.action.info.engine).toBe('blind');
  });

  it('before the first delta (prefill, a queue) the long window applies too', () => {
    const c = new StallClock(P, 0, false);
    expect(run(c, 0, 599 * S)).toBeNull();
    expect(run(c, 0, 3600 * S)?.action.info.phase).toBe('waiting');
  });

  it('a llama.cpp prefill frame that moved is evidence', () => {
    const c = new StallClock(P, 0, false);
    for (let t = 0; t <= 900 * S; t += 30 * S) c.progress(t); // a 15-minute prefill, still moving
    expect(c.check(900 * S).type).toBe('wait');
    expect(run(c, 900 * S, 3600 * S)?.at).toBe(1500 * S);
  });
});

describe('StallClock — engines with a progress probe', () => {
  it('asks only once the stream has gone quiet, then on a cadence', () => {
    const c = new StallClock(P, 0, true);
    const probes: number[] = [];
    // Deltas every second for a minute: no probe at all.
    for (let t = 0; t <= 60 * S; t += S) {
      c.delta('reasoning', t);
      expect(c.check(t).type).toBe('wait');
    }
    run(
      c,
      60 * S,
      95 * S,
      () => 7,
      (at) => probes.push(at / S),
    );
    expect(probes).toEqual([70, 80, 90]);
  });

  it('A HELD-BACK TOOL CALL: silent stream, engine still stepping → never fires', () => {
    const c = new StallClock(P, 0, true);
    c.delta('reasoning', 1 * S);
    c.delta('content', 4 * S); // then rapid-mlx buffers the <tool_call> for minutes
    let steps = 1000;
    // ~37 tok/s, every token decoded and none of it streamed.
    const hit = run(c, 4 * S, 1800 * S, () => {
      steps += 370;
      return steps;
    });
    expect(hit).toBeNull();
  });

  it('A WEDGED ENGINE: silent stream, counter frozen → fires at the short window', () => {
    const c = new StallClock(P, 0, true);
    c.delta('reasoning', 1 * S);
    c.delta('content', 4 * S);
    const hit = run(c, 4 * S, 1800 * S, () => 5231);
    expect(hit?.at).toBe(94 * S);
    expect(hit?.action.info).toEqual({
      quietMs: 90 * S,
      phase: 'writing',
      engine: 'idle',
      deltas: 2,
    });
  });

  it('the last movement counts from when it was seen', () => {
    const c = new StallClock(P, 0, true);
    c.delta('content', 0);
    let steps = 0;
    // Moving until t=200 s, frozen after.
    const hit = run(c, 0, 3600 * S, (at) => {
      if (at <= 200 * S) steps += 10;
      return steps;
    });
    expect(hit?.at).toBe(290 * S);
  });

  it('an engine that stops answering its status endpoint is not given the long window', () => {
    const c = new StallClock(P, 0, true);
    c.delta('content', 0);
    const hit = run(c, 0, 3600 * S, () => undefined);
    expect(hit?.at).toBe(90 * S);
    expect(hit?.action.info.engine).toBe('unanswered');
  });

  it('"not supported" falls back to the rules for engines that cannot be asked', () => {
    const writing = new StallClock(P, 0, true);
    writing.delta('content', 0);
    expect(run(writing, 0, 3600 * S, () => null)?.at).toBe(600 * S);
    const thinking = new StallClock(P, 0, true);
    thinking.delta('reasoning', 0);
    expect(run(thinking, 0, 3600 * S, () => null)?.at).toBe(90 * S);
  });

  it('a counter that went backwards rebases instead of counting as work', () => {
    const c = new StallClock(P, 0, true);
    c.delta('content', 0);
    const values = [500, 500, 20, 20, 20, 20, 20, 20, 20, 20, 20];
    let i = 0;
    const hit = run(c, 0, 3600 * S, () => {
      const v = values[Math.min(i, values.length - 1)];
      i++;
      return v;
    });
    expect(hit?.at).toBe(90 * S);
  });

  it('a probe still out at the deadline is waited for, and can rescue the stream', () => {
    const c = new StallClock(P, 0, true);
    c.delta('content', 0);
    c.check(10 * S); // → probe
    c.probeStarted(10 * S);
    c.probeResult(100, 10 * S);
    for (let t = 20 * S; t <= 80 * S; t += 10 * S) {
      c.probeStarted(t);
      c.probeResult(100, t);
    }
    // One more probe goes out at 89 s and is slow to come back.
    c.probeStarted(89 * S);
    const atDeadline = c.check(90 * S);
    expect(atDeadline).toEqual({ type: 'wait', ms: P.probeTimeoutMs });
    c.probeResult(140, 92 * S); // it moved
    expect(c.check(92 * S).type).toBe('wait');
    expect(run(c, 92 * S, 3600 * S, () => 140)?.at).toBe(182 * S);
  });
});

describe('policy', () => {
  it('env: 0 turns the watchdog off; numbers override; the cadence is clamped', () => {
    expect(stallPolicyFromEnv({ PI_STREAM_STALL_MS: '0' })).toBeNull();
    expect(stallPolicyFromEnv({})).toEqual(normalizeStallPolicy(DEFAULT_STALL_POLICY));
    const p = stallPolicyFromEnv({ PI_STREAM_STALL_MS: '6000', PI_STREAM_STALL_BLIND_MS: '1000' });
    expect(p?.stallMs).toBe(6000);
    expect(p?.blindStallMs).toBe(6000); // never shorter than the ordinary window
    expect(p?.probeAfterMs).toBe(2000); // asked at least twice inside the window
    expect(p?.probeEveryMs).toBe(2000);
    expect(stallPolicyFromEnv({ PI_STREAM_STALL_MS: 'soon' })?.stallMs).toBe(P.stallMs);
  });
});

describe('work counters', () => {
  it('rapid-mlx /v1/status → steps_executed', () => {
    expect(
      rapidMlxWorkCounter({ status: 'generating', steps_executed: 5231, num_running: 1 }),
    ).toBe(5231);
    expect(rapidMlxWorkCounter({ status: 'idle' })).toBeNull();
    expect(rapidMlxWorkCounter('<html>')).toBeNull();
  });

  it('llama-server /slots → decoded + prompt-processed, either next_token shape', () => {
    expect(
      llamaSlotsWorkCounter([
        {
          id: 0,
          is_processing: true,
          next_token: { n_decoded: 40 },
          n_prompt_tokens_processed: 900,
        },
        { id: 1, is_processing: false, next_token: [{ n_decoded: 2 }] },
      ]),
    ).toBe(942);
    expect(llamaSlotsWorkCounter([{ id: 0 }])).toBeNull();
    expect(llamaSlotsWorkCounter({ error: 'no slots' })).toBeNull();
  });

  it('http probe: a missing route (any 4xx, 501) = cannot say; other 5xx = no answer; JSON = the counter', async () => {
    const reply = (status: number, body: string): typeof fetch =>
      (async () => new Response(body, { status })) as unknown as typeof fetch;
    const signal = new AbortController().signal;
    const read = rapidMlxWorkCounter;
    expect(await httpProgressProbe('u', read, reply(404, 'nope'))(signal)).toBeNull();
    expect(await httpProgressProbe('u', read, reply(501, ''))(signal)).toBeNull();
    expect(await httpProgressProbe('u', read, reply(401, 'key'))(signal)).toBeNull();
    expect(await httpProgressProbe('u', read, reply(400, 'bad'))(signal)).toBeNull();
    expect(await httpProgressProbe('u', read, reply(503, 'busy'))(signal)).toBeUndefined();
    expect(await httpProgressProbe('u', read, reply(500, 'boom'))(signal)).toBeUndefined();
    expect(await httpProgressProbe('u', read, reply(200, 'not json'))(signal)).toBeNull();
    expect(await httpProgressProbe('u', read, reply(200, '{"steps_executed":12}'))(signal)).toBe(
      12,
    );
  });
});

describe('watchStream (real driver, fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once, with what it knew, and goes quiet after', async () => {
    const onStall = vi.fn();
    const w = watchStream({ policy: P, onStall, now: () => Date.now() });
    w.delta('reasoning');
    await vi.advanceTimersByTimeAsync(89 * S);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * S);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(w.stalled?.phase).toBe('thinking');
    w.delta('content');
    await vi.advanceTimersByTimeAsync(3600 * S);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() leaves no timer behind and never fires', async () => {
    const onStall = vi.fn();
    const w = watchStream({ policy: P, onStall, probe: async () => 1 });
    await vi.advanceTimersByTimeAsync(15 * S); // a probe has gone out
    w.stop();
    await vi.advanceTimersByTimeAsync(3600 * S);
    expect(onStall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a held-back tool call keeps the stream alive through the probe', async () => {
    const onStall = vi.fn();
    let steps = 0;
    const w = watchStream({
      policy: P,
      onStall,
      probe: async () => {
        steps += 300;
        return steps;
      },
    });
    w.delta('content');
    await vi.advanceTimersByTimeAsync(1200 * S);
    expect(onStall).not.toHaveBeenCalled();
    w.stop();
  });

  it('a probe that ignores its signal and never settles cannot hold the watchdog open', async () => {
    const onStall = vi.fn();
    const w = watchStream({ policy: P, onStall, probe: () => new Promise(() => undefined) });
    w.delta('content');
    await vi.advanceTimersByTimeAsync(100 * S);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(w.stalled?.engine).toBe('unanswered');
  });

  it('a frozen counter fires at the short window', async () => {
    const onStall = vi.fn();
    const w = watchStream({ policy: P, onStall, probe: async () => 77 });
    w.delta('content');
    await vi.advanceTimersByTimeAsync(89 * S);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * S);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(w.stalled?.engine).toBe('idle');
  });
});

describe('what the turn is told', () => {
  /**
   * pi 0.68.1's auto-retry pattern (dist/core/agent-session.js
   * `_isRetryableError`). A stall that was already retried once must NOT match
   * it, or pi sends the request three more times.
   */
  const PI_RETRYABLE =
    /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|timed? out|timeout|terminated|retry delay/i;

  it('is plain, says what happened, and is never retried again by pi', () => {
    for (const engine of ['idle', 'unanswered', 'blind'] as const) {
      for (const quietMs of [6 * S, 90 * S, 119 * S, 500 * S, 503 * S, 600 * S, 25_700 * S]) {
        for (const attempts of [1, 2]) {
          const msg = stallErrorMessage({ quietMs, phase: 'writing', engine, deltas: 3 }, attempts);
          expect(msg).not.toMatch(PI_RETRYABLE);
          expect(msg).toMatch(/^The model stopped responding: no output for /);
        }
      }
    }
    expect(
      stallErrorMessage({ quietMs: 90 * S, phase: 'writing', engine: 'idle', deltas: 3 }, 2),
    ).toBe(
      'The model stopped responding: no output for 90 s, and the engine reported no work in ' +
        'progress. It was cancelled and sent again, and the new attempt stalled the same way. ' +
        'Switching models or restarting Bobble restarts the model engine.',
    );
  });
});
