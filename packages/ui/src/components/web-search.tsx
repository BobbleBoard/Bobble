import { clsx } from 'clsx';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { createContext, forwardRef, useContext, useState } from 'react';
import { IconGlobe } from './icons.tsx';

/**
 * How a row finds its site's icon. The default knows none, so this package stays
 * free of app wiring and renders letter chips in stories and tests.
 *
 * The app installs a real one ({@link SiteIconProvider}) that resolves each host
 * through the main process — the renderer's CSP forbids remote images, and
 * fetching a favicon from a third-party aggregator would tell it every domain
 * the user searched.
 */
export type UseSiteIcon = (site: string | undefined) => string | undefined;

const SiteIconContext = createContext<UseSiteIcon>(() => undefined);

/** Install the app's icon resolver for every search card below this point. */
export const SiteIconProvider = SiteIconContext.Provider;

/**
 * What a result row does when clicked. Undefined means "behave like a link" —
 * which is what a story or a plain page wants. The app installs one that opens
 * the URL in the canvas browser, next to the conversation the search came from.
 */
const OpenUrlContext = createContext<((url: string) => void) | undefined>(undefined);

/** Install the app's "open this result" behaviour for every card below. */
export const OpenUrlProvider = OpenUrlContext.Provider;

/**
 * The installed opener, for anything that needs to follow a link.
 *
 * Exported because markdown links needed exactly this and had nothing: every
 * hyperlink the model produced was inert — the click scheduled a navigation the
 * main process then cancelled, so every citation in every reply was dead.
 */
export function useOpenUrl(): ((url: string) => void) | undefined {
  return useContext(OpenUrlContext);
}

/*
 * Web-search result list (THEME 3, match img13/14). Header = globe + query +
 * "N results" (right); body = a bordered, rounded, scrollable list of result
 * cards — favicon + title, source host, and a two-line snippet — each linking to
 * its URL. Favicons that fail / are absent fall back to a letter chip built from
 * the domain initial, so the list renders identically offline (and in the
 * screenshot harness). An empty result set renders a labelled empty state (never
 * a blank dead-end): the caller's `emptyHint` explains why (e.g. rate-limited).
 */

export interface WebSearchResultData {
  title: string;
  url?: string;
  /** Displayed on the right, muted (e.g. "developer.mozilla.org"). */
  domain?: string;
  /** One-to-two line description under the title. */
  snippet?: string;
  /** Optional favicon; on load error the row falls back to a letter chip. */
  faviconUrl?: string;
}

function domainInitial(row: WebSearchResultData): string {
  const src = (row.domain ?? row.url ?? row.title ?? '').replace(/^https?:\/\//, '');
  const ch = src
    .replace(/^www\./, '')
    .trim()
    .charAt(0);
  return ch ? ch.toUpperCase() : '#';
}

export interface WebSearchResultItemProps extends Omit<HTMLAttributes<HTMLElement>, 'onSelect'> {
  result: WebSearchResultData;
  onSelect?: (result: WebSearchResultData) => void;
  /** One line: icon, title, site — no snippet (the chain's search row). */
  compact?: boolean;
}

/** One favicon + title + domain + snippet row. Renders as a link if `url` is present. */
export const WebSearchResultItem = forwardRef<HTMLElement, WebSearchResultItemProps>(
  function WebSearchResultItem({ result, onSelect, compact = false, className, ...rest }, ref) {
    const [broken, setBroken] = useState(false);
    // An explicit `faviconUrl` wins; otherwise ask the installed resolver for the
    // site's own icon. Either way a failure falls through to the letter chip, so
    // the list renders identically offline.
    const resolved = useContext(SiteIconContext)(result.domain ?? result.url);
    const openUrl = useContext(OpenUrlContext);
    // An explicit `onSelect` wins; otherwise the app's installed opener handles it.
    const select =
      onSelect ??
      (openUrl !== undefined && result.url !== undefined
        ? () => openUrl(result.url as string)
        : undefined);
    const src = result.faviconUrl ?? resolved;
    const showImg = src !== undefined && !broken;
    const favicon = showImg ? (
      <img className="pd-websearch-favicon-img" src={src} alt="" onError={() => setBroken(true)} />
    ) : (
      <span className="pd-websearch-favicon-chip">{domainInitial(result)}</span>
    );
    const inner = (
      <>
        <span className="pd-websearch-favicon">{favicon}</span>
        <span className="pd-websearch-main">
          <span className="pd-websearch-headline">
            <span className="pd-websearch-title">{result.title}</span>
            {result.domain !== undefined ? (
              <span className="pd-websearch-domain">{result.domain}</span>
            ) : null}
          </span>
          {result.snippet && !compact ? (
            <span className="pd-websearch-snippet">{result.snippet}</span>
          ) : null}
        </span>
      </>
    );
    const shared = clsx('pd-websearch-row pd-focusable', className);
    /*
     * A HANDLER MEANS THIS IS NOT A LINK. The user: "clicking them to show their
     * links in the browser" — the app's own browser, in the canvas beside the
     * conversation.
     *
     * It was tempting to keep the `<a target="_blank">` and merely
     * preventDefault, and it very nearly works: the canvas browser opens, and so
     * does a second OS window on the same page, because the new-window request
     * does not go through the click's default action. Measured, not guessed —
     * the probe found two windows and one of them was outside the app.
     *
     * So when somebody owns the click, the row is a button. `title` keeps the
     * URL on hover. With no handler (a story, a plain page) it is a real link.
     */
    if (select === undefined && result.url !== undefined) {
      return (
        <a
          ref={ref as Ref<HTMLAnchorElement>}
          className={shared}
          href={result.url}
          target="_blank"
          rel="noreferrer"
          title={result.url}
          {...(rest as HTMLAttributes<HTMLAnchorElement>)}
        >
          {inner}
        </a>
      );
    }
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        className={shared}
        {...(result.url !== undefined ? { title: result.url } : {})}
        onClick={() => select?.(result)}
        {...(rest as HTMLAttributes<HTMLButtonElement>)}
      >
        {inner}
      </button>
    );
  },
);

