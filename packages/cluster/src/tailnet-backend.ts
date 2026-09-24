/**
 * ONE WAY TO ASK TAILSCALE, WHICHEVER WAY THIS MACHINE ANSWERS.
 *
 * A backend answers four questions — status, whois, ping, and "tell me when
 * something changes" — and there are three ways to ask them: the daemon's
 * LocalAPI (fast, streams changes, undocumented), the CLI (always there when
 * Tailscale is), and later Bobble's own embedded node (tsnet, DEV-14), which
 * will be one more implementation of this interface.
 *
 * {@link chooseBackend} picks per machine: the LocalAPI when it answers, else
 * the CLI when there is one, else "Tailscale is not installed" — never a guess.
 * {@link createTailnetAdapter} wraps the choice so callers never hold a stale
 * one: when the chosen backend stops answering (Tailscale restarted on a new
 * port, the app was removed), it chooses again, once, before giving an answer.
 */
import { type CliRunner, createCliBackend, locateCli } from './cli-backend.js';
import {
  createLocalApiClient,
  type LocalApiClient,
  type LocalApiTarget,
  locateLocalApi,
} from './localapi.js';
import { type PingResult, parsePingJson } from './ping-parse.js';
import { parseTailscaleStatus, type TailnetStatus } from './tailscale.js';
import { notifyNeedsRefresh, runWithReconnect, sleep, statusDigest } from './watch.js';
import { parseWhois, type WhoisResult, whoisFailure } from './whois.js';

export interface BackendCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TailnetBackend {
  readonly kind: 'localapi' | 'cli';
  /** Where it asks — for diagnostics. Never contains a secret. */
  readonly label: string;
  /** Throws only when the backend itself is gone (so the adapter chooses again). */
  status(opts?: BackendCallOptions): Promise<TailnetStatus>;
  whois(addr: string, opts?: BackendCallOptions): Promise<WhoisResult>;
  ping(ip: string, opts?: BackendCallOptions): Promise<PingResult>;
  /**
   * Push: call `onChange` whenever the device list may have changed, until
   * `signal` aborts (then resolve). Only backends with a live channel have it;
   * the adapter polls the others.
   */
  watch?(onChange: () => void, opts: { readonly signal: AbortSignal }): Promise<void>;
}

/**
 * The LocalAPI target stopped being one: it refused this user (401/403) or is
 * something else (404, 5xx on status). Thrown so the adapter chooses again.
 */
export class LocalApiGoneError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Tailscale's local API answered HTTP ${status}: ${body.trim().slice(0, 200)}`);
    this.name = 'LocalApiGoneError';
    this.status = status;
  }
}

/** Answers from the LocalAPI, parsed exactly like the CLI's. */
export function createLocalApiBackend(
  client: LocalApiClient,
  opts: { readonly reconnectMinMs?: number; readonly reconnectMaxMs?: number } = {},
): TailnetBackend {
  return {
    kind: 'localapi',
    label: client.label,
    async status(o = {}) {
      const res = await client.status(o);
      if (res.status === 200) return parseTailscaleStatus(res.body);
      /*
       * The daemon's status route always answers 200. Anything else means this
       * target is no longer the daemon's LocalAPI — a rotated same-user token
       * (401), another program on the old port (403/404) — so the adapter must
       * look again rather than report "not running" from a stale target.
       */
      throw new LocalApiGoneError(res.status, res.body);
    },
    async whois(addr, o = {}) {
      const res = await client.whois(addr, o);
      if (res.status === 200) return parseWhois(res.body);
      if (res.status === 401 || res.status === 403)
        throw new LocalApiGoneError(res.status, res.body);
      return whoisFailure(res.body.trim() || `HTTP ${res.status}`);
    },
    async ping(ip, o = {}) {
      try {
        const res = await client.ping(ip, o);
        if (res.status === 401 || res.status === 403)
          throw new LocalApiGoneError(res.status, res.body);
        if (res.status !== 200) {
          return { ok: false, reason: 'error', detail: res.body.trim() || `HTTP ${res.status}` };
        }
        return parsePingJson(JSON.parse(res.body));
      } catch (e) {
        if (e instanceof Error && e.name === 'TimeoutError') {
          return { ok: false, reason: 'timeout', detail: 'no pong before the deadline' };
        }
        if (e instanceof SyntaxError) {
          return { ok: false, reason: 'error', detail: 'the ping answer was not JSON' };
        }
        throw e;
      }
    },
    watch(onChange, { signal }) {
      return runWithReconnect(
        (onLine, s) => client.watchIpnBus(onLine, s),
        (line) => {
          if (notifyNeedsRefresh(line)) onChange();
        },
        {
          signal,
          ...(opts.reconnectMinMs !== undefined ? { minBackoffMs: opts.reconnectMinMs } : {}),
          ...(opts.reconnectMaxMs !== undefined ? { maxBackoffMs: opts.reconnectMaxMs } : {}),
          // A stream that failed without a word may mean the daemon moved
          // (restart, new port): a status read finds out, and re-chooses.
          onConnectionEnd: ({ lines, error }) => {
            if (lines === 0 && error !== undefined) onChange();
          },
        },
      );
    },
  };
}

