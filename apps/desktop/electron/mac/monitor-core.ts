/**
 * The computer-use MONITOR's logic, with no electron in it.
 *
 * Everything that decides anything lives here — when the capture child may run,
 * what a subscriber is sent, how a dead helper is retried and when it is given
 * up on, how the published state is assembled from the overlay's — so all of it
 * unit-tests in plain Node with a fake child and a fake sink (the same
 * structural-injection rule the rest of `electron/` follows). `monitor.ts` is
 * the electron half: ipcMain handlers, a WebContents→sink adapter, the real
 * spawn, and the wallpaper cache.
 *
 * ── TWO GATES, BOTH REQUIRED ────────────────────────────────────────────────
 * The child runs only while (a) a computer-use session is controlling an app
 * and (b) at least one subscriber wants FRAMES. Screen capture is a compositor
 * tap that keeps the GPU busy, so a monitor tab the user switched away from
 * must cost nothing, and a session with no tab open must not capture at all.
 *
 * ── ONE SOURCE OF TRUTH FOR THE PHANTOM ─────────────────────────────────────
 * The cursor point, the bubble text and the tracked window rect are not derived
 * here. They are pushed in from the overlay controller, which already owns them
 * to drive the real on-screen overlay. A second derivation of the same tool
 * events would drift, and a monitor whose phantom is somewhere the real one is
 * not is worse than no monitor.
 */
import {
  captureNoticeFor,
  EMPTY_MAC_MONITOR_STATE,
  MAC_CAPTURE_DENIED,
  type MacMonitorAxScene,
  type MacMonitorCaptureSource,
  type MacMonitorControl,
  type MacMonitorFramePayload,
  type MacMonitorState,
  type MacMonitorStreamState,
  type MacMonitorWindowSource,
  streamMessageFor,
} from './mac-monitor-contract';
import { axSceneFrom, type MacAxSnapshotLike } from './monitor-ax';
import type { MacOverlayState } from './overlay-geometry';
import { PimfParser } from './pimf';

/** Capture cadence asked of the helper. 12fps reads as live without making the
 * stream the most expensive thing the app does. */
export const STREAM_FPS = 12;
/** Cap the captured pixel width; a 6K window scaled into a canvas rail does not
 * need 6K of JPEG per frame. */
export const STREAM_MAX_WIDTH = 1400;
/** A child that dies is retried this many times before the stream is called
 * unavailable — an old helper with no `--stream` dies instantly, every time. */
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 800;
/** A child that survived this long counts as having worked, so its exit resets
 * the restart budget rather than spending it. */
const HEALTHY_RUN_MS = 5_000;
/**
 * Cadence of the Accessibility fallback poll.
 *
 * 4Hz, an order of magnitude below the capture stream's 12, because an AX tree
 * walk is a synchronous round-trip through another process's main thread and
 * the thing being drawn is a LAYOUT — windows, buttons, the text in a field.
 * Those change at human speed. Fast enough that a sheet appears the moment it
 * opens; slow enough to cost the driven app almost nothing.
 */
export const AX_POLL_MS = 250;
/** How many elements the fallback asks for. The helper's own default is 60,
 * which is a good list for a MODEL and a thin drawing of a window. */
const AX_CAP = 220;

/**
 * THE CALM STATE ALWAYS GETS ON SCREEN FIRST.
 *
 * A child can spawn and die inside one tick, which paints "Live view
 * unavailable" before "Connecting to TextEdit" was ever seen — the exact thing
 * iPhone Mirroring is mocked for ("that 'connection failed' screen shows up
 * faster than the app can even crash"). A failure inside this window waits it
 * out; a failure after it lands immediately, because by then the user has had
 * the calm state and is owed the truth.
 */
export const UNAVAILABLE_FLOOR_MS = 900;
/**
 * A live stream with no new picture for this long is STALLED, not slow. Above
 * the helper's own 400ms window re-resolve and well above a 12fps cadence, so
 * a hiccup never trips it; short enough that the surface says so before the
 * user starts wondering.
 */
export const STALL_AFTER_MS = 4_000;
/** Re-enumerate Chromium's window sources at most this often. Enumeration walks
 * every window on the machine, so it rides the AX poll's coat-tails rather than
 * running at it: only when the window set changed, or this long has passed. */
const SOURCE_REFRESH_MS = 2_000;
/** Chromium refusing to share the windows this many times in a row means the
 * app's own grant is not usable — fall back to the helper, which may hold one
 * of its own. */
const ELECTRON_GIVE_UP = 2;

/** Whether the APP (not the helper) may capture. Injected so the core stays
 * electron-free; monitor.ts reads systemPreferences. */
