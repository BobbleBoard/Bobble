/**
 * Render a {@link MacSnapshot} into the compact text the model reads — one line
 * per element, addressed by `[index]`, with only the fields that help the model
 * decide (role, name, value, editable/focused markers). Coordinates are omitted
 * from the text (the app resolves index → element). Mirror of browser-use's
 * format.ts.
 *
 * DIALOGS ARE FIRST-CLASS HERE. the user's field report: the model clicks Open in
 * TextEdit, a file dialog appears — that dialog is part of TextEdit, not of
 * Finder — and the model has to be able to SEE it and drive it. A snapshot that
 * silently mixes a sheet's controls into the window's list leaves the model
 * guessing which surface an index belongs to, which is how it ends up clicking
 * the document behind an open save panel. So when the helper reports a modal
 * surface, that is the FIRST thing this text says, and the elements are
 * attributed to the surface they live in.
 *
 * Everything the helper might not send is optional: the app ships a PREBUILT
 * `pi-mac`, so a snapshot with no `windows`/`dialog`/`win` must degrade to
 * exactly the old output rather than throw.
 */
import type { MacDialogInfo, MacElement, MacRect, MacSnapshot, MacWindowInfo } from './protocol.js';

function elementLine(el: MacElement): string {
  const marks: string[] = [];
  if (el.editable) marks.push('editable');
  if (el.focused) marks.push('focused');
  if (el.enabled === false) marks.push('disabled');
  const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
  const value =
    el.value !== undefined && el.value !== '' && el.value !== el.name ? ` = "${el.value}"` : '';
  const name = el.name !== '' ? ` "${el.name}"` : '';
  return `[${el.index}] ${el.role}${name}${value}${suffix}`;
}

/**
 * True when Accessibility told us nothing usable about this app.
 *
 * Plenty of real applications are like this — anything drawing its own UI
 * (Electron without the a11y tree enabled, games, Java apps, canvas-based
 * editors) exposes a window and nothing inside it. It is the normal case for a
 * large slice of the Mac, not an error.
 */
export function isAxOpaque(snap: MacSnapshot): boolean {
  return snap.elements.length === 0;
}

/** A dialog as this module talks about it: whatever the helper told us, plus
 * whatever the windows list can add (its id and frame). */
export interface ResolvedDialog {
  readonly title: string;
  readonly role: string;
  /** 'sheet' when it is attached to a window, else 'dialog'. */
  readonly kind: 'sheet' | 'dialog';
  readonly windowId?: number;
  readonly frame?: MacRect;
}

/** A window entry that IS a modal surface — the helper says so outright
 * (sheet/modal), or its role/subrole leaves no doubt. */
function dialogRank(w: MacWindowInfo): number {
  if (w.sheet === true || w.modal === true || w.role === 'AXSheet') return 2;
  if (w.subrole === 'AXDialog' || w.subrole === 'AXSystemDialog') return 1;
  return 0;
}

function kindOf(role: string | undefined, w: MacWindowInfo | undefined): 'sheet' | 'dialog' {
  return role === 'AXSheet' || w?.sheet === true || w?.role === 'AXSheet' ? 'sheet' : 'dialog';
}

/**
 * The frontmost modal surface, or null.
 *
 * Two independent sources, because a helper may send either: the explicit
 * `dialog` field, and the `windows` list. Whichever answers, the other is used
 * to fill in the blanks — a `dialog: {title, role}` with no id still gets its
 * frame if a window with that title is listed, which is what lets a coordinate
 * click be aimed at the dialog rather than at the window behind it.
 */
