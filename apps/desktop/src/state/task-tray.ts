/**
 * THE TASKS YOU LEFT — what the button beside the sidebar toggle lists.
 *
 * The user (2026-09-24): "implement a little notifications button in the top left
 * within the left sidebar or always simply to the right of the collapse
 * sidebar button, this only appears when you leave a running task, eg. chat,
 * generation etc. and clicking on it has a quick little card".
 *
 * WHAT A TASK IS. A chat turn, a studio generation or a 3D studio job. Each
 * belongs to a PLACE — its chat, or its studio — and clicking its row takes you
 * there. One row per place: a chat runs one turn at a time and a studio one
 * job, so a newer run replaces the older row rather than stacking under it.
 *
 * WHEN IT IS LISTED — only while its place is NOT the one on screen:
 *   running / needs input   listed for as long as you are somewhere else. Go
 *                           to it and it leaves the list (you are looking at
 *                           it); leave again and it comes back.
 *   done / failed           listed from the moment it ends somewhere you are
 *                           not, until you open its place or dismiss it. A task
 *                           that ends while you are watching never appears —
 *                           there is no news in something you just saw.
 * So the button exists exactly when this list is not empty.
 *
 * CLEARING. Opening a row's place clears a finished row (seen). The × on a
 * finished row, and "Clear" for all of them, dismiss without opening. A
 * running row has no × — it is not news, it is the way back, and it leaves on
 * its own when the work ends or you go to it. A run the person STOPPED is not
 * news either: stopping is something they did, so it leaves no row.
 *
 * WHAT IS NOT HERE, on purpose:
 *   - A generation an AGENT started. The chat that asked for it is mid-turn
 *     for exactly as long as the picture takes, so that chat's row already
 *     says it — a second row for the same wait would be the "status said
 *     twice" the user's reference card was criticised for.
 *   - Subagents: they ride their parent chat the same way.
 *   - Downloads and model loads: the same card lists them under their own
 *     headers, from their own stores (state/tray-transfers.ts) — they are not
 *     tasks you left, they are the machine working.
 *
 * The rules are pure functions over a small model so they are tested without a
 * window; the zustand store below is only their state. Sources report into it:
 * chats from here (connectTaskTray), studio generations from studio-jobs.ts,
 * 3D jobs from tripo/gen3d-client.ts.
 */

import type { ChatMsg } from '@pi-desktop/engine';
import { create } from 'zustand';
import { describeTurnProblem } from '../chat/turn-problem';
import { isChatDeleted, useDeletedChats } from './deleted-chats';
import { useModalityStore } from './modality-store';
import { usePiStore } from './pi-slice';

/** The studios a task can live in — the modality store's rooms. */
export type TrayStudio = 'image' | 'video' | 'audio' | '3d';

/** Where a task lives: what clicking its row opens. */
export type TaskPlace =
  | { readonly kind: 'chat'; readonly sessionFile: string }
  | { readonly kind: 'studio'; readonly modality: TrayStudio };

export type TaskState = 'running' | 'needs-input' | 'done' | 'failed';

export interface TrayTask {
  /** One per place — see {@link placeKey}. */
  readonly key: string;
  readonly place: TaskPlace;
  /** The chat's title, or what the studio was asked for. */
  readonly title: string;
  readonly state: TaskState;
  /** Wall clock, ms. */
  readonly startedAt: number;
  /** Wall clock, ms — set once the task has ended. */
  readonly endedAt?: number;
  /** Why it failed, in the engine's words, when it did. */
  readonly error?: string;
}

/** What is on screen right now. */
export type Surface =
  | { readonly kind: 'chat'; readonly sessionFile: string | null }
  | { readonly kind: 'studio'; readonly modality: TrayStudio }
  /** The model hub, Scheduled, Extensions — no task lives there. */
  | { readonly kind: 'elsewhere' };

export interface TrayModel {
  /** What each source says is happening now (running / needs input), by key. */
  readonly live: Readonly<Record<string, TrayTask>>;
  /** What ended while its place was off screen and has not been seen since. */
  readonly ended: Readonly<Record<string, TrayTask>>;
  readonly surface: Surface;
}

export function placeKey(place: TaskPlace): string {
  return place.kind === 'chat' ? `chat:${place.sessionFile}` : `studio:${place.modality}`;
}

