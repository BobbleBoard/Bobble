/**
 * THE PAGES A TURN SAW, AND WHICH OF THEM ITS ANSWER CITES.
 *
 * The user (2026-09-24): "source citing (for research and such, examples from
 * google search summary shown)". The reference is Google's AI overview: a claim,
 * then a chip naming the site it came from, a card beside the answer listing
 * every source. Everything that decides WHAT those show lives here, pure, so
 * the rules are tested without a renderer:
 *
 *  - which calls in a turn were web research — the native `web_search` /
 *    `web_fetch` tools and, in CLI mode (the default), the same tools typed as
 *    `web search …` / `web fetch …` into `bash`. Both print the same text, so
 *    the sources come from the RESULT TEXT, which is also all the renderer is
 *    ever handed (the engine forwards a tool's text, not its `details`);
 *  - when a link in the answer IS one of those pages ({@link sourceKey}: the
 *    same page written two ways — `www.`, a trailing slash, `http:` for
 *    `https:`, a tracking parameter — is one page);
 *  - the order the Sources card lists them in.
 *
 * A link to anything the turn did not see stays an ordinary link. The model
 * can write a URL from memory; a chip would be the app vouching for it.
 */
import type { ToolResultMsg } from '@pi-desktop/engine';
import { parseSearchOutcome } from '../activity-mapping';

/** One page the model saw in a turn. */
export interface TurnSource {
  /** Identity for matching an answer's link to this page — see {@link sourceKey}. */
  readonly key: string;
  readonly url: string;
  /** The bare host, `www.` dropped: what the letter tile and the fallback label use. */
  readonly host: string;
  readonly title?: string;
  readonly snippet?: string;
  /** Opened in full (`web fetch`), not only listed by a search. */
  readonly read: boolean;
  /** 1-based position in the search that listed it first. */
  readonly rank?: number;
  /** Which search in the turn listed it first (0-based), for interleaving. */
  readonly search?: number;
  /** The order the turn first met it in. */
  readonly seen: number;
}

/** A web-research call, as far as sources are concerned. */
export type WebCall = { readonly kind: 'search' } | { readonly kind: 'fetch' };

/*
 * Query parameters that say where a click CAME FROM rather than which page it
 * is. A model that copies a link out of a newsletter-shaped page keeps them;
 * the search result it saw usually did not have them.
 */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url)$/i;

/**
 * The identity of a page for citation matching, or null for anything that is
 * not an http(s) URL.
 *
 * Scheme, `www.`, trailing slashes, the fragment, tracking parameters and
 * parameter order do not change which page it is; percent-encoding is decoded
 * so `%E2%80%93` and `–` agree. The path keeps its case — `/Wiki/Foo` and
 * `/wiki/foo` are different pages on most servers.
 */
export function sourceKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === '') return null;
  let path = url.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // A malformed escape is still a path; compare it as written.
  }
  path = path.replace(/\/(?:index|default)\.(?:html?|php|aspx?)$/i, '').replace(/\/+$/, '');
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length === 0 ? '' : `?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
  return `${host}${path}${query}`;
}

/** The bare host of a URL, `www.` dropped; '' when it has none. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * `web search …` / `web fetch …` somewhere in a shell line — first, after a
 * `cd … &&`, or piped on to `head`. The CLI prints exactly what the native tool
 * returns, so what the line ran decides which parser reads its output.
 */
export function webCommandKinds(command: string): { search: boolean; fetch: boolean } {
  const re = /(?:^|[;&|(\n])\s*web\s+(search|fetch)\b/g;
  const kinds = { search: false, fetch: false };
  for (const m of command.matchAll(re)) {
    if (m[1] === 'search') kinds.search = true;
    else kinds.fetch = true;
  }
  return kinds;
}

/** Is this tool call web research, and which kind — native or through `bash`. */
export function webCallsOf(name: string, args: unknown): WebCall[] {
  const n = name.toLowerCase();
  if (n.includes('web_search') || n.includes('search_web')) return [{ kind: 'search' }];
  if (n.includes('web_fetch') || n === 'fetch_url' || n === 'fetch_page')
    return [{ kind: 'fetch' }];
  if (n === 'bash') {
    const command = str((args as Record<string, unknown> | undefined)?.command);
    if (command === undefined) return [];
    const k = webCommandKinds(command);
    return [
      ...(k.search ? [{ kind: 'search' as const }] : []),
      ...(k.fetch ? [{ kind: 'fetch' as const }] : []),
    ];
  }
  return [];
}

/**
 * The URLs a fetch call asked for — `web_fetch {url}`, or `web fetch <url>` /
 * `--url=<url>` in a shell line. The fallback for a fetch whose printed header
 * did not survive: bash keeps the LAST 2000 lines of a long page, and the
 * `URL:` line is the first.
 */
export function fetchUrlsOf(name: string, args: unknown): string[] {
  const a = args as Record<string, unknown> | undefined;
  if (name.toLowerCase() !== 'bash') {
    const url = str(a?.url);
    return url !== undefined && /^https?:\/\//i.test(url) ? [url] : [];
  }
  const command = str(a?.command) ?? '';
  const re = /web\s+fetch\s+(?:--url[=\s]\s*)?["']?(https?:\/\/[^\s"']+)/g;
  return [...command.matchAll(re)].map((m) => m[1] as string);
}

/** A page a fetch printed: `# Title`, `URL: …`, then the article. */
export interface FetchedPage {
  readonly url: string;
  readonly title?: string;
  /** The opening of the article, for a row with nothing better to show. */
  readonly snippet?: string;
}

