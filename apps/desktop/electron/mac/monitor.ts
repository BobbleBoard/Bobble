/**
 * The Mac computer-use MONITOR — main's electron half of the live window stream.
 *
 * All of the deciding lives in `monitor-core.ts` (electron-free, unit-tested);
 * this is the wiring: the two renderer→main channels, the WebContents→sink
 * adapter, the real `pi-mac --stream` spawn, the overlay's published state, and
 * the wallpaper cache.
 *
 * `--stream` is Lane N of the round-21 contract and is built in parallel: a
 * helper that does not understand it exits immediately, which the core treats
 * as `stream:'unavailable'` after a bounded retry rather than a respawn loop.
 */
import { spawn } from 'node:child_process';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  shell,
  type WebContents,
} from 'electron';
import { isBackgroundMode } from '../background-mode';
import type { AppEventMap } from '../ipc-contract';
import { notifyDecision } from '../notify-gate';
import { isTrustedIpcEvent } from '../trusted-senders';
import {
  MAC_SCREEN_RECORDING_PANE,
  type MacMonitorAxScene,
  type MacMonitorControl,
  type MacMonitorFramePayload,
  type MacMonitorState,
} from './mac-monitor-contract';
import {
  type AxReader,
  MacMonitorCore,
  type MonitorSink,
  type StreamChild,
  type StreamSpawnFn,
  type WallpaperReader,
} from './monitor-core';
import { macOverlay } from './overlay-window';
import { cacheWallpaper } from './wallpaper';
import { capturableWindows, registerForScreenRecording, screenCaptureGrant } from './window-capture';

const log = createLogger('desktop:mac-monitor');
const events = createIpcEventSender<AppEventMap>();

export type { AxReader, StreamChild, StreamSpawnFn, WallpaperReader } from './monitor-core';

/** How often the published ages — "no new frames for 12s", "still thinking,
 * 32s" — are refreshed. One second, the resolution they are read at; the core's
 * identical-state dedupe swallows a tick that changed nothing. */
const HEARTBEAT_MS = 1_000;

/** One watching renderer. */
class WebContentsSink implements MonitorSink {
  frames: boolean;
  constructor(
    readonly wc: WebContents,
    frames: boolean,
  ) {
    this.frames = frames;
  }
  sendState(state: MacMonitorState): void {
    events.send(this.wc, 'mac:monitor:state', state);
  }
  sendFrame(frame: MacMonitorFramePayload): void {
    events.send(this.wc, 'mac:monitor:frame', frame);
  }
  sendAx(scene: MacMonitorAxScene): void {
    events.send(this.wc, 'mac:monitor:ax', scene);
  }
  isGone(): boolean {
    return this.wc.isDestroyed();
  }
}

let helperPath = '';

const core = new MacMonitorCore({
  spawn: (_pid, args) =>
    spawn(helperPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as StreamChild,
  wallpaperResolver: async (source) => {
    const cached = await cacheWallpaper(source);
    return cached === null ? null : { source: cached.source, url: cached.url };
  },
  // THE PREFERRED CAPTURE PATH. Chromium captures under the app's own identity,
  // so the Screen Recording switch the user finds under "Bobble" is the one
  // that decides whether the monitor can see. Absent the grant the core falls
  // back to the separately-signed helper, which may hold one of its own.
  captureGrant: screenCaptureGrant,
  sourceReader: capturableWindows,
  log,
});

const sinks = new WeakMap<WebContents, WebContentsSink>();
let overlayAttached = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * THE USER IS NOT IN BOBBLE WHILE THIS RUNS — that is the whole point of the
 * background guarantee, and the biggest hole it opens: the canvas tab is the
 * only place anything is said, and it is behind whatever they are doing.
 *
 * Two notifications close it, and no more than two: one when an app is taken
 * over, one when it is handed back. The gate is the app's own (notify-gate.ts)
 * — suppressed outright in test mode, and skipped when the window is focused,
 * because then the tab is already saying it.
 */
function notify(title: string, body: string): void {
  const decision = notifyDecision({
    backgroundMode: isBackgroundMode(),
    windowFocused: BrowserWindow.getFocusedWindow() !== null,
    supported: Notification.isSupported(),
  });
  if (!decision.shown) return;
  try {
    const n = new Notification({ title, body });
    n.on('click', () => {
      // The overlay window is non-focusable, so this can only ever find a real
      // app window.
      const target = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isFocusable());
      if (target === undefined) return;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    });
    n.show();
  } catch (err) {
    log.warn('mac monitor notification failed', { error: String(err) });
  }
}