/** Is this task's place the thing on screen? */
export function isOnScreen(place: TaskPlace, surface: Surface): boolean {
  if (place.kind === 'chat') {
    return surface.kind === 'chat' && surface.sessionFile === place.sessionFile;
  }
  return surface.kind === 'studio' && surface.modality === place.modality;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (record[key] === undefined) return record as Record<string, T>;
  const next = { ...record };
  delete next[key];
  return next;
}

/** A source says this is happening now. A newer run replaces older news. */
export function tracked(m: TrayModel, task: TrayTask): TrayModel {
  return { ...m, live: { ...m.live, [task.key]: task }, ended: without(m.ended, task.key) };
}

/** A source says it stopped with nothing to report (the person stopped it). */
export function untracked(m: TrayModel, key: string): TrayModel {
  return { ...m, live: without(m.live, key) };
}

/**
 * A source says it ended. Kept as news only if nobody was watching it end —
 * the SAME rule whether or not it was ever tracked while live, so a job that
 * starts and fails between two looks is still reported.
 */
export function settled(m: TrayModel, task: TrayTask): TrayModel {
  const live = without(m.live, task.key);
  if (isOnScreen(task.place, m.surface)) return { ...m, live, ended: without(m.ended, task.key) };
  return { ...m, live, ended: { ...m.ended, [task.key]: task } };
}

/** What is on screen changed: a finished row whose place is now in view has been seen. */
export function resurfaced(m: TrayModel, surface: Surface): TrayModel {
  let ended = m.ended;
  for (const task of Object.values(m.ended)) {
    if (isOnScreen(task.place, surface)) ended = without(ended, task.key);
  }
  return { ...m, surface, ended };
}

/** Dismiss finished rows without opening them — one, or all of them. */
export function dismissed(m: TrayModel, key: string | 'all'): TrayModel {
  return { ...m, ended: key === 'all' ? {} : without(m.ended, key) };
}

const ORDER: Record<TaskState, number> = { 'needs-input': 0, running: 1, failed: 2, done: 2 };

/**
 * The rows, in the order the card shows them: what is waiting on you, then what
 * is still going (newest first), then what finished (most recent first). A
 * place with both a live run and old news shows only the live one.
 */
export function trayRows(m: TrayModel): TrayTask[] {
  const rows = new Map<string, TrayTask>();
  for (const t of Object.values(m.ended)) rows.set(t.key, t);
  for (const t of Object.values(m.live)) rows.set(t.key, t);
  return [...rows.values()]
    .filter((t) => !isOnScreen(t.place, m.surface))
    .sort((a, b) => {
      const byState = ORDER[a.state] - ORDER[b.state];
      if (byState !== 0) return byState;
      const at = (t: TrayTask) => t.endedAt ?? t.startedAt;
      return at(b) - at(a);
    });
}

/**
 * The button's one mark: the most urgent thing in the list. Needs-input beats
 * failed beats done; a list that is only running has no mark — the button
 * being there at all already says "something you left is still going".
 */
export function trayTone(rows: readonly TrayTask[]): 'needs-input' | 'failed' | 'done' | null {
  if (rows.some((r) => r.state === 'needs-input')) return 'needs-input';
  if (rows.some((r) => r.state === 'failed')) return 'failed';
  if (rows.some((r) => r.state === 'done')) return 'done';
  return null;
}

/* ── chats ──────────────────────────────────────────────────────────────── */

/** What the tray needs to know about the chats, as plain data. */
export interface ChatSnapshot {
  readonly bgRun: {
    readonly sessionFile: string;
    readonly streaming: boolean;
    readonly title: string | null;
    readonly messages: readonly ChatMsg[];
  } | null;
  readonly viewedFile: string | null;
  readonly viewedTitle: string | null;
  readonly viewedMessages: readonly ChatMsg[];
  /** The viewed chat's own turn is in flight (streaming, dispatching, resuming). */
  readonly viewedBusy: boolean;
  /** Chats with a question waiting on the person (a pending ask_user). */
  readonly asking: readonly string[];
}

export interface LiveChat {
  readonly file: string;
  readonly title: string;
  readonly needsInput: boolean;
  /** When the turn began — its last user message — when the thread says. */
  readonly startedAt?: number;
}

/** When the running turn began: the last thing the person sent. */
export function turnStart(messages: readonly ChatMsg[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === 'user') return m.timestamp;
  }
  return undefined;
}

function titleOr(title: string | null, fallback: string): string {
  return title !== null && title.trim().length > 0 ? title.trim() : fallback;
}

