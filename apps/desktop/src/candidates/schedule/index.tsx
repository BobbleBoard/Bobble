/**
 * Candidate designs for the SCHEDULED tab. Owned end-to-end by the schedule
 * candidate pass — add entries, add files beside this one, nothing outside
 * `src/candidates/schedule/` needs to change.
 *
 * Three arguments about what the screen is FOR (NOTES.md has the long form):
 *   ledger   — what it left behind: the run history is the page
 *   agenda   — when it runs on this Mac, and whether it can
 *   routines — a prompt with a clock; templates, tasks and reach on one board
 */
import './candidates.css';
import { useEffect } from 'react';
import { type CandidateEntry, CandidateShell } from '../CandidatesRoute';
import { AgendaCandidate } from './AgendaCandidate';
import { installCandidateHook } from './hook';
import { LedgerCandidate } from './LedgerCandidate';
import { RoutinesCandidate } from './RoutinesCandidate';

const ENTRIES: readonly CandidateEntry[] = [
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
  return <CandidateShell entries={ENTRIES} initial={initial} />;
}
