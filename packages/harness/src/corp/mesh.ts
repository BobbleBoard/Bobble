/**
 * The AGENT MESH — the corp's message-passing runtime (the user's model: "EVERYONE is a
 * pi instance with a system prompt + tools that gets prompted to DO SOMETHING, and
 * anyone can talk to anyone"). This is the emergent alternative to the deterministic
 * `runCorp` pipeline: instead of a fixed vision→promote→architect→dispatch→review
 * sequence, there are persistent AGENTS that prompt each other via a `talk_to` tool,
 * and the work is whatever falls out of that conversation. The CEO is prompted with
 * the task, talks to the manager, the manager talks to engineers and specialists, and
 * replies flow back up.
 *
 * This module is the PURE, DETERMINISTIC CORE — the actual pi sessions are INJECTED
 * ({@link RunAgentTurn}), so the routing, the peer permissions, and the bounds are all
 * unit-testable with mocks (no model, no fs). It generalizes the existing `consult`
 * primitive (role-agent-seam.ts — an agent already spawns another and waits for its
 * prose) into named, PERSISTENT, ANY-TO-ANY peers: the same synchronous recursive
 * "call another agent and get its reply" shape, but the target keeps its context
 * across turns and both directions are first-class.
 *
 * Bounded by construction (a small model in an emergent loop must never run away):
 * every talk is gated by a per-agent PEER ALLOWLIST (you may only talk to declared
 * peers), a DEPTH cap (nested conversations), a TOTAL-TURN budget, and a re-entrancy
 * guard (an agent already mid-turn on the call stack is "busy" rather than deadlocked).
 * A blocked talk returns a plain-language note, never throws — the calling agent reads
 * it like any tool result and carries on. Pure; never throws.
 */

/** A persistent agent in the mesh: a stable id, its role, its system prompt, the peers
 * it may talk to, and its built-in tools. Its SESSION persists across turns (its
 * context accumulates) — modeled here by the injected {@link RunAgentTurn} keeping
 * state per `id`. */
export interface MeshAgent {
  /** Stable id used for routing (e.g. `ceo`, `manager`, `engineer:frontend-1`). */
  readonly id: string;
  /** The role family (for prompts/telemetry), e.g. `ceo` / `manager` / `engineer`. */
  readonly role: string;
  /** The composed system prompt for this agent's session. */
  readonly systemPrompt: string;
  /** The agent ids this agent may `talk_to` — a DIRECTED allowlist (declare both ways
   * for a two-way channel, e.g. ceo↔manager). Talking to a non-peer is refused. */
  readonly peers: readonly string[];
  /** Built-in tool names the agent may use (`read`/`write`/`bash`/…). */
  readonly tools: readonly string[];
}

/** The router handed INTO each agent turn: when the running agent calls its
 * `talk_to(peer, message)` tool, the seam invokes this and awaits the peer's reply
 * (synchronous + recursive — the peer may talk to ITS peers before replying). */
export type TalkFn = (from: string, to: string, message: string) => Promise<string>;

/** One prompt to a persistent agent: which agent, who is prompting it, the message,
 * and the {@link TalkFn} its `talk_to` tools call. The seam runs the agent's live
 * session (appending `message` to its context) and returns its reply. */
export interface AgentTurnRequest {
  readonly agentId: string;
  readonly from: string;
  readonly message: string;
  readonly talk: TalkFn;
}

/** The result of one agent turn: its reply to whoever prompted it (the tool result the
 * sender receives). */
export interface AgentTurnResult {
  readonly reply: string;
}

/** The injected seam that runs ONE persistent agent turn (real = a live pi session;
 * test = a mock). Should never throw — an error is the agent's problem to report as a
 * reply, not the mesh's to crash on. */
export type RunAgentTurn = (req: AgentTurnRequest) => Promise<AgentTurnResult>;

/** The mesh's bounds — the backstop against an emergent conversation running away. */
export interface MeshBudget {
  /** Max TOTAL agent turns across the whole mesh (every prompt/talk charges one). */
  readonly maxTurns: number;
  /** Max `talk_to` nesting depth (a → b → c → … ). */
  readonly maxDepth: number;
  /**
   * How many agent turns may be IN FLIGHT at once. Dispatched work runs in
   * parallel up to this, and the rest queues FIFO for the next free slot —
   * the user: "even if there isn't enough compute to handle concurrency, when an
   * engineer running pauses, then run then unqueue the manager". The cap is
   * about the machine (one llama-server, a few slots), never about the design:
   * the manager's wait behaves identically either way, it just resumes sooner
   * or later.
   */
  readonly maxConcurrent?: number;
}

