import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  buildCanvasContext,
  CANVAS_BLOCK_ENTRY,
  CANVAS_STATE_OPEN,
  CanvasBlockLedger,
  type CanvasContextMessage,
  type CanvasStateSource,
  formatCanvasSummary,
  isCanvasStateMessage,
  registerCanvasContext,
  withCanvasBlock,
} from './canvas-context.js';
import type { CanvasState } from './protocol.js';

let clock = 1000;
const userMsg = (text: string, at?: number): CanvasContextMessage =>
  ({ role: 'user', content: text, timestamp: at ?? clock++ }) as CanvasContextMessage;
const asstMsg = (text: string): CanvasContextMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 0 }) as CanvasContextMessage;

/** A source that returns a fixed state (or throws, to exercise the catch). */
function source(state: CanvasState | null, opts: { throws?: boolean } = {}): CanvasStateSource {
  return {
    getCanvasState: async () => {
      if (opts.throws === true) throw new Error('bridge down');
      return state;
    },
  };
}

const BROWSER: CanvasState = {
  active: {
    kind: 'browser',
    tabId: 't1',
    title: 'Sandboxels',
    url: 'https://neal.fun/sandboxels/',
  },
  others: [
    { kind: 'file', filePath: 'src/App.tsx', dirty: true },
    { kind: 'terminal', cwd: '~/proj', lastCommand: 'npm test' },
  ],
};

describe('formatCanvasSummary', () => {
  it('renders the active surface + the others, wrapped in the sentinel', () => {
    const block = formatCanvasSummary(BROWSER);
    expect(block).not.toBeNull();
    expect(block).toContain(CANVAS_STATE_OPEN);
    expect(block).toContain('</canvas_state>');
    expect(block).toContain(
      'The user is looking at: Browser — "Sandboxels" (https://neal.fun/sandboxels/)',
    );
    expect(block).toContain('Also open:');
    expect(block).toContain('File src/App.tsx (unsaved)');
    expect(block).toContain(
      'Terminal — YOUR OWN command output, not something to act on (cwd ~/proj, last: `npm test`)',
    );
  });

  it('includes a capped excerpt when the active file has one', () => {
    const block = formatCanvasSummary({
      active: { kind: 'file', filePath: 'a.txt', excerpt: 'x'.repeat(1000) },
      others: [],
    });
    expect(block).toContain('Excerpt:');
    expect(block).toContain('…'); // clipped
    expect((block ?? '').length).toBeLessThan(500);
  });

  it('returns null for an empty canvas (nothing to inject)', () => {
    expect(formatCanvasSummary({ active: null, others: [] })).toBeNull();
  });

  it('says a file the agent itself just wrote is its own, and does not quote it back', () => {
    // SEEN: "The user is looking at: File illustration1.md" + an excerpt of
    // the model's own text → "I see you're viewing the illustration
    // descriptions I created", five turns running.
    const block = formatCanvasSummary({
      active: {
        kind: 'file',
        filePath: 'illustration1.md',
        own: true,
        excerpt: 'Illustration 1 - Title Slide',
      },
      others: [],
    });
    expect(block).toContain('On screen: File illustration1.md — YOUR OWN write as it landed');
    expect(block).not.toContain('The user is looking at');
    expect(block).not.toContain('Excerpt:');
  });
});

describe('withCanvasBlock / dedupe', () => {
  it('appends the block as the LAST message', () => {
    const msgs = [userMsg('hello'), asstMsg('hi there')];
    const out = withCanvasBlock(msgs, `${CANVAS_STATE_OPEN}\nx\n</canvas_state>`);
    expect(out).toHaveLength(3);
    const last = out.at(-1);
    expect(last !== undefined && isCanvasStateMessage(last)).toBe(true);
    // The original messages are untouched (non-destructive).
    expect(out.slice(0, 2)).toEqual(msgs);
  });

  it('strips a prior block before appending (never accumulates)', () => {
    const first = withCanvasBlock([userMsg('hello')], `${CANVAS_STATE_OPEN}\nA\n</canvas_state>`);
    const second = withCanvasBlock(first, `${CANVAS_STATE_OPEN}\nB\n</canvas_state>`);
    const blocks = second.filter(isCanvasStateMessage);
    expect(blocks).toHaveLength(1); // exactly one, the fresh one
    expect(JSON.stringify(blocks[0])).toContain('B');
    expect(JSON.stringify(blocks[0])).not.toContain('A');
    // Still pinned to the tail.
    const tail = second.at(-1);
    expect(tail !== undefined && isCanvasStateMessage(tail)).toBe(true);
  });

  it('only treats user-role blocks as injected (not assistant text)', () => {
    expect(isCanvasStateMessage(asstMsg(CANVAS_STATE_OPEN))).toBe(false);
    expect(isCanvasStateMessage(userMsg(`${CANVAS_STATE_OPEN} ...`))).toBe(true);
  });
});

