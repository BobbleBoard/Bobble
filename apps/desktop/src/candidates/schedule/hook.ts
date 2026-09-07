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
import { useLlmStore } from '../../state/llm-store';

/**
 * The states a candidate can be put in — a list, or a function of the moment,
 * because some states cannot exist on some data: an empty list has nothing
 * running and nothing late, and a shot named for a state the screen is not in
 * is worse than no shot (round three had two of those, byte-identical to the
 * default).
 */
type StateList = readonly string[] | (() => readonly string[]);

interface CandidateStates {
  readonly states: StateList;
  readonly set: (state: string) => void;
}

interface ScheduleCandidatesHook {
  seedRuns: (runs: Record<string, readonly TaskRun[]>) => void;
  reload: () => Promise<void>;
  states: (candidateId: string) => readonly string[];
  setState: (candidateId: string, state: string) => void;
  /**
   * Put a model in the llm store as if `llm:status` had said it was ready —
   * through the store's own `applyStatus`, the seam main's event uses. The
   * probe loads no model (there is none in a throwaway home), and without
   * this every shot of "Runs on" said "none is loaded yet". `null` unloads.
   */
  setLoadedModel: (displayName: string | null) => void;
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
  states: StateList,
  set: (state: string) => void,
): () => void {
  registry.set(candidateId, { states, set });
  return () => {
    registry.delete(candidateId);
  };
}

function statesOf(entry: CandidateStates | undefined): readonly string[] {
  if (entry === undefined) return ['default'];
  return typeof entry.states === 'function' ? entry.states() : entry.states;
}

export function installCandidateHook(): void {
  if (window.__scheduleCandidates !== undefined) return;
  window.__scheduleCandidates = {
    seedRuns(runs) {
      seeded = true;
      useTasksStore.setState({ runs });
    },
    reload: () => useTasksStore.getState().load(),
    states: (id) => statesOf(registry.get(id)),
    setState: (id, state) => registry.get(id)?.set(state),
    setLoadedModel(displayName) {
      const { status, applyStatus } = useLlmStore.getState();
      if (displayName === null) {
        applyStatus({ ...status, phase: 'idle', serverRunning: false, model: null });
        return;
      }
      applyStatus({
        ...status,
        phase: 'ready',
        serverRunning: true,
        model: {
          id: displayName.toLowerCase().replace(/\s+/g, '-'),
          displayName,
          quant: 'Q4_K_M',
          contextWindow: 65_536,
        },
      });
    },
  };
}