export type CaptureGrantReader = () => 'granted' | 'denied' | 'unknown';

/** Chromium's sources for the given CGWindowIDs, in the order asked for. */
export type CaptureSourceReader = (
  windowIds: readonly number[],
) => Promise<{ windows: MacMonitorWindowSource[]; denied: boolean }>;

/** Injected reader for the helper's `wallpaper` method (mac-agent owns the one
 * long-lived helper pipe; the monitor never opens a second one). */
export type WallpaperReader = () => Promise<{ path?: string } | null>;

/** Injected converter: a system wallpaper path → a path the renderer can load. */
export type WallpaperResolver = (source: string) => Promise<{ source: string; url: string } | null>;

/** Injected reader for the helper's `snapshot` method — the fallback's eyes.
 * Goes through the one long-lived `--serve` helper, never a second pipe. */
export type AxReader = (pid: number, cap: number) => Promise<MacAxSnapshotLike | null>;

/** The capture child, structurally — so a fake stands in for `pi-mac`. */
export interface StreamChild {
  readonly pid?: number;
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type StreamSpawnFn = (pid: number, args: readonly string[]) => StreamChild;

/** One watching renderer, abstracted away from WebContents. */
export interface MonitorSink {
  /** Whether this sink wants FRAMES as well as state. */
  frames: boolean;
  sendState(state: MacMonitorState): void;
  sendFrame(frame: MacMonitorFramePayload): void;
  /** The Accessibility-drawn scene. Same gate as frames — it is the same
   * picture by another route, and costs the driven app a tree walk. */
  sendAx(scene: MacMonitorAxScene): void;
  /** The renderer is gone; drop it on the next fan-out. */
  isGone(): boolean;
}

export interface MacMonitorCoreOptions {
  spawn: StreamSpawnFn;
  wallpaperReader?: WallpaperReader;
  wallpaperResolver?: WallpaperResolver;
  axReader?: AxReader;
  /** The app's own Screen Recording grant, and Chromium's window sources — the
   * preferred capture path (see the contract's two-paths note). */
  captureGrant?: CaptureGrantReader;
  sourceReader?: CaptureSourceReader;
  /** Injected so tests need no timers of their own. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

const IDLE_OVERLAY: MacOverlayState = {
  engaged: false,
  pid: null,
  rect: null,
  cursor: null,
  cursorState: 'idle',
  statusText: '',
  bubbleVisible: false,
  wantsVisible: false,
};

export class MacMonitorCore {
  #sinks = new Set<MonitorSink>();
  #session: { pid: number; appName: string } | null = null;
  #child: StreamChild | null = null;
  #childStartedAt = 0;
  #parser = new PimfParser();
  #restarts = 0;
  #restartHandle: unknown = null;
  #stream: MacMonitorStreamState = 'idle';
  #streamError: string | null = null;
  #wallpaper: { path: string; url: string } | null = null;
  #wallpaperPending: Promise<void> | null = null;
  #overlay: MacOverlayState = IDLE_OVERLAY;
  #lastSentJson = '';
  /** The CAPTURED union rect (main window plus its sheets), which is what the
   * surface must draw — the overlay's AX frame is only the main window. */
  #frameRect: MacMonitorState['rect'] = null;
  #frameDisplay: MacMonitorState['display'] = null;
  #captureDenied = false;
  /** The Accessibility fallback's poll: a self-rescheduling chain, never an
   * interval — a tree walk that takes longer than the cadence must not stack. */
  #axHandle: unknown = null;
  #axInFlight = false;
  #axScene: MacMonitorAxScene | null = null;
  #now: () => number = () => Date.now();
  /** When the current session's calm state began — the floor F9 measures from. */
  #calmSince = 0;
  /** A give-up held back by that floor, and its timer. */
  #pendingGiveUp: string | null = null;
  #giveUpHandle: unknown = null;
  /** When the last picture — a real frame OR an AX scene — arrived. */
  #lastPictureAt = 0;
  /** When the bubble last went to 'thinking' (null: it is not thinking). */
  #thinkingSince: number | null = null;
  /** Who has the wheel. Only the USER can move this off 'stopped'/'user'. */
  #control: MacMonitorControl = 'agent';
  /** The app's own capture grant, as last read. */
  #grant: 'granted' | 'denied' | 'unknown' = 'unknown';
  /** The app HELD the grant at some point in this run — so losing it is
   * macOS's monthly re-ask rather than a first run (F8). */
  #everGranted = false;
  #source: MacMonitorCaptureSource = 'none';
  #sources: MacMonitorWindowSource[] = [];
  /** The window-id set `#sources` was enumerated for, and when. */
  #sourcesKey = '';
  #sourcesAt = 0;
  /** Consecutive enumerations that produced nothing. */
  #sourceMisses = 0;

