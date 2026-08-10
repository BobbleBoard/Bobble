/**
 * Run a corp task as an AGENT MESH and emit the SAME {@link CoordinationEvent} stream
 * the situation room already renders — so the emergent multi-agent build shows up live
 * (the org chart, each agent's streaming feed, the terminal verdict) with no UI change.
 *
 * This is the app-facing wiring for the mesh (the user's "everyone is an agent"): it stands
 * up the roster as an org chart, runs {@link runCorpMeshTask} with the persistent
 * session host, maps each agent's {@link RoleAgentActivity} onto `worker-activity`
 * events (nodeId = the agent), and closes with a `done`. It reuses the EXACT event
 * shapes the CorpEngine emits (mapRoleActivity), re-implemented here because those
 * helpers are engine-private. Gated behind an env flag in corp-main so it is fully
 * additive — the deterministic path is untouched.
 */

import type {
  CoordinationEvent,
  OrgChartView,
  OrgNodeView,
  TaskHandle,
  TaskResult,
} from '@pi-desktop/coordination';
import { buildCorpRoster, type MeshAgent, type RoleAgentActivity } from '@pi-desktop/harness/corp';
import { runCorpMeshTask } from './mesh-host';
import { type PlanHop, planFromHops } from './mesh-plan';
import type { CorpModelHandle } from './role-agent';

/** A minimal single-producer/single-consumer async queue — the same shape as the
 * coordination engine's (unexported) PushStream, so the corp:event drain loop consumes
 * it unchanged. Drops pushes after `end()`. */
class MeshEventStream implements AsyncIterable<CoordinationEvent> {
  private readonly buffer: CoordinationEvent[] = [];
  private readonly waiters: Array<(r: IteratorResult<CoordinationEvent>) => void> = [];
  private ended = false;