export function dialogOf(snap: MacSnapshot): ResolvedDialog | null {
  const windows = Array.isArray(snap.windows) ? snap.windows : [];
  const ranked = windows
    .map((w) => ({ w, rank: dialogRank(w) }))
    .filter((e) => e.rank > 0)
    .sort((a, b) => b.rank - a.rank);

  const stated = snap.dialog;
  if (stated !== null && stated !== undefined && (isText(stated.title) || isText(stated.role))) {
    const match =
      windows.find((w) => typeof w.windowId === 'number' && w.windowId === stated.windowId) ??
      (isText(stated.title) ? ranked.find((e) => e.w.title === stated.title)?.w : undefined) ??
      ranked[0]?.w;
    return {
      title: pick(stated.title, match?.title),
      role: pick(stated.role, match?.role, 'AXDialog'),
      kind: kindOf(stated.role, match),
      windowId: stated.windowId ?? match?.windowId,
      frame: match?.frame,
    };
  }

  const top = ranked[0]?.w;
  if (top === undefined) return null;
  return {
    title: pick(top.title),
    role: pick(top.role, top.subrole, 'AXDialog'),
    kind: kindOf(top.role, top),
    windowId: top.windowId,
    frame: top.frame,
  };
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

function pick(...vals: (string | undefined)[]): string {
  for (const v of vals) if (isText(v)) return v;
  return '';
}

/**
 * The indices that live in a window the open dialog is BLOCKING.
 *
 * A modal sheet does not merely sit on top: the window under it stops accepting
 * input, so an AXPress on a button down there is a silent no-op the model reads
 * as a success. Knowing which indices those are costs nothing (the helper
 * already says which window each element is in) and turns that silence into a
 * refusal that names the dialog.
 *
 * Empty whenever we cannot tell — no dialog, no window id, or an older helper
 * that does not attribute elements at all.
 */
export function blockedIndexes(snap: MacSnapshot, dialog: ResolvedDialog | null): number[] {
  if (dialog === null || typeof dialog.windowId !== 'number') return [];
  return snap.elements
    .filter((el) => typeof el.win === 'number' && el.win !== dialog.windowId)
    .map((el) => el.index);
}

/**
 * A stable key for "is this the same dialog as last time".
 *
 * Used by the act tools: an index taken BEFORE a dialog opened must not be
 * blind-retried against the surface that now owns that number. Comparing the
 * signature is enough to know a modal surface appeared or changed, and it works
 * whether the helper identifies dialogs by id or only by title.
 */
export function dialogSignature(dialog: ResolvedDialog | MacDialogInfo | null | undefined): string {
  if (dialog === null || dialog === undefined) return '';
  const id = typeof dialog.windowId === 'number' ? String(dialog.windowId) : '';
  return `${id}|${dialog.title ?? ''}|${dialog.role ?? ''}`;
}

/** How the model should refer to a dialog in prose: `"Save" (sheet)`. */
function dialogLabel(d: ResolvedDialog): string {
  return `${d.title !== '' ? `"${d.title}"` : 'untitled'} (${d.kind})`;
}

/**
 * The screen rect the snapshot's IMAGE covers.
 *
 * With a composite capture (window + its sheets, cropped to the union) the
 * parent window's frame is the WRONG rect to hand the model: a point read off
 * the image and offset by the window origin lands somewhere inside the window
 * instead of on the dialog. Prefer what the helper says the image covers, then
 * the union, and only then the single window's bounds.
 */
export function snapshotRect(snap: MacSnapshot): MacRect | undefined {
  return snap.screenshot?.rect ?? snap.union ?? snap.windowBounds;
}

function rectLine(label: string, rect: MacRect | undefined): string {
  if (rect === undefined) return '';
  return `${label} (screen points): x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`;
}

/** Is an image actually going to ride along with this text? */
function hasImage(snap: MacSnapshot): boolean {
  return isText(snap.screenshot?.base64);
}

/** Greedy wrap. The banner's width depends on the dialog's own title, so it
 * cannot be hard-wrapped at authoring time without going ragged on some apps. */
function wrap(text: string, width = 80): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/**
 * The banner that opens a snapshot when a modal surface is up.
 *
 * Deliberately the first thing after the app line: by the time the model reaches
 * an index it must already know which surface it is looking at. What it should
 * DO about it differs by app — an app with an AX tree gets the dialog's controls
 * indexed, one without gets the dialog's rect to click inside — so the banner
 * ends with whichever is true rather than promising controls that do not exist.
 */
export function dialogBanner(snap: MacSnapshot, dialog: ResolvedDialog): string[] {
  const how = isAxOpaque(snap)
    ? 'Its own bounds are given below — click inside those, not inside the window behind it.'
    : `Act on ITS controls; the window behind it is blocked until the ${dialog.kind} is closed or confirmed.`;
  return wrap(
    `A DIALOG IS OPEN — ${dialogLabel(dialog)}. It belongs to "${snap.app}", not to another app, ` +
      `and you drive it exactly like the app itself. ${how}`,
  );
}

/** Split the element list by the surface each element lives in, when the helper
 * tells us (`win`). Returns null when it does not, so the caller keeps the flat
 * list rather than inventing an attribution. */
function partition(
  snap: MacSnapshot,
  dialog: ResolvedDialog,
): { inDialog: MacElement[]; behind: MacElement[] } | null {
  const id = dialog.windowId;
  if (typeof id !== 'number') return null;
  const attributed = snap.elements.filter((el) => typeof el.win === 'number');
  if (attributed.length === 0) return null;
  const inDialog = snap.elements.filter((el) => el.win === id);
  if (inDialog.length === 0) return null;
  return { inDialog, behind: snap.elements.filter((el) => el.win !== id) };
}

/**
 * The human/model-facing snapshot text.
 *
 * WHEN AX IS EMPTY, THIS IS NOT A DEAD END. It used to read "(no actionable AX
 * elements — the app may be AX-opaque; request a screenshot and use x,y clicks)",
 * which the user rightly called useless: it spends a turn telling the model that the
 * tool it just called cannot help, and asks it to call the same tool again with a
 * flag. The caller now attaches the screenshot itself, so the model is looking at
 * the window in the SAME reply — and this text tells it what to do with it.
 *
 * AND WHEN THE PICTURE IS MISSING TOO (Screen Recording not granted), it still
 * is not a dead end: keys and coordinates both work without an image, so the
 * text names them instead of describing a hole.
 */
/**
 * The menu bar, in one line.
 *
 * A third of what a Mac app can do lives in its menus — New, Save As, the whole
 * Format menu — and none of it appears in any window, so a model looking only
 * at elements cannot even know those actions exist. Titles only: a full menu
 * bar is hundreds of entries and would drown the list it is meant to help, and
 * naming one lists it on demand.
 */
function menuLine(snap: MacSnapshot): string {
  const menus = snap.menus ?? [];
  if (menus.length === 0) return '';
  return (
    `\n\nMenus: ${menus.join(', ')} — mac_click with menu:"File > New" presses one, ` +
    'or name a menu to list what is inside it.'
  );
}

export function formatMacSnapshot(snap: MacSnapshot): string {
  const dialog = dialogOf(snap);
  const head: string[] = [`App: "${snap.app}"${snap.window ? ` — window "${snap.window}"` : ''}`];
  if (dialog !== null) head.push('', ...dialogBanner(snap, dialog));

  if (isAxOpaque(snap)) {
    const rect = snapshotRect(snap);
    const bounds = [
      rectLine('Image bounds', rect),
      dialog?.frame !== undefined ? rectLine('Dialog bounds', dialog.frame) : '',
    ].filter((l) => l !== '');
    const body = hasImage(snap)
      ? [
          'This app does not expose its controls to Accessibility, so there are no',
          'indexes to act on. The screenshot attached below IS your view of it.',
          '',
          'CONTROL THE APPLICATION VIA COORDINATES: read the window in the image and',
          'pass x,y screen points to mac_click, text to mac_type, and combos to',
          'mac_key. The image origin and size are given below, so a point you read',
          'off the image maps directly onto the screen.',
        ]
      : [
          'This app does not expose its controls to Accessibility, and its window could',
          'not be captured either (Screen Recording may not be granted).',
          '',
          'YOU CAN STILL DRIVE IT: mac_click takes x,y screen points anywhere in the',
          'bounds below, mac_type types into its focused field, and mac_key sends key',
          'combos — none of those need the picture. To see it as well, the user grants',
          'Screen Recording in System Settings → Privacy & Security.',
        ];
    return [...head, '', ...body, ...(bounds.length > 0 ? ['', ...bounds] : [])].join('\n');
  }

  const cap = `${menuLine(snap)}${
    snap.summary.truncated
      ? `\n\n(${snap.elements.length} of ${snap.summary.elementCount} elements shown; narrow the app or re-snapshot for more)`
      : ''
  }`;

  const split = dialog === null ? null : partition(snap, dialog);
  if (dialog !== null && split !== null) {
    const behind =
      split.behind.length > 0
        ? [
            '',
            `Behind it — window "${snap.window}" (blocked while the dialog is open):`,
            ...split.behind.map(elementLine),
          ]
        : [];
    const lines = [
      ...head,
      '',
      "The dialog's controls (act by index):",
      ...split.inDialog.map(elementLine),
      ...behind,
    ];
    return `${lines.join('\n')}${cap}`;
  }

  const lead =
    dialog === null
      ? 'Actionable elements (act by index):'
      : "Actionable elements (act by index) — the dialog's controls are among them:";
  return `${head.join('\n')}\n\n${lead}\n${snap.elements.map(elementLine).join('\n')}${cap}`;
}