export interface WebSearchResultsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect' | 'results'> {
  query: ReactNode;
  results: WebSearchResultData[];
  /** Header count; defaults to results.length. */
  count?: number;
  /** Rows shown before the list scrolls (drives max-height). */
  maxVisible?: number;
  /** Secondary line shown in the empty state (e.g. a backend note). */
  emptyHint?: ReactNode;
  onSelect?: (result: WebSearchResultData) => void;
  /**
   * `compact` — the search row in a thinking chain: no header (the row above
   * already says what was searched), one line per result (the site's icon,
   * the title, the site), the first five and a "Show N more".
   */
  variant?: 'full' | 'compact';
}

/** Results a compact list shows before "Show N more". */
export const COMPACT_VISIBLE = 5;

/**
 * WHAT A SEARCH FOUND, AT A GLANCE — the chain's search row.
 *
 * Part of the user's sources wave (2026-09-24: "the app's own ui for showing
 * sources and such"): the row should read like research, not a raw log. A
 * list of eight 68px cards with two-line snippets was the whole search result
 * reprinted in the middle of the work; what a person scanning the chain wants
 * is WHERE the model looked — which sites, which pages — and the snippets live
 * on in the answer's Sources card.
 */
function CompactResults({
  results,
  emptyHint,
  onSelect,
  className,
  ...rest
}: Omit<WebSearchResultsProps, 'query' | 'count' | 'maxVisible' | 'variant'>) {
  const [all, setAll] = useState(false);
  if (results.length === 0) {
    return (
      <div className={clsx('pd-websearch pd-websearch--compact', className)} {...rest}>
        <div className="pd-websearch-empty pd-websearch-empty--compact" role="status">
          <span className="pd-websearch-empty-title">No results found</span>
          <span className="pd-websearch-empty-hint">
            {emptyHint ?? 'Try rephrasing the search or checking your connection.'}
          </span>
        </div>
      </div>
    );
  }
  const shown = all ? results : results.slice(0, COMPACT_VISIBLE);
  const hidden = results.length - COMPACT_VISIBLE;
  return (
    <div className={clsx('pd-websearch pd-websearch--compact', className)} {...rest}>
      <div className="pd-websearch-list pd-websearch-list--compact">
        {shown.map((result) => (
          <WebSearchResultItem
            key={result.url ?? result.title}
            result={result}
            onSelect={onSelect}
            compact
          />
        ))}
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          className="pd-showmore pd-focusable"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : `Show ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

/** Web-search step body: header row + bordered scrollable result list, or an empty state. */
export const WebSearchResults = forwardRef<HTMLDivElement, WebSearchResultsProps>(
  function WebSearchResults(
    {
      query,
      results,
      count,
      maxVisible = 4,
      emptyHint,
      onSelect,
      variant = 'full',
      className,
      style,
      ...rest
    },
    ref,
  ) {
    if (variant === 'compact') {
      return (
        <CompactResults
          results={results}
          emptyHint={emptyHint}
          onSelect={onSelect}
          className={className}
          style={style}
          {...rest}
        />
      );
    }
    const total = count ?? results.length;
    const isEmpty = results.length === 0;
    return (
      <div
        ref={ref}
        className={clsx('pd-websearch', className)}
        style={{ '--pd-websearch-visible': maxVisible, ...style } as CSSProperties}
        {...rest}
      >
        <div className="pd-websearch-header">
          <span className="pd-websearch-header-icon">
            <IconGlobe size={15} />
          </span>
          <span className="pd-websearch-query">{query}</span>
          <span className="pd-websearch-count">
            {total} {total === 1 ? 'result' : 'results'}
          </span>
        </div>
        {isEmpty ? (
          <div className="pd-websearch-empty" role="status">
            <span className="pd-websearch-empty-icon">
              <IconGlobe size={18} />
            </span>
            <span className="pd-websearch-empty-title">No results found</span>
            <span className="pd-websearch-empty-hint">
              {emptyHint ?? 'Try rephrasing the search or checking your connection.'}
            </span>
          </div>
        ) : (
          <div className="pd-websearch-list pd-scroll">
            {results.map((result) => (
              <WebSearchResultItem
                key={result.url ?? result.title}
                result={result}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
