/**
 * ONE GENERATION, FROM A STUDIO'S POINT OF VIEW.
 *
 * All three studios need the same four things — run, know you are running, see
 * what came out, see why it did not — and none of them should each grow their
 * own copy of the IPC call, the busy flag and the error string.
 *
 * WHY RESULTS ACCUMULATE rather than replacing. Iterating means comparing: you
 * change one knob and want the previous take still on screen to judge against.
 * Newest first, because that is the one you just asked for.
 */
import { useCallback, useEffect, useState } from 'react';
import type { MediaKind, ThreadMediaItem } from '../chat/thread-media';
import { useGenStore } from '../state/gen-store';

export interface StudioRun {
  readonly prompt: string;
  readonly items: readonly ThreadMediaItem[];
  readonly at: number;
}

type Req = Parameters<typeof window.piDesktop.invoke<'gen:generate'>>[1];

export interface UseStudio {
  readonly busy: boolean;
  readonly error: string | null;
  readonly runs: readonly StudioRun[];
  readonly run: (req: Req) => Promise<void>;
  readonly clearError: () => void;
}

/** Extension → the kind a result renders as. */
function kindOf(path: string): MediaKind {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  return 'image';
}

export function useStudio(): UseStudio {
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<StudioRun[]>([]);

  /*
   * A generation outlives the view when someone leaves for chat mid-run, so the
   * unmount must not try to set state on a dead component — but it also must not
   * cancel the job, which is real work the user asked for and which the queue
   * owns. Track liveness rather than aborting.
   */
  const [live, setLive] = useState(true);
  useEffect(() => () => setLive(false), []);

  const run = useCallback(
    async (req: Req): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const res = await window.piDesktop.invoke('gen:generate', req);
        if (!live) return;
        if (res.error !== undefined && res.error !== '') {
          setError(res.error);
          return;
        }
        if (res.outputs.length === 0) {
          setError('the generator produced nothing');
          return;
        }
        setRuns((prev) => [
          {
            prompt: req.prompt,
            at: Date.now(),
            items: res.outputs.map((o) => ({
              path: o.path,
              kind: kindOf(o.path),
              name: o.path.split('/').pop() ?? o.path,
            })),
          },
          ...prev,
        ]);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (live) setBusy(false);
      }
    },
    [live],
  );

  return { busy, error, runs, run, clearError: () => setError(null) };
}
