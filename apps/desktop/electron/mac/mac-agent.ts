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
import { app, globalShortcut, ipcMain, systemPreferences } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import { isBackgroundMode } from '../background-mode';
import { isTrustedIpcEvent } from '../trusted-senders';
import { userLaunchEnv } from './launch-env';
import {
  macMonitor,
  registerMacMonitorIpc,
  setCaptureGrantPrompt,
  setMacControlHandler,
} from './monitor';
import { macMonitorMockControl, startMacMonitorMock } from './monitor-mock';
import { macOverlay } from './overlay-controller';
import type { OverlayRect } from './overlay-geometry';

const log = createLogger('desktop:mac-agent');
const execFileAsync = promisify(execFile);

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

function rectOf(b: MacWindowBounds): OverlayRect | null {
  if (
    typeof b.x !== 'number' ||
    typeof b.y !== 'number' ||
    typeof b.w !== 'number' ||
    typeof b.h !== 'number'
  ) {
    return null;
  }
  return { x: b.x, y: b.y, w: b.w, h: b.h };
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
async function restoreFocusTo(previous: string, launched: string): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 350));
    const now = await frontmostAppName();
    if (now === null) return;
    if (now !== launched) return; // the user is somewhere else, or it behaved
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
  try {
    await execFileAsync('open', background ? ['-g', '-a', appName] : ['-a', appName], {
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
  // Let first-paint settle so the snapshot-after-open screenshot shows content.
  await sleep(LAUNCH_SETTLE_MS);
  return { ok: true, app: bounds.app ?? appName, pid: bounds.pid, bounds };
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
  cacheSnapshot(snap);
  if (typeof snap.pid === 'number') {
    const wb = snap.windowBounds;
    await macOverlay.control(snap.pid, wb ? { x: wb.x, y: wb.y, w: wb.w, h: wb.h } : null);
    // The monitor tab follows the SAME target the overlay just took (one
    // controlled app at a time); the app name is what titles the tab.
    macMonitor.setSession(snap.pid, String(snap.app ?? params.app ?? ''));
    await macOverlay.thinking();
  }
  return snap;
}

/** Click: glide the phantom cursor to the target BEFORE the act (element
 * centre from the last snapshot, or the explicit x,y), fire, then ripple at
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
  const control = macMonitor.control();
  if (control === 'agent') return null;
  if (method === 'check' || method === 'setDriving') return null;
  const app = macMonitor.state().appName.trim();
  const named = app === '' ? 'the app' : app;
  if (control === 'user') {
    return `The user has taken over ${named}. Bobble is not watching or acting while they drive — do not retry; wait for them to hand it back, and ask before touching ${named} again.`;
  }
  return `The user pressed Stop, so Mac control is off. Do not retry: say what you had done to ${named} and ask whether to carry on.`;
}

async function dispatch(method: MacAgentMethod, params: Record<string, unknown>): Promise<unknown> {
  if (!isSupportedPlatform()) throw new Error('mac computer-use is macOS-only');
  const refusal = controlRefusal(method);
  if (refusal !== null) throw new Error(refusal);
  switch (method) {
    case 'check':
      return getHelper().request('check');
    case 'snapshot':
      return snapshotWithOverlay(params);
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
    // the extension (session end/reset) puts it away.
    case 'setDriving': {
      if (params.driving === false) {
        macOverlay.hide();
        macMonitor.clearSession();
      }
      return { ok: true };
    }
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
    const result = await dispatch(req.method, req.params ?? {});
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
export function registerMacAgentIpc(): void {
  startServer();
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
          case 'windows':
          case 'setDriving':
            return { ok: true, result: await dispatch(req.op as MacAgentMethod, params) };
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
            await macOverlay.debugBackdrop(typeof params.color === 'string' ? params.color : null);
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
