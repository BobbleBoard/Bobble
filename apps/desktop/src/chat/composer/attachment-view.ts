/**
 * What an attachment chip SAYS, and what a selection of them does.
 *
 * the user's brief, verbatim: "no name shown, just a box … a bit bigger, and then
 * slide to the right open when it's hovered over (the individual file/image)
 * this should be less colored in and have a more visible border … show name a
 * bit smaller and higher, truncate name if too long, show centered dot, file
 * extension, then below it, size eg. 10.1 MB <centered dot> N tokens replace n
 * with a loading spinner if prefilling still while hovered."
 *
 * All pure, so the copy and the selection arithmetic are testable without a
 * renderer — the selection rules in particular (shift-range, toggle, clamping)
 * are the kind of thing that is quietly wrong for months in a component test.
 */

/** 10,485,760 → "10.0 MB". Two significant places, the way a Finder row reads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  /*
   * One decimal below 100, whole numbers above — and a trailing ".0" stripped,
   * because "42.0 MB" reads like a measurement and "42 MB" reads like a file.
   * the user's own example was "10.1 MB", which a `< 10` threshold rounds away.
   */
  const shown = value < 100 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}

/**
 * The extension, upper-cased, for the corner of the box and the name row.
 * A name with no dot answers "FILE" rather than an empty slot that collapses the
 * row it is in.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return (ext === '' ? 'file' : ext).toUpperCase().slice(0, 5);
}

/**
 * A rough token count for text that is about to ride in a prompt.
 *
 * FOUR CHARACTERS PER TOKEN is the same approximation the thread already uses
 * for its thinking-time estimate, and it is the honest resolution here: the real
 * count depends on the tokenizer of whichever model is loaded, and quoting an
 * exact-looking number we did not measure is the invented-number mistake this
 * app keeps having to unlearn. Rounded to a readable figure for that reason.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** 2480 → "2,480". */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export interface AttachmentMeta {
  /** "10.1 MB", or '' when the size is unknown. */
  size: string;
  /** "PNG", "MD", "FILE". */
  ext: string;
  /** "2,480 tokens", or null when this kind carries no prompt text. */
  tokens: string | null;
}

/**
 * The two lines the chip reveals on hover.
 *
 * IMAGES GET NO TOKEN COUNT, and that is not an omission. Images are excluded
 * from prefill on purpose (the vision encode re-runs per request on the pinned
 * llama.cpp build, so priming one buys nothing), and their cost in tokens
 * depends on a projector we do not measure. A number we cannot stand behind is
 * worse than a blank.
 */
export function attachmentMeta(a: {
  name: string;
  kind: 'image' | 'text';
  bytes?: number;
  text?: string;
}): AttachmentMeta {
  return {
    size: a.bytes === undefined ? '' : formatBytes(a.bytes),
    ext: extensionOf(a.name),
    tokens:
      a.kind === 'text' && a.text !== undefined
        ? `${formatCount(estimateTokens(a.text))} tokens`
        : null,
  };
}

/* ── Selection ─────────────────────────────────────────────────────────────
 *
 * the user: "clicking a file needs to highlight it blue and blue border and then
 * allow for user to press ctrl c/x/v or shift click other files to do so."
 *
 * The rules are the ones every file list has had since 1984, which is exactly
 * why they have to be right: a plain click replaces the selection, shift extends
 * from the anchor, and the anchor only moves on a plain click. Getting the
 * anchor wrong is the bug nobody reports and everybody feels.
 */
export interface SelectionState {
  readonly ids: readonly string[];
  /** Where a shift-range measures from. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: [], anchor: null };

export function selectClick(
  state: SelectionState,
  order: readonly string[],
  id: string,
  mods: { shift?: boolean; meta?: boolean },
): SelectionState {
  if (!order.includes(id)) return state;
  if (mods.shift === true && state.anchor !== null && order.includes(state.anchor)) {
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(id);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    // The anchor STAYS: dragging a shift-selection back and forth should sweep
    // from where it started, not from wherever it last landed.
    return { ids: order.slice(lo, hi + 1), anchor: state.anchor };
  }
  if (mods.meta === true) {
    const has = state.ids.includes(id);
    const ids = has ? state.ids.filter((x) => x !== id) : [...state.ids, id];
    // Toggling OFF leaves the anchor where it was; toggling on moves it here.
    return { ids, anchor: has ? state.anchor : id };
  }
  return { ids: [id], anchor: id };
}

/** Drop ids that no longer exist (a file was removed while selected). */
export function pruneSelection(state: SelectionState, order: readonly string[]): SelectionState {
  const ids = state.ids.filter((id) => order.includes(id));
  if (ids.length === state.ids.length && (state.anchor === null || order.includes(state.anchor))) {
    return state;
  }
  return {
    ids,
    anchor: state.anchor !== null && order.includes(state.anchor) ? state.anchor : null,
  };
}
