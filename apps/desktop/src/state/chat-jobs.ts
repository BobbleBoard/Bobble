/**
 * WHICH CHAT STARTED WHICH JOB — so deleting the chat can stop them.
 *
 * the user (2026-09-23): "clicking delete on a chat should instantly terminate any
 * generation of any kind happening". A picture, a clip, a sound, a drawing or
 * a mesh runs in the MAIN process, not in the chat's pi: aborting the chat's
 * turn kills the command that asked for it and leaves the job itself running
 * for minutes, holding the GPU for a chat that no longer exists.
 *
 * Main announces every job an AGENT starts (`gen:agent-job`,
 * `gen3d:agent-job`) — never a studio's — with the asking pi's id. The owner is
 * decided here, the moment the job appears:
 *   - a subagent's job belongs to the chat that owns the subagent;
 *   - the chat's own pi (`agent` absent) is working for exactly one chat at a
 *     time — the one running in the background if there is one, otherwise the
 *     one on screen.
 * A studio job is never announced, so no chat can stop one.
 */
import { useChildAgentStore } from './child-agent-store';
import { usePiStore } from './pi-slice';

export type ChatJobKind = 'gen' | 'gen3d';

export interface ChatJob {
  readonly jobId: string;
  readonly kind: ChatJobKind;
  /** The chat's session file, or null when no chat could be named. */
  readonly owner: string | null;
}

/** Enough to cover every job a session could have in flight; the oldest go first. */
const MAX_TRACKED = 64;

const jobs = new Map<string, ChatJob>();

/** Pure: the chat a job belongs to, from who asked and what was running. */
export function ownerOfJob(input: {
  readonly agent: string | undefined;
  /** The subagent's owning chat, when `agent` names one. */
  readonly childParent: string | undefined;
  readonly bgRun: { readonly sessionFile: string; readonly streaming: boolean } | null;
  readonly viewed: string | null;
}): string | null {
  if (input.agent !== undefined && input.agent !== 'main') return input.childParent ?? null;
  if (input.bgRun?.streaming === true) return input.bgRun.sessionFile;
  return input.viewed;
}

/** Record a job an agent started. Exported for tests; the wire calls it. */
export function noteAgentJob(kind: ChatJobKind, jobId: string, agent: string | undefined): void {
  const pi = usePiStore.getState();
  const owner = ownerOfJob({
    agent,
    childParent:
      agent !== undefined ? useChildAgentStore.getState().children[agent]?.parentId : undefined,
    bgRun: pi.bgRun,
    viewed: pi.session?.sessionFile ?? null,
  });
  jobs.set(jobId, { jobId, kind, owner });
  while (jobs.size > MAX_TRACKED) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

/** A job is over; forget it. */
export function forgetJob(jobId: string): void {
  jobs.delete(jobId);
}

/**
 * Do this job's live frames belong on the chat on screen?
 *
 * Only a job an agent started (a studio's is never announced), and not one a
 * DIFFERENT chat owns — a chat running in the background keeps its own frames.
 * A job no chat could be named for (asked before the chat had a file) gets the
 * benefit of the doubt. PendingMediaCard asks this of every decoded frame,
 * because the stream carries every job's frames at once.
 */
export function showsInViewedChat(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (job === undefined) return false;
  return job.owner === null || job.owner === (usePiStore.getState().session?.sessionFile ?? null);
}

/** Every tracked job owned by one of these chat files. */
export function jobsOwnedBy(files: readonly string[]): ChatJob[] {
  return [...jobs.values()].filter((j) => j.owner !== null && files.includes(j.owner));
}

/**
 * Stop every job these chats started. Cancelling a job that already finished
 * is a no-op on the other side, so nothing here has to know what is still
 * running.
 */
export async function cancelJobsOf(files: readonly string[]): Promise<void> {
  const owned = jobsOwnedBy(files);
  await Promise.all(
    owned.map(async (j) => {
      forgetJob(j.jobId);
      const channel = j.kind === 'gen3d' ? 'gen3d:cancel' : 'gen:cancel';
      await window.piDesktop.invoke(channel, { jobId: j.jobId }).catch(() => undefined);
    }),
  );
}

/** Listen for agent jobs and their ends, for the life of the app. */
export function connectChatJobs(): () => void {
  const bridge = window.piDesktop;
  const offs = [
    bridge.onEvent('gen:agent-job', ({ jobId, agent }) => noteAgentJob('gen', jobId, agent)),
    bridge.onEvent('gen3d:agent-job', ({ jobId, agent }) => noteAgentJob('gen3d', jobId, agent)),
    bridge.onEvent('gen:update', ({ tabId, payload }) => {
      if (payload.status !== 'generating') forgetJob(tabId.replace(/^pi:gen-/, ''));
    }),
    bridge.onEvent('gen3d:job', (u) => {
      if (u.done) forgetJob(u.jobId);
    }),
    // One drawing at a time; when it ends, every drawing id is spent.
    bridge.onEvent('gen:svg-live', (ev) => {
      if (ev.status === 'drawing') return;
      for (const id of [...jobs.keys()]) if (id.startsWith('svg-')) forgetJob(id);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
