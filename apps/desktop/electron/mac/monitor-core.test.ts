import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MacMonitorAxScene,
  MacMonitorFramePayload,
  MacMonitorState,
  MacMonitorWindowSource,
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
    expect(sink.last?.streamMessage).toBe(
      'The live view stopped. Bobble is still controlling TextEdit.',
    );
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

  /*
   * THE AX POLL TESTS THAT USED TO LIVE HERE ARE GONE WITH THE DRAWING.
   *
   * The tree was walked four times a second whenever the pixel stream was
   * unavailable, to feed a rendering of the window built from Accessibility.
   * That rendering is retired — it can show layout and never colour, type or
   * artwork, so an arbitrary app could never look like itself — and the surface
   * now asks for the Screen Recording grant instead, which needs no tree.
   *
   * The reader is still wired for the ELECTRON source, where the walk is not a
   * fallback but the geometry itself; `wantsAx()` is asserted below.
   */
  it('does not walk the tree just because the pixel stream is unavailable', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setAxReader(async () => null);
    h.core.setSession(4242, 'TextEdit');
    denyStream(h.spawned[0], h.timers);
    expect(h.core.wantsAx()).toBe(false);
  });
});

describe('MacMonitorCore — a grant revoked mid-session', () => {
  it('forwards the status frame so the renderer drops the picture it is holding', async () => {
    // Without this the last good frame stays on screen under a surface that has
    // switched to the Screen Recording ask, and the stale PHOTOGRAPH wins the
    // source race — the monitor then shows a window frozen at the moment the
    // capture died, with no sign that anything is wrong.
    const { core, spawned, timers } = makeAxCore(vi.fn(async () => snapshot()));
    const sink = new FakeSink(true);
    core.addSink(sink);
    core.setSession(4242, 'TextEdit');
    spawned[0]?.emit(encodePimf(header(), new Uint8Array([1, 2, 3])));
    expect(sink.frameList).toHaveLength(1);
    denyStream(spawned[0], timers, 2);
    expect(sink.frameList).toHaveLength(2);
    expect(sink.frameList[1]?.jpeg).toHaveLength(0);
    expect(sink.last?.captureDenied).toBe(true);
    /*
     * It used to also assert a replacement Accessibility scene arrived. Nothing
     * publishes one now — the surface asks for the grant instead of drawing the
     * window from its tree — so what matters is only the half above: the empty
     * status frame reaches the renderer, which is what makes it let go of the
     * photograph it was still showing.
     */
    await settle();
    expect(sink.scenes).toHaveLength(0);
  });
});

// ── the picture comes from ELECTRON when the app itself is allowed to look ───

/**
 * A core with the Electron capture path installed, a controllable clock, and
 * the same fake helper child as everywhere else — so a test can watch the
 * monitor CHOOSE between the two binaries that could take the picture.
 */
