/**
 * WHAT A GENERATION LOOKS LIKE WHILE IT IS STILL A GENERATION.
 *
 * One component, three modalities, and — this is the part that matters — it
 * lives in the THREAD, in the box the finished thing will occupy. the user, round
 * 21: "image/video/audio/media generation tools DO NOT GET SHOWN IN THE
 * CANVAS…. they get shown inline, the large card, same as each studio would
 * show. we need to have custom animations for when these are generating."
 *
 * Each modality gets the animation that is honest about what its engine can
 * actually tell us:
 *
 *   image  the app's own mark as a sliding-tile puzzle, replaced the instant a
 *          real decoded step arrives — mflux and the gen3d sidecar both publish
 *          them, so the wait ends in the picture resolving rather than in a cut.
 *   video  the same, and it keeps the tiles for the whole run: ComfyUI publishes
 *          step COUNTS and no step images, so there is nothing to unblur. Said
 *          here rather than pretended around.
 *   audio  pulsing bars at the exact geometry of the transport that replaces
 *          them, resolving onto the real waveform as soon as the clip exists.
 *
 * A 3D build gets no bespoke animation: it is a multi-stage pipeline with its
 * own progress vocabulary, and the card's title, estimate and clock already say
 * more about it than a loop could.
 */
import type { JSX } from 'react';
import { type GenLiveJob, type GenLiveModality, useLiveGen } from '../state/gen-live';
import type { JobKind } from './long-job';
import { ThreadAudioPlaceholder } from './ThreadAudioPlaceholder';
import { ThreadImagePlaceholder } from './ThreadImagePlaceholder';

/** The generation stream's modality for a job kind, or null when it has none. */
export function genModalityFor(kind: JobKind | null | undefined): GenLiveModality | null {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'music' || kind === 'speech' || kind === 'sfx') return 'audio';
  return null;
}

/** The verb the placeholder announces to a screen reader. */
const LABEL: Partial<Record<JobKind, string>> = {
  image: 'Generating an image',
  video: 'Generating a video',
  music: 'Composing music',
  speech: 'Recording the audio',
  sfx: 'Generating a sound',
};

export function GeneratingMedia({
  kind,
  job,
}: {
  kind: JobKind;
  /** The live stream for this job, when one is reporting. Absent is normal:
   * the gen3d image path publishes frames without opening a gen stream. */
  job?: GenLiveJob | null;
}): JSX.Element | null {
  const label = LABEL[kind] ?? 'Working';
  if (kind === 'image' || kind === 'video') {
    return (
      <ThreadImagePlaceholder
        label={label}
        {...(job?.aspect !== undefined ? { aspect: job.aspect } : {})}
      />
    );
  }
  if (kind === 'music' || kind === 'speech' || kind === 'sfx') {
    /* The first finished clip is what the bars resolve onto. With `n > 1` the
       rest arrive as their own cards; a waveform can only be one sound's. */
    return <ThreadAudioPlaceholder label={label} resolveSrc={job?.outputs[0]} />;
  }
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
