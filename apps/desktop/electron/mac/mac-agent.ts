/**
 * Mac-agent bridge — the trusted seam that lets the @pi-desktop/mac-computer-use
 * extension (running inside the spawned pi child, a separate process) DRIVE any
 * Mac app through the `pi-mac` Accessibility + CGEvent helper.
 *
 * Transport: a local line-delimited JSON-RPC server on a Unix-domain socket
 * (@pi-desktop/mac-computer-use/protocol). The socket path + a random token are
 * published onto the env BEFORE the first pi spawn (like browser-agent.ts /
 * afm-main.ts), so the child's `MacAgentClient.fromEnv()` connects and every
 * request echoes the token. Requests run against a long-lived `pi-mac --serve`
 * helper.
 *
 * The load-bearing reason this lives in MAIN (not the pi child): posting
 * synthetic CGEvents + reading other apps' AX trees requires the Accessibility
 * (and Screen Recording) TCC grants, and those attribute to the SIGNED bundle
 * that spawns the helper. The pi child runs as ELECTRON_RUN_AS_NODE (an
 * effectively-unsigned exec path) whose grant would never stick; main is Pi
 * Desktop.app itself. So main owns the helper spawn — mirroring how
 * browser-agent.ts owns the WebContentsView.
 *
 * Nothing thrown here escapes to the child: request handlers translate failures
 * into `{ ok: false, error }` responses.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  MAC_AGENT_SOCK_ENV,
  MAC_AGENT_TOKEN_ENV,
  type MacActAck,
  type MacAgentMethod,
  type MacAgentRequest,
  type MacAgentResponse,
  type MacLaunchAck,
  type MacSnapshot,
  type MacTccStatus,
  type MacWindowBounds,
} from '@pi-desktop/mac-computer-use/protocol';
import { MacHelperClient } from '@pi-desktop/pi-mac';
import { createLogger } from '@pi-desktop/shared';
import { app, globalShortcut, ipcMain, screen, systemPreferences } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import { isBackgroundMode } from '../background-mode';
import { readSettings } from '../settings/settings-main';
import { isTrustedIpcEvent } from '../trusted-senders';
import { createAppIconSource } from './app-icon-source';
import { createDriverRegistry, type DriverId } from './drivers';
import { userLaunchEnv } from './launch-env';
import { installedAppIcon, listInstalledApps, sameApp } from './mac-apps';
import {
  macMonitor,
  registerMacMonitorIpc,
  setCaptureGrantPrompt,
  setMacControlHandler,
  setMacOpenAppHandler,
} from './monitor';
import { macMonitorMockControl, startMacMonitorMock } from './monitor-mock';
import { macOverlay } from './overlay-controller';
import type { OverlayRect } from './overlay-geometry';
import { aimAwayFromSelf, type FrontApp, refuseSelf } from './self-target';

const log = createLogger('desktop:mac-agent');
const execFileAsync = promisify(execFile);

/** Bobble's own process — the one that owns its windows (a dev build's too). */
const OWN_PIDS: readonly number[] = [process.pid];

/** The sessions driving right now, by bridge connection (see drivers.ts). */
const drivers = createDriverRegistry();
/** The e2e debug channel's requests, as one session of their own. */
const E2E_DRIVER: DriverId = Symbol('mac:debug');

/** No session drives any more: the phantom goes, the capture stops, and the
 *  brake — scoped to the runs it stopped — is released (clearSession). */
function endDriving(): void {
  macOverlay.hide();
  macMonitor.clearSession();
}

/** How long to let a freshly launched app settle before the model snapshots. */
const LAUNCH_SETTLE_MS = 600;
/** Launch waits for the opened app to HAVE A WINDOW (so the immediate
 * snapshot-after-open sees content, not a launch animation). */
const LAUNCH_WINDOW_TIMEOUT_MS = 8_000;
const LAUNCH_POLL_MS = 250;
/** TCC probe cache: the grant status can't change under us mid-session often
 * enough to justify a helper round-trip per launch. */
const TCC_CACHE_MS = 30_000;

let token = '';
let server: net.Server | null = null;
let helper: MacHelperClient | null = null;

/** index → element-centre cache per pid, refreshed on every snapshot response.
 * Lets the overlay GLIDE the phantom cursor to an element BEFORE the actual
 * click/type fires (browser-agent's moveCursor-then-act pattern); the ack's
 * echoed x,y covers stale/unknown indices afterwards. Snapshot bbox x,y are
 * element CENTRES (screen points) by the pi-mac wire contract. */
const elementCenters = new Map<number, Map<number, { x: number; y: number; name: string }>>();
/**
 * The controlled window's frame, from the last look at it.
 *
 * Cached rather than read live because it exists to make the phantom cursor
 * move BEFORE an act, and a helper round-trip to find out where to move would
 * put back exactly the delay it is there to remove. Every snapshot refreshes it.
 */
const windowFrames = new Map<number, { x: number; y: number; w: number; h: number }>();

/** Where a pointer would sit to scroll this app's content — the window's
 *  middle, biased below the toolbar so it is over content and not chrome. */
function scrollPoint(pid: number | null): { x: number; y: number } | null {
  const f = pid === null ? null : (windowFrames.get(pid) ?? null);
  if (f === null || !(f.w > 0) || !(f.h > 0)) return null;
  return { x: Math.round(f.x + f.w / 2), y: Math.round(f.y + f.h * 0.55) };
}
/** Windows already pulled fully on-screen this session — once each, so a window
 * the user moves afterwards is left where they put it. */
const nudgedPids = new Set<number>();

let tccCache: { at: number; status: MacTccStatus } | null = null;
/** PI_E2E-only: a synthetic window frame the overlay's real tracking loop reads
 * (via an injected bounds reader) so the deterministic probe can move the
 * "controlled window" with no TCC/real app and assert the overlay follows. */
let e2eFakeBounds:
  | (OverlayRect & {
      frontmost?: boolean;
      onScreen?: boolean;
      occluded?: boolean | null;
      occluders?: OverlayRect[];
    })
  | null = null;
/** The system permission dialogs are surfaced at most once per app session
 * (first mac_* use without the grants) — never nag. */
let promptedTcc = false;
/** The global Escape brake ignores presses until this moment — see the `key`
 * case: it is how our own injected Escape cannot stop our own run. */
let suppressEscUntil = 0;
const SELF_KEY_QUIET_MS = 400;
/** Whether the global Escape accelerator is currently held. */
let escArmed = false;

/**
 * Resolve the packaged `pi-mac` binary to a REAL on-disk path. Like pi-afm it is
 * a mach-o that must be spawned, so it is asarUnpack'd (electron-builder.yml);
 * the resolver points inside app.asar, which we rewrite to app.asar.unpacked so
 * the path exists for `spawn`/`execve`. In dev the resolver already yields the
 * SwiftPM build output.
 */
