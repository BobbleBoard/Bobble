/**
 * A `pi-mac` snapshot → the monitor's Accessibility SCENE.
 *
 * The fallback's whole job is to draw the controlled app when its pixels are
 * unreachable, and everything it draws has to be something Accessibility
 * actually said. This module is the seam where a helper reply — loose, optional
 * fields, an older build missing half of them — becomes the tight shape the
 * renderer paints from, so the renderer never has to ask "did the helper send
 * this?" and can never be tempted to invent a value that is missing.
 *
 * Pure, and separate from monitor-core.ts, because the two rules that matter
 * are assertions rather than opinions:
 *
 *  - THE STAGE MUST NOT MOVE. The capture path's rect is the union of every
 *    window the app owns (StreamShape.of, pi-mac). So is this one, computed the
 *    same way from the same window list — switching source must not shift the
 *    picture by a point.
 *  - CHROME IS NOT CONTENT. macOS hands out invisible AXUnknown host windows
 *    (a shadow, a panel service's carrier); drawing them puts empty grey cards
 *    on the stage and, worse, drags the union rect out to enclose them.
 */
import type {
  MacMonitorAxElement,
  MacMonitorAxScene,
  MacMonitorAxWindow,
} from './mac-monitor-contract';

/** The subset of the helper's `snapshot` reply the monitor reads. Structural,
 * so the mock frame source can stand in for the helper. */
export interface MacAxSnapshotLike {
  app?: unknown;
  pid?: unknown;
  windows?: unknown;
  elements?: unknown;
  windowBounds?: unknown;
  union?: unknown;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rectOf(value: unknown): Rect | null {
  if (value === null || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const w = num(r.w, -1);
  const h = num(r.h, -1);
  if (w <= 0 || h <= 0) return null;
  return { x: num(r.x), y: num(r.y), w, h };
}

/**
 * Is this window something the user can SEE?
 *
 * A sheet or a modal always is, whatever it calls itself — that is the surface
 * this whole feature exists for. Everything else has to be a window-shaped
 * window: `AXUnknown` is macOS's carrier for a shadow or a panel service, and
 * TextEdit alone puts up a 248×83 one beside its save sheet.
 */
export function isDrawableAxWindow(w: {
  role: string;
  subrole: string;
  sheet: boolean;
  modal: boolean;
  frame: Rect;
}): boolean {
  if (w.frame.w < 24 || w.frame.h < 24) return false;
  if (w.sheet || w.modal) return true;
  if (w.role === 'AXUnknown' || w.subrole === 'AXUnknown') return false;
  return true;
}

/** Union of every rect, or null when there are none. */
export function unionOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Normalize the helper's window list, front-to-back, chrome dropped. */
export function axWindowsFrom(raw: unknown): MacMonitorAxWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: MacMonitorAxWindow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const frame = rectOf(w.frame);
    if (frame === null) continue;
    const win: MacMonitorAxWindow = {
      windowId: num(w.windowId, -1),
      title: str(w.title),
      role: str(w.role),
      subrole: str(w.subrole),
      frame,
      main: w.main === true,
      focused: w.focused === true,
      sheet: w.sheet === true,
      modal: w.modal === true,
    };
    if (!isDrawableAxWindow(win)) continue;
    out.push(win);
  }
  return out;
}

/**
 * Normalize the helper's element list.
 *
 * `bbox` stays in the wire's own space (x,y are the element's CENTRE) — the
 * renderer converts once, where it draws. A `value` is copied only when AX
 * returned one: the difference between an empty field and a field whose
 * contents we do not know is exactly what the fallback must not blur.
 */
export function axElementsFrom(raw: unknown): MacMonitorAxElement[] {
  if (!Array.isArray(raw)) return [];
  const out: MacMonitorAxElement[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const bbox = rectOf(e.bbox);
    if (bbox === null) continue;
    const role = str(e.role);
    if (role === '') continue;
    const el: MacMonitorAxElement = {
      index: num(e.index, 0),
      role,
      name: str(e.name),
      bbox,
    };
    if (typeof e.value === 'string' && e.value !== '') el.value = e.value;
    if (e.editable === true) el.editable = true;
    if (e.focused === true) el.focused = true;
    if (e.enabled === false) el.enabled = false;
    if (typeof e.win === 'number') el.win = e.win;
    out.push(el);
  }
  return out;
}

/**
 * Build the scene, or null when there is nothing to draw.
 *
 * Null rather than an empty scene on purpose: "Accessibility returned no
 * windows" must leave the surface on its own honest empty state, not on a
 * drawing of a blank stage that looks like the app vanished.
 */
export function axSceneFrom(
  snap: MacAxSnapshotLike,
  meta: {
    t: number;
    pid: number;
    appName: string;
    display: { w: number; h: number } | null;
  },
): MacMonitorAxScene | null {
  const windows = axWindowsFrom(snap.windows);
  // Fall back to the single snapshotted window when an older helper sends no
  // window list at all — one window drawn is worth more than an error panel.
  const only = windows.length === 0 ? rectOf(snap.windowBounds) : null;
  const drawable: MacMonitorAxWindow[] =
    only === null
      ? windows
      : [
          {
            windowId: -1,
            title: '',
            role: 'AXWindow',
            subrole: 'AXStandardWindow',
            frame: only,
            main: true,
            focused: true,
            sheet: false,
            modal: false,
          },
        ];
  if (drawable.length === 0) return null;
  const rect = unionOf(drawable.map((w) => w.frame));
  if (rect === null) return null;
  const ids = new Set(drawable.map((w) => w.windowId));
  const elements = axElementsFrom(snap.elements).filter(
    // An element belonging to a window we dropped as chrome must go with it,
    // or it floats on the stage attached to nothing.
    (e) => e.win === undefined || ids.has(e.win) || ids.has(-1),
  );
  const name = str(snap.app);
  return {
    t: meta.t,
    pid: typeof snap.pid === 'number' ? snap.pid : meta.pid,
    appName: name === '' ? meta.appName : name,
    rect,
    display: meta.display,
    windows: drawable,
    elements,
  };
}