  readonly #opts: MacMonitorCoreOptions;

  constructor(opts: MacMonitorCoreOptions) {
    this.#opts = opts;
  }

  /** Test seam: control the clock the restart-health rule reads. */
  setClock(now: () => number): void {
    this.#now = now;
  }

  setWallpaperReader(reader: WallpaperReader): void {
    this.#opts.wallpaperReader = reader;
    this.#wallpaper = null;
  }

  setSpawn(spawn: StreamSpawnFn): void {
    this.#opts.spawn = spawn;
  }

  setAxReader(reader: AxReader): void {
    this.#opts.axReader = reader;
    this.reconcile();
  }

  /** Dev mock only: fall back to the helper path, whatever the app's grant
   * says — the mock IS a stubbed helper, and the preferred path would never
   * spawn it on a machine where the grant is present. */
  disableElectronCapture(): void {
    this.#opts.sourceReader = undefined;
    this.#sources = [];
    this.#sourcesKey = '';
    if (this.#source === 'electron') this.#source = 'none';
    this.reconcile();
  }

  /** Install the preferred (Electron) capture path. */
  setCaptureSourceReader(grant: CaptureGrantReader, sources: CaptureSourceReader): void {
    this.#opts.captureGrant = grant;
    this.#opts.sourceReader = sources;
    this.#readGrant();
    this.reconcile();
  }

  /**
   * Re-read the app's own grant, remembering whether it was ever held.
   *
   * Called whenever a session starts, which is exactly when it matters: macOS
   * Sequoia re-asks for Screen Recording about once a month, so a run thirty
   * days after everything worked is the FIRST place the app can notice it was
   * turned off — and the difference between "you have never granted this" and
   * "macOS just asked again" is the whole of the copy.
   */
  #readGrant(): 'granted' | 'denied' | 'unknown' {
    const read = this.#opts.captureGrant;
    const next = read === undefined ? 'unknown' : read();
    if (next === 'granted') this.#everGranted = true;
    this.#grant = next;
    return next;
  }

  /** The installed reader, so a wrapper can delegate to it. */
  axReader(): AxReader | undefined {
    return this.#opts.axReader;
  }

  /** Diagnostics/tests: the last Accessibility scene published, if any. */
  axScene(): MacMonitorAxScene | null {
    return this.#axScene;
  }

  // ── the phantom's state, pushed in from the overlay ─────────────────────