function makeCaptureCore(opts: {
  grant?: 'granted' | 'denied' | 'unknown';
  sources?: () => Promise<{ windows: MacMonitorWindowSource[]; denied: boolean }>;
}) {
  const spawned: FakeChild[] = [];
  const timers: Array<() => void> = [];
  const now = { value: 50_000 };
  const grant = { value: opts.grant ?? 'granted' };
  const sourceCalls: number[][] = [];
  const core = new MacMonitorCore({
    spawn: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child;
    },
    axReader: (async () => snapshot()) as never,
    captureGrant: () => grant.value,
    sourceReader: async (ids) => {
      sourceCalls.push([...ids]);
      return opts.sources === undefined
        ? {
            windows: ids.map((id) => ({
              sourceId: `window:${id}:0`,
              windowId: id,
              name: 'TextEdit',
            })),
            denied: false,
          }
        : await opts.sources();
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  core.setClock(() => now.value);
  return { core, spawned, timers, now, grant, sourceCalls };
}

describe('MacMonitorCore — which binary takes the picture', () => {
  /*
   * The Electron path is OPT-IN now: it enumerates the window and publishes a
   * source id, and nothing turns that id into a stream — there is no
   * `getUserMedia({chromeMediaSourceId})` consumer. While Screen Recording was
   * denied the gate never opened and the helper always ran; the moment it was
   * granted the monitor reported `live` and no frame ever arrived, which is why
   * every demo recording was a blank canvas reading "Stalled · 20s".
   *
   * These still cover the path — the flag is what the consumer will remove.
   */
  beforeEach(() => {
    process.env.PI_MAC_ELECTRON_CAPTURE = '1';
  });
  afterEach(() => {
    delete process.env.PI_MAC_ELECTRON_CAPTURE;
  });

  it('prefers Electron when the APP holds the grant, and spawns no helper at all', async () => {
    // macOS keys the grant to the binary that captures. The helper is signed
    // separately, so a user who enabled "Bobble" — the only name they would
    // look for — granted a binary that does no capturing.
    const h = makeCaptureCore({});
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    await settle();
    expect(h.spawned).toHaveLength(0);
    expect(h.core.streaming()).toBe(false);
    expect(sink.last?.captureSource).toBe('electron');
    expect(sink.last?.stream).toBe('live');
    // Front-to-back, joined to Accessibility by CGWindowID: the sheet first.
    expect(sink.last?.sources.map((s) => s.windowId)).toEqual([2, 1]);
    expect(sink.last?.sources[0]?.sourceId).toBe('window:2:0');
    expect(sink.scenes).toHaveLength(1); // the geometry it composes onto
  });

  it('falls back to the helper when the app is not the one holding the grant', () => {
    const h = makeCaptureCore({ grant: 'denied' });
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    expect(h.spawned).toHaveLength(1);
    expect(sink.last?.captureSource).toBe('helper');
    expect(sink.last?.sources).toEqual([]);
  });

  it('falls back to the helper when Chromium refuses to share, rather than showing nothing', async () => {
    const h = makeCaptureCore({ sources: async () => ({ windows: [], denied: true }) });
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    await settle();
    h.now.value += 3_000; // past the source refresh throttle
    for (const fn of h.timers.splice(0, h.timers.length)) fn();
    await settle();
    expect(h.spawned.length).toBeGreaterThan(0);
    expect(h.core.state().captureSource).toBe('helper');
  });

  it('stops enumerating when the window set has not changed', async () => {
    const h = makeCaptureCore({});
    h.core.addSink(new FakeSink(true));
    h.core.setSession(4242, 'TextEdit');
    await settle();
    for (const fn of h.timers.splice(0, h.timers.length)) fn();
    await settle();
    expect(h.sourceCalls).toHaveLength(1); // same windows, same list
  });

  it('re-reads the grant on every session — macOS asks again every month', () => {
    const h = makeCaptureCore({ grant: 'granted' });
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    expect(sink.last?.captureSource).toBe('electron');
    h.grant.value = 'denied';
    h.core.setSession(99, 'Notes');
    expect(sink.last?.captureSource).toBe('helper');
    // …and once the helper cannot see either, the panel says which of the two
    // stories this is, because they need different first lines.
    denyStream(h.spawned[h.spawned.length - 1], h.timers);
    expect(sink.last?.captureDenied).toBe(true);
    expect(sink.last?.captureRevoked).toBe(true);
    expect(sink.last?.captureNotice?.title).toBe('macOS asks for this again every month');
  });
});

describe('MacMonitorCore — slow is not stuck', () => {
  it('says stalled when a live stream stops producing, with the age it stopped at', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    h.spawned[0]?.emit(encodePimf(header(), new Uint8Array([1, 2, 3])));
    expect(sink.last?.stream).toBe('live');
    expect(sink.last?.stalled).toBe(false);
    h.now.value += 12_000;
    h.core.tick();
    expect(sink.last?.stalled).toBe(true);
    expect(sink.last?.lastPictureAgeMs).toBe(12_000);
  });

  it('times how long the model has been thinking, and forgets it when it acts', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    h.core.setOverlayState(overlay({ cursorState: 'thinking' }));
    h.now.value += 32_000;
    h.core.tick();
    expect(sink.last?.thinkingMs).toBe(32_000);
    h.core.setOverlayState(overlay({ cursorState: 'clicking' }));
    expect(sink.last?.thinkingMs).toBeNull();
  });

  it('a tick nobody is watching costs nothing', () => {
    const h = makeCore();
    h.core.setSession(4242, 'TextEdit');
    h.core.tick(); // no sinks
    expect(h.core.state().active).toBe(true);
  });
});

