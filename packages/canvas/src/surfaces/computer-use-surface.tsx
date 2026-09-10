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
  type MacMonitorRect,
  type MacMonitorSessionState,
  type MacMonitorViewMode,
  type MacMonitorWindowInfo,
} from './computer-use-feed.ts';
import {
  annotationScale,
  blendPlacement,
  bubbleAnchor,
  coverCrop,
  cursorEase,
  type DrawnWindow,
  fitWindow,
  followWindow,
  type Point,
  screenToCanvas,
  stagePadding,
  visibleRegion,
} from './computer-use-geometry.ts';

export interface ComputerUseSurfaceProps {
  /** The live frame source. Absent → the calm "nothing to watch" state. */
  feed?: MacMonitorFeed;
  className?: string;
}

/**
 * THE SHARED AGENT CURSOR — the user's artwork, the same path the native overlay
 * draws (pi-mac Overlay.swift `pointerGlyph`).
 *
 * He sent one SVG for "the fake cursor", and there are two of them: the panel
 * painted over his real screen, and this one painted over a picture of the
 * window. They have to be the same drawing or the monitor is showing something
 * that is not what is happening — so this is his path verbatim, arcs and all,
 * because SVG is what a canvas Path2D speaks anyway.
 */
const CURSOR_PATH =
  'M 58.48 87.06 A 24.06 25.11 -36 0 1 93.89 61.34 L 223.67 137.27 ' +
  'A 18.23 19.02 -36 0 1 218.85 171.89 A 117.23 122.31 -36 0 0 131.29 247.95 ' +
  'A 19.66 20.51 -36 0 1 92.88 244.4 Z';
/** His stroke, in his viewBox units, so it scales with the glyph. */
const CURSOR_STROKE_W = 13.79;
/** Body and keyline, straight off the SVG. */
const CURSOR_BODY = '#78BFE5';
const CURSOR_KEYLINE = '#FFFFFF';
const CURSOR_GLOW = '#95F9E5';
/** The anchors' bounds grown by half the keyline — what is actually drawn. */
const CURSOR_VIEWBOX = { x: 51.59, y: 54.45, w: 188.56, h: 213.37 };
/** Drawn size in CSS px, pinned by HEIGHT to match the panel's 22pt. */
const CURSOR_BOX = { w: 19.44, h: 22 };
/** The point of the pointer, in drawn-box units — the rounded corner between
 * the first arc's ends, pulled out along the diagonal by half the keyline. */
const CURSOR_TIP = { x: 1.15, y: 0.31 };
/** Matches CURSOR_TRAVEL_MS in overlay-controller.ts. */
const CURSOR_TRAVEL_MS = 300;
/** How long a click ripple lives (overlay.html's .ripple transition). */
const RIPPLE_MS = 620;
/** Corner radius of a macOS window, at real size. */
const WINDOW_RADIUS = 11;
/**
 * WHEN TO STOP FITTING THE WINDOW AND FOLLOW THE ACTION.
 *
 * This was 0.6, which is far too eager: a 900x620pt window in the rail fits at
 * 0.45 and is perfectly readable there. the user watched it flip mid-run and was
 * blunt about it — "there was no purpouse, the window being used could be seen
 * absolutely just fine… I don't think there's ever a point aside from a really
 * large window that literally can't fit on canvas screen without being
 * comically small".
 *
 * So following is now reserved for that case, and the two thresholds are
 * different on purpose: a single number means a window set that changes size —
 * an app opening a second window, a sheet appearing — can sit on the boundary
 * and flip the whole picture back and forth. Enter following only when the
 * window really is comically small; leave it only once fitting is comfortably
 * fine again.
 */
const FOLLOW_ENTER_BELOW = 0.3;
const FOLLOW_LEAVE_ABOVE = 0.42;
/** How long a change of placement takes. It is a zoom, so it is animated. */
const ZOOM_MS = 460;
/** The smallest the followed crop is allowed to get — the same threshold that
 * makes fitting unacceptable, so the two modes meet instead of jumping. */
const FOLLOW_MIN_SCALE = FOLLOW_ENTER_BELOW;
/** How long the follow camera takes to pan, on the cursor's own curve. */
const CAMERA_MS = 420;
/**
 * How long "Thinking" is allowed to nag before the bubble gets out of the way,
 * and how long before it comes back to ADMIT how long it has been.
 *
 * Measured over 45s of the real choreography: `thinking` was 63% of everything
 * the surface said, in a pill identical whether the model was one token from
 * finishing or stuck for four minutes. The overlay's own idle is 15s, which is
 * far too long to keep pulsing and far too short to be worth reading.
 */
const THINKING_QUIET_MS = 6_000;
const THINKING_ADMIT_MS = 20_000;
/** No new frames for this long, on a stream that says it is live, is stalled. */
const STALLED_MS = 4_000;
/** The act strip's memory: chips, thumbnails and scrub frames are all capped
 * here, so a two-hour run costs the same as a two-minute one. */
const MAX_ACTS = 40;
/** Widest scrub frame kept per act (the mock window is 900pt wide). */
const FRAME_MAX_W = 900;
/** The chip's picture, in CSS px. Cropped around the act, not the whole window:
 * a 72×48 thumbnail of a 900×620 window shows nothing, one of the 216×144
 * region around the click shows the click. */
const CHIP_W = 72;
const CHIP_H = 48;

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

/** The moment an act was named — what the bubble says and what the strip logs. */
interface ActWords {
  /** "Click", "Type", "Press" — the verb, for the strip. */
  verb: string;
  /** "Save", "⌘S", the typed preview — what it was done to. */
  object: string;
}

/**
 * The verb and the object of the act in flight.
 *
 * `statusText` is the overlay's own payload for the state (the typed preview,
 * the key combo, the app name) — and, once the producer passes one, the NAME of
 * the control being clicked. The surface renders whatever it is given rather
 * than hard-coding "Clicking": the measured defect is that two thirds of the
 * time this surface says a word that means nothing, and the fix is to say the
 * specific thing whenever the specific thing is in hand.
 */
export function actWords(state: MacMonitorCursorState, text: string): ActWords {
  const detail = text.trim();
  switch (state) {
    case 'opening':
      // The producer sends the whole sentence ("Opening TextEdit") here.
      return { verb: 'Open', object: detail.replace(/^Opening\s+/i, '') };
    case 'clicking':
      return { verb: 'Click', object: detail };
    case 'typing':
      return { verb: 'Type', object: detail };
    case 'pressing':
      return { verb: 'Press', object: detail };
    case 'scrolling':
      return { verb: 'Scroll', object: detail };
    case 'reading':
      return { verb: 'Read', object: '' };
    default:
      return { verb: '', object: '' };
  }
}

/** What the bubble says, given how long the state has been going. */
export interface Bubble {
  label: string;
  detail: string;
  /** Three dots = WAITING ON THE MODEL. Never for an act in progress: the
   * measured problem is that "Scrolling ⋯" and "Thinking ⋯" look identical. */
  dots: boolean;
  /** A steady mark = this act is happening right now. */
  mark: boolean;
  /** How the detail gives way when there is no room: keep the tail of a live
   * typed preview, or drop a context phrase whole. */
  truncate: 'head' | 'drop';
  visible: boolean;
}

/** "after typing The quick brown…" → "after typing" → nothing. */
function shortenContext(text: string, fits: (t: string) => boolean): string {
  const words = text.split(' ');
  for (let n = words.length - 1; n >= 2; n--) {
    const candidate = words.slice(0, n).join(' ');
    if (fits(candidate)) return candidate;
  }
  return '';
}

const NOTHING: Bubble = {
  label: '',
  detail: '',
  dots: false,
  mark: false,
  truncate: 'drop',
  visible: false,
};

export function bubbleText(
  state: MacMonitorCursorState,
  text: string,
  sinceMs: number,
  after: string,
): Bubble {
  if (state === 'idle') return NOTHING;
  if (state === 'thinking') {
    // Decay, then admit. 0–6s it says what it is thinking after; 6–20s it gets
    // out of the way entirely (the frame's own glow still says work is in
    // flight); past 20s it comes back with the number, because by then "is this
    // slow or is it broken" is the only question the user has.
    if (sinceMs >= THINKING_ADMIT_MS) {
      return {
        label: `Still thinking — ${Math.round(sinceMs / 1000)}s`,
        detail: '',
        dots: false,
        mark: false,
        truncate: 'drop',
        visible: true,
      };
    }
    if (sinceMs >= THINKING_QUIET_MS) return NOTHING;
    return {
      label: 'Thinking',
      detail: after,
      dots: true,
      mark: false,
      truncate: 'drop',
      visible: true,
    };
  }
  const { verb, object } = actWords(state, text);
  const mark = true;
  switch (state) {
    case 'opening':
      return {
        label: object === '' ? 'Opening' : `Opening ${object}`,
        detail: '',
        dots: true,
        mark: false,
        truncate: 'drop',
        visible: true,
      };
    case 'clicking':
      return {
        label: object === '' ? 'Clicking' : `Clicking ${object}`,
        detail: '',
        dots: false,
        mark,
        truncate: 'drop',
        visible: true,
      };
    case 'typing':
      return {
        label: 'Typing',
        detail: object,
        dots: false,
        mark,
        truncate: 'head',
        visible: true,
      };
    case 'pressing':
      return {
        label: `Pressing ${object}`.trimEnd(),
        detail: '',
        dots: false,
        mark,
        truncate: 'drop',
        visible: true,
      };
    case 'scrolling':
      return {
        label: object === '' ? 'Scrolling the window' : `Scrolling ${object}`,
        detail: '',
        dots: false,
        mark,
        truncate: 'drop',
        visible: true,
      };
    case 'reading':
      return {
        label: 'Reading the screen',
        detail: '',
        dots: true,
        mark: false,
        truncate: 'drop',
        visible: true,
      };
    default:
      return { ...NOTHING, label: verb };
  }
}