export interface ChooseBackendDeps {
  readonly locateLocalApi?: () => Promise<LocalApiTarget[]>;
  readonly createLocalApiClient?: (target: LocalApiTarget) => LocalApiClient;
  readonly locateCli?: () => Promise<string | null>;
  readonly runCli?: CliRunner;
  /** Base environment for CLI spawns (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** How long a LocalAPI candidate gets to answer `status`. Default 1500 ms. */
  readonly probeTimeoutMs?: number;
  /** Passed to the LocalAPI backend's watch (tests shorten them). */
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
}

export type BackendChoice =
  | {
      readonly backend: TailnetBackend;
      readonly tried: readonly string[];
      /** LocalAPI candidates were found but none answered (the CLI stood in). */
      readonly localApiSeen?: boolean;
    }
  | { readonly backend: null; readonly status: TailnetStatus; readonly tried: readonly string[] };

export const NOT_INSTALLED_REASON = 'Tailscale is not installed on this computer.';

/**
 * LocalAPI when a candidate answers `status` (any HTTP 200 — a Stopped daemon
 * still answers, and says so); else the CLI when one is on disk; else not
 * installed. `tried` lists what was asked, without secrets.
 */
export async function chooseBackend(deps: ChooseBackendDeps = {}): Promise<BackendChoice> {
  const tried: string[] = [];
  let targets: LocalApiTarget[] = [];
  try {
    targets = await (deps.locateLocalApi ?? locateLocalApi)();
  } catch {
    targets = [];
  }
  for (const target of targets) {
    const client = (deps.createLocalApiClient ?? createLocalApiClient)(target);
    tried.push(client.label);
    try {
      const res = await client.status({ timeoutMs: deps.probeTimeoutMs ?? 1500 });
      if (res.status === 200) {
        return {
          backend: createLocalApiBackend(client, {
            ...(deps.reconnectMinMs !== undefined ? { reconnectMinMs: deps.reconnectMinMs } : {}),
            ...(deps.reconnectMaxMs !== undefined ? { reconnectMaxMs: deps.reconnectMaxMs } : {}),
          }),
          tried,
        };
      }
    } catch {
      /* not answering: the next candidate */
    }
  }
  let bin: string | null = null;
  try {
    bin = await (deps.locateCli ?? locateCli)();
  } catch {
    bin = null;
  }
  if (bin !== null) {
    tried.push(`CLI ${bin}`);
    return {
      localApiSeen: targets.length > 0,
      backend: createCliBackend({
        bin,
        ...(deps.runCli !== undefined ? { run: deps.runCli } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      }),
      tried,
    };
  }
  return {
    backend: null,
    tried,
    status: { available: false, state: 'NotInstalled', reason: NOT_INSTALLED_REASON, peers: [] },
  };
}

export interface TailnetAdapterDeps extends ChooseBackendDeps {
  readonly now?: () => number;
  /** With nothing installed, how long before looking again. Default 5 s. */
  readonly rechooseAfterMs?: number;
  /**
   * On the CLI while a LocalAPI exists but did not answer (it was restarting),
   * how long before trying the LocalAPI again. Default 60 s.
   */
  readonly upgradeAfterMs?: number;
}

export interface WatchOptions {
  readonly signal: AbortSignal;
  /** Poll interval without a push channel (the CLI). Default 5 s — the Devices-open rate. */
  readonly pollMs?: number;
  /** Safety poll while the LocalAPI stream is live. Default 60 s. */
  readonly pushPollMs?: number;
  /** Coalesce a burst of change notices into one status read. Default 250 ms. */
  readonly debounceMs?: number;
}

export interface TailnetAdapter {
  status(opts?: BackendCallOptions): Promise<TailnetStatus>;
  whois(addr: string, opts?: BackendCallOptions): Promise<WhoisResult>;
  ping(ip: string, opts?: BackendCallOptions): Promise<PingResult>;
  /**
   * Report the status now and on every change, until `signal` aborts. Only
   * changes are reported (compared by {@link statusDigest}).
   */
  watch(onStatus: (status: TailnetStatus) => void, opts: WatchOptions): Promise<void>;
  /** What is answering: known after the first call. */
  backendKind(): 'localapi' | 'cli' | 'none' | 'unknown';
  /** Forget the choice (Tailscale was installed or removed). */
  reset(): void;
}

export function createTailnetAdapter(deps: TailnetAdapterDeps = {}): TailnetAdapter {
  const now = deps.now ?? Date.now;
  const rechooseAfter = deps.rechooseAfterMs ?? 5000;
  const upgradeAfter = deps.upgradeAfterMs ?? 60_000;
  let current: Promise<BackendChoice> | null = null;
  let chosenAt = 0;
  let kind: 'localapi' | 'cli' | 'none' | 'unknown' = 'unknown';
  let standIn = false;
  /** Watchers waiting to hear that the answering backend changed. */
  const choiceListeners = new Set<() => void>();

  const stale = (): boolean => {
    const age = now() - chosenAt;
    // Nothing installed is re-checked now and then: Tailscale may appear.
    if (kind === 'none') return age >= rechooseAfter;
    // The CLI standing in for a LocalAPI that was down: try the fast path again.
    if (kind === 'cli' && standIn) return age >= upgradeAfter;
    return false;
  };

  const choose = (force: boolean): Promise<BackendChoice> => {
    if (current !== null && !force && !stale()) return current;
    const previous = current;
    const next = chooseBackend(deps).then(async (c) => {
      kind = c.backend?.kind ?? 'none';
      standIn = c.backend !== null && c.localApiSeen === true;
      chosenAt = now();
      const before = previous === null ? undefined : await previous.catch(() => undefined);
      if (
        before?.backend?.label !== c.backend?.label ||
        before?.backend?.kind !== c.backend?.kind
      ) {
        for (const listener of choiceListeners) listener();
      }
      return c;
    });
    current = next;
    return next;
  };

  /** Run on the chosen backend; if it throws (it is gone), choose again once. */
  const withBackend = async <T>(
    fn: (b: TailnetBackend) => Promise<T>,
    none: (c: Extract<BackendChoice, { backend: null }>) => T,
    failed: (message: string) => T,
  ): Promise<T> => {
    let choice = await choose(false);
    for (let attempt = 0; ; attempt += 1) {
      if (choice.backend === null) return none(choice);
      try {
        return await fn(choice.backend);
      } catch (e) {
        if (attempt >= 1) return failed(e instanceof Error ? e.message : String(e));
        choice = await choose(true);
      }
    }
  };

  const adapter: TailnetAdapter = {
    status: (opts) =>
      withBackend(
        (b) => b.status(opts),
        (c) => c.status,
        (message) => ({
          available: false,
          state: 'NotRunning',
          reason: `Tailscale did not answer: ${message}`,
          peers: [],
        }),
      ),
    whois: (addr, opts) =>
      withBackend(
        (b) => b.whois(addr, opts),
        () => ({ found: false, reason: 'error', detail: NOT_INSTALLED_REASON }),
        (message) => whoisFailure(message),
      ),
    ping: (ip, opts) =>
      withBackend(
        (b) => b.ping(ip, opts),
        () => ({ ok: false, reason: 'error', detail: NOT_INSTALLED_REASON }),
        (message) => ({ ok: false, reason: 'error', detail: message }),
      ),
    async watch(onStatus, opts) {
      const { signal } = opts;
      const pollMs = opts.pollMs ?? 5000;
      const pushPollMs = opts.pushPollMs ?? 60_000;
      const debounceMs = opts.debounceMs ?? 250;
      let last: string | undefined;
      let reading: Promise<void> | null = null;
      let readAgain = false;
      const refresh = async (): Promise<void> => {
        if (reading !== null) {
          readAgain = true;
          return reading;
        }
        reading = (async () => {
          do {
            readAgain = false;
            const s = await adapter.status();
            if (signal.aborted) return;
            const digest = statusDigest(s);
            if (digest !== last) {
              last = digest;
              onStatus(s);
            }
          } while (readAgain && !signal.aborted);
        })().finally(() => {
          reading = null;
        });
        return reading;
      };
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const poke = (): void => {
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          void refresh();
        }, debounceMs);
      };
      let pushFor: TailnetBackend | null = null;
      let pushStop: AbortController | null = null;
      const stopPush = (): void => {
        pushStop?.abort();
        pushStop = null;
      };
      // A new backend wakes the loop at once, so the live stream follows it
      // instead of waiting out a minute-long safety poll.
      let wake: AbortController | null = null;
      const onChoice = (): void => wake?.abort();
      choiceListeners.add(onChoice);
      try {
        await refresh();
        while (!signal.aborted) {
          const choice = await choose(false);
          if (choice.backend !== pushFor) {
            // The answering backend changed: move the live stream with it.
            stopPush();
            pushFor = choice.backend;
            const backend = choice.backend;
            if (backend?.watch !== undefined) {
              const stop = new AbortController();
              pushStop = stop;
              const onAbort = (): void => stop.abort();
              signal.addEventListener('abort', onAbort, { once: true });
              void backend
                .watch(poke, { signal: stop.signal })
                .catch(() => undefined)
                .finally(() => signal.removeEventListener('abort', onAbort));
            }
          }
          const w = new AbortController();
          wake = w;
          const onStop = (): void => w.abort();
          signal.addEventListener('abort', onStop, { once: true });
          await sleep(pushStop !== null ? pushPollMs : pollMs, w.signal);
          signal.removeEventListener('abort', onStop);
          wake = null;
          if (!signal.aborted) await refresh();
        }
      } finally {
        choiceListeners.delete(onChoice);
        stopPush();
        if (debounce !== undefined) clearTimeout(debounce);
      }
    },
    backendKind: () => kind,
    reset() {
      current = null;
      kind = 'unknown';
      standIn = false;
    },
  };
  return adapter;
}