function resolveMacHelperPath(): string {
  const resolved = resolveBundledPackageAsset('pi-mac', 'swift/.build/release/pi-mac');
  if (!app.isPackaged) return resolved;
  return resolved.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
}

const HELPER_PATH = resolveMacHelperPath();

/** The on-device helper is Apple-silicon macOS only. */
function isSupportedPlatform(): boolean {
  return process.platform === 'darwin';
}

/** Lazily spawn the long-lived `pi-mac --serve` helper (kept alive so a
 * snapshot's index→element map survives into the acts that follow). */
function getHelper(): MacHelperClient {
  if (helper === null) helper = new MacHelperClient({ helperPath: HELPER_PATH });
  return helper;
}

/**
 * One request to the same long-lived helper, for the quick panel
 * (electron/quick): the app in front, its selected text, the windows on screen.
 * Sharing the one process keeps the panel's reads as fast as the agent's and
 * keeps the Accessibility grant attributed to one identity.
 */
export function macHelperRequest<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!isSupportedPlatform() || !existsSync(HELPER_PATH)) {
    return Promise.reject(new Error('the Mac helper is not available'));
  }
  return getHelper().request<T>(method, params);
}

/**
 * One app's real icon, cached per app, for the computer-use rows in the chat
 * (`mac:app-icon`). The running helper first, then the installed apps — see
 * app-icon-source.ts. Neither needs a permission.
 */
const appIcons = createAppIconSource({
  helperIcon: (app) =>
    getHelper().request<{ base64?: string; mimeType?: string }>('appIcon', { app, size: 64 }),
  installedIcon: (app) => installedAppIcon(HELPER_PATH, app),
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

async function tccStatus(): Promise<MacTccStatus> {
  if (tccCache !== null && Date.now() - tccCache.at < TCC_CACHE_MS) return tccCache.status;
  const status = await getHelper().request<MacTccStatus>('check');
  tccCache = { at: Date.now(), status };
  return status;
}

/** Read the target window's live frame via the helper (null = no window). */
async function readBounds(params: Record<string, unknown>): Promise<MacWindowBounds | null> {
  try {
    const b = await getHelper().request<MacWindowBounds>('bounds', params);
    return b.ok ? b : null;
  } catch {
    return null;
  }
}

function rectOf(b: MacWindowBounds): (OverlayRect & { windowId?: number }) | null {
  if (
    typeof b.x !== 'number' ||
    typeof b.y !== 'number' ||
    typeof b.w !== 'number' ||
    typeof b.h !== 'number'
  ) {
    return null;
  }
  /*
   * THE WINDOW NUMBER HAS TO TRAVEL WITH THE RECT.
   *
   * This returned x/y/w/h and dropped a windowId it was holding, so every
   * caller that goes through it — the launch ack and the monitor-session seam —
   * handed `control()` a target with no window number. `trackedWindow` then
   * stayed 0, and `refreshOcclusion` guards on `trackedWindow > 0`: no occluder
   * mask, and no off-desktop hiding either.
   *
   * The snapshot path never showed this because it passes `snap.windowId`
   * itself, a few lines below — which is why the layering the user signed off on
   * works as soon as the model looks at anything, and why this only bites in
   * the window between a launch and the first snapshot.
   */
  return {
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    ...(typeof b.windowId === 'number' ? { windowId: b.windowId } : {}),
  };
}

/**
 * The real name of a RUNNING app, given whatever the model called it.
 *
 * Exact match first, so nothing is reinterpreted when the model was already
 * right. Then a case-insensitive substring, which is the same rule the pi-mac
 * helper uses for `--app`, so `chrome` reaches "Google Chrome" from either side.
 * Returns null when nothing matches and the caller keeps the original name —
 * launching something not yet running still has to work.
 */
async function resolveRunningAppName(asked: string): Promise<string | null> {
  const want = asked.trim().toLowerCase();
  if (want === '') return null;
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'tell application "System Events" to get name of every process whose background only is false',
    ]);
    const names = stdout
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    const exact = names.find((n) => n.toLowerCase() === want);
    if (exact !== undefined) return exact;
    const partial = names.find((n) => n.toLowerCase().includes(want));
    return partial ?? null;
  } catch {
    return null;
  }
}

/** The app that currently has the screen, or null when we cannot tell. */
async function frontmostAppName(): Promise<string | null> {
  try {
    const r = await getHelper().request<{ app?: string }>('frontmost', {});
    return typeof r.app === 'string' && r.app !== '' ? r.app : null;
  } catch {
    return null;
  }
}

/**
 * Hand the screen back to whoever had it, if a background launch took it.
 *
 * Polled rather than done once: an app that activates itself does so a beat
 * AFTER `open` returns, so a single check right away sees the old frontmost and
 * concludes all is well. Bounded, and it never fights the user — if they have
 * moved to something else in the meantime, that is not ours to undo.
 */
/**
 * How long a launched app is watched for taking the front. It was 6 × 350 ms
 * — and Chrome's profile picker arrives after a cold start that takes longer
 * than that on its own, so the watch was over before the theft. The user, after
 * that fix had shipped: "chrome I know for sure … steal focus upon computer
 * use launch." Ten seconds covers a cold start; the loop leaves the moment the
 * user goes somewhere else themselves.
 */
const LAUNCH_FOCUS_WATCH_MS = 10_000;
const LAUNCH_FOCUS_POLL_MS = 250;

async function restoreFocusTo(previous: string, launched: string): Promise<void> {
  const until = Date.now() + LAUNCH_FOCUS_WATCH_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, LAUNCH_FOCUS_POLL_MS));
    const now = await frontmostAppName();
    if (now === null) return;
    const tookIt = sameApp(now, launched);
    // The user went to a third app themselves: not ours to undo.
    if (!tookIt && !sameApp(now, previous)) return;
    if (!tookIt) continue; // behaving (or given back) — keep watching
    try {
      await getHelper().request('focus', { app: previous });
    } catch {
      return;
    }
  }
}

/**
 * Launch an app in the BACKGROUND (`open -g -a NAME` — injection-safe, no
 * shell; the app opens without stealing focus) and WAIT until it has a real
 * window, so the tool's immediate snapshot-after-open sees content and the
 * resolved pid makes the app the session's controlled target. With the
 * Accessibility grant missing the window poll can never succeed, so it is
 * skipped (the launch still happens; perception degrades with a clear story).
 */
