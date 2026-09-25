/**
 * A STUDIO'S RUNNING JOB, KEPT OUTSIDE THE ROOM — the other half of
 * studio-runs.ts, which already did this for the finished results.
 *
 * the user (2026-09-24): "leaving a studio with a generation running and then going
 * back doesn't keep it going, or maybe it does but the UI resets".
 *
 * It was the UI. The job runs in MAIN (gen-manager's queue) and nothing ever
 * stopped it. But everything the room knew about it — that it was busy, the
 * card, the step count, the id Stop needs, the error — was `useState` inside
 * the room, and App renders a studio INSTEAD of the chat, so leaving unmounted
 * the room and all of it with it. MEASURED (studio-leave-return-probe, on the
 * build before this): back in the room mid-job, the empty "Make pictures on
 * this machine" state with a live Generate button over a GPU still busy with
 * the last one; and a picture that finished while you were out never reached
 * the list at all — it sat in a ref of the unmounted room, waiting for a reveal
 * that room could no longer play.
 *
 * So the job lives here, one slot per room, for the life of the app:
 *   - the room is a VIEW of its slot: leave and come back and the same card is
 *     there, still counting, with Stop where Stop was;
 *   - the job's events find it by the request id main echoes on every event
 *     (GenSurfacePayload.requestId) — no longer "the first stream to open while
 *     I was busy", which only worked from inside a mounted room and could claim
 *     a chat's picture that opened in the same second;
 *   - a result that lands while the room is open is HELD for the card's
 *     reveal, as before (the card uncovers it, then it is filed); one that lands
 *     while you are away goes straight into the list, because there is nobody
 *     to play the reveal to;
 *   - an error stays until the next run or the room is dismissed, so a job that
 *     failed while you were out says so when you come back.
 *
 * It also tells the task tray (task-tray.ts) what each room is doing, which is
 * how a generation you walked away from shows up beside the sidebar toggle.
 */
import { create } from 'zustand';
import type { GenInvokeMap, GenSurfacePayload } from '../../electron/gen/gen-ipc-contract';
import { jobIdFromTab, latestPreview } from '../chat/gen-stream';
import type { MediaKind } from '../chat/thread-media';
import type { StudioJobState, StudioRun } from '../studio/use-studio';
import { type StudioModality, useStudioRuns } from './studio-runs';
import { placeKey, type TaskPlace, type TrayTask, useTaskTray } from './task-tray';

/** What a room asks for — everything but the id, which is ours to give. */
export type StudioRequest = Omit<GenInvokeMap['gen:generate']['request'], 'requestId'>;

export interface StudioSlot {
  /** The job on screen: running, or holding its result while the card uncovers it. */
  readonly job: StudioJobState | null;
  /** A run is in flight — the button is Stop (or Working…), not Generate. */
  readonly busy: boolean;
  /** Why the last run produced nothing, until the next run or a dismissal. */
  readonly error: string | null;
}

const IDLE: StudioSlot = { job: null, busy: false, error: null };

interface StudioJobsState {
  readonly slots: Readonly<Record<StudioModality, StudioSlot>>;
}

export const useStudioJobs = create<StudioJobsState>(() => ({
  slots: { image: IDLE, video: IDLE, audio: IDLE },
}));

function patch(modality: StudioModality, change: Partial<StudioSlot>): void {
  useStudioJobs.setState((s) => ({
    slots: { ...s.slots, [modality]: { ...s.slots[modality], ...change } },
  }));
}

/** The bookkeeping nothing renders from. */
interface Flight {
  readonly requestId: string;
  readonly prompt: string;
  readonly startedAt: number;
  /** The engine's job id, once its first event names it — what Stop sends. */
  jobId: string | null;
  /** The finished run, between the bytes existing and the card having shown them. */
  held: StudioRun | null;
  /** The person pressed Stop: however it ends, it is not news for the tray. */
  stopping: boolean;
}

const flights = new Map<StudioModality, Flight>();
/** How many of each room are mounted (StrictMode mounts twice). */
const rooms: Record<StudioModality, number> = { image: 0, video: 0, audio: 0 };
let seq = 0;

/** Extension → the kind a result renders as. */
export function kindOf(path: string): MediaKind {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (['glb', 'gltf', 'obj', 'ply', 'stl'].includes(ext)) return 'model';
  return 'image';
}

function placeOf(modality: StudioModality): TaskPlace {
  return { kind: 'studio', modality };
}

function trayTask(modality: StudioModality, flight: Flight): TrayTask {
  const place = placeOf(modality);
  return {
    key: placeKey(place),
    place,
    title: flight.prompt,
    state: 'running',
    startedAt: flight.startedAt,
  };
}

/** File a result the card was uncovering, and take the card down. */
function fileHeld(modality: StudioModality): void {
  const flight = flights.get(modality);
  if (flight === undefined || flight.held === null) return;
  useStudioRuns.getState().add(modality, flight.held);
  flights.delete(modality);
  patch(modality, { job: null });
}

/**
 * Start a generation for a room. Resolves when it has finished one way or the
 * other; the room reads the outcome from its slot, never from this promise —
 * which is what lets the room be gone by then.
 */
