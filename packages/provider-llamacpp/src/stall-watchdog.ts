/**
 * A STREAM THAT STOPPED — told apart from one that is only quiet.
 *
 * MEASURED 2026-09-26 (visual suite, qwen3.5-4b-mtp on rapid-mlx): the first
 * request of a task streamed 143 chunks — a short thought and the "\n\n" after
 * `</think>` — then nothing for 300 s but rapid-mlx's `: keepalive` comments,
 * until the probe's 5-minute cap cancelled it. The turn ended with no tool
 * call, and the chat showed a finished "Thought" and nothing else all along.
 *
 * The obvious guard — "no delta for 60–90 s, abort" — would have been wrong on
 * the same machine the same day. rapid-mlx's hermes parser HOLDS a tool call
 * back until it closes (`_has_incomplete_structured_block` → nothing is sent),
 * so a model writing a big file streams its thought and then goes silent for
 * as long as the file takes. In the suite logs of that week: "6693 tokens in
 * 173.9 s" arrived as 216 chunks, "7321 tokens in 201.9 s" as 235 — about
 * twenty successful requests with 80–195 s of silence each. A plain idle
 * timer kills every one of them, retries, and kills the retry.
 *
 * So silence alone is not the signal. Evidence that the request is ALIVE is:
 *
 *   - a content / reasoning / tool-call delta;
 *   - a llama.cpp prefill frame whose `processed` count moved;
 *   - the ENGINE saying it is still working — rapid-mlx's `/v1/status`
 *     `steps_executed` (one step per decode or prefill chunk, and it only moves
 *     while a request is being stepped) or llama-server's `/slots` decode
 *     counters. Asked only once the stream has been quiet a while.
 *
 * Keepalive comments are never evidence: `parseSSE` drops them before this
 * code sees anything, and a chunk that carries no delta (the role chunk, a
 * usage chunk, an empty delta) does not count either.
 *
 * A stream is STALLED after `stallMs` with no evidence at all. For an engine
 * that cannot be asked (mlx_lm.server, mlx-dspark, dflash-mlx have no progress
 * endpoint), silence is ambiguous except in the middle of a thought — every
 * engine streams reasoning token by token — so there the short window applies,
 * and anywhere a tool call could be held back only the much longer
 * `blindStallMs` does.
 *
 * The clock is pure (the caller passes the time), so every rule here is tested
 * with numbers; {@link watchStream} binds it to real timers and the probe.
 */

/** What kind of delta arrived — it decides what a later silence can mean. */
export type DeltaKind = 'reasoning' | 'content' | 'tool';

/**
 * Where the stream is, as far as silence goes.
 *   `waiting`  — nothing yet: prefill, or queued behind another request.
 *   `thinking` — the last delta was reasoning, which every engine streams
 *                token by token: a long silence here is not a held-back call.
 *   `writing`  — text or a tool call has started; a tool call may be held back.
 */
export type StreamPhase = 'waiting' | 'thinking' | 'writing';

export interface StallPolicy {
  /** No evidence of progress for this long → stalled. */
  readonly stallMs: number;
  /**
   * No delta for this long, where the engine cannot be asked and the silence
   * could be a held-back tool call → stalled. Must cover the longest real
   * silent stretch on the slowest engine that has no probe.
   */
  readonly blindStallMs: number;
  /** Start asking the engine once the stream has been quiet this long. */
  readonly probeAfterMs: number;
  /** Then ask again this often while it stays quiet. */
  readonly probeEveryMs: number;
  /** A probe that has not answered in this long counts as no answer. */
  readonly probeTimeoutMs: number;
}

/**
 * The defaults, and why.
 *
 * `stallMs` 90 s: the user's range was 60–90 s, "well above normal prefill of a
 * ~12k-token prompt". The long end, because the cost of a false stall (a turn
 * that throws away good work) is higher than a minute more of waiting on a
 * dead one — and prefill is covered by evidence anyway (llama.cpp progress
 * frames; rapid-mlx steps once per 8192-token prefill chunk), so the window
 * only has to outlast ONE step.
 *
 * `blindStallMs` 10 min: the longest silent tool-call write measured was
 * ~195 s at ~36 tok/s on the 4B; a 9B–27B model at ~16 tok/s writing the same
 * file is ~450 s. Past ten minutes a stream the engine cannot vouch for is
 * given up on — before this there was no limit at all.
 */