async function launchApp(name: string, background = true): Promise<MacLaunchAck> {
  const appName = name.trim();
  if (appName === '') return { ok: false, app: name, error: 'launch needs an app name' };
  /*
   * WHO HAD THE SCREEN BEFORE WE TOUCHED IT.
   *
   * `open -g` asks for a background launch, and that is a REQUEST, not a
   * guarantee: an app is free to activate itself on startup and some do.
   * MEASURED, on the user's machine, three runs in a row — Chrome's profile chooser
   * came up frontmost and stayed there for the whole run (519 of 519 focus
   * samples), while every one of them had asked for the background.
   *
   * So the promise is kept where it can actually be kept: remember the app that
   * had focus, and if the launch took it, give it back.
   */
  const hadFocus = background ? await frontmostAppName() : null;
  /*
   * `chrome` IS Google Chrome, and every other tool here already knows that.
   *
   * MEASURED, MiniCPM5 on the Chrome task: `open -a chrome` came back "Unable to
   * find application named 'chrome'" — macOS wants the exact bundle name — and
   * the run never recovered: it fell back to the app's OWN browser and
   * snapshotted about:blank thirty-five times. Three calls later `mac snapshot
   * --app chrome` resolved "Google Chrome" without trouble, because the helper
   * matches app names by substring. Two tools, one name, two answers.
   *
   * So the launch resolves the same way before asking macOS: if something is
   * already running whose name contains what was asked for, that IS the app.
   * Nothing is guessed when the exact name works — this only runs as a repair.
   */
  const resolved = await resolveRunningAppName(appName);
  const nameToOpen = resolved ?? appName;
  try {
    await execFileAsync('open', background ? ['-g', '-a', nameToOpen] : ['-a', nameToOpen], {
      env: userLaunchEnv(),
    });
  } catch (err) {
    if (!background) {
      // Foreground ask for an already-running app `open` couldn't match: a
      // plain activate. (Never used on the background path — no focus steal.)
      try {
        await getHelper().request('focus', { app: appName });
        return { ok: true, app: appName };
      } catch {
        /* fall through to the launch error */
      }
    }
    return { ok: false, app: appName, error: err instanceof Error ? err.message : String(err) };
  }

  if (hadFocus !== null) void restoreFocusTo(hadFocus, appName);

  let ax = false;
  try {
    ax = (await tccStatus()).accessibility;
  } catch {
    /* helper unavailable → skip the window poll */
  }
  if (!ax) {
    // First use without the grants: ask macOS to surface the permission
    // dialogs / register the app under Privacy & Security, so the user can
    // toggle instead of hunting for the right binary. Once per session.
    if (!promptedTcc) {
      promptedTcc = true;
      tccCache = null;
      try {
        await getHelper().request('promptGrants');
      } catch {
        /* helper unavailable — the check already degraded */
      }
    }
    await sleep(LAUNCH_SETTLE_MS);
    return { ok: true, app: appName };
  }

  const deadline = Date.now() + LAUNCH_WINDOW_TIMEOUT_MS;
  let bounds: MacWindowBounds | null = null;
  for (;;) {
    bounds = await readBounds({ app: appName });
    if (bounds !== null || Date.now() >= deadline) break;
    await sleep(LAUNCH_POLL_MS);
  }
  if (bounds === null) {
    // Opened but no window materialized (agent-style app / very slow launch).
    // Still a successful open; the tool degrades to a by-name snapshot.
    return { ok: true, app: appName };
  }
  // A name that resolved to Bobble itself (a dev build is "Electron"): never
  // nudged, never taken as the target.
  refuseSelf(bounds.pid, OWN_PIDS);
  // Let first-paint settle so the snapshot-after-open screenshot shows content.
  await sleep(LAUNCH_SETTLE_MS);
  bounds = (await nudgeOnScreen(bounds)) ?? bounds;
  return { ok: true, app: bounds.app ?? appName, pid: bounds.pid, bounds };
}

/**
 * PULL A WINDOW BACK ONTO THE SCREEN BEFORE DRIVING IT.
 *
 * MEASURED on the Maps runs: the window was 1024pt wide at x=641 on a 1512pt
 * display, so 153pt of it hung off the right edge — and macOS asks an app to
 * draw only what is on screen, so Maps left that strip blank. It reached the
 * model as a solid white band down the side of every screenshot for the whole
 * run, and the user watched it in every video.
 *
 * The picture is the smaller half of the problem: nothing in that strip can be
 * clicked either, because there is no screen there to click. A window we are
 * about to drive has to be somewhere it can be seen and hit.
 *
 * Only ever a nudge — the window keeps its size, and one that already fits is
 * left exactly where the user put it.
 */
async function nudgeOnScreen(bounds: MacWindowBounds): Promise<MacWindowBounds | null> {
  const { x: bx, y: by, w: bw, h: bh } = bounds;
  if (bx === undefined || by === undefined || bw === undefined || bh === undefined) return null;
  const area = displayContaining({ x: bx, y: by, w: bw, h: bh });
  if (area === null) return null;
  const x = Math.max(area.x, Math.min(bx, area.x + area.w - bw));
  const y = Math.max(area.y, Math.min(by, area.y + area.h - bh));
  if (Math.abs(x - bx) < 1 && Math.abs(y - by) < 1) return null;
  try {
    await getHelper().request('moveWindow', { pid: bounds.pid, x, y });
  } catch {
    return null; // a window that refuses to move is still worth driving
  }
  await sleep(LAUNCH_SETTLE_MS);
  return await readBounds({ pid: bounds.pid });
}

/** The visible frame of the display this window is mostly on, in the same
 * top-left screen points the helper reports. */
function displayContaining(b: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} | null {
  const displays = screen.getAllDisplays();
  const first = displays[0];
  if (first === undefined) return null;
  const overlap = (d: Electron.Display) => {
    const a = d.workArea;
    return (
      Math.max(0, Math.min(b.x + b.w, a.x + a.width) - Math.max(b.x, a.x)) *
      Math.max(0, Math.min(b.y + b.h, a.y + a.height) - Math.max(b.y, a.y))
    );
  };
  const best = displays.reduce((m, d) => (overlap(d) > overlap(m) ? d : m), first);
  const a = best.workArea;
  return { x: a.x, y: a.y, w: a.width, h: a.height };
}

// ── overlay choreography around helper acts ─────────────────────────────────

function centerOf(params: Record<string, unknown>): { x: number; y: number } | null {
  const pid = typeof params.pid === 'number' ? params.pid : null;
  const index = typeof params.index === 'number' ? params.index : null;
  if (pid === null || index === null) return null;
  return elementCenters.get(pid)?.get(index) ?? null;
}

function cacheSnapshot(snap: MacSnapshot): void {
  if (typeof snap.pid !== 'number') return;
  const map = new Map<number, { x: number; y: number; name: string }>();
  for (const el of snap.elements ?? []) {
    if (el?.bbox !== undefined) {
      // The NAME travels with the centre: it is what turns "Clicking" into
      // "Clicking Save", and the snapshot that produced the index already had it.
      map.set(el.index, { x: el.bbox.x, y: el.bbox.y, name: el.name ?? '' });
    }
  }
  elementCenters.set(snap.pid, map);
  const wb = snap.windowBounds;
  if (wb !== undefined) windowFrames.set(snap.pid, { x: wb.x, y: wb.y, w: wb.w, h: wb.h });
}

/** The name of the control an act names by index, when a look has seen it. */
function nameOf(params: Record<string, unknown>): string {
  const pid = typeof params.pid === 'number' ? params.pid : null;
  const index = typeof params.index === 'number' ? params.index : null;
  if (pid === null || index === null) return '';
  return elementCenters.get(pid)?.get(index)?.name ?? '';
}

