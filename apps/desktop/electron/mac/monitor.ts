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
import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import type { AppEventMap } from '../ipc-contract';
import { isTrustedIpcEvent } from '../trusted-senders';
import type { MacMonitorFramePayload, MacMonitorState } from './mac-monitor-contract';
import {
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

export type { StreamChild, StreamSpawnFn, WallpaperReader } from './monitor-core';

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
}
