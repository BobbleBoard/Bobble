/**
 * Renderer ↔ main bridge for the EXPERIMENTAL coordination harness (CorpEngine).
 * The engine runs in the main process; the renderer drives it over the `corp:*`
 * IPC channels and reconstructs a per-task `AsyncIterable<CoordinationEvent>` from
 * the `corp:event` stream (the situation room folds it). Gated behind the
 * production-harness flag — nothing here runs unless the flag / env override is on.
 *
 * A single module-level subscription buffers `corp:event`s by taskId, so events
 * that race ahead of `corp:start`'s response are never lost: a fresh consumer
 * flushes the buffer, then tails live events to the terminal `done`.
 */

import type {
  CoordinationEvent,
  OrgChartView,
  ProductPeek,
  TaskContext,
  WorkerTranscriptView,
} from '@pi-desktop/coordination';
import { resolveEffort } from './model-selection';
import { conversationId as piConversationId, resolvedWorkspace } from './pi-connect';
import { usePiStore } from './pi-slice';
import { useProjectStore } from './project-store';
import { useSettingsStore } from './settings-store';

/** A minimal single-consumer async iterable the situation room drains. */
class PushStream<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Per-task inbox: events queued (pre-attach) or forwarded to a live stream. */
interface TaskInbox {
  queue: CoordinationEvent[];
  stream: PushStream<CoordinationEvent> | null;
  ended: boolean;
}

const inboxes = new Map<string, TaskInbox>();
let connected = false;

function inboxFor(taskId: string): TaskInbox {
  let inbox = inboxes.get(taskId);
  if (inbox === undefined) {
    inbox = { queue: [], stream: null, ended: false };
    inboxes.set(taskId, inbox);
  }
  return inbox;
}

/** Install the single `corp:event` subscription. Idempotent; call once at boot. */
export function connectCorp(): void {
  if (connected) return;
  connected = true;
  window.piDesktop.onEvent('corp:event', ({ taskId, event }) => {
    const inbox = inboxFor(taskId);
    if (inbox.stream !== null) {
      inbox.stream.push(event);
      if (event.type === 'done') {
        inbox.stream.end();
        inboxes.delete(taskId);
      }
    } else {
      inbox.queue.push(event);
      if (event.type === 'done') inbox.ended = true;
    }
  });
}

/** A live handle the situation room consumes (same shape as `TaskHandle`). */
export interface CorpTaskHandle {
  readonly taskId: string;
  readonly events: AsyncIterable<CoordinationEvent>;
}

/**
 * Start a coordination task in main and return a handle whose `events` replays any
 * buffered events then tails live ones to `done`. Wrap in `replayableEvents()`
 * before handing to the situation tab so a tab-switch remount rebuilds instantly.
 */
export async function startCorpTask(prompt: string, ctx?: TaskContext): Promise<CorpTaskHandle> {
  connectCorp();
  // The EFFECTIVE effort for this task — the slider level, or in Adaptive the
  // level the classifier resolved for the message. The harness gates the
  // corporation on it (only 'high'/'max' offer create_production_hierarchy;
  // lower levels run a single solo agent).
  const effort = resolveEffort(useSettingsStore.getState().settings);
  /*
   * THE CORP WORKS IN THE CHAT'S OWN PROJECT.
   *
   * This passed only what the caller handed it — images, and nothing else — so
   * `ctx.cwd` was always undefined and every corp run landed in a throwaway
   * directory under the OS temp dir. The whole point of a persistent team is that
   * it belongs to a project and is still there next week; a team keyed to a
   * folder that never existed before cannot be.
   *
   * Found by driving the real app instead of the harness: the e2e driver builds
   * the mesh directly and never touches this path, so it looked healthy while the
   * product was writing everything to /var/folders.
   */
  /*
   * THE DROPDOWN, VERBATIM. the user: "if they have a project selected that dropdown
   * right there is the end all be all, everything is THAT DROPDOWN'S SELECTION.
   * always always always nothing competes with that."
   *
   * `activePath` IS that selection. "No project" is null, and main turns that
   * into ~/Bobble/<conversation name> — named, so the user can find it in Finder
   * instead of hunting an opaque sandbox id.
   */
  /*
   * USE THE WORKSPACE THE CHAT ALREADY RESOLVED. Re-resolving here produced a
   * SECOND folder: the corp had only `windowTitle` (absent on a first turn) so it
   * chose `~/Bobble/new-chat`, while the chat had already named itself from the
   * first message. One chat, two directories, work split across them. MEASURED
   * live: `new-chat/.scratch` alongside `ask-the-manager-to-research-how/`.
   */
  const resolved = resolvedWorkspace();
  const activePath = resolved ?? useProjectStore.getState().activePath;
  const conversationName = usePiStore.getState().windowTitle ?? 'new chat';
  const withCwd: TaskContext = {
    ...(ctx ?? {}),
    ...(activePath !== null && activePath !== '' ? { cwd: activePath } : {}),
    conversationName,
    conversationId: piConversationId(),
  };
  const { taskId } = await window.piDesktop.invoke('corp:start', {
    prompt,
    ctx: withCwd,
    effort,
  });
  return attachCorpTask(taskId);
}

