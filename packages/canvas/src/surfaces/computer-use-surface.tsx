/**
 * ComputerUseSurface — the live view of the Mac app Pi is driving.
 *
 * the user, verbatim: "a canvas tab that shows the whole window + dialogs or
 * whatever it is live streamed into the canvas in this computer use monitoring
 * tab, if the window is not sized, show it in full but show the user's desktop
 * background wallpaper behind it (center the window and keep it sized exactly
 * how it is in reality)."
 *
 * So: the user's own wallpaper as the ground, dimmed so it reads as context
 * rather than content; the captured window floating on it at its REAL point
 * size, centred, scaled DOWN only when the tab is too small to hold it; and the
 * phantom cursor + status bubble drawn on top at the mapped screen point, so
 * what is in this tab and what is on the user's screen are the same object.
 *
 * ── WHY A CANVAS, AND WHY NO REACT STATE PER FRAME ──────────────────────────
 * Frames arrive at 12fps as JPEG bytes. Decoding to an ImageBitmap and blitting
 * is one draw call; putting the frame in React state would repaint the rail
 * forty times a minute to move one picture. So the feed is imperative
 * (computer-use-feed.ts), React holds only the session, and the paint loop is a
 * rAF that runs solely while the surface is mounted AND the document is
 * visible. Nothing queues: a frame that arrives while an older one is still
 * being drawn replaces it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AxDrawable,
  ellipsize,
  idleCursorDrift,
  layoutAxScene,
  type MonitorSource,
  pickMonitorSource,
  restingCursor,
  wrapText,
} from './computer-use-ax.ts';
import {
  IDLE_MAC_MONITOR_SESSION,
  type MacMonitorAxScene,
  type MacMonitorAxWindow,
  type MacMonitorCursorState,
  type MacMonitorFeed,
  type MacMonitorSessionState,
} from './computer-use-feed.ts';
import {
  annotationScale,
  bubbleAnchor,
  coverCrop,
  cursorEase,
  type DrawnWindow,
  fitWindow,
} from './computer-use-geometry.ts';

export interface ComputerUseSurfaceProps {
  /** The live frame source. Absent → the calm "nothing to watch" state. */
  feed?: MacMonitorFeed;
  className?: string;
}

/**
 * The shared Pi agent cursor. SYNC: apps/desktop/electron/mac/overlay.html and
 * apps/desktop/electron/canvas/agent-cursor.ts — one glyph for "Pi is driving",
 * whether it is driving a web page, a Mac app, or the picture of one in here.
 */
const CURSOR_PATH =
  'M 10.01 13.12 Q 8.00 8.00 13.04 10.21 L 30.55 17.89 Q 36.50 20.50 30.03 21.17 ' +
  'L 25.48 21.64 Q 22.00 22.00 20.85 25.31 L 19.64 28.78 Q 18.00 33.50 16.17 28.85 Z';
/** overlay.html renders the 26.56×24.21 viewBox at 34×31 with the tip inset. */
const CURSOR_VIEWBOX = { x: 8.14, y: 8.24, w: 26.56, h: 24.21 };
const CURSOR_BOX = { w: 34, h: 31 };
const CURSOR_TIP = { x: 2.9, y: 1.6 };
/** Matches CURSOR_TRAVEL_MS in overlay-window.ts. */
const CURSOR_TRAVEL_MS = 300;
/** How long a click ripple lives (overlay.html's .ripple transition). */
const RIPPLE_MS = 620;
/** Corner radius of a macOS window, at real size. */
const WINDOW_RADIUS = 11;
/** Breathing room kept around a window that has to be scaled down. */
const STAGE_PADDING = 18;

interface Palette {
  ground: string;
  accent: string;
  text: string;
}

const FALLBACK_PALETTE: Palette = { ground: '#17181b', accent: '#4d8df6', text: '#f2f2f2' };

/** Read the three theme tokens the canvas paints with (it cannot use `var()`). */
function readPalette(el: HTMLElement | null): Palette {
  if (el === null || typeof window === 'undefined' || !window.getComputedStyle) {
    return FALLBACK_PALETTE;
  }
  const cs = window.getComputedStyle(el);
  const pick = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v === '' ? fallback : v;
  };
  return {
    ground: pick('--pd-bg-inset', FALLBACK_PALETTE.ground),
    accent: pick('--pd-accent-primary', FALLBACK_PALETTE.accent),
    text: pick('--pd-text-primary', FALLBACK_PALETTE.text),
  };
}

/** The bubble's words — the same seven cases overlay.html's STATUS map paints. */
function bubbleText(state: MacMonitorCursorState, text: string): { label: string; detail: string } {
  switch (state) {
    case 'opening':
      return { label: text === '' ? 'Opening' : text, detail: '' };
    case 'thinking':
      return { label: 'Thinking', detail: '' };
    case 'clicking':
      return { label: 'Clicking', detail: '' };
    case 'typing':
      return { label: 'Typing', detail: text };
    case 'pressing':
      return { label: `Pressing ${text}`.trimEnd(), detail: '' };
    case 'scrolling':
      return { label: 'Scrolling', detail: '' };
    case 'reading':
      return { label: 'Reading the screen', detail: '' };
    default:
      return { label: '', detail: '' };
  }
}

const DOTTED: ReadonlySet<MacMonitorCursorState> = new Set([
  'thinking',
  'typing',
  'opening',
  'scrolling',
  'reading',
]);

interface BackdropCache {
  canvas: HTMLCanvasElement | null;
  source: HTMLImageElement | ImageBitmap | null;
  w: number;
  h: number;
  dpr: number;
}

