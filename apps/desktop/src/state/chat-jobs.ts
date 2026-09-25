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
 *
 * A PRODUCTION is one of these jobs too: the CEO's `talk_to_manager` makes main
 * start a team (`corp:attached`), and the team works for the chat whose pi
 * asked. The corp store's team pointer is no guide to that — every chat switch
 * drops it, and the situation room binds it to whichever chat is on screen.
 */
import { useChildAgentStore } from './child-agent-store';
import { isChatDeleted } from './deleted-chats';
import { usePiStore } from './pi-slice';

export type ChatJobKind = 'gen' | 'gen3d' | 'corp';

export interface ChatJob {
  readonly jobId: string;
  readonly kind: ChatJobKind;
  /** The chat's session file, or null when no chat could be named. */
  readonly owner: string | null;
}

/** Enough to cover every job a session could have in flight; the oldest go first. */
const MAX_TRACKED = 64;

const jobs = new Map<string, ChatJob>();

/** The subagents of chats deleted this run — see {@link noteAgentJob}. */
const orphanedAgents = new Set<string>();

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
  /*
   * ANNOUNCED TOO LATE TO BE CAUGHT. A delete reads the jobs its chat owns
   * once, and a job can get its id after that: a mesh or a picture waits up to
   * 20 s for memory, or for a cold engine, before it has one. One that turns
   * up for a chat already deleted — or from a deleted chat's subagent, which
   * the child store no longer knows — is stopped the moment it appears.
   */
  if (isChatDeleted(owner) || (agent !== undefined && orphanedAgents.has(agent))) {
    void cancelJob({ jobId, kind, owner });
    return;
  }
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

/** The chat a tracked job belongs to — null when none could be named. */
export function ownerOfTrackedJob(jobId: string): string | null {
  return jobs.get(jobId)?.owner ?? null;
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
  // Its subagents are removed next; a job one announces later still stops.
  for (const c of Object.values(useChildAgentStore.getState().children)) {
    if (files.includes(c.parentId)) orphanedAgents.add(c.childId);
  }
  const owned = jobsOwnedBy(files);
  await Promise.all(
    owned.map(async (j) => {
      forgetJob(j.jobId);
      await cancelJob(j);
    }),
  );
}

async function cancelJob(j: ChatJob): Promise<void> {
  if (j.kind === 'corp') {
    await window.piDesktop.invoke('corp:abort', { taskId: j.jobId }).catch(() => undefined);
    return;
  }
  const channel = j.kind === 'gen3d' ? 'gen3d:cancel' : 'gen:cancel';
  await window.piDesktop.invoke(channel, { jobId: j.jobId }).catch(() => undefined);
}

/** Listen for agent jobs and their ends, for the life of the app. */
export function connectChatJobs(): () => void {
  const bridge = window.piDesktop;
  const offs = [
    bridge.onEvent('gen:agent-job', ({ jobId, agent }) => noteAgentJob('gen', jobId, agent)),
    bridge.onEvent('gen3d:agent-job', ({ jobId, agent }) => noteAgentJob('gen3d', jobId, agent)),
    // Subscribed before the app mounts, so the owner is known by the time the
    // situation room binds to the run (ChatApp nests its roles under it). Its
    // end is seen by corp-connect, which owns `corp:event` (see connectCorp).
    bridge.onEvent('corp:attached', ({ taskId }) => noteAgentJob('corp', taskId, undefined)),
    bridge.onEvent('gen:update', ({ tabId, payload }) => {
      if (payload.status !== 'generating') forgetJob(tabId.replace(/^pi:gen-/, ''));
    }),
    bridge.onEvent('gen3d:job', (u) => {
      if (u.done) forgetJob(u.jobId);
    }),
    // Nothing serialises OmniSVG — the chat's pi and a subagent can each be
    // drawing — so a drawing's end spends that drawing's id and no other.
    bridge.onEvent('gen:svg-live', (ev) => {
      if (ev.status !== 'drawing' && ev.jobId !== undefined) forgetJob(ev.jobId);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