export const DEFAULT_STALL_POLICY: StallPolicy = {
  stallMs: 90_000,
  blindStallMs: 600_000,
  probeAfterMs: 10_000,
  probeEveryMs: 10_000,
  probeTimeoutMs: 5_000,
};

/** How many times a stalled request is sent again before the turn is told. */
export const STALL_RETRIES = 1;

/**
 * Keep a policy self-consistent: the engine is asked at least twice inside the
 * stall window (one answer is only a baseline — it takes two to see a counter
 * move), and the blind window is never shorter than the ordinary one.
 */
export function normalizeStallPolicy(p: StallPolicy): StallPolicy {
  const stallMs = Math.max(1, p.stallMs);
  const probeEveryMs = Math.max(1, Math.min(p.probeEveryMs, stallMs / 3));
  return {
    stallMs,
    blindStallMs: Math.max(stallMs, p.blindStallMs),
    probeAfterMs: Math.max(0, Math.min(p.probeAfterMs, stallMs / 3)),
    probeEveryMs,
    probeTimeoutMs: Math.max(1, Math.min(p.probeTimeoutMs, probeEveryMs)),
  };
}

/** Env knobs, for probes and diagnosis. `PI_STREAM_STALL_MS=0` turns the watchdog off. */
export function stallPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): StallPolicy | null {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const stallMs = num('PI_STREAM_STALL_MS', DEFAULT_STALL_POLICY.stallMs);
  if (stallMs === 0) return null;
  return normalizeStallPolicy({
    stallMs,
    blindStallMs: num('PI_STREAM_STALL_BLIND_MS', DEFAULT_STALL_POLICY.blindStallMs),
    probeAfterMs: num('PI_STREAM_STALL_PROBE_AFTER_MS', DEFAULT_STALL_POLICY.probeAfterMs),
    probeEveryMs: num('PI_STREAM_STALL_PROBE_EVERY_MS', DEFAULT_STALL_POLICY.probeEveryMs),
    probeTimeoutMs: num('PI_STREAM_STALL_PROBE_TIMEOUT_MS', DEFAULT_STALL_POLICY.probeTimeoutMs),
  });
}

/** What the watchdog knew when it gave up on a stream. */
export interface StallInfo {
  /** How long nothing counted as progress. */
  readonly quietMs: number;
  readonly phase: StreamPhase;
  /**
   * `idle` — the engine answered and its work counter did not move;
   * `unanswered` — the engine has a progress endpoint and it stopped answering;
   * `blind` — the engine cannot be asked (the long window applied, or the
   *   silence was mid-thought, where no engine holds output back).
   */
  readonly engine: 'idle' | 'unanswered' | 'blind';
  /** Deltas seen before the silence. */
  readonly deltas: number;
}

export type ClockAction =
  | { readonly type: 'stall'; readonly info: StallInfo }
  | { readonly type: 'probe' }
  | { readonly type: 'wait'; readonly ms: number };

/**
 * The rules, with the time passed in. One instance per request attempt.
 *
 * `hasProbe` says whether the engine is expected to answer a progress probe;
 * a probe that answers "not supported" turns that off for the rest of the
 * stream, one that merely fails (timeout, refused) does not — an engine that
 * used to answer and stopped is itself a sign of trouble.
 */
export class StallClock {
  private phase: StreamPhase = 'waiting';
  private lastDeltaAt: number;
  private lastEvidenceAt: number;
  private deltaCount = 0;
  private probeState: 'unknown' | 'working' | 'unsupported';
  private probeValue: number | undefined;
  private probeInFlight = false;
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  /** Did the most recent probe get an answer? (undefined: none sent yet.) */
  private lastProbeAnswered: boolean | undefined;
  private readonly policy: StallPolicy;

