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
import { macOverlay } from './overlay-controller';
import { cacheWallpaper } from './wallpaper';
import {
  capturableWindows,
  registerForScreenRecording,
  screenCaptureGrant,
} from './window-capture';

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

  /**
   * Take the Electron capture path away — for the DEV MOCK only, which stubs
   * the helper and would otherwise be bypassed entirely on a machine where the
   * app does hold the grant (the preferred path never spawns a child at all).
   */
  disableElectronCapture(): void {
    core.disableElectronCapture();
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
    const before = core.state();
    core.setSession(pid, appName);
    startHeartbeat();
    // Once per app taken over, not once per snapshot — `setSession` is called
    // on every one of those. Switching apps mid-run IS worth saying again: it
    // is the user's own machine reaching into something else.
    if (!before.active || before.pid !== pid) {
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

  /** The user clicked the phantom's bubble: tell the renderer to show them the
   * monitor. Main has already brought the window forward. */
  reveal(): void {
    const pid = core.state().pid;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !win.isFocusable()) continue;
      events.send(win.webContents, 'mac:monitor:reveal', { pid });
    }
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
    /*
     * ASK FIRST, AND ONLY SEND THEM TO SETTINGS IF ASKING CANNOT WORK.
     *
     * This used to prompt AND open System Settings, every time — so the happy
     * path (macOS has never asked about this app; `CGRequestScreenCaptureAccess`
     * puts up one Allow/Deny alert) buried the alert under a Settings window the
     * user did not need. the user: "ideally those steps can just be 'click here and
     * click allow' if you can just prompt the user to one button allow/deny."
     *
     * So: prompt, read the answer, and open the pane only when the answer is no
     * — which is also the only case where the pane is the ONLY route, since the
     * system alert never appears twice for the same app.
     */
    const granted = await promptCaptureGrant?.()
      .then((r) => (r as { screenRecording?: boolean } | undefined)?.screenRecording === true)
      .catch(() => false);
    if (granted === true) {
      log.info('screen recording granted from the prompt');
      return { ok: true, granted: true };
    }
    try {
      await shell.openExternal(MAC_SCREEN_RECORDING_PANE);
      return { ok: true, granted: false };
    } catch (err) {
      log.warn('could not open the Screen Recording pane', { error: String(err) });
      return { ok: false, granted: false };
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

  /*
   * THE ONE THING HERE THAT IS MEANT TO TAKE THE SCREEN.
   *
   * the user: "have a prominent Open <app icon> <app name> <square with top right
   * arrow> prominently in the top right of the computer use canvas area."
   * Everything else in this subsystem works hard NOT to move the user's focus;
   * this exists because they asked to be put in front of the window they have
   * been watching. It can only run from that click — the model has no path to
   * this channel.
   */
  ipcMain.handle('mac:monitor:open-app', async (event: IpcMainInvokeEvent) => {
    if (!isTrustedIpcEvent(event)) throw new Error('[mac-monitor] rejected open-app');
    const app = macMonitor.state().appName;
    if (app === undefined || app === '') return { ok: false };
    try {
      await openControlledApp(app);
      return { ok: true, app };
    } catch {
      return { ok: false, app };
    }
  });
}

/** Raising the app is the mac-agent's job (it owns the helper); injected the
 * same way the control handler is, so this file keeps no helper of its own. */
let openControlledApp: (app: string) => Promise<void> = async () => {};

export function setMacOpenAppHandler(fn: (app: string) => Promise<void>): void {
  openControlledApp = fn;
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