describe('buildCanvasContext', () => {
  it('appends a fresh block when the canvas has content', async () => {
    const res = await buildCanvasContext(source(BROWSER), [userMsg('go')]);
    expect(res).toBeDefined();
    const blocks = res?.messages.filter(isCanvasStateMessage) ?? [];
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks[0])).toContain('Sandboxels');
  });

  it('dedupes across calls (feeding its own output re-yields one block)', async () => {
    const ledger = new CanvasBlockLedger();
    const first =
      (await buildCanvasContext(source(BROWSER), [userMsg('go')], ledger))?.messages ?? [];
    const second = (await buildCanvasContext(source(BROWSER), first, ledger))?.messages ?? [];
    expect(second.filter(isCanvasStateMessage)).toHaveLength(1);
  });

  it('returns undefined (no change) when there is nothing and no prior block', async () => {
    const res = await buildCanvasContext(source({ active: null, others: [] }), [userMsg('go')]);
    expect(res).toBeUndefined();
  });

  it('never throws — a bridge failure yields no change', async () => {
    const res = await buildCanvasContext(source(null, { throws: true }), [userMsg('go')]);
    expect(res).toBeUndefined();
  });

  /*
   * THE PREFIX-CACHE PROPERTY. MEASURED 2026-09-13 (prompt-diff on llama.cpp
   * and rapid-mlx): with the block stripped and re-read before every call, the
   * previous user message changed between turns and the whole previous turn
   * was prefilled again. A turn's block is read once and stays.
   */
  it('a turn keeps the block it was given, byte for byte, on every later call', async () => {
    const ledger = new CanvasBlockLedger();
    const turn1 = [userMsg('go', 1)];
    const first = (await buildCanvasContext(source(BROWSER), turn1, ledger))?.messages ?? [];
    const block1 = first[0];
    // Mid-turn the canvas changed (the agent opened a terminal) — the turn's
    // block does not.
    const changed: CanvasState = { active: { kind: 'terminal', cwd: '~/x' }, others: [] };
    const mid = (await buildCanvasContext(source(changed), [...turn1, asstMsg('working')], ledger))
      ?.messages;
    expect(mid?.[0]).toEqual(block1);
    // Next turn: the old turn is still identical; the new turn gets the new state.
    const turn2 = [...turn1, asstMsg('done'), userMsg('and now?', 2)];
    const next = (await buildCanvasContext(source(changed), turn2, ledger))?.messages ?? [];
    expect(next[0]).toEqual(block1);
    expect(JSON.stringify(next[2])).toContain('Terminal');
    expect(next.filter(isCanvasStateMessage)).toHaveLength(2);
  });

  it('a turn that saw an empty canvas never grows a block later', async () => {
    const ledger = new CanvasBlockLedger();
    const turn = [userMsg('go', 7)];
    expect(
      await buildCanvasContext(source({ active: null, others: [] }), turn, ledger),
    ).toBeUndefined();
    // Something opened mid-turn: still nothing for this turn.
    expect(
      await buildCanvasContext(source(BROWSER), [...turn, asstMsg('hm')], ledger),
    ).toBeUndefined();
  });

  it('a stale block in the messages is replaced by the ledger, never doubled', async () => {
    const ledger = new CanvasBlockLedger();
    const withOld = withCanvasBlock(
      [userMsg('go', 9)],
      `${CANVAS_STATE_OPEN}\nold\n</canvas_state>`,
    );
    const res = await buildCanvasContext(source(BROWSER), withOld, ledger);
    const blocks = res?.messages.filter(isCanvasStateMessage) ?? [];
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks[0])).toContain('Sandboxels');
    expect(JSON.stringify(blocks[0])).not.toContain('old');
  });

  it('the ledger restores from the session and hands out what to persist', async () => {
    const ledger = new CanvasBlockLedger();
    await buildCanvasContext(source(BROWSER), [userMsg('go', 11)], ledger);
    const records = ledger.drain();
    expect(records).toHaveLength(1);
    expect(records[0]?.at).toBe(11);
    expect(ledger.drain()).toHaveLength(0);
    const reloaded = new CanvasBlockLedger();
    reloaded.restore([
      { type: 'custom', customType: CANVAS_BLOCK_ENTRY, data: records[0] },
      { type: 'custom', customType: 'other', data: { at: 12, block: 'x' } },
    ]);
    // Same turn, no canvas read (a source that throws would otherwise yield '').
    const res = await buildCanvasContext(
      source(null, { throws: true }),
      [userMsg('go', 11)],
      reloaded,
    );
    expect(JSON.stringify(res?.messages[0])).toContain('Sandboxels');
    expect(reloaded.has(12)).toBe(false);
  });
});

describe('registerCanvasContext', () => {
  it("registers a 'context' handler that injects the block", async () => {
    const handlers: Record<string, (e: { messages: CanvasContextMessage[] }) => unknown> = {};
    const pi = {
      on: (event: string, h: (e: { messages: CanvasContextMessage[] }) => unknown) => {
        handlers[event] = h;
      },
    } as unknown as ExtensionAPI;
    registerCanvasContext(pi, source(BROWSER));
    const handler = handlers.context;
    expect(handler).toBeDefined();
    const out = (await handler?.({ messages: [userMsg('go')] })) as
      | { messages: CanvasContextMessage[] }
      | undefined;
    expect(out?.messages.some(isCanvasStateMessage)).toBe(true);
  });
});

describe('the block says it is not the user talking', () => {
  it('leads with what it is, before what it says', () => {
    const out = formatCanvasSummary({
      active: { kind: 'browser', title: 'Shop iPhone', url: 'https://apple.com' },
      others: [],
    } as never);
    expect(out).not.toBeNull();
    const body = String(out);
    expect(body).toContain('NOT a message from the user');
    // And it comes FIRST — a model that stops reading at "The user is looking
    // at" is exactly the one that needs telling.
    expect(body.indexOf('Automatic status')).toBeLessThan(body.indexOf('The user is looking at'));
  });
});

/*
 * A 4B spent four turns trying to "read Terminal" because the block said the
 * user was looking at one — a terminal its own failing bash commands had just
 * opened. The surface is the agent's output; saying so costs six words.
 */
describe('the activity terminal is the agent looking at itself', () => {
  it('says whose output it is', () => {
    const out = formatCanvasSummary({
      active: { kind: 'terminal', lastCommand: 'read --help' },
      others: [],
    } as never);
    expect(String(out)).toContain('YOUR OWN command output');
  });
});
