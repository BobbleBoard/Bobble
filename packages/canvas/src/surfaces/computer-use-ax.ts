/**
 * Drawing the controlled app from ACCESSIBILITY instead of from pixels.
 *
 * Screen Recording is a grant a Mac does not have by default and that a lot of
 * people never turn on. Accessibility is the grant computer-use cannot function
 * without at all — so when the capture stream is unavailable the monitor still
 * has a complete, live description of the app: every window's frame, every
 * sheet, and every control at its real position with its real text.
 *
 * This module is the DECIDING half of drawing that: which source the surface
 * should use, what shape a role becomes, how a window's parts are laid out, and
 * how a value is fitted into the box AX said it occupies. It is pure so those
 * rules are assertions rather than opinions — the one rule that matters most
 * being that nothing here may ever produce content Accessibility did not
 * report. A drawn approximation of a real window is honest. A drawn
 * approximation with invented labels in it is a forgery.
 */
import type {
  MacMonitorAxElement,
  MacMonitorAxScene,
  MacMonitorAxWindow,
  MacMonitorSessionState,
} from './computer-use-feed.ts';
import type { Rect } from './computer-use-geometry.ts';

/** Where the picture in the tab is coming from. */
export type MonitorSource = 'pixels' | 'permission' | 'none';

/**
 * Pick the source.
 *
 * PIXELS WIN whenever there are any: a photograph of the window is always
 * better than anything else, and a capture grant that arrives mid-session
 * should simply take over with nothing to restart.
 *
 * Accessibility takes over only when the stream has actually given up — which
 * covers both halves of the brief: `stream === 'unavailable'`, and the frame
 * that arrives carrying `error: "screen-recording-denied"` (main turns that
 * into exactly this state, so the surface has one condition to test rather than
 * two that can disagree).
 *
 * `'none'` is not a failure — it is "say the honest empty thing", which the
 * surface already does better than any drawing could.
 */
export function pickMonitorSource(
  session: Pick<MacMonitorSessionState, 'active' | 'stream' | 'captureDenied'>,
  frame: { bitmap: unknown | null } | null,
): MonitorSource {
  if (!session.active) return 'none';
  /*
   * PIXELS WIN, ALWAYS. The user: "when screen recording permissions are granted
   * always use the real window visual."
   */
  if (frame?.bitmap != null) return 'pixels';
  /*
   * No pixels because the grant is missing → ask for it, rather than drawing a
   * grey approximation of the app. See CapturePermissionPanel for why the
   * Accessibility drawing was retired: AX has roles, names and rectangles and
   * no colour, type or artwork, so a reconstruction of an ARBITRARY app can
   * never look like that app.
   */
  if (session.captureDenied) return 'permission';
  return 'none';
}

/** The shapes the renderer knows how to paint. */
export type AxShape =
  | 'document' // a big editable text surface — the document itself
  | 'field' // text field / search field / combo box
  | 'button'
  | 'popup' // pop-up button / menu button: label plus chevrons
  | 'checkbox'
  | 'radio'
  | 'toggle' // a control too small to hold its own name (a toolbar chip)
  | 'link'
  | 'tab'
  | 'row' // a table/outline row or cell
  | 'slider'
  | 'disclosure'
  | 'plain'; // known to be there, nothing more specific to say

/** A control narrower than this cannot hold a label, whatever its role says. */
const LABEL_MIN_W = 46;
/** A text surface at least this big is the document, not a field. */
const DOCUMENT_MIN_H = 90;

/**
 * Role → shape.
 *
 * Two adjustments to the literal role, both because macOS reuses roles for
 * things that look nothing alike:
 *
 *  - a TEXT AREA the size of a page is the DOCUMENT, and a small one is a
 *    field. TextEdit's body and a comment box are the same role.
 *  - a CHECKBOX 22pt wide is a toolbar chip, not a tick box with a label
 *    beside it. TextEdit's Bold/Italic/alignment controls are all AXCheckBox,
 *    and drawing seven captioned tick boxes across the ruler would be a worse
 *    likeness than drawing the seven chips that are actually there.
 */
export function axShapeFor(el: Pick<MacMonitorAxElement, 'role' | 'bbox' | 'editable'>): AxShape {
  const { w, h } = el.bbox;
  switch (el.role) {
    case 'AXTextArea':
      return h >= DOCUMENT_MIN_H ? 'document' : 'field';
    case 'AXTextField':
    case 'AXSearchField':
    case 'AXComboBox':
      return 'field';
    case 'AXPopUpButton':
    case 'AXMenuButton':
      return w >= LABEL_MIN_W ? 'popup' : 'toggle';
    case 'AXButton':
    case 'AXToolbarButton':
      return w >= LABEL_MIN_W ? 'button' : 'toggle';
    case 'AXCheckBox':
      return w >= LABEL_MIN_W ? 'checkbox' : 'toggle';
    case 'AXRadioButton':
      return w >= LABEL_MIN_W ? 'radio' : 'toggle';
    case 'AXLink':
      return 'link';
    case 'AXTab':
    case 'AXTabGroup':
    case 'AXSegmentedControl':
      return 'tab';
    case 'AXRow':
    case 'AXCell':
      return 'row';
    case 'AXSlider':
      return 'slider';
    case 'AXDisclosureTriangle':
      return 'disclosure';
    default:
      return el.editable === true ? 'field' : 'plain';
  }
}

/**
 * What text this element should show, or `''` for none.
 *
 * A field shows its VALUE, because that is what is in it. A field with no value
 * shows nothing rather than its accessible name: AX names a filename field
 * "Save As:", and painting that inside the box would put a label where the
 * user's typing is. Everything else shows its name, which for a button is the
 * word on the button.
 */
