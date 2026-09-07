/**
 * The seam between the screenshot probe (shots.mjs) and the candidates.
 *
 * Installed only when the candidate route is mounted, on `window`, because the
 * probe can only reach the page through `page.evaluate`. It lets the probe
 * hand the REAL tasks store a set of run records (the TaskRun shape the runner
 * writes), ask the store to re-read the schedule file after tasks were created
 * through IPC, and put a candidate into one of its named states so every
 * state gets photographed.
 */
import type { TaskRun } from '../../../electron/scheduled/scheduled-contract';
import { useTasksStore } from '../../scheduled/tasks-store';

interface CandidateStates {
  readonly states: readonly string[];
  readonly set: (state: string) => void;
}

interface ScheduleCandidatesHook {
  seedRuns: (runs: Record<string, readonly TaskRun[]>) => void;
  reload: () => Promise<void>;
  states: (candidateId: string) => readonly string[];
  setState: (candidateId: string, state: string) => void;
}

declare global {
  interface Window {
    __scheduleCandidates?: ScheduleCandidatesHook;
  }
}

const registry = new Map<string, CandidateStates>();
let seeded = false;

/** Once the probe has seeded runs, nothing may fetch them from disk over the top. */
export function runsWereSeeded(): boolean {
  return seeded;
}

/** A candidate announces the states it can be photographed in. Returns the unregister. */
export function registerCandidateStates(
  candidateId: string,
  states: readonly string[],
  set: (state: string) => void,
): () => void {
  registry.set(candidateId, { states, set });
  return () => {
    registry.delete(candidateId);
  };
}

export function installCandidateHook(): void {
  if (window.__scheduleCandidates !== undefined) return;
  window.__scheduleCandidates = {
    seedRuns(runs) {
      seeded = true;
      useTasksStore.setState({ runs });
    },
    reload: () => useTasksStore.getState().load(),
    states: (id) => registry.get(id)?.states ?? ['default'],
    setState: (id, state) => registry.get(id)?.set(state),
  };
}