/**
 * The wallpaper, rendered once per (image, size) and reused.
 *
 * the user, verbatim: "don't blur the wallpaper please." It used to be blurred 4px,
 * washed 58% black and vignetted 42% — three treatments to push it back, which
 * between them turned the user's own desktop into grey soup and made the tab
 * look like a modal scrim rather than a desk. It is now DRAWN AS IT IS, and the
 * window reads as the subject the way a real window does: by being sharp,
 * bright and casting a shadow onto it.
 *
 * The one thing left is a whisper of a vignette — a tenth of what it was — that
 * only touches the far corners. It exists because a canvas rail is a small,
 * hard-edged box and a photograph running dead flat into that edge reads as a
 * cropped picture; this gives it somewhere to end. Nothing is dimmed where the
 * window sits.
 *
 * Returns null when there is no wallpaper — the caller's flat ground colour is
 * then the whole backdrop, which is a deliberate surface rather than a hole.
 */
function ensureBackdrop(
  cache: { current: BackdropCache },
  source: HTMLImageElement | ImageBitmap | null,
  cssW: number,
  cssH: number,
  dpr: number,
): HTMLCanvasElement | null {
  const c = cache.current;
  if (source === null) {
    c.canvas = null;
    c.source = null;
    return null;
  }
  if (c.canvas !== null && c.source === source && c.w === cssW && c.h === cssH && c.dpr === dpr) {
    return c.canvas;
  }
  const off = c.canvas ?? document.createElement('canvas');
  off.width = Math.max(1, Math.round(cssW * dpr));
  off.height = Math.max(1, Math.round(cssH * dpr));
  const g = off.getContext('2d');
  if (g === null) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const crop = coverCrop({ w: source.width, h: source.height }, { w: cssW, h: cssH });
  g.drawImage(source as CanvasImageSource, crop.x, crop.y, crop.w, crop.h, 0, 0, cssW, cssH);
  const vignette = g.createRadialGradient(
    cssW / 2,
    cssH / 2,
    Math.min(cssW, cssH) * 0.52,
    cssW / 2,
    cssH / 2,
    Math.max(cssW, cssH) * 0.86,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.2)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, cssW, cssH);
  cache.current = { canvas: off, source, w: cssW, h: cssH, dpr };
  return off;
}

// ── the Accessibility-drawn window ──────────────────────────────────────────
//
// The palette of a light macOS window, which is what the fallback draws on
// (AX reports no colours, and a document window is white on every Mac that has
// not been deliberately changed). Named rather than inlined because the whole
// point of this surface is that everything on it is either something AX said or
// something acknowledged here as chrome.
const AX_PAPER = '#ffffff';
const AX_TITLE_TOP = '#f4f4f6';
const AX_TITLE_BOTTOM = '#e6e6e9';
const AX_HAIRLINE = 'rgba(0, 0, 0, 0.14)';
const AX_CONTROL = '#fdfdfe';
const AX_CONTROL_EDGE = 'rgba(0, 0, 0, 0.2)';
const AX_INK = '#1d1d20';
const AX_INK_SOFT = 'rgba(29, 29, 32, 0.62)';
const AX_DISABLED = 'rgba(29, 29, 32, 0.3)';
const AX_LIGHTS = ['#ec6a5e', '#f4bf4f', '#61c554'];
/** System font stack for anything drawn inside the fake window. */
const AX_FONT = '-apple-system, "SF Pro Text", system-ui, sans-serif';

interface AxRender {
  canvas: HTMLCanvasElement | null;
  /** What was drawn: scene timestamp + the geometry it was drawn for. */
  key: string;
}

/** No drift. A shared frozen object so the hot path allocates nothing. */
const ZERO = { x: 0, y: 0 } as const;

/**
 * Render the Accessibility scene into an offscreen canvas, reusing the last one
 * whenever nothing that affects it has changed.
 *
 * The key includes the caret's blink phase, which is what keeps a focused text
 * area's insertion point alive at 1Hz without re-rendering the scene sixty
 * times a second to animate one 2px rectangle.
 */
