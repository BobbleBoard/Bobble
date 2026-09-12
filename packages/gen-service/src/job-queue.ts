/**
 * JobQueue — the supervised, unified-memory-budget-aware scheduler that the
 * Electron gen manager drives. It runs generation jobs parallel-or-queued:
 *
 *   - Light jobs (small image models) run up to `maxConcurrent` at once.
 *   - A HEAVY job (e.g. Qwen-Image ~24GB) runs EXCLUSIVELY — it waits for all
 *     running jobs to drain, then runs alone, and blocks new starts until it
 *     finishes. This is the "one heavy model at a time" unified-memory rule.
 *
 * FIFO within those constraints. Cancel works whether a job is still queued or
 * already running (running jobs are aborted via their AbortController → the
 * runner SIGKILLs the worker).
 *
 * The job RUNNER is injected so the queue unit-tests with a fake runner (no uv /
 * Python); production passes {@link GenServiceClient.run}.
 */
import { GenServiceClient } from './client.js';
import type { GenEvent, GenJob, GenOutput } from './protocol.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

/** Runs a single job to completion. Rejects on error/abort. */
export type JobRunner = (
  job: GenJob,
  opts: {
    onEvent?: (event: GenEvent) => void;
    signal?: AbortSignal;
    extraWith?: readonly string[];
  },
) => Promise<GenOutput[]>;

export type JobQueueListener = (event: JobQueueEvent) => void;

/** Queue-level observability (distinct from per-job worker {@link GenEvent}s). */
export type JobQueueEvent =
  | { readonly type: 'status'; readonly jobId: string; readonly status: JobStatus }
  | { readonly type: 'event'; readonly jobId: string; readonly event: GenEvent }
  /** A heavy job at the head is being held by the MACHINE, and this is why. */
  | { readonly type: 'held'; readonly jobId: string; readonly reason: string };

export interface EnqueueOptions {
  /** Expected resident footprint of the job's model, GB — see `heavyAllowed`. */
  readonly footprintGB?: number;
  /** Serialize this job exclusively (unified-memory budget). From catalog `heavy`. */
  readonly heavy?: boolean;
  /** Extra `uv --with` deps for the backend. */
  readonly extraWith?: readonly string[];
  /** Per-job worker event stream (progress/candidate/…). */
  readonly onEvent?: (event: GenEvent) => void;
}

export interface JobHandle {
  readonly id: string;
  /** Resolves with outputs on success; rejects on error/cancel. */
  readonly result: Promise<GenOutput[]>;
}

interface Entry {
  readonly job: GenJob;
  readonly heavy: boolean;
  readonly extraWith?: readonly string[];
  readonly onEvent?: (event: GenEvent) => void;
  readonly controller: AbortController;
  footprintGB?: number;
  /** Why it was cancelled, when it was not the user — see `cancel`. */
  cancelReason?: string;
  status: JobStatus;
  resolve(outputs: GenOutput[]): void;
  reject(err: Error): void;
}

export interface JobQueueOptions {
  /** Max simultaneous LIGHT jobs (default 2). Heavy jobs always run alone. */
  readonly maxConcurrent?: number;
  /** The runner (default = a {@link GenServiceClient}). */
  readonly runner?: JobRunner;
  /**
   * May a HEAVY job start right now? Consulted at admission, so the answer can
   * change with the machine. Default: always. See `JobQueue.#heavyAllowed`.
   *
   * Given the job's expected resident footprint (GB) when the caller knows it,
   * so the answer can be "not THIS one" rather than "nothing heavy": a machine
   * with 9 GB to spare can run a 5 GB video job and should hold a 12 GB image
   * one. The reason, when refused, is kept for the job's own status.
   */
  readonly heavyAllowed?: (footprintGB?: number) => boolean | { ok: boolean; reason?: string };
}

export class JobQueue {
  readonly #maxConcurrent: number;
  readonly #runner: JobRunner;
  readonly #listeners = new Set<JobQueueListener>();
  readonly #queue: Entry[] = [];
  readonly #entries = new Map<string, Entry>();
  readonly #running = new Set<string>();
  #runningHeavy = false;

