/**
 * The Mac computer-use CURSOR OVERLAY — the only thing the user perceives while
 * Pi drives an app in the background.
 *
 * This module used to CREATE the overlay (a transparent, click-through,
 * always-on-top BrowserWindow sized to the controlled app's window, hosting an
 * overlay.html). It no longer does: the overlay is a NATIVE NSPanel living in a
 * `pi-mac --overlay` child process, and what is left here is the choreography —
 * spawn it, tell it where the phantom cursor is and what the pill should say,
 * and run the tracking loop that decides when it should be visible.
 *
 * WHY THE MOVE (both are the user's field reports on real runs):
 *   - "mission control still shows blank window". An Electron window is a
 *     first-class managed window, so Mission Control laid the overlay out as a
 *     tile beside the app it was supposed to be painted ON, and the two came
 *     apart on screen. The fix is NSWindowCollectionBehavior.transient, which
 *     Electron does not expose at all.
 *   - "the window is sized directly to the app window size and thus causing cut
 *     off if the mouse cursor goes even a little bit off the screen to the right
 *     especially". The old window was the app frame plus a 56pt margin, so a
 *     cursor past that margin was clipped by the overlay's own window.
 *
 * The native panel is sized to the union of every screen and NEVER MOVES, which
 * deletes both problems along with a whole mechanism: there is no
 * reposition-on-drag path, no screen→window coordinate mapping, and no way to
 * clip. Everything below speaks GLOBAL SCREEN POINTS straight through.
 *
 * Transport is the same NDJSON dialect `--serve` uses, so MacHelperClient drives
 * it unchanged (lazy spawn, id correlation, per-request timeout, respawn after a
 * crash). Every push is best-effort: the overlay is cosmetic and must never
 * break a tool call.
 *
 * NO ✕ BRAKE HERE. The panel is `ignoresMouseEvents = true` end to end — it
 * cannot receive a click, so a "stop" affordance cannot live on the pill without
 * making the overlay swallow mouse events over the app the model is driving,
 * which is the one thing it must never do. If the brake is wanted it needs its
 * own small hit-testable panel (a second NSPanel, click-through everywhere
 * except the button's rect); that is deliberately not built here.
 *
 * Driven by REAL tool events from mac-agent.ts (launch/snapshot/click/type/…)
 * so the pill always reflects what is actually happening.
 */
import { MacHelperClient } from '@pi-desktop/pi-mac';
import { createLogger } from '@pi-desktop/shared';
import { showsMacOverlay } from '../background-mode';
import {
  comboLabel,
  type MacCursorState,
  type MacOverlayState,
  type OverlayOccluders,
  type OverlayRect,
  occludersDiffer,
  overlayShouldShow,
  rectDelta,
  rectsDiffer,
  typingPreview,
} from './overlay-geometry';

const log = createLogger('desktop:mac-overlay');

/** How long the phantom cursor takes to glide to an action point (mirrored by
 * the panel's travel animation, so a tool act can wait it out). */
export const CURSOR_TRAVEL_MS = 300;
/** Window-tracking poll cadence while the overlay is VISIBLE. The panel no
 * longer has to be repositioned, but the sample still carries the visibility
 * inputs (frontmost/onScreen/occluded) and the occluder rects the mask is built
 * from, and the phantom rides a window drag off this same delta — so the tight
 * cadence still earns its keep. The tracker self-reschedules AFTER each bounds
 * read resolves, so at most one read is ever outstanding on the
 * (single-threaded) helper pipe: a real tool act waits behind at most one cheap
 * bounds read, never a backlog. */
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
/** How long a transient pill (key press / scroll) lingers before returning to
 * the resting 'thinking' state. */
const TRANSIENT_STATUS_MS = 1200;
/** With NO tool activity for this long the pill fades out (the cursor stays —
 * always visible while an app is controlled). "Thinking…" must reflect a turn
 * actually in flight, not linger forever after the model finished. */
