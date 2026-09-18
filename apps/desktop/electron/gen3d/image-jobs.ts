/**
 * Awaiting an image job — the electron-free half of the chat's image tools.
 *
 * The studio panels are event-driven (fire a generate, watch `gen3d:job`
 * broadcasts), but a TOOL CALL is request/response: it must await exactly one
 * image and get back either a path or a reason. This tracker turns the sidecar's
 * job event stream into that promise, with no polling.
 *
 * Two orderings have to work, because the `/generate` POST response and the
 * `/events` stream are independent:
 *   - the normal one — waiter registered, then artifact, then done;
 *   - the race — a job finishes before its caller learns the jobId, so the
 *     artifact and/or the terminal outcome arrive with no waiter yet. Both are
 *     remembered (boundedly) and claimed when the waiter shows up.
 *
 * Kept out of gen3d-main.ts so it can be unit-tested: electron/ tests may not
 * import the real `electron`, which gen3d-main does.
 */

export type ImageJobResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/** The fields of a `JobUpdate` this tracker cares about. */
export interface ImageJobProgress {
  readonly jobId: string;
  readonly artifact?: { readonly kind: string; readonly path: string };
  readonly done: boolean;
  readonly error?: string;
}

/** How many finished-but-unclaimed jobs to remember. Only ever needs to cover
 * the microscopic window between a job ending and its waiter registering. */
const MEMORY = 8;

function evict<V>(map: Map<string, V>): void {
  while (map.size > MEMORY) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

/** Which artifact a waiter wants back: a picture, or (the chat's 3D tools,
 * 2026-09-18) the model — the LAST `model-glb` a job pushed, since a
 * generation pushes its untextured geometry first and the textured mesh
 * after, on the same job. */
export type WantedArtifact = 'image' | 'model-glb';

export class ImageJobTracker {
  private readonly waiters = new Map<
    string,
    { readonly kind: WantedArtifact; readonly settle: (r: ImageJobResult) => void }
  >();
  /** jobId → artifact paths by kind, for artifacts seen before their waiter existed. */
  private readonly artifacts = new Map<string, Map<string, string>>();
  /** jobId → outcome, for jobs that finished before their waiter existed. */
  private readonly outcomes = new Map<
    string,
    { readonly error?: string; readonly paths: Map<string, string> }
  >();

  /**
   * The sidecar died — settle everything waiting on it.
   *
   * Without this, a crash (OOM is an expected outcome on 24 GB) left every
   * in-flight caller waiting for a process that is gone, until its own
   * fifteen-minute timeout. The chat's image tools await a specific job, so
   * "generate an image" simply hung, once, for a quarter of an hour.
   */
  failAll(reason: string): void {
    for (const { settle } of this.waiters.values()) {
      settle({ ok: false, error: reason });
    }
    this.waiters.clear();
  }

  private static outcome(
    kind: WantedArtifact,
    error: string | undefined,
    paths: ReadonlyMap<string, string>,
  ): ImageJobResult {
    if (error !== undefined && error !== '') return { ok: false, error };
    const path = paths.get(kind);
    if (path !== undefined) return { ok: true, path };
    return {
      ok: false,
      error: `the engine finished without producing ${kind === 'image' ? 'an image' : 'a model'}`,
    };
  }

  /** Fold one job update in, settling the waiter when the job ends. */
  note(update: ImageJobProgress): void {
    const kind = update.artifact?.kind;
    if ((kind === 'image' || kind === 'model-glb') && update.artifact?.path !== '') {
      const paths = this.artifacts.get(update.jobId) ?? new Map<string, string>();
      // The last of a kind wins: textured geometry replaces the untextured.
      paths.set(kind, update.artifact?.path ?? '');
      this.artifacts.set(update.jobId, paths);
      evict(this.artifacts);
    }
    if (!update.done) return;
    const paths = this.artifacts.get(update.jobId) ?? new Map<string, string>();
    this.artifacts.delete(update.jobId);
    const waiter = this.waiters.get(update.jobId);
    if (waiter !== undefined) {
      this.waiters.delete(update.jobId);
      waiter.settle(ImageJobTracker.outcome(waiter.kind, update.error, paths));
      return;
    }
    this.outcomes.set(update.jobId, {
      ...(update.error !== undefined ? { error: update.error } : {}),
      paths,
    });
    evict(this.outcomes);
  }

  /**
   * Resolve when the job ends — or with a timeout reason, so a caller can never
   * hang forever on an engine that stopped reporting.
   */
  wait(jobId: string, timeoutMs: number, kind: WantedArtifact = 'image'): Promise<ImageJobResult> {
    const already = this.outcomes.get(jobId);
    if (already !== undefined) {
      this.outcomes.delete(jobId);
      return Promise.resolve(ImageJobTracker.outcome(kind, already.error, already.paths));
    }
    return new Promise<ImageJobResult>((resolve) => {
      let settled = false;
      const settle = (r: ImageJobResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(jobId);
        resolve(r);
      };
      const timer = setTimeout(() => {
        // Leave the engine alone — cancelling mid-model-load costs more than it
        // saves — but stop waiting, and say so.
        settle({
          ok: false,
          error: `the ${kind === 'image' ? 'image' : '3D'} job did not finish within ${Math.round(timeoutMs / 1000)}s`,
        });
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(jobId, { kind, settle });
    });
  }

  /** Test/lifecycle hook. */
  get pending(): number {
    return this.waiters.size;
  }
}
