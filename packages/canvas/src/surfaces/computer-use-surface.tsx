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
  IDLE_MAC_MONITOR_SESSION,
  type MacMonitorCursorState,
  type MacMonitorFeed,
  type MacMonitorSessionState,
} from './computer-use-feed.ts';
import {
  annotationScale,
  bubbleAnchor,
  coverCrop,
  cursorEase,
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

/** Gaussian radius of the backdrop blur, in CSS px. */
const BACKDROP_BLUR = 4;

interface BackdropCache {
  canvas: HTMLCanvasElement | null;
  source: HTMLImageElement | ImageBitmap | null;
  w: number;
  h: number;
  dpr: number;
}

/**
 * The dimmed, blurred, vignetted wallpaper, rendered once per (image, size) and
 * reused. Returns null when there is no wallpaper — the caller's flat ground
 * colour is then the whole backdrop, which is a deliberate surface rather than
 * a hole.
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
  // Overdraw past the edges so the blur has real pixels to sample instead of
  // fading into transparency at the borders.
  const bleed = BACKDROP_BLUR * 3;
  g.filter = `blur(${BACKDROP_BLUR}px)`;
  g.drawImage(
    source as CanvasImageSource,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    -bleed,
    -bleed,
    cssW + bleed * 2,
    cssH + bleed * 2,
  );
  g.filter = 'none';
  g.fillStyle = 'rgba(8, 9, 12, 0.58)';
  g.fillRect(0, 0, cssW, cssH);
  const vignette = g.createRadialGradient(
    cssW / 2,
    cssH / 2,
    Math.min(cssW, cssH) * 0.22,
    cssW / 2,
    cssH / 2,
    Math.max(cssW, cssH) * 0.76,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, cssW, cssH);
  cache.current = { canvas: off, source, w: cssW, h: cssH, dpr };
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
  const paletteRef = useRef<Palette>(FALLBACK_PALETTE);
  const backdropRef = useRef<BackdropCache>({
    canvas: null,
    source: null,
    w: 0,
    h: 0,
    dpr: 1,
  });
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
      const windows = frame?.windows ?? [];
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

    // 2. The wallpaper: the desk the app is sitting on. Blurred, dimmed and
    //    vignetted so it reads as CONTEXT — the eye should land on the window,
    //    not on someone's photograph of a bridge. Rendered once into an
    //    offscreen and blitted, because a per-frame blur of a 2560px picture is
    //    the one expensive thing on this surface.
    const backdrop = ensureBackdrop(backdropRef, feed?.getWallpaper() ?? null, cssW, cssH, dpr);
    if (backdrop !== null) ctx.drawImage(backdrop, 0, 0, cssW, cssH);

    const frame = feed?.getFrame() ?? null;
    const rect = frame?.rect ?? session.rect;
    const bitmap = frame?.bitmap ?? null;
    if (rect === null || rect.w <= 0 || rect.h <= 0) return;

    // 3. The window, at REAL point size, centred, never upscaled.
    const drawn = fitWindow(rect, viewport, STAGE_PADDING);
    const radius = WINDOW_RADIUS * drawn.scale;
    if (bitmap !== null) {
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
    }

    // 4. The phantom, glided onto its target on the overlay's own easing curve.
    //    ONLY over a real picture: the cursor lives ON the controlled window,
    //    and with no window to be on, its mapped position means nothing — a
    //    phantom floating over bare wallpaper claims to be somewhere it is not.
    const target = bitmap === null ? null : session.cursor;
    if (target !== null) {
      const g = glide.current;
      if (g.to === null || g.to.x !== target.x || g.to.y !== target.y) {
        g.from = g.to ?? target;
        g.to = target;
        g.startedAt = performance.now();
      }
      const elapsed = performance.now() - g.startedAt;
      const t = Math.min(1, elapsed / CURSOR_TRAVEL_MS);
      const eased = cursorEase(t);
      const from = g.from ?? target;
      const screen = {
        x: from.x + (target.x - from.x) * eased,
        y: from.y + (target.y - from.y) * eased,
      };
      const at = {
        x: drawn.x + (screen.x - rect.x) * drawn.scale,
        y: drawn.y + (screen.y - rect.y) * drawn.scale,
      };
      const k = annotationScale(drawn.scale);

      const sinceClick = performance.now() - lastClick.current;
      if (sinceClick < RIPPLE_MS) drawRipples(ctx, at, k, sinceClick, palette.accent);
      if (cursorPath !== null) drawCursor(ctx, cursorPath, at, k, sinceClick);
      if (session.bubbleVisible && session.cursorState !== 'idle') {
        drawBubble(ctx, at, k, viewport, session, palette);
      }
      if (t < 1 || sinceClick < RIPPLE_MS || DOTTED.has(session.cursorState)) dirty.current = true;
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

  const empty = emptyState(session, feed?.getFrame() ?? null);
  const rootClass = ['pd-macmon', className].filter(Boolean).join(' ');
  const live = session.stream === 'live';

  return (
    <div className={rootClass} ref={rootRef} data-testid="computer-use-surface">
      <canvas className="pd-macmon-canvas" ref={canvasRef} aria-label="Controlled app, live view" />
      {empty === null ? null : (
        <div className="pd-macmon-state" data-kind={empty.kind}>
          <div className="pd-macmon-state-mark" aria-hidden="true">
            <ScreenGlyph pulse={empty.kind === 'waiting'} />
          </div>
          <p className="pd-macmon-state-title">{empty.title}</p>
          <p className="pd-macmon-state-sub">{empty.sub}</p>
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
        <span className="pd-macmon-live" data-live={live ? 'true' : 'false'}>
          <span className="pd-macmon-dot" aria-hidden="true" />
          {live ? 'Live' : streamWord(session.stream)}
        </span>
        {live && fps > 0 ? <span className="pd-macmon-fps">{fps} fps</span> : null}
      </div>
    </div>
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
    return {
      kind: 'unavailable',
      title: 'Live view unavailable',
      sub: session.streamError ?? `The screen capture for ${app} could not start.`,
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