const BUBBLE_IDLE_MS = 15_000;
/** The overlay draws; it never computes. A command that has not been answered
 * in this long means the panel process is wedged, and waiting the helper
 * client's 30s default would stall the tool act that is waiting on the glide. */
const OVERLAY_REQUEST_TIMEOUT_MS = 4_000;

/** A live window-frame read, plus the visibility-rule inputs that ride along
 * with it (see overlayShouldShow): whether the controlled app is frontmost,
 * whether its window is on the CURRENT space, whether it is meaningfully
 * OCCLUDED by other apps' windows above it, and WHICH rects those are (helper
 * CGWindowList truth; absent on older helpers). */
export type BoundsSample = OverlayRect & {
  readonly frontmost?: boolean;
  readonly onScreen?: boolean;
  readonly occluded?: boolean | null;
  readonly occluders?: OverlayOccluders;
  /** The window server's number for this window — what the panel pins above. */
  readonly windowId?: number;
};

/** Injected read of the controlled window's live frame (null = no window). */
export type BoundsReader = (pid: number) => Promise<BoundsSample | null>;

/** What the native panel reports about itself — the probe's replacement for
 * reading the old overlay's DOM. Shape is the Swift `info` result; typed loosely
 * on purpose so a helper that predates a field degrades instead of throwing. */
export type NativeOverlayInfo = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

class MacOverlayController {
  #client: MacHelperClient | null = null;
  #helperPath: string | undefined;
  #boundsReader: BoundsReader | null = null;
  #target: { pid: number | null; rect: OverlayRect; windowId?: number } | null = null;
  /** Whether the helper is cutting the occlusion mask itself, off the window
   * server's own z-order at display rate. When it is, this side stops sampling
   * occlusion and stops hiding the overlay — see trackWindow in Overlay.swift. */
  #nativeMask = false;
  /** Whether the helper rides window moves off the Accessibility notification
   * itself. When it does, pushing our own shift from here lands LATER with a
   * delta measured against a frame that has already moved on — which is the
   * cursor snap the user saw while dragging. */
  #nativeFollow = false;
  #trackTimer: ReturnType<typeof setTimeout> | null = null;
  #missingSince: number | null = null;
  #lastActivityAt: number | null = null;
  #lastOccluded: boolean | null = null;
  #lastOccluders: OverlayOccluders | null = null;
  #visible = false;
  /*
   * WHO WANTS TELLING WHEN THE PHANTOM IS ENGAGED.
   *
   * The global Escape brake exists exactly while an app is being driven, and
   * the overlay's engagement is the app's single truth for that. The old
   * BrowserWindow overlay exposed this as `watch`; the panel has to keep it, or
   * Escape stops braking — and MEASURED, the missing method threw during
   * startup and the app's window never opened at all.
   */
  #watchers: ((state: MacOverlayState) => void)[] = [];
  #cursorPlaced = false;
  /*
   * WHAT THE PANEL IS SHOWING, MIRRORED HERE.
   *
   * The canvas monitor draws the same phantom over a live picture of the
   * controlled window, and reads it through `state()`. The old BrowserWindow
   * overlay held this in its DOM; the panel holds it in another process, so the
   * controller has to remember what it last pushed or the two surfaces disagree
   * — and MEASURED, the missing method threw at startup and no window opened.
   */
  #cursor: { x: number; y: number } | null = null;
  #cursorState: MacCursorState = 'idle';
  #statusText = '';
  #revertTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** mac-agent injects the resolved `pi-mac` binary path (dev build output or
   * the asarUnpack'd bundle path) once at registration. */
  setHelperPath(path: string): void {
    this.#helperPath = path;
  }

  /** mac-agent injects the helper-backed bounds reader once at registration. */
  setBoundsReader(reader: BoundsReader): void {
    this.#boundsReader = reader;
  }

  // ── panel process lifecycle ────────────────────────────────────────────