function ensureAxRender(
  cache: { current: AxRender },
  scene: MacMonitorAxScene,
  drawn: DrawnWindow,
  viewport: { w: number; h: number },
  dpr: number,
  accent: string,
  now: number,
): HTMLCanvasElement | null {
  const blink = Math.floor(now / 530);
  const key = [
    scene.t,
    scene.windows.length,
    scene.elements.length,
    Math.round(drawn.x),
    Math.round(drawn.y),
    Math.round(drawn.w),
    Math.round(drawn.h),
    drawn.scale.toFixed(4),
    Math.round(viewport.w),
    Math.round(viewport.h),
    dpr,
    accent,
    blink,
  ].join('|');
  const c = cache.current;
  if (c.canvas !== null && c.key === key) return c.canvas;
  const cssW = viewport.w;
  const cssH = viewport.h;
  const off = c.canvas ?? document.createElement('canvas');
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (off.width !== pxW || off.height !== pxH) {
    off.width = pxW;
    off.height = pxH;
  }
  const g = off.getContext('2d');
  if (g === null) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  drawAxScene(g, scene, drawn, accent, now);
  cache.current = { canvas: off, key };
  return off;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function ComputerUseSurface({ feed, className }: ComputerUseSurfaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState<MacMonitorSessionState>(
    () => feed?.getSession() ?? IDLE_MAC_MONITOR_SESSION,
  );
  const [fps, setFps] = useState(0);
  const [windowTitle, setWindowTitle] = useState('');
  /** The frontmost sheet/dialog the app has open, named — a save panel IS part
   * of the app, and the footer should say so rather than quietly renaming the
   * window. */
  const [dialogTitle, setDialogTitle] = useState('');
  /** Which source is on screen. React state (not a ref) because the honest
   * "this is a drawing" label is chrome, and chrome lives in the DOM. */
  const [source, setSource] = useState<MonitorSource>('none');
  const paletteRef = useRef<Palette>(FALLBACK_PALETTE);
  const backdropRef = useRef<BackdropCache>({
    canvas: null,
    source: null,
    w: 0,
    h: 0,
    dpr: 1,
  });
  /**
   * The Accessibility scene, rendered once per (scene, geometry) into an
   * offscreen and blitted after that.
   *
   * The scene changes 4 times a second and the phantom cursor moves 60, so
   * re-running two hundred canvas ops per animation frame would be paying the
   * expensive part fifteen times over for a picture that has not changed.
   */
  const axRef = useRef<AxRender>({ canvas: null, key: '' });
  const cursorPath = useMemo(
    () => (typeof Path2D === 'function' ? new Path2D(CURSOR_PATH) : null),
    [],
  );

  /** The cursor's glide: where it was, where it is going, when it started. */
  const glide = useRef<{
    from: { x: number; y: number } | null;
    to: { x: number; y: number } | null;
    startedAt: number;
  }>({ from: null, to: null, startedAt: 0 });
  const lastClick = useRef(0);
  const lastState = useRef<MacMonitorCursorState>('idle');
  /** The last place the phantom actually WAS, so an idle turn leaves it there
   * instead of teleporting it to a default corner. */
  const lastCursor = useRef<{ x: number; y: number } | null>(null);
  const dirty = useRef(true);

  // ── palette (re-read when the theme changes) ─────────────────────────────
  useEffect(() => {
    const refresh = (): void => {
      paletteRef.current = readPalette(rootRef.current);
      dirty.current = true;
    };
    refresh();
    if (typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => mo.disconnect();
  }, []);

  // ── the feed: mount = subscribe, unmount = stop the capture ──────────────
  useEffect(() => {
    if (feed === undefined) return;
    const visible = (): boolean =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden';
    feed.setActive(visible());
    const onVisibility = (): void => feed.setActive(visible());
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribe = feed.subscribe(() => {
      dirty.current = true;
      const next = feed.getSession();
      setSession((prev) => (sameSession(prev, next) ? prev : next));
      const frame = feed.getFrame();
      const ax = feed.getAxScene();
      const nextSource = pickMonitorSource(next, frame, ax);
      setSource((prev) => (prev === nextSource ? prev : nextSource));
      // The footer names whatever the picture is OF, from whichever source drew
      // it — the window list is the same list either way.
      const windows =
        nextSource === 'accessibility' && ax !== null ? ax.windows : (frame?.windows ?? []);
      const main = windows.find((w) => !w.sheet && !w.modal) ?? windows[0];
      const dialog = windows.find((w) => w.sheet || w.modal);
      // A window title outlives its session otherwise, and the footer ends up
      // reading "No app · Untitled 2 — Edited" over an empty state.
      const mainName = next.active && main !== undefined ? main.title : '';
      const dialogName = next.active && dialog !== undefined ? dialog.title : '';
      setWindowTitle((prev) => (prev === mainName ? prev : mainName));
      setDialogTitle((prev) => (prev === dialogName ? prev : dialogName));
    });
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      feed.setActive(false);
    };
  }, [feed]);

  // A calm 2Hz fps readout — the number itself must not cause a repaint storm.
  useEffect(() => {
    if (feed === undefined) return;
    const id = window.setInterval(() => {
      const next = Math.round(feed.getFps());
      setFps((prev) => (prev === next ? prev : next));
    }, 500);
    return () => window.clearInterval(id);
  }, [feed]);

  // ── the paint loop ───────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (canvas === null || root === null) return;
    const cssW = root.clientWidth;
    const cssH = root.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
      dirty.current = true;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const palette = paletteRef.current;
    const viewport = { w: cssW, h: cssH };

    // 1. The ground. A plain wash under the wallpaper so a missing or still-
    //    loading picture is a deliberate surface, never a white flash.
    ctx.fillStyle = palette.ground;
    ctx.fillRect(0, 0, cssW, cssH);

    // 2. The wallpaper: the desk the app is sitting on. NOT blurred and not
    //    dimmed — the user, verbatim: "don't blur the wallpaper please." The window
    //    reads as the subject by being sharp and casting a shadow onto it, the
    //    way a real window does, rather than by everything else being smeared.
    //    Still rendered once into an offscreen and blitted: a cover-crop of a
    //    5K picture per animation frame is not free either.
    const backdrop = ensureBackdrop(backdropRef, feed?.getWallpaper() ?? null, cssW, cssH, dpr);
    if (backdrop !== null) ctx.drawImage(backdrop, 0, 0, cssW, cssH);

    const frame = feed?.getFrame() ?? null;
    const ax = feed?.getAxScene() ?? null;
    const from = pickMonitorSource(session, frame, ax);
    // The stage is the union rect of whichever source is drawing — computed the
    // same way on both sides, so a switch between them moves nothing.
    const rect = from === 'accessibility' && ax !== null ? ax.rect : (frame?.rect ?? session.rect);
    const bitmap = frame?.bitmap ?? null;
    if (rect === null || rect.w <= 0 || rect.h <= 0) return;

    // 3. The window, at REAL point size, centred, never upscaled.
    const drawn = fitWindow(rect, viewport, STAGE_PADDING);
    const radius = WINDOW_RADIUS * drawn.scale;
    const now = performance.now();
    if (from === 'pixels' && bitmap !== null) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = 42 * drawn.scale + 8;
      ctx.shadowOffsetY = 16 * drawn.scale + 2;
      ctx.fillStyle = 'rgba(0,0,0,0.9)';
      roundRect(ctx, drawn.x, drawn.y, drawn.w, drawn.h, radius);
      ctx.fill();
      ctx.restore();

      ctx.save();
      roundRect(ctx, drawn.x, drawn.y, drawn.w, drawn.h, radius);
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, drawn.x, drawn.y, drawn.w, drawn.h);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      roundRect(ctx, drawn.x + 0.5, drawn.y + 0.5, drawn.w - 1, drawn.h - 1, radius);
      ctx.stroke();
    } else if (from === 'accessibility' && ax !== null) {
      const rendered = ensureAxRender(axRef, ax, drawn, viewport, dpr, palette.accent, now);
      if (rendered !== null) ctx.drawImage(rendered, 0, 0, cssW, cssH);
    }

    // 4. The phantom. ALWAYS, whenever there is a window for it to be on —
    //    the user: "always show the fake cursor around there even if just idling,
    //    looks nice and makes it feel like 'this is the model's computer'." With
    //    no live position it rests where it last actually was (or, having never
    //    been anywhere, where a hand would leave a mouse) and breathes. It is
    //    still never drawn over BARE WALLPAPER: with no window, a mapped
    //    position means nothing and the phantom would claim to be somewhere.
    if (from !== 'none') {
      if (session.cursor !== null) lastCursor.current = session.cursor;
      const live = session.cursor !== null;
      const target = session.cursor ?? restingCursor(rect, lastCursor.current);
      const g = glide.current;
      if (g.to === null || g.to.x !== target.x || g.to.y !== target.y) {
        g.from = g.to ?? target;
        g.to = target;
        g.startedAt = now;
      }
      const t = Math.min(1, (now - g.startedAt) / CURSOR_TRAVEL_MS);
      const eased = cursorEase(t);
      const was = g.from ?? target;
      const screen = {
        x: was.x + (target.x - was.x) * eased,
        y: was.y + (target.y - was.y) * eased,
      };
      // The idle breath is applied in CANVAS pixels, after the mapping: it is a
      // property of the drawing, not a claim that the cursor moved on screen.
      const drift = live && session.cursorState !== 'idle' ? ZERO : idleCursorDrift(now);
      const at = {
        x: drawn.x + (screen.x - rect.x) * drawn.scale + drift.x,
        y: drawn.y + (screen.y - rect.y) * drawn.scale + drift.y,
      };
      const k = annotationScale(drawn.scale);

      const sinceClick = now - lastClick.current;
      if (sinceClick < RIPPLE_MS) drawRipples(ctx, at, k, sinceClick, palette.accent);
      if (cursorPath !== null) {
        // Resting reads as resting: a hair smaller and a touch transparent, so
        // an idle phantom is calm rather than merely stationary.
        const resting = !live || session.cursorState === 'idle';
        ctx.save();
        if (resting) ctx.globalAlpha = 0.82;
        drawCursor(ctx, cursorPath, at, resting ? k * 0.94 : k, sinceClick);
        ctx.restore();
      }
      if (session.bubbleVisible && session.cursorState !== 'idle') {
        drawBubble(ctx, at, k, viewport, session, palette);
      }
      // Something is always moving now (the breath, the caret), so the loop is
      // kept awake rather than woken by each individual change.
      dirty.current = true;
    }
  }, [cursorPath, feed, session]);

  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      if (dirty.current) {
        dirty.current = false;
        draw();
      }
      raf = requestAnimationFrame(tick);
    };
    dirty.current = true;
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // Any layout change repaints; the canvas backing store resizes inside draw().
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      dirty.current = true;
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // A click has a moment, not a duration — remember when the state entered it.
  useEffect(() => {
    if (session.cursorState === 'clicking' && lastState.current !== 'clicking') {
      lastClick.current = performance.now();
    }
    lastState.current = session.cursorState;
    dirty.current = true;
  }, [session.cursorState]);

  const drawnFromAx = source === 'accessibility';
  const empty = drawnFromAx ? null : emptyState(session, feed?.getFrame() ?? null);
  const rootClass = ['pd-macmon', className].filter(Boolean).join(' ');
  const live = session.stream === 'live';

  return (
    <div
      className={rootClass}
      ref={rootRef}
      data-testid="computer-use-surface"
      data-source={source}
    >
      <canvas className="pd-macmon-canvas" ref={canvasRef} aria-label="Controlled app, live view" />
      {drawnFromAx ? (
        <SourceNote denied={session.captureDenied} onTurnOn={() => feed?.requestCapture?.()} />
      ) : null}
      {empty === null ? null : (
        <div className="pd-macmon-state" data-kind={empty.kind}>
          <div className="pd-macmon-state-card">
            <div className="pd-macmon-state-mark" aria-hidden="true">
              <ScreenGlyph pulse={empty.kind === 'waiting'} />
            </div>
            <p className="pd-macmon-state-title">{empty.title}</p>
            <p className="pd-macmon-state-sub">{empty.sub}</p>
          </div>
        </div>
      )}
      <div className="pd-macmon-footer">
        <span className="pd-macmon-app">{session.appName === '' ? 'No app' : session.appName}</span>
        {windowTitle === '' ? null : (
          <>
            <span className="pd-macmon-sep" aria-hidden="true" />
            <span className="pd-macmon-title" title={windowTitle}>
              {windowTitle}
            </span>
          </>
        )}
        {dialogTitle === '' ? null : (
          <span className="pd-macmon-dialog" title={`${dialogTitle} dialog`}>
            {dialogTitle}
          </span>
        )}
        <span className="pd-macmon-spacer" />
        <span
          className="pd-macmon-live"
          data-live={live ? 'true' : 'false'}
          data-drawn={drawnFromAx ? 'true' : 'false'}
        >
          <span className="pd-macmon-dot" aria-hidden="true" />
          {live ? 'Live' : drawnFromAx ? 'Drawn live' : streamWord(session.stream)}
        </span>
        {live && fps > 0 ? <span className="pd-macmon-fps">{fps} fps</span> : null}
      </div>
    </div>
  );
}

