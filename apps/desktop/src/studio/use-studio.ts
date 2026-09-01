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
 */
import { useCallback, useEffect, useState } from 'react';
import type { MediaKind, ThreadMediaItem } from '../chat/thread-media';
import { useGenStore } from '../state/gen-store';
import { type StudioModality, useStudioRuns } from '../state/studio-runs';

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
  /** Step progress, when the backend streams it (image + video do). */
  readonly step?: number;
  readonly total?: number;
  /** The latest decoded preview frame, when there is one. */
  readonly previewSrc?: string;
  readonly cancellable: boolean;
}

type Req = Parameters<typeof window.piDesktop.invoke<'gen:generate'>>[1];

export interface UseStudio {
  readonly busy: boolean;
  readonly error: string | null;
  readonly runs: readonly StudioRun[];
  readonly job: StudioJobState | null;
  readonly run: (req: Req) => Promise<void>;
  readonly cancel: () => void;
  readonly clearError: () => void;
}

/** Extension → the kind a result renders as. */
function kindOf(path: string): MediaKind {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (['glb', 'gltf', 'obj', 'ply', 'stl'].includes(ext)) return 'model';
  return 'image';
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
  const addRun = useStudioRuns((s) => s.add);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<StudioJobState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  /*
   * THE PROGRESS THAT WAS ALREADY FLOWING PAST THIS WINDOW.
   *
   * `gen:open` / `gen:update` carry `{candidate, step, total}` and decoded step
   * previews, emitted on this exact code path — and the only subscriber in the
   * app was the chat canvas hook, which is not mounted while a studio is open.
   * So a job streamed step-accurate progress into a room nobody was in, and the
   * studio's entire answer to a multi-minute wait was a 13px spinner at half
   * opacity. We subscribe while busy and correlate on the first job to open.
   */
  useEffect(() => {
    if (!busy) return;
    let mine: string | null = null;
    const take = (tabId: string, payload: GenPayload): void => {
      if (mine === null) mine = tabId;
      if (tabId !== mine) return;
      setJobId(tabId.startsWith('pi:gen-') ? tabId.slice('pi:gen-'.length) : null);
      setJob((cur) =>
        cur === null
          ? cur
          : {
              ...cur,
              ...(payload.progress !== undefined
                ? { step: payload.progress.step, total: payload.progress.total }
                : {}),
              ...(latestPreview(payload) !== undefined
                ? { previewSrc: latestPreview(payload) }
                : {}),
              cancellable: true,
            },
      );
    };
    const unsubOpen = window.piDesktop.onEvent('gen:open', ({ tabId, payload }) =>
      take(tabId, payload as GenPayload),
    );
    const unsubUpdate = window.piDesktop.onEvent('gen:update', ({ tabId, payload }) =>
      take(tabId, payload as GenPayload),
    );
    return () => {
      unsubOpen();
      unsubUpdate();
    };
  }, [busy]);

  const run = useCallback(
    async (req: Req): Promise<void> => {
      setBusy(true);
      setError(null);
      setJobId(null);
      setJob({ prompt: req.prompt, startedAt: Date.now(), cancellable: false });
      try {
        const res = await window.piDesktop.invoke('gen:generate', req);
        if (res.error !== undefined && res.error !== '') {
          setError(res.error);
          return;
        }
        if (res.outputs.length === 0) {
          setError('the generator produced nothing');
          return;
        }
        const first = res.outputs[0];
        addRun(modality, {
          prompt: req.prompt,
          at: Date.now(),
          ...(first?.seed !== undefined ? { seed: first.seed } : {}),
          ...(first?.model !== undefined ? { model: first.model } : {}),
          items: res.outputs.map((o) => ({
            path: o.path,
            kind: kindOf(o.path),
            name: o.path.split('/').pop() ?? o.path,
          })),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        /*
         * NO LIVENESS GUARD. There was one — a `live` flag flipped on unmount —
         * and it could never work: the callback closes over the value from the
         * render that created it, and setting state on an unmounted component
         * is a no-op anyway. Results go to the store now, so a run that finishes
         * after you have left the room lands where the room will look for it.
         */
        setBusy(false);
        setJob(null);
      }
    },
    [addRun, modality],
  );

  const cancel = useCallback((): void => {
    if (jobId === null) return;
    void window.piDesktop.invoke('gen:cancel', { jobId }).catch(() => undefined);
  }, [jobId]);

  return { busy, error, runs, job, run, cancel, clearError: () => setError(null) };
}

interface GenPayload {
  readonly candidates?: ReadonlyArray<{ readonly previewSrc?: string; readonly status: string }>;
  readonly progress?: { readonly candidate: number; readonly step: number; readonly total: number };
}

/** The most recent decoded step image across the candidates, if any. */
function latestPreview(payload: GenPayload): string | undefined {
  const withPreview = (payload.candidates ?? []).filter((c) => c.previewSrc !== undefined);
  return withPreview.length > 0 ? withPreview[withPreview.length - 1]?.previewSrc : undefined;
}
