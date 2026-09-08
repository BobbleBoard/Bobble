/**
 * The Mac computer-use CURSOR OVERLAY window — the only thing the user
 * perceives while Pi drives an app in the background.
 *
 * A transparent, frameless, click-through, always-on-top ("screen-saver"
 * level, all workspaces) BrowserWindow positioned EXACTLY over the controlled
 * app's window and tracking its moves/resizes by polling the pi-mac helper's
 * `bounds` method (injected — this module never talks to the helper directly).
 * Inside it, a static overlay.html (plain JS/CSS, loadFile — zero vite
 * coupling) renders the phantom gradient cursor + status bubble; main pushes
 * state via executeJavaScript → window.__pdOverlay(msg), so the page needs no
 * preload and no nodeIntegration.
 *
 * Never steals focus: the window is non-focusable and shown with
 * showInactive(); setIgnoreMouseEvents(true, {forward:true}) forwards every
 * mouse event through to whatever is really underneath.
 *
 * Driven by REAL tool events from mac-agent.ts (launch/snapshot/click/type/…)
 * so the bubble always reflects what is actually happening.
 */
import path from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import { themes } from '@pi-desktop/themes';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { isBackgroundMode } from '../background-mode';
import { readSettings } from '../settings/settings-main';
import {
  comboLabel,
  type MacCursorState,
  type MacOverlayState,
  type OverlayRect,
  overlayBoundsFor,
  overlayShouldShow,
  rectsDiffer,
  toLocalPoint,
  typingPreview,
} from './overlay-geometry';

const log = createLogger('desktop:mac-overlay');

/** How long the phantom cursor takes to glide to an action point (matches the
 * CSS travel transition in overlay.html). */
export const CURSOR_TRAVEL_MS = 300;
/** Window-tracking poll cadence while the overlay is VISIBLE — tight enough
 * that the overlay rides a window drag live instead of snapping on release.
 * The tracker self-reschedules AFTER each bounds read resolves, so at most one
 * read is ever outstanding on the (single-threaded) helper pipe — a real tool
 * act waits behind at most one cheap bounds read, never a backlog. */
const FAST_TRACK_MS = 16;
/** Slower cadence while the overlay is hidden-but-still-tracking (app
 * backgrounded / model idle): we only need to notice a refocus, not animate. */
const SLOW_TRACK_MS = 250;
/** Bounds have read null (window minimized/closed/quit) continuously for this
 * long → tear the overlay all the way down rather than track a ghost. A brief
 * miss (space-switch animation, AX hiccup) just hides it visually and recovers. */
const MISSING_GRACE_MS = 1500;
/** The model counts as actively DRIVING for this long after its last action —
 * the overlay stays visible through it even while the app is backgrounded, so
 * the user can watch Pi work; once it lapses (and the app isn't frontmost) the
 * overlay tucks away. */
const DRIVING_WINDOW_MS = 4_000;
/** How long a transient bubble (key press / scroll) lingers before returning
 * to the resting 'thinking' state. */
const TRANSIENT_STATUS_MS = 1200;
/** With NO tool activity for this long the bubble fades out (the cursor stays
 * — always visible while an app is controlled). "Thinking…" must reflect a
 * turn actually in flight, not linger forever after the model finished. */
const BUBBLE_IDLE_MS = 15_000;

/** A live window-frame read, plus the visibility-rule inputs that ride along
 * with it (see overlayShouldShow): whether the controlled app is frontmost,
 * whether its window is on the CURRENT space, and whether it is meaningfully
 * OCCLUDED by other apps' windows above it in z (helper CGWindowList truth;
 * absent on older helpers). */
export type BoundsSample = OverlayRect & {
  readonly frontmost?: boolean;
  readonly onScreen?: boolean;
  readonly occluded?: boolean | null;
};

/** Injected read of the controlled window's live frame (null = no window). */
export type BoundsReader = (pid: number) => Promise<BoundsSample | null>;