async function snapshotWithOverlay(params: Record<string, unknown>): Promise<MacSnapshot> {
  // Name the moment: a snapshot is the agent READING the user's screen, and
  // that is the one thing a bubble saying "Thinking" was actively wrong about.
  await macOverlay.reading();
  const snap = await getHelper().request<MacSnapshot>('snapshot', params);
  // A named look that resolved to Bobble: refused before it is cached, nudged,
  // followed by the overlay, or read by the model (see self-target.ts).
  refuseSelf(snap.pid, OWN_PIDS);
  cacheSnapshot(snap);
  if (typeof snap.pid === 'number') {
    /*
     * AND AN APP WE TAKE OVER, not only one we launched.
     *
     * The nudge lived on the launch path alone, so a window that was ALREADY
     * open when the model took control of it kept whatever position it had —
     * MEASURED, reproduced while photographing the monitor: Maps hanging 153pt
     * off the right edge, the white unrendered strip back, and that strip
     * unclickable. Once per pid, so a window the user deliberately moves later
     * is left where they put it rather than being dragged back every snapshot.
     */
    if (!nudgedPids.has(snap.pid)) {
      nudgedPids.add(snap.pid);
      const wb = snap.windowBounds;
      if (wb !== undefined) {
        void nudgeOnScreen({ ...wb, pid: snap.pid } as MacWindowBounds);
      }
    }
    const wb = snap.windowBounds;
    /* The window NUMBER travels with the rect: the panel pins itself directly
       above that window, which is the layering (see pinAbove). */
    await macOverlay.control(
      snap.pid,
      wb
        ? {
            x: wb.x,
            y: wb.y,
            w: wb.w,
            h: wb.h,
            ...(typeof snap.windowId === 'number' ? { windowId: snap.windowId } : {}),
          }
        : null,
    );
    // The monitor tab follows the SAME target the overlay just took (one
    // controlled app at a time); the app name is what titles the tab.
    macMonitor.setSession(snap.pid, String(snap.app ?? params.app ?? ''));
    await macOverlay.thinking();
  }
  return snap;
}

/** Click: glide the phantom cursor to the target BEFORE the act (element
 * centre from the last snapshot, or the explicit x,y), fire, then press at
 * the point the helper actually acted on. */
async function clickWithOverlay(params: Record<string, unknown>): Promise<MacActAck> {
  const known =
    typeof params.x === 'number' && typeof params.y === 'number'
      ? { x: params.x, y: params.y }
      : centerOf(params);
  if (known !== null) await macOverlay.moveCursor(known.x, known.y);
  const ack = await getHelper().request<MacActAck>('click', params);
  if (ack.found) {
    const at = typeof ack.x === 'number' && typeof ack.y === 'number' ? ack : known;
    if (at !== null && typeof at.x === 'number' && typeof at.y === 'number') {
      await macOverlay.clickAt(at.x, at.y, nameOf(params));
    }
  }
  return ack;
}

async function typeWithOverlay(params: Record<string, unknown>): Promise<MacActAck> {
  const known = centerOf(params);
  if (known !== null) await macOverlay.moveCursor(known.x, known.y);
  await macOverlay.typing(String(params.text ?? ''));
  const ack = await getHelper().request<MacActAck>('type', params);
  if (ack.found && typeof ack.x === 'number' && typeof ack.y === 'number' && known === null) {
    await macOverlay.moveCursor(ack.x, ack.y);
  }
  await macOverlay.thinking();
  return ack;
}

/**
 * WHAT "STOP" MEANS, one layer below the UI.
 *
 * A brake that only hides a cursor is not a brake. When the user stops the run
 * — from the surface, from the ✕ on the overlay's own bubble, or with the
 * global Escape — the agent's hands come off the Mac here: every act and every
 * LOOK is refused until the user asks for the agent back. Nothing the model
 * does can clear it, which is the entire point; a model that could talk its way
 * past the stop button would make the button a decoration.
 *
 * Take-over is the same cut with a different sentence, and it carries the
 * promise that makes handing the keyboard over safe: while the user is driving,
 * nothing is captured and nothing is read.
 */
function controlRefusal(method: MacAgentMethod): string | null {
  if (method === 'check' || method === 'setDriving' || method === 'policy' || method === 'brake') {
    return null;
  }
  return brakeRefusal();
}

/** The sentence every act and look is refused with while the user holds the
 * brake — null while the agent has the wheel. */
function brakeRefusal(): string | null {
  const control = macMonitor.control();
  if (control === 'agent') return null;
  const app = macMonitor.state().appName.trim();
  const named = app === '' ? 'the app' : app;
  if (control === 'user') {
    return `The user has taken over ${named}. Bobble is not watching or acting while they drive — do not retry; wait for them to hand it back, and ask before touching ${named} again.`;
  }
  return `The user pressed Stop, so Mac control is off. Do not retry: say what you had done to ${named} and ask whether to carry on.`;
}