/**
 * The chats with a turn in flight: the one running in the BACKGROUND (you
 * switched away from it mid-reply) and the viewed one — which is "left" too
 * whenever a studio or another screen is covering it. At most one of each:
 * the app runs one pi, so the viewed chat cannot stream while another does.
 */
export function liveChats(s: ChatSnapshot): LiveChat[] {
  const out: LiveChat[] = [];
  const asking = new Set(s.asking);
  if (s.bgRun?.streaming === true) {
    const started = turnStart(s.bgRun.messages);
    out.push({
      file: s.bgRun.sessionFile,
      title: titleOr(s.bgRun.title, 'New chat'),
      needsInput: asking.has(s.bgRun.sessionFile),
      ...(started !== undefined ? { startedAt: started } : {}),
    });
  } else if (s.viewedBusy && s.viewedFile !== null) {
    const started = turnStart(s.viewedMessages);
    out.push({
      file: s.viewedFile,
      title: titleOr(s.viewedTitle, 'New chat'),
      needsInput: asking.has(s.viewedFile),
      ...(started !== undefined ? { startedAt: started } : {}),
    });
  }
  return out;
}

/**
 * How a chat's turn ended, read off its last reply. `stopped` is a turn the
 * person aborted (Stop, a delete, a switch that disposed it): something they
 * did, so it leaves no row.
 */
export function chatOutcome(
  messages: readonly ChatMsg[],
): { readonly state: 'done' | 'failed'; readonly error?: string } | 'stopped' {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === 'user') break;
    if (m?.kind !== 'assistant') continue;
    if (m.stopReason === 'aborted') return 'stopped';
    if (m.stopReason === 'error' || (m.errorMessage !== undefined && m.errorMessage !== '')) {
      // What happened in words (turn-problem.ts), not the engine's raw line.
      const said = describeTurnProblem(m.errorMessage)?.title;
      return { state: 'failed', ...(said !== undefined ? { error: said } : {}) };
    }
    return { state: 'done' };
  }
  return { state: 'done' };
}

/* ── the store ──────────────────────────────────────────────────────────── */

interface TaskTrayState extends TrayModel {
  /**
   * A content route (a studio, the model hub, Scheduled, Extensions) is drawn
   * where the chat would be. Published by ChatApp, which is the one component
   * that knows whether its content slot is overridden.
   */
  readonly covered: boolean;
  readonly track: (task: TrayTask) => void;
  readonly untrack: (key: string) => void;
  readonly settle: (task: TrayTask) => void;
  readonly setSurface: (surface: Surface) => void;
  readonly setCovered: (covered: boolean) => void;
  readonly dismiss: (key: string) => void;
  readonly clearFinished: () => void;
}

/** A model-level update that leaves the store untouched when nothing changed. */
const apply =
  (fn: (m: TrayModel) => TrayModel) =>
  (s: TaskTrayState): Partial<TaskTrayState> => {
    const next = fn(s);
    return next.live === s.live && next.ended === s.ended && next.surface === s.surface
      ? {}
      : { live: next.live, ended: next.ended, surface: next.surface };
  };

function sameSurface(a: Surface, b: Surface): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'chat' && b.kind === 'chat') return a.sessionFile === b.sessionFile;
  if (a.kind === 'studio' && b.kind === 'studio') return a.modality === b.modality;
  return true;
}

export const useTaskTray = create<TaskTrayState>((set) => ({
  live: {},
  ended: {},
  surface: { kind: 'chat', sessionFile: null },
  covered: false,
  track: (task) => set(apply((m) => tracked(m, task))),
  untrack: (key) => set(apply((m) => untracked(m, key))),
  settle: (task) => set(apply((m) => settled(m, task))),
  setSurface: (surface) =>
    set((s) => (sameSurface(s.surface, surface) ? {} : apply((m) => resurfaced(m, surface))(s))),
  setCovered: (covered) => set((s) => (s.covered === covered ? {} : { covered })),
  dismiss: (key) => set(apply((m) => dismissed(m, key))),
  clearFinished: () => set(apply((m) => dismissed(m, 'all'))),
}));

/** What is on screen, from the three facts that decide it. */
export function surfaceOf(input: {
  readonly modality: 'chat' | TrayStudio;
  readonly covered: boolean;
  readonly viewedFile: string | null;
}): Surface {
  if (input.modality !== 'chat') return { kind: 'studio', modality: input.modality };
  if (input.covered) return { kind: 'elsewhere' };
  return { kind: 'chat', sessionFile: input.viewedFile };
}

