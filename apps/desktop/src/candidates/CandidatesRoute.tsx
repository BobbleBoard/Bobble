/**
 * The CANDIDATE ROUTE — `?candidates=schedule` / `?candidates=connectors`.
 *
 * the user asked for candidate designs for the Scheduled and Connectors tabs that
 * do NOT replace what ships: "these UI's are not to immediately replace
 * anything but keep the current ones safe." So they live off a dev-only query
 * param with their own switcher, reachable and screenshot-able without any
 * shipping surface importing them.
 *
 * Lazy on purpose — nothing here is in the normal bundle.
 */
import { useState } from 'react';
import { lazyRoute } from '../RouteBoundary';

export interface CandidateEntry {
  /** URL-stable id, used by `&v=`. */
  readonly id: string;
  /** What the switcher calls it. */
  readonly name: string;
  /** One line on what this design is arguing for. */
  readonly note: string;
  readonly render: () => React.ReactNode;
}

/* Their own boundary, like every other lazy route — a candidate gallery that
 * will not fetch is a dev route failing, not the app. See RouteBoundary.tsx. */
const ScheduleCandidates = lazyRoute('Schedule candidates', () => import('./schedule/index'), {
  pick: (m) => m.CandidateGallery,
});
const ConnectorCandidates = lazyRoute('Connector candidates', () => import('./connectors/index'), {
  pick: (m) => m.CandidateGallery,
});

export const CANDIDATES_PARAM = 'candidates';

/** Which candidate set the URL asks for, or null when this is a normal launch. */
export function candidateSet(search: string): 'schedule' | 'connectors' | null {
  const v = new URLSearchParams(search).get(CANDIDATES_PARAM);
  return v === 'schedule' || v === 'connectors' ? v : null;
}

/**
 * The shared chrome: a slim switcher strip over whichever candidate is picked.
 * Each candidate set owns everything below it.
 */
export function CandidateShell({
  entries,
  initial,
}: {
  entries: readonly CandidateEntry[];
  initial?: string;
}) {
  const [active, setActive] = useState(
    () => entries.find((e) => e.id === initial)?.id ?? entries[0]?.id ?? '',
  );
  const current = entries.find((e) => e.id === active) ?? entries[0];
  return (
    <div className="flex h-full flex-col" data-testid="candidate-shell">
      <header
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--pd-border-subtle)', background: 'var(--pd-bg-raised)' }}
      >
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            className="pd-segment"
            data-state={e.id === current?.id ? 'active' : undefined}
            data-testid={`candidate-tab-${e.id}`}
            onClick={() => setActive(e.id)}
            title={e.note}
          >
            {e.name}
          </button>
        ))}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden" data-testid="candidate-body">
        {current?.render()}
      </div>
    </div>
  );
}

export function CandidatesRoute({ set }: { set: 'schedule' | 'connectors' }) {
  const initial = new URLSearchParams(window.location.search).get('v') ?? undefined;
  return set === 'schedule' ? (
    <ScheduleCandidates initial={initial} />
  ) : (
    <ConnectorCandidates initial={initial} />
  );
}