  constructor(policy: StallPolicy, start: number, hasProbe: boolean) {
    this.policy = normalizeStallPolicy(policy);
    this.lastDeltaAt = start;
    this.lastEvidenceAt = start;
    this.probeState = hasProbe ? 'unknown' : 'unsupported';
  }

  /** A delta arrived. Returns true when it moved the stream to a new phase. */
  delta(kind: DeltaKind, now: number): boolean {
    this.deltaCount++;
    this.lastDeltaAt = now;
    this.lastEvidenceAt = Math.max(this.lastEvidenceAt, now);
    const phase: StreamPhase = kind === 'reasoning' ? 'thinking' : 'writing';
    const moved = phase !== this.phase;
    this.phase = phase;
    return moved;
  }

  /** The server reported progress on the stream itself (a prefill frame that moved). */
  progress(now: number): void {
    this.lastEvidenceAt = Math.max(this.lastEvidenceAt, now);
  }

  /** A probe is being sent now. */
  probeStarted(now: number): void {
    this.probeInFlight = true;
    this.lastProbeAt = now;
  }

  /**
   * A probe came back: a work counter, `null` for "this engine cannot say",
   * or `undefined` for no answer (timed out, refused, garbled once).
   */
  probeResult(value: number | null | undefined, now: number): void {
    this.probeInFlight = false;
    if (value === null) {
      this.probeState = 'unsupported';
      return;
    }
    this.lastProbeAnswered = value !== undefined;
    if (value === undefined) return;
    // A counter that moved is the engine doing work. The first answer is only
    // a baseline; one that went BACKWARDS (a restarted engine) rebases.
    if (this.probeValue !== undefined && value > this.probeValue) {
      this.lastEvidenceAt = Math.max(this.lastEvidenceAt, now);
    }
    this.probeValue = value;
    this.probeState = 'working';
  }

  /** What to do at `now`. */
  check(now: number): ClockAction {
    const p = this.policy;
    const quietMs = now - this.lastEvidenceAt;
    const canAsk = this.probeState !== 'unsupported';

    // The window that applies to this silence.
    let windowMs: number;
    let since: number;
    if (canAsk) {
      windowMs = p.stallMs;
      since = this.lastEvidenceAt;
    } else if (this.phase === 'thinking') {
      windowMs = p.stallMs;
      since = this.lastDeltaAt;
    } else {
      windowMs = p.blindStallMs;
      since = this.lastEvidenceAt;
    }
    const due = since + windowMs;

    if (now >= due) {
      // A probe on its way back may still show the engine moving: wait for it.
      if (this.probeInFlight) return { type: 'wait', ms: Math.max(1, p.probeTimeoutMs) };
      return {
        type: 'stall',
        info: {
          quietMs: now - since,
          phase: this.phase,
          engine: !canAsk ? 'blind' : this.lastProbeAnswered === true ? 'idle' : 'unanswered',
          deltas: this.deltaCount,
        },
      };
    }

    if (canAsk && !this.probeInFlight && quietMs >= p.probeAfterMs) {
      if (now - this.lastProbeAt >= p.probeEveryMs) return { type: 'probe' };
    }

    // Sleep until the next thing that could change the answer.
    let next = due;
    if (canAsk && !this.probeInFlight) {
      next = Math.min(
        next,
        Math.max(this.lastEvidenceAt + p.probeAfterMs, this.lastProbeAt + p.probeEveryMs),
      );
    }
    return { type: 'wait', ms: Math.max(1, next - now) };
  }
}

// --- engine progress probes -----------------------------------------------

/**
 * Ask the engine how much work it has done. A number that only grows while
 * it works; `null` when this engine has no way to say; throws (or `undefined`)
 * when it did not answer.
 */
export type EngineProgressProbe = (signal: AbortSignal) => Promise<number | null | undefined>;

/**
 * rapid-mlx `GET /v1/status` → `steps_executed`: the scheduler's step count,
 * which moves once per decode step or prefill chunk and ONLY while a request
 * is being stepped (the loop blocks on an event when idle). Read from rapid-mlx
 * 0.14.1: `routes/health.py` `status()`, `engine/batched.py` `get_stats()`,
 * `mllm_scheduler.py` `_step_no_queue()`. `null` when the body has no counter.
 */
