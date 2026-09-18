/**
 * WHAT CHANGED WITHIN A CHANGED LINE.
 *
 * A diff that tints whole rows says which lines moved; a reader still has to
 * find the three characters that differ between `return "Hello, " + name;`
 * and `` return `Hello, ${name}!`; `` by eye. The references (the user's second
 * screenshot, 2026-09-17) mark that stretch with a second, stronger tint — so
 * a deleted row and the added row that replaced it are paired, their common
 * prefix and suffix are found, and only the middle is emphasised.
 *
 * Both helpers are pure. `pairChanges` decides WHICH rows pair (a run of
 * deletions followed by the same number of additions, matched in order — the
 * shape a str_replace edit produces); `emphasizeHtml` marks a character range
 * inside highlight.js output without ever crossing one of its spans, so the
 * result stays well-formed HTML with the syntax colours intact.
 */

export interface EmphasisRange {
  /** Character offset (in the line's raw text) where the change starts. */
  from: number;
  /** Character offset where it ends (exclusive). */
  to: number;
}

/**
 * The changed stretch shared by a deleted line and its replacement, when the
 * two are mostly the same text. Returns null when they share nothing at either
 * end, or when the differing middle is most of the line — marking three
 * quarters of a row is noise, not a pointer.
 */
export function changedRange(
  before: string,
  after: string,
): { before: EmphasisRange; after: EmphasisRange } | null {
  if (before === after) return null;
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix + suffix === 0) return null;
  const longest = Math.max(before.length, after.length);
  const changed = longest - prefix - suffix;
  if (changed > longest * 0.75) return null;
  return {
    before: { from: prefix, to: before.length - suffix },
    after: { from: prefix, to: after.length - suffix },
  };
}

/**
 * Pair rows for intra-line emphasis: within each run of `del` rows followed
 * directly by the same number of `add` rows, the i-th deletion pairs with the
 * i-th addition. Keys are row indices into `kinds`/`texts`; values are the
 * range to emphasise in that row.
 */
export function pairChanges(
  rows: ReadonlyArray<{ kind: string; text: string }>,
): Map<number, EmphasisRange> {
  const out = new Map<number, EmphasisRange>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i]?.kind !== 'del') {
      i += 1;
      continue;
    }
    const delStart = i;
    while (i < rows.length && rows[i]?.kind === 'del') i += 1;
    const addStart = i;
    while (i < rows.length && rows[i]?.kind === 'add') i += 1;
    const dels = addStart - delStart;
    const adds = i - addStart;
    if (dels !== adds) continue;
    for (let k = 0; k < dels; k += 1) {
      const before = rows[delStart + k]?.text ?? '';
      const after = rows[addStart + k]?.text ?? '';
      const range = changedRange(before, after);
      if (range === null) continue;
      out.set(delStart + k, range.before);
      out.set(addStart + k, range.after);
    }
  }
  return out;
}

/**
 * Wrap the characters `[from, to)` of a highlighted line in `<span class=…>`.
 *
 * `html` is highlight.js output: escaped text and `<span class="hljs-…">`
 * elements, nothing else. Offsets count TEXT characters (an entity such as
 * `&amp;` is one), so they line up with the raw line the range was computed
 * on. Where the range would cross one of the existing spans the emphasis is
 * closed before the tag and reopened after it, so nesting is never broken.
 */
export function emphasizeHtml(html: string, range: EmphasisRange, className: string): string {
  if (range.to <= range.from) return html;
  const open = `<span class="${className}">`;
  const close = '</span>';
  let out = '';
  let pos = 0;
  let inside = false;
  const tokens = html.split(/(<[^>]+>)/);
  for (const token of tokens) {
    if (token === '') continue;
    if (token.startsWith('<')) {
      // A tag: step out of the emphasis around it.
      if (inside) out += close;
      out += token;
      if (inside) out += open;
      continue;
    }
    // Text (with entities): walk it a character at a time.
    let i = 0;
    while (i < token.length) {
      const entity = token[i] === '&' ? /^&[^;\s]{1,8};/.exec(token.slice(i)) : null;
      const unit = entity === null ? (token[i] ?? '') : entity[0];
      if (!inside && pos === range.from) {
        out += open;
        inside = true;
      }
      if (inside && pos === range.to) {
        out += close;
        inside = false;
      }
      out += unit;
      pos += 1;
      i += unit.length;
    }
  }
  if (inside) out += close;
  return out;
}
