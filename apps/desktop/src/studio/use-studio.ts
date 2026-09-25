/**
 * ONE GENERATION, FROM A STUDIO'S POINT OF VIEW.
 *
 * All three studios need the same five things — run, know how far along it is,
 * stop it, see what came out, see why it did not — and none of them should grow
 * its own copy of the IPC call, the busy flag and the error string.
 *
 * WHY RESULTS ACCUMULATE rather than replacing. Iterating means comparing: you
 * change one knob and want the previous take still on screen to judge against.
 * Newest first, because that is the one you just asked for.
 *
 * WHY THEY LIVE IN A STORE and not in this hook's state. They used to be
 * `useState` here, and the room is unmounted outright when you press Chat — so
 * the single most ordinary gesture in the app (make a thing, go paste it in a
 * conversation, come back and make the next one) destroyed everything you had
 * made. The files were still on disk; the room simply had no memory of them.
 * A module-level store per modality survives the unmount.
 *
 * …and the RUNNING JOB now does the same (state/studio-jobs.ts). It was the
 * last thing still held in here, so leaving mid-generation reset the room to
 * empty while the job ran on in main, and lost the result if it landed before
 * you came back. the user (2026-09-24): "leaving a studio with a generation running
 * and then going back doesn't keep it going, or maybe it does but the UI
 * resets". This hook is now only the room's view of its slot.
 */
import { useCallback, useEffect } from 'react';
import type { ThreadMediaItem } from '../chat/thread-media';
import { useGenStore } from '../state/gen-store';
import {
  cancelStudioJob,
  clearStudioError,
  finishStudioReveal,
  runStudioJob,
  type StudioRequest,
  studioRoomOpened,
  useStudioJobs,
} from '../state/studio-jobs';
import { type StudioModality, useStudioRuns } from '../state/studio-runs';

/**
 * A ROOM IS BLOCKED WHEN NOTHING IN IT CAN ACTUALLY RUN.
 *
 * All three studios asked `models.length === 0`, which is a different question:
 * a catalogue entry marked `reserved` is enumerated and gated — "backend lands
 * in a later phase" — so it counts towards that length while being unable to
 * produce anything.
 *
 * MEASURED in the round-2 settings run: EVERY video model is reserved today,
 * so the Video studio drew a live Generate button, three starters and a model
 * picker reading "Recommended", with nothing anywhere on screen saying that
 * video cannot run on this machine yet. the user, about the image room in the same
 * state: it "isn't user-friendly to get working in a few clicks even when
 * something has gone wrong".
 *
 * Shared so the three rooms cannot drift on the answer.
 */
export function runnableModels<T extends { readonly reserved?: boolean }>(
  models: readonly T[],
): readonly T[] {
  return models.filter((m) => m.reserved !== true);
}

/**
 * Why this room cannot run, or undefined when it can.
 *
 * Two different pieces of news, deliberately worded differently: nothing is
 * catalogued at all (something is wrong, or the engine has not answered), or
 * everything catalogued is still to come (nothing is wrong; it is not built).
 */
export function studioBlockedReason(
  models: readonly { readonly reserved?: boolean }[],
  what: string,
): string | undefined {
  if (models.length === 0) return `No ${what} models are available.`;
  if (runnableModels(models).length === 0) {
    return `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} generation is not available on this machine yet — every model listed is still to come.`;
  }
  return undefined;
}

export interface StudioRun {
  readonly prompt: string;
  readonly items: readonly ThreadMediaItem[];
  readonly at: number;
  /** Provenance the engine already returns, and which used to be dropped here. */
  readonly seed?: number;
  readonly model?: string;
}

/** A generation in flight, as the room shows it. */
export interface StudioJobState {
  readonly prompt: string;
  readonly startedAt: number;
  /**
   * The shape this job was asked for (`"768x432"`), so its card keeps that
   * rectangle however the room's knobs are set when you come back to it.
   */
  readonly size?: string;
  /** Step progress, when the backend streams it (image + video do). */
  readonly step?: number;
  readonly total?: number;
  /**
   * What the engine last said it was doing, before there are any steps to count.
   *
   * the user: the image studio "won't work at all". A cold run spends minutes
   * provisioning a Python environment and loading weights before step 1, and the
   * room said "Starting…" through all of it — indistinguishable from broken.
   */
  readonly note?: string;
  /** The latest decoded preview frame, when there is one. */
  readonly previewSrc?: string;
  readonly cancellable: boolean;
  /**
   * The finished media, while the card is still uncovering it.
   *
   * The job does not end the instant the bytes exist — it ends when the closing
   * sweep has finished showing them (see PendingMediaCard). Clearing the job at
   * the moment the promise resolved is what made the result a SWAP: one card
   * unmounted and a different one appeared in its place. Holding the items here
   * for that second is what makes it a reveal instead.
   */
  readonly items?: readonly ThreadMediaItem[];
}

type Req = StudioRequest;

export interface UseStudio {
  readonly busy: boolean;
  readonly error: string | null;
  readonly runs: readonly StudioRun[];
  readonly job: StudioJobState | null;
  readonly run: (req: Req) => Promise<void>;
  readonly cancel: () => void;
  readonly clearError: () => void;
  /** The card has finished uncovering the result: file it and clear the job. */
  readonly finishReveal: () => void;
}

export function useStudio(modality: StudioModality): UseStudio {
  /*
   * LOAD THE CATALOGUE. The gen store fetches lazily and previously only the
   * settings model-manager ever asked, so a studio opened straight from the
   * sidebar found an empty list and reported "No image models are available."
   * over a catalogue of five. Idempotent — the store keeps a `loaded` flag.
   */
  const loaded = useGenStore((s) => s.loaded);
  const refreshCatalog = useGenStore((s) => s.refreshCatalog);
  useEffect(() => {
    if (!loaded) void refreshCatalog().catch(() => undefined);
  }, [loaded, refreshCatalog]);

  const runs = useStudioRuns((s) => s.runs[modality]);
  const slot = useStudioJobs((s) => s.slots[modality]);

  /* The room is on screen: a result that lands now is uncovered by its card,
     one that lands after this unmounts goes straight into the list. */
  useEffect(() => studioRoomOpened(modality), [modality]);

  const run = useCallback((req: Req) => runStudioJob(modality, req), [modality]);
  const cancel = useCallback(() => cancelStudioJob(modality), [modality]);
  const finishReveal = useCallback(() => finishStudioReveal(modality), [modality]);
  const clearError = useCallback(() => clearStudioError(modality), [modality]);

  return {
    busy: slot.busy,
    error: slot.error,
    runs,
    job: slot.job,
    run,
    cancel,
    finishReveal,
    clearError,
  };
}
