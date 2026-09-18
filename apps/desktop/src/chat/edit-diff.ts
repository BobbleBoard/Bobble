/**
 * A REAL DIFF OF AN EDIT — the fix for "successful edits show up as red".
 *
 * the user, with a screenshot of a `file-icon.svg` tab reading `+11 −18` over a
 * slab of red and a smaller block of green: "editing/writing tool calls a lot
 * of the time show up as red."
 *
 * They were not failing. Both places that draw an edit — the chain row in the
 * thread and the file tab in the canvas — built their "diff" by putting EVERY
 * line of `old_string` in as a deletion and EVERY line of `new_string` in as an
 * addition. That is not a diff, it is two blocks stacked. And a `str_replace`
 * edit's two sides are nearly the same text by construction: the model must
 * quote enough surrounding lines for the match to be unique, so a one-word
 * change carries fifteen identical lines with it. Every one of those was
 * painted as deleted-then-added.
 *
 * The result is that the ordinary case — change a line, keep its neighbours —
 * rendered as a wall of red with green underneath, which is exactly what this
 * app uses to say something went wrong. A successful write read as a failure.
 *
 * So: diff the two sides properly. Unchanged lines become CONTEXT (untinted),
 * only what actually moved is coloured, and the ±stat counts real changes —
 * `+11 −18` on that icon becomes the two lines that changed.
 *
 * Pure, and shared by both call sites (activity-mapping's chain row and
 * file-tabs' canvas tab) so the two can never drift again.
 */
import type { DiffFileData, DiffLine } from '@pi-desktop/ui';

/**
 * Above this many lines per side, the quadratic LCS table is not worth it — a
 * whole-file rewrite can be thousands of lines and this runs on every stream
 * tick. Beyond it we fall back to the old block-for-block shape, which is
 * honest for a wholesale replacement anyway.
 */
const LCS_LINE_CAP = 800;

/**
 * Rows of unchanged text to keep either side of a change. Enough to see where
 * you are, few enough that a big edit does not become a file listing.
 */
const CONTEXT_LINES = 3;

/** Longest common subsequence of two line arrays, as a list of index pairs. */
function commonLines(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Split, treating an absent side as "no lines" rather than one empty line. */
function linesOf(text: string | undefined): string[] {
  return text === undefined || text === '' ? [] : text.split('\n');
}

/**
 * Line-level rows for one edit hunk, with unchanged lines as context.
 *
 * A side that is absent contributes nothing, so a hunk mid-stream (old known,
 * new still arriving) draws just its deletions and grows the additions — the
 * live-follow both surfaces rely on.
 */
export function editDiffLines(
  oldText: string | undefined,
  newText: string | undefined,
  options: EditDiffOptions = {},
): { lines: DiffLine[]; added: number; deleted: number } {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  /*
   * LINE NUMBERS, WHEN THEY ARE KNOWN. A whole-file write starts at 1. A
   * str_replace hunk sits somewhere in a file only the caller may have in
   * hand: given the pre-edit `baseText`, the hunk's first line is found by
   * locating `oldText` in it; without it the gutter stays blank rather than
   * counting from 1 as if the hunk were the file (the references number file
   * lines, and a wrong number is worse than none).
   */
  const start = startLineOf(oldText, options.baseText, a.length === 0);
  const oldNo = (i: number): number | undefined => (start === undefined ? undefined : start + i);
  const newNo = oldNo;
  // One side only (a whole-file write, or an edit whose replacement has not
  // streamed in yet): every line is genuinely new or genuinely gone.
  if (a.length === 0 || b.length === 0 || a.length > LCS_LINE_CAP || b.length > LCS_LINE_CAP) {
    const lines: DiffLine[] = [
      ...a.map((text, i): DiffLine => ({ kind: 'del', text, oldNumber: oldNo(i) })),
      ...b.map((text, i): DiffLine => ({ kind: 'add', text, newNumber: newNo(i) })),
    ];
    return { lines, added: b.length, deleted: a.length };
  }

  const pairs = commonLines(a, b);
  // Walk both sides, emitting deletions/additions between the common anchors.
  const rows: DiffLine[] = [];
  let ai = 0;
  let bi = 0;
  let added = 0;
  let deleted = 0;
  const emitCommon = (text: string, oi: number, ni: number): void => {
    rows.push({ kind: 'context', text, oldNumber: oldNo(oi), newNumber: newNo(ni) });
  };
  for (const [pa, pb] of pairs) {
    while (ai < pa) {
      rows.push({ kind: 'del', text: a[ai] ?? '', oldNumber: oldNo(ai) });
      deleted += 1;
      ai += 1;
    }
    while (bi < pb) {
      rows.push({ kind: 'add', text: b[bi] ?? '', newNumber: newNo(bi) });
      added += 1;
      bi += 1;
    }
    emitCommon(a[pa] ?? '', pa, pb);
    ai = pa + 1;
    bi = pb + 1;
  }
  while (ai < a.length) {
    rows.push({ kind: 'del', text: a[ai] ?? '', oldNumber: oldNo(ai) });
    deleted += 1;
    ai += 1;
  }
  while (bi < b.length) {
    rows.push({ kind: 'add', text: b[bi] ?? '', newNumber: newNo(bi) });
    added += 1;
    bi += 1;
  }

  return { lines: trimContext(rows), added, deleted };
}

export interface EditDiffOptions {
  /** The file as it was BEFORE a str_replace edit, when the caller has it —
   * the only way a hunk can carry the file's own line numbers. */
  baseText?: string;
}

/** 1-based line the hunk starts on, or undefined when nobody can know. */
function startLineOf(
  oldText: string | undefined,
  baseText: string | undefined,
  wholeFile: boolean,
): number | undefined {
  if (wholeFile) return 1;
  if (oldText === undefined || oldText === '' || baseText === undefined) return undefined;
  const at = baseText.indexOf(oldText);
  if (at === -1) return undefined;
  return baseText.slice(0, at).split('\n').length;
}

/**
 * Keep {@link CONTEXT_LINES} of unchanged text around each change and collapse
 * the rest. A str_replace hunk is small, so this rarely fires — but a model
 * that quotes forty lines to change one should not hand the reader forty rows.
 */
function trimContext(rows: readonly DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.kind === 'context') return;
    for (
      let j = Math.max(0, i - CONTEXT_LINES);
      j <= Math.min(rows.length - 1, i + CONTEXT_LINES);
      j++
    ) {
      keep[j] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (keep[i] === true) {
      if (skipped > 0) {
        out.push({ kind: 'hunk', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
        skipped = 0;
      }
      out.push(row);
      return;
    }
    skipped += 1;
  });
  // A trailing run of unchanged lines needs no marker — there is nothing after
  // it to separate it from.
  return out;
}

/** One file's diff, as both surfaces want it. `path` is what the header shows. */
export function editDiffFile(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
  options: EditDiffOptions = {},
): DiffFileData {
  const { lines, added, deleted } = editDiffLines(oldText, newText, options);
  return { path, added, deleted, lines };
}