/** The default bounds — generous enough for a real multi-agent build, tight enough to
 * guarantee termination. */
/** Three at once: enough for a real round on this machine, few enough that a
 * single llama-server's slots are not thrashed. */
export const DEFAULT_MAX_CONCURRENT = 3;

export const DEFAULT_MESH_BUDGET: MeshBudget = {
  maxTurns: 200,
  maxDepth: 12,
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
};

/** One piece of work handed out and not yet finished. */
export interface DispatchedJob {
  /** Who is doing it. */
  readonly to: string;
  /** What they were asked, so a wait can say which job came back. */
  readonly message: string;
  /** Resolves with their reply when their turn ends. Never rejects. */
  readonly done: Promise<string>;
  settled: boolean;
  reply?: string;
}

/** What a {@link AgentMesh.waitOn} came back with. */
export interface WaitOutcome {
  /** `finished` = at least one job came back; `nudged` = somebody needs you;
   * `idle` = there was nothing outstanding to wait for. */
  readonly kind: 'finished' | 'nudged' | 'idle';
  /** Jobs that completed while waiting (empty for `nudged`/`idle`). */
  readonly finished: readonly { readonly to: string; readonly reply: string }[];
  /** Jobs still running when the wait returned. */
  readonly stillRunning: readonly string[];
}

/** The synthetic sender id for the ROOT prompt (the user/task kicking off the mesh) —
 * it may talk to any agent (it has no peer allowlist of its own). */
export const ROOT_SENDER = 'user';

/** Why a talk was refused (surfaced to the caller as a plain note, never thrown). */
export type TalkRefusal =
  | 'unknown-agent'
  | 'not-a-peer'
  | 'busy'
  | 'too-deep'
  | 'out-of-turns'
  | 'aborted';

/** The plain-language note a refused talk returns to the calling agent. Pure. */
export function refusalNote(kind: TalkRefusal, to: string): string {
  switch (kind) {
    case 'unknown-agent':
      return `(there is no "${to}" to talk to.)`;
    case 'not-a-peer':
      return `(you are not set up to talk to "${to}".)`;
    case 'busy':
      /*
       * "Check back later" is advice that can never succeed, and it was the only
       * thing the one upward edge in this system ever returned. `deliver` marks
       * the recipient active BEFORE awaiting the turn, so whoever called you is on
       * the stack for as long as you are running: an engineer messaging its
       * manager is refused 100% of the time. Measured — across fourteen live runs
       * engineers tried exactly twice, and were refused twice.
       *
       * The synchronous shape is not itself wrong: your reply IS the message back
       * to whoever called you. So say that, instead of sending a small model round
       * a loop that has no exit.
       */
      return (
        `(${to} is mid-turn — it is the one waiting on YOU, so it cannot answer a ` +
        `message right now. If you need something from ${to}, stop here and put it ` +
        `in your reply: your reply goes straight back to them.)`
      );
    case 'too-deep':
      return '(this conversation has nested too many times — wrap up and report back.)';
    case 'out-of-turns':
      return '(the team is out of time for now — wrap up with what you have.)';
    case 'aborted':
      return '(the run was stopped — wrap up immediately, do not start anything new.)';
  }
}

/** One recorded talk in the mesh transcript (for telemetry / the situation room). */
export interface MeshHop {
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly reply: string;
  readonly depth: number;
  /** Present when the talk was refused (no agent turn ran). */
  readonly refused?: TalkRefusal;
  /** True when the recipient was mid-task, so this was left for its next turn. */
  readonly queued?: boolean;
}

/**
 * The message-passing runtime. Construct with the injected turn-runner + the agent
 * roster, then {@link run} kicks it off by prompting a root agent (e.g. the CEO with
 * the task). Everything else emerges from `talk_to`. Every hop is recorded in
 * {@link hops} for telemetry. Not reusable across runs (the budget/transcript are
 * per-instance); make a new mesh per task.
 */
export class AgentMesh {
  private readonly agents = new Map<string, MeshAgent>();
  private readonly active = new Set<string>();
  /** Messages that arrived while an agent was mid-task, waiting for its next turn. */
  private readonly pending = new Map<string, string[]>();
  private turnsUsed = 0;
  private aborted = false;
  /** The ordered transcript of every talk (including refusals). */
  readonly hops: MeshHop[] = [];