/**
 * "This is a drawing, and here is why."
 *
 * The one thing this surface must never do is pass a rendering off as a
 * photograph, so it says what it is, on its face, permanently — not as a toast
 * that goes away and not as an error the picture is hiding behind. Quiet enough
 * to be furniture after the first read: one line, one glyph, one thing to press.
 *
 * The button OPENS the Screen Recording pane. It is deliberately not phrased as
 * "allow" or "grant": no app can turn this on, and a button that implies it can
 * is the kind of small lie that makes people stop trusting the big things.
 */
function SourceNote({ denied, onTurnOn }: { denied: boolean; onTurnOn: () => void }) {
  return (
    <div className="pd-macmon-source" data-testid="macmon-source-note">
      <span className="pd-macmon-source-mark" aria-hidden="true">
        <TreeGlyph />
      </span>
      <span className="pd-macmon-source-text">
        Drawn from Accessibility
        {denied ? (
          <>
            <span className="pd-macmon-source-sep" aria-hidden="true">
              ·
            </span>
            <span className="pd-macmon-source-why">Screen Recording is off</span>
          </>
        ) : null}
      </span>
      {denied ? (
        <button type="button" className="pd-macmon-source-action" onClick={onTurnOn}>
          Turn on
        </button>
      ) : null}
    </div>
  );
}

