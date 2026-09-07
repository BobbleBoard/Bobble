/**
 * Candidate designs for the SCHEDULED tab. Owned end-to-end by the schedule
 * candidate pass — add entries, add files beside this one, nothing outside
 * `src/candidates/schedule/` needs to change.
 *
 * Four arguments about what the screen is FOR (NOTES.md has the long form):
 *   ledger-plus — the one to ship: the Ledger's page with the Agenda's sentence
 *                 box across the top and its day-grouped list
 *   ledger      — what it left behind: the run history is the page
 *   agenda      — when it runs on this Mac, and whether it can
 *   routines    — a prompt with a clock; templates, tasks and reach on one board
 */
import './candidates.css';
import { useEffect } from 'react';
import { type CandidateEntry, CandidateShell } from '../CandidatesRoute';
import { AgendaCandidate } from './AgendaCandidate';
import { AppChrome } from './chrome';
import { installCandidateHook } from './hook';
import { LedgerCandidate } from './LedgerCandidate';
import { RoutinesCandidate } from './RoutinesCandidate';

/** `&v=` value that renders Ledger+ inside the real app shell instead of the switcher. */
const CHROME_VIEW = 'ledger-plus-chrome';

const ENTRIES: readonly CandidateEntry[] = [
  {
    id: 'ledger-plus',
    name: 'Ledger+',
    note: 'The one to ship: the run history is the page, a sentence with a time in it is the way in, and the list is grouped by when.',
    render: () => <LedgerCandidate plus />,
  },
  {
    id: 'ledger',
    name: 'Ledger',
    note: 'A scheduled task is judged by what it left behind — the run history is the page, the schedule is a detail.',
    render: () => <LedgerCandidate />,
  },
  {
    id: 'agenda',
    name: 'Agenda',
    note: 'A schedule is a question about time on this Mac: what runs next, what is due, what was missed — with the parsed schedule shown before you commit.',
    render: () => <AgendaCandidate />,
  },
  {
    id: 'routines',
    name: 'Routines',
    note: 'A task is a prompt with a clock; templates, tasks and what they reach are one kind of card, not three menus.',
    render: () => <RoutinesCandidate />,
  },
];

export function CandidateGallery({ initial }: { initial?: string }) {
  useEffect(() => {
    installCandidateHook();
  }, []);
  if (initial === CHROME_VIEW) {
    return (
      <AppChrome title="Scheduled">
        <LedgerCandidate plus />
      </AppChrome>
    );
  }
  return <CandidateShell entries={ENTRIES} initial={initial} />;
}