/** States that are an ACT — something happened to the app — rather than a wait. */
const ACT_STATES: ReadonlySet<MacMonitorCursorState> = new Set([
  'opening',
  'clicking',
  'typing',
  'pressing',
  'scrolling',
]);

/**
 * One thing the agent did, kept so the tab has a HISTORY and not just a live
 * frame. The pictures are captured off the live canvas ~250ms after the act
 * landed, which means the phantom and its ripple are already baked in — the one
 * thing Skyvern's otherwise-excellent run viewer gets wrong (select a past
 * "click" there and you get a bare screenshot with no click marker).
 */
export interface MonitorAct {
  id: number;
  state: MacMonitorCursorState;
  verb: string;
  object: string;
  /** performance.now() when it started, and when it ended (null = in flight). */
  at: number;
  endedAt: number | null;
  /** Wall clock, for "12s ago". */
  wall: number;
  point: Point | null;
  rect: MacMonitorRect | null;
  /** 72×48 crop around the act. */
  thumb: string | null;
  /** The whole window at up to 900px wide, for scrubbing the stage back. */
  frame: string | null;
  dialog: boolean;
}

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

/** No drift. A shared frozen object so the hot path allocates nothing. */
const ZERO = { x: 0, y: 0 } as const;

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
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState<MacMonitorSessionState>(
    () => feed?.getSession() ?? IDLE_MAC_MONITOR_SESSION,
  );
  /**
   * What the footer's right group reads, sampled at 2Hz.
   *
   * `scale` replaced the fps number: 12fps is a deliberate, correct rate for a
   * background capture and a user who reads it concludes the feature is laggy,
   * whereas "the picture is 45% of the real window" is a fact they are looking
   * at and cannot otherwise know.
   */
  const [chrome, setChrome] = useState<{ scale: number; stalledFor: number }>({
    scale: 1,
    stalledFor: 0,
  });
  const [windowTitle, setWindowTitle] = useState('');
  /** Mirrors the app's "show computer use status pill" setting, so the toggle
   * beside the picture reflects a change made anywhere else. */
  const [pillShown, setPillShown] = useState<boolean | undefined>(() =>
    feed?.getStatusPillShown?.(),
  );
  /** The frontmost sheet/dialog the app has open, named — a save panel IS part
   * of the app, and the surface should say so rather than quietly renaming the
   * window. */
  const [dialogTitle, setDialogTitle] = useState('');
  /** Which source is on screen. React state (not a ref) because the honest
   * "this is a drawing" label is chrome, and chrome lives in the DOM. */
  const [source, setSource] = useState<MonitorSource>('none');
  /* The system prompts for Screen Recording ONCE per app. After that the only
     route is the Settings pane, so the panel changes what it says and does. */
  const [askedForCapture, setAskedForCapture] = useState(false);
  /** The history strip. Bounded at MAX_ACTS; the pictures are JPEG data URLs so
   * a long run costs kilobytes rather than decoded bitmaps. */
  const [acts, setActs] = useState<readonly MonitorAct[]>([]);
  /** Hover previews, click commits — Playwright's `highlighted || selected`,
   * which is what makes a long list scannable for one line of state. */
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<MacMonitorViewMode>(
    () => feed?.getViewMode?.() ?? 'auto',
  );
  const [takenOver, setTakenOver] = useState<boolean>(() => feed?.isTakenOver?.() ?? false);
  /** The one sentence assistive tech is told, one per act. */
  const [announced, setAnnounced] = useState('');
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [reduced, setReduced] = useState(false);
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
  /** When the current cursorState began — the whole of A2's pacing hangs on it. */
  const stateSince = useRef(performance.now());
  /** The last place the phantom actually WAS, so an idle turn leaves it there
   * instead of teleporting it to a default corner. */
  const lastCursor = useRef<{ x: number; y: number } | null>(null);
  /** Where the window was last drawn — what an act's picture is cropped from.
   * `painted` is what stops a chip being a black rectangle: the geometry is
   * known a beat before the first frame lands. */
  /** Which placement `auto` settled on, and the one it drew last — the two
   * halves of "do not flip the whole picture back and forth on a boundary". */
  const autoMode = useRef<'fit' | 'follow'>('fit');
  const lastMode = useRef<'fit' | 'follow' | null>(null);
  const zoom = useRef<{ from: DrawnWindow; startedAt: number } | null>(null);
  const lastDrawn = useRef<{ drawn: DrawnWindow; rect: MacMonitorRect; painted: boolean } | null>(
    null,
  );
  /** The follow camera: a screen point, panned on the cursor's own curve. */
  const camera = useRef<{ from: Point; to: Point; startedAt: number } | null>(null);
  const dirty = useRef(true);

  // ── reduced motion ───────────────────────────────────────────────────────
  // The CSS animations were already covered; the canvas was not, and 753
  // sampled pixels were measured still changing per 400ms under
  // `prefers-reduced-motion: reduce`. Everything drawn here reads this: the
  // glide, the ripples, the press pop, the bubble dots, the idle breath, the
  // frame glow and the caret — and, just as importantly, the repaint loop
  // itself stops being woken every frame for animations nobody asked for.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      setReduced(mq.matches);
      dirty.current = true;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

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
      setTakenOver((prev) => {
        const now = feed.isTakenOver?.() ?? false;
        return prev === now ? prev : now;
      });
      const frame = feed.getFrame();
      const nextSource = pickMonitorSource(next, frame);
      setSource((prev) => (prev === nextSource ? prev : nextSource));
      // The footer names whatever the picture is OF.
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

  // The scale readout and the stalled watch, at 2Hz — neither number may cause
  // a repaint storm, and both are read from places the paint loop already knows.
  const stalledSince = useRef<number | null>(null);
  useEffect(() => {
    if (feed === undefined) return;
    const id = window.setInterval(() => {
      const live = feed.getSession().stream === 'live';
      const frozen = live && feed.getFps() === 0;
      if (!frozen) stalledSince.current = null;
      else if (stalledSince.current === null) stalledSince.current = performance.now();
      const stalledMs =
        stalledSince.current === null ? 0 : performance.now() - stalledSince.current;
      const stalledFor = stalledMs > STALLED_MS ? Math.round(stalledMs / 1000) : 0;
      const scale = lastDrawn.current?.drawn.scale ?? 1;
      setChrome((prev) =>
        prev.stalledFor === stalledFor && Math.abs(prev.scale - scale) < 0.005
          ? prev
          : { scale, stalledFor },
      );
    }, 500);
    return () => window.clearInterval(id);
  }, [feed]);

  // ── the act log ──────────────────────────────────────────────────────────
  //
  // The feed keeps exactly one frame (it closes every previous bitmap), so the
  // history has to be built here, from what the surface already sees: a cursor
  // state entering an act, and the picture on the canvas a beat later.
  const actSeq = useRef(0);
  const openAct = useRef<{ id: number; key: string } | null>(null);
  /**
   * Everything the act log reads that is NOT the act itself.
   *
   * The cursor moves sixty times a second, so an effect that depended on it
   * re-ran (and cleared its own capture timer) before the 250ms picture was
   * ever taken — measured: two chips in three had no thumbnail. The act's
   * identity is the state and its text; the rest is read at the moment it fires.
   */
  useEffect(() => {
    if (feed?.getStatusPillShown === undefined) return;
    const sync = () => setPillShown(feed.getStatusPillShown?.());
    sync();
    return feed.subscribe(sync);
  }, [feed]);

  const actContext = useRef({ session, dialogTitle });
  actContext.current = { session, dialogTitle };
  useEffect(() => {
    const state = session.cursorState;
    const text = session.statusText;
    const key = `${state} ${text}`;
    const now = performance.now();
    if (!ACT_STATES.has(state) || !session.active) {
      if (openAct.current !== null) {
        const id = openAct.current.id;
        openAct.current = null;
        setActs((prev) => prev.map((a) => (a.id === id ? { ...a, endedAt: now } : a)));
      }
      return;
    }
    if (openAct.current?.key === key) return;
    const closing = openAct.current?.id ?? null;
    const id = ++actSeq.current;
    openAct.current = { id, key };
    const ctx = actContext.current;
    const { verb, object } = actWords(state, text);
    const act: MonitorAct = {
      id,
      state,
      verb,
      object,
      at: now,
      endedAt: null,
      wall: Date.now(),
      point: ctx.session.cursor,
      rect: ctx.session.rect,
      thumb: null,
      frame: null,
      dialog: ctx.dialogTitle !== '',
    };
    setActs((prev) => {
      const closed =
        closing === null ? prev : prev.map((a) => (a.id === closing ? { ...a, endedAt: now } : a));
      const next = [...closed, act];
      return next.length > MAX_ACTS ? next.slice(next.length - MAX_ACTS) : next;
    });
    setAnnounced(actSentence(act, ctx.session.appName));
    // The picture is taken a beat AFTER the act lands, off the live canvas —
    // so the phantom and its ripple are already in it. Skyvern's history frames
    // are bare screenshots with no click marker; ours cannot be, by construction.
    let timer = 0;
    let tries = 0;
    const shoot = (): void => {
      const shots = captureAct(canvasRef.current, lastDrawn.current, act.point);
      if (shots === null) {
        // No picture yet — the first act of a session routinely lands before
        // the first frame does. Try again for a couple of seconds, then this
        // act simply has no thumbnail and the chip says so.
        tries += 1;
        if (tries <= 3) timer = window.setTimeout(shoot, 350 * tries);
        return;
      }
      setActs((prev) =>
        prev.map((a) => (a.id === id ? { ...a, thumb: shots.thumb, frame: shots.frame } : a)),
      );
    };
    timer = window.setTimeout(shoot, 250);
    return () => window.clearTimeout(timer);
  }, [session.cursorState, session.statusText, session.active]);

  // A dialog opening is the beat that matters most — it is the app asking a
  // question the agent is about to answer on the user's behalf.
  useEffect(() => {
    if (dialogTitle === '') return;
    setAnnounced(`A ${dialogTitle} dialog opened`);
  }, [dialogTitle]);

  // A session that ends takes its history with it: the next run is a different
  // story, and stale thumbnails under a live view are the exact lie this
  // surface exists not to tell.
  useEffect(() => {
    if (session.active) return;
    openAct.current = null;
    setActs((prev) => (prev.length === 0 ? prev : []));
    setPinned(null);
    setHovered(null);
  }, [session.active]);

  const scrubId = hovered ?? pinned;
  const scrub = scrubId === null ? null : (acts.find((a) => a.id === scrubId) ?? null);
  // A long run drops its oldest acts; a pin on one of them would otherwise
  // leave the stage scrubbed to a frame that no longer exists.
  useEffect(() => {
    if (pinned !== null && !acts.some((a) => a.id === pinned)) setPinned(null);
  }, [acts, pinned]);
  const scrubImages = useRef(new Map<number, HTMLImageElement>());
  const scrubImage = useCallback((act: MonitorAct | null): HTMLImageElement | null => {
    if (act === null || act.frame === null) return null;
    const cached = scrubImages.current.get(act.id);
    if (cached !== undefined) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    const img = new Image();
    img.onload = () => {
      dirty.current = true;
    };
    img.src = act.frame;
    scrubImages.current.set(act.id, img);
    // Only the frames actually looked at are ever decoded, and only a few of
    // those are kept: the strings are the storage, the bitmaps are a cache.
    while (scrubImages.current.size > 6) {
      const oldest = scrubImages.current.keys().next().value;
      if (oldest === undefined) break;
      scrubImages.current.delete(oldest);
    }
    return null;
  }, []);

  // ── the paint loop ───────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (canvas === null || stage === null) return;
    const cssW = stage.clientWidth;
    const cssH = stage.clientHeight;
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
    const now = performance.now();

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

    // While the user is driving, there is deliberately nothing to see: the
    // capture child is stopped, so drawing the last frame would be a lie about
    // what Bobble can currently see.
    if (takenOver) {
      scrimStage(ctx, viewport);
      lastDrawn.current = null;
      return;
    }

    const frame = feed?.getFrame() ?? null;
    const from = pickMonitorSource(session, frame);
    const empty = from === 'permission' ? null : emptyState(session, frame);
    // The stage is the union rect of whichever source is drawing — computed the
    // same way on both sides, so a switch between them moves nothing. Scrubbing
    // back uses the rect the act was captured at, so the window does not jump.
    const scrubbed = scrub !== null && scrub.rect !== null ? scrub : null;
    const scrubShot = scrubbed === null ? null : scrubImage(scrubbed);
    const rect =
      scrubbed !== null && scrubShot !== null ? scrubbed.rect : (frame?.rect ?? session.rect);
    const bitmap = frame?.bitmap ?? null;
    // `undefined <= 0` is false, so a header with no rect at all used to pass
    // this guard and produce NaN geometry.
    if (rect == null || !(rect.w > 0) || !(rect.h > 0)) {
      lastDrawn.current = null;
      if (empty !== null) scrimStage(ctx, viewport);
      return;
    }

    // 3. Where the window goes. Two modes, and the second one is the whole
    //    point of the docked rail: FIT shows the whole window at real point
    //    size (never upscaled — the composition this surface is built on), and
    //    FOLLOW crops around whatever is being acted on so the everyday mode is
    //    not a 45% demo of the fullscreen one. Apple's own binary, with the
    //    scrolling done for you.
    const pad = stagePadding(viewport);
    const fitted = fitWindow(rect, viewport, pad);

    // The phantom's screen position is worked out BEFORE the geometry, because
    // in follow mode the geometry depends on it.
    if (session.cursor !== null) lastCursor.current = session.cursor;
    const liveCursor = session.cursor !== null;
    const target = session.cursor ?? restingCursor(rect, lastCursor.current);
    const g = glide.current;
    if (g.to === null || g.to.x !== target.x || g.to.y !== target.y) {
      g.from = g.to ?? target;
      g.to = target;
      g.startedAt = now;
    }
    const travel = reduced ? 0 : CURSOR_TRAVEL_MS;
    const t = travel === 0 ? 1 : Math.min(1, (now - g.startedAt) / travel);
    const eased = cursorEase(t);
    const was = g.from ?? target;
    const screen = {
      x: was.x + (target.x - was.x) * eased,
      y: was.y + (target.y - was.y) * eased,
    };

    // What the crop is centred on: the dialog, when one is up — a sheet IS the
    // story — otherwise the cursor.
    const windows: readonly MacMonitorWindowInfo[] = frame?.windows ?? [];
    const dialogWin = windows.find((w) => w.sheet || w.modal) ?? null;
    const focusPoint: Point =
      dialogWin !== null
        ? {
            x: dialogWin.frame.x + dialogWin.frame.w / 2,
            y: dialogWin.frame.y + dialogWin.frame.h / 2,
          }
        : (scrubbed?.point ?? screen);

    if (viewMode === 'auto') {
      if (autoMode.current === 'fit' && fitted.scale < FOLLOW_ENTER_BELOW) {
        autoMode.current = 'follow';
      } else if (autoMode.current === 'follow' && fitted.scale > FOLLOW_LEAVE_ABOVE) {
        autoMode.current = 'fit';
      }
    }
    const mode: 'fit' | 'follow' = viewMode === 'auto' ? autoMode.current : viewMode;
    let drawn = fitted;
    if (mode === 'follow') {
      // Pan on the cursor's own easing curve, and only when the point of
      // interest has left the middle of the frame — a camera that chases every
      // 3px of cursor drift is unwatchable.
      const cam = camera.current;
      const probe = followWindow(rect, viewport, cam?.to ?? focusPoint, FOLLOW_MIN_SCALE, pad);
      const seen = visibleRegion(rect, viewport, probe);
      const deadX = seen.w * 0.23;
      const deadY = seen.h * 0.23;
      const cx = seen.x + seen.w / 2;
      const cy = seen.y + seen.h / 2;
      const outside = Math.abs(focusPoint.x - cx) > deadX || Math.abs(focusPoint.y - cy) > deadY;
      if (cam === null) camera.current = { from: focusPoint, to: focusPoint, startedAt: now };
      else if (outside && (cam.to.x !== focusPoint.x || cam.to.y !== focusPoint.y)) {
        const p = reduced ? 1 : cursorEase(Math.min(1, (now - cam.startedAt) / CAMERA_MS));
        camera.current = {
          from: {
            x: cam.from.x + (cam.to.x - cam.from.x) * p,
            y: cam.from.y + (cam.to.y - cam.from.y) * p,
          },
          to: focusPoint,
          startedAt: now,
        };
      }
      const c = camera.current ?? { from: focusPoint, to: focusPoint, startedAt: now };
      const p = reduced ? 1 : cursorEase(Math.min(1, (now - c.startedAt) / CAMERA_MS));
      const at = {
        x: c.from.x + (c.to.x - c.from.x) * p,
        y: c.from.y + (c.to.y - c.from.y) * p,
      };
      drawn = followWindow(rect, viewport, at, FOLLOW_MIN_SCALE, pad);
      if (p < 1) dirty.current = true;
    } else {
      camera.current = null;
    }

    /*
     * A CHANGE OF PLACEMENT IS A ZOOM, AND A ZOOM IS ANIMATED.
     *
     * Cutting straight from fitting to following moves the picture a long way
     * on one frame, which reads as the recording jumping rather than as the
     * view changing. Blend from wherever the last frame drew to wherever this
     * one wants to, on the cursor's own curve.
     */
    const previous = lastDrawn.current?.drawn ?? null;
    if (lastMode.current !== null && lastMode.current !== mode && previous !== null) {
      zoom.current = { from: previous, startedAt: now };
    }
    lastMode.current = mode;
    if (zoom.current !== null) {
      const t = reduced ? 1 : cursorEase(Math.min(1, (now - zoom.current.startedAt) / ZOOM_MS));
      drawn = blendPlacement(zoom.current.from, drawn, t);
      if (t < 1) dirty.current = true;
      else zoom.current = null;
    }
    const radius = WINDOW_RADIUS * drawn.scale;

    // 4. The window itself.
    const shadow = (): void => {
      // A real macOS window shadow is large, soft and low-contrast, and macOS
      // stacks two of them: a wide key shadow and a tight ambient one. Ours was
      // a tight card-shadow, which is the single detail that made this read as
      // a picture OF a window rather than as a window.
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.44)';
      ctx.shadowBlur = 88 * drawn.scale + 10;
      ctx.shadowOffsetY = 26 * drawn.scale + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.9)';
      roundRect(ctx, drawn.x, drawn.y, drawn.w, drawn.h, radius);
      ctx.fill();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
      ctx.shadowBlur = 10 * drawn.scale + 2;
      ctx.shadowOffsetY = 2;
      ctx.fill();
      ctx.restore();
    };
    let painted = false;
    if (scrubbed !== null && scrubShot !== null) {
      shadow();
      ctx.save();
      roundRect(ctx, drawn.x, drawn.y, drawn.w, drawn.h, radius);
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(scrubShot, drawn.x, drawn.y, drawn.w, drawn.h);
      ctx.restore();
      painted = true;
    } else if (from === 'pixels' && bitmap !== null) {
      shadow();
      ctx.save();
      roundRect(ctx, drawn.x, drawn.y, drawn.w, drawn.h, radius);
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, drawn.x, drawn.y, drawn.w, drawn.h);
      ctx.restore();
      painted = true;
    }
    lastDrawn.current = { drawn, rect, painted };
    /*
     * NO EDGE TREATMENT AT ALL.
     *
     * There was a translucent keyline, then a glow, then a mist. the user, having
     * looked at each: "no that's not what I was looking for, why don't we just
     * remove the border." The window's own drop shadow already lifts it off the
     * wallpaper, which was the job an edge was being asked to do.
     */

    // 5. A modal is up: the room goes quiet. macOS's own composition dims the
    //    window behind a sheet, and a "Save changes?" answered wrongly is the
    //    most expensive mistake this feature can make — so it gets the beat.
    if (painted && dialogWin !== null && scrubbed === null) {
      dimBehindDialog(ctx, drawn, rect, dialogWin.frame, radius);
      // The sheet's own buttons used to name an untitled sheet, read off the
      // Accessibility scene while that was the drawing source. With pixels the
      // only source, the caption falls back to the app and title it has.
      const sheetButtons: string[] = [];
      drawDialogCaption(
        ctx,
        drawn,
        rect,
        dialogWin.frame,
        viewport,
        dialogCaption(session.appName, dialogWin.title, sheetButtons),
        annotationScale(drawn.scale),
      );
    }

    // 6. "Something is happening" belongs to the FRAME, not to a 110px pill in
    //    the middle of the picture. An inset outline on the window's own rounded
    //    rect reads from across the room and can never be mistaken for app
    //    chrome, because real chrome is inside the frame.
    if (painted && scrubbed === null && session.cursorState !== 'idle') {
      drawWorkingOutline(ctx, drawn, viewport, radius, palette.accent, now, reduced);
    }

    // 7. The phantom. ALWAYS, whenever there is a window for it to be on —
    //    the user: "always show the fake cursor around there even if just idling,
    //    looks nice and makes it feel like 'this is the model's computer'." With
    //    no live position it rests where it last actually was (or, having never
    //    been anywhere, where a hand would leave a mouse) and breathes. It is
    //    still never drawn over BARE WALLPAPER: with no window, a mapped
    //    position means nothing and the phantom would claim to be somewhere.
    //    A scrubbed frame already has one baked in; two would be a lie.
    if (from !== 'none' && scrubbed === null) {
      // The idle breath is applied in CANVAS pixels, after the mapping: it is a
      // property of the drawing, not a claim that the cursor moved on screen.
      const drift =
        reduced || (liveCursor && session.cursorState !== 'idle') ? ZERO : idleCursorDrift(now);
      const mapped = screenToCanvas(screen, rect, drawn);
      const at = { x: mapped.x + drift.x, y: mapped.y + drift.y };
      const k = annotationScale(drawn.scale);

      const sinceClick = reduced ? RIPPLE_MS : now - lastClick.current;
      if (sinceClick < RIPPLE_MS) drawRipples(ctx, at, k, sinceClick, palette.accent);
      if (cursorPath !== null) {
        // Resting reads as resting: a hair smaller and a touch transparent, so
        // an idle phantom is calm rather than merely stationary.
        const resting = !liveCursor || session.cursorState === 'idle';
        ctx.save();
        if (resting) ctx.globalAlpha = 0.82;
        drawCursor(ctx, cursorPath, at, resting ? k * 0.94 : k, sinceClick);
        ctx.restore();
      }
      const bubble = bubbleText(
        session.cursorState,
        session.statusText,
        now - stateSince.current,
        thinkingAfter(acts),
      );
      if (session.bubbleVisible && bubble.visible) {
        drawBubble(ctx, at, k, viewport, bubble, palette, drawn, reduced);
      }
      // Something is always moving (the breath, the caret, the dots), so the
      // loop is kept awake rather than woken by each individual change — unless
      // the user asked for none of it, in which case a repaint has to be caused
      // by something actually changing.
      if (!reduced) dirty.current = true;
    }

    // 8. The minimap: while the crop is showing part of a window, say which
    //    part. A crop with no map is disorienting; 96px in a corner is not.
    if (painted && (drawn.w > viewport.w + 1 || drawn.h > viewport.h + 1)) {
      drawMinimap(ctx, rect, viewport, drawn);
    }

    // 9. An empty panel needs a calm ground. Only then: the working state keeps
    //    the user's own wallpaper exactly as it is.
    if (empty !== null) scrimStage(ctx, viewport);
  }, [cursorPath, feed, session, reduced, viewMode, scrub, scrubImage, takenOver, acts]);

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
    const stage = stageRef.current;
    if (stage === null || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      dirty.current = true;
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // A click has a moment, not a duration — remember when the state entered it.
  useEffect(() => {
    if (session.cursorState === 'clicking' && lastState.current !== 'clicking') {
      lastClick.current = performance.now();
    }
    lastState.current = session.cursorState;
    stateSince.current = performance.now();
    dirty.current = true;
  }, [session.cursorState]);

  // The thinking bubble decays and then admits — both are time, not events, so
  // the DOM has to be nudged for the aria-live sentence to follow.
  useEffect(() => {
    if (session.cursorState !== 'thinking') return;
    const id = window.setInterval(() => {
      const ms = performance.now() - stateSince.current;
      if (ms >= THINKING_ADMIT_MS) setAnnounced(`Still thinking, ${Math.round(ms / 1000)} seconds`);
      dirty.current = true;
    }, 1000);
    return () => window.clearInterval(id);
  }, [session.cursorState]);

  // ── the actions ──────────────────────────────────────────────────────────
  const caps = feed?.getCapabilities?.() ?? {};
  const onStop = useCallback(() => {
    feed?.stop?.();
    setAnnounced('Stopped');
  }, [feed]);
  const onPause = useCallback(() => {
    feed?.pause?.();
    setAnnounced('Paused by you');
  }, [feed]);
  const onTakeOver = useCallback(() => {
    feed?.takeOver?.();
    setTakenOver(true);
    setAnnounced('You took over');
  }, [feed]);
  const onHandBack = useCallback(() => {
    feed?.handBack?.();
    setTakenOver(false);
  }, [feed]);
  const onCopy = useCallback(() => {
    void copyFrame(canvasRef.current, lastDrawn.current).then((ok) => {
      setCopied(ok ? 'ok' : 'fail');
      window.setTimeout(() => setCopied(null), 1800);
    });
  }, []);
  const chooseMode = useCallback(
    (next: MacMonitorViewMode) => {
      setViewMode(next);
      feed?.setViewMode?.(next);
      camera.current = null;
      dirty.current = true;
    },
    [feed],
  );

  // ⌘. is the macOS convention for "stop what you are doing", and it is what
  // Screen Sharing uses. Scoped to this surface: it must not shadow the app's
  // own bindings from the other side of the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '.' || !(e.metaKey || e.ctrlKey)) return;
      const root = rootRef.current;
      if (root === null || !root.contains(document.activeElement)) return;
      if (caps.stop !== true) return;
      e.preventDefault();
      onStop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [caps.stop, onStop]);

  const needsCapture = source === 'permission';
  const empty = takenOver || needsCapture ? null : emptyState(session, feed?.getFrame() ?? null);
  const rootClass = ['pd-macmon', className].filter(Boolean).join(' ');
  const live = session.stream === 'live';
  const stalled = chrome.stalledFor > 0 && live;
  const scaleLabel = chrome.scale < 0.995 ? `${Math.round(chrome.scale * 100)}%` : '';
  const ident = identity(session.appName, windowTitle);
  const pinnedIndex = pinned === null ? -1 : acts.findIndex((a) => a.id === pinned);
  const newSince = pinnedIndex < 0 ? 0 : acts.length - 1 - pinnedIndex;
  const bubbleNow = bubbleText(
    session.cursorState,
    session.statusText,
    performance.now() - stateSince.current,
    thinkingAfter(acts),
  );
  const canvasLabel =
    session.appName === ''
      ? 'Controlled app, live view'
      : `${ident.text}, live view${bubbleNow.label === '' ? '' : `. ${bubbleNow.label}`}`;

  return (
    <div
      className={rootClass}
      ref={rootRef}
      data-testid="computer-use-surface"
      data-source={source}
      data-mode={viewMode}
    >
      <div className="pd-macmon-stage" ref={stageRef}>
        <canvas className="pd-macmon-canvas" ref={canvasRef} aria-label={canvasLabel} />
        {needsCapture ? (
          <CapturePermissionPanel
            app={session.appName}
            asked={askedForCapture}
            onAllow={() => {
              setAskedForCapture(true);
              feed?.requestCapture?.();
            }}
            onOpenSettings={() => feed?.openCaptureSettings?.()}
          />
        ) : null}
        {takenOver ? (
          <div className="pd-macmon-state" data-kind="taken-over">
            <div className="pd-macmon-state-card">
              <StateMark app={session.appName} kind="taken-over" />
              <p className="pd-macmon-state-title">You're driving</p>
              <p className="pd-macmon-state-sub">
                Bobble stood down and stopped watching — nothing on this screen is being captured.
                Click {session.appName === '' ? 'the app' : session.appName} to carry on yourself.
              </p>
              <button type="button" className="pd-macmon-btn" onClick={onHandBack}>
                Let Bobble carry on
              </button>
            </div>
          </div>
        ) : null}
        {empty === null ? null : (
          <div className="pd-macmon-state" data-kind={empty.kind}>
            <div className="pd-macmon-state-card">
              <StateMark app={empty.mark === 'app' ? session.appName : ''} kind={empty.kind} />
              <p className="pd-macmon-state-title">{empty.title}</p>
              <p className="pd-macmon-state-sub">{empty.sub}</p>
            </div>
          </div>
        )}
        {pinned === null ? null : (
          <div className="pd-macmon-pinned" data-testid="macmon-pinned">
            <span>
              Pinned · act {pinnedIndex + 1} of {acts.length}
              {newSince > 0 ? ` · ${newSince} new since` : ''}
            </span>
            <button
              type="button"
              className="pd-macmon-pinned-resume"
              onClick={() => setPinned(null)}
            >
              Resume following
            </button>
          </div>
        )}
      </div>

      {/* Everything below is OUTSIDE the picture. The moment a toolbar floats
          over the stage this stops being a window onto the user's Mac and
          becomes a remote-desktop client. Three bands under one stage,
          differentiated by weight rather than by three card treatments. */}
      {acts.length === 0 ? null : (
        <ActStrip
          acts={acts}
          hovered={hovered}
          pinned={pinned}
          onHover={setHovered}
          onPin={(id) => setPinned((prev) => (prev === id ? null : id))}
        />
      )}

      {!session.active && session.appName === '' ? null : (
        <div className="pd-macmon-actions">
          {caps.stop === true ? (
            <button
              type="button"
              className="pd-macmon-btn pd-macmon-btn--danger"
              onClick={onStop}
              data-testid="macmon-stop"
              title="Stop — ⌘."
            >
              Stop
            </button>
          ) : null}
          {caps.pause === true ? (
            <button
              type="button"
              className="pd-macmon-btn"
              onClick={onPause}
              data-testid="macmon-pause"
            >
              Pause
            </button>
          ) : null}
          {caps.takeOver === true && !takenOver ? (
            <button
              type="button"
              className="pd-macmon-btn"
              onClick={onTakeOver}
              data-testid="macmon-takeover"
              title="Drive it yourself — Bobble stands down and stops watching"
            >
              Take over
            </button>
          ) : null}
          <button
            type="button"
            className="pd-macmon-btn"
            onClick={onCopy}
            data-testid="macmon-copy"
            title="Copy this frame as a picture"
          >
            {copied === 'ok' ? 'Copied' : copied === 'fail' ? "Couldn't copy" : 'Copy frame'}
          </button>
          <span className="pd-macmon-spacer" />
          <div className="pd-macmon-seg">
            <button
              type="button"
              className="pd-macmon-seg-btn"
              data-on={viewMode === 'fit' ? 'true' : 'false'}
              aria-pressed={viewMode === 'fit'}
              onClick={() => chooseMode(viewMode === 'fit' ? 'auto' : 'fit')}
              data-testid="macmon-fit"
              title="Fit the whole window in the tab"
            >
              Fit
            </button>
            <button
              type="button"
              className="pd-macmon-seg-btn"
              data-on={viewMode === 'follow' ? 'true' : 'false'}
              aria-pressed={viewMode === 'follow'}
              onClick={() => chooseMode(viewMode === 'follow' ? 'auto' : 'follow')}
              data-testid="macmon-follow"
              title="Zoom in and follow whatever is being acted on"
            >
              Follow
            </button>
          </div>
          {pillShown === undefined ? null : (
            <button
              type="button"
              className="pd-macmon-btn"
              data-on={pillShown ? 'true' : 'false'}
              aria-pressed={pillShown}
              onClick={() => feed?.setStatusPillShown?.(!pillShown)}
              data-testid="macmon-pill-toggle"
              title={
                pillShown
                  ? 'Hide the status pill on screen (the cursor keeps moving)'
                  : 'Show the status pill on screen'
              }
            >
              {pillShown ? 'Hide pill' : 'Show pill'}
            </button>
          )}
        </div>
      )}

      {/* Two groups and a rule. Identity on the left, connection on the right,
          and nothing that is neither. */}
      {!session.active && session.appName === '' ? null : (
        <div className="pd-macmon-footer">
          {session.appName === '' ? null : (
            <span className="pd-macmon-ident">
              {ident.edited ? (
                <span className="pd-macmon-edited" title="Unsaved changes" aria-hidden="true" />
              ) : null}
              <span className="pd-macmon-ident-text" title={ident.text}>
                {ident.text}
              </span>
            </span>
          )}
          <span className="pd-macmon-spacer" />
          {session.appName === '' ? null : (
            <>
              {scaleLabel === '' ? null : (
                <span className="pd-macmon-scale" title="The picture is scaled to fit this tab">
                  {scaleLabel}
                </span>
              )}
              <span className="pd-macmon-rule" aria-hidden="true" />
            </>
          )}
          <span
            className="pd-macmon-live"
            data-live={live && !stalled ? 'true' : 'false'}
            data-stalled={stalled ? 'true' : 'false'}
          >
            <span className="pd-macmon-dot" aria-hidden="true" />
            {stalled
              ? `Stalled · ${chrome.stalledFor}s`
              : live
                ? 'Live'
                : streamWord(session.stream)}
          </span>
        </div>
      )}

      {/* The narrative is painted into a canvas, which says nothing to a screen
          reader. This is the same sentence the bubble carries, once per act. */}
      <div className="pd-macmon-sr" role="status" aria-live="polite">
        {announced}
      </div>
    </div>
  );
}

