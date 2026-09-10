/**
 * WHAT THE MODEL ACTUALLY LOOKED AT.
 *
 * the user: "log and tell me how much images are being utilized and how much
 * accessibility tree/dom is being utilized (not what's offered, grounded in the
 * runs how much is the model using and or getting or being forced on one or the
 * other)."
 *
 * The distinction that matters is the last one. A run on Maps and a run on
 * Blender both ADVERTISE a screenshot and a snapshot; only one of them has a
 * choice. Blender exposes three Accessibility elements (its close, zoom and
 * minimise buttons), so every act there is a coordinate read off a picture —
 * that is not the model preferring pixels, it is the app leaving nothing else.
 * So this counts three separate things and never conflates them:
 *
 *   - what came BACK (image parts and their bytes, tree text and its size),
 *   - what the model ACTED on (an [index] from a tree, or a raw x,y),
 *   - and how often the tree it was given had nothing actionable in it.
 *
 * A tally is per-session and cheap: string sizes and integers, no copies of the
 * content itself.
 */

export interface ModalityTally {
  /** Result parts that were images, and their decoded byte size. */
  images: number;
  imageBytes: number;
  /** Snapshot-shaped results, split by which surface produced them. */
  axSnapshots: number;
  axChars: number;
  domSnapshots: number;
  domChars: number;
  /** Acts aimed by an element index (tree-grounded) vs by raw x,y. */
  byIndex: number;
  byCoord: number;
  /**
   * Of the coordinate acts, the ones aimed at a point the TREE had just named.
   *
   * This is the distinction the user's question turns on, and it needs saying
   * because the two look identical from outside: an element line is `[7]
   * AXButton "Save"` with no geometry, so the only coordinates a snapshot ever
   * hands over are the points on its read-text lines. A click at one of those is
   * text-grounded — the model read a word and pressed the word. A click
   * anywhere else was read off a picture.
   */
  byCoordFromText: number;
  /** Snapshots that came back with no actionable element — the forced-to-pixels case. */
  visualOnly: number;
  /** Every other text result, for a denominator that adds up. */
  otherResults: number;
  otherChars: number;
}

export function emptyTally(): ModalityTally {
  return {
    images: 0,
    imageBytes: 0,
    axSnapshots: 0,
    axChars: 0,
    domSnapshots: 0,
    domChars: 0,
    byIndex: 0,
    byCoord: 0,
    byCoordFromText: 0,
    visualOnly: 0,
    otherResults: 0,
    otherChars: 0,
  };
}

/** Base64 decodes to 3 bytes per 4 characters, less the padding. */
function b64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

type Part = { type: string; text?: string; data?: string };

/**
 * The tool families, by the only thing we can rely on: the tool's own name.
 *
 * `mac_*` reads the Accessibility tree, `browser_*` reads the DOM. Both are
 * "the structured view" as far as the model is concerned, but they are worth
 * separating — a browser page that reports nothing is broken, whereas a native
 * app that reports nothing is normal and common.
 */
const SNAPSHOT_TOOLS = new Set([
  'mac_snapshot',
  'mac_launch',
  /* Chrome's own set reads the same tree (or the DOM when Apple Events are on),
     so it is the structured view too. MEASURED: a run that did the whole task
     through `chrome` scored ZERO snapshots and 8KB of "other", which reads as
     "the model used neither modality" when in fact it used one of them
     exclusively. */
  'chrome_snapshot',
  'chrome_tabs',
  'browser_snapshot',
  'browser_navigate',
]);

/** A phrase the mac/browser formatters emit when a surface has no usable tree. */
const NO_TREE = /exposes no Accessibility elements|no actionable elements/i;

/**
 * Every point a snapshot told the model about, from its read-text lines.
 *
 * Kept per tally rather than globally: two sessions must not contaminate each
 * other's numbers. Only the LAST snapshot counts — a point from four snapshots
 * ago is not what the model was looking at.
 */
const lastPoints = new WeakMap<ModalityTally, { x: number; y: number }[]>();
/** How close a click has to land to count as aimed at that line. */
const GROUNDED_WITHIN = 40;

function pointsIn(text: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const m of text.matchAll(/\((\d{1,5}),(\d{1,5})\)/g)) {
    out.push({ x: Number(m[1]), y: Number(m[2]) });
  }
  return out;
}

export function noteResult(
  tally: ModalityTally,
  toolName: string,
  input: unknown,
  content: readonly Part[],
): void {
  let text = '';
  for (const part of content) {
    if (part.type === 'image' && typeof part.data === 'string') {
      tally.images += 1;
      tally.imageBytes += b64Bytes(part.data);
    } else if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
    }
  }

  if (SNAPSHOT_TOOLS.has(toolName)) {
    /* chrome_* is the DOM when Apple Events are on and the Accessibility tree
       when they are not; it says which in its own output, and either way it is
       the browser's structured view rather than the Mac's. */
    if (toolName.startsWith('browser') || toolName.startsWith('chrome')) {
      tally.domSnapshots += 1;
      tally.domChars += text.length;
    } else {
      tally.axSnapshots += 1;
      tally.axChars += text.length;
    }
    if (NO_TREE.test(text)) tally.visualOnly += 1;
    lastPoints.set(tally, pointsIn(text));
  } else if (text.length > 0) {
    tally.otherResults += 1;
    tally.otherChars += text.length;
  }

  /* How the act was AIMED. Only the acting tools carry a target, and a call that
     carries both an index and a coordinate is aimed by the index — that is the
     order the tools themselves resolve them in. */
  if (/_(click|type|scroll|drag|hover|move|tab)$/.test(toolName)) {
    const args = (input ?? {}) as Record<string, unknown>;
    if (typeof args.index === 'number') tally.byIndex += 1;
    else if (typeof args.x === 'number' && typeof args.y === 'number') {
      tally.byCoord += 1;
      const x = args.x;
      const y = args.y;
      const near = (lastPoints.get(tally) ?? []).some(
        (p) => Math.abs(p.x - x) <= GROUNDED_WITHIN && Math.abs(p.y - y) <= GROUNDED_WITHIN,
      );
      if (near) tally.byCoordFromText += 1;
    }
  }
}

/** One line for a log, and the JSON the demo harness reads off the status channel. */
export function describeTally(t: ModalityTally): string {
  const aimed = t.byIndex + t.byCoord;
  const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
  return [
    `images ${t.images} (${(t.imageBytes / 1024).toFixed(0)}KB)`,
    `ax ${t.axSnapshots} (${(t.axChars / 1024).toFixed(0)}KB)`,
    `dom ${t.domSnapshots} (${(t.domChars / 1024).toFixed(0)}KB)`,
    `aimed by index ${t.byIndex}/${aimed} (${pct(t.byIndex, aimed)})`,
    `by a point the tree named ${t.byCoordFromText}/${t.byCoord}`,
    `no-tree snapshots ${t.visualOnly}/${t.axSnapshots + t.domSnapshots}`,
  ].join(', ');
}
