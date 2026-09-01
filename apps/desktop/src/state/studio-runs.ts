/**
 * WHAT THE STUDIOS HAVE MADE — kept outside the rooms that made it.
 *
 * The rooms are unmounted the moment you press Chat (App.tsx renders the studio
 * INSTEAD of the chat shell), so holding results in a component's state meant
 * the most ordinary gesture in the app — make a thing, go paste it into a
 * conversation, come back and make the next one — silently destroyed everything
 * else you had made that session. The files were never lost; the room simply
 * had no memory of them, and offered no way back to them either.
 *
 * Deliberately in memory only, for now. Persisting across a RELAUNCH means
 * reading the output directory and reconstructing runs from filenames, which is
 * a real feature (a library) rather than a bug fix, and it needs its own design
 * — grouping, deletion, naming. This fixes the case that bites every session.
 */
import { create } from 'zustand';
import type { StudioRun } from '../studio/use-studio';

export type StudioModality = 'image' | 'video' | 'audio';

interface StudioRunsState {
  readonly runs: Readonly<Record<StudioModality, readonly StudioRun[]>>;
  readonly add: (modality: StudioModality, run: StudioRun) => void;
  readonly clear: (modality: StudioModality) => void;
}

export const useStudioRuns = create<StudioRunsState>((set) => ({
  runs: { image: [], video: [], audio: [] },
  add: (modality, run) =>
    set((s) => ({ runs: { ...s.runs, [modality]: [run, ...s.runs[modality]] } })),
  clear: (modality) => set((s) => ({ runs: { ...s.runs, [modality]: [] } })),
}));

/*
 * E2E hook, on the same `?piE2E` opt-in the other stores use: a probe can put a
 * finished run on screen without spending two minutes of GPU to get one. Looking
 * at how a result is DRAWN is a different question from whether the generator
 * works, and tying the two together is what makes visual checks too slow to run.
 */
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __studio_runs?: () => typeof useStudioRuns }).__studio_runs = () =>
    useStudioRuns;
}