/**
 * `TextEdit — Untitled 2`, one voice, truncating from the tail, with the
 * document's edited state carried by a dot rather than by the word "Edited"
 * hanging off the end of the title — which is how a Mac title bar says it.
 */
export function identity(app: string, title: string): { text: string; edited: boolean } {
  const edited = / [—-] Edited$/.test(title);
  const clean = edited ? title.replace(/ [—-] Edited$/, '') : title;
  if (app === '') return { text: clean, edited };
  return { text: clean === '' ? app : `${app} — ${clean}`, edited };
}

/**
 * The history strip: one chip per act, in order, newest last.
 *
 * Hover previews, click commits (Playwright's `highlightedAction ||
 * selectedAction`) — hovering repaints the stage with zero commitment, which is
 * the mechanic that makes a long list scannable.
 */
function ActStrip({
  acts,
  hovered,
  pinned,
  onHover,
  onPin,
}: {
  acts: readonly MonitorAct[];
  hovered: number | null;
  pinned: number | null;
  onHover: (id: number | null) => void;
  onPin: (id: number) => void;
}) {
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Follow the tail unless the user has pinned something — Playwright stops
    // following permanently once you click a row, with no way to resume, and
    // that is the one thing everybody who uses it complains about.
    if (pinned !== null || acts.length === 0) return;
    tail.current?.scrollTo({ left: tail.current.scrollWidth, behavior: 'auto' });
  }, [acts, pinned]);
  return (
    <div className="pd-macmon-strip" ref={tail} data-testid="macmon-strip">
      {acts.map((act) => (
        <button
          type="button"
          key={act.id}
          className="pd-macmon-chip"
          data-on={hovered === act.id || pinned === act.id ? 'true' : 'false'}
          data-dialog={act.dialog ? 'true' : 'false'}
          onMouseEnter={() => onHover(act.id)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(act.id)}
          onBlur={() => onHover(null)}
          onClick={() => onPin(act.id)}
          aria-label={`${act.verb}${act.object === '' ? '' : ` ${act.object}`}, ${actDuration(act)}`}
          title={`${act.verb}${act.object === '' ? '' : ` ${act.object}`}`}
        >
          <span className="pd-macmon-chip-shot" data-empty={act.thumb === null ? 'true' : 'false'}>
            {act.thumb === null ? null : <img src={act.thumb} alt="" draggable={false} />}
            <span className="pd-macmon-chip-dur" aria-hidden="true">
              {actDuration(act)}
            </span>
          </span>
          <span className="pd-macmon-chip-label">
            <span className="pd-macmon-chip-verb">{act.verb}</span>
            {act.object === '' ? null : <span className="pd-macmon-chip-object">{act.object}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Duration as a state machine — Playwright's one right-aligned slot per row
 * that is spinner (running) → `1.2s` (done). "Which act is running" then costs
 * no separate badge.
 */
function actDuration(act: MonitorAct): string {
  if (act.endedAt === null) return '···';
  const s = (act.endedAt - act.at) / 1000;
  return s < 0.1 ? '0.1s' : `${s.toFixed(1)}s`;
}

/** "Clicking Save" as a sentence, for the live region. */
function actSentence(act: MonitorAct, app: string): string {
  const what = act.object === '' ? act.verb : `${act.verb} ${act.object}`;
  return app === '' ? what : `${what}, in ${app}`;
}

/** "after clicking Save" — what the thinking bubble is thinking after. */
export function thinkingAfter(acts: readonly MonitorAct[]): string {
  const last = acts[acts.length - 1];
  if (last === undefined) return '';
  const verb =
    last.verb === 'Click'
      ? 'clicking'
      : last.verb === 'Type'
        ? 'typing'
        : last.verb === 'Press'
          ? 'pressing'
          : last.verb === 'Scroll'
            ? 'scrolling'
            : last.verb === 'Open'
              ? 'opening'
              : last.verb.toLowerCase();
  if (verb === '') return '';
  return `after ${verb}${last.object === '' ? '' : ` ${ellipsizeWords(last.object, 22)}`}`;
}

function ellipsizeWords(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * The mark on an empty-state panel.
 *
 * A generic monitor glyph on every state is what made `07`, `08` and `09`
 * pixel-identical apart from two lines of text, in a tab that knows perfectly
 * well which app this is about. The app's own icon would be better still and is
 * one main-process `getFileIcon` away; the monogram is the part that can be
 * true today, and it carries the identity a grey display glyph does not.
 */
function StateMark({ app, kind }: { app: string; kind: string }) {
  const name = app.trim();
  if (name === '') {
    return (
      <div className="pd-macmon-state-mark" data-kind="glyph" aria-hidden="true">
        <ScreenGlyph pulse={kind === 'waiting'} />
      </div>
    );
  }
  const letters = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <div
      className="pd-macmon-state-mark"
      data-kind="app"
      data-pulse={kind === 'waiting' ? 'true' : 'false'}
      aria-hidden="true"
    >
      {letters}
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
/**
 * THE REAL macOS SCREEN RECORDING ICON — a white circle on a red superellipse.
 *
 * Drawn rather than shipped as an asset: it is the mark the user is about to
 * look for in System Settings, and a panel that shows a DIFFERENT glyph than the
 * one on the row they have to find is a panel that makes the job harder. The
 * squircle is Apple's continuous corner, not a rounded rect — the difference is
 * small and it is the whole reason their icons read as theirs.
 */
function ScreenRecordingIcon({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <title>Screen Recording</title>
      <defs>
        <linearGradient id="pd-srec-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff5f52" />
          <stop offset="1" stopColor="#e0281c" />
        </linearGradient>
      </defs>
      {/* An Apple continuous-corner squircle, as a path — a plain rx rounds the
          corner with a circular arc, which reads visibly tighter than theirs. */}
      <path
        d="M32 1.5C50.8 1.5 58 8.7 58 27.5v9C58 55.3 50.8 62.5 32 62.5S6 55.3 6 36.5v-9C6 8.7 13.2 1.5 32 1.5Z"
        fill="url(#pd-srec-g)"
      />
      <circle cx="32" cy="32" r="13.5" fill="#fff" />
    </svg>
  );
}

/**
 * WHAT TO SHOW WHEN THERE ARE NO PIXELS.
 *
 * This surface used to draw the window from its Accessibility tree — every
 * control as a labelled box, in its real position. It is honest and it is
 * genuinely useful for a form, and the user's verdict on it against a real app was
 * the right one: "that reconstruction of the calculator app does not feel like
 * it's at the best it can be, surely you can get color layout and such more?"
 *
 * It cannot. Accessibility gives roles, names and rectangles — no colour, no
 * type, no artwork, no custom-drawn anything. The layout is real; everything
 * that makes an app look like itself is unavailable in principle, not for want
 * of effort. So a drawing of an ARBITRARY app is always going to be a grey
 * approximation of it, and the user's instruction covers exactly that case: "if you
 * can't do that great a construction for any arbitrary app, just show in there
 * 'please enable screen recording to show preview'".
 *
 * Which is also the better outcome, because the real thing is one grant away —
 * and once granted, "always use the real window visual" (the user), which is what
 * `pickMonitorSource` already does by preferring pixels over everything.
 */
function CapturePermissionPanel({
  app,
  onAllow,
  onOpenSettings,
  asked,
}: {
  app: string;
  onAllow: () => void;
  onOpenSettings: () => void;
  /** True once this panel has asked — the system only prompts once per app. */
  asked: boolean;
}) {
  return (
    <div className="pd-macmon-state" data-kind="permission" data-testid="macmon-permission">
      <div className="pd-macmon-state-card pd-macmon-perm">
        <ScreenRecordingIcon />
        <p className="pd-macmon-state-title">Enable Screen Recording to show the preview</p>
        <p className="pd-macmon-state-sub">
          Bobble is controlling {app === '' ? 'the app' : app} right now and that part works without
          it — this is only so you can watch.
        </p>
        <ol className="pd-macmon-perm-steps">
          <li>
            <span className="pd-macmon-perm-step">1</span>
            Press the button below.
          </li>
          <li>
            <span className="pd-macmon-perm-step">2</span>
            {asked ? (
              <>
                Find <strong>Bobble</strong> under Screen &amp; System Audio Recording and turn it
                on.
              </>
            ) : (
              <>
                Choose <strong>Allow</strong> when macOS asks.
              </>
            )}
          </li>
        </ol>
        <button type="button" className="pd-macmon-btn pd-macmon-btn--primary" onClick={onAllow}>
          {asked ? 'Open Screen Recording settings' : 'Allow Screen Recording'}
        </button>
        {asked ? null : (
          <button type="button" className="pd-macmon-perm-alt" onClick={onOpenSettings}>
            Already said no? Open Settings
          </button>
        )}
      </div>
    </div>
  );
}

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
  /** The app's own identity, or the generic glyph when there is no app. */
  mark: 'app' | 'glyph';
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
    // The one screen with room to teach that the feature exists. It used to
    // explain the widget ("this view wakes up when…") in a passive, slightly
    // ominous voice; it now says what you can ask for.
    return {
      kind: 'idle',
      mark: 'glyph',
      title: "Bobble isn't using any apps right now",
      sub: "Ask for something like \u201copen Notes and write up today's meeting\u201d and you'll be able to watch it here.",
    };
  }
  if (session.stream === 'unavailable') {
    // Reached only when the Accessibility drawing has nothing either — the app
    // is between windows, or the tree came back empty. With a scene in hand the
    // surface draws it instead and this panel never appears.
    return {
      kind: 'unavailable',
      mark: 'app',
      title: session.captureDenied ? 'Screen Recording is off' : 'Live view unavailable',
      sub: session.captureDenied
        ? `Bobble is still in control of ${app}. The view comes back as soon as it can read a window.`
        : (session.streamError ?? `The screen capture for ${app} could not start.`),
    };
  }
  if (session.stream === 'no-window') {
    return {
      kind: 'no-window',
      mark: 'app',
      title: `${app} has no window on screen`,
      sub: 'Bobble is still in control — the view comes back when a window opens.',
    };
  }
  if (frame?.bitmap == null) {
    // "Connecting" implies a network and "frame" is a video-codec word. What is
    // actually happening is either a window opening or a picture being taken.
    const opening = session.cursorState === 'opening';
    return {
      kind: 'waiting',
      mark: 'app',
      title: opening ? `Opening ${app}'s window` : `Getting a picture of ${app}`,
      sub: opening
        ? 'The picture arrives a moment after the window does.'
        : 'Bobble is already in control; the view catches up in a moment.',
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
 * A calm ground under an empty panel, and ONLY under an empty panel.
 *
 * The wallpaper is deliberately undimmed while something is happening (the user:
 * "don't blur the wallpaper please"), which is right — but it means the state
 * that says "nothing is happening" lands on a sunlit photograph at full
 * brightness, which is louder than the state that says something is. This is
 * the one case where the picture is not the subject.
 */
function scrimStage(ctx: CanvasRenderingContext2D, viewport: { w: number; h: number }): void {
  ctx.save();
  ctx.fillStyle = 'rgba(8, 9, 12, 0.42)';
  ctx.fillRect(0, 0, viewport.w, viewport.h);
  ctx.restore();
}

/**
 * Dim the window BEHIND a sheet, the way macOS's own composition does.
 *
 * Four bands around the dialog rather than a re-blit: the picture is already
 * down, and punching a hole in a fill is cheaper and cannot resample the
 * dialog's own pixels.
 */
function dimBehindDialog(
  ctx: CanvasRenderingContext2D,
  drawn: DrawnWindow,
  rect: MacMonitorRect,
  dialog: MacMonitorRect,
  radius: number,
): void {
  const k = drawn.scale;
  const dx = drawn.x + (dialog.x - rect.x) * k;
  const dy = drawn.y + (dialog.y - rect.y) * k;
  const dw = dialog.w * k;
  const dh = dialog.h * k;
  ctx.save();
  roundRect(ctx, drawn.x, drawn.y, drawn.w, drawn.h, radius);
  ctx.clip();
  // 0.18 rather than the 0.28 a bare window would want: several real apps
  // (and the mock) already dim their own content under a sheet, and dimming a
  // dimmed window twice reads as a rendering fault rather than as a beat.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillRect(drawn.x, drawn.y, drawn.w, Math.max(0, dy - drawn.y));
  ctx.fillRect(drawn.x, dy + dh, drawn.w, Math.max(0, drawn.y + drawn.h - (dy + dh)));
  ctx.fillRect(drawn.x, dy, Math.max(0, dx - drawn.x), dh);
  ctx.fillRect(dx + dw, dy, Math.max(0, drawn.x + drawn.w - (dx + dw)), dh);
  ctx.restore();
}

/**
 * The names a sheet's own confirming button goes by, in the order a caption
 * should prefer them. macOS sheets are overwhelmingly one of these.
 */
const CONFIRM_BUTTONS = [
  'Save',
  'Replace',
  'Open',
  'Send',
  'Allow',
  'Delete',
  'Discard',
  "Don't Save",
  'Continue',
  'Done',
  'OK',
];

/** "TextEdit is asking: Save" — what the sheet is, in the app's own voice. */
export function dialogCaption(app: string, title: string, buttons: readonly string[] = []): string {
  const who = app.trim() === '' ? 'This app' : app.trim();
  const what = title.trim();
  if (what !== '') return `${who} is asking: ${what}`;
  // TextEdit's real save sheet measures as `title: ""` — the most common dialog
  // on macOS produces no name at all. Naming it from its own confirming button
  // is what the tree already knows; "untitled" is a fact about our data rather
  // than about the user's screen, and this caption never says it.
  const confirm = CONFIRM_BUTTONS.find((name) =>
    buttons.some((b) => b.trim().toLowerCase() === name.toLowerCase()),
  );
  return confirm === undefined ? `${who} is asking you something` : `${who} is asking: ${confirm}`;
}

/**
 * The caption, centred UNDER the dialog rather than in the far corner of the
 * footer. The dialog is dead centre of a wide stage; a chip 900px away from it
 * never read as related to it — and, being a bordered filled pill labelled
 * "Save", read as a button a user would click.
 */
function drawDialogCaption(
  ctx: CanvasRenderingContext2D,
  drawn: DrawnWindow,
  rect: MacMonitorRect,
  dialog: MacMonitorRect,
  viewport: { w: number; h: number },
  text: string,
  k: number,
): void {
  const scale = drawn.scale;
  const cx = drawn.x + (dialog.x - rect.x + dialog.w / 2) * scale;
  const bottom = drawn.y + (dialog.y - rect.y + dialog.h) * scale;
  const size = 13 * k;
  ctx.save();
  ctx.font = `500 ${size}px -apple-system, system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 22 * k;
  const h = 18 * k + 8 * k;
  const x = Math.max(8, Math.min(viewport.w - 8 - w, cx - w / 2));
  const y = Math.min(viewport.h - 8 - h, bottom + 12 * k);
  ctx.fillStyle = 'rgba(18, 20, 25, 0.9)';
  roundRect(ctx, x, y, w, h, 8 * k);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 8 * k);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, x + w / 2, y + h / 2);
  ctx.restore();
}

/**
 * "Something is happening", as the FRAME.
 *
 * Skyvern's single best idea: an 8px outline inset 2px inside the viewport,
 * breathing. It reads from across the room, costs one draw call, and can never
 * be mistaken for app chrome because real chrome is inside the frame. It also
 * frees the bubble to carry words rather than the whole burden of being the
 * only signal that work is in flight.
 */
function drawWorkingOutline(
  ctx: CanvasRenderingContext2D,
  drawn: DrawnWindow,
  viewport: { w: number; h: number },
  radius: number,
  accent: string,
  now: number,
  reduced: boolean,
): void {
  // Follow mode crops the window, so the outline hugs whichever of the window
  // and the stage is smaller — never a rectangle floating off-screen.
  const x = Math.max(0, drawn.x);
  const y = Math.max(0, drawn.y);
  const w = Math.min(viewport.w, drawn.x + drawn.w) - x;
  const h = Math.min(viewport.h, drawn.y + drawn.h) - y;
  if (w <= 2 || h <= 2) return;
  const width = Math.max(4, 8 * drawn.scale);
  // Skyvern insets its outline because its stage IS the viewport. Ours usually
  // is not: when the whole window is on the stage the outline goes just OUTSIDE
  // it, so it never covers the app's own edge pixels — and only tucks inside
  // when the stage is doing the cropping and there is no outside to draw in.
  const clipped = drawn.x < 0 || drawn.y < 0 || drawn.w > viewport.w || drawn.h > viewport.h;
  const inset = clipped ? width / 2 : -width / 2 - 1;
  const breath = reduced ? 0.5 : 0.5 + 0.5 * Math.sin((now / 1600) * Math.PI * 2);
  ctx.save();
  ctx.globalAlpha = 0.18 + breath * 0.14;
  ctx.strokeStyle = accent;
  ctx.lineWidth = width;
  roundRect(ctx, x + inset, y + inset, w - inset * 2, h - inset * 2, Math.max(2, radius));
  ctx.stroke();
  ctx.restore();
}

/** Where the crop is, inside the whole window. 96px, bottom-right, quiet. */
function drawMinimap(
  ctx: CanvasRenderingContext2D,
  rect: MacMonitorRect,
  viewport: { w: number; h: number },
  drawn: DrawnWindow,
): void {
  const w = 84;
  const h = Math.max(20, Math.round((w * rect.h) / Math.max(1, rect.w)));
  const x = viewport.w - w - 14;
  const y = viewport.h - h - 14;
  if (x < 10 || y < 10) return;
  const seen = visibleRegion(rect, viewport, drawn);
  const k = w / Math.max(1, rect.w);
  ctx.save();
  // The whole window as a pale sheet on a dark plate, and the slice you are
  // looking at picked out of it. A crop with no map is disorienting; this says
  // "you are here" in about a hundred pixels.
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = 'rgba(10, 12, 16, 0.76)';
  roundRect(ctx, x - 5, y - 5, w + 10, h + 10, 7);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  roundRect(ctx, x - 4.5, y - 4.5, w + 9, h + 9, 6.5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.26)';
  roundRect(ctx, x, y, w, h, 2);
  ctx.fill();
  const rx = x + (seen.x - rect.x) * k;
  const ry = y + (seen.y - rect.y) * k;
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fillRect(rx, ry, seen.w * k, seen.h * k);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1;
  ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, seen.w * k - 1), Math.max(1, seen.h * k - 1));
  ctx.restore();
}

/**
 * The act's pictures, taken off the LIVE CANVAS — which is why they are already
 * annotated (the phantom and the ripple are in the frame) and why one code path
 * serves both the pixel stream and the Accessibility drawing.
 *
 * Two sizes from one read: a 72×48 chip cropped around the act (a thumbnail of
 * a whole 900pt window shows nothing; one of the region around the click shows
 * the click) and a ≤900px frame for scrubbing the stage back.
 */
function captureAct(
  canvas: HTMLCanvasElement | null,
  placed: { drawn: DrawnWindow; rect: MacMonitorRect; painted: boolean } | null,
  point: Point | null,
): { thumb: string; frame: string } | null {
  if (canvas === null || placed === null || !placed.painted) return null;
  const dpr = canvas.clientWidth === 0 ? 1 : canvas.width / canvas.clientWidth;
  const { drawn } = placed;
  const sx = Math.max(0, drawn.x * dpr);
  const sy = Math.max(0, drawn.y * dpr);
  const sw = Math.min(canvas.width - sx, drawn.w * dpr);
  const sh = Math.min(canvas.height - sy, drawn.h * dpr);
  if (!(sw > 8) || !(sh > 8)) return null;
  try {
    const scale = Math.min(1, FRAME_MAX_W / (sw / dpr));
    const frame = document.createElement('canvas');
    frame.width = Math.max(1, Math.round((sw / dpr) * scale));
    frame.height = Math.max(1, Math.round((sh / dpr) * scale));
    const fg = frame.getContext('2d');
    if (fg === null) return null;
    fg.imageSmoothingQuality = 'high';
    fg.drawImage(canvas, sx, sy, sw, sh, 0, 0, frame.width, frame.height);

    // The chip: the region around the act, at 3× the chip's own size so the
    // control that was clicked is recognisable rather than a grey smudge.
    const chip = document.createElement('canvas');
    chip.width = CHIP_W * 2;
    chip.height = CHIP_H * 2;
    const cg = chip.getContext('2d');
    if (cg === null) return null;
    const cropW = Math.min(sw, CHIP_W * 4.5 * dpr);
    const cropH = Math.min(sh, CHIP_H * 4.5 * dpr);
    const centre =
      point === null
        ? { x: sx + sw / 2, y: sy + sh / 2 }
        : {
            x: (drawn.x + (point.x - placed.rect.x) * drawn.scale) * dpr,
            y: (drawn.y + (point.y - placed.rect.y) * drawn.scale) * dpr,
          };
    const cx = Math.max(sx, Math.min(sx + sw - cropW, centre.x - cropW / 2));
    const cy = Math.max(sy, Math.min(sy + sh - cropH, centre.y - cropH / 2));
    cg.imageSmoothingQuality = 'high';
    cg.drawImage(canvas, cx, cy, cropW, cropH, 0, 0, chip.width, chip.height);
    return {
      thumb: chip.toDataURL('image/jpeg', 0.7),
      frame: frame.toDataURL('image/jpeg', 0.72),
    };
  } catch {
    // A tainted canvas (a wallpaper served without CORS) must cost the history,
    // never the live view.
    return null;
  }
}

/**
 * Copy the current frame to the clipboard as a PNG.
 *
 * A picture of what the agent just did is the single most useful thing to paste
 * into a bug report, and the tab bar's own Copy is hidden for this surface
 * because there is "no text to copy" — which was true and beside the point.
 */
async function copyFrame(
  canvas: HTMLCanvasElement | null,
  placed: { drawn: DrawnWindow; rect: MacMonitorRect; painted: boolean } | null,
): Promise<boolean> {
  if (canvas === null) return false;
  try {
    const dpr = canvas.clientWidth === 0 ? 1 : canvas.width / canvas.clientWidth;
    const out = document.createElement('canvas');
    let sx = 0;
    let sy = 0;
    let sw = canvas.width;
    let sh = canvas.height;
    if (placed?.painted === true) {
      sx = Math.max(0, placed.drawn.x * dpr);
      sy = Math.max(0, placed.drawn.y * dpr);
      sw = Math.min(canvas.width - sx, placed.drawn.w * dpr);
      sh = Math.min(canvas.height - sy, placed.drawn.h * dpr);
    }
    out.width = Math.max(1, Math.round(sw));
    out.height = Math.max(1, Math.round(sh));
    const g = out.getContext('2d');
    if (g === null) return false;
    g.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    if (blob === null) return false;
    const items = { 'image/png': blob };
    await navigator.clipboard.write([new ClipboardItem(items)]);
    return true;
  } catch {
    return false;
  }
}

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

  /*
   * HIS PAINT, and the panel's: a #95F9E5 glow, a solid #78BFE5 body, a white
   * keyline. The old stack was a pearl gradient with two luminous rims tuned to
   * match overlay.html — a file that no longer exists, for a glyph that no
   * longer exists. Matching the NATIVE panel is what matters now: the phantom on
   * screen and the phantom in this tab have to be the same object.
   */
  ctx.save();
  ctx.shadowColor = CURSOR_GLOW;
  ctx.shadowBlur = 13;
  ctx.fillStyle = CURSOR_GLOW;
  ctx.globalAlpha = 0.38;
  ctx.fill(path);
  ctx.globalAlpha = 1;
  ctx.restore();

  ctx.fillStyle = CURSOR_BODY;
  ctx.fill(path);

  ctx.strokeStyle = CURSOR_KEYLINE;
  ctx.lineWidth = CURSOR_STROKE_W;
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
 * DELIBERATE DEVIATION: the on-screen overlay fills it with a dark navy
 * gradient (`rgba(30,41,66)` → `rgba(22,30,50)`); this one is neutral glass
 * lifted by the CURRENT THEME's accent, so it belongs to whichever flavour is
 * on rather than to one hardcoded palette. Shape, type and motion are the
 * identity; the fill is the app's. (The comment that used to sit here claimed
 * the overlay's fill was "indigo→violet" and that this was a no-purple
 * workaround. It is not violet and never was — see overlay.html:106.)
 *
 * THREE DOTS MEAN ONE THING: waiting on the model. They used to be on five of
 * the seven states, which made "Scrolling ⋯" and "Thinking ⋯" the same picture
 * at a glance. An act in progress gets a steady mark instead — different shape,
 * different meaning, and nothing moving for a user who asked for no motion.
 */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number },
  k: number,
  viewport: { w: number; h: number },
  bubble: Bubble,
  palette: Palette,
  drawn: DrawnWindow,
  reduced: boolean,
): void {
  const { label, detail, dots, mark } = bubble;
  if (label === '') return;
  const fontSize = 12.5 * k;
  const padX = 13 * k;
  const padY = 7 * k;
  const gap = 7 * k;
  const dotsWidth = dots ? 4 * 3 * k + 3 * 2 * k + gap : mark ? 7 * k + gap : 0;

  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
  const labelWidth = ctx.measureText(label).width;
  const detailFont = `500 ${11.5 * k}px ui-monospace, "SF Mono", Menlo, monospace`;
  // The bubble may not eat the window it is annotating: measured at the docked
  // scale it spanned 28% of the drawn window and covered a dialog's Cancel
  // button. The detail truncates from the HEAD, because the end of what is
  // being typed is the part that is still changing.
  const room = Math.max(120 * k, Math.min(drawn.w, viewport.w) * 0.4);
  let shown = detail;
  let detailWidth = 0;
  if (detail !== '') {
    ctx.font = detailFont;
    const budget = room - (padX * 2 + dotsWidth + labelWidth);
    const fits = (t: string): boolean => ctx.measureText(` ${t}`).width <= budget;
    if (!fits(shown)) {
      // Context ("after pressing ⌘S") degrades to its verb and then vanishes:
      // head-truncating it produces "…ssing ⌘S", which is worse than silence.
      // A typed preview is the opposite — the END is the part still changing —
      // so that one truncates from the head and keeps going.
      shown = bubble.truncate === 'head' ? shown : shortenContext(shown, fits);
      if (bubble.truncate === 'head') {
        while (shown.length > 1 && !fits(`…${shown}`)) {
          shown = shown.slice(Math.max(1, Math.ceil(shown.length * 0.12)));
        }
        if (shown !== detail) shown = `…${shown}`;
      }
    }
    detailWidth = shown === '' ? 0 : ctx.measureText(` ${shown}`).width;
  }
  const w = padX * 2 + dotsWidth + labelWidth + detailWidth;
  const h = fontSize * 1.2 + padY * 2;
  const anchor = bubbleAnchor(at, { w, h }, viewport, { x: 27 * k, y: 40 * k }, 8);

  // Glass pill: dark enough that any window content reads behind it, lifted by
  // the theme accent and a hairline top highlight. The fill was near-black,
  // which left the accent ring reading as a slightly-less-black edge in light
  // mode; it is a touch lighter now so the ring has something to sit against.
  ctx.save();
  ctx.shadowColor = 'rgba(6, 8, 14, 0.5)';
  ctx.shadowBlur = 18 * k;
  ctx.shadowOffsetY = 4 * k;
  ctx.fillStyle = 'rgba(22, 24, 30, 0.92)';
  roundRect(ctx, anchor.x, anchor.y, w, h, h / 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2 * k;
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
    const phase = reduced ? 0 : performance.now() / 1250;
    for (let i = 0; i < 3; i++) {
      const local = (phase - i * 0.128) % 1;
      const lift = !reduced && local > 0 && local < 0.3 ? Math.sin((local / 0.3) * Math.PI) : 0;
      ctx.globalAlpha = reduced ? 0.8 : 0.45 + lift * 0.55;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + 2 * k, midY - lift * 2.5 * k, 2 * k, 0, Math.PI * 2);
      ctx.fill();
      x += 4 * k + 3 * k;
    }
    ctx.globalAlpha = 1;
    x += gap - 3 * k;
  } else if (mark) {
    // An act in flight: one steady mark in the theme accent. Not a spinner, not
    // dots — "this is happening", as opposed to "we are waiting".
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(x + 3.5 * k, midY, 3.5 * k, 0, Math.PI * 2);
    ctx.fill();
    x += 7 * k + gap;
  }

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(label, x, midY);
  if (shown !== '') {
    ctx.globalAlpha = 0.78;
    ctx.font = detailFont;
    ctx.fillText(` ${shown}`, x + labelWidth, midY);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
