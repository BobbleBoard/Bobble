/**
 * THE SOURCES CARD — under an answer that used the web.
 *
 * the user's reference (Google's overview, his screenshots 5 and 6): the top three
 * sources as rows, a full-width "Show all" that opens the rest IN PLACE, and
 * "Show less" to fold them away again. Ours lists what the answer cites first,
 * in the order it cites it, then the pages the model opened, then the rest of
 * what its searches found (turn-sources / orderForCard) — so the three rows
 * showing are the three that matter most.
 *
 * The rows that are folded away are inert and ask nothing of main until they
 * are shown: a forty-result research turn does not fetch forty pages' heads to
 * draw three rows.
 */
import { IconChevronDown } from '@pi-desktop/ui';
import { useState } from 'react';
import { SourceRow } from './SourceRow';
import { useTurnSources } from './turn-sources';
import './sources.css';

/** Rows shown before "Show all". */
export const SOURCES_FOLDED = 3;

export function SourcesCard() {
  const turn = useTurnSources();
  const [expanded, setExpanded] = useState(false);
  const sources = turn?.ordered ?? [];
  if (sources.length === 0) return null;
  const head = sources.slice(0, SOURCES_FOLDED);
  const rest = sources.slice(SOURCES_FOLDED);
  return (
    <section className="pd-sources" data-testid="sources-card" aria-label="Sources">
      <div className="pd-sources-head">
        <span className="pd-sources-title">Sources</span>
        <span className="pd-sources-count">{sources.length}</span>
      </div>
      <div className="pd-sources-list">
        {head.map((s) => (
          <SourceRow key={s.key} source={s} variant="card" />
        ))}
      </div>
      {rest.length > 0 ? (
        <>
          <div className="pd-sources-more" data-open={expanded}>
            <div className="pd-sources-more-inner pd-scroll" inert={!expanded}>
              {rest.map((s) => (
                <SourceRow key={s.key} source={s} variant="card" active={expanded} />
              ))}
            </div>
          </div>
          <button
            type="button"
            className="pd-sources-toggle pd-focusable"
            data-testid="sources-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Show all'}
            <IconChevronDown size={14} className="pd-sources-toggle-icon" />
          </button>
        </>
      ) : null}
    </section>
  );
}
