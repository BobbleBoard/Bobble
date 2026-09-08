import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MacMonitorFramePayload, MacMonitorState } from './mac-monitor-contract';
import { MacMonitorCore, type MonitorSink, type StreamChild } from './monitor-core';
import type { MacOverlayState } from './overlay-geometry';
import { encodePimf, type PimfHeader } from './pimf';

// ── fakes ───────────────────────────────────────────────────────────────────

class FakeChild implements StreamChild {
  readonly pid = 4242;
  killed = false;
  #data: ((chunk: Buffer) => void) | null = null;
  #close: ((code: number | null) => void) | null = null;
  #error: ((err: Error) => void) | null = null;
  readonly stdout = {
    on: (_e: 'data', cb: (chunk: Buffer) => void): void => {
      this.#data = cb;
    },
  };
  readonly stderr = {
    on: (): void => {},
  };
  on(event: 'error' | 'close', cb: (arg: never) => void): void {
    if (event === 'close') this.#close = cb as unknown as (code: number | null) => void;
    else this.#error = cb as unknown as (err: Error) => void;
  }
  kill(): void {
    this.killed = true;
  }
  emit(chunk: Buffer): void {
    this.#data?.(chunk);
  }
  exit(code: number | null): void {
    this.#close?.(code);
  }
  fail(message: string): void {
    this.#error?.(new Error(message));
  }
}

class FakeSink implements MonitorSink {
  states: MacMonitorState[] = [];
  frameList: MacMonitorFramePayload[] = [];
  gone = false;
  constructor(public frames = true) {}
  sendState(state: MacMonitorState): void {
    this.states.push(state);
  }
  sendFrame(frame: MacMonitorFramePayload): void {
    this.frameList.push(frame);
  }
  isGone(): boolean {
    return this.gone;
  }
  get last(): MacMonitorState | undefined {
    return this.states[this.states.length - 1];
  }
}

function overlay(patch: Partial<MacOverlayState> = {}): MacOverlayState {
  return {
    engaged: true,
    pid: 4242,
    rect: { x: 100, y: 100, w: 800, h: 600 },
    cursor: { x: 420, y: 380 },
    cursorState: 'thinking',
    statusText: '',
    bubbleVisible: true,
    wantsVisible: true,
    ...patch,
  };
}

function header(patch: Partial<PimfHeader> = {}): PimfHeader {
  return {
    seq: 1,
    t: 1000,
    w: 1600,
    h: 1200,
    scale: 2,
    rect: { x: 100, y: 100, w: 800, h: 600 },
    display: { w: 1512, h: 982 },
    windows: [{ windowId: 1, title: 'Untitled', frame: { x: 100, y: 100, w: 800, h: 600 } }],
    ...patch,
  };
}

interface Harness {
  core: MacMonitorCore;
  spawned: FakeChild[];
  timers: Array<() => void>;
  runTimers: () => void;
  now: { value: number };
}

function makeCore(opts: { spawnThrows?: boolean } = {}): Harness {
  const spawned: FakeChild[] = [];
  const timers: Array<() => void> = [];
  const now = { value: 10_000 };
  const core = new MacMonitorCore({
    spawn: () => {
      if (opts.spawnThrows === true) throw new Error('ENOENT pi-mac');
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  core.setClock(() => now.value);
  return {
    core,
    spawned,
    timers,
    now,
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
    },
  };
}

describe('MacMonitorCore — the two capture gates', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeCore();
  });

  it('does not capture with a session but nobody watching', () => {
    h.core.setSession(4242, 'TextEdit');
    expect(h.spawned).toHaveLength(0);
    expect(h.core.streaming()).toBe(false);
  });

  it('does not capture with a watcher but no session', () => {
    h.core.addSink(new FakeSink(true));
    expect(h.spawned).toHaveLength(0);
  });

  it('captures once BOTH are true, in either order', () => {
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(new FakeSink(true));
    expect(h.spawned).toHaveLength(1);

    const other = makeCore();
    other.core.addSink(new FakeSink(true));
    other.core.setSession(7, 'Notes');
    expect(other.spawned).toHaveLength(1);
  });

  it('does NOT capture for a state-only watcher (the tab router)', () => {
    h.core.setSession(4242, 'TextEdit');
    const watcher = new FakeSink(false);
    h.core.addSink(watcher);
    expect(h.spawned).toHaveLength(0);
    // …but it is still told about the session.
    expect(watcher.last?.active).toBe(true);
    expect(watcher.last?.appName).toBe('TextEdit');
  });

  it('starts capturing when a state-only watcher asks for frames', () => {
    h.core.setSession(4242, 'TextEdit');
    const sink = new FakeSink(false);
    h.core.addSink(sink);
    expect(h.spawned).toHaveLength(0);
    sink.frames = true;
    h.core.reconcile();
    expect(h.spawned).toHaveLength(1);
  });

  it('kills the child when the last frame watcher goes away', () => {
    h.core.setSession(4242, 'TextEdit');
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.removeSink(sink);
    expect(h.spawned[0]?.killed).toBe(true);
    expect(h.core.streaming()).toBe(false);
  });

  it('kills the child when the session ends', () => {
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(new FakeSink(true));
    h.core.clearSession();
    expect(h.spawned[0]?.killed).toBe(true);
  });

  it('drops a destroyed renderer rather than capturing for it', () => {
    h.core.setSession(4242, 'TextEdit');
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    sink.gone = true;
    expect(h.core.wanted()).toBe(false);
  });
});