  /**
   * WORK HANDED OUT AND STILL RUNNING, by whoever handed it out.
   *
   * A manager delegates a ROUND — several engineers — and only then waits. That
   * is impossible if delegation blocks: the first hand-off would hold the stack
   * and the second engineer could never start. the user: "when you've delegated
   * everyone you want for the round, you're either delegating more, sending
   * messages to already delegated workers, or being on standby."
   */
  private readonly jobs = new Map<string, DispatchedJob[]>();
  /** Anyone parked in {@link waitOn}, so a raised hand can wake them early. */
  private readonly waiters = new Map<string, () => void>();
  /** Turns actually in flight, for the concurrency cap. */
  private running = 0;
  /** Agents whose turn is queued behind the cap, released FIFO as slots free. */
  private readonly startQueue: Array<() => void> = [];

  // PLAIN FIELDS, not constructor parameter properties. The real-server drivers
  // load these modules directly under Node's strip-only TypeScript, which cannot
  // transform a parameter property — it throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
  // before a single agent runs. Same rule as role-agent.ts's "no syntax the smoke
  // cannot load".
  private readonly runTurn: RunAgentTurn;
  private readonly budget: MeshBudget;

  /** Called as each hop is recorded, so a host can show work being handed out
   * WHILE it happens. `hops` is only readable once the whole run resolves, which
   * is far too late for anything watching a live run. */
  private readonly onHop: ((hop: MeshHop) => void) | undefined;

  constructor(
    runTurn: RunAgentTurn,
    agents: readonly MeshAgent[],
    budget: MeshBudget = DEFAULT_MESH_BUDGET,
    onHop?: (hop: MeshHop) => void,
  ) {
    this.runTurn = runTurn;
    // OPTIONAL on the way in, concrete in here: an existing caller that predates
    // parallel dispatch must not have to know about a cap to keep working.
    this.budget = { ...budget, maxConcurrent: budget.maxConcurrent ?? DEFAULT_MAX_CONCURRENT };
    this.onHop = onHop;
    for (const a of agents) this.agents.set(a.id, a);
  }

  /** Record a hop and tell anyone watching. Every `hops.push` goes through here
   * so a new hop kind cannot silently skip the notification. */
  private record(hop: MeshHop): void {
    this.hops.push(hop);
    this.onHop?.(hop);
  }

  /** True once no more turns may run (the total-turn budget is spent). */
  get exhausted(): boolean {
    return this.turnsUsed >= this.budget.maxTurns;
  }

  /** How many agent turns have run so far. */
  get turns(): number {
    return this.turnsUsed;
  }

  /**
   * Cooperatively stop the run: every subsequent talk (including the root's next
   * hop and any in-flight agent's `talk_to`) is refused with `'aborted'`, so the
   * conversation unwinds fast — no new turns start. The turn currently awaiting
   * its seam finishes (a single model call can't be torn mid-flight here), then
   * its downstream talks all refuse. Idempotent.
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Kick off the mesh: prompt `rootId` with `message` (e.g. the CEO with the user's
   * task). Returns the root agent's final reply — the product of the whole emergent
   * conversation. A missing root or a spent budget yields a plain note, never throws.
   */
  async run(rootId: string, message: string): Promise<string> {
    let reply = await this.deliver(ROOT_SENDER, rootId, message, 0);
    /*
     * ENDING A TURN IS NOT FINISHING THE JOB.
     *
     * `deliver` runs ONE turn. So the production used to end the moment the root's
     * turn ended — and a manager that has just delegated has, by design, nothing
     * left to say. MEASURED, run 4: the manager briefed three engineers, wrote a
     * note to itself reading "Waiting for engineers to submit completed work", and
     * its turn ended. deliver returned an empty reply, mesh-host invented a cause
     * for it ("ran out of steps after 100 tool calls"), promote-tool turned that
     * into "Nothing was delivered", and the CEO relayed a failure to the user
     * while a packaged .app sat on disk.
     *
     * the user: "unless the manager returned a message to the ceo like 'we failed'
     * how would the ceo break out of waiting for a tool result for the 'talk to'
     * tool, it should just be waiting for a tool result".
     *
     * So while the root still has work out, waiting is the default rather than a
     * thing it must remember to ask for. Each pass parks until somebody comes back
     * and hands the root what came back, exactly as the `wait` tool would have. It
     * ends when there is genuinely nothing outstanding — which is the real
     * definition of done, and the only one that cannot be produced by silence.
     */
    for (;;) {
      if (this.aborted) break;
      const outstanding = this.outstanding(rootId);
      if (outstanding.length === 0) break;
      const out = await this.waitOn(rootId);
      // `idle` with nothing outstanding is the loop's own exit; anything else is
      // news the root has to act on, so give it a turn with that news.
      const news = [
        ...out.finished.map((f) => `${f.to} came back:\n${f.reply}`),
        ...(out.stillRunning.length > 0 ? [`Still working: ${out.stillRunning.join(', ')}.`] : []),
      ].join('\n\n');
      if (news === '') break;
      reply = await this.deliver(ROOT_SENDER, rootId, news, 0);
    }
    return reply;
  }