async function dispatch(
  method: MacAgentMethod,
  requested: Record<string, unknown>,
  who: DriverId,
): Promise<unknown> {
  if (!isSupportedPlatform()) throw new Error('mac computer-use is macOS-only');
  const refusal = controlRefusal(method);
  if (refusal !== null) throw new Error(refusal);
  // Before any await: lines on one connection are handled concurrently, and
  // this session's own `driving:false` must not overtake its registration.
  drivers.noteRequest(who, method);
  // A request that names no app goes to the front app that is NOT Bobble —
  // resolved and stamped here, before the helper can pick Bobble itself.
  const { behindBobble, ...params } = await aimAwayFromSelf(method, requested, {
    ownPids: OWN_PIDS,
    frontmost: (excludePids) =>
      getHelper().request<FrontApp>('frontmost', { excludePids: [...excludePids] }),
  });
  switch (method) {
    case 'check':
      return getHelper().request('check');
    case 'snapshot': {
      const snap = await snapshotWithOverlay(params);
      // Bobble was in front and skipped: the look's header says so.
      return behindBobble === true ? { ...snap, behindBobble: true } : snap;
    }
    case 'click':
      return clickWithOverlay(params);
    case 'type':
      return typeWithOverlay(params);
    case 'key': {
      // OUR OWN Escape must not press the user's brake. The global hotkey is
      // deliberately deaf for a beat around every key we inject, which is also
      // the guard against screen content talking the model into "press Escape"
      // to dismiss the one control the user has.
      suppressEscUntil = Date.now() + SELF_KEY_QUIET_MS;
      await macOverlay.keyPress(String(params.combo ?? params.key ?? ''));
      return getHelper().request('key', params);
    }
    case 'scroll': {
      /*
       * PUT THE POINTER WHERE THE SCROLLING IS HAPPENING, FIRST.
       *
       * The user: "move the cursor/scroll more proactively so that there's not delay
       * between the action being executed and the fake cursor moving around."
       * Click and type already glide the cursor to their target before firing;
       * scroll only changed the pill's text, so the content moved while the
       * phantom sat wherever the last click had left it — which reads as the
       * page moving by itself.
       *
       * A scroll names no element, so the point is the one a person's pointer
       * would be at: the middle of the window, a little below centre so it is
       * over content rather than the toolbar. From the cached frame, so this
       * costs no round-trip — the delay is the thing being removed.
       */
      const at = scrollPoint(typeof params.pid === 'number' ? params.pid : null);
      if (at !== null) await macOverlay.moveCursor(at.x, at.y);
      await macOverlay.scrolling();
      return getHelper().request('scroll', params);
    }
    // The menu bar. Accessibility presses the item directly, so no menu opens
    // on screen and the app stays in the background — there is no point to
    // animate the phantom cursor to, so the bubble just says what was pressed.
    case 'menuClick': {
      const ack = (await getHelper().request('menuClick', params)) as { listed?: boolean };
      if (ack.listed !== true) await macOverlay.thinking();
      return ack;
    }
    /* The window AROUND the page — see MAC_TABS_TOOL. Listing and switching are
       background; opening and closing take the user's screen and say so in the
       helper's own answer. */
    case 'tabs':
      return getHelper().request('tabs', params);
    case 'tabSelect':
    case 'tabNew':
    case 'tabClose': {
      const ack = await getHelper().request(method, params);
      await macOverlay.thinking();
      return ack;
    }
    case 'windows':
      return getHelper().request('windows', params);
    case 'screenshot':
      return getHelper().request('screenshot', params);
    case 'bounds':
      return getHelper().request('bounds', params);
    case 'frontmost':
      return getHelper().request('frontmost', params);
    case 'launch': {
      const ack = await launchApp(String(params.app ?? ''), params.background !== false);
      if (ack.ok && typeof ack.pid === 'number' && ack.bounds !== undefined) {
        await macOverlay.control(ack.pid, rectOf(ack.bounds));
        macMonitor.setSession(ack.pid, ack.app);
        await macOverlay.opening(ack.app);
      }
      return ack;
    }
    // The overlay follows the controlled app; an explicit driving=false from
    // the extension (its turn ended) puts it away — once the LAST session
    // driving has said so. One session's end used to tear down another's run
    // and lift the Stop the user had pressed on it (drivers.ts).
    case 'setDriving': {
      if (params.driving === false && drivers.end(who)) endDriving();
      return { ok: true };
    }
    // The person's standing answer (Settings → Computer use), read fresh on
    // every gate so a change applies to the next action — see policy.ts.
    case 'policy':
      return computerUsePolicy();
    // The Chrome DOM route acts over Apple Events, which never passes through
    // here — so it asks first, and hears the sentence any other act would.
    case 'brake':
      return { refusal: brakeRefusal() };
    default:
      throw new Error(`unknown method: ${String(method)}`);
  }
}

// ── socket server (mirror browser-agent.ts) ──────────────────────────────────

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-mac-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
}

function handleConnection(socket: net.Socket): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {
    /* a peer reset must never crash main */
  });
  // Its session's process died mid-run (a chat deleted, a child killed): no
  // `driving:false` will ever come, so the connection's end is its turn's end.
  socket.on('close', () => {
    if (drivers.gone(socket)) endDriving();
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== '') void handleLine(socket, line);
      nl = buffer.indexOf('\n');
    }
  });
}