  /**
   * May a HEAVY job start right now?
   *
   * The power policy's answer (power-policy.ts): under real memory pressure a
   * heavy generation is gigabytes of extra resident memory and the single worst
   * thing to begin. Held, never refused — the job waits in the queue and starts
   * when the machine is breathing again, which is what somebody who pressed
   * Generate wants. Defaults to "always", so a caller that does not care behaves
   * exactly as before.
   */
  #heavyAllowed: (footprintGB?: number) => boolean | { ok: boolean; reason?: string } = () => true;
  /** Why the heavy job at the head is being held, for whoever is watching it. */
  #holdReason: string | undefined;

  constructor(opts: JobQueueOptions = {}) {
    this.#maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2);
    this.#runner = opts.runner ?? ((job, o) => new GenServiceClient().run(job, o));
    if (opts.heavyAllowed !== undefined) this.#heavyAllowed = opts.heavyAllowed;
  }

  /**
   * Re-ask the admission question. The policy calls this when pressure clears,
   * so a job held back starts as soon as there is room rather than waiting for
   * the next unrelated queue event to pump it.
   */
  reconsider(): void {
    this.#pump();
  }

  on(listener: JobQueueListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: JobQueueEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch {
        // a listener throwing must never wedge the queue
      }
    }
  }

  #setStatus(entry: Entry, status: JobStatus): void {
    entry.status = status;
    this.#emit({ type: 'status', jobId: entry.job.id, status });
  }

  /** Current status of a job, or undefined if unknown. */
  statusOf(jobId: string): JobStatus | undefined {
    return this.#entries.get(jobId)?.status;
  }

  /** Number of jobs currently running. */
  get runningCount(): number {
    return this.#running.size;
  }

  /** Number of jobs waiting to start. */
  get queuedCount(): number {
    return this.#queue.length;
  }

  /** Is a heavy job running right now? */
  get runningHeavy(): boolean {
    return this.#runningHeavy;
  }

  /**
   * Cancel every RUNNING job — the guardian's lever. Heavy ones first, because
   * they are the likeliest cause, but all of them: at the wall a "light" 2 GB
   * audio job is still 2 GB the machine does not have, and the cost of stopping
   * it is a retry. Queued jobs stay queued — they are not the problem, and
   * admission holds them until the machine is breathing again. Returns the ids
   * it stopped.
   */
  shedRunning(reason: string): string[] {
    const running = [...this.#running]
      .map((id) => this.#entries.get(id))
      .filter((e): e is Entry => e !== undefined)
      .sort((a, b) => Number(b.heavy) - Number(a.heavy));
    const stopped: string[] = [];
    for (const entry of running) {
      if (this.cancel(entry.job.id, reason)) stopped.push(entry.job.id);
    }
    return stopped;
  }

  /** Enqueue a job. Returns a handle whose `result` settles on completion. */
  enqueue(job: GenJob, options: EnqueueOptions = {}): JobHandle {
    if (this.#entries.has(job.id)) {
      throw new Error(`job id already in queue: ${job.id}`);
    }
    let resolveFn!: (outputs: GenOutput[]) => void;
    let rejectFn!: (err: Error) => void;
    const result = new Promise<GenOutput[]>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const entry: Entry = {
      job,
      heavy: options.heavy === true,
      footprintGB: options.footprintGB,
      extraWith: options.extraWith,
      onEvent: options.onEvent,
      controller: new AbortController(),
      status: 'queued',
      resolve: resolveFn,
      reject: rejectFn,
    };
    this.#entries.set(job.id, entry);
    this.#queue.push(entry);
    this.#emit({ type: 'status', jobId: job.id, status: 'queued' });
    this.#pump();
    return { id: job.id, result };
  }

  /**
   * Cancel a queued or running job. No-op for unknown / already-settled jobs.
   *
   * `reason` is what the job's owner will be told. The user pressing Stop needs
   * none; the machine stopping a job on their behalf owes them one — "generation
   * canceled" after a job they did not cancel reads as a bug, where "stopped:
   * only 7% of memory was free" reads as the app looking after the computer.
   */
  cancel(jobId: string, reason?: string): boolean {
    const entry = this.#entries.get(jobId);
    if (entry === undefined) return false;
    if (reason !== undefined) entry.cancelReason = reason;
    if (entry.status === 'queued') {
      const idx = this.#queue.indexOf(entry);
      if (idx !== -1) this.#queue.splice(idx, 1);
      this.#setStatus(entry, 'canceled');
      entry.reject(new Error(reason ?? 'generation canceled'));
      this.#entries.delete(jobId);
      return true;
    }
    if (entry.status === 'running') {
      // Already on its way out: the worker is being killed and the promise
      // will reject on its own. Saying "cancelled" again would count one job
      // as several — the guardian logs and announces what this returns.
      if (entry.controller.signal.aborted) return false;
      // Abort → the runner SIGKILLs the worker → its promise rejects, which
      // #finish() maps to 'canceled'.
      entry.controller.abort();
      return true;
    }
    return false;
  }

  /** The machine's answer for one entry, normalised. */
  #machineAllows(entry: Entry): boolean {
    const answer = this.#heavyAllowed(entry.footprintGB);
    const ok = typeof answer === 'boolean' ? answer : answer.ok;
    const reason = typeof answer === 'boolean' ? undefined : answer.reason;
    if (!ok && reason !== undefined && reason !== this.#holdReason) {
      this.#holdReason = reason;
      this.#emit({ type: 'held', jobId: entry.job.id, reason });
    }
    if (ok) this.#holdReason = undefined;
    return ok;
  }

  /** Whether the entry at the head can start given the memory-budget rule. */
  #canStart(entry: Entry): boolean {
    if (this.#runningHeavy) return false; // a heavy job owns the machine
    if (entry.heavy) {
      // The machine has to be empty AND willing — see `#heavyAllowed`.
      return this.#running.size === 0 && this.#machineAllows(entry);
    }
    /*
     * LIGHT JOBS ASK TOO. "Light" is a catalog word for "may share the machine
     * with another job"; it is not a promise about size — a 2 GB music render
     * is light — and the reading that holds a 12 GB image should hold that
     * render when the same 2 GB is what the machine has left. The footprint
     * makes the answer proportionate: a 300 MB speech job passes where the
     * render does not.
     */
    return this.#running.size < this.#maxConcurrent && this.#machineAllows(entry);
  }

  #pump(): void {
    /*
     * Start as many head-of-queue jobs as the constraints allow. We only ever
     * consider the FRONT of the queue so ordering stays FIFO and a heavy job
     * can't be perpetually skipped by lighter jobs queued behind it.
     *
     * ONE EXCEPTION, and it is about who is doing the blocking. A heavy job
     * waiting for another job to finish is being blocked by the QUEUE, and
     * letting lighter work past it there is exactly the starvation the FIFO rule
     * exists to prevent. A heavy job held by the POWER POLICY is being blocked
     * by the MACHINE — nothing in the queue can clear it, and stalling every
     * light job behind it would mean a moment of memory pressure freezes all
     * generation. So that one is stepped over, and it starts on the next
     * `reconsider()` when the machine is breathing again.
     */
    let index = 0;
    while (index < this.#queue.length) {
      const next = this.#queue[index];
      if (next === undefined) break;
      if (!this.#canStart(next)) {
        // Held by the MACHINE rather than by the queue: step over it — a
        // smaller job behind it may fit (see the note above).
        if (!this.#runningHeavy && !this.#machineAllows(next)) {
          index += 1;
          continue;
        }
        break;
      }
      this.#queue.splice(index, 1);
      this.#start(next);
    }
  }

  #start(entry: Entry): void {
    this.#running.add(entry.job.id);
    if (entry.heavy) this.#runningHeavy = true;
    this.#setStatus(entry, 'running');

    this.#runner(entry.job, {
      signal: entry.controller.signal,
      extraWith: entry.extraWith,
      onEvent: (event) => {
        entry.onEvent?.(event);
        this.#emit({ type: 'event', jobId: entry.job.id, event });
      },
    }).then(
      (outputs) => this.#finish(entry, { ok: true, outputs }),
      (err: Error) => this.#finish(entry, { ok: false, err }),
    );
  }

  #finish(
    entry: Entry,
    result: { ok: true; outputs: GenOutput[] } | { ok: false; err: Error },
  ): void {
    this.#running.delete(entry.job.id);
    if (entry.heavy) this.#runningHeavy = false;
    if (result.ok) {
      this.#setStatus(entry, 'done');
      entry.resolve(result.outputs);
    } else if (entry.controller.signal.aborted) {
      this.#setStatus(entry, 'canceled');
      entry.reject(new Error(entry.cancelReason ?? 'generation canceled'));
    } else {
      this.#setStatus(entry, 'error');
      entry.reject(result.err);
    }
    this.#entries.delete(entry.job.id);
    this.#pump();
  }
}