/** Re-exported for callers that already import from this module. */
export type { MacOverlayState } from './overlay-geometry';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/** Static overlay page, resolved relative to the app root (dev: the source
 * tree; packaged: inside app.asar — see the electron-builder note in the
 * repo docs; loadFile reads from the asar transparently). */
function overlayHtmlPath(): string {
  return path.join(app.getAppPath(), 'electron', 'mac', 'overlay.html');
}

/** How long the window may stay mouse-CATCHING before main forces it back to
 * click-through. The page reports the pointer leaving the bubble, but a page
 * that never gets that event (the pointer jumps to another space, the window
 * moves out from under it) must not be able to leave a transparent window
 * eating the user's clicks. */
const HIT_WATCHDOG_MS = 4_000;

/**
 * The bubble's three colours, resolved from whichever theme flavour is on.
 *
 * The on-screen phantom and the one in the canvas tab are supposed to be the
 * same object; they had drifted into two palettes with two justifications, one
 * of which (a purple that had already been removed) was no longer true. So the
 * overlay stops carrying its own palette and is told the app's, which also
 * means the phantom floating over TextEdit belongs to the flavour the user
 * picked instead of to whatever this file was written with.
 */
export function overlayTheme(): { accent: string; pill: string; ink: string } {
  // Near-black, theme-independent, exactly like the canvas bubble: the pill
  // floats over the USER'S DESKTOP, which is not light or dark on our terms.
  const pill = 'rgba(22,24,30,0.92)';
  const ink = '#ffffff';
  try {
    const pref = readSettings().theme;
    const mode =
      pref.mode === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : pref.mode;
    const accent = themes[`${pref.flavor}-${mode}`]?.accent.primary;
    return { accent: accent ?? '#0071e3', pill, ink };
  } catch {
    return { accent: '#0071e3', pill, ink };
  }
}

class MacOverlayController {
  #win: BrowserWindow | null = null;
  #loaded: Promise<void> | null = null;
  #boundsReader: BoundsReader | null = null;
  #target: { pid: number | null; rect: OverlayRect } | null = null;
  #trackTimer: ReturnType<typeof setTimeout> | null = null;
  #missingSince: number | null = null;
  #lastCursor: { x: number; y: number } | null = null;
  #lastActivityAt: number | null = null;
  #lastOccluded: boolean | null = null;
  /** What {@link #applyVisibility} last decided, before the background-mode gate. */
  #wantsVisible = false;
  #revertTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The phantom's position in GLOBAL SCREEN POINTS — see {@link MacOverlayState}. */
  #screenCursor: { x: number; y: number } | null = null;
  #cursorState: MacCursorState = 'idle';
  #statusText = '';
  #bubbleVisible = false;
  #watchers = new Set<(state: MacOverlayState) => void>();
  /** What the ✕ inside the bubble does. Injected by mac-agent.ts, which owns
   * the other half of stopping (refusing the model's next act). */
  #brake: ((mode: 'stopped' | 'user') => void) | null = null;
  /** What clicking the bubble body does: bring Bobble forward on its monitor. */
  #reveal: (() => void) | null = null;
  /** True while the window is catching the mouse for the bubble (C2). */
  #catching = false;
  #hitWatchdog: ReturnType<typeof setTimeout> | null = null;

  /** mac-agent injects the helper-backed bounds reader once at registration. */
  setBoundsReader(reader: BoundsReader): void {
    this.#boundsReader = reader;
  }

  /**
   * THE BRAKE ON THE ONLY THING THE USER CAN SEE.
   *
   * While an app is driven in the background, the phantom and its bubble are
   * the entire product as far as the user is concerned — and until now they
   * were decorative, because the whole window is click-through. `stop` is
   * wired to the ✕ inside the bubble; `reveal` to the bubble body, which brings
   * Bobble forward on the monitor.
   */
  setBrake(stop: (mode: 'stopped' | 'user') => void, reveal?: () => void): void {
    this.#brake = stop;
    this.#reveal = reveal ?? null;
  }