export function axLabelFor(el: MacMonitorAxElement, shape: AxShape): string {
  if (shape === 'document') return el.value ?? '';
  if (shape === 'field') return el.value ?? '';
  if (shape === 'toggle') return '';
  return el.name;
}

/** bbox (x,y = CENTRE, the pi-mac wire's space) → a top-left rect. */
export function rectOfBbox(bbox: { x: number; y: number; w: number; h: number }): Rect {
  return { x: bbox.x - bbox.w / 2, y: bbox.y - bbox.h / 2, w: bbox.w, h: bbox.h };
}

/** Does `inner` sit inside `outer` (allowing a point of slop)? */
export function rectContains(outer: Rect, inner: Rect, slop = 2): boolean {
  return (
    inner.x >= outer.x - slop &&
    inner.y >= outer.y - slop &&
    inner.x + inner.w <= outer.x + outer.w + slop &&
    inner.y + inner.h <= outer.y + outer.h + slop
  );
}

/** One element, resolved for drawing. */
export interface AxDrawable {
  el: MacMonitorAxElement;
  shape: AxShape;
  /** Top-left rect in global screen points. */
  rect: Rect;
  label: string;
}

/** One window with the elements that belong to it, ready to paint. */
export interface AxWindowLayout {
  win: MacMonitorAxWindow;
  /** Screen-point rect, straight off the window's own frame. */
  rect: Rect;
  /** Height of the drawn title bar in points; 0 for a sheet (it has none). */
  titleBar: number;
  elements: AxDrawable[];
}

/** A standard macOS document window's title bar, in points. */
export const AX_TITLE_BAR = 28;

/**
 * Group the scene into windows to paint, back to front.
 *
 * The helper lists windows FRONT to back; painting in that order would put the
 * document on top of the save sheet, which is the one case this whole fallback
 * exists to get right. So the list is reversed here rather than at three
 * different call sites in the renderer.
 *
 * Elements are matched to their window by `win` id when they have one, and by
 * containment when they do not (an older helper sends no ids). Within a window
 * they are sorted LARGEST FIRST so a container never paints over its own
 * children — the document body is 900×560 and the caret inside it is 2×16.
 */
export function layoutAxScene(scene: MacMonitorAxScene): AxWindowLayout[] {
  const back = [...scene.windows].reverse();
  const known = new Set(scene.windows.map((w) => w.windowId));
  const byWindow = new Map<number, AxDrawable[]>();
  for (const win of back) byWindow.set(win.windowId, []);

  for (const el of scene.elements) {
    const shape = axShapeFor(el);
    const rect = rectOfBbox(el.bbox);
    const drawable: AxDrawable = { el, shape, rect, label: axLabelFor(el, shape) };
    let target: number | null = el.win !== undefined && known.has(el.win) ? el.win : null;
    if (target === null) {
      // No id (or an id we dropped as chrome): the innermost window that
      // contains it, front-most first so a sheet claims its own controls.
      for (const win of scene.windows) {
        if (rectContains(win.frame, rect)) {
          target = win.windowId;
          break;
        }
      }
    }
    if (target === null) continue; // belongs to nothing on the stage
    byWindow.get(target)?.push(drawable);
  }

  return back.map((win) => {
    const elements = (byWindow.get(win.windowId) ?? []).sort(
      (a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h,
    );
    return {
      win,
      rect: { ...win.frame },
      titleBar: win.sheet || win.modal ? 0 : AX_TITLE_BAR,
      elements,
    };
  });
}

/**
 * Where the phantom rests when nothing is happening.
 *
 * The user: "always show the fake cursor around there even if just idling, looks
 * nice and makes it feel like 'this is the model's computer'." So there is
 * always a point to draw at. The LAST place it actually was is the honest one —
 * a cursor that teleports home the instant a turn ends reads as a reset, not as
 * a pause. Only when it has never been anywhere does it park: inside the
 * window, below and right of centre, where a hand would leave a mouse.
 */
export function restingCursor(
  rect: Rect,
  last: { x: number; y: number } | null,
): { x: number; y: number } {
  if (last !== null) return last;
  return { x: rect.x + rect.w * 0.62, y: rect.y + rect.h * 0.58 };
}

/**
 * The resting cursor's breath: a slow two-axis drift, in canvas pixels.
 *
 * Two periods that do not divide into each other, so it never visibly repeats,
 * and an amplitude of a couple of pixels — enough that the surface is alive,
 * far too little to be mistaken for the cursor going somewhere.
 */
export function idleCursorDrift(nowMs: number): { x: number; y: number } {
  return {
    x: Math.sin(nowMs / 2870) * 3.4,
    y: Math.sin(nowMs / 2110 + 1.1) * 2.5,
  };
}

/**
 * Greedy word wrap into `maxWidth`, at most `maxLines` lines, honouring the
 * newlines already in the text.
 *
 * `measure` is injected so this is testable without a canvas — and so the
 * renderer measures in the exact font it is about to draw with, rather than in
 * an estimate that drifts a character per line.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: (s: string) => number,
): string[] {
  if (text === '' || maxWidth <= 0 || maxLines <= 0) return [];
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (out.length >= maxLines) break;
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (word === '') continue;
      const next = line === '' ? word : `${line} ${word}`;
      if (measure(next) <= maxWidth || line === '') {
        line = next;
        continue;
      }
      out.push(line);
      if (out.length >= maxLines) break;
      line = word;
    }
    if (out.length >= maxLines) break;
    if (line !== '') out.push(line);
  }
  return out.slice(0, maxLines);
}

/** Cut a single line to `maxWidth`, ending in an ellipsis when it had to. */
export function ellipsize(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (text === '' || maxWidth <= 0) return '';
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? '' : `${text.slice(0, lo)}…`;
}