function chatSnapshot(): ChatSnapshot {
  const pi = usePiStore.getState();
  return {
    bgRun: pi.bgRun,
    viewedFile: pi.session?.sessionFile ?? null,
    viewedTitle: pi.windowTitle,
    viewedMessages: pi.messages,
    viewedBusy: pi.agent.isStreaming || pi.promptInFlight || pi.resuming,
    asking: pi.uiRequests
      .map((r) => r.sessionFile)
      .filter((f): f is string => typeof f === 'string'),
  };
}

/** The thread a chat's turn ran in, wherever it is being held right now. */
function threadOf(file: string): readonly ChatMsg[] {
  const pi = usePiStore.getState();
  if (pi.bgRun?.sessionFile === file) return pi.bgRun.messages;
  if (pi.session?.sessionFile === file) return pi.messages;
  return [];
}

let connected = false;

/**
 * Follow the chats and what is on screen for the life of the app. Studio and
 * 3D jobs report themselves (studio-jobs.ts, tripo/gen3d-client.ts).
 *
 * Re-derived on a MICROTASK after any change rather than on every store write:
 * a chat switch is several synchronous writes (the thread swaps, then the
 * background slot clears, then the view pointer moves), and a read between two
 * of them saw a running chat vanish — which would have been filed as "done"
 * for a frame before it came back as running.
 */
export function connectTaskTray(): () => void {
  if (connected) return () => undefined;
  connected = true;
  const tray = () => useTaskTray.getState();
  /* The chat rows tracked last time, so an ending can be told from a change. */
  const tracking = new Map<string, TrayTask>();

  const syncChats = (): void => {
    const now = Date.now();
    const next = liveChats(chatSnapshot()).filter((c) => !isChatDeleted(c.file));
    const seen = new Set<string>();
    for (const c of next) {
      const place: TaskPlace = { kind: 'chat', sessionFile: c.file };
      const key = placeKey(place);
      seen.add(key);
      const prev = tracking.get(key);
      const task: TrayTask = {
        key,
        place,
        title: c.title,
        state: c.needsInput ? 'needs-input' : 'running',
        startedAt: c.startedAt ?? prev?.startedAt ?? now,
      };
      if (
        prev === undefined ||
        prev.title !== task.title ||
        prev.state !== task.state ||
        prev.startedAt !== task.startedAt
      ) {
        tracking.set(key, task);
        tray().track(task);
      }
    }
    for (const [key, prev] of tracking) {
      if (seen.has(key)) continue;
      tracking.delete(key);
      const file = prev.place.kind === 'chat' ? prev.place.sessionFile : '';
      if (isChatDeleted(file)) {
        tray().untrack(key);
        tray().dismiss(key);
        continue;
      }
      const outcome = chatOutcome(threadOf(file));
      if (outcome === 'stopped') tray().untrack(key);
      else {
        tray().settle({
          ...prev,
          state: outcome.state,
          endedAt: now,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        });
      }
    }
  };

  const syncSurface = (): void => {
    const s = tray();
    s.setSurface(
      surfaceOf({
        modality: useModalityStore.getState().view,
        covered: s.covered,
        viewedFile: usePiStore.getState().session?.sessionFile ?? null,
      }),
    );
  };

  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // Surface first: a chat that ends in the same breath as you arrive in it
      // has been watched, not missed.
      syncSurface();
      syncChats();
    });
  };

  const offs = [
    usePiStore.subscribe(schedule),
    useModalityStore.subscribe(schedule),
    useTaskTray.subscribe((s, prev) => {
      if (s.covered !== prev.covered) schedule();
    }),
    /* A chat deleted this run takes its row with it, running or finished. */
    useDeletedChats.subscribe(() => {
      for (const task of [...Object.values(tray().live), ...Object.values(tray().ended)]) {
        if (task.place.kind === 'chat' && isChatDeleted(task.place.sessionFile)) {
          tray().untrack(task.key);
          tray().dismiss(task.key);
        }
      }
    }),
  ];
  schedule();
  return () => {
    for (const off of offs) off();
    connected = false;
  };
}

/*
 * E2E hook, on the same `?piE2E` opt-in the other stores use: a probe can read
 * the tray, and put a finished task in it, without a real run behind it.
 */
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __task_tray?: () => typeof useTaskTray }).__task_tray = () => useTaskTray;
}