/** Markdown down to the words — for a two-line snippet, not for display as markdown. */
function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The pages in a fetch's text body. Several when one shell line fetched
 * several; none for "Fetch failed: …", which read nothing.
 */
export function parseFetchedPages(text: string): FetchedPage[] {
  const lines = text.split('\n');
  const pages: FetchedPage[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^URL:\s*(https?:\/\/\S+)\s*$/i.exec((lines[i] ?? '').trim());
    if (m === null) continue;
    const url = m[1] as string;
    let title: string | undefined;
    for (let j = i - 1; j >= Math.max(0, i - 2); j -= 1) {
      const t = /^#\s+(.+)$/.exec((lines[j] ?? '').trim());
      if (t !== null) {
        title = (t[1] as string).trim();
        break;
      }
    }
    // The article starts after the header block; stop at the next page's header.
    const body: string[] = [];
    for (let k = i + 1; k < lines.length && body.join(' ').length < 400; k += 1) {
      const line = (lines[k] ?? '').trim();
      if (/^URL:\s*https?:\/\//i.test(line) || /^#\s/.test(line)) {
        if (body.length > 0) break;
        continue;
      }
      if (line === '' || /^\(content truncated\)$/i.test(line)) continue;
      body.push(line);
    }
    const snippet = plainText(body.join(' ')).slice(0, 280);
    pages.push({ url, ...(title !== undefined ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return pages;
}

/** One tool call of a turn with what it returned, in the order they ran. */
export interface TurnCall {
  readonly name: string;
  readonly args: unknown;
  readonly result?: Pick<ToolResultMsg, 'text' | 'isError'>;
}

type SearchRow = { readonly title: string; readonly url: string; readonly snippet?: string };

/*
 * EACH RESULT IS READ ONCE. The turn re-renders on every streamed token, and a
 * fetched page is up to 40 KB of text; its text never changes once it has
 * landed, and the store hands back the same result object until it does.
 */
const readSearches = new WeakMap<object, SearchRow[]>();
const readFetches = new WeakMap<object, FetchedPage[]>();

function searchRowsOf(result: object, text: string): SearchRow[] {
  let rows = readSearches.get(result);
  if (rows === undefined) {
    // The chain's own reader of this text (JSON rows from an MCP search tool
    // too), so a row and a source can never disagree about a result.
    rows = parseSearchOutcome({ text }).results.flatMap((r) =>
      r.url === undefined ? [] : [{ title: r.title, url: r.url, snippet: r.snippet }],
    );
    readSearches.set(result, rows);
  }
  return rows;
}

function fetchedPagesOf(result: object, text: string): FetchedPage[] {
  let pages = readFetches.get(result);
  if (pages === undefined) {
    pages = parseFetchedPages(text);
    readFetches.set(result, pages);
  }
  return pages;
}

/**
 * Every page the turn saw, first sighting first. A page listed by a search and
 * then opened is ONE source, read, keeping the search's title and snippet
 * (what the model was shown) over the fetch's.
 */
export function collectTurnSources(calls: readonly TurnCall[]): TurnSource[] {
  const byKey = new Map<string, TurnSource>();
  let searches = 0;
  const add = (source: Omit<TurnSource, 'key' | 'host' | 'seen'>): void => {
    const key = sourceKey(source.url);
    if (key === null) return;
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, { ...source, key, host: hostOf(source.url), seen: byKey.size });
      return;
    }
    byKey.set(key, {
      ...prior,
      read: prior.read || source.read,
      title: prior.title ?? source.title,
      snippet: prior.snippet ?? source.snippet,
      rank: prior.rank ?? source.rank,
      search: prior.search ?? source.search,
    });
  };
  for (const call of calls) {
    const result = call.result;
    if (result === undefined || result.isError) continue;
    const kinds = webCallsOf(call.name, call.args);
    for (const kind of kinds) {
      if (kind.kind === 'search') {
        const rows = searchRowsOf(result, result.text);
        if (rows.length === 0) continue;
        const search = searches;
        searches += 1;
        for (const [i, r] of rows.entries()) {
          add({ url: r.url, title: r.title, snippet: r.snippet, read: false, rank: i + 1, search });
        }
      } else {
        const pages = fetchedPagesOf(result, result.text);
        for (const p of pages) {
          add({ url: p.url, title: p.title, snippet: p.snippet, read: true });
        }
        // The header lost to truncation: the call itself says which page it was.
        if (pages.length === 0 && !/^Fetch failed:/m.test(result.text)) {
          for (const url of fetchUrlsOf(call.name, call.args)) add({ url, read: true });
        }
      }
    }
  }
  return [...byKey.values()];
}

/**
 * The URLs a markdown answer links to, as source keys, in the order they first
 * appear. Wikipedia-style parentheses inside a URL survive; a sentence's full
 * stop after an autolink does not.
 */
export function linkedKeys(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s<>()"'\]]+(?:\([^\s<>()"']*\)[^\s<>()"'\]]*)*/g;
  for (const m of markdown.matchAll(re)) {
    const key = sourceKey(m[0].replace(/[.,;:!?]+$/, ''));
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The Sources card's order: what the answer cites, in the order it cites it;
 * then pages the model opened; then the rest of what its searches listed,
 * interleaved by rank so each search's best result comes before any search's
 * tenth.
 */
export function orderForCard(
  sources: readonly TurnSource[],
  cited: readonly string[],
): TurnSource[] {
  const byKey = new Map(sources.map((s) => [s.key, s] as const));
  const out: TurnSource[] = [];
  const taken = new Set<string>();
  const take = (s: TurnSource | undefined): void => {
    if (s === undefined || taken.has(s.key)) return;
    taken.add(s.key);
    out.push(s);
  };
  for (const k of cited) take(byKey.get(k));
  for (const s of sources) if (s.read) take(s);
  const rest = sources
    .filter((s) => !taken.has(s.key))
    .sort(
      (a, b) =>
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        (a.search ?? 0) - (b.search ?? 0) ||
        a.seen - b.seen,
    );
  for (const s of rest) take(s);
  return out;
}

/**
 * A page title without the site's name hung on the end — "Complete wiring map
 * | National Institutes of Health" under a row that already says whose site it
 * is. Only a trailing segment that IS the site's name (or its host) goes.
 */
export function cleanTitle(title: string, siteName: string | undefined, host: string): string {
  const t = title.trim();
  const m = /^(.*\S)\s+[|\-–—·:]\s+([^|\-–—·]{2,60})$/.exec(t);
  if (m === null) return t;
  const tail = (m[2] as string).trim().toLowerCase();
  const label = host.split('.').slice(-2, -1)[0] ?? '';
  const names = [siteName?.trim().toLowerCase(), host, label].filter(
    (n): n is string => n !== undefined && n !== '',
  );
  const squash = (s: string): string => s.replace(/[^a-z0-9]/g, '');
  return names.some((n) => squash(n) === squash(tail)) ? (m[1] as string) : t;
}

/**
 * The title to show: what the search showed the model — unless the search had
 * cut it short. Search engines trim long titles ("Whole-brain annotation and
 * multi-connectome cell typing of ..."; SEEN on the first real research turn,
 * a Nature paper), and the page's own `og:title` is the whole of it.
 */
export function bestTitle(
  fromSearch: string | undefined,
  fromPage: string | undefined,
): string | undefined {
  if (fromSearch === undefined || fromSearch.trim() === '') return fromPage;
  if (fromPage === undefined || fromPage.trim() === '') return fromSearch;
  const bare = fromSearch.replace(/\s*(?:\.{3}|…)\s*$/, '').trim();
  const trimmed = bare !== fromSearch.trim();
  const longer = fromPage.trim().length > bare.length + 3;
  const extends_ = fromPage.trim().toLowerCase().startsWith(bare.toLowerCase());
  return longer && (trimmed || extends_) ? fromPage.trim() : fromSearch;
}

/**
 * What a chip calls a site: its own name when the page declares one
 * (`og:site_name`), otherwise its host. Never guessed from the title.
 */
export function siteLabel(siteName: string | undefined, host: string): string {
  const name = siteName?.replace(/\s+/g, ' ').trim();
  return name !== undefined && name !== '' ? name : host;
}