describe('MacMonitorCore — frames', () => {
  let h: Harness;
  let sink: FakeSink;
  beforeEach(() => {
    h = makeCore();
    sink = new FakeSink(true);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);
  });

  it('forwards a parsed frame and turns the stream live', () => {
    expect(sink.last?.stream).toBe('starting');
    h.spawned[0]?.emit(encodePimf(header({ seq: 5 }), new Uint8Array(24).fill(1)));
    expect(sink.frameList).toHaveLength(1);
    expect(sink.frameList[0]?.seq).toBe(5);
    expect(sink.frameList[0]?.jpeg).toHaveLength(24);
    expect(sink.frameList[0]?.rect).toEqual({ x: 100, y: 100, w: 800, h: 600 });
    expect(sink.last?.stream).toBe('live');
  });

  it('reassembles a frame split across two stdout chunks', () => {
    const bytes = encodePimf(header({ seq: 9 }), new Uint8Array(400).fill(2));
    h.spawned[0]?.emit(bytes.subarray(0, 37));
    expect(sink.frameList).toHaveLength(0);
    h.spawned[0]?.emit(bytes.subarray(37));
    expect(sink.frameList.map((f) => f.seq)).toEqual([9]);
  });

  it('reads the 0-byte "no window" frame as no-window, not a truncation', () => {
    h.spawned[0]?.emit(encodePimf(header({ seq: 3, windows: [] }), new Uint8Array(0)));
    expect(sink.frameList).toHaveLength(1);
    expect(sink.frameList[0]?.jpeg).toHaveLength(0);
    expect(sink.last?.stream).toBe('no-window');
    // A real frame afterwards brings it back to live.
    h.spawned[0]?.emit(encodePimf(header({ seq: 4 }), new Uint8Array(8)));
    expect(sink.last?.stream).toBe('live');
  });

  it('sends frames only to watchers that asked for them', () => {
    const stateOnly = new FakeSink(false);
    h.core.addSink(stateOnly);
    h.spawned[0]?.emit(encodePimf(header({ seq: 1 }), new Uint8Array(8)));
    expect(sink.frameList).toHaveLength(1);
    expect(stateOnly.frameList).toHaveLength(0);
    expect(stateOnly.states.length).toBeGreaterThan(0);
  });

  it('publishes the CAPTURED union rect, which includes a sheet', () => {
    const union = { x: 80, y: 60, w: 900, h: 700 };
    h.spawned[0]?.emit(
      encodePimf(
        header({
          seq: 2,
          rect: union,
          windows: [
            { windowId: 1, title: 'Untitled', frame: { x: 100, y: 100, w: 800, h: 600 } },
            { windowId: 2, title: 'Save', frame: { x: 80, y: 60, w: 400, h: 240 }, sheet: true },
          ],
        }),
        new Uint8Array(8),
      ),
    );
    expect(sink.last?.rect).toEqual(union);
    expect(sink.frameList[0]?.windows[1]).toMatchObject({ title: 'Save', sheet: true });
  });
});

