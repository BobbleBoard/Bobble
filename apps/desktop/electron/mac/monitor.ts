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
import { type IpcMainInvokeEvent, ipcMain, shell, type WebContents } from 'electron';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import type {
  MacMonitorAxScene,
  MacMonitorFramePayload,
  MacMonitorState,
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

const log = createLogger('desktop:mac-monitor');
const events = createIpcEventSender<AppEventMap>();

export type { AxReader, StreamChild, StreamSpawnFn, WallpaperReader } from './monitor-core';

/** Where macOS keeps the Screen Recording switch. Opening it is all any app can
 * do — the grant itself is deliberately unreachable from code. */
const SCREEN_RECORDING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

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
  log,
});

const sinks = new WeakMap<WebContents, WebContentsSink>();
let overlayAttached = false;

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
    core.setSession(pid, appName);
    log.info('mac monitor session', { pid, app: appName });
  },

  clearSession(): void {
    core.clearSession();
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
   * Two steps, and both are needed. `promptGrants` asks macOS to register this
   * app under Screen Recording (an app that has never tried to capture is not
   * in the list at all, so the pane opens on a switch that does not exist yet),
   * then the pane opens on it. The user does the toggling; no code can.
   */
  ipcMain.handle('mac:monitor:request-capture', async (event: IpcMainInvokeEvent) => {
    if (!isTrustedIpcEvent(event)) throw new Error('[mac-monitor] rejected request-capture');
    if (process.platform !== 'darwin') return { ok: false };
    await promptCaptureGrant?.().catch(() => undefined);
    try {
      await shell.openExternal(SCREEN_RECORDING_PANE);
      return { ok: true };
    } catch (err) {
      log.warn('could not open the Screen Recording pane', { error: String(err) });
      return { ok: false };
    }
  });
}

/** Injected by mac-agent.ts (which owns the helper): ask macOS to register this
 * app under the capture grants, so the pane has a switch to show. */
let promptCaptureGrant: (() => Promise<unknown>) | null = null;

export function setCaptureGrantPrompt(fn: () => Promise<unknown>): void {
  promptCaptureGrant = fn;
}