  /**
   * HAND WORK OUT WITHOUT WAITING FOR IT.
   *
   * The recipient's turn starts now and runs alongside the sender's, so a manager
   * can brief its whole round and only then park in {@link waitOn}. Returns
   * immediately with an acknowledgement — never the reply, which by definition
   * does not exist yet.
   *
   * A refusal (not a peer, out of turns, aborted) still comes back synchronously,
   * because those are answers the sender can act on straight away.
   */
  dispatch(from: string, to: string, message: string, depth = 0): string {
    const refusal = this.refuse(from, to, depth);
    if (refusal !== undefined) {
      const reply = refusalNote(refusal, to);
      this.record({ from, to, message, reply, depth, refused: refusal });
      return reply;
    }
    const job: DispatchedJob = {
      to,
      message,
      settled: false,
      // `deliver` never throws, so this promise never rejects — but the catch
      // stays because an unhandled rejection here would take down the run for a
      // reason that has nothing to do with the work.
      /*
       * THE CONCURRENCY GATE, held for the whole JOB rather than per turn.
       *
       * Per turn it deadlocks: a nested `talk_to` inside a running turn would
       * wait for a slot its own parent is holding, and at maxConcurrent=3 a
       * chain four deep stops forever. Per job is also the honest unit — a
       * dispatched thread only ever has ONE agent generating at a time (the
       * leaf), whoever called it is parked awaiting a reply. So "3 at once"
       * means three models really generating.
       */
      done: this.acquireSlot()
        .then(() => this.deliver(from, to, message, depth + 1))
        .catch(
          (err: unknown) =>
            `(${to} hit a problem: ${err instanceof Error ? err.message : String(err)})`,
        )
        .finally(() => this.releaseSlot()),
    };
    void job.done.then((reply) => {
      job.settled = true;
      job.reply = reply;
      // Whoever handed this out may be parked waiting for exactly this.
      this.nudge(from);
    });
    const list = this.jobs.get(from) ?? [];
    list.push(job);
    this.jobs.set(from, list);
    return (
      `Handed to ${to}, who is working on it now. You do NOT have their answer yet — ` +
      `carry on delegating, or wait to be told when they finish or need you.`
    );
  }

  /** Who this agent has work out with right now. */
  outstanding(from: string): string[] {
    return (this.jobs.get(from) ?? []).filter((j) => !j.settled).map((j) => j.to);
  }

  /**
   * Wake anyone parked in {@link waitOn} for `agentId` — a job came back, or
   * somebody raised a hand at them. Safe to call when nobody is waiting.
   */
  nudge(agentId: string): void {
    const wake = this.waiters.get(agentId);
    if (wake === undefined) return;
    this.waiters.delete(agentId);
    wake();
  }

  /**
   * STAND BY until something happens: a job comes back, or somebody needs you.
   *
   * Returns as soon as the FIRST thing lands rather than draining everything, so
   * a manager hears about a stuck engineer immediately instead of after the
   * slowest contract in the round. With nothing outstanding it returns `idle` at
   * once — waiting on an empty team is a mistake to report, not to hang on.
   */
  async waitOn(from: string): Promise<WaitOutcome> {
    const jobs = this.jobs.get(from) ?? [];
    const outstanding = jobs.filter((j) => !j.settled);
    if (outstanding.length === 0) {
      return { kind: 'idle', finished: [], stillRunning: [] };
    }
    let nudged = false;
    const woken = new Promise<void>((resolve) => {
      this.waiters.set(from, () => {
        nudged = true;
        resolve();
      });
    });
    await Promise.race([...outstanding.map((j) => j.done), woken]);
    this.waiters.delete(from);
    // Report every job that settled, not only the one that won the race — two
    // finishing together must not leave one silently unreported.
    const finished = jobs
      .filter((j) => j.settled && j.reply !== undefined)
      .map((j) => ({ to: j.to, reply: j.reply as string }));
    // Settled jobs are consumed: the next wait is about what is still out.
    this.jobs.set(
      from,
      jobs.filter((j) => !j.settled),
    );
    const stillRunning = this.outstanding(from);
    if (finished.length > 0) return { kind: 'finished', finished, stillRunning };
    return { kind: nudged ? 'nudged' : 'idle', finished: [], stillRunning };
  }

