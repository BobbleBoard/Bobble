/**
 * MAKE ROOM: park the chat model for a generation that does not fit beside it.
 *
 * the user: "low can't stop image generation requests, it just has to lessen
 * compute intensivity in some way sacrificing speed to keep headroom."
 *
 * On a 24 GB Mac the resident chat model is the single largest thing in memory
 * — MEASURED 6.5 GB for a 4B at Q8 with its context — and the picture the user
 * asked for needs about as much again (FLUX.2 klein, 1024², low-RAM: ~6 GB,
 * ~8 GB with the guardian's headroom) beside a 6 GB reserve. With the machine's
 * own programs open that is "Waiting for memory — needs about 8.3 GB and only
 * 10.6 GB is available (keeping 6 GB for you)", for as long as anyone cares to
 * watch: a hold that never lifts is a stop with a spinner on it.
 *
 * The chat model is idle for the whole of that wait — when the picture was
 * asked for from the chat it is inside the tool call, and from a studio it is
 * doing nothing — so it is the thing to give up. This module runs that trade:
 *
 *   held      the queue says a job is waiting on memory → ask the inference
 *             worker to PARK the chat server (refused while a request is in
 *             flight — a turn is never cut; then we try again shortly), take a
 *             fresh reading, and let the queue reconsider;
 *   started   the job is running → the room was worth it;
 *   ── or ──  it is still held after the grace → parking did not help (the
 *             picture would not fit even so); the chat comes straight back and
 *             that job is not asked about again, the honest hold stands;
 *   finished  the last heavy job is out of the queue → RESUME the chat server,
 *             on the same URL, before whoever asked for the picture is
 *             answered — so the chat's next request finds its model back.
 *
 * The speed given up is one model reload and one re-prefill per parking. That
 * is the "sacrificing speed" the user named, spent only when nothing cheaper fits.
 *
 * Pure: every side effect is a dependency, so the choreography is tested
 * without a model, a queue or a worker.
 */

export interface RoomDeps {
  /** Ask the inference worker to stop the chat server's process (keeping its port). */
  readonly park: () => Promise<{ ok: boolean; reason?: string }>;
  /** Bring a parked server back on the same URL. */
  readonly resume: () => Promise<{ ok: boolean; reason?: string }>;
  /** A fresh pressure reading, then a queue pump — the held job may now fit. */
  readonly reconsider: () => Promise<void>;
  /** Heavy work still queued or running? Nothing resumes into a running job. */
  readonly busy: () => boolean;
  readonly log: (message: string, extra?: Record<string, unknown>) => void;
  /** How long after a park the job gets to start before parking is judged useless. */
  readonly graceMs?: number;
  /** How long to wait before asking again when the chat was mid-request. */
  readonly retryMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface RoomKeeper {
  /** The queue is holding `jobId` for want of memory. */
  held(jobId: string): void;
  /** `jobId` is running now. */
  started(jobId: string): void;
  /** `jobId` left the queue (done, failed or cancelled). */
  finished(jobId: string): void;
  /**
   * Resolves once any resume this keeper owes has completed — the manager
   * awaits it before answering the caller, so a chat that asked for the
   * picture gets its model back with the result.
   */
  settle(): Promise<void>;
  /** The chat server is parked because of this keeper. */
  readonly parked: boolean;
  dispose(): void;
}

export function createRoomKeeper(deps: RoomDeps): RoomKeeper {
  const graceMs = deps.graceMs ?? 4_000;
  const retryMs = deps.retryMs ?? 5_000;
  const setT = deps.setTimeout ?? globalThis.setTimeout;
  const clearT = deps.clearTimeout ?? globalThis.clearTimeout;

  let parked = false;
  /** A park or resume in flight; nothing else starts until it lands. */
  let inFlight: Promise<void> | null = null;
  /** Jobs currently held by the machine, in the order they were reported. */
  const heldJobs = new Set<string>();
  /** Jobs parking has already been tried for, and did not help. */
  const hopeless = new Set<string>();
  const running = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearT(retryTimer);
      retryTimer = null;
    }
  };
  const clearGrace = (): void => {
    if (graceTimer !== null) {
      clearT(graceTimer);
      graceTimer = null;
    }
  };

  const resumeNow = (why: string): Promise<void> => {
    if (!parked) return Promise.resolve();
    parked = false;
    clearGrace();
    const p = deps
      .resume()
      .then((r) => {
        if (r.ok) deps.log('chat model back', { why });
        else deps.log('chat model did NOT come back', { why, reason: r.reason });
      })
      .catch((err) => {
        deps.log('chat model did NOT come back', { why, error: String(err) });
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  };

  const scheduleRetry = (jobId: string): void => {
    clearRetry();
    retryTimer = setT(() => {
      retryTimer = null;
      tryPark(jobId);
    }, retryMs);
  };

  const tryPark = (jobId: string): void => {
    if (disposed || parked) return;
    if (!heldJobs.has(jobId) || hopeless.has(jobId)) return;
    // A resume (or an earlier park) is still landing: ask again after it.
    if (inFlight !== null) {
      scheduleRetry(jobId);
      return;
    }
    const p = deps
      .park()
      .then(async (r) => {
        if (disposed) return;
        if (!r.ok) {
          // No chat model at all: nothing to give up, the hold is honest.
          if (r.reason === 'no server') {
            hopeless.add(jobId);
            return;
          }
          // Mid-request (or starting): ask again once the turn has moved on.
          deps.log('chat model not parked yet', { jobId, reason: r.reason });
          scheduleRetry(jobId);
          return;
        }
        parked = true;
        deps.log('chat model parked to make room', { jobId });
        await deps.reconsider();
        // Did it help? The job starts within the grace or it never will.
        clearGrace();
        graceTimer = setT(() => {
          graceTimer = null;
          if (heldJobs.has(jobId) && !running.has(jobId)) {
            hopeless.add(jobId);
            deps.log('parking did not make enough room; chat model returns', { jobId });
            void resumeNow('the picture still does not fit');
          }
        }, graceMs);
      })
      .catch((err) => {
        deps.log('park failed', { jobId, error: String(err) });
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
  };

  return {
    held(jobId) {
      if (disposed || hopeless.has(jobId)) return;
      heldJobs.add(jobId);
      tryPark(jobId);
    },
    started(jobId) {
      heldJobs.delete(jobId);
      running.add(jobId);
      if (parked) clearGrace();
    },
    finished(jobId) {
      heldJobs.delete(jobId);
      running.delete(jobId);
      hopeless.delete(jobId);
      if (heldJobs.size === 0) clearRetry();
      if (parked && !deps.busy()) void resumeNow('the queue drained');
    },
    settle() {
      return inFlight ?? Promise.resolve();
    },
    get parked() {
      return parked;
    },
    dispose() {
      disposed = true;
      clearRetry();
      clearGrace();
      if (parked) void resumeNow('shutting down');
    },
  };
}
