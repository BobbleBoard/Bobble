/**
 * WHICH LIVE STREAM A RUNNING TOOL CALL BELONGS TO.
 *
 * The component that used to live here — a per-modality placeholder inside a
 * card with a title, a clock and a Cancel — is gone. the user: "just the same final
 * video card, same final image card, same final 3d card … and then below it,
 * just floating, a white progress bar." The thread now mounts
 * media/PendingMediaCard, the same card the studios use, and this file keeps
 * the one thing the thread still needs from here: the engine's own account of
 * the job that is running.
 */
import { type GenLiveJob, type GenLiveModality, useLiveGen } from '../state/gen-live';
import type { JobKind } from './long-job';

/** The generation stream's modality for a job kind, or null when it has none. */
export function genModalityFor(kind: JobKind | null | undefined): GenLiveModality | null {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'music' || kind === 'speech' || kind === 'sfx') return 'audio';
  return null;
}

/**
 * The live generation stream for the job kind currently running, or null.
 *
 * A hook so the thread can ask once, near where it already knows which tool row
 * it is waiting on — the store keeps one job because the engine runs one job.
 */
export function useGeneratingJob(kind: JobKind | null | undefined): GenLiveJob | null {
  return useLiveGen(genModalityFor(kind));
}
