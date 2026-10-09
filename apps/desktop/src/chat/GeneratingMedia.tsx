/**
 * WHICH LIVE STREAM A RUNNING TOOL CALL BELONGS TO.
 *
 * The component that used to live here — a per-modality placeholder inside a
 * card with a title, a clock and a Cancel — is gone. The user: "just the same final
 * video card, same final image card, same final 3d card … and then below it,
 * just floating, a white progress bar." The thread now mounts
 * media/PendingMediaCard, the same card the studios use, and this file keeps
 * the one thing the thread still needs from here: the engine's own account of
 * the job that is running.
 */
import { useEffect, useState } from 'react';
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

/** What the 3D engine last said about the build the chat is waiting on. */
export interface Model3dLive {
  readonly note: string;
  /** 0–1 across the whole job (image → structure → shape → texture). */
  readonly progress?: number;
}

/**
 * THE 3D ENGINE'S OWN ACCOUNT of a build, for the card in the thread.
 *
 * A mesh does not go through the gen stream the other modalities use — the
 * 3D studio's sidecar broadcasts `gen3d:job` (stage, a human line, percents)
 * and the studio's panels are its only reader. The chat's pending 3D card
 * would otherwise show the shipped estimate for the whole five minutes while
 * the engine was saying "Shape (step 12/20)" to nobody. Subscribed only while
 * a 3D tool call is running, so an idle chat costs nothing.
 */
export function useModel3dLive(active: boolean): Model3dLive | null {
  const [live, setLive] = useState<Model3dLive | null>(null);
  useEffect(() => {
    if (!active) {
      setLive(null);
      return;
    }
    const bridge = window.piDesktop;
    if (bridge === undefined) return;
    return bridge.onEvent('gen3d:job', (update) => {
      if (update.done) return;
      const note = update.message.trim();
      const pct = update.overallPercent;
      setLive({
        note,
        ...(Number.isFinite(pct) && pct > 0 ? { progress: Math.min(1, pct / 100) } : {}),
      });
    });
  }, [active]);
  return live;
}
