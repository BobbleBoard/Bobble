/**
 * THE GENERATION THAT IS HAPPENING RIGHT NOW, for the card in the thread.
 *
 * The user: "image/video/audio/media generation tools DO NOT GET SHOWN IN THE
 * CANVAS… they get shown inline, the large card, same as each studio would
 * show." So the live surface data the gen manager streams — step counts, the
 * worker's own status line, the decoded step previews, the finished clip — stops
 * going to a canvas tab and comes here instead, where the thread can read it.
 *
 * WHAT THIS DOES NOT CARRY: the decoded FRAMES. They arrive up to once a second
 * and drive a filter and a clip-path, and putting them through React re-rendered
 * the whole assistant group — markdown included — on every step (see
 * ThreadImagePlaceholder for what that looked like). Frames go straight to the
 * DOM via `subscribeToDenoise`; this store holds only the things that change a
 * few times a job and that a component genuinely has to re-render for.
 *
 * ONE JOB AT A TIME is not an assumption here, it is the engine's rule: the
 * JobQueue runs a single heavy job on a 24 GB machine and gen3d refuses a second
 * outright. `liveGenJob()` therefore returns *the* job rather than asking the
 * caller to correlate one — and the caller that must correlate (a chat showing a
 * running tool call) already has the stronger fact: its own tool row.
 */
import { create } from 'zustand';

/** The three modalities the generate tools produce inline cards for. */
export type GenLiveModality = 'image' | 'video' | 'audio';

/** One generation, as the thread needs to see it. */
export interface GenLiveJob {
  /** The gen manager's tab id (`pi:gen-<jobId>`) — the stream's identity. */
  readonly id: string;
  /** The engine job id, for `gen:cancel`. */
  readonly jobId: string;
  readonly modality: GenLiveModality;
  readonly prompt?: string;
  /** Denoising progress, once the engine is counting steps. */
  readonly step?: number;
  readonly total?: number;
  /**
   * What the worker last said it was doing.
   *
   * MEASURED on the user's Mac: a cold image run spends 94 seconds before step 1 —
   * uv provisioning a Python environment, then weights loading. The studio has
   * shown this line all along; the thread said nothing for the same 94 seconds.
   */
  readonly note?: string;
  /** Aspect ratio of the picture being made, when the job knows it. */
  readonly aspect?: number;
  /** Outputs finished so far — an audio waveform resolves onto the first one. */
  readonly outputs: readonly string[];
  readonly status: 'generating' | 'done' | 'error';
  readonly error?: string;
  /** Renderer clock, ms — when this job's first event arrived. */
  readonly startedAt: number;
}

interface GenLiveState {
  /** Keyed by stream id. Small and short-lived; a finished job is dropped when
   * the next one opens, so the audio card can resolve onto its own result. */
  readonly jobs: Readonly<Record<string, GenLiveJob>>;
  /** The stream that opened most recently, or null before anything has. */
  readonly currentId: string | null;
  readonly open: (job: GenLiveJob) => void;
  readonly update: (id: string, patch: Partial<GenLiveJob>) => void;
  readonly clear: () => void;
}

export const useGenLive = create<GenLiveState>((set) => ({
  jobs: {},
  currentId: null,
  open: (job) =>
    set(() => ({
      // A new job replaces the map outright rather than accumulating: these are
      // live surfaces, not history, and history is the thread itself.
      jobs: { [job.id]: job },
      currentId: job.id,
    })),
  update: (id, patch) =>
    set((s) => {
      const existing = s.jobs[id];
      if (existing === undefined) return s;
      return { jobs: { ...s.jobs, [id]: { ...existing, ...patch } } };
    }),
  clear: () => set(() => ({ jobs: {}, currentId: null })),
}));

/** The generation currently on screen, or null. */
export function liveGenJob(state: GenLiveState): GenLiveJob | null {
  const id = state.currentId;
  return id === null ? null : (state.jobs[id] ?? null);
}

/**
 * The live job IF it is of this modality.
 *
 * The card asks by modality because that is what it can prove locally: an audio
 * card must never resolve its waveform onto a picture, however certain the
 * one-job-at-a-time rule is. A mismatch simply yields null and the card falls
 * back to its own placeholder animation, which is the honest failure.
 */
export function useLiveGen(modality: GenLiveModality | null): GenLiveJob | null {
  return useGenLive((s) => {
    const job = liveGenJob(s);
    if (job === null || modality === null) return null;
    return job.modality === modality ? job : null;
  });
}

/* E2E hook, on the same `?piE2E` opt-in the other stores use: a probe can put a
   generating card on screen without spending minutes of GPU to get one. How the
   wait is DRAWN is a different question from whether the generator runs, and
   tying the two together is what makes a visual check too slow to run. */
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __gen_live?: () => typeof useGenLive }).__gen_live = () => useGenLive;
}