describe('MacMonitorCore — a helper that cannot stream', () => {
  it('retries a few times then reports unavailable instead of respawning forever', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);

    // An old helper with no --stream: exits instantly, every time.
    for (let i = 0; i < 6; i++) {
      h.spawned[h.spawned.length - 1]?.exit(1);
      h.runTimers();
    }
    expect(h.spawned.length).toBeLessThanOrEqual(4);
    expect(sink.last?.stream).toBe('unavailable');
    expect(sink.last?.streamError).toContain('exited');
    // …and it stays given up, rather than restarting on the next reconcile.
    const spawnedSoFar = h.spawned.length;
    h.core.reconcile();
    expect(h.spawned).toHaveLength(spawnedSoFar);
  });

  it('a NEW session clears the give-up so the next app gets a fair try', () => {
    const h = makeCore();
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(new FakeSink(true));
    for (let i = 0; i < 6; i++) {
      h.spawned[h.spawned.length - 1]?.exit(1);
      h.runTimers();
    }
    const before = h.spawned.length;
    h.core.setSession(99, 'Notes');
    expect(h.spawned.length).toBe(before + 1);
  });

  it('does not spend the give-up budget on a child that ran healthily first', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);
    for (let i = 0; i < 6; i++) {
      h.now.value += 60_000; // each child lived a minute
      h.spawned[h.spawned.length - 1]?.exit(0);
      h.runTimers();
    }
    expect(sink.last?.stream).not.toBe('unavailable');
    expect(h.spawned.length).toBe(7);
  });

  it('reports unavailable when the binary cannot be spawned at all', () => {
    const h = makeCore({ spawnThrows: true });
    const sink = new FakeSink(true);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);
    expect(sink.last?.stream).toBe('unavailable');
    expect(sink.last?.streamError).toContain('ENOENT');
  });

  it('ignores a stale close from a child that was already replaced', () => {
    const h = makeCore();
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(new FakeSink(true));
    const first = h.spawned[0] as FakeChild;
    h.core.setSession(77, 'Notes'); // replaces the child
    const spawnedSoFar = h.spawned.length;
    first.exit(1);
    h.runTimers();
    expect(h.spawned.length).toBe(spawnedSoFar);
  });
});

describe('MacMonitorCore — the phantom comes from the overlay', () => {
  it('publishes the overlay cursor and bubble verbatim', () => {
    const h = makeCore();
    const sink = new FakeSink(false);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);
    h.core.setOverlayState(overlay({ cursorState: 'typing', statusText: 'hello there' }));
    expect(sink.last).toMatchObject({
      cursor: { x: 420, y: 380 },
      cursorState: 'typing',
      statusText: 'hello there',
      bubbleVisible: true,
    });
  });

  it('falls back to the overlay rect before the first frame', () => {
    const h = makeCore();
    const sink = new FakeSink(false);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);
    h.core.setOverlayState(overlay());
    expect(sink.last?.rect).toEqual({ x: 100, y: 100, w: 800, h: 600 });
  });

  it('the overlay disengaging ENDS the session (they cannot disagree)', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);
    expect(h.core.streaming()).toBe(true);
    h.core.setOverlayState(overlay({ engaged: false, rect: null, cursor: null }));
    expect(sink.last?.active).toBe(false);
    expect(h.core.streaming()).toBe(false);
  });

  it('does not re-send an identical state', () => {
    const h = makeCore();
    const sink = new FakeSink(false);
    h.core.setSession(4242, 'TextEdit');
    h.core.addSink(sink);
    h.core.setOverlayState(overlay());
    const count = sink.states.length;
    h.core.setOverlayState(overlay());
    h.core.setOverlayState(overlay());
    expect(sink.states.length).toBe(count);
  });
});

describe('MacMonitorCore — wallpaper', () => {
  it('resolves the helper path through the injected converter and publishes both', async () => {
    const resolver = vi.fn(async (source: string) => ({
      source,
      url: 'pd-file://f/Users/x/.pi/agent/mac-wallpaper/abc.jpg',
    }));
    const core = new MacMonitorCore({
      spawn: () => new FakeChild(),
      wallpaperReader: async () => ({ path: '/System/Library/Desktop Pictures/Sonoma.heic' }),
      wallpaperResolver: resolver,
    });
    const sink = new FakeSink(false);
    core.addSink(sink);
    await core.ensureWallpaper();
    expect(resolver).toHaveBeenCalledWith('/System/Library/Desktop Pictures/Sonoma.heic');
    expect(sink.last?.wallpaperPath).toBe('/System/Library/Desktop Pictures/Sonoma.heic');
    expect(sink.last?.wallpaperUrl).toContain('pd-file://');
  });

  it('survives a reader that throws, leaving the backdrop simply absent', async () => {
    const core = new MacMonitorCore({
      spawn: () => new FakeChild(),
      wallpaperReader: async () => {
        throw new Error('no wallpaper method');
      },
      wallpaperResolver: async () => null,
    });
    const sink = new FakeSink(false);
    core.addSink(sink);
    await expect(core.ensureWallpaper()).resolves.toBeUndefined();
    expect(core.state().wallpaperUrl).toBeNull();
  });
});
