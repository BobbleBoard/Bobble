/**
 * THE IMAGE VIEWER'S EDITS — kept outside the viewer.
 *
 * WHY A STORE. The viewer is a dialog and Escape is one key away, while an edit
 * takes a minute or more (MEASURED: Qwen-Image 2.1, ~97 s for a 1024² picture
 * on the 24 GB M5 Pro). Closing the viewer halfway must not lose the result —
 * the file lands on disk either way — so the run and every version it made live
 * here, keyed by the ORIGINAL picture's path: open the same card again and its
 * history is there, and a run still going is still going.
 *
 * WHICH ENGINE. The same `gen:generate` the Image Studio's Edit runs — the
 * picture as `inputImage`, the typed words as the prompt, a named strength —
 * rather than the agent's `edit_image` (Mage-Flow-Edit on the Bobble 3D
 * engine). That engine is an optional module most Macs do not have (this one
 * does not: its install stamps are empty), while the image module is the one
 * the studio already needs, and it streams step progress into the same waiting
 * card. One edit in the app, with one queue, one heavy gate and one cancel.
 */
import { create } from 'zustand';
import type { GenSurfacePayload } from '../../electron/gen/gen-ipc-contract';
import { type ImageVersion, jobIdOfTab, versionLabel } from './image-edit';

/** An edit in flight, as the viewer draws it. */
export interface EditJob {
  readonly instruction: string;
  /** This edit's id on the wire — main echoes it on the job's every event. It
   * also keys the waiting card's % (PendingMediaCard `progressKey`), so a
   * viewer reopened mid-run continues the number instead of starting over. */
  readonly requestId: string;
  readonly startedAt: number;
  /** The box the waiting card holds: the picture's own, measured at Edit. */
  readonly aspect: number;
  readonly width: number;
  readonly height: number;
  /** Main's id for the job, once it has opened — what Stop cancels. */
  readonly jobId?: string;
  readonly step?: number;
  readonly total?: number;
  /** What the engine last said it was doing, before there are steps. */
  readonly note?: string;
  /** Stop was pressed: the failure that follows is not news. */
  readonly stopping?: boolean;
  /** The finished version, while the waiting card uncovers it. */
  readonly result?: ImageVersion;
}

/** One picture's history in the viewer. */
export interface EditSession {
  readonly versions: readonly ImageVersion[];
  /** The version on screen — the one the tools act on and the next edit edits. */
  readonly index: number;
  readonly job: EditJob | null;
  readonly error: string | null;
}

interface EditsState {
  readonly sessions: Readonly<Record<string, EditSession>>;
}

export const useImageEdits = create<EditsState>(() => ({ sessions: {} }));

/** A picture's history, started with just the original if it has none yet. */
export function sessionOf(original: ImageVersion): EditSession {
  return (
    useImageEdits.getState().sessions[original.path] ?? {
      versions: [original],
      index: 0,
      job: null,
      error: null,
    }
  );
}

function patch(original: ImageVersion, fn: (s: EditSession) => EditSession): void {
  useImageEdits.setState((st) => ({
    sessions: { ...st.sessions, [original.path]: fn(sessionOf(original)) },
  }));
}

/** Put a version on screen. */
export function selectVersion(original: ImageVersion, index: number): void {
  patch(original, (s) =>
    index >= 0 && index < s.versions.length ? { ...s, index, error: null } : s,
  );
}

export function clearEditError(original: ImageVersion): void {
  patch(original, (s) => ({ ...s, error: null }));
}

/**
 * The waiting card has finished uncovering the result: it is the picture now.
 * (Until then the version is already in the history — on disk and listed — but
 * the card, not the picture, holds the stage.)
 */
export function finishReveal(original: ImageVersion): void {
  patch(original, (s) => {
    const done = s.job?.result;
    if (done === undefined) return s;
    const at = s.versions.findIndex((v) => v.path === done.path);
    return { ...s, job: null, index: at >= 0 ? at : s.index };
  });
}