/** A window with its parts picked out — "structure, not pixels", as a glyph. */
function TreeGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.9" />
      <path d="M1.6 5.6h12.8" />
      <rect x="3.9" y="7.6" width="4.2" height="3.6" rx="0.9" />
      <path d="M10 8.4h2.3M10 10.6h2.3" />
    </svg>
  );
}

function streamWord(stream: MacMonitorSessionState['stream']): string {
  switch (stream) {
    case 'starting':
      return 'Connecting';
    case 'no-window':
      return 'No window';
    case 'unavailable':
      return 'Not streaming';
    default:
      return 'Idle';
  }
}

/** Shallow-compare the session so an unchanged push does not re-render. */
function sameSession(a: MacMonitorSessionState, b: MacMonitorSessionState): boolean {
  return (
    a.active === b.active &&
    a.appName === b.appName &&
    a.stream === b.stream &&
    a.streamError === b.streamError &&
    a.wallpaperUrl === b.wallpaperUrl &&
    a.statusText === b.statusText &&
    a.cursorState === b.cursorState &&
    a.bubbleVisible === b.bubbleVisible &&
    a.captureDenied === b.captureDenied &&
    a.cursor?.x === b.cursor?.x &&
    a.cursor?.y === b.cursor?.y &&
    a.rect?.x === b.rect?.x &&
    a.rect?.y === b.rect?.y &&
    a.rect?.w === b.rect?.w &&
    a.rect?.h === b.rect?.h
  );
}

interface EmptyState {
  kind: 'idle' | 'waiting' | 'no-window' | 'unavailable';
  title: string;
  sub: string;
}

/**
 * Which "nothing to draw" this is. Each one is a different fact and deserves
 * different words — "no app is being driven" and "the app has no window open"
 * look identical on screen and mean completely different things.
 */
function emptyState(
  session: MacMonitorSessionState,
  frame: { bitmap: ImageBitmap | null } | null,
): EmptyState | null {
  const app = session.appName === '' ? 'the app' : session.appName;
  if (!session.active) {
    return {
      kind: 'idle',
      title: 'Nothing is being controlled',
      sub: 'This view wakes up when Bobble takes control of a Mac app.',
    };
  }
  if (session.stream === 'unavailable') {
    // Reached only when the Accessibility drawing has nothing either — the app
    // is between windows, or the tree came back empty. With a scene in hand the
    // surface draws it instead and this panel never appears.
    return {
      kind: 'unavailable',
      title: session.captureDenied ? 'Screen Recording is off' : 'Live view unavailable',
      sub: session.captureDenied
        ? `Bobble is still in control of ${app}. The view returns as soon as it can read a window.`
        : (session.streamError ?? `The screen capture for ${app} could not start.`),
    };
  }
  if (session.stream === 'no-window') {
    return {
      kind: 'no-window',
      title: `${app} has no window on screen`,
      sub: 'Pi is still in control — the view returns when a window opens.',
    };
  }
  if (frame?.bitmap == null) {
    return {
      kind: 'waiting',
      title: `Connecting to ${app}`,
      sub: 'Waiting for the first frame.',
    };
  }
  return null;
}

/** A quiet display glyph for the empty states — same stroke anatomy as the icons. */
function ScreenGlyph({ pulse }: { pulse: boolean }) {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={pulse ? 'pd-macmon-glyph-pulse' : undefined}
    >
      <rect x="2.5" y="4" width="19" height="13" rx="2.2" />
      <path d="M9 20.5h6M12 17v3.5" />
    </svg>
  );
}

// ── the Accessibility drawing ───────────────────────────────────────────────

/**
 * Draw the whole scene: every window, back to front, at its real frame.
 *
 * `origin`/`scale` map screen points into the canvas exactly as the pixel path
 * maps them, because they ARE the pixel path's — `fitWindow` over the same
 * union rect. Switching source therefore cannot move anything.
 *
 * Everything below is a likeness of macOS chrome, drawn from geometry AX
 * reported. No control gets a label the tree did not name, no field gets text
 * it did not return, and a window with nothing in it is drawn empty rather than
 * furnished.
 */
