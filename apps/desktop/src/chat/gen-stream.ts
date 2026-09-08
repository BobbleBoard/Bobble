/**
 * The renderer's subscription to a RUNNING generation — the twin of
 * `useBrowserAgent`, minus the canvas.
 *
 * ## What changed, and why
 * This hook used to be `useGen(controller)` and its whole job was to
 * `upsertTab({ kind: 'gen-image' })` for every `generate_image` /
 * `generate_video` call. the user, round 21: "image/video/audio/media generation
 * tools DO NOT GET SHOWN IN THE CANVAS…. they get shown inline, the large card,
 * same as each studio would show."
 *
 * It was already half-conceded — the hook carried a long comment titled "THE
 * RAIL DOES NOT OPEN ITSELF", from an earlier round where the user asked for the
 * same thing — and it did not hold, because `CanvasTabsPanel` opens the rail
 * whenever the tab COUNT grows, from any source. A tab that must never be
 * looked at is not a tab; asking for a picture in a conversation is a request
 * for a picture, not a request to rearrange the window around one.
 *
 * So the stream now feeds {@link useGenLive}, the thread reads it, and the
 * canvas never hears about generation at all.
 *
 * ## Why it is no longer gated on the experimental flag
 * The gen-tools extension only loads when the flag is on, so with the flag off
 * these events are never emitted and two idle IPC listeners cost nothing. The
 * gate mattered when the hook could CREATE UI (a surface registration and a
 * canvas tab); it cannot any more. Ungating it also means the card behaves the
 * same however the job was started — which is the point of one card.
 */
import { useEffect } from 'react';
import type { GenSurfacePayload } from '../../electron/gen/gen-ipc-contract';
import { type GenLiveJob, useGenLive } from '../state/gen-live';

/** `pi:gen-<jobId>` → the engine job id `gen:cancel` wants. */
export function jobIdFromTab(tabId: string): string {
  return tabId.startsWith('pi:gen-') ? tabId.slice('pi:gen-'.length) : tabId;
}

/**
 * The most recent decoded step image across the candidates, if any.
 *
 * LAST rather than first: with `n > 1` the engine works through the candidates
 * in order, so the newest preview is the one being worked on now. A card showing
 * candidate 1 while candidate 4 is rendering is a picture of the past.
 */
export function latestPreview(payload: GenSurfacePayload): string | undefined {
  const withPreview = payload.candidates.filter((c) => c.previewSrc !== undefined);
  return withPreview.length > 0 ? withPreview[withPreview.length - 1]?.previewSrc : undefined;
}

/** Every output that has actually landed, in candidate order. */
export function finishedOutputs(payload: GenSurfacePayload): string[] {
  return payload.candidates
    .map((c) => c.finalSrc)
    .filter((src): src is string => typeof src === 'string' && src.length > 0);
}

/** One surface payload → the job shape the thread's card reads. Pure. */
export function jobFromPayload(tabId: string, payload: GenSurfacePayload, now: number): GenLiveJob {
  const size = payload.size;
  return {
    id: tabId,
    jobId: jobIdFromTab(tabId),
    modality: payload.modality,
    ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
    ...(payload.progress !== undefined
      ? { step: payload.progress.step, total: payload.progress.total }
      : {}),
    ...(payload.note !== undefined ? { note: payload.note } : {}),
    ...(size !== undefined && size.width > 0 && size.height > 0
      ? { aspect: size.width / size.height }
      : {}),
    outputs: finishedOutputs(payload),
    status: payload.status,
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    startedAt: now,
  };
}

/**
 * Subscribe to the generation stream for as long as the app is up.
 *
 * Mounted at the app root rather than inside the chat, so a job started in a
 * conversation keeps streaming while its owner wanders into a studio and back —
 * the card it belongs to is in the thread, and the thread will still be there.
 */
export function useGenStream(): void {
  useEffect(() => {
    const bridge = window.piDesktop;
    if (bridge === undefined) return;
    const { open, update } = useGenLive.getState();

    const unsubOpen = bridge.onEvent('gen:open', ({ tabId, payload }) => {
      open(jobFromPayload(tabId, payload, Date.now()));
    });
    const unsubUpdate = bridge.onEvent('gen:update', ({ tabId, payload }) => {
      const existing = useGenLive.getState().jobs[tabId];
      if (existing === undefined) {
        // An update for a stream we never saw open (a reload mid-job) still
        // deserves a card — it is the same job either way.
        open(jobFromPayload(tabId, payload, Date.now()));
        return;
      }
      const next = jobFromPayload(tabId, payload, existing.startedAt);
      /*
       * DO NOT UNSET WHAT THE JOB ALREADY TOLD US. `progress` is cleared on the
       * terminal event and `note` is absent on every event that is not a log
       * line, so folding the raw payload in wholesale made the caption flicker
       * between the step count and nothing.
       */
      update(tabId, {
        ...next,
        ...(next.step === undefined ? { step: existing.step, total: existing.total } : {}),
        ...(next.note === undefined ? { note: existing.note } : {}),
        ...(next.aspect === undefined ? { aspect: existing.aspect } : {}),
      });
    });

    return () => {
      unsubOpen();
      unsubUpdate();
    };
  }, []);
}