describe('MacMonitorCore — the brake and the wheel', () => {
  it('stops capturing the moment the user stops the run', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    expect(h.core.streaming()).toBe(true);
    h.core.setControl('stopped');
    expect(h.core.streaming()).toBe(false);
    expect(h.core.wanted()).toBe(false);
    expect(sink.last?.control).toBe('stopped');
    // The session is still there — the surface has to be able to say WHICH app
    // was stopped, and "stopped" must not read as "finished".
    expect(sink.last?.active).toBe(true);
  });

  it('stops LOOKING when the user takes over — including the Accessibility poll', async () => {
    // The case this exists for is the user typing a password into the app the
    // agent just opened. "Bobble isn't watching" has to be true.
    const { core, timers } = makeAxCore(async () => snapshot());
    const sink = new FakeSink(true);
    core.addSink(sink);
    core.setSession(4242, 'TextEdit');
    denyStream(undefined, timers);
    core.setControl('user');
    await settle();
    expect(core.polling()).toBe(false);
    expect(core.streaming()).toBe(false);
    expect(sink.last?.control).toBe('user');
  });

  it('comes back only when control is handed back', () => {
    const h = makeCore();
    h.core.addSink(new FakeSink(true));
    h.core.setSession(4242, 'TextEdit');
    h.core.setControl('stopped');
    const spawnedWhileStopped = h.spawned.length;
    h.core.setSession(4242, 'TextEdit'); // the model carries on asking
    expect(h.spawned.length).toBe(spawnedWhileStopped);
    h.core.setControl('agent');
    expect(h.spawned.length).toBe(spawnedWhileStopped + 1);
  });

  it('never offers the Screen Recording screen to someone who is driving', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    denyStream(h.spawned[0], h.timers);
    expect(sink.last?.captureNotice).not.toBeNull();
    h.core.setControl('user');
    expect(sink.last?.captureNotice).toBeNull();
    expect(sink.last?.captureDenied).toBe(false);
  });
});

describe('MacMonitorCore — what it says when it cannot see', () => {
  it('never puts a process message on screen', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    for (let i = 0; i < 6; i++) {
      h.spawned[h.spawned.length - 1]?.exit(1);
      h.runTimers();
    }
    expect(sink.last?.stream).toBe('unavailable');
    // The raw reason still travels for the disclosure…
    expect(sink.last?.streamError).toContain('pi-mac --stream exited');
    // …and never reaches the sentence a person reads.
    expect(sink.last?.streamMessage).not.toContain('pi-mac');
    expect(sink.last?.streamMessage).toBe(
      'The live view stopped. Bobble is still controlling TextEdit.',
    );
  });

  it('tells "nothing to show" apart from "not allowed"', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    h.spawned[0]?.emit(
      encodePimf(
        header({ w: 0, h: 0, windows: [], error: 'no-shareable-window' }),
        new Uint8Array(0),
      ),
    );
    h.runTimers();
    expect(sink.last?.captureDenied).toBe(false);
    expect(sink.last?.streamMessage).toBe('TextEdit has nothing on screen to show.');
  });

  it('reports a late failure at once — the floor is for the FIRST moment only', () => {
    const h = makeCore();
    const sink = new FakeSink(true);
    h.core.addSink(sink);
    h.core.setSession(4242, 'TextEdit');
    h.now.value += 60_000; // a stream that ran happily for a minute
    denyStream(h.spawned[0], []); // no timers run: nothing is being held back
    expect(sink.last?.stream).toBe('unavailable');
  });
});