export function rapidMlxWorkCounter(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  const steps = (body as { steps_executed?: unknown }).steps_executed;
  return typeof steps === 'number' && Number.isFinite(steps) ? steps : null;
}

/**
 * llama-server `GET /slots` → the tokens every slot has decoded plus the prompt
 * tokens it has processed. `next_token` is an object on current builds and a
 * one-element array on older ones; both are read. `null` when the body is not
 * a slot list.
 */
export function llamaSlotsWorkCounter(body: unknown): number | null {
  if (!Array.isArray(body)) return null;
  let total = 0;
  let seen = false;
  for (const slot of body) {
    if (slot === null || typeof slot !== 'object') continue;
    const s = slot as {
      next_token?: unknown;
      n_decoded?: unknown;
      n_prompt_tokens_processed?: unknown;
    };
    const next = Array.isArray(s.next_token) ? s.next_token[0] : s.next_token;
    const decoded =
      next !== null && typeof next === 'object'
        ? (next as { n_decoded?: unknown }).n_decoded
        : s.n_decoded;
    if (typeof decoded === 'number' && Number.isFinite(decoded)) {
      total += decoded;
      seen = true;
    }
    if (
      typeof s.n_prompt_tokens_processed === 'number' &&
      Number.isFinite(s.n_prompt_tokens_processed)
    ) {
      total += s.n_prompt_tokens_processed;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * A probe that GETs `url` and reads a counter out of the JSON.
 *
 * Any 4xx, a 501, or a body without the counter means "this engine cannot say"
 * (`null`), and the stream gets the long blind window: an engine without the
 * route answers 404 (mlx_lm.server, dflash-mlx, mlx-dspark, oMLX — read from
 * their sources), one behind an API key 401, `--no-slots` llama-server 501.
 * Reading one of those as "stopped answering" would give a held-back tool call
 * the SHORT window. A network failure, a timeout or another 5xx is no answer
 * this time (throws / `undefined`).
 */
export function httpProgressProbe(
  url: string,
  read: (body: unknown) => number | null,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): EngineProgressProbe {
  return async (signal) => {
    const res = await fetchImpl(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      await res.text().catch(() => ''); // release the connection
      return res.status < 500 || res.status === 501 ? null : undefined;
    }
    const body = (await res.json().catch(() => undefined)) as unknown;
    if (body === undefined) return null;
    return read(body);
  };
}

/** `http://host:port/v1` → `http://host:port` (llama-server's own routes live at the root). */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

// --- the driver -------------------------------------------------------------

export interface StreamWatch {
  /** A content / reasoning / tool-call delta arrived. */
  delta(kind: DeltaKind): void;
  /** Server-side progress on the stream itself (a llama.cpp prefill frame that moved). */
  progress(): void;
  /** The stream is over, one way or another: stop the timers and any probe. */
  stop(): void;
  /** Set once the watchdog has fired. */
  readonly stalled: StallInfo | undefined;
}

export interface WatchStreamOptions {
  readonly policy: StallPolicy;
  readonly probe?: EngineProgressProbe | undefined;
  /** Called once, when the stream is judged stalled: cancel the request here. */
  readonly onStall: (info: StallInfo) => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Watch one streaming request. One timer at a time, re-armed from the clock's
 * answer; deltas only update the clock (thousands of them must not churn
 * timers), so a timer that fires early just re-checks and sleeps again.
 */
export function watchStream(opts: WatchStreamOptions): StreamWatch {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const policy = normalizeStallPolicy(opts.policy);
  const clock = new StallClock(policy, now(), opts.probe !== undefined);
  let timer: unknown;
  let stopped = false;
  let stalled: StallInfo | undefined;
  let probeAbort: AbortController | undefined;

  const runProbe = (): void => {
    const probe = opts.probe;
    if (probe === undefined) return;
    clock.probeStarted(now());
    const ctl = new AbortController();
    probeAbort = ctl;
    let settled = false;
    // Exactly one answer per probe: whatever comes first of the reply and the
    // timeout. A probe that ignores its signal cannot hold the clock open.
    const settle = (value: number | null | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimer(timeout);
      if (probeAbort === ctl) probeAbort = undefined;
      if (stopped) return;
      clock.probeResult(value, now());
      evaluate();
    };
    const timeout = setTimer(() => {
      ctl.abort();
      settle(undefined);
    }, policy.probeTimeoutMs);
    void probe(ctl.signal).then(
      (value) => settle(ctl.signal.aborted ? undefined : value),
      () => settle(undefined),
    );
  };

  const evaluate = (): void => {
    if (stopped) return;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    const action = clock.check(now());
    if (action.type === 'stall') {
      stalled = action.info;
      stop();
      opts.onStall(action.info);
      return;
    }
    if (action.type === 'probe') {
      // The probe's own answer (or its timeout) re-evaluates.
      runProbe();
      return;
    }
    timer = setTimer(evaluate, action.ms);
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    probeAbort?.abort();
    probeAbort = undefined;
  }

  evaluate();
  return {
    delta(kind) {
      if (stopped) return;
      // A new phase can SHORTEN the window (waiting → thinking takes the blind
      // ten minutes down to ninety seconds), so the sleeping timer is re-armed.
      // Rare — once or twice a stream — so deltas still never churn timers.
      if (clock.delta(kind, now())) evaluate();
    },
    progress() {
      if (!stopped) clock.progress(now());
    },
    stop,
    get stalled() {
      return stalled;
    },
  };
}

// --- what the turn is told --------------------------------------------------

/** The abort reason a stalled attempt is cancelled with. */
export class StreamStalledError extends Error {
  constructor(readonly info: StallInfo) {
    super(`stream stalled after ${Math.round(info.quietMs / 1000)} s`);
    this.name = 'StreamStalledError';
  }
}

/**
 * Link an attempt's controller to the caller's signal: the person's Stop still
 * cancels the request, and the watchdog can cancel THIS attempt without
 * touching the caller's signal. Returns the unlink.
 */
export function linkAbort(outer: AbortSignal | undefined, inner: AbortController): () => void {
  if (outer === undefined) return () => undefined;
  if (outer.aborted) {
    inner.abort(outer.reason);
    return () => undefined;
  }
  const onAbort = (): void => inner.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  return () => outer.removeEventListener('abort', onAbort);
}

/**
 * "90 s" / "10 min". Seconds only below two minutes and whole minutes above,
 * so the text can never carry a number pi reads as an HTTP status (500, 503…).
 */
function formatQuiet(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  return secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
}

function describeSilence(info: StallInfo): string {
  const quiet = formatQuiet(info.quietMs);
  if (info.engine === 'idle') {
    return `no output for ${quiet}, and the engine reported no work in progress`;
  }
  if (info.engine === 'unanswered') {
    return `no output for ${quiet}, and the engine stopped answering status checks`;
  }
  return `no output for ${quiet}, and this engine cannot report whether it is still generating`;
}

/** One line for stderr each time an attempt is cancelled. */
export function stallLogLine(info: StallInfo, attempt: number, retrying: boolean): string {
  return (
    `[pi-stall] ${describeSilence(info)} (phase=${info.phase}, deltas=${info.deltas}) — ` +
    `cancelled attempt ${attempt}${retrying ? `, sending it again (${attempt} of ${STALL_RETRIES})` : ''}`
  );
}

/**
 * The error the turn ends with when the retry stalled too.
 *
 * WORDED SO PI DOES NOT RETRY IT AGAIN. pi auto-retries an error whose text
 * matches its "transient" pattern (`timed out`, `terminated`, `server error`,
 * `connection …`, 5xx codes — agent-session.js `_isRetryableError`), three more
 * times with backoff. The request was already sent twice; a wedged engine
 * would turn that into minutes of futile retries. The test pins it.
 */
export function stallErrorMessage(info: StallInfo, attempts: number): string {
  const tries =
    attempts === 1
      ? 'The request was cancelled.'
      : 'It was cancelled and sent again, and the new attempt stalled the same way.';
  return (
    `The model stopped responding: ${describeSilence(info)}. ${tries} ` +
    'Switching models or restarting Bobble restarts the model engine.'
  );
}