function drawAxScene(
  ctx: CanvasRenderingContext2D,
  scene: MacMonitorAxScene,
  drawn: DrawnWindow,
  accent: string,
  now: number,
): void {
  const k = drawn.scale;
  const at = (x: number, y: number): { x: number; y: number } => ({
    x: drawn.x + (x - scene.rect.x) * k,
    y: drawn.y + (y - scene.rect.y) * k,
  });
  for (const layout of layoutAxScene(scene)) {
    const p = at(layout.rect.x, layout.rect.y);
    const w = layout.rect.w * k;
    const h = layout.rect.h * k;
    if (w < 2 || h < 2) continue;
    const sheet = layout.titleBar === 0;
    const radius = (sheet ? 12 : WINDOW_RADIUS) * k;

    // The window's own shadow. A sheet sits ON the window behind it, so it
    // needs a tighter, darker one to lift off a surface rather than off a
    // wallpaper — which is exactly how a real sheet reads.
    ctx.save();
    ctx.shadowColor = sheet ? 'rgba(0, 0, 0, 0.42)' : 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = (sheet ? 34 : 44) * k + 8;
    ctx.shadowOffsetY = (sheet ? 12 : 16) * k + 2;
    ctx.fillStyle = AX_PAPER;
    roundRect(ctx, p.x, p.y, w, h, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, p.x, p.y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = AX_PAPER;
    ctx.fillRect(p.x, p.y, w, h);
    if (!sheet) {
      const barH = layout.titleBar * k;
      // Controls that LIVE IN the title bar — TextEdit's "Edited"/"Suggested"
      // filename popup is one — get out of the title's way, because AppKit
      // gives way to them too. Without this the title is drawn straight
      // through a real control at its real position.
      const blockers = layout.elements
        .map((it) => {
          const q = at(it.rect.x, it.rect.y);
          return { x: q.x, y: q.y, w: it.rect.w * k, h: it.rect.h * k };
        })
        .filter((r) => r.y < p.y + barH && r.y + r.h > p.y);
      drawAxTitleBar(ctx, layout.win, p, w, barH, k, blockers);
    }
    for (const item of layout.elements) {
      drawAxElement(ctx, item, at, k, accent, now);
    }
    ctx.restore();

    ctx.strokeStyle = sheet ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    roundRect(ctx, p.x + 0.5, p.y + 0.5, w - 1, h - 1, radius);
    ctx.stroke();
  }
}

/** Title bar: the gradient, the hairline, the three lights, the real title. */
function drawAxTitleBar(
  ctx: CanvasRenderingContext2D,
  win: MacMonitorAxWindow,
  p: { x: number; y: number },
  w: number,
  barH: number,
  k: number,
  blockers: readonly { x: number; w: number }[] = [],
): void {
  const grad = ctx.createLinearGradient(p.x, p.y, p.x, p.y + barH);
  grad.addColorStop(0, AX_TITLE_TOP);
  grad.addColorStop(1, AX_TITLE_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(p.x, p.y, w, barH);
  ctx.fillStyle = AX_HAIRLINE;
  ctx.fillRect(p.x, p.y + barH - Math.max(1, k), w, Math.max(1, k));

  const r = 6 * k;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(p.x + (20 + i * 20) * k, p.y + barH / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = AX_LIGHTS[i] as string;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  if (win.title === '' || barH < 12) return;
  const size = 13 * k;
  ctx.font = `600 ${size}px ${AX_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  // Centred, but never under the traffic lights and never through a control
  // that lives in the bar — the same room AppKit leaves a long title.
  const cx = p.x + w / 2;
  let left = p.x + 80 * k;
  let right = p.x + w - 12 * k;
  for (const b of blockers) {
    if (b.x + b.w <= cx) left = Math.max(left, b.x + b.w + 8 * k);
    else if (b.x >= cx) right = Math.min(right, b.x - 8 * k);
  }
  const room = Math.min(cx - left, right - cx) * 2;
  const measure = (s: string): number => ctx.measureText(s).width;
  const text = ellipsize(win.title, Math.max(20, room), measure);
  ctx.fillStyle = win.focused ? AX_INK : AX_INK_SOFT;
  ctx.fillText(text, p.x + w / 2, p.y + barH / 2 + 0.5 * k);
  ctx.textAlign = 'left';
}

/** One control, at its real bbox, in the shape its role earns. */
function drawAxElement(
  ctx: CanvasRenderingContext2D,
  item: AxDrawable,
  at: (x: number, y: number) => { x: number; y: number },
  k: number,
  accent: string,
  now: number,
): void {
  const p = at(item.rect.x, item.rect.y);
  const w = item.rect.w * k;
  const h = item.rect.h * k;
  if (w < 2 || h < 2) return;
  const enabled = item.el.enabled !== false;
  const ink = enabled ? AX_INK : AX_DISABLED;
  const measure = (s: string): number => ctx.measureText(s).width;
  const pad = Math.min(9 * k, w * 0.2);

  const chrome = (radius: number, fill = AX_CONTROL): void => {
    ctx.fillStyle = fill;
    roundRect(ctx, p.x, p.y, w, h, radius);
    ctx.fill();
    ctx.strokeStyle = AX_CONTROL_EDGE;
    ctx.lineWidth = 1;
    roundRect(ctx, p.x + 0.5, p.y + 0.5, w - 1, h - 1, radius);
    ctx.stroke();
  };
  const focusRing = (radius: number): void => {
    if (item.el.focused !== true) return;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5 * k;
    roundRect(ctx, p.x - 1.5 * k, p.y - 1.5 * k, w + 3 * k, h + 3 * k, radius + 1.5 * k);
    ctx.stroke();
    ctx.restore();
  };
  const centred = (text: string): void => {
    if (text === '') return;
    ctx.font = `500 ${Math.min(13, item.rect.h * 0.5) * k}px ${AX_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = ink;
    ctx.fillText(ellipsize(text, w - pad * 2, measure), p.x + w / 2, p.y + h / 2);
    ctx.textAlign = 'left';
  };
  const leading = (text: string, inset = pad): void => {
    if (text === '') return;
    ctx.font = `400 ${Math.min(13, item.rect.h * 0.55) * k}px ${AX_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    ctx.fillText(ellipsize(text, w - inset * 2, measure), p.x + inset, p.y + h / 2);
  };

  switch (item.shape) {
    case 'document': {
      // The page itself, and the real text on it. This is the whole reason the
      // fallback is worth having: the user can READ what the model is working
      // on, not just see that a window exists.
      drawAxDocument(ctx, item, p, w, h, k, accent, now);
      return;
    }
    case 'field': {
      chrome(5 * k, '#ffffff');
      focusRing(5 * k);
      leading(item.label);
      return;
    }
    case 'button': {
      chrome(6 * k);
      focusRing(6 * k);
      centred(item.label);
      return;
    }
    case 'popup': {
      chrome(6 * k);
      focusRing(6 * k);
      leading(item.label, pad);
      // The two chevrons that make a pop-up a pop-up.
      const cx = p.x + w - 11 * k;
      const cy = p.y + h / 2;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.4 * k;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx - 3.2 * k, cy + dir * 4.6 * k - dir * 2.2 * k);
        ctx.lineTo(cx, cy + dir * 4.6 * k);
        ctx.lineTo(cx + 3.2 * k, cy + dir * 4.6 * k - dir * 2.2 * k);
        ctx.stroke();
      }
      return;
    }
    case 'checkbox': {
      const side = Math.min(h, 14 * k);
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, p.x, p.y + (h - side) / 2, side, side, 3.5 * k);
      ctx.fill();
      ctx.strokeStyle = AX_CONTROL_EDGE;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = `400 ${Math.min(13, item.rect.h * 0.7) * k}px ${AX_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ink;
      ctx.fillText(
        ellipsize(item.label, w - side - 6 * k, measure),
        p.x + side + 6 * k,
        p.y + h / 2,
      );
      return;
    }
    case 'radio': {
      const r = Math.min(h, 14 * k) / 2;
      ctx.beginPath();
      ctx.arc(p.x + r, p.y + h / 2, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = AX_CONTROL_EDGE;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = `400 ${Math.min(13, item.rect.h * 0.7) * k}px ${AX_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ink;
      ctx.fillText(
        ellipsize(item.label, w - r * 2 - 6 * k, measure),
        p.x + r * 2 + 6 * k,
        p.y + h / 2,
      );
      return;
    }
    case 'toggle': {
      // Too small to hold its own name — a toolbar chip. Drawn as the chip it
      // is rather than captioned with text that would not fit; inventing a
      // glyph for "bold" is exactly the kind of guess this surface must not make.
      chrome(4.5 * k, 'rgba(0,0,0,0.045)');
      return;
    }
    case 'link': {
      ctx.font = `400 ${Math.min(13, item.rect.h * 0.7) * k}px ${AX_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = accent;
      const text = ellipsize(item.label, w, measure);
      ctx.fillText(text, p.x, p.y + h / 2);
      const tw = ctx.measureText(text).width;
      ctx.fillRect(p.x, p.y + h / 2 + 6 * k, tw, Math.max(1, k));
      return;
    }
    case 'tab': {
      chrome(6 * k, 'rgba(0,0,0,0.05)');
      centred(item.label);
      return;
    }
    case 'row': {
      ctx.fillStyle = AX_HAIRLINE;
      ctx.fillRect(p.x, p.y + h - Math.max(1, k), w, Math.max(1, k));
      leading(item.label, 4 * k);
      return;
    }
    case 'slider': {
      const cy = p.y + h / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      roundRect(ctx, p.x, cy - 2 * k, w, 4 * k, 2 * k);
      ctx.fill();
      return;
    }
    case 'disclosure': {
      const cx = p.x + w / 2;
      const cy = p.y + h / 2;
      const s = Math.min(w, h) * 0.28;
      ctx.strokeStyle = AX_INK_SOFT;
      ctx.lineWidth = 1.6 * k;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.6, cy - s);
      ctx.lineTo(cx + s * 0.6, cy);
      ctx.lineTo(cx - s * 0.6, cy + s);
      ctx.stroke();
      return;
    }
    default: {
      if (item.label === '') return;
      leading(item.label, 2 * k);
    }
  }
}

/** The document surface: the page, its real text, and a caret when focused. */
function drawAxDocument(
  ctx: CanvasRenderingContext2D,
  item: AxDrawable,
  p: { x: number; y: number },
  w: number,
  h: number,
  k: number,
  accent: string,
  now: number,
): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(p.x, p.y, w, h);
  if (item.el.focused === true) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 * k;
    ctx.strokeRect(p.x + k, p.y + k, w - 2 * k, h - 2 * k);
    ctx.restore();
  }
  const text = item.label;
  if (text === '') return;
  const size = 13 * k;
  const lineH = size * 1.45;
  const inset = 10 * k;
  ctx.font = `400 ${size}px ${AX_FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = AX_INK;
  const maxLines = Math.max(0, Math.floor((h - inset * 2) / lineH));
  const lines = wrapText(text, w - inset * 2, maxLines, (s) => ctx.measureText(s).width);
  let y = p.y + inset + size;
  let lastX = p.x + inset;
  for (const line of lines) {
    ctx.fillText(line, p.x + inset, y);
    if (line !== '') lastX = p.x + inset + ctx.measureText(line).width;
    y += lineH;
  }
  // The insertion point, blinking at the system's ~1Hz — drawn only for a text
  // area AX reported as focused, which is a fact, not a flourish.
  if (item.el.focused === true && lines.length > 0 && Math.floor(now / 530) % 2 === 0) {
    ctx.fillStyle = AX_INK;
    ctx.fillRect(lastX + 1 * k, y - lineH - size + 1 * k, Math.max(1, 1.5 * k), size * 1.15);
  }
}

// ── canvas painters ─────────────────────────────────────────────────────────

/** The shared agent cursor, tip exactly on `at`, matching overlay.html. */
function drawCursor(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  at: { x: number; y: number },
  k: number,
  sinceClick: number,
): void {
  // overlay.html's press "pop": shrink then overshoot, radiating from the tip.
  let pop = 1;
  if (sinceClick < 340) {
    const p = sinceClick / 340;
    pop =
      p < 0.38
        ? 1 - 0.18 * (p / 0.38)
        : p < 0.7
          ? 0.82 + 0.27 * ((p - 0.38) / 0.32)
          : 1.09 - 0.09 * ((p - 0.7) / 0.3);
  }
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(k * pop, k * pop);
  ctx.translate(-CURSOR_TIP.x, -CURSOR_TIP.y);
  ctx.scale(CURSOR_BOX.w / CURSOR_VIEWBOX.w, CURSOR_BOX.h / CURSOR_VIEWBOX.h);
  ctx.translate(-CURSOR_VIEWBOX.x, -CURSOR_VIEWBOX.y);

  // The three drop-shadows overlay.html stacks on #cursor, in the same order:
  // a tight dark one (which is what keeps a pearl-white glyph legible over a
  // WHITE document — without it the cursor dissolves into the page it is
  // pointing at), then two luminous rims.
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.shadowColor = 'rgba(150, 168, 255, 0.55)';
  ctx.shadowBlur = 12;
  ctx.fill(path);
  ctx.shadowColor = 'rgba(205, 210, 255, 0.9)';
  ctx.shadowBlur = 5;
  ctx.fill(path);
  ctx.shadowColor = 'rgba(10, 12, 40, 0.55)';
  ctx.shadowBlur = 2.5;
  ctx.shadowOffsetY = 1.2;
  ctx.fill(path);
  ctx.restore();

  const body = ctx.createLinearGradient(10, 9, 30, 30);
  body.addColorStop(0, 'rgba(255,255,255,0.97)');
  body.addColorStop(0.45, 'rgba(231,230,246,0.9)');
  body.addColorStop(1, 'rgba(195,194,228,0.86)');
  ctx.fillStyle = body;
  ctx.fill(path);

  const sheen = ctx.createLinearGradient(10, 9, 22, 23);
  sheen.addColorStop(0, 'rgba(255,255,255,0.54)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fill(path);

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();
}

/** Two expanding rings, the overlay's click feedback. */
function drawRipples(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number },
  k: number,
  since: number,
  accent: string,
): void {
  for (const delay of [0, 130]) {
    const t = (since - delay) / 500;
    if (t < 0 || t > 1) continue;
    const eased = 1 - (1 - t) ** 3;
    const scale = 0.55 + eased * 2.55;
    ctx.save();
    ctx.globalAlpha = 0.95 * (1 - t);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5 * k;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 9 * k * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * The status bubble: the same pill overlay.html draws — same offset from the
 * tip, same radius, weight and dots, same edge flips.
 *
 * DELIBERATE DEVIATION: the on-screen overlay fills it with an indigo→violet
 * gradient. the user's standing brief for this app is no purple anywhere, so this
 * one is neutral glass lifted by the CURRENT THEME's accent, which also means
 * it belongs to whichever flavour is on rather than to one hardcoded palette.
 * Shape, type and motion are the identity; the fill is the app's.
 */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number },
  k: number,
  viewport: { w: number; h: number },
  session: MacMonitorSessionState,
  palette: Palette,
): void {
  const { label, detail } = bubbleText(session.cursorState, session.statusText);
  if (label === '') return;
  const dots = DOTTED.has(session.cursorState);
  const fontSize = 12.5 * k;
  const padX = 13 * k;
  const padY = 7 * k;
  const gap = 7 * k;
  const dotsWidth = dots ? 4 * 3 * k + 3 * 2 * k + gap : 0;

  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
  const labelWidth = ctx.measureText(label).width;
  const detailFont = `500 ${11.5 * k}px ui-monospace, "SF Mono", Menlo, monospace`;
  let detailWidth = 0;
  if (detail !== '') {
    ctx.font = detailFont;
    detailWidth = ctx.measureText(` ${detail}`).width;
  }
  const w = padX * 2 + dotsWidth + labelWidth + detailWidth;
  const h = fontSize * 1.2 + padY * 2;
  const anchor = bubbleAnchor(at, { w, h }, viewport, { x: 27 * k, y: 40 * k }, 8);

  // Glass pill: near-black so any window content reads behind it, lifted by a
  // soft accent glow and a hairline top highlight.
  ctx.save();
  ctx.shadowColor = 'rgba(6, 8, 14, 0.5)';
  ctx.shadowBlur = 18 * k;
  ctx.shadowOffsetY = 4 * k;
  ctx.fillStyle = 'rgba(18, 20, 25, 0.9)';
  roundRect(ctx, anchor.x, anchor.y, w, h, h / 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.34;
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2.5 * k;
  roundRect(ctx, anchor.x, anchor.y, w, h, h / 2);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.24)';
  ctx.lineWidth = 1;
  roundRect(ctx, anchor.x + 0.5, anchor.y + 0.5, w - 1, h - 1, (h - 1) / 2);
  ctx.stroke();

  let x = anchor.x + padX;
  const midY = anchor.y + h / 2;
  if (dots) {
    const phase = performance.now() / 1250;
    for (let i = 0; i < 3; i++) {
      const local = (phase - i * 0.128) % 1;
      const lift = local > 0 && local < 0.3 ? Math.sin((local / 0.3) * Math.PI) : 0;
      ctx.globalAlpha = 0.45 + lift * 0.55;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + 2 * k, midY - lift * 2.5 * k, 2 * k, 0, Math.PI * 2);
      ctx.fill();
      x += 4 * k + 3 * k;
    }
    ctx.globalAlpha = 1;
    x += gap - 3 * k;
  }

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(label, x, midY);
  if (detail !== '') {
    ctx.globalAlpha = 0.78;
    ctx.font = detailFont;
    ctx.fillText(` ${detail}`, x + labelWidth, midY);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
