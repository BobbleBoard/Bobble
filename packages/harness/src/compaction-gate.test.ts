import { describe, expect, it } from 'vitest';
import {
  compactionReserve,
  compactionVerdict,
  MANUAL_COMPACTION_FOCUS,
  registerCompactionGate,
} from './compaction-gate.js';

describe('the compaction gate', () => {
  const W = 32768;

  it('holds the compaction pi fires at half a local window (MEASURED: 23k of 32k, 35 s, nothing freed)', () => {
    expect(compactionReserve(W)).toBe(4096);
    expect(
      compactionVerdict({ window: W, tokensBefore: 23188, frees: 214, manual: false }),
    ).toEqual({
      run: false,
      why: '23188 of 32768 tokens used — it runs above 28672',
    });
  });

  it('runs near the end of the window when the plan frees a real share', () => {
    expect(
      compactionVerdict({ window: W, tokensBefore: 29500, frees: 9000, manual: false }),
    ).toEqual({
      run: true,
    });
    expect(
      compactionVerdict({ window: W, tokensBefore: 29500, frees: 800, manual: false }),
    ).toEqual({
      run: false,
      why: 'it would free 800 tokens (under 3277)',
    });
  });

  it('always runs past the window (overflow recovery), for a person who asked, and with no window known', () => {
    expect(compactionVerdict({ window: W, tokensBefore: 34000, frees: 0, manual: false }).run).toBe(
      true,
    );
    expect(compactionVerdict({ window: W, tokensBefore: 9000, frees: 500, manual: true }).run).toBe(
      true,
    );
    expect(compactionVerdict({ window: 0, tokensBefore: 9000, frees: 0, manual: false }).run).toBe(
      true,
    );
  });

  it('cancels pi’s plan before any model is called, and says why in the log', async () => {
    type Handler = (e: unknown, ctx: unknown) => unknown;
    const handlers = new Map<string, Handler>();
    const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as never;
    const lines: string[] = [];
    registerCompactionGate(pi, (l) => lines.push(l));
    const gate = handlers.get('session_before_compact');
    const msg = (text: string) => ({
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 0,
    });
    const event = (tokensBefore: number, customInstructions?: string) => ({
      type: 'session_before_compact',
      preparation: {
        firstKeptEntryId: 'e2',
        messagesToSummarize: [msg('This is from my A-level physics practice paper.')],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore,
        fileOps: {},
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: [],
      customInstructions,
      signal: new AbortController().signal,
    });
    const ctx = { model: { contextWindow: W } };
    expect(await gate?.(event(23188), ctx)).toEqual({ cancel: true });
    expect(lines).toEqual([
      '[harness] compaction held: 23188 of 32768 tokens used — it runs above 28672',
    ]);
    expect(await gate?.(event(23188, MANUAL_COMPACTION_FOCUS), ctx)).toBeUndefined();
    expect(await gate?.(event(40000), ctx)).toBeUndefined();
  });
});
