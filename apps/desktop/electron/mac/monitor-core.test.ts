import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MacMonitorAxScene,
  MacMonitorFramePayload,
  MacMonitorState,
} from './mac-monitor-contract';
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
  scenes: MacMonitorAxScene[] = [];
  gone = false;
  constructor(public frames = true) {}
  sendState(state: MacMonitorState): void {
    this.states.push(state);
  }
  sendFrame(frame: MacMonitorFramePayload): void {
    this.frameList.push(frame);
  }
  sendAx(scene: MacMonitorAxScene): void {
    this.scenes.push(scene);
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
    // The calm state is on screen first (F9) — the failure lands after it.
    expect(sink.last?.stream).toBe('starting');
    h.runTimers();
    expect(sink.last?.stream).toBe('unavailable');
    expect(sink.last?.streamError).toContain('ENOENT');
    expect(sink.last?.streamMessage).toBe('The live view stopped. Bobble is still controlling TextEdit.');
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

// ── the Accessibility fallback ──────────────────────────────────────────────

/** The reply a real `pi-mac snapshot` gives for a TextEdit with a save sheet. */
function snapshot(): Record<string, unknown> {
  return {
    app: 'TextEdit',
    pid: 4242,
    windows: [
      {
        role: 'AXSheet',
        subrole: '',
        title: '',
        frame: { x: 200, y: 140, w: 390, h: 218 },
        windowId: 2,
        modal: true,
        sheet: true,
      },
      {
        role: 'AXWindow',
        subrole: 'AXStandardWindow',
        title: 'Untitled',
        frame: { x: 100, y: 100, w: 800, h: 600 },
        windowId: 1,
        main: true,
      },
    ],
    elements: [
      { index: 1, role: 'AXButton', name: 'Save', bbox: { x: 520, y: 330, w: 81, h: 26 }, win: 2 },
    ],
  };
}

/** A core with an injected AX reader and controllable timers. */
function makeAxCore(reader: (pid: number, cap: number) => Promise<unknown>) {
  const spawned: FakeChild[] = [];
  const timers: Array<() => void> = [];
  const core = new MacMonitorCore({
    spawn: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
    axReader: reader as never,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  return { core, spawned, timers };
}

/** Let the poller's awaited reader settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * The helper's "denied" status frame, AND the wait that follows it.
 *
 * Giving up is held behind UNAVAILABLE_FLOOR_MS (F9) so the calm "Connecting"
 * state always reaches the screen before the failure does — so a test that
 * wants the failure has to let that floor elapse, exactly as the product does.
 */
function denyStream(child: FakeChild | undefined, timers: Array<() => void>, seq = 1): void {
  child?.emit(
    encodePimf(
      header({ seq, w: 0, h: 0, windows: [], error: 'screen-recording-denied' }),
      new Uint8Array(0),
    ),
  );
  for (const fn of timers.splice(0, timers.length)) fn();
}

describe('MacMonitorCore — the Accessibility fallback', () => {
  it('says WHY when the helper reports the capture grant is missing', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    denyStream(h.spawned[0], h.timers);
    expect(sink.last?.stream).toBe('unavailable');
    expect(sink.last?.captureDenied).toBe(true);
    expect(sink.last?.streamError).toBe('screen-recording-denied');
    // The RAW reason travels for the disclosure; what the panel shows is the
    // notice, which names the app and says the grant needs a relaunch.
    expect(sink.last?.captureNotice?.title).toBe("Bobble can't see TextEdit yet");
    expect(sink.last?.captureNotice?.hint).toContain('quit and reopen Bobble');
  });

  it('does not confuse "no window" with "not allowed"', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    h.spawned[0]?.emit(
      encodePimf(header({ w: 0, h: 0, windows: [], empty: true }), new Uint8Array(0)),
    );
    expect(sink.last?.stream).toBe('no-window');
    expect(sink.last?.captureDenied).toBe(false);
  });

  it('keeps the last real geometry when a status frame arrives with none', () => {
    // A status frame's rect is all zeros. Adopting it would collapse the stage
    // to a zero-size rect at the origin at exactly the moment the surface
    // switches to drawing the window.
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    h.spawned[0]?.emit(encodePimf(header(), new Uint8Array([1, 2, 3])));
    h.spawned[0]?.emit(
      encodePimf(
        header({
          seq: 2,
          w: 0,
          h: 0,
          rect: { x: 0, y: 0, w: 0, h: 0 },
          windows: [],
          error: 'screen-recording-denied',
        }),
        new Uint8Array(0),
      ),
    );
    expect(sink.last?.rect).toEqual({ x: 100, y: 100, w: 800, h: 600 });
  });

  it('polls and publishes a scene once the stream is unavailable', async () => {
    const reader = vi.fn(async () => snapshot());
    const { core, spawned, timers } = makeAxCore(reader);
    const sink = new FakeSink(true);
    core.addSink(sink);
    core.setSession(4242, 'TextEdit');
    expect(reader).not.toHaveBeenCalled(); // pixels are still being tried
    denyStream(spawned[0], timers);
    await settle();
    expect(reader).toHaveBeenCalledWith(4242, expect.any(Number));
    expect(sink.scenes).toHaveLength(1);
    expect(sink.scenes[0]?.windows.map((w) => w.windowId)).toEqual([2, 1]);
    expect(sink.scenes[0]?.rect).toEqual({ x: 100, y: 100, w: 800, h: 600 });
  });

  it('never polls while pixels are arriving', async () => {
    const reader = vi.fn(async () => snapshot());
    const { core, spawned, timers } = makeAxCore(reader);
    core.addSink(new FakeSink(true));
    core.setSession(4242, 'TextEdit');
    spawned[0]?.emit(encodePimf(header(), new Uint8Array([1, 2, 3])));
    await settle();
    expect(core.polling()).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });

  it('stops polling when the tab stops watching — the same gate as the capture', async () => {
    const reader = vi.fn(async () => snapshot());
    const { core, spawned, timers } = makeAxCore(reader);
    const sink = new FakeSink(true);
    core.addSink(sink);
    core.setSession(4242, 'TextEdit');
    denyStream(spawned[0], timers);
    await settle();
    expect(core.polling()).toBe(true);
    sink.frames = false;
    core.addSink(sink); // re-subscribe state-only, as the surface does when hidden
    expect(core.polling()).toBe(false);
    const seen = reader.mock.calls.length;
    await settle();
    expect(reader.mock.calls.length).toBe(seen);
  });

  it('stops polling when the session ends and forgets the scene', async () => {
    const { core, spawned, timers } = makeAxCore(async () => snapshot());
    core.addSink(new FakeSink(true));
    core.setSession(4242, 'TextEdit');
    denyStream(spawned[0], timers);
    await settle();
    expect(core.axScene()).not.toBeNull();
    core.clearSession();
    expect(core.polling()).toBe(false);
    expect(core.axScene()).toBeNull();
  });

  it('survives a reader that throws, and keeps polling', async () => {
    let calls = 0;
    const { core, spawned, timers } = makeAxCore(async () => {
      calls += 1;
      if (calls === 1) throw new Error('helper busy');
      return snapshot();
    });
    const sink = new FakeSink(true);
    core.addSink(sink);
    core.setSession(4242, 'TextEdit');
    denyStream(spawned[0], timers);
    await settle();
    expect(sink.scenes).toHaveLength(0);
    for (const fn of timers.splice(0, timers.length)) fn();
    await settle();
    expect(sink.scenes).toHaveLength(1);
  });

  it('publishes nothing when Accessibility comes back empty', async () => {
    const { core, spawned, timers } = makeAxCore(async () => ({ app: 'TextEdit', windows: [] }));
    const sink = new FakeSink(true);
    core.addSink(sink);
    core.setSession(4242, 'TextEdit');
    denyStream(spawned[0], timers);
    await settle();
    expect(sink.scenes).toHaveLength(0);
    expect(core.axScene()).toBeNull();
  });

  it('sends the scene only to sinks that asked for frames', async () => {
    const { core, spawned, timers } = makeAxCore(async () => snapshot());
    const watcher = new FakeSink(true);
    const listener = new FakeSink(false);
    core.addSink(watcher);
    core.addSink(listener);
    core.setSession(4242, 'TextEdit');
    denyStream(spawned[0], timers);
    await settle();
    expect(watcher.scenes).toHaveLength(1);
    expect(listener.scenes).toHaveLength(0);
  });
});

describe('MacMonitorCore — a grant revoked mid-session', () => {
  it('forwards the status frame so the renderer drops the picture it is holding', async () => {
    // Without this the last good frame stays on screen under a surface that has
    // switched to drawing from Accessibility, and the stale PHOTOGRAPH wins the
    // source race — the monitor then shows a window frozen at the moment the
    // capture died, with no sign that anything is wrong.
    const reader = vi.fn(async () => snapshot());
    const { core, spawned, timers } = makeAxCore(reader);
    const sink = new FakeSink(true);
    core.addSink(sink);
    core.setSession(4242, 'TextEdit');
    spawned[0]?.emit(encodePimf(header(), new Uint8Array([1, 2, 3])));
    expect(sink.frameList).toHaveLength(1);
    denyStream(spawned[0], timers, 2);
    expect(sink.frameList).toHaveLength(2);
    expect(sink.frameList[1]?.jpeg).toHaveLength(0);
    expect(sink.last?.captureDenied).toBe(true);
    await settle();
    expect(sink.scenes).toHaveLength(1);
  });
});