  setOverlayState(state: MacOverlayState): void {
    const was = this.#overlay.cursorState;
    this.#overlay = state;
    // "Thinking" is the one state with no natural end — every other one is
    // followed by an act. Time it, so a model that has gone quiet can say how
    // long rather than showing the same three dots forever.
    if (state.cursorState === 'thinking') {
      if (was !== 'thinking' || this.#thinkingSince === null) this.#thinkingSince = this.#now();
    } else {
      this.#thinkingSince = null;
    }
    // The overlay dropping its target IS the session ending — the two must not
    // be able to disagree about whether an app is being driven. EXCEPT when the
    // user is the one who put the phantom away: "stopped" has to keep saying
    // WHICH app was stopped, or the brake reads as the run having finished.
    if (!state.engaged && this.#session !== null && this.#control === 'agent') this.clearSession();
    else this.broadcastState();
  }

  // ── session lifecycle ──────────────────────────────────────────────────

  /** A computer-use act took control of `pid`. Idempotent per pid. */
  setSession(pid: number, appName: string): void {
    const name = appName.trim();
    if (this.#session?.pid === pid) {
      if (name !== '' && name !== this.#session.appName) {
        this.#session = { pid, appName: name };
        this.broadcastState();
      }
      return;
    }
    this.#session = { pid, appName: name };
    this.#restarts = 0;
    this.#streamError = null;
    this.#captureDenied = false;
    this.#axScene = null;
    this.#stopChild();
    this.#clearPendingGiveUp();
    this.#stream = 'idle';
    this.#calmSince = this.#now();
    this.#lastPictureAt = 0;
    this.#sources = [];
    this.#sourcesKey = '';
    this.#sourceMisses = 0;
    this.#source = 'none';
    // A new session is the moment to look again: the grant may have arrived
    // since the last one, or macOS may have taken it back (F8).
    this.#readGrant();
    // A new act means the agent is driving again; a brake the model could not
    // clear is the point, but a brand-new session is the user's own doing.
    void this.ensureWallpaper();
    this.reconcile();
    this.broadcastState();
  }

  /**
   * THE BRAKE, AND THE WHEEL.
   *
   * `stopped` and `user` both cut every capture dead — the difference is only
   * what the surface says. Take-over in particular has to stop LOOKING, not
   * just stop acting: the case that most needs it is the user typing a password
   * into the app the agent opened, and "Bobble isn't watching" has to be true
   * for that to be a promise rather than a slogan.
   */
  setControl(mode: MacMonitorControl): void {
    if (this.#control === mode) return;
    this.#control = mode;
    if (mode === 'agent') {
      // Coming back from a stop is a fresh look at the picture, not a resume of
      // a stream that gave up while nobody was allowed to watch.
      this.#streamError = null;
      this.#captureDenied = false;
      this.#clearPendingGiveUp();
      if (this.#stream === 'unavailable') this.#stream = 'idle';
      this.#calmSince = this.#now();
      this.#readGrant();
    }
    this.reconcile();
    this.broadcastState();
  }

  control(): MacMonitorControl {
    return this.#control;
  }

  /** The session ended (setDriving:false, the window vanished, the app quit). */
  clearSession(): void {
    if (this.#session === null && this.#stream === 'idle') return;
    this.#session = null;
    this.#stopChild();
    this.#clearPendingGiveUp();
    this.#stream = 'idle';
    this.#streamError = null;
    this.#captureDenied = false;
    this.#frameRect = null;
    this.#frameDisplay = null;
    this.#axScene = null;
    this.#sources = [];
    this.#sourcesKey = '';
    this.#source = 'none';
    this.#lastPictureAt = 0;
    this.#thinkingSince = null;
    // The brake is scoped to the run it stopped. Latching it past the end of
    // the session would leave an invisible refusal waiting for a run somebody
    // starts hours later, with nothing on screen to explain it — and by this
    // point the stop has already done its whole job: the agent has stood down,
    // the phantom is gone and nothing is being captured.
    this.#control = 'agent';
    this.reconcile();
    this.broadcastState();
  }

  // ── subscribers ────────────────────────────────────────────────────────

  addSink(sink: MonitorSink): MacMonitorState {
    this.#sinks.add(sink);
    // A fresh subscriber has seen nothing, so the dedupe (which compares
    // against what was last sent to ANYONE) must not swallow its first push.
    this.#lastSentJson = '';
    void this.ensureWallpaper();
    this.reconcile();
    // Push as well as return: the invoke response covers the subscriber that
    // just asked, but a re-subscribe (a surface asking for frames) and the
    // wallpaper arriving later both reach everyone through the event.
    this.broadcastState();
    return this.state();
  }

  removeSink(sink: MonitorSink): void {
    if (!this.#sinks.delete(sink)) return;
    this.reconcile();
  }

  /** For the electron adapter: find this renderer's existing sink, if any. */
  sinks(): ReadonlySet<MonitorSink> {
    return this.#sinks;
  }

  // ── published state ────────────────────────────────────────────────────

  state(): MacMonitorState {
    const session = this.#session;
    const o = this.#overlay;
    const now = this.#now();
    // Whole seconds, not milliseconds: these are ages a person reads off the
    // screen ("no new frames for 12s"), and a value that changes every
    // millisecond would defeat the identical-state dedupe on every frame.
    const seconds = (from: number): number => Math.floor((now - from) / 1000) * 1000;
    const appName = session?.appName ?? '';
    // "macOS has not granted this" is only worth saying while there is nothing
    // to look at. The denial is real either way; the SCREEN for it is not.
    const denied =
      session !== null && this.#stream === 'unavailable' && this.#control === 'agent'
        ? this.#captureDenied || this.#grant === 'denied'
        : false;
    const revoked = denied && this.#everGranted && this.#grant === 'denied';
    return {
      ...EMPTY_MAC_MONITOR_STATE,
      active: session !== null,
      pid: session?.pid ?? null,
      appName,
      stream: this.#stream,
      streamError: this.#streamError,
      streamMessage: denied
        ? null // the notice says it better, and says what to do about it
        : streamMessageFor(this.#streamError, appName),
      wallpaperPath: this.#wallpaper?.path ?? null,
      wallpaperUrl: this.#wallpaper?.url ?? null,
      rect: this.#frameRect ?? (o.rect === null ? null : { ...o.rect }),
      display: this.#frameDisplay,
      statusText: o.statusText,
      cursorState: o.cursorState,
      cursor: o.cursor,
      bubbleVisible: o.bubbleVisible,
      captureDenied: denied,
      captureRevoked: revoked,
      captureAppName: EMPTY_MAC_MONITOR_STATE.captureAppName,
      captureNotice: denied ? captureNoticeFor({ appName, revoked }) : null,
      captureSource: this.#source,
      sources: this.#sources.map((s) => ({ ...s })),
      stalled:
        this.#stream === 'live' &&
        this.#lastPictureAt !== 0 &&
        now - this.#lastPictureAt >= STALL_AFTER_MS,
      lastPictureAgeMs: this.#lastPictureAt === 0 ? null : seconds(this.#lastPictureAt),
      thinkingMs: this.#thinkingSince === null ? null : seconds(this.#thinkingSince),
      control: this.#control,
    };
  }

  broadcastState(): void {
    if (this.#sinks.size === 0) return;
    const state = this.state();
    // Cursor moves are frequent; an identical state is not worth a wire hop.
    const json = JSON.stringify(state);
    if (json === this.#lastSentJson) return;
    this.#lastSentJson = json;
    for (const sink of [...this.#sinks]) {
      if (sink.isGone()) {
        this.#sinks.delete(sink);
        continue;
      }
      try {
        sink.sendState(state);
      } catch {
        /* a dead renderer must never break the stream */
      }
    }
  }

  /**
   * Nothing changed, but TIME did — and time is the whole of "stalled" and
   * "still thinking, 32s". Cheap by construction: the ages are quantised to
   * whole seconds, so the identical-state dedupe swallows every tick inside the
   * same second, and a session nobody is watching never gets here at all.
   */
  tick(): void {
    if (this.#session === null || this.#sinks.size === 0) return;
    this.broadcastState();
  }

  #broadcastFrame(payload: MacMonitorFramePayload): void {
    for (const sink of [...this.#sinks]) {
      if (sink.isGone()) {
        this.#sinks.delete(sink);
        continue;
      }
      if (!sink.frames) continue;
      try {
        sink.sendFrame(payload);
      } catch {
        /* drop the frame for this renderer; the next one will do */
      }
    }
  }

  #broadcastAx(scene: MacMonitorAxScene): void {
    for (const sink of [...this.#sinks]) {
      if (sink.isGone()) {
        this.#sinks.delete(sink);
        continue;
      }
      if (!sink.frames) continue;
      try {
        sink.sendAx(scene);
      } catch {
        /* drop this poll for this renderer; the next one is 250ms away */
      }
    }
  }

  // ── the capture child ──────────────────────────────────────────────────

  /** Should anything be capturing right now? BOTH gates, plus the brake. */
  wanted(): boolean {
    if (this.#session === null) return false;
    // Stopped, or the user has taken the wheel: nothing looks at their screen.
    if (this.#control !== 'agent') return false;
    for (const sink of this.#sinks) {
      if (sink.frames && !sink.isGone()) return true;
    }
    return false;
  }

  /**
   * Should the pixels come from ELECTRON rather than the helper?
   *
   * Yes whenever the app itself holds the grant, because that is the grant the
   * user can actually give: "Bobble" is the only name they would look for in
   * the Screen Recording list, and enabling it grants this process. The helper
   * is a separately-signed binary and therefore its own TCC client — a user who
   * has done everything right can still have granted the wrong thing.
   */
  #prefersElectron(): boolean {
    return (
      this.#opts.sourceReader !== undefined &&
      this.#grant === 'granted' &&
      this.#sourceMisses < ELECTRON_GIVE_UP
    );
  }

  /**
   * Should the Accessibility fallback be polling right now?
   *
   * The same "somebody is watching" gate as the capture, AND only while the
   * pixels are not coming. Two live sources of the same window would be a
   * wasted tree walk four times a second in the case that already works.
   */
  wantsAx(): boolean {
    if (!this.wanted() || this.#opts.axReader === undefined) return false;
    /*
     * ONLY WHERE THE TREE IS ACTUALLY USED — the Electron path, where it is not
     * a fallback at all: it is where the geometry comes from, and the window ids
     * it reports are what join Chromium's pixels to the right window.
     *
     * It used to ALSO run whenever the pixel stream was unavailable, to feed a
     * drawing of the window made from the tree. That drawing is gone (the user, on
     * seeing it against a real app: "that reconstruction of the calculator app
     * does not feel like it's at the best it can be" — and Accessibility has no
     * colour or artwork to give, so an arbitrary app can never look like
     * itself). What shows instead is the Screen Recording ask, which needs no
     * tree — so this was a full walk of the user's app, four times a second, for
     * a picture nobody sees.
     */
    return this.#source === 'electron';
  }

  reconcile(): void {
    const wanted = this.wanted();
    if (wanted && this.#prefersElectron()) {
      // Not merely unnecessary — a second capture of the same window, by a
      // binary the user never granted anything to.
      this.#stopChild();
      if (this.#source !== 'electron') {
        this.#source = 'electron';
        this.#stream = 'starting';
        this.#calmSince = this.#now();
        this.#clearPendingGiveUp();
      }
    } else if (wanted) {
      this.#source = 'helper';
      this.#startChild();
    } else {
      this.#stopChild();
      this.#source = 'none';
    }
    if (this.wantsAx()) this.#startAx();
    else this.#stopAx();
  }

  /** Diagnostics/tests: is a capture child running? */
  streaming(): boolean {
    return this.#child !== null;
  }

  /** Diagnostics/tests: is the Accessibility fallback polling? */
  polling(): boolean {
    return this.#axHandle !== null || this.#axInFlight;
  }

  // ── the Accessibility fallback ─────────────────────────────────────────

  #startAx(): void {
    if (this.#axHandle !== null || this.#axInFlight) return;
    // Poll immediately: the surface is showing an explanation right now, and a
    // quarter-second of empty stage before the window appears reads as broken.
    void this.#axTick();
  }

  #stopAx(): void {
    if (this.#axHandle === null) return;
    const clearTimer = this.#opts.clearTimer ?? ((h) => clearTimeout(h as never));
    clearTimer(this.#axHandle);
    this.#axHandle = null;
  }

  async #axTick(): Promise<void> {
    this.#axHandle = null;
    const reader = this.#opts.axReader;
    const session = this.#session;
    if (reader === undefined || session === null || !this.wantsAx()) return;
    this.#axInFlight = true;
    try {
      const snap = await reader(session.pid, AX_CAP);
      // The gate can close while a tree walk is in flight (the tab was hidden,
      // the session ended, pixels started arriving). Publishing then would push
      // a scene into a surface that has already moved on.
      if (snap !== null && this.wantsAx() && this.#session?.pid === session.pid) {
        const scene = axSceneFrom(snap, {
          t: this.#now(),
          pid: session.pid,
          appName: session.appName,
          display: this.#frameDisplay,
        });
        if (scene !== null) {
          this.#axScene = scene;
          this.#lastPictureAt = this.#now();
          this.#broadcastAx(scene);
          if (this.#source === 'electron') await this.#refreshSources(scene);
        } else if (this.#source === 'electron') {
          // Accessibility can see the app and it has no windows. That is the
          // "no window" state, not a failure — and there is nothing for
          // Chromium to share either.
          this.#sources = [];
          this.#sourcesKey = '';
          if (this.#stream !== 'no-window') {
            this.#stream = 'no-window';
            this.broadcastState();
          }
        }
      }
    } catch (err) {
      // A failed walk is not worth a state change — the app may simply have
      // been mid-launch. The next tick is 250ms away.
      this.#opts.log?.warn('mac monitor ax poll failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#axInFlight = false;
    }
    if (!this.wantsAx()) return;
    const setTimer = this.#opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#axHandle = setTimer(() => {
      void this.#axTick();
    }, AX_POLL_MS);
    (this.#axHandle as { unref?: () => void })?.unref?.();
  }

  /**
   * Join Chromium's window sources to the windows Accessibility just reported.
   *
   * Enumeration is the expensive half (it walks every window on the machine),
   * so it runs only when the window set changed or SOURCE_REFRESH_MS has
   * passed — a sheet opening is a change, a cursor moving is not.
   */
  async #refreshSources(scene: MacMonitorAxScene): Promise<void> {
    const reader = this.#opts.sourceReader;
    if (reader === undefined || this.#source !== 'electron') return;
    const ids = scene.windows.map((w) => w.windowId).filter((id) => id > 0);
    const key = ids.join(',');
    if (key === this.#sourcesKey && this.#now() - this.#sourcesAt < SOURCE_REFRESH_MS) return;
    let res: { windows: MacMonitorWindowSource[]; denied: boolean };
    try {
      res = await reader(ids);
    } catch {
      res = { windows: [], denied: true };
    }
    // The gate can close while an enumeration is in flight.
    if (this.#source !== 'electron') return;
    this.#sourcesAt = this.#now();
    if (res.denied || res.windows.length === 0) {
      this.#sourceMisses += 1;
      this.#sources = [];
      this.#sourcesKey = '';
      if (res.denied) this.#grant = 'denied';
      if (this.#sourceMisses >= ELECTRON_GIVE_UP) {
        // The app's own grant is not usable after all. The helper is signed
        // separately and may hold one of its own, so try it before giving up.
        this.#opts.log?.warn('mac monitor: electron capture unusable, trying the helper', {
          denied: res.denied,
        });
        this.#source = 'none';
        this.reconcile();
      }
      this.broadcastState();
      return;
    }
    this.#sourceMisses = 0;
    this.#sourcesKey = key;
    this.#sources = res.windows;
    if (this.#stream !== 'live') {
      this.#stream = 'live';
      this.#streamError = null;
      this.#captureDenied = false;
    }
    this.broadcastState();
  }

  #startChild(): void {
    if (this.#child !== null || this.#restartHandle !== null) return;
    const session = this.#session;
    if (session === null) return;
    // Already gave up for this session; a new setSession() clears it.
    if (this.#stream === 'unavailable') return;
    // A give-up is being held back by the calm-state floor — respawning here
    // would restart the very child whose death is already being reported.
    if (this.#pendingGiveUp !== null) return;
    // Say "connecting" BEFORE trying, not after succeeding: a helper binary
    // that is missing entirely throws synchronously, and a user who never saw
    // the calm state reads the failure as an app that did not even try. The
    // calm state also starts HERE rather than at setSession, so a tab opened
    // five minutes into a run still gets it.
    this.#stream = 'starting';
    this.#calmSince = this.#now();
    this.broadcastState();
    let child: StreamChild;
    try {
      child = this.#opts.spawn(session.pid, [
        '--stream',
        '--pid',
        String(session.pid),
        '--fps',
        String(STREAM_FPS),
        '--max-width',
        String(STREAM_MAX_WIDTH),
      ]);
    } catch (err) {
      this.#giveUp(err instanceof Error ? err.message : String(err));
      return;
    }
    this.#child = child;
    this.#childStartedAt = this.#calmSince;
    this.#parser.reset();

    child.stdout?.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr?.on('data', () => {
      /* the helper's diagnostics are logged by the electron adapter */
    });
    child.on('error', (err) => this.#onChildGone(child, err.message));
    child.on('close', (code) =>
      this.#onChildGone(child, code === 0 ? null : `pi-mac --stream exited (${String(code)})`),
    );
  }

  #onStdout(chunk: Buffer): void {
    for (const { header, payload } of this.#parser.push(chunk)) {
      // A status frame carries no geometry (all zeros); adopting it would move
      // the stage to the origin at zero size just as the surface switches to
      // drawing from Accessibility, which is the one moment the rect matters.
      const statusOnly = header.error !== undefined || header.empty === true;
      if (!statusOnly) {
        this.#frameRect = { ...header.rect };
        this.#frameDisplay = { ...header.display };
        // A real picture arrived. This is the clock the stalled state reads.
        this.#lastPictureAt = this.#now();
      }
      // A frame that explains itself wins over anything inferred from its
      // shape: "the app has no window" and "macOS will not let us capture" look
      // identical on the wire (no picture) and are completely different facts.
      const was = this.#stream;
      if (header.error !== undefined) {
        this.#giveUp(header.error);
      } else {
        // The contract's once-only "no window" frame: an empty window list AND
        // a zero-byte payload. Anything else is a picture.
        const next: MacMonitorStreamState =
          header.empty === true || (header.windows.length === 0 && payload.length === 0)
            ? 'no-window'
            : 'live';
        if (next !== this.#stream) {
          this.#stream = next;
          this.#streamError = null;
          this.#captureDenied = false;
        }
      }
      // FALL THROUGH to the broadcast even for a status frame. The zero-byte
      // payload is how the renderer learns to drop the picture it is holding:
      // a grant revoked mid-session would otherwise leave the last good frame
      // on screen, and a stale photograph outranks the drawing that replaced it.
      this.#broadcastFrame({
        seq: header.seq,
        t: header.t,
        jpeg: payload,
        w: header.w,
        h: header.h,
        rect: { ...header.rect },
        display: { ...header.display },
        windows: header.windows.map((w) => ({
          windowId: w.windowId,
          title: w.title,
          frame: { ...w.frame },
          sheet: w.sheet === true,
          modal: w.modal === true,
        })),
      });
      this.broadcastState();
      // A stream state that changed opens or closes the Accessibility poll —
      // only then, because reconciling on every one of twelve frames a second
      // would walk the sink set for nothing.
      if (this.#stream !== was) this.reconcile();
    }
  }

  #onChildGone(child: StreamChild, reason: string | null): void {
    // A stale 'close' from a child we already replaced must not restart anything.
    if (this.#child !== child) return;
    const lived = this.#now() - this.#childStartedAt;
    this.#child = null;
    this.#parser.reset();
    if (!this.wanted()) {
      if (this.#stream !== 'unavailable') this.#stream = 'idle';
      this.broadcastState();
      return;
    }
    // A child that ran for a while and then stopped is a hiccup, not a helper
    // that cannot stream — don't spend the give-up budget on it.
    if (lived >= HEALTHY_RUN_MS) this.#restarts = 0;
    if (this.#restarts >= MAX_RESTARTS) {
      this.#giveUp(reason ?? 'the capture stream stopped');
      return;
    }
    this.#restarts += 1;
    const setTimer = this.#opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#restartHandle = setTimer(() => {
      this.#restartHandle = null;
      if (this.wanted()) this.#startChild();
    }, RESTART_DELAY_MS);
    (this.#restartHandle as { unref?: () => void })?.unref?.();
  }

  /**
   * The picture is not coming. Say why, and leave the child alone.
   *
   * Deliberately NOT killing the stream child on a status frame: the helper
   * re-resolves its window set every 400ms, so a grant the user turns on while
   * this screen is up starts producing frames on its own and the surface swaps
   * back to pixels with nothing to restart. `#startChild` refuses to respawn
   * while the state is 'unavailable', so a child that actually DIED still stays
   * dead — which is the case this guard was written for.
   */
  #giveUp(reason: string): void {
    if (this.#stream === 'unavailable' && this.#streamError === reason) return;
    // F9: the calm state always gets on screen first. A child can spawn and die
    // inside a tick, and "Live view unavailable" arriving before "Connecting to
    // TextEdit" was ever shown reads as an app that did not even try.
    const wait = UNAVAILABLE_FLOOR_MS - (this.#now() - this.#calmSince);
    if (wait > 0) {
      this.#pendingGiveUp = reason;
      if (this.#giveUpHandle !== null) return;
      const setTimer = this.#opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      this.#giveUpHandle = setTimer(() => {
        this.#giveUpHandle = null;
        const held = this.#pendingGiveUp;
        this.#pendingGiveUp = null;
        if (held !== null && this.#session !== null) this.#applyGiveUp(held);
      }, wait);
      (this.#giveUpHandle as { unref?: () => void })?.unref?.();
      return;
    }
    this.#applyGiveUp(reason);
  }

  #applyGiveUp(reason: string): void {
    if (this.#stream === 'unavailable' && this.#streamError === reason) return;
    this.#stream = 'unavailable';
    this.#streamError = reason;
    this.#captureDenied = reason === MAC_CAPTURE_DENIED;
    this.#opts.log?.warn('mac monitor stream unavailable', { reason });
    this.reconcile();
    this.broadcastState();
  }

  #clearPendingGiveUp(): void {
    this.#pendingGiveUp = null;
    if (this.#giveUpHandle === null) return;
    const clearTimer = this.#opts.clearTimer ?? ((h) => clearTimeout(h as never));
    clearTimer(this.#giveUpHandle);
    this.#giveUpHandle = null;
  }

  #stopChild(): void {
    if (this.#restartHandle !== null) {
      const clearTimer = this.#opts.clearTimer ?? ((h) => clearTimeout(h as never));
      clearTimer(this.#restartHandle);
      this.#restartHandle = null;
    }
    const child = this.#child;
    this.#child = null;
    this.#parser.reset();
    if (child === null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    if (this.#stream !== 'unavailable') this.#stream = 'idle';
  }

  // ── wallpaper ──────────────────────────────────────────────────────────

  /**
   * Fetch + convert the desktop picture once. Concurrent callers JOIN the
   * in-flight promise rather than being told "already going" — otherwise a
   * caller that awaits this can return before the picture is actually there,
   * which is the kind of race that only ever shows up as a backdrop that is
   * sometimes missing.
   */
  ensureWallpaper(): Promise<void> {
    if (this.#wallpaper !== null) return Promise.resolve();
    if (this.#wallpaperPending !== null) return this.#wallpaperPending;
    const reader = this.#opts.wallpaperReader;
    if (reader === undefined) return Promise.resolve();
    const run = (async () => {
      try {
        const res = await reader();
        const source = typeof res?.path === 'string' ? res.path : '';
        if (source === '') return;
        const resolve = this.#opts.wallpaperResolver;
        const cached = resolve === undefined ? null : await resolve(source);
        if (cached === null) return;
        this.#wallpaper = { path: cached.source, url: cached.url };
        this.broadcastState();
      } catch {
        /* a backdrop is never worth an error the user has to read */
      } finally {
        this.#wallpaperPending = null;
      }
    })();
    this.#wallpaperPending = run;
    return run;
  }

  dispose(): void {
    this.#stopChild();
    this.#stopAx();
    this.#clearPendingGiveUp();
    this.#sinks.clear();
    this.#session = null;
    this.#wallpaper = null;
    this.#stream = 'idle';
    this.#axScene = null;
    this.#captureDenied = false;
    this.#lastSentJson = '';
    this.#sources = [];
    this.#sourcesKey = '';
    this.#source = 'none';
    this.#lastPictureAt = 0;
    this.#thinkingSince = null;
    this.#control = 'agent';
  }
}
