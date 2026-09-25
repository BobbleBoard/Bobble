import { describe, expect, it } from 'vitest';
import type { DiagramLiveReply, DiagramLiveRequest } from './diagram-contract';
import { checkLiveRequest, createLiveQueue } from './diagram-live-queue';

const req = (id: string, source: string): DiagramLiveRequest => ({ id, source, mode: 'light' });

describe('checkLiveRequest — a frame request as it crosses IPC', () => {
  it('keeps what a frame needs and what is optional, typed', () => {
    expect(
      checkLiveRequest({
        id: 'call_1',
        source: 'flowchart TD\n  A --> B',
        mode: 'dark',
        title: 'T',
        kit: 'fog',
        look: 'sketch',
        root: '/w',
        partial: true,
        extra: 'dropped',
      }),
    ).toEqual({
      id: 'call_1',
      source: 'flowchart TD\n  A --> B',
      mode: 'dark',
      title: 'T',
      kit: 'fog',
      look: 'sketch',
      root: '/w',
      partial: true,
    });
  });

  it('refuses one with no id, no source, a mode it does not know, or a source past the limit', () => {
    expect(checkLiveRequest(null)).toBeNull();
    expect(checkLiveRequest({ source: 'x', mode: 'light' })).toBeNull();
    expect(checkLiveRequest({ id: 'a', mode: 'light' })).toBeNull();
    expect(checkLiveRequest({ id: 'a', source: 'x', mode: 'sepia' })).toBeNull();
    expect(checkLiveRequest({ id: 'a', source: 'x'.repeat(60_001), mode: 'light' })).toBeNull();
    // An odd optional is dropped, not the frame.
    expect(
      checkLiveRequest({ id: 'a', source: 'x', mode: 'light', look: 'neon', title: 7 }),
    ).toEqual({
      id: 'a',
      source: 'x',
      mode: 'light',
    });
  });
});

describe('createLiveQueue — one frame at a time, the newest per call', () => {
  /** A drawer whose first frame is held until `release` — the others draw at once. */
  function drawer() {
    const drawn: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const draw = async (r: DiagramLiveRequest): Promise<DiagramLiveReply> => {
      drawn.push(`${r.id}:${r.source}`);
      if (drawn.length === 1) await gate;
      return {
        ok: true,
        svg: r.source,
        width: 1,
        height: 1,
        kind: 'flowchart',
        kit: 'paper-teal',
        paper: '#FFFFFF',
        source: r.source,
      };
    };
    return { drawn, draw, release: () => release() };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('answers a frame overtaken while it waited without drawing it', async () => {
    const { drawn, draw, release } = drawer();
    const live = createLiveQueue(draw);
    const first = live(req('c1', 'one line'));
    await tick(); // the first is being drawn
    const second = live(req('c1', 'two lines'));
    const third = live(req('c1', 'three lines'));
    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, superseded: true });
    expect(c).toMatchObject({ ok: true, source: 'three lines' });
    expect(drawn).toEqual(['c1:one line', 'c1:three lines']);
  });

  it('draws only the newest of frames asked for together', async () => {
    const { drawn, draw, release } = drawer();
    release();
    const live = createLiveQueue(draw);
    const replies = await Promise.all([live(req('c1', '1')), live(req('c1', '2'))]);
    expect(replies.map((r) => r.ok)).toEqual([false, true]);
    expect(drawn).toEqual(['c1:2']);
  });

  it('keeps each call’s newest frame: two diagrams streaming at once both draw', async () => {
    const { drawn, draw, release } = drawer();
    const live = createLiveQueue(draw);
    const a1 = live(req('a', '1'));
    await tick();
    const b1 = live(req('b', '1'));
    const a2 = live(req('a', '2'));
    release();
    await Promise.all([a1, b1, a2]);
    expect(drawn).toEqual(['a:1', 'b:1', 'a:2']);
  });

  it('a frame whose drawing throws does not stop the next', async () => {
    let n = 0;
    const live = createLiveQueue(async (r) => {
      n += 1;
      if (n === 1) throw new Error('window gone');
      return { ok: false, error: 'nothing yet', line: null, ...(r.id === 'x' ? {} : {}) };
    });
    await expect(live(req('x', 'a'))).rejects.toThrow('window gone');
    await expect(live(req('x', 'b'))).resolves.toMatchObject({ ok: false, error: 'nothing yet' });
  });
});