  /** The overlay process, spawned on first use. Same client as `--serve`: it
   * respawns after a crash, so a panel that dies mid-run comes back on the next
   * push rather than leaving the run blind. */
  #panel(): MacHelperClient {
    /* The client is created lazily, so the brake binding has to be retried
       whenever it is asked for rather than once at construction. */
    if (this.#client === null) {
      this.#client = new MacHelperClient({
        helperPath: this.#helperPath,
        /* Headless under a probe: the panel is created and driven, and never
           ordered onto the screen — `showsMacOverlay` is the one switch for
           "may the phantom appear", and it was not wired to the native panel
           (the user, 2026-09-15: the overlay leaking from the test harness). */
        helperArgs: showsMacOverlay() ? ['--overlay'] : ['--overlay', '--headless'],
        /* The overlay child's stderr was piped and never read, so everything it
           said about its own health was invisible. the user: "you need to log
           whenever that's happening". A line starting `overlay:` is the panel
           reporting that it cannot mask itself — the exact condition behind the
           phantom drawing over the wrong window. */
        onStderr: (line) => {
          if (line.startsWith('overlay: UNMASKED')) log.warn('phantom is unmasked', { line });
          else log.debug('pi-mac overlay', { line });
        },
        requestTimeoutMs: OVERLAY_REQUEST_TIMEOUT_MS,
      });
    }
    this.#bindBrake();
    return this.#client;
  }

  async #push(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (process.platform !== 'darwin') return null;
    try {
      return await this.#panel().request(method, params);
    } catch (err) {
      // The overlay is cosmetic — a failed push must never break a tool call.
      log.debug('overlay push failed', { method, error: String(err) });
      return null;
    }
  }

  // ── control / tracking ─────────────────────────────────────────────────

  /**
   * What a press on the pill's own buttons should do.
   *
   * The phantom is paint everywhere except here: the pill carries stop, pause
   * and hide, and those are the only controls that exist while the user is in
   * ANOTHER app looking at the thing being driven. The panel reports the press
   * as an event; this is where it becomes an action.
   */
  onBrake(fn: (action: string) => void): void {
    this.#brake = fn;
    this.#bindBrake();
  }
  #brake: ((action: string) => void) | null = null;
  #brakeBound = false;

  #bindBrake(): void {
    if (this.#brakeBound) return;
    const client = this.#client;
    if (client === null) return;
    this.#brakeBound = true;
    client.onEvent((event, data) => {
      /*
       * ACCESSIBILITY SAW THE WINDOW MOVE, or an app came forward and changed
       * the z-order. Either way whatever we last read is stale RIGHT NOW, and
       * waiting up to 250ms for the next poll is what the user saw as the phantom
       * lagging a drag and then "inexplicably" sitting on top again. Re-tick
       * immediately instead.
       */
      if (event === 'overlay-retrack') {
        if (this.#target !== null) this.#scheduleTrack(0);
        return;
      }
      if (event !== 'overlay-brake') return;
      const action = typeof data.action === 'string' ? data.action : '';
      if (action !== '') this.#brake?.(action);
    });
  }

  /** Show the overlay for `pid`'s window and track it. Idempotent per pid; a
   * new pid re-targets the overlay. `rect` is the caller's already-known frame
   * (a snapshot/launch ack) to save a round-trip. */
  async control(
    pid: number,
    rect: (OverlayRect & { windowId?: number }) | null | undefined,
  ): Promise<void> {
    if (process.platform !== 'darwin') return;
    const known = rect ?? (await this.#readBounds(pid));
    if (known === null) return; // no window yet — a later snapshot will retry
    this.#target = {
      pid,
      rect: { x: known.x, y: known.y, w: known.w, h: known.h },
      ...(known.windowId === undefined ? {} : { windowId: known.windowId }),
    };
    this.#missingSince = null;
    this.#markActivity(); // control() means the model just acted → show
    await this.#pushTarget(this.#target.rect);
    await this.#show();
    await this.#seedCursor();
    this.#startTracking();
  }

  /** E2E seam: bring the panel up with NO pid tracking, targeted at an
   * arbitrary rect (mac-overlay-probe.mjs drives states deterministically). */
  async debugShow(rect: OverlayRect): Promise<void> {
    this.#target = { pid: null, rect };
    await this.#show();
    await this.#seedCursor();
  }

  /** Put the phantom on the controlled window's CENTRE the first time we take
   * an app, before any act has told us where it is going.
   *
   * Without this the pill's first appearance ("Thinking", pushed by the
   * snapshot that starts a session) has no cursor to hang off, and a
   * screen-sized canvas puts "no position" at the desktop's bottom-left corner
   * — a status pill in the corner of the display, nowhere near the app. The old
   * window-sized overlay got the same behaviour for free from its
   * place-at-centre-on-first-message rule, because its centre WAS the window's. */
  async #seedCursor(): Promise<void> {
    const target = this.#target;
    if (target === null || this.#cursorPlaced) return;
    this.#cursorPlaced = true;
    await this.#push('cursor', {
      x: Math.round(target.rect.x + target.rect.w / 2),
      y: Math.round(target.rect.y + target.rect.h / 2),
      ms: 0,
    });
  }

  /** E2E seam: simulate ONE tracker reposition to `rect` synchronously (the
   * same code path a live bounds change takes) so a probe can assert the
   * phantom rides a window move in the SAME tick. */
  async debugRetarget(rect: OverlayRect): Promise<void> {
    if (this.#target === null) return;
    await this.#follow(rect);
  }

  /** Raw panel introspection for probes — the native panel's own view of
   * itself (frame, click-through, focus, collection behavior, cursor, pill). */
  async nativeInfo(): Promise<NativeOverlayInfo | null> {
    const res = await this.#push('info');
    return (res as NativeOverlayInfo | null) ?? null;
  }

  /** Probe seam: paint a solid colour behind the phantom and render the panel's
   * layer tree to a PNG. The panel is transparent, so this is the only way to
   * capture what the overlay actually draws without a Screen Recording grant. */
  async debugBackdrop(
    color: string | null,
    over?: { x: number; y: number; w: number; h: number },
  ): Promise<void> {
    /* `over` pins the ground to the region a caller is about to MEASURE.
       Without it the backdrop follows the phantom, which cannot promise to
       cover someone else's rect — see setBackdrop in Overlay.swift. */
    await this.#push('backdrop', color === null ? {} : { color, ...(over ?? {}) });
  }

  /** Probe seam: order the panel OUT without tearing tracking down, so a
   * screenshot can be rendered with the (opaque, full-desktop) probe backdrop
   * painted and no chance of it reaching a real screen. */
  /** E2E seam for the cross-process ordering experiment. */
  async orderTest(windowId: number, mode = 'read-only'): Promise<unknown> {
    // Deliberately NOT through #push: that swallows errors so a cosmetic
    // failure cannot break a tool call, which is wrong for an experiment.
    try {
      return await this.#panel().request('order-test', { windowId, mode });
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  }

  async debugHidePanel(): Promise<void> {
    await this.#push('hide');
    this.#visible = false;
    this.#announce();
  }

  /** Probe seam: push an occluder set straight to the panel, bypassing the
   * tracker — a deterministic mask for a screenshot, with no bounds poll
   * racing it back to empty. */
  async debugOccluders(rects: OverlayRect[]): Promise<void> {
    this.#lastOccluders = rects;
    await this.#push('occluders', { rects });
  }

  /** Probe seam: hover the pill's buttons without a pointer, so a render can
   * show them. See previewControlsHover in Overlay.swift. */
  async debugControlsHover(on: boolean, hot?: number): Promise<void> {
    await this.#push('controls-hover', { on, ...(hot === undefined ? {} : { hot }) });
  }

  async debugRender(
    path: string,
    crop?: { x: number; y: number; w: number; h: number; scale?: number },
  ): Promise<boolean> {
    const res = (await this.#push('render', { path, ...(crop ?? {}) })) as { ok?: boolean } | null;
    return res?.ok === true;
  }

  async #show(): Promise<void> {
    await this.#push('show');
    this.#visible = true;
    this.#announce();
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
    if (this.#trackTimer !== null && !this.#visible) this.#scheduleTrack(0);
  }

  /** Follow the controlled window: the phantom shifts by the window's ORIGIN
   * delta so it stays glued to the thing it is pointing at. Nothing is
   * repositioned — the panel spans the desktop — so this is one small message,
   * not a window move, and a pure resize (origin unchanged) sends nothing at
   * all. */
  async #follow(fresh: OverlayRect): Promise<void> {
    const target = this.#target;
    if (target === null) return;
    const { dx, dy } = rectDelta(target.rect, fresh);
    target.rect = { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h };
    if (!this.#nativeFollow && (dx !== 0 || dy !== 0)) await this.#push('shift', { dx, dy });
    // The panel keeps the pill inside this rect, so a resize matters as much as
    // a move — send it whenever either changed.
    await this.#pushTarget(target.rect);
  }

  /** Tell the panel which window the phantom belongs to, so the pill stays
   * inside it instead of spilling onto whatever app is beside it. */
  async #pushTarget(rect: OverlayRect | null): Promise<void> {
    const pid = this.#target?.pid ?? null;
    const windowNumber = this.#target?.windowId ?? null;
    const reply = await this.#push(
      'target',
      rect === null
        ? {}
        : {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            ...(pid === null ? {} : { pid }),
            // The panel masks itself against this window's z-order — see trackWindow.
            ...(windowNumber === null ? {} : { windowNumber }),
          },
    );
    const r = reply as { nativeMask?: boolean; nativeFollow?: boolean } | null;
    this.#nativeMask = r?.nativeMask === true;
    this.#nativeFollow = r?.nativeFollow === true;
  }

  async #applyVisibility(show: boolean): Promise<void> {
    if (show === this.#visible) return;
    this.#visible = show;
    this.#announce();
    await this.#push(show ? 'show' : 'hide');
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

  /** One self-rescheduling tracking tick: read the live frame, ride any move,
   * refresh the occluder mask, and apply the app-scoped visibility rule.
   * Re-schedules itself AFTER the async read resolves (never on a fixed
   * interval), so reads can't pile up on the helper pipe. */
  async #trackTick(): Promise<void> {
    const target = this.#target;
    if (target === null || target.pid === null) {
      this.#trackTimer = null;
      return;
    }
    const sample = await this.#readBounds(target.pid);
    // Bail if control was dropped / re-targeted while the read was in flight.
    if (this.#target !== target) return;

    let visible = false;
    if (sample === null) {
      // Window not currently readable (minimized / space animation / quit).
      if (this.#missingSince === null) this.#missingSince = Date.now();
      await this.#applyVisibility(false);
      if (Date.now() - this.#missingSince >= MISSING_GRACE_MS) {
        this.hide();
        return;
      }
    } else {
      this.#missingSince = null;
      if (sample.windowId !== undefined && sample.windowId !== target.windowId) {
        // A new window for the same app (a tab torn off, a dialog) is a new
        // thing to sit above.
        this.#target = { ...target, windowId: sample.windowId };
        await this.#pushTarget(this.#target.rect);
      }
      if (rectsDiffer(target.rect, sample)) await this.#follow(sample);
      this.#lastOccluded = typeof sample.occluded === 'boolean' ? sample.occluded : null;
      if (!this.#nativeMask) await this.#applyOccluders(sample.occluders);
      visible = overlayShouldShow({
        controlledFrontmost: sample.frontmost === true,
        // onScreen === false means the helper SAW the window off the current
        // space (or minimized) even though AX still reports a frame — the
        // phantom must not haunt the space the user switched to.
        appVisible: sample.onScreen !== false,
        driving: this.#isDriving(),
        nativeMask: this.#nativeMask,
        occluded: this.#lastOccluded,
      });
      await this.#applyVisibility(visible);
    }
    this.#scheduleTrack(visible ? FAST_TRACK_MS : SLOW_TRACK_MS);
  }

  /** Push the occluder rects the panel masks itself against, but only when the
   * set actually changed — see occludersDiffer. An absent list (older helper,
   * or a window we could not find in the z-order) leaves the mask alone rather
   * than clearing it to a guess. */
  async #applyOccluders(occluders: OverlayOccluders | undefined): Promise<void> {
    if (occluders === undefined) return;
    if (!occludersDiffer(this.#lastOccluders, occluders)) return;
    this.#lastOccluders = occluders.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    await this.#push('occluders', { rects: this.#lastOccluders });
  }

  // ── action-driven states (called by mac-agent dispatch) ────────────────

  /** Glide the cursor to a screen point and wait out the travel. */
  async moveCursor(screenX: number, screenY: number): Promise<void> {
    if (this.#target === null) return;
    this.#armIdle();
    this.#cursorPlaced = true;
    this.#cursor = { x: screenX, y: screenY };
    await this.#push('cursor', { x: screenX, y: screenY, ms: CURSOR_TRAVEL_MS });
    await sleep(CURSOR_TRAVEL_MS);
    this.#announce();
  }

  /** Click feedback at a screen point: a quick press of the cursor glyph. `label`
   * is what was clicked, which the pill shows. */
  async clickAt(screenX: number, screenY: number, label = ''): Promise<void> {
    if (this.#target === null) return;
    this.#armIdle();
    this.#cursor = { x: screenX, y: screenY };
    this.#note('clicking', label);
    await this.#push('click', { x: screenX, y: screenY });
    this.#revertSoon();
    this.#announce();
  }

  /** Live-typing pill (previewing the text) at the cursor. */
  async typing(text: string): Promise<void> {
    this.#armIdle();
    this.#note('typing', typingPreview(text));
    await this.#push('status', { status: 'typing', text: typingPreview(text) });
    this.#announce();
  }

  async keyPress(combo: string): Promise<void> {
    this.#armIdle();
    this.#note('pressing', comboLabel(combo));
    await this.#push('status', { status: 'pressing', text: comboLabel(combo) });
    this.#revertSoon();
    this.#announce();
  }

  async scrolling(): Promise<void> {
    this.#armIdle();
    this.#note('scrolling');
    await this.#push('status', { status: 'scrolling' });
    this.#revertSoon();
    this.#announce();
  }

  async opening(appName: string): Promise<void> {
    this.#armIdle();
    this.#note('opening', `Opening ${appName}`);
    await this.#push('status', { status: 'opening', text: `Opening ${appName}` });
    this.#announce();
  }

  /** The resting state between actions: the model is deciding what to do. */
  async thinking(): Promise<void> {
    this.#clearRevert();
    this.#armIdle();
    this.#note('thinking');
    await this.#push('status', { status: 'thinking' });
    this.#announce();
  }

  /**
   * An image is being ingested — 0...1, or null when it finishes.
   *
   * the user: "when an image is prefilling it should expand horizontally and show a
   * prefill % ring and 'processing' text". Ingesting a screenshot is the one
   * wait long enough to be worth explaining rather than hiding behind dots.
   */
  async prefill(fraction: number | null): Promise<void> {
    if (fraction === this.#prefill) return;
    this.#prefill = fraction;
    await this.#push('prefill', fraction === null ? {} : { fraction });
  }
  #prefill: number | null = null;

  /**
   * Show the pill at all. Off means the phantom cursor still moves and clicks —
   * that is the part that shows what is happening — but nothing writes words
   * over the user's own windows.
   */
  async setPillEnabled(on: boolean): Promise<void> {
    if (on === this.#pillEnabled) return;
    this.#pillEnabled = on;
    await this.#push('pill', { enabled: on });
  }
  #pillEnabled = true;

  /** Looking at the screen — a snapshot, not an act on anything. */
  async reading(): Promise<void> {
    this.#armIdle();
    this.#note('reading');
    await this.#push('status', { status: 'reading' });
    this.#revertSoon();
    this.#announce();
  }

  /** Remember the pill we just pushed. */
  #note(state: MacCursorState, text = ''): void {
    this.#cursorState = state;
    this.#statusText = text;
  }

  /**
   * Everything the phantom is doing, for the canvas monitor — the same shape
   * the BrowserWindow overlay reported, so monitor-core is unchanged.
   */
  state(): MacOverlayState {
    return {
      engaged: this.#target !== null,
      pid: this.#target?.pid ?? null,
      rect: this.#target?.rect ?? null,
      cursor: this.#cursorPlaced ? this.#cursor : null,
      cursorState: this.#cursorState,
      statusText: this.#statusText,
      bubbleVisible: this.#visible && this.#cursorState !== 'idle',
      wantsVisible: this.#visible,
    };
  }

  #revertSoon(): void {
    this.#clearRevert();
    this.#revertTimer = setTimeout(() => {
      this.#note('thinking');
      void this.#push('status', { status: 'thinking' });
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
   * silence the pill hides (the cursor rests in place, still visible). Also
   * marks the model as actively driving, which keeps the overlay visible (see
   * overlayShouldShow) even while the controlled app is backgrounded. */
  #armIdle(): void {
    this.#markActivity();
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      void this.#push('hideBubble');
    }, BUBBLE_IDLE_MS);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  /** Info for probes/assertions. Cheap and synchronous — main's own view of
   * the overlay (what it is tracking and whether it asked for it to be shown).
   * The panel's own truth is nativeInfo(). */
  /** Call `fn` whenever the phantom engages or disengages. The whole state
   * goes with it: the canvas monitor mirrors the phantom from this, so half of
   * it would leave the two surfaces drawing different things. */
  watch(fn: (state: MacOverlayState) => void): void {
    this.#watchers.push(fn);
    fn(this.state());
  }

  /**
   * Tell the watchers whenever the phantom's STATE changed — not just when it
   * appeared or disappeared.
   *
   * the user, watching the Apple run: "you can see it finally has selected the 2tb
   * option, and yet, the mouse cursor didn't move at all, the click happened
   * invisibly." This was mine: the old BrowserWindow overlay pushed its state
   * continuously, and when the native panel replaced it I made the notification
   * fire on visibility alone. So the canvas monitor — which draws the same
   * phantom over a picture of the window — was frozen from the moment it became
   * visible, and every move and click after that happened off-screen.
   *
   * Compared on the whole state rather than one flag, and cheap: this is a
   * handful of numbers and two short strings.
   */
  #announce(): void {
    const snapshot = this.state();
    const key = JSON.stringify(snapshot);
    if (key === this.#announced) return;
    this.#announced = key;
    for (const fn of this.#watchers) {
      try {
        fn(snapshot);
      } catch {
        /* a watcher that throws must not take the overlay down with it */
      }
    }
  }
  #announced: string | null = null;

  info(): {
    visible: boolean;
    bounds: OverlayRect | null;
    trackingPid: number | null;
    occluded: boolean | null;
    occluders: number;
  } {
    return {
      visible: this.#visible,
      bounds: this.#target?.rect ?? null,
      trackingPid: this.#target?.pid ?? null,
      occluded: this.#lastOccluded,
      occluders: this.#lastOccluders?.length ?? 0,
    };
  }

  /** Put the phantom away: the panel stays spawned (respawning it per app is
   * pure latency in the middle of a run) but is ordered out and cleared. */
  hide(): void {
    this.#clearRevert();
    this.#clearIdle();
    this.#stopTracking();
    this.#target = null;
    void this.#pushTarget(null);
    this.#missingSince = null;
    this.#lastActivityAt = null;
    this.#lastOccluded = null;
    this.#lastOccluders = null;
    this.#visible = false;
    this.#announce();
    this.#cursorPlaced = false;
    this.#cursor = null;
    this.#note('idle');
    void this.#push('reset');
  }

  dispose(): void {
    this.hide();
    const client = this.#client;
    this.#client = null;
    // dispose() ends stdin and SIGTERMs the child; the panel process also exits
    // on its own when stdin closes, so a hard kill is never the normal path.
    client?.dispose();
  }
}

/** The app-wide overlay singleton (one controlled app at a time — matches the
 * single long-lived pi-mac helper). */
export const macOverlay = new MacOverlayController();