/** Stop the edit in flight. Quiet: the run's own failure is swallowed. */
export function stopEdit(original: ImageVersion): void {
  const job = sessionOf(original).job;
  if (job === null || job.result !== undefined) return;
  patch(original, (s) => (s.job === null ? s : { ...s, job: { ...s.job, stopping: true } }));
  if (job.jobId !== undefined) {
    void window.piDesktop.invoke('gen:cancel', { jobId: job.jobId }).catch(() => undefined);
  }
}

export interface EditRequest {
  readonly instruction: string;
  readonly strength: number;
  /** `WxH` — the picture's own shape (image-edit.ts editSize). */
  readonly size: string;
  /** The on-screen box of the picture being edited. */
  readonly box: { readonly aspect: number; readonly width: number; readonly height: number };
}

/** Per-app sequence for request ids, so two edits in one millisecond differ. */
let editSeq = 0;

/**
 * Edit the version on screen. Resolves when the run has ended, however it ended.
 *
 * PROGRESS: main streams `gen:open` / `gen:update` for every job, and the reply
 * to `gen:generate` only comes when the whole run is over. The request carries
 * an id of its own and main echoes it on every event of the job it starts
 * (`GenSurfacePayload.requestId`), so this follows exactly its own stream. The
 * id also keeps the edit OUT of the chat: the thread's live card takes every
 * stream that has no request id as the chat's own job (gen-stream.ts), and an
 * edit running behind the viewer would otherwise have drawn itself there.
 */
export async function runEdit(original: ImageVersion, req: EditRequest): Promise<void> {
  const start = sessionOf(original);
  const from = start.versions[start.index];
  const instruction = req.instruction.trim();
  if (start.job !== null || from === undefined || instruction === '') return;

  editSeq += 1;
  const requestId = `viewer-edit-${Date.now().toString(36)}-${editSeq}`;
  patch(original, (s) => ({
    ...s,
    error: null,
    job: {
      instruction,
      requestId,
      startedAt: Date.now(),
      aspect: req.box.aspect,
      width: req.box.width,
      height: req.box.height,
    },
  }));

  const take = (tabId: string, payload: GenSurfacePayload): void => {
    if (payload.requestId !== requestId) return;
    patch(original, (s) => {
      if (s.job === null) return s;
      const id = jobIdOfTab(tabId);
      return {
        ...s,
        job: {
          ...s.job,
          ...(id !== null ? { jobId: id } : {}),
          ...(payload.progress !== undefined
            ? { step: payload.progress.step, total: payload.progress.total }
            : {}),
          ...(payload.note !== undefined ? { note: payload.note } : {}),
        },
      };
    });
  };
  const offOpen = window.piDesktop.onEvent('gen:open', ({ tabId, payload }) =>
    take(tabId, payload),
  );
  const offUpdate = window.piDesktop.onEvent('gen:update', ({ tabId, payload }) =>
    take(tabId, payload),
  );

  const fail = (why: string): void =>
    patch(original, (s) => ({
      ...s,
      job: null,
      // Stopped on purpose is not a failure worth a red line.
      error: s.job?.stopping === true ? null : why,
    }));

  try {
    const res = await window.piDesktop.invoke('gen:generate', {
      kind: 'image',
      prompt: instruction,
      inputImage: from.path,
      strength: req.strength,
      size: req.size,
      n: 1,
      requestId,
    });
    const out = res.outputs[0];
    if ((res.error !== undefined && res.error !== '') || out === undefined) {
      fail(res.error !== undefined && res.error !== '' ? res.error : 'the edit produced nothing');
      return;
    }
    const made: ImageVersion = {
      path: out.path,
      name: out.path.split('/').pop() ?? out.path,
      label: versionLabel(instruction),
    };
    /*
     * INTO THE HISTORY NOW, onto the stage when the card has shown it. Listed at
     * once so a viewer closed mid-run still finds it on reopening; the stage
     * switches in finishReveal, when the sweep has uncovered the same pixels.
     */
    patch(original, (s) => ({
      ...s,
      versions: [...s.versions, made],
      job: s.job === null ? null : { ...s.job, result: made },
    }));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    offOpen();
    offUpdate();
  }
}
