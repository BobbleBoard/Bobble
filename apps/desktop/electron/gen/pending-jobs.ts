/**
 * A JOB CAN BE STOPPED BEFORE THE QUEUE HAS IT.
 *
 * A generation gets its id — and the chat that asked learns it
 * (`gen:agent-job`) — before it is queued: first it waits at the module,
 * weights and consent gates, which last as long as a multi-GB install the
 * person started, or four minutes when they never press Download.
 * `JobQueue.cancel` knows only queued and running jobs, so a cancel in that
 * window reached nothing and said so quietly (`canceled: false`), and the job
 * ran to the end once the install landed — for a chat that had been deleted
 * (review of the 2026-09-23 wave, delete #3). The same gap swallowed the
 * cancel of a ComfyUI mesh, whose caller holds a signal rather than the
 * queue's id (delete #5).
 *
 * So a job is `open` from its id to the queue: a cancel in that window stops
 * it at whichever gate it is waiting at, and it never reaches the queue.
 */

/** What the job's caller is told — the queue's own words for a cancel. */
export const CANCELED = 'generation canceled';

export class PendingJobs {
  readonly #pending = new Map<string, AbortController>();

  /**
   * The job has its id and is on its way to the queue. `also` is a signal of
   * the caller's that stops it too.
   */
  open(jobId: string, also?: AbortSignal): AbortSignal {
    const stop = new AbortController();
    this.#pending.set(jobId, stop);
    if (also?.aborted === true) stop.abort();
    else also?.addEventListener('abort', () => stop.abort(), { once: true });
    return stop.signal;
  }

  /** Stop a job still on its way to the queue. False when none is. */
  cancel(jobId: string): boolean {
    const stop = this.#pending.get(jobId);
    if (stop === undefined) return false;
    this.#pending.delete(jobId);
    stop.abort();
    return true;
  }

  /**
   * The job goes to the queue NOW — unless it was stopped on the way. Called
   * right before `enqueue`, with nothing awaited in between, so a cancel that
   * said "stopped" can never be followed by the job running.
   */
  admit(jobId: string): void {
    const stop = this.#pending.get(jobId);
    this.#pending.delete(jobId);
    if (stop === undefined || stop.signal.aborted) throw new Error(CANCELED);
  }

  /** The job is over, wherever it got to. */
  close(jobId: string): void {
    this.#pending.delete(jobId);
  }
}

/** Wait at a gate — unless the job is stopped first. */
export function unlessStopped<T>(stop: AbortSignal, gate: Promise<T> | T): Promise<T> {
  if (stop.aborted) return Promise.reject(new Error(CANCELED));
  return new Promise<T>((resolve, reject) => {
    const onStop = (): void => reject(new Error(CANCELED));
    stop.addEventListener('abort', onStop, { once: true });
    Promise.resolve(gate).then(
      (value) => {
        stop.removeEventListener('abort', onStop);
        resolve(value);
      },
      (err: unknown) => {
        stop.removeEventListener('abort', onStop);
        reject(err);
      },
    );
  });
}