export async function runStudioJob(modality: StudioModality, req: StudioRequest): Promise<void> {
  const current = flights.get(modality);
  if (current !== undefined) {
    // One job per room: while it runs, the room's button is Stop.
    if (current.held === null) return;
    // A new run while the last one is still being uncovered keeps the last one.
    fileHeld(modality);
  }
  seq += 1;
  const flight: Flight = {
    requestId: `studio-${modality}-${Date.now().toString(36)}-${seq}`,
    prompt: req.prompt,
    startedAt: Date.now(),
    jobId: null,
    held: null,
    stopping: false,
  };
  flights.set(modality, flight);
  patch(modality, {
    busy: true,
    error: null,
    job: {
      prompt: req.prompt,
      startedAt: flight.startedAt,
      cancellable: false,
      ...(req.size !== undefined ? { size: req.size } : {}),
    },
  });
  const tray = useTaskTray.getState();
  const task = trayTask(modality, flight);
  tray.track(task);

  let failure = 'the generator produced nothing';
  try {
    const res = await window.piDesktop.invoke('gen:generate', {
      ...req,
      requestId: flight.requestId,
    });
    if (res.error !== undefined && res.error !== '') {
      failure = res.error;
    } else if (res.outputs.length > 0) {
      const first = res.outputs[0];
      const run: StudioRun = {
        prompt: req.prompt,
        at: Date.now(),
        ...(first?.seed !== undefined ? { seed: first.seed } : {}),
        ...(first?.model !== undefined ? { model: first.model } : {}),
        items: res.outputs.map((o) => ({
          path: o.path,
          kind: kindOf(o.path),
          name: o.path.split('/').pop() ?? o.path,
        })),
      };
      useTaskTray.getState().settle({ ...task, state: 'done', endedAt: run.at });
      if (flights.get(modality) !== flight) return;
      if (rooms[modality] > 0) {
        /*
         * HELD, NOT FILED. The room is open, and its card uncovers the result
         * from under the sweep before `finishStudioReveal` files it — filing now
         * would put the finished card in the list while the pending card above
         * it is still showing the same picture coming out: the same result
         * twice, a second apart.
         */
        flight.held = run;
        const job = useStudioJobs.getState().slots[modality].job;
        patch(modality, { busy: false, job: job === null ? null : { ...job, items: run.items } });
      } else {
        // Nobody to uncover it for: into the list, where the room will look.
        useStudioRuns.getState().add(modality, run);
        flights.delete(modality);
        patch(modality, { busy: false, job: null });
      }
      return;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  if (flights.get(modality) === flight) {
    flights.delete(modality);
    // A run that produced nothing has nothing to uncover, so its card goes now.
    patch(modality, { busy: false, job: null, error: failure });
  }
  if (flight.stopping) useTaskTray.getState().untrack(task.key);
  else
    useTaskTray
      .getState()
      .settle({ ...task, state: 'failed', endedAt: Date.now(), error: failure });
}

/** Stop the room's job. Only possible once its first event has named it. */
export function cancelStudioJob(modality: StudioModality): void {
  const flight = flights.get(modality);
  if (flight === undefined || flight.jobId === null) return;
  flight.stopping = true;
  void window.piDesktop.invoke('gen:cancel', { jobId: flight.jobId }).catch(() => undefined);
}

/** The card has finished uncovering the result: file it and take the card down. */
export function finishStudioReveal(modality: StudioModality): void {
  fileHeld(modality);
}

export function clearStudioError(modality: StudioModality): void {
  patch(modality, { error: null });
}

/**
 * A room is on screen. Returns its unmount. Leaving mid-reveal files the result
 * at once — it is on disk and it is the whole point of the run; the reveal was
 * only ever the manner of showing it.
 */
export function studioRoomOpened(modality: StudioModality): () => void {
  rooms[modality] += 1;
  return () => {
    rooms[modality] = Math.max(0, rooms[modality] - 1);
    if (rooms[modality] === 0) fileHeld(modality);
  };
}

/** One event of a studio job → the room's card. */
function follow(tabId: string, payload: GenSurfacePayload): void {
  const id = payload.requestId;
  if (id === undefined) return;
  for (const [modality, flight] of flights) {
    if (flight.requestId !== id) continue;
    flight.jobId = jobIdFromTab(tabId);
    // Already uncovering the result: the trailing events have nothing to add.
    if (flight.held !== null) return;
    const job = useStudioJobs.getState().slots[modality].job;
    if (job === null) return;
    const preview = latestPreview(payload);
    patch(modality, {
      job: {
        ...job,
        ...(payload.progress !== undefined
          ? { step: payload.progress.step, total: payload.progress.total }
          : {}),
        ...(preview !== undefined ? { previewSrc: preview } : {}),
        ...(payload.note !== undefined ? { note: payload.note } : {}),
        cancellable: true,
      },
    });
    return;
  }
}

let connected = false;

/**
 * Follow studio jobs for the life of the app — wired at boot beside the other
 * stores, so it is listening whichever screen is up when a job reports.
 */
export function connectStudioJobs(): () => void {
  if (connected) return () => undefined;
  connected = true;
  const bridge = window.piDesktop;
  const offs = [
    bridge.onEvent('gen:open', ({ tabId, payload }) => follow(tabId, payload)),
    bridge.onEvent('gen:update', ({ tabId, payload }) => follow(tabId, payload)),
  ];
  return () => {
    for (const off of offs) off();
    connected = false;
  };
}

/*
 * E2E hook, on the same `?piE2E` opt-in the other stores use: a probe can read
 * a room's slot while the room is not on screen.
 */
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __studio_jobs?: () => typeof useStudioJobs }).__studio_jobs = () =>
    useStudioJobs;
}
