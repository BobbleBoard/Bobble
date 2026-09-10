/**
 * FINDING SOMETHING ON A PAGE WITHOUT LOADING A SECOND MODEL.
 *
 * the user: "would it be possible to take a really small embedding model and quickly
 * index and search a page or is the dom too heavy to do that without speed loss
 * on lower end devices."
 *
 * MEASURED first, because the answer turns on the size of the thing being
 * searched. Across every run recorded so far, a Chrome DOM snapshot is 4.7-7.0 KB
 * (median 5.3) and a Mac Accessibility snapshot 0.9-2.9 KB. That is ~100 lines.
 * Nothing about that is heavy: the DOM is not the problem, and speed is not the
 * reason to hesitate.
 *
 * The reason to hesitate is what a model COSTS when it is not the one answering:
 * a download, a load on first use, and residency beside a 13 GB LLM on a 24 GB
 * machine. intent-bias.ts already made this trade once, for tool matching, and
 * measured that a lexical scorer was enough there.
 *
 * So the flag exists NOW with the free scorer behind it, and the seam is shaped
 * so an embedding backend can replace `score` alone when a measured case needs
 * one. What the free scorer genuinely cannot do is synonyms — "checkout" will
 * not find "Add to Bag" by any amount of token overlap, and that is exactly the
 * case that would justify the model. It is not guessed at here; it is left
 * open with the seam ready.
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
}

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
      hits.push({ ...line, score: 1, exact: true });
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
    if (score >= 0.5) hits.push({ ...line, score, exact: false });
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
