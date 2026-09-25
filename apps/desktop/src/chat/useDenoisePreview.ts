/**
 * The renderer's subscription to live denoising frames — from BOTH engines.
 *
 * ## Two streams, one card
 * The app has two generators and they publish step previews differently:
 *
 *   - gen3d's image sidecar (`gen3d:job`) sends an inline data URI per step.
 *     This is the path the ordinary `generate_image` / `edit_image` chat tools
 *     take, and it has always fed this card.
 *   - the gen-service stream (`gen:update`, mflux / ComfyUI, behind the
 *     experimental generation flag) sends a `pd-file://` URL to a step image on
 *     disk. Nothing in the thread listened to it: those previews went to a
 *     canvas tab, which is exactly what the user asked us to stop doing.
 *
 * Both are the same fact — "here is what the picture looks like partway
 * through" — so both land here, and the card cannot tell which engine it is
 * watching. That is the point: "when we get diffusion steps, we put them on so
 * the user can see image unblur in real time as soon as it resembles anything at
 * all" is a promise about the picture, not about the backend.
 *
 * ## Correlating a frame with the tool row that is waiting for it
 * A preview carries a jobId; the chat's tool row carries a toolCallId; nothing
 * connects the two, and plumbing a shared id would mean threading a new field
 * through the tool → app bridge → sidecar → worker → event stream, five layers
 * deep.
 *
 * It used to be matched by liveness, on the premise that only one job ever
 * runs. That stopped being true: a HyperFrames render is a LIGHT job the
 * JobQueue runs beside others, gen3d's image jobs are outside that queue
 * altogether, and a studio, a subagent or a chat in the background can each be
 * generating while a chat's card waits (review of the 2026-09-23 wave). So every
 * frame now says which job it is (the engine's id) and what that job is making,
 * and the card keeps only frames of its own kind, from a job the chat on screen
 * started (state/chat-jobs — a studio's job is never announced), from the one
 * job it is following (PendingMediaCard).
 *
 * ## Why this is a plain function and not a hook
 * It used to be `useDenoisePreview`, holding the frames in React state. That put
 * a `setState` on the render path of every arriving frame, which re-rendered the
 * whole assistant group — markdown, the activity chain, everything — five times
 * per image, and remounted the frame elements each time. the user saw the result as
 * a flash across the window on every step. The frames now drive the DOM directly
 * (see ThreadImagePlaceholder), so nothing about a new frame reaches React.
 */

import type { GenSurfacePayload } from '../../electron/gen/gen-ipc-contract';
import type { PreviewFrameInput } from './denoise-preview';
import { jobIdFromTab, latestPreview } from './gen-stream';

export interface DenoiseListener {
  /** `jobId` is the engine's (a gen-service stream's tab id reduced to it);
   * `modality` is what the job is making — gen3d's frames are always pictures. */
  readonly onFrame: (
    jobId: string,
    preview: PreviewFrameInput,
    modality: 'image' | 'video',
  ) => void;
  readonly onDone: (jobId: string) => void;
}

/**
 * The step preview carried by one gen-service payload, or undefined.
 *
 * THE URL DOES NOT CHANGE BETWEEN STEPS. mflux is told to write its stepwise
 * output into one directory and the worker publishes the running composite from
 * it, which is the SAME FILE rewritten in place — so `img.src = url` on step 3
 * is a no-op assignment of the value already there, and the card would show
 * step 1 forever. The step number is the real identity of a frame, so it is what
 * decides a new one has arrived and what cache-busts the URL. (The query is
 * invisible to the protocol handler, which reads only the pathname.)
 */
export function genFrameFrom(payload: GenSurfacePayload): PreviewFrameInput | undefined {
  if (payload.modality === 'audio') return undefined;
  const src = latestPreview(payload);
  if (src === undefined) return undefined;
  const step = payload.progress?.step ?? 0;
  const total = payload.progress?.total ?? 1;
  return {
    dataUri: `${src}${src.includes('?') ? '&' : '?'}pdstep=${step}`,
    step,
    totalSteps: Math.max(1, total),
    width: payload.size?.width ?? 0,
    height: payload.size?.height ?? 0,
  };
}

/** Listen to the live denoise stream. Returns an unsubscribe, or null when
 * there is no app bridge (a browser-hosted render of the chat). */
export function subscribeToDenoise(listener: DenoiseListener): (() => void) | null {
  const bridge = window.piDesktop;
  if (bridge === undefined) return null;

  const unsubGen3d = bridge.onEvent('gen3d:job', (update) => {
    if (update.preview !== undefined) {
      listener.onFrame(update.jobId, update.preview, 'image');
      return;
    }
    // Keep the last frame on screen and let the card settle at fully resolved
    // rather than freezing mid-tween while the finished PNG loads.
    if (update.done) listener.onDone(update.jobId);
  });

  // Per-stream high-water mark, so a `gen:update` carrying only a status note
  // does not re-publish the frame the card is already showing.
  const seenStep = new Map<string, number>();
  const unsubGen = bridge.onEvent('gen:update', ({ tabId, payload }) => {
    const frame = genFrameFrom(payload);
    if (frame !== undefined && frame.step > (seenStep.get(tabId) ?? -1)) {
      seenStep.set(tabId, frame.step);
      listener.onFrame(
        jobIdFromTab(tabId),
        frame,
        payload.modality === 'video' ? 'video' : 'image',
      );
    }
    if (payload.status !== 'generating') {
      seenStep.delete(tabId);
      listener.onDone(jobIdFromTab(tabId));
    }
  });

  return () => {
    unsubGen3d();
    unsubGen();
  };
}