function startHeartbeat(): void {
  if (heartbeat !== null) return;
  heartbeat = setInterval(() => core.tick(), HEARTBEAT_MS);
  heartbeat.unref?.();
}

function stopHeartbeat(): void {
  if (heartbeat === null) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

/** The app-wide monitor (one controlled app at a time — matching the single
 * long-lived pi-mac helper and the single cursor overlay). */
export const macMonitor = {
  setHelperPath(path: string): void {
    helperPath = path;
  },

  setWallpaperReader(reader: WallpaperReader): void {
    core.setWallpaperReader(reader);
  },

  /** Override how the capture child is created (the dev mock source). */
  setSpawnFn(fn: StreamSpawnFn): void {
    core.setSpawn(fn);
  },

  /** How the Accessibility fallback reads the controlled app. Injected from
   * mac-agent.ts, which owns the one long-lived `--serve` helper. */
  setAxReader(reader: AxReader): void {
    core.setAxReader(reader);
  },

  /** The reader currently installed, so the dev mock can answer for its own
   * synthetic app and hand every REAL pid straight through to the helper. */
  axReader(): AxReader | undefined {
    return core.axReader();
  },

  /** Mirror the overlay controller's published state into the monitor. The
   * cursor and the bubble MUST come from there — see monitor-core.ts. */
  attachOverlay(): void {
    if (overlayAttached) return;
    overlayAttached = true;
    core.setOverlayState(macOverlay.state());
    macOverlay.watch((state) => core.setOverlayState(state));
  },

  setSession(pid: number, appName: string): void {
    if (process.platform !== 'darwin') return;
    const had = core.state().active;
    core.setSession(pid, appName);
    startHeartbeat();
    if (!had) {
      const app = appName.trim() === '' ? 'an app' : appName.trim();
      notify(`Bobble is using ${app}`, 'Press Esc to stop.');
    }
    log.info('mac monitor session', { pid, app: appName });
  },

  clearSession(): void {
    const before = core.state();
    core.clearSession();
    stopHeartbeat();
    // The stand-down deserves a word too: a run that simply goes quiet leaves
    // the user unsure whether it finished or died, and that uncertainty is the
    // reason people stop trusting a background agent.
    if (before.active) {
      const app = before.appName.trim() === '' ? 'the app' : before.appName.trim();
      notify(`Bobble finished with ${app}`, 'It has stopped controlling it.');
    }
  },

  /** The brake and the wheel — see the contract's `mac:monitor:control`. */
  setControl(mode: MacMonitorControl): void {
    core.setControl(mode);
  },

  control(): MacMonitorControl {
    return core.control();
  },

  subscribe(wc: WebContents, frames: boolean): MacMonitorState {
    const existing = sinks.get(wc);
    if (existing !== undefined) {
      existing.frames = frames;
      // Re-adding is a no-op on the set but re-primes the first-push dedupe
      // and re-runs the capture gate for the new `frames` value.
      return core.addSink(existing);
    }
    const sink = new WebContentsSink(wc, frames);
    sinks.set(wc, sink);
    wc.once('destroyed', () => {
      core.removeSink(sink);
      sinks.delete(wc);
    });
    return core.addSink(sink);
  },

  unsubscribe(wc: WebContents): void {
    const sink = sinks.get(wc);
    if (sink === undefined) return;
    sinks.delete(wc);
    core.removeSink(sink);
  },

  state(): MacMonitorState {
    return core.state();
  },

  /** Diagnostics/tests: is a capture child running right now? */
  streaming(): boolean {
    return core.streaming();
  },

  /** Diagnostics/tests: is the Accessibility fallback polling right now? */
  polling(): boolean {
    return core.polling();
  },

  /** Diagnostics/tests: the last Accessibility scene published. */
  axScene(): ReturnType<typeof core.axScene> {
    return core.axScene();
  },

  dispose(): void {
    stopHeartbeat();
    core.dispose();
  },
};

/**
 * Register the two renderer→main channels. Called from registerMacAgentIpc,
 * which also injects the helper path and the wallpaper reader.
 */
export function registerMacMonitorIpc(): void {
  macMonitor.attachOverlay();
  ipcMain.handle(
    'mac:monitor:subscribe',
    (event: IpcMainInvokeEvent, req?: { frames?: boolean }) => {
      if (!isTrustedIpcEvent(event)) throw new Error('[mac-monitor] rejected subscribe');
      return { ok: true, state: macMonitor.subscribe(event.sender, req?.frames !== false) };
    },
  );
  ipcMain.handle('mac:monitor:unsubscribe', (event: IpcMainInvokeEvent) => {
    if (!isTrustedIpcEvent(event)) throw new Error('[mac-monitor] rejected unsubscribe');
    macMonitor.unsubscribe(event.sender);
    return { ok: true };
  });
  /**
   * "Turn it on" — which means OPEN THE PANE, and nothing else.
   *
   * Three steps, and all three are needed. An app that has never ATTEMPTED a
   * capture is not in the Screen Recording list at all, so the pane would open
   * on a switch that does not exist yet — and the entry that has to be there is
   * **Bobble's**, because Bobble is what captures now. So: ask Chromium for the
   * window list (refused, and the refusal is what registers this app), ask the
   * helper to register itself too (it is still the fallback), then open the
   * pane. The user does the toggling; no code can, by design.
   */
  ipcMain.handle('mac:monitor:request-capture', async (event: IpcMainInvokeEvent) => {
    if (!isTrustedIpcEvent(event)) throw new Error('[mac-monitor] rejected request-capture');
    if (process.platform !== 'darwin') return { ok: false };
    await registerForScreenRecording();
    await promptCaptureGrant?.().catch(() => undefined);
    try {
      await shell.openExternal(MAC_SCREEN_RECORDING_PANE);
      return { ok: true };
    } catch (err) {
      log.warn('could not open the Screen Recording pane', { error: String(err) });
      return { ok: false };
    }
  });
  /**
   * The brake, and the wheel. See the contract: a `stop` cannot be cleared by
   * anything the model does — only by the user asking for the agent back.
   */
  ipcMain.handle(
    'mac:monitor:control',
    (event: IpcMainInvokeEvent, req?: { mode?: MacMonitorControl }) => {
      if (!isTrustedIpcEvent(event)) throw new Error('[mac-monitor] rejected control');
      const mode = req?.mode;
      if (mode !== 'agent' && mode !== 'stopped' && mode !== 'user') {
        return { ok: false, control: macMonitor.control() };
      }
      macControl(mode);
      return { ok: true, control: macMonitor.control() };
    },
  );
}

/**
 * Everything that has to happen when control changes hands, in one place so the
 * three ways of asking — the surface's button, the overlay's own ✕, and the
 * global Esc — cannot drift apart. Injected by mac-agent.ts, which owns the
 * other half (the phantom, and refusing the model's acts).
 */
let controlHandler: (mode: MacMonitorControl) => void = (mode) => {
  macMonitor.setControl(mode);
};

export function setMacControlHandler(fn: (mode: MacMonitorControl) => void): void {
  controlHandler = fn;
}

export function macControl(mode: MacMonitorControl): void {
  controlHandler(mode);
}

/** Injected by mac-agent.ts (which owns the helper): ask macOS to register this
 * app under the capture grants, so the pane has a switch to show. */
let promptCaptureGrant: (() => Promise<unknown>) | null = null;

export function setCaptureGrantPrompt(fn: () => Promise<unknown>): void {
  promptCaptureGrant = fn;
}
