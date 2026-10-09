/**
 * FINDING SOMETHING ON A PAGE — BY WORD AND BY MEANING, ALWAYS BOTH.
 *
 * The user: "keep keyword search but also on any search (don't let the model choose
 * between keyword and semantic, just give the top ~10 of both ordered)."
 *
 * That is the right shape and it is worth saying why: choosing between them is a
 * decision the model is badly placed to make. It does not know whether the app
 * spells the thing the way it just guessed — that is the entire reason it is
 * searching. Asked to pick, a small model picks whichever word appears in the
 * flag description most recently, and a wrong pick returns an empty list that
 * reads like "this screen has no such thing".
 *
 * MEASURED, on the sizes that actually occur: a Chrome DOM snapshot here is
 * 4.7-7.0 KB and a Mac Accessibility snapshot 0.9-2.9 KB — about a hundred
 * lines. Keyword ranking over that costs 69 µs, which is 0.4% of the time this
 * machine needs to generate ONE token. The DOM is not heavy. Running both is
 * free on the keyword side and bounded on the other: an embedding pass over a
 * hundred short lines is one batch.
 *
 * The embedder is injected rather than imported, so this file stays pure and
 * testable and the model behind it is a deployment decision — see `Embedder`.
 * Without one, semantic results are simply absent and the keyword half answers
 * alone; nothing about the caller or the model's instructions changes.
 */

/** One searchable line: page text, or a control's label. */
export interface PageLine {
  readonly text: string;
  readonly index?: number;
}

export interface PageHit extends PageLine {
  /** 0..1. Exact substring matches score 1 and always sort first. */
  readonly score: number;
  readonly exact: boolean;
  /** Which search found it. A line both agree on is the strongest signal there
   *  is, and is labelled as such rather than listed twice. */
  readonly kind: 'keyword' | 'semantic' | 'both';
}

/**
 * Turns short texts into vectors. One call, one batch — the page and the query
 * go together so a backend can amortise whatever it needs to.
 *
 * Deliberately the narrowest possible surface: EmbeddingGemma-300M behind a
 * llama.cpp `--embedding` server satisfies it, and so does anything else. At
 * 300M parameters that is roughly 300 MB at Q8 beside a 13 GB LLM, which is why
 * The user's "if it's this small" is the right instinct — the cost of a second model
 * here is residency, never latency.
 */
export type Embedder = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

const WORD = /[a-z0-9]+/g;

function tokens(s: string): string[] {
  return s.toLowerCase().match(WORD) ?? [];
}

/**
 * Rank lines against a query.
 *
 * Exact substring first, because that is what `find` has always meant and a
 * model asking for "2TB" wants the line containing "2TB" — not the most
 * thematically similar one. Only when nothing matches exactly does the ranking
 * matter, and then it is IDF-weighted token overlap: a rare word shared between
 * query and line is strong evidence, a common one is nearly none.
 *
 * Pure, and linear in the page — the whole point is that it costs nothing worth
 * measuring on the sizes actually seen.
 */
export function searchPage(lines: readonly PageLine[], query: string, limit = 12): PageHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const qTokens = tokens(q);
  if (qTokens.length === 0) return [];

  /* Document frequency over the page itself: "the" is worthless HERE, and on a
     shop page so is "buy" — which a fixed stopword list would never know. */
  const df = new Map<string, number>();
  const lineTokens = lines.map((l) => {
    const t = new Set(tokens(l.text));
    for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
    return t;
  });
  const n = Math.max(1, lines.length);

  const hits: PageHit[] = [];
  for (const [i, line] of lines.entries()) {
    const lower = line.text.toLowerCase();
    if (lower.includes(q)) {
      hits.push({ ...line, score: 1, exact: true, kind: 'keyword' });
      continue;
    }
    const have = lineTokens[i] ?? new Set<string>();
    let num = 0;
    let denom = 0;
    for (const w of new Set(qTokens)) {
      const idf = Math.log(1 + n / (1 + (df.get(w) ?? 0)));
      denom += idf;
      if (have.has(w)) num += idf;
    }
    const score = denom === 0 ? 0 : num / denom;
    /* Half the query's weight, or it is not an answer — a page will always have
       SOME line sharing a word, and returning it is worse than saying nothing. */
    if (score >= 0.5) hits.push({ ...line, score, exact: false, kind: 'keyword' });
  }
  hits.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.score - a.score);
  return hits.slice(0, limit);
}

/** What to tell the model when `find` matched nothing exactly. */
export function nearMissNote(query: string, hits: readonly PageHit[]): string {
  if (hits.length === 0 || hits.some((h) => h.exact)) return '';
  return (
    `\n\n(nothing contains "${query}" exactly. These share most of its words — ` +
    'if none is what you meant, the word on this screen is a different one, so ' +
    'read the list without find rather than guessing again.)'
  );
}

/** Cosine similarity of two equal-length vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Below this a "nearest" line is just the least unrelated one on the page. */
const SEMANTIC_FLOOR = 0.45;

/**
 * Both searches, merged — the thing the caller actually wants.
 *
 * Keyword first within equal standing, because a line containing the words the
 * model typed needs no interpretation. A line both halves found is promoted to
 * `both` and listed once: agreement is evidence, and printing it twice would
 * spend the model's attention on the same row.
 *
 * `perKind` bounds each side (~10 by the user's ask), so a page cannot flood the
 * result and the cost of reading it stays fixed whatever the page size.
 */
export async function searchPageBoth(
  lines: readonly PageLine[],
  query: string,
  opts: { readonly embed?: Embedder; readonly perKind?: number } = {},
): Promise<{ hits: PageHit[]; semantic: 'used' | 'unavailable' | 'failed' }> {
  const perKind = opts.perKind ?? 10;
  const keyword = searchPage(lines, query, perKind);
  if (opts.embed === undefined) return { hits: keyword, semantic: 'unavailable' };

  let semantic: PageHit[] = [];
  try {
    /* Query first, then the page: one batch, so a backend pays its fixed costs
       once however many lines there are. */
    const vectors = await opts.embed([query, ...lines.map((l) => l.text)]);
    const q = vectors[0];
    if (q !== undefined) {
      semantic = lines
        .map((line, i) => {
          const v = vectors[i + 1];
          return {
            ...line,
            score: v === undefined ? 0 : cosine(q, v),
            exact: false,
            kind: 'semantic' as const,
          };
        })
        .filter((h) => h.score >= SEMANTIC_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, perKind);
    }
  } catch {
    /* A search that half-worked is worth more than an error: the keyword side
       is already a real answer, and the caller is told which half it got. */
    return { hits: keyword, semantic: 'failed' };
  }

  const byText = new Map<string, PageHit>();
  for (const h of keyword) byText.set(h.text, h);
  for (const h of semantic) {
    const seen = byText.get(h.text);
    byText.set(
      h.text,
      seen === undefined ? h : { ...seen, kind: 'both', score: Math.max(seen.score, h.score) },
    );
  }
  const hits = [...byText.values()].sort(
    (a, b) =>
      (b.kind === 'both' ? 1 : 0) - (a.kind === 'both' ? 1 : 0) ||
      (b.exact ? 1 : 0) - (a.exact ? 1 : 0) ||
      b.score - a.score,
  );
  return { hits, semantic: 'used' };
}