/**
 * Bind to a run that ALREADY EXISTS, without starting one.
 *
 * `talk_to_manager` blocks the CEO until the team delivers, so main starts that
 * run itself and announces it on `corp:attached` — the situation room has to join
 * a production already under way rather than kicking off a second one. The
 * per-task inbox has been buffering its events since the first one arrived, so
 * nothing is missed by joining late.
 */
export function attachCorpTask(taskId: string): CorpTaskHandle {
  connectCorp();
  const inbox = inboxFor(taskId);
  const stream = new PushStream<CoordinationEvent>();
  // Flush anything that raced ahead of this response, then attach for live tail.
  for (const event of inbox.queue) stream.push(event);
  inbox.queue = [];
  if (inbox.ended) {
    stream.end();
    inboxes.delete(taskId);
  } else {
    inbox.stream = stream;
  }
  return { taskId, events: stream };
}

/** Stop a running corp task (its stream ends with an aborted `done`). */
export async function abortCorpTask(taskId: string): Promise<void> {
  await window.piDesktop.invoke('corp:abort', { taskId }).catch(() => undefined);
}

/** Mid-run steering to the lead. Fire-and-forget. */
export async function steerCorpTask(taskId: string, text: string): Promise<void> {
  await window.piDesktop.invoke('corp:steer', { taskId, text }).catch(() => undefined);
}

/** A follow-up question ANSWERED by the CEO from its retained context (A1/A4) — not a
 * new run. Returns the CEO's reply (an honest fallback line on any error). */
export async function askCorpTask(taskId: string, question: string): Promise<string> {
  return window.piDesktop
    .invoke('corp:ask', { taskId, question })
    .then((r) => r.answer)
    .catch(() => 'I hit a snag answering that — give me a moment and try again.');
}

/** Answer a surfaced permission request. */
export async function respondCorpPermission(
  taskId: string,
  requestId: string,
  granted: boolean,
): Promise<void> {
  await window.piDesktop
    .invoke('corp:respond-permission', { taskId, requestId, granted })
    .catch(() => undefined);
}

/** A synchronous-ish org-chart snapshot (situation-room bootstrap). */
export async function getCorpOrgChart(taskId: string): Promise<OrgChartView | null> {
  const res = await window.piDesktop
    .invoke('corp:get-org-chart', { taskId })
    .catch(() => ({ chart: null }));
  return res.chart;
}

/** The REAL captured turn stream for one node (the click-through), or null. */
export async function fetchWorkerTranscript(
  taskId: string,
  nodeId: string,
): Promise<WorkerTranscriptView | null> {
  const res = await window.piDesktop
    .invoke('corp:worker-transcript', { taskId, nodeId })
    .catch(() => ({ transcript: null }));
  return res.transcript;
}

/** "Peek at what we have so far" — a live snapshot of the in-progress product tree
 * (real files), or null when the task is unknown/ended. */
export async function peekCorpTask(taskId: string): Promise<ProductPeek | null> {
  const res = await window.piDesktop.invoke('corp:peek', { taskId }).catch(() => ({ peek: null }));
  return res.peek;
}
