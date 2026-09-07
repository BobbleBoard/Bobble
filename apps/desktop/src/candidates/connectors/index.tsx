/**
 * Candidate designs for the CONNECTORS tab. Owned end-to-end by the connectors
 * candidate pass — add entries, add files beside this one, nothing outside
 * `src/candidates/connectors/` needs to change.
 *
 * Three positions on the connectors / skills / servers question:
 *   shelf   one catalog, kind is a filter, what-is-on is a strip of marks
 *   ledger  have vs could-have side by side, kinds mixed in both
 *   reach   grouped by what each one can touch on this Mac, details in place
 * See NOTES.md for the arguments and what each takes / rejects from the refs.
 */
import { type CandidateEntry, CandidateShell } from '../CandidatesRoute';
import './candidates.css';
import { Ledger } from './Ledger';
import { Reach } from './Reach';
import { Shelf } from './Shelf';
import { ShelfPlus } from './ShelfPlus';

const ENTRIES: readonly CandidateEntry[] = [
  {
    id: 'shelf-plus',
    name: 'Shelf+',
    note: 'The merged candidate: Shelf’s one catalog on the model hub’s list-plus-pane idiom, the pane resting as the ledger of what is on, every section capped, tools read as sentences and split by what they change.',
    render: () => <ShelfPlus />,
  },
  {
    id: 'shelf',
    name: 'Shelf',
    note: 'One surface: tools and skills are one catalog with one search — kind is a filter, not a tab — and what is on right now is a strip of marks at the top.',
    render: () => <Shelf />,
  },
  {
    id: 'ledger',
    name: 'Ledger',
    note: 'The real split is have vs could-have: a persistent ledger of what your agent has beside one directory to add from, kinds mixed in both, no separate Directory modal.',
    render: () => <Ledger />,
  },
  {
    id: 'reach',
    name: 'Reach',
    note: 'Grouped by what each connector can touch on this Mac; details expand in place and tools are split into what looks things up vs what changes things.',
    render: () => <Reach />,
  },
];

export function CandidateGallery({ initial }: { initial?: string }) {
  if (ENTRIES.length === 0) {
    return (
      <div
        className="grid h-full place-items-center text-sm"
        style={{ color: 'var(--pd-fg-muted)' }}
      >
        No connector candidates yet.
      </div>
    );
  }
  return <CandidateShell entries={ENTRIES} initial={initial} />;
}