  /**
   * Take a concurrency slot, queueing FIFO when every slot is busy. This is the
   * only place a turn is allowed to begin, so the cap cannot be bypassed by a
   * new call path.
   */
  private async acquireSlot(): Promise<void> {
    if (this.running < (this.budget.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.startQueue.push(resolve));
    this.running += 1;
  }

  private releaseSlot(): void {
    this.running -= 1;
    const next = this.startQueue.shift();
    if (next !== undefined) next();
  }

  /** Route one message from `from` to `to`, enforcing the peer allowlist, the
   * re-entrancy/busy guard, and the depth + turn budgets. Records the hop. Never
   * throws — a refusal or a seam error becomes the reply text. */
  /**
   * MESSAGES TO SOMEONE MID-TASK ARE QUEUED, NOT REFUSED.
   *
   * This used to answer "busy, check back later", which is advice that can never
   * succeed: whoever called you is on the stack for as long as you run, so an
   * engineer messaging its manager — or a manager reporting to the CEO — was
   * refused 100% of the time. Seven such refusals in one live run, and the run
   * ended with the CEO never hearing anything.
   *
   * There was never a use case for the refusal. The only real constraint is that
   * a pi session cannot be re-prompted while it is mid-turn, and queueing
   * respects that exactly: the message waits, and is handed over the moment that
   * agent is next prompted. The sender is told it was delivered and carries on,
   * which is what "sending a message to a colleague" should have meant all along.
   */
  private queued(to: string): string {
    const waiting = this.pending.get(to);
    if (waiting === undefined || waiting.length === 0) return '';
    this.pending.delete(to);
    return `${waiting.join('\n\n')}\n\n`;
  }

  private async deliver(from: string, to: string, message: string, depth: number): Promise<string> {
    // Mid-task: queue it for their next turn rather than bouncing it.
    if (this.agents.has(to) && this.active.has(to) && !this.aborted) {
      const waiting = this.pending.get(to) ?? [];
      waiting.push(`[message from ${from}, sent while you were working]\n${message}`);
      this.pending.set(to, waiting);
      this.record({ from, to, message, reply: '(queued)', depth, queued: true });
      return (
        `(Delivered. ${to} is mid-task, so it will read this the moment it next picks ` +
        `up work — you do not need to wait or resend.)`
      );
    }
    const refusal = this.refuse(from, to, depth);
    if (refusal !== undefined) {
      const reply = refusalNote(refusal, to);
      this.record({ from, to, message, reply, depth, refused: refusal });
      return reply;
    }

    this.turnsUsed += 1;
    this.active.add(to);
    let reply: string;
    try {
      const talk: TalkFn = (f, t, m) => this.deliver(f, t, m, depth + 1);
      // Anything that arrived while this agent was busy goes in front of the new
      // message, so it is read before being asked to do the next thing.
      const out = await this.runTurn({
        agentId: to,
        from,
        message: `${this.queued(to)}${message}`,
        talk,
      });
      reply = out.reply;
    } catch (err) {
      // A seam that throws is the agent's failure to report, not a mesh crash.
      reply = `(${to} hit a problem: ${err instanceof Error ? err.message : String(err)})`;
    } finally {
      this.active.delete(to);
    }
    this.record({ from, to, message, reply, depth });
    return reply;
  }

  /** The bounds check for a talk: returns the refusal kind, or `undefined` when the
   * talk may proceed. Pure over the mesh's state. */
  private refuse(from: string, to: string, depth: number): TalkRefusal | undefined {
    // Stop wins over everything — once aborted, no talk proceeds.
    if (this.aborted) return 'aborted';
    if (!this.agents.has(to)) return 'unknown-agent';
    // The root may talk to anyone; an agent may talk only to its DECLARED peers.
    if (from !== ROOT_SENDER && this.agents.get(from)?.peers.includes(to) !== true) {
      return 'not-a-peer';
    }
    // NOTE: an agent mid-turn is handled ABOVE, by queueing — never refused.
    if (depth > this.budget.maxDepth) return 'too-deep';
    if (this.turnsUsed >= this.budget.maxTurns) return 'out-of-turns';
    return undefined;
  }
}