async function handleLine(socket: net.Socket, line: string): Promise<void> {
  let req: MacAgentRequest;
  try {
    req = JSON.parse(line) as MacAgentRequest;
  } catch {
    return;
  }
  if (typeof req.id !== 'number') return;
  const respond = (patch: Partial<MacAgentResponse>): void => {
    try {
      socket.write(`${JSON.stringify({ id: req.id, ok: true, ...patch })}\n`);
    } catch {
      /* peer gone */
    }
  };
  if (req.token !== token) {
    respond({ ok: false, error: 'unauthorized' });
    return;
  }
  try {
    const result = await dispatch(req.method, req.params ?? {}, socket);
    respond({ ok: true, result });
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function startServer(): void {
  const socketPath = process.env[MAC_AGENT_SOCK_ENV] ?? defaultSocketPath();
  token = process.env[MAC_AGENT_TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket; listen() will surface a real problem */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('mac-agent bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('mac-agent bridge listening', { socketPath }));
  // Publish for the pi child spawned later (env is read at spawn time).
  process.env[MAC_AGENT_SOCK_ENV] = socketPath;
  process.env[MAC_AGENT_TOKEN_ENV] = token;
}

/**
 * Control changing hands, in ONE place.
 *
 * The three ways of asking — the surface's button, the ✕ on the overlay's
 * bubble, and the global Escape — must not be able to do three different
 * things. Stopping takes the phantom off the screen and the capture off the
 * GPU immediately; the refusal that keeps the agent's hands off lives in
 * `controlRefusal`, and it outlives this call.
 */
function applyControl(mode: 'agent' | 'stopped' | 'user'): void {
  macMonitor.setControl(mode);
  if (mode === 'agent') return;
  // The phantom is a promise that something is being driven. Nothing is.
  macOverlay.hide();
}

/**
 * THE USER'S NEXT MESSAGE IS THE HAND-BACK.
 *
 * The brake latched past the turn it stopped. `clearSession` releases it, but
 * the overlay only clears a session while control is 'agent' (monitor-core),
 * so a Stop — the surface button, the bubble's ✕, or the global Escape, which
 * fires for ANY Escape pressed anywhere while an app is being driven — left
 * 'stopped' standing until the app quit. MEASURED in two sessions (09-13
 * Notes, 09-14 Chrome): a fresh chat's first `mac launch` answered "The user
 * pressed Stop, so Mac control is off … ask whether to carry on", the model
 * asked, and the user's "carry on" changed nothing, because nothing the
 * model does can clear it. The user: "despite it executing some command itself
 * [the thought is] 'The user closed <thing>' … it thinks since the user
 * closed something it should stop."
 *
 * The refusal itself says what releases it: the user asking again. A new
 * prompt from the person is exactly that — for a stop AND for a take-over —
 * and they keep Stop for the run it starts.
 */
export function releaseMacBrake(): void {
  if (macMonitor.control() === 'agent') return;
  log.info("mac computer-use: brake released by the user's next message");
  applyControl('agent');
}

/**
 * A BRAKE THE USER CAN REACH WITHOUT BEING IN BOBBLE.
 *
 * The whole feature runs while the user is somewhere else, so the stop has to
 * exist somewhere else too. Escape is the convention (it is what Claude Code
 * uses for the same job) and registering it globally CONSUMES it, which is the
 * property that matters: a page or a document that tells the model to "press
 * Escape" cannot use the user's own brake against them, because our injected
 * keys are ignored for a beat either side (see the `key` case).
 *
 * Never armed in test mode: eating the Escape key of whoever is using this
 * machine is exactly the kind of "taking notice" a probe must not do.
 */
function armEscBrake(on: boolean): void {
  if (process.platform !== 'darwin' || isBackgroundMode()) return;
  if (on === escArmed) return;
  try {
    if (on) {
      escArmed = globalShortcut.register('Escape', () => {
        if (Date.now() < suppressEscUntil) return; // our own keystroke
        log.info('mac computer-use stopped by the global Escape');
        applyControl('stopped');
      });
      if (!escArmed) log.warn('could not register the global Escape brake');
      return;
    }
    globalShortcut.unregister('Escape');
    escArmed = false;
  } catch (err) {
    log.warn('global Escape brake failed', { error: String(err) });
    escArmed = false;
  }
}

/**
 * Stand up the mac-agent bridge socket (publishing its env for the pi child) and
 * point the helper at the resolved `pi-mac` binary. Called from main.ts's
 * registerAppIpc on app-ready, BEFORE the first pi spawn, so PI_MAC_SOCK/_TOKEN
 * are present when the child's MacAgentClient.fromEnv() runs. No-op off macOS
 * (the tools still register but the bridge just reports "macOS-only").
 *
 * Also arms the cursor overlay (its window tracker reads bounds through the
 * helper), wires the USER'S BRAKE to its three buttons — the surface's Stop,
 * the ✕ on the overlay's own bubble, and the global Escape — and, under
 * PI_E2E=1 only, a renderer-reachable debug channel the probes use
 * (tests/e2e/mac-overlay-probe.mjs / mac-brake-probe.mjs).
 */
/** The standing policy as the bridge hands it to the consent gate. */
function computerUsePolicy(): { enabled: boolean; apps: { id: string; name: string }[] } {
  const cu = readSettings().computerUse;
  return { enabled: cu.enabled, apps: cu.apps.map((a) => ({ id: a.id, name: a.name })) };
}

export function registerMacAgentIpc(): void {
  startServer();
  // The installed apps with their real icons, for the computer-use chooser.
  ipcMain.handle('mac:list-apps', async (event, req: { refresh?: boolean } | undefined) => {
    if (!isTrustedIpcEvent(event)) throw new Error('[mac-agent] rejected mac:list-apps');
    if (!isSupportedPlatform() || !existsSync(HELPER_PATH)) return { apps: [] };
    return { apps: await listInstalledApps(HELPER_PATH, req?.refresh === true) };
  });
  // One app's real icon, for the computer-use rows in the chat (src/chat/app-icons.ts).
  ipcMain.handle('mac:app-icon', async (event, req: { app?: unknown } | undefined) => {
    if (!isTrustedIpcEvent(event)) throw new Error('[mac-agent] rejected mac:app-icon');
    if (!isSupportedPlatform() || !existsSync(HELPER_PATH)) return { icon: null };
    return { icon: await appIcons(typeof req?.app === 'string' ? req.app : '') };
  });
  // The overlay is a SECOND pi-mac process (`--overlay`) — same binary, same
  // wire format, its own NSApplication runloop — so it needs the same resolved
  // path the `--serve` bridge uses.
  macOverlay.setHelperPath(HELPER_PATH);
  macOverlay.setBoundsReader(async (pid) => {
    const b = await readBounds({ pid });
    if (b === null) return null;
    const rect = rectOf(b);
    // Thread the visibility-rule inputs alongside the frame: `frontmost`
    // ("user is looking at the controlled app"), `onScreen` (current space),
    // `occluded` (CGWindowList z-order truth — another app's window covers the
    // controlled one, so the phantom must not paint over it) and `occluders`
    // (WHICH rects those are — the native overlay masks them out, which is the
    // per-window version of the same rule).
    if (rect === null) return null;
    const extras = b as unknown as {
      onScreen?: boolean;
      occluded?: boolean;
      occluders?: OverlayRect[];
    };
    return {
      ...rect,
      frontmost: b.frontmost === true,
      onScreen: typeof extras.onScreen === 'boolean' ? extras.onScreen : undefined,
      occluded: typeof extras.occluded === 'boolean' ? extras.occluded : null,
      // The rects themselves, so the phantom can ask whether anything is over
      // the exact point it is about to draw on — see OverlayRect.occluders.
      occluders: Array.isArray(extras.occluders) ? extras.occluders : [],
    };
  });
  // The computer-use MONITOR (round-21 Lane A): the canvas tab that live-
  // streams the controlled window. It owns its own `pi-mac --stream` child, so
  // it needs the resolved helper path; the `wallpaper` method goes through the
  // one long-lived --serve helper this module owns (never a second pipe).
  macMonitor.setHelperPath(HELPER_PATH);
  macMonitor.setWallpaperReader(async () => {
    try {
      return await getHelper().request<{ ok: boolean; path?: string }>('wallpaper');
    } catch {
      // Older helper without the `wallpaper` method: fall back to the standard
      // macOS default picture, which is present on every install.
      return existsSync(FALLBACK_WALLPAPER) ? { path: FALLBACK_WALLPAPER } : null;
    }
  });
  /*
   * The ACCESSIBILITY fallback's eyes.
   *
   * Screen Recording is a grant the app may simply not have — on a fresh Mac it
   * never does — while Accessibility is the one computer-use cannot work
   * without at all. So when the pixels do not come, the monitor draws the same
   * window from the same tree the model itself is acting on. It goes through
   * THIS module's single long-lived helper (never a second pipe), and
   * deliberately not through `snapshotWithOverlay`: a poll four times a second
   * must not re-target the overlay, re-open the session, or overwrite the
   * index→element map the model's own last snapshot left behind.
   */
  macMonitor.setAxReader(async (pid, cap) => {
    try {
      return await getHelper().request<MacSnapshot>('snapshot', { pid, cap });
    } catch {
      return null;
    }
  });
  setCaptureGrantPrompt(async () => {
    tccCache = null;
    return getHelper().request('promptGrants');
  });
  /*
   * The brake, wired to its buttons (see applyControl) and to the global Escape
   * below.
   *
   * It used to be wired to the overlay's own ✕ as well. The phantom is now a
   * native panel that is click-through end to end, so there is no ✕ to click and
   * `setBrake` no longer exists — MEASURED, calling it threw during startup and
   * the app's window never opened. What is lost is the one control that existed
   * while the user was in another app; Escape still brakes, and the surface's
   * own button still does. A hit-testable control would need a second, tiny
   * panel that is click-through except for its button rect.
   */
  setMacControlHandler(applyControl);
  /* The Open button on the monitor surface — the one deliberate focus change in
     this subsystem, and only ever from a click. `focus` activates a RUNNING app
     without launching anything. */
  setMacOpenAppHandler(async (app) => {
    await getHelper().request('focus', { app });
  });
  /*
   * The pill's own buttons. The user asked for them back — an ✕, a pause and a
   * hide, on the one surface that exists while the user is in another app
   * watching the thing being driven. They route to the SAME brake as the
   * surface's buttons and the global Escape; there is still only one.
   */
  macOverlay.onBrake((action) => {
    if (action === 'stop') applyControl('stopped');
    else if (action === 'pause') applyControl('user');
  });
  // An app being driven is exactly when the global Escape brake should exist,
  // and the overlay's own engagement is the app's single truth for that.
  macOverlay.watch((state) => armEscBrake(state.engaged));
  registerMacMonitorIpc();
  startMacMonitorMock();
  if (process.env.PI_E2E === '1') registerE2eDebugChannel();
  log.info('mac-agent helper path', { helperPath: HELPER_PATH, packaged: app.isPackaged });
}

/** Shipped on every macOS 14+ install; the honest last resort when the helper
 * cannot report the user's own desktop picture. */
const FALLBACK_WALLPAPER = '/System/Library/CoreServices/DefaultDesktop.heic';

/**
 * PI_E2E-only introspection/driving channel. Two op families:
 *   - helper passthrough (check/frontmost/bounds/snapshot/screenshot): the
 *     probes' TCC reality-check + no-focus-steal assertions;
 *   - overlay-* ops: deterministic overlay driving with NO real app involved,
 *     so the overlay probe can screenshot every cursor/bubble state.
 * Trusted-sender-gated like every other channel; never registered outside E2E.
 */
/** One synthetic bounds sample from probe params — the shape the overlay's real
 * tracking loop reads, including the occluder rects the native mask is built
 * from. PI_E2E only. */
function fakeSample(params: Record<string, unknown>): NonNullable<typeof e2eFakeBounds> {
  return {
    x: Number(params.x ?? 0),
    y: Number(params.y ?? 0),
    w: Number(params.w ?? 600),
    h: Number(params.h ?? 400),
    frontmost: params.frontmost !== false,
    onScreen: params.onScreen !== false,
    occluded: typeof params.occluded === 'boolean' ? params.occluded : null,
    occluders: Array.isArray(params.occluders) ? (params.occluders as OverlayRect[]) : undefined,
  };
}

function registerE2eDebugChannel(): void {
  ipcMain.handle(
    'mac:debug',
    async (event, req: { op: string; params?: Record<string, unknown> }) => {
      if (!isTrustedIpcEvent(event)) throw new Error('[mac-agent] rejected mac:debug');
      const params = req.params ?? {};
      try {
        switch (req.op) {
          /*
           * THE SAME PATH THE MODEL TAKES.
           *
           * These ops used to call the helper directly, side-stepping
           * `dispatch` — so a probe drove the app while the overlay never
           * engaged and the monitor never got a session. Every probe was
           * therefore verifying something the product does not do, and a
           * recorded run showed an empty chat. Anything `dispatch` handles now
           * goes through `dispatch`.
           */
          case 'check':
          case 'frontmost':
          case 'bounds':
          case 'snapshot':
          case 'screenshot':
          case 'click':
          case 'type':
          case 'key':
          case 'scroll':
          case 'launch':
          case 'menuClick':
          case 'tabs':
          case 'tabSelect':
          case 'tabNew':
          case 'tabClose':
          case 'windows':
          case 'setDriving':
            return {
              ok: true,
              result: await dispatch(req.op as MacAgentMethod, params, E2E_DRIVER),
            };
          // Helper-only reads and the recorder, which `dispatch` has no part in.
          case 'promptGrants':
          case 'moveWindow':
          case 'wallpaper':
          case 'menus':
          case 'recordStart':
          case 'recordStop':
            return { ok: true, result: await getHelper().request(req.op, params) };
          case 'overlay-show': {
            await macOverlay.debugShow({
              x: Number(params.x ?? 0),
              y: Number(params.y ?? 0),
              w: Number(params.w ?? 600),
              h: Number(params.h ?? 400),
            });
            return { ok: true };
          }
          case 'overlay-cursor': {
            await macOverlay.moveCursor(Number(params.x ?? 0), Number(params.y ?? 0));
            return { ok: true };
          }
          case 'overlay-click': {
            await macOverlay.moveCursor(Number(params.x ?? 0), Number(params.y ?? 0));
            await macOverlay.clickAt(Number(params.x ?? 0), Number(params.y ?? 0));
            return { ok: true };
          }
          case 'overlay-typing': {
            await macOverlay.typing(String(params.text ?? ''));
            return { ok: true };
          }
          case 'overlay-key': {
            await macOverlay.keyPress(String(params.combo ?? 'cmd+s'));
            return { ok: true };
          }
          case 'overlay-status': {
            if (params.status === 'opening') await macOverlay.opening(String(params.text ?? ''));
            else if (params.status === 'scrolling') await macOverlay.scrolling();
            else if (params.status === 'reading') await macOverlay.reading();
            else await macOverlay.thinking();
            return { ok: true };
          }
          /*
           * WHO IS macOS ACTUALLY ANSWERING?
           *
           * The app and the pi-mac helper are separate binaries with separate
           * code-signing identities, and TCC answers per CLIENT — so "is
           * Accessibility granted" has two answers and they can disagree. That
           * disagreement is exactly what made a granted machine look ungranted:
           * the helper said no while System Settings showed the app switched on.
           * This reports both, plus the identities, so the question can be
           * settled by reading rather than by theory.
           */
          case 'grants': {
            const helper = await getHelper().request<Record<string, unknown>>('check');
            return {
              ok: true,
              result: {
                app: {
                  accessibility: systemPreferences.isTrustedAccessibilityClient(false),
                  screen: systemPreferences.getMediaAccessStatus('screen'),
                  path: app.getPath('exe'),
                },
                helper: { ...helper, path: HELPER_PATH },
              },
            };
          }
          case 'overlay-info':
            return { ok: true, result: macOverlay.info() };
          // The brake, from a probe. Same entry point as the surface's button,
          // the overlay's ✕ and the global Escape — there is only one.
          case 'mac-control': {
            const mode = String(params.mode ?? '');
            if (mode !== 'agent' && mode !== 'stopped' && mode !== 'user') {
              return { ok: false, error: `unknown control mode: ${mode}` };
            }
            applyControl(mode);
            return { ok: true, result: { control: macMonitor.control() } };
          }
          // The computer-use MONITOR's own truth, read-only. A probe cannot use
          // `mac:monitor:subscribe` to look: there is one sink per renderer, so
          // asking for state would DOWNGRADE the surface's frame subscription
          // and stop the very capture it was checking on.
          // Dev frame source only (PI_MAC_MONITOR_MOCK=1): drive the states a
          // running stream never sits still in — "no window", "no frame yet".
          case 'monitor-mock': {
            macMonitorMockControl({
              windows: typeof params.windows === 'boolean' ? params.windows : undefined,
              restart: params.restart === true,
              delayMs: typeof params.delayMs === 'number' ? params.delayMs : undefined,
              deny: typeof params.deny === 'boolean' ? params.deny : undefined,
            });
            return { ok: true };
          }
          // Point the monitor at a REAL app the probe already launched, and put
          // the overlay on it — the two things `snapshot`/`launch` do for the
          // model, which the debug channel's passthrough deliberately does not.
          // Without this a probe cannot look at the monitor drawing a real
          // window at all: it can drive TextEdit and it can read the surface,
          // but nothing joins them.
          /* A window move, done by the process that HAS the Accessibility
             grant. The user: "if I move the map around the cursor does not move
             with it" — reproducing that needs a real move, and a probe's own
             shell cannot make one (System Events refuses without the grant). */
          /* The helper's raw `appIcon` answer, for probes. The chat's rows ask
             through `mac:app-icon`, which also knows apps that are not running
             and caches per app (app-icon-source.ts). */
          case 'app-icon': {
            const res = await getHelper().request<{ base64?: string; mimeType?: string }>(
              'appIcon',
              {
                app: String(params.app ?? ''),
                ...(params.pid === undefined ? {} : { pid: params.pid }),
              },
            );
            return { ok: true, result: res };
          }
          case 'move-window': {
            const pid = Number(params.pid ?? 0);
            const x = Number(params.x ?? 0);
            const y = Number(params.y ?? 0);
            if (!Number.isFinite(pid) || pid <= 0) return { ok: false, error: 'needs a pid' };
            const res = await getHelper().request('moveWindow', { pid, x, y });
            return { ok: true, result: res };
          }
          case 'monitor-session': {
            const pid = Number(params.pid ?? 0);
            if (!Number.isFinite(pid) || pid <= 0) return { ok: false, error: 'needs a pid' };
            const b = await readBounds({ pid });
            await macOverlay.control(pid, b === null ? null : rectOf(b));
            macMonitor.setSession(pid, String(params.app ?? b?.app ?? ''));
            await macOverlay.thinking();
            return { ok: true, result: macMonitor.state() };
          }
          case 'monitor-info':
            return {
              ok: true,
              result: {
                ...macMonitor.state(),
                capturing: macMonitor.streaming(),
                polling: macMonitor.polling(),
                ax: macMonitor.axScene(),
              },
            };
          // The native panel's own truth (frame, click-through, focus,
          // collection behavior, cursor position, pill state). This is what
          // replaced reading the old overlay window's DOM — there is no DOM
          // any more, so the panel reports on itself.
          case 'overlay-native-info':
            return { ok: true, result: await macOverlay.nativeInfo() };
          /* The user's challenge, measured: can we sit directly above another app's
             window? See OverlayController.orderRelativeTest. */
          case 'overlay-order-test':
            return {
              ok: true,
              result: await macOverlay.orderTest(
                Number(params.windowId ?? 0),
                String(params.mode ?? 'read-only'),
              ),
            };
          case 'overlay-hide-panel': {
            await macOverlay.debugHidePanel();
            return { ok: true };
          }
          case 'overlay-occluders': {
            await macOverlay.debugOccluders(
              Array.isArray(params.rects) ? (params.rects as OverlayRect[]) : [],
            );
            return { ok: true };
          }
          case 'overlay-backdrop': {
            const r =
              typeof params.w === 'number' && typeof params.h === 'number'
                ? {
                    x: Number(params.x ?? 0),
                    y: Number(params.y ?? 0),
                    w: Number(params.w),
                    h: Number(params.h),
                  }
                : undefined;
            await macOverlay.debugBackdrop(
              typeof params.color === 'string' ? params.color : null,
              r,
            );
            return { ok: true };
          }
          case 'overlay-controls-hover': {
            await macOverlay.debugControlsHover(
              params.on !== false,
              typeof params.hot === 'number' ? params.hot : undefined,
            );
            return { ok: true };
          }
          case 'overlay-render': {
            const crop =
              typeof params.w === 'number' && typeof params.h === 'number'
                ? {
                    x: Number(params.x ?? 0),
                    y: Number(params.y ?? 0),
                    w: Number(params.w),
                    h: Number(params.h),
                    scale: Number(params.scale ?? 2),
                  }
                : undefined;
            return { ok: await macOverlay.debugRender(String(params.path ?? ''), crop) };
          }
          case 'overlay-retarget': {
            // Prompt reposition to a new frame (the tracker's move path) — proves
            // the overlay follows without snap-on-release. Also update the
            // synthetic bounds source so the live tracker MAINTAINS the new frame
            // instead of reverting it on its next tick.
            const frame = {
              x: Number(params.x ?? 0),
              y: Number(params.y ?? 0),
              w: Number(params.w ?? 600),
              h: Number(params.h ?? 400),
            };
            e2eFakeBounds = { ...frame, frontmost: e2eFakeBounds?.frontmost !== false };
            await macOverlay.debugRetarget(frame);
            return { ok: true, result: macOverlay.info() };
          }
          /* Real control of a real app: the live bounds reader, the real
             window number, the real pin — the only way to check the stacking
             claim against the window server rather than against a fake. */
          case 'overlay-live-control': {
            const app = String(params.app ?? '');
            const b = (await getHelper().request('bounds', { app })) as {
              pid?: number;
              x?: number;
              y?: number;
              w?: number;
              h?: number;
              windowId?: number;
            };
            if (typeof b?.pid !== 'number') return { ok: false, error: `no window for ${app}` };
            await macOverlay.control(b.pid, {
              x: Number(b.x ?? 0),
              y: Number(b.y ?? 0),
              w: Number(b.w ?? 0),
              h: Number(b.h ?? 0),
              ...(typeof b.windowId === 'number' ? { windowId: b.windowId } : {}),
            });
            return { ok: true, result: { ...macOverlay.info(), windowId: b.windowId, pid: b.pid } };
          }
          case 'overlay-fake-control': {
            // Drive the REAL tracking loop off a synthetic bounds source.
            e2eFakeBounds = fakeSample(params);
            macOverlay.setBoundsReader(async () => e2eFakeBounds);
            await macOverlay.control(Number(params.pid ?? 424242), {
              x: e2eFakeBounds.x,
              y: e2eFakeBounds.y,
              w: e2eFakeBounds.w,
              h: e2eFakeBounds.h,
            });
            return { ok: true, result: macOverlay.info() };
          }
          case 'overlay-fake-move': {
            // Move the synthetic window; the live tracker picks it up on its
            // next fast tick (probe waits a beat, then asserts the overlay
            // window moved with it).
            e2eFakeBounds = fakeSample(params);
            return { ok: true };
          }
          case 'overlay-hide': {
            macOverlay.hide();
            return { ok: true };
          }
          default:
            return { ok: false, error: `unknown op: ${req.op}` };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

/** Test/lifecycle hook: close the socket server + kill the helper. */
export function disposeMacAgent(): void {
  armEscBrake(false);
  server?.close();
  server = null;
  helper?.dispose();
  helper = null;
  macMonitor.dispose();
  macOverlay.dispose();
  elementCenters.clear();
  tccCache = null;
}