  // ── published state (monitor.ts's single source of truth) ──────────────

  /** A snapshot of what the phantom is doing right now. */
  state(): MacOverlayState {
    const target = this.#target;
    return {
      engaged: target !== null,
      pid: target?.pid ?? null,
      rect: target === null ? null : { ...target.rect },
      cursor: this.#screenCursor === null ? null : { ...this.#screenCursor },
      cursorState: this.#cursorState,
      statusText: this.#statusText,
      bubbleVisible: this.#bubbleVisible,
      wantsVisible: this.#wantsVisible,
    };
  }

  /** Watch {@link state} for changes. Returns an unsubscribe. */
  watch(listener: (state: MacOverlayState) => void): () => void {
    this.#watchers.add(listener);
    return () => {
      this.#watchers.delete(listener);
    };
  }

  #emit(): void {
    if (this.#watchers.size === 0) return;
    const snapshot = this.state();
    for (const w of this.#watchers) {
      try {
        w(snapshot);
      } catch {
        /* a watcher must never break a tool call */
      }
    }
  }

  /** Record the bubble state alongside the push to overlay.html, so the two
   * always describe the same moment. */
  #setStatus(state: MacCursorState, text = ''): void {
    this.#cursorState = state;
    this.#statusText = text;
    this.#bubbleVisible = state !== 'idle';
  }

  // ── window lifecycle ───────────────────────────────────────────────────

  #ensureWindow(): BrowserWindow {
    if (this.#win !== null && !this.#win.isDestroyed()) return this.#win;
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The tracker + animations must run while the overlay never has focus.
        backgroundThrottling: false,
      },
    });
    // Float ABOVE normal app windows, but NOT at screen-saver level — the
    // overlay must not sit over system UI / the user's other apps as if it
    // owned the screen. macOS window levels are global bands (not per-app), so
    // this can't be truly z-sandwiched between the controlled app and the rest;
    // the app-scoping is done by the show/hide visibility rule in #trackTick
    // (overlayShouldShow), and 'floating' keeps the level as low as still lets
    // the phantom read over the controlled window while the model is driving.
    /* NEVER over a real screen during a test. This window is always-on-top and
       rides every space including fullscreen — the single most intrusive thing
       the app can put in front of someone. In background mode it is built and
       driven but never shown, so a computer-use probe still exercises its
       geometry and its IPC without appearing. */
    win.setAlwaysOnTop(true, 'floating');
    // Ride along to whatever space the controlled window is on (incl. a
    // fullscreen app); the visibility rule keeps it from intruding elsewhere.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Click-through by default: the overlay must never eat a real mouse event
    // — except over the bubble itself, which the page asks for by the hit
    // messages below and which main un-asks for on its own watchdog.
    win.setIgnoreMouseEvents(true, { forward: true });
    this.#catching = false;
    /*
     * THE PAGE'S ONE WAY TO SPEAK.
     *
     * overlay.html is deliberately preload-less and sandboxed — main drives it
     * through executeJavaScript and it has no ipcRenderer. A denied
     * `window.open('pd-overlay:…')` is a one-way, argument-free signal that
     * needs no build wiring and can never navigate anything: the handler reads
     * the verb and returns 'deny'.
     */
    win.webContents.setWindowOpenHandler(({ url }) => {
      this.#fromPage(url);
      return { action: 'deny' };
    });
    // Nothing in this window may ever navigate. It renders one static file.
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    this.#loaded = win.loadFile(overlayHtmlPath()).catch((err) => {
      log.error('overlay.html failed to load', { error: String(err) });
    });
    win.on('closed', () => {
      if (this.#win === win) {
        this.#win = null;
        this.#stopTracking();
      }
    });
    this.#win = win;
    return win;
  }

  /** One `pd-overlay:<verb>` signal from the page. */
  #fromPage(url: string): void {
    if (!url.startsWith('pd-overlay:')) return;
    const verb = url.slice('pd-overlay:'.length).replace(/[/?#].*$/, '');
    switch (verb) {
      case 'hit':
        this.#setCatching(true);
        return;
      case 'unhit':
        this.#setCatching(false);
        return;
      case 'stop':
        this.#setCatching(false);
        this.#brake?.('stopped');
        return;
      case 'reveal':
        this.#setCatching(false);
        this.#reveal?.();
        return;
      default:
        return;
    }
  }

  /**
   * Catch the mouse, or stop catching it.
   *
   * The watchdog is not paranoia: a transparent, always-on-top window that got
   * stuck catching would silently swallow every click over the controlled app,
   * with nothing on screen to explain why. The page reports the pointer
   * leaving; main stops believing it after HIT_WATCHDOG_MS regardless.
   */
  #setCatching(on: boolean): void {
    const win = this.#win;
    if (win === null || win.isDestroyed()) return;
    if (this.#hitWatchdog !== null) {
      clearTimeout(this.#hitWatchdog);
      this.#hitWatchdog = null;
    }
    if (on) {
      if (!this.#catching) {
        this.#catching = true;
        win.setIgnoreMouseEvents(false);
      }
      this.#hitWatchdog = setTimeout(() => {
        this.#hitWatchdog = null;
        this.#setCatching(false);
      }, HIT_WATCHDOG_MS);
      this.#hitWatchdog.unref?.();
      return;
    }
    if (!this.#catching) return;
    this.#catching = false;
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  /** Probes: is the overlay currently catching the mouse for its bubble? */
  catching(): boolean {
    return this.#catching;
  }

  async #push(msg: Record<string, unknown>): Promise<void> {
    const win = this.#win;
    if (win === null || win.isDestroyed()) return;
    await this.#loaded;
    if (win.isDestroyed()) return;
    try {
      await win.webContents.executeJavaScript(
        `window.__pdOverlay && window.__pdOverlay(${JSON.stringify(msg)})`,
        true,
      );
    } catch {
      /* the overlay is cosmetic — a push must never break a tool call */
    }
  }

  // ── control / tracking ─────────────────────────────────────────────────

  /** Show the overlay over `rect` and track `pid`'s window (moves/resizes).
   * Idempotent per pid; a new pid re-targets the overlay. */
  async control(pid: number, rect: OverlayRect | null | undefined): Promise<void> {
    if (process.platform !== 'darwin') return;
    const known = rect ?? (await this.#readBounds(pid));
    if (known === null) return; // no window yet — a later snapshot will retry
    const win = this.#ensureWindow();
    this.#target = { pid, rect: { x: known.x, y: known.y, w: known.w, h: known.h } };
    this.#missingSince = null;
    this.#markActivity(); // control() means the model just acted → show
    win.setBounds(overlayBoundsFor(this.#target.rect));
    this.#applyVisibility(true);
    this.#emit();
    await this.#push({ kind: 'theme', ...overlayTheme() });
    await this.#push({ kind: 'reset' });
    this.#startTracking();
  }

  /** E2E seam: show the overlay over an arbitrary rect with NO pid tracking
   * (mac-overlay-probe.mjs drives states deterministically). */
  async debugShow(rect: OverlayRect): Promise<void> {
    const win = this.#ensureWindow();
    this.#target = { pid: null, rect };
    win.setBounds(overlayBoundsFor(rect));
    this.#applyVisibility(true);
    this.#emit();
    await this.#push({ kind: 'theme', ...overlayTheme() });
    await this.#push({ kind: 'reset' });
  }

  /** E2E seam: simulate ONE tracker reposition to `rect` synchronously (same
   * code path a live bounds change takes) so a probe can assert the overlay
   * follows the controlled window in the SAME tick — no snap-on-release lag. */
  async debugRetarget(rect: OverlayRect): Promise<void> {
    if (this.#target === null) return;
    await this.#reposition(rect);
  }

  async #readBounds(pid: number): Promise<BoundsSample | null> {
    const reader = this.#boundsReader;
    if (reader === null) return null;
    try {
      return await reader(pid);
    } catch {
      return null;
    }
  }

  /** True while the model is actively driving (recent action) — see
   * DRIVING_WINDOW_MS. */
  #isDriving(): boolean {
    return this.#lastActivityAt !== null && Date.now() - this.#lastActivityAt < DRIVING_WINDOW_MS;
  }

  #markActivity(): void {
    this.#lastActivityAt = Date.now();
    // If we're tracking but currently tucked away, re-evaluate visibility right
    // now so the overlay reappears the instant the model resumes — don't wait
    // out the slow hidden-cadence poll.
    const win = this.#win;
    if (this.#trackTimer !== null && win !== null && !win.isDestroyed() && !win.isVisible()) {
      this.#scheduleTrack(0);
    }
  }

  /** Move/resize the overlay window to follow the target rect. A pure MOVE just
   * repositions the window — the phantom cursor rides along at its fixed local
   * coordinate (it stays glued to the on-screen target, no spring re-fires). A
   * RESIZE that would push the cursor outside the padded window re-clamps it via
   * a 'reset'; otherwise no executeJavaScript round-trip runs, so tracking stays
   * lag-free at the fast cadence. */
  async #reposition(fresh: OverlayRect): Promise<void> {
    const target = this.#target;
    const win = this.#win;
    if (target === null || win === null || win.isDestroyed()) return;
    const resized =
      Math.abs(target.rect.w - fresh.w) >= 1 || Math.abs(target.rect.h - fresh.h) >= 1;
    target.rect = { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h };
    // Instant follow: no animate, no moveTop/focus — just the new frame.
    win.setBounds(overlayBoundsFor(target.rect));
    this.#emit();
    if (resized && this.#cursorOutsidePadded(target.rect)) await this.#push({ kind: 'reset' });
  }

  /** Would the last-placed cursor now fall outside the padded window (so the
   * DOM must re-clamp it)? Unknown cursor → assume yes, to be safe. */
  #cursorOutsidePadded(rect: OverlayRect): boolean {
    const c = this.#lastCursor;
    if (c === null) return false;
    const b = overlayBoundsFor(rect);
    return c.x < 4 || c.y < 4 || c.x > b.width - 4 || c.y > b.height - 4;
  }

  #applyVisibility(show: boolean): void {
    const win = this.#win;
    if (win === null || win.isDestroyed()) return;
    /*
     * The DECISION, recorded before the gate. In background mode the window is
     * never shown, so `isVisible()` stops being able to tell anyone whether the
     * overlay's own logic — frontmost, on-screen, driving, occluded — said it
     * should be. Keeping the answer here is what lets a probe test that logic
     * without a window ever appearing over someone's work.
     */
    const changed = this.#wantsVisible !== show;
    this.#wantsVisible = show;
    if (changed) this.#emit();
    if (show) {
      if (!win.isVisible() && !isBackgroundMode()) win.showInactive();
    } else if (win.isVisible()) {
      win.hide();
    }
  }

  #startTracking(): void {
    if (this.#trackTimer !== null) return;
    this.#scheduleTrack(0);
  }

  #scheduleTrack(delay: number): void {
    if (this.#trackTimer !== null) clearTimeout(this.#trackTimer);
    this.#trackTimer = setTimeout(() => {
      void this.#trackTick();
    }, delay);
    this.#trackTimer.unref?.();
  }

  #stopTracking(): void {
    if (this.#trackTimer !== null) {
      clearTimeout(this.#trackTimer);
      this.#trackTimer = null;
    }
  }

  /** One self-rescheduling tracking tick: read the live frame, follow moves,
   * and apply the app-scoped visibility rule. Re-schedules itself AFTER the
   * async read resolves (never on a fixed interval), so reads can't pile up on
   * the helper pipe. */
  async #trackTick(): Promise<void> {
    const target = this.#target;
    const win = this.#win;
    if (target === null || target.pid === null || win === null || win.isDestroyed()) {
      this.#trackTimer = null;
      return;
    }
    const sample = await this.#readBounds(target.pid);
    // Bail if control was dropped / re-targeted while the read was in flight.
    if (this.#target !== target || this.#win !== win || win.isDestroyed()) return;

    let visible = false;
    if (sample === null) {
      // Window not currently readable (minimized / space animation / quit).
      if (this.#missingSince === null) this.#missingSince = Date.now();
      this.#applyVisibility(false);
      if (Date.now() - this.#missingSince >= MISSING_GRACE_MS) {
        this.hide();
        return;
      }
    } else {
      this.#missingSince = null;
      if (rectsDiffer(target.rect, sample)) await this.#reposition(sample);
      this.#lastOccluded = typeof sample.occluded === 'boolean' ? sample.occluded : null;
      visible = overlayShouldShow({
        controlledFrontmost: sample.frontmost === true,
        // onScreen === false means the helper SAW the window off the current
        // space (or minimized) even though AX still reports a frame — the
        // phantom must not haunt the space the user switched to.
        appVisible: sample.onScreen !== false,
        driving: this.#isDriving(),
        occluded: this.#lastOccluded,
      });
      this.#applyVisibility(visible);
    }
    this.#scheduleTrack(visible ? FAST_TRACK_MS : SLOW_TRACK_MS);
  }

  // ── action-driven states (called by mac-agent dispatch) ────────────────

  #local(screenX: number, screenY: number): { x: number; y: number } | null {
    const target = this.#target;
    if (target === null) return null;
    const p = toLocalPoint(screenX, screenY, target.rect);
    this.#lastCursor = p; // remembered so a resize knows whether to re-clamp
    // The GLOBAL point too: the canvas monitor draws in screen space and would
    // otherwise have to invert the overlay's padded-local mapping.
    this.#screenCursor = { x: screenX, y: screenY };
    return p;
  }

  /** Glide the cursor to a screen point and wait out the travel. */
  async moveCursor(screenX: number, screenY: number): Promise<void> {
    const p = this.#local(screenX, screenY);
    if (p === null) return;
    this.#armIdle();
    this.#emit();
    await this.#push({ kind: 'cursor', x: p.x, y: p.y, ms: CURSOR_TRAVEL_MS });
    await sleep(CURSOR_TRAVEL_MS);
  }

  /** Click feedback at a screen point: press dip + expanding ripples. */
  async clickAt(screenX: number, screenY: number): Promise<void> {
    const p = this.#local(screenX, screenY);
    if (p === null) return;
    this.#armIdle();
    // overlay.html's 'click' message shows the "Clicking" bubble itself.
    this.#setStatus('clicking');
    this.#emit();
    await this.#push({ kind: 'click', x: p.x, y: p.y });
    this.#revertSoon();
  }

  /** Live-typing bubble (optionally previewing the text) at the cursor. */
  async typing(text: string): Promise<void> {
    this.#armIdle();
    const preview = typingPreview(text);
    this.#setStatus('typing', preview);
    this.#emit();
    await this.#push({ kind: 'status', status: 'typing', text: preview });
  }

  async keyPress(combo: string): Promise<void> {
    this.#armIdle();
    const label = comboLabel(combo);
    this.#setStatus('pressing', label);
    this.#emit();
    await this.#push({ kind: 'status', status: 'pressing', text: label });
    this.#revertSoon();
  }

  async scrolling(): Promise<void> {
    this.#armIdle();
    this.#setStatus('scrolling');
    this.#emit();
    await this.#push({ kind: 'status', status: 'scrolling' });
    this.#revertSoon();
  }

  /**
   * The model is READING the screen — a snapshot, not an act.
   *
   * This state existed on both sides and had never fired once, because nothing
   * called it: a census of 180 samples saw every other state and not this one.
   * It is wired now (mac-agent's snapshot path), because a snapshot IS the
   * thing the user most wants named — a bubble that says "Thinking" while the
   * agent silently reads their screen is the wrong word for that moment.
   */
  async reading(): Promise<void> {
    this.#armIdle();
    this.#setStatus('reading');
    this.#emit();
    await this.#push({ kind: 'status', status: 'reading' });
  }

  async opening(appName: string): Promise<void> {
    this.#armIdle();
    const label = `Opening ${appName}`;
    this.#setStatus('opening', label);
    this.#emit();
    await this.#push({ kind: 'status', status: 'opening', text: label });
  }

  /** The resting state between actions: the model is deciding what to do. */
  async thinking(): Promise<void> {
    this.#clearRevert();
    this.#armIdle();
    this.#setStatus('thinking');
    this.#emit();
    await this.#push({ kind: 'status', status: 'thinking' });
  }

  #revertSoon(): void {
    this.#clearRevert();
    this.#revertTimer = setTimeout(() => {
      this.#setStatus('thinking');
      this.#emit();
      void this.#push({ kind: 'status', status: 'thinking' });
    }, TRANSIENT_STATUS_MS);
    this.#revertTimer.unref?.();
  }

  #clearRevert(): void {
    if (this.#revertTimer !== null) {
      clearTimeout(this.#revertTimer);
      this.#revertTimer = null;
    }
  }

  /** Every real activity push re-arms the idle fade: after BUBBLE_IDLE_MS of
   * silence the bubble hides (the cursor rests in place, still visible). Also
   * marks the model as actively driving, which keeps the overlay visible (see
   * overlayShouldShow) even while the controlled app is backgrounded. */
  #armIdle(): void {
    this.#markActivity();
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#bubbleVisible = false;
      this.#emit();
      void this.#push({ kind: 'hide-bubble' });
    }, BUBBLE_IDLE_MS);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  /** Info for probes/assertions. */
  info(): {
    visible: boolean;
    engaged: boolean;
    wantsVisible: boolean;
    bounds: OverlayRect | null;
    trackingPid: number | null;
    occluded: boolean | null;
  } {
    const win = this.#win;
    const visible = win !== null && !win.isDestroyed() && win.isVisible();
    return {
      visible,
      /*
       * ENGAGED ≠ VISIBLE, and the difference is the whole of background mode.
       *
       * The overlay is a floating always-on-top window; a test suite that shows
       * it puts it over whatever the user is reading, so `showInactive()` is
       * gated on `isBackgroundMode()`. Everything else about it still runs —
       * it is built, positioned, tracked and rendered on a window nobody sees.
       *
       * `visible` alone therefore could not tell a probe whether the overlay was
       * WORKING or merely hidden on purpose, which is exactly what a probe needs
       * to know. This says the overlay is targeted at something and would be on
       * screen if it were allowed to be.
       */
      engaged: this.#target !== null,
      /* What the overlay's own logic decided, before the background-mode gate —
         the only way to test that logic without showing a window. */
      wantsVisible: this.#wantsVisible,
      bounds: this.#target?.rect ?? null,
      trackingPid: this.#target?.pid ?? null,
      occluded: this.#lastOccluded,
    };
  }

  hide(): void {
    this.#clearRevert();
    this.#clearIdle();
    this.#stopTracking();
    this.#setCatching(false);
    this.#target = null;
    this.#missingSince = null;
    this.#lastCursor = null;
    this.#lastActivityAt = null;
    this.#lastOccluded = null;
    this.#screenCursor = null;
    this.#setStatus('idle');
    const win = this.#win;
    this.#wantsVisible = false;
    if (win !== null && !win.isDestroyed() && win.isVisible()) win.hide();
    this.#emit();
  }

  dispose(): void {
    this.hide();
    this.#watchers.clear();
    const win = this.#win;
    this.#win = null;
    if (win !== null && !win.isDestroyed()) win.destroy();
  }
}

/** The app-wide overlay singleton (one controlled app at a time — matches the
 * single long-lived pi-mac helper). */
export const macOverlay = new MacOverlayController();