  push(value: CoordinationEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as unknown as CoordinationEvent, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CoordinationEvent> {
    return {
      next: (): Promise<IteratorResult<CoordinationEvent>> => {
        const value = this.buffer.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) {
          return Promise.resolve({ value: undefined as unknown as CoordinationEvent, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Human label for a mesh agent id. */
function nameFor(agent: MeshAgent): string {
  if (agent.id === 'manager') return 'Manager';
  if (agent.id.startsWith('engineer:')) return `Engineer ${agent.id.split(':')[1] ?? ''}`.trim();
  if (agent.id.startsWith('specialist:'))
    return `${agent.id.split(':')[1] ?? ''} specialist`.trim();
  return agent.id;
}

/**
 * The parent node for the tree. The MANAGER is the root — there is no CEO inside
 * a production; the only CEO is the chat the user is talking to, and it is
 * blocked in `talk_to_manager` for as long as this runs. Everyone else hangs off
 * the manager: engineers because it contracts them, specialists because anyone
 * may commission them and the manager is the one seat always present.
 */
function parentFor(agent: MeshAgent): string | undefined {
  if (agent.id === 'manager') return undefined;
  return 'manager';
}

/**
 * Build the org chart from the roster + the current per-agent states.
 *
 * ONLY PEOPLE WHO HAVE ACTUALLY BEEN GIVEN WORK.
 *
 * The roster is a POOL, built up front: four engineer slots and twelve specialty
 * seats that anyone may commission. Emitting all of it meant the situation room
 * opened with seventeen names sitting at `queued` before a single message had
 * been sent, which reads as a team that has been assembled and contracted. the user,
 * looking at exactly that: "the contracts had to have been premade by either you
 * or you hardcoded the godot contracts from an earlier run." Neither — but the
 * room gave him no way to tell, and the one agent that mattered (the manager)
 * looked hired when it had never been spoken to.
 *
 * So a seat appears when it is first engaged. The room now grows in the order
 * work is actually handed out, and "the manager is in the room" means the
 * manager is really on the job.
 */
function buildMeshChart(
  taskId: string,
  roster: readonly MeshAgent[],
  states: ReadonlyMap<string, OrgNodeView['state']>,
): OrgChartView {
  const nodes: OrgNodeView[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  for (const agent of roster) {
    // The MANAGER is always present — it is the one seat that exists by virtue of
    // the production existing. Everyone else has to have been engaged.
    const state = states.get(agent.id);
    if (state === undefined && agent.id !== 'manager') continue;
    const parentId = parentFor(agent);
    nodes.push({
      id: agent.id,
      role: agent.role as OrgNodeView['role'],
      name: nameFor(agent),
      ...(parentId !== undefined ? { parentId } : {}),
      state: state ?? 'idle',
    });
    if (parentId !== undefined) edges.push({ from: parentId, to: agent.id });
  }
  return { taskId, nodes, edges };
}

/** The text/thinking increment for a streamed record (delta phase → delta; else full). */
function deltaFor(r: RoleAgentActivity): string | undefined {
  return r.phase === 'delta' ? r.delta : r.text;
}

/** Map one agent activity onto a `worker-activity` event (nodeId = the agent). Returns
 * undefined for turn-start/turn-end (handled as node-state pulses by the caller). Same
 * kind mapping as the CorpEngine's mapRoleActivity. */
function activityToEvent(nodeId: string, r: RoleAgentActivity): CoordinationEvent | undefined {
  switch (r.kind) {
    case 'assistant-text': {
      const delta = deltaFor(r);
      return {
        type: 'worker-activity',
        nodeId,
        kind: 'text',
        ...(r.phase !== undefined ? { phase: r.phase } : {}),
        ...(delta !== undefined && delta !== '' ? { delta } : {}),
      };
    }
    case 'thinking': {
      const delta = deltaFor(r);
      return {
        type: 'worker-activity',
        nodeId,
        kind: 'thinking',
        ...(r.phase !== undefined ? { phase: r.phase } : {}),
        ...(delta !== undefined && delta !== '' ? { delta } : {}),
      };
    }
    case 'briefing':
      return {
        type: 'worker-activity',
        nodeId,
        kind: 'briefing',
        ...(r.text !== undefined ? { delta: r.text } : {}),
      };
    case 'tool':
      return {
        type: 'worker-activity',
        nodeId,
        kind: 'tool',
        ...(r.toolName !== undefined ? { toolName: r.toolName } : {}),
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        ...(r.output !== undefined ? { output: r.output } : {}),
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.argsText !== undefined ? { argsText: r.argsText } : {}),
        ...(r.recipient !== undefined ? { recipient: r.recipient } : {}),
        ...(r.settled === true ? { settled: true } : {}),
      };
    case 'file-write':
      return {
        type: 'worker-activity',
        nodeId,
        kind: 'file',
        ...(r.path !== undefined ? { path: r.path } : {}),
        label: 'Writing',
        ...(r.text !== undefined ? { content: r.text } : {}),
        ...(r.linesAdded !== undefined ? { addedLines: r.linesAdded } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * Start a corp task as a mesh run, returning a {@link TaskHandle} whose `events` stream
 * the corp:event drain loop forwards to the window unchanged. Emits: opening
 * status+org-chart, then per-agent `worker-activity` (the live conversation) + org-chart
 * state pulses, then `status:'done'` + a terminal `done` carrying the CEO's reply. The
 * product files land in `cwd` (the shared workspace). Never throws — a run error is a
 * `failed` `done`.
 */
export function startMeshTask(opts: {
  readonly handle: CorpModelHandle;
  readonly task: string;
  readonly taskId: string;
  readonly cwd: string;
  /** Where this project's team lives between runs — the hierarchy directory. When
   * absent the team is written beside the work, which is only right for a
   * throwaway run. */
  readonly teamDir?: string;
  /** Tool registrars (web, browser) for every role's session. */
  readonly extensionFactories?: unknown[];
  /** Extension packages every role's session loads — the chat's own tool dirs. */
  readonly additionalExtensionPaths?: readonly string[];
  readonly maxTokens?: number;
}): TaskHandle & {
  readonly abort: () => void;
  /** Ask the CEO a question mid-run. Null until the team is live. */
  readonly ask: (question: string) => Promise<string>;
} {
  const stream = new MeshEventStream();
  /* Set once the host exists — see `onAskable`. Until then a question has nowhere
   * to go, which is a fact worth stating rather than a reason to send the user
   * away to a new chat. */
  let askCeo: ((question: string) => Promise<string>) | null = null;
  const roster = buildCorpRoster({ task: opts.task });
  const states = new Map<string, OrgNodeView['state']>();
  const emitChart = (): void => {
    stream.push({ type: 'org-chart', chart: buildMeshChart(opts.taskId, roster, states) });
  };

  /*
   * THE LIVE PLAN. The room's plan panel and its progress rail read the
   * `checklist` event, which the mesh never emitted — so every run showed a full
   * team and 0/0 tasks. The rows are derived from the work actually handed out
   * (see ./mesh-plan); this keeps the hops so far and re-publishes on each one.
   */
  const hops: PlanHop[] = [];
  const emitPlan = (): void => {
    const working = new Set(
      [...states.entries()].filter(([, st]) => st === 'working').map(([id]) => id),
    );
    stream.push({ type: 'checklist', items: planFromHops(hops, working) });
  };

  stream.push({ type: 'status', status: 'working' });
  emitChart();

  // Cooperative stop. `abort()` fires the mesh's signal (no new turns start) AND
  // emits the terminal 'aborted' done immediately, so the UI shows "stopped" at
  // once rather than waiting out the in-flight turn. The run's own then/catch are
  // guarded by `terminated` so they never double-emit after a stop.
  const controller = new AbortController();
  let terminated = false;
  const abort = (): void => {
    if (terminated) return;
    terminated = true;
    controller.abort();
    for (const agent of roster)
      if (states.get(agent.id) === 'working') states.set(agent.id, 'idle');
    emitChart();
    stream.push({ type: 'status', status: 'done' });
    stream.push({
      type: 'done',
      result: { outcome: 'aborted', summary: 'Stopped — every agent was told to wrap up.' },
    });
    stream.end();
  };

  void runCorpMeshTask({
    onAskable: (ask) => {
      askCeo = ask;
    },
    handle: opts.handle,
    task: opts.task,
    cwd: opts.cwd,
    signal: controller.signal,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.teamDir !== undefined ? { teamDir: opts.teamDir } : {}),
    ...(opts.additionalExtensionPaths !== undefined
      ? { additionalExtensionPaths: opts.additionalExtensionPaths }
      : {}),
    ...(opts.extensionFactories !== undefined
      ? { extensionFactories: opts.extensionFactories as never }
      : {}),
    onHop: (hop) => {
      hops.push(hop);
      emitPlan();
    },
    onActivity: (agentId, record) => {
      if (record.kind === 'turn-start') {
        states.set(agentId, 'working');
        emitChart();
        emitPlan();
        return;
      }
      if (record.kind === 'turn-end') {
        // Not "done" — a persistent agent may be talked to again; idle between turns.
        states.set(agentId, 'idle');
        emitChart();
        emitPlan();
        return;
      }
      const event = activityToEvent(agentId, record);
      if (event !== undefined) stream.push(event);
    },
  })
    .then((result) => {
      // A stop already emitted the terminal 'aborted' done — the mesh resolves
      // right after (its hops all refuse), so swallow this to avoid double-done.
      if (terminated) return;
      terminated = true;
      // Only people who actually WORKED can be finished. Marking the whole
      // roster done would resurrect the untouched pool at the final frame — the
      // same "team that never ran" the chart filter exists to stop.
      for (const [id, state] of states) if (state !== 'retired') states.set(id, 'done');
      states.set('manager', 'done');
      emitChart();
      stream.push({ type: 'status', status: 'done' });
      const taskResult: TaskResult = { outcome: 'completed', summary: result.reply };
      stream.push({ type: 'done', result: taskResult });
      stream.end();
    })
    .catch((err) => {
      if (terminated) return;
      terminated = true;
      const taskResult: TaskResult = {
        outcome: 'failed',
        summary: 'The mesh run failed.',
        error: err instanceof Error ? err.message : String(err),
      };
      stream.push({ type: 'status', status: 'error' });
      stream.push({ type: 'done', result: taskResult });
      stream.end();
    });

  const ask = async (question: string): Promise<string> => {
    if (askCeo === null) {
      return 'The team has not started yet — ask again in a moment.';
    }
    return askCeo(question);
  };
  return { taskId: opts.taskId, events: stream, abort, ask };
}
