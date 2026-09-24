/**
 * STAYING CURRENT — a live view of the tailnet that survives the daemon.
 *
 * The LocalAPI's `watch-ipn-bus` is a long-lived stream of `ipn.Notify` lines.
 * Streams end: Tailscale restarts, the laptop sleeps, and the daemon closes a
 * watcher that has been idle for about a minute (reported upstream, #21220).
 * A watch that stops at the first close shows a Devices list that silently
 * freezes, so every end here is followed by a reconnect — at once when the
 * stream was healthy (it said something before it ended), with a doubling
 * backoff when it fails without a word (the daemon is down).
 *
 * What the stream SAYS is only used as "something changed, read the status
 * again": the Notify schema is internal to Tailscale and changes between
 * versions, while the status document is what the parser already reads.
 */
import type { TailnetStatus } from './tailscale.js';

/** Sleep that ends early (without throwing) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** One connection of a line stream: resolve when it ends, reject when it fails. */
export type LineStreamConnect = (
  onLine: (line: string) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface ReconnectOptions {
  readonly signal: AbortSignal;
  /** Wait after a healthy stream ends, and the first wait after a failure. Default 500 ms. */
  readonly minBackoffMs?: number;
  /** Cap on the doubling wait while connections keep failing. Default 30 s. */
  readonly maxBackoffMs?: number;
  /** Observes each connection's end (tests, diagnostics). */
  readonly onConnectionEnd?: (info: {
    readonly attempt: number;
    readonly lines: number;
    readonly error?: unknown;
  }) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Keep a line stream open until `signal` aborts, reconnecting after every end.
 * Resolves only on abort.
 */
export async function runWithReconnect(
  connect: LineStreamConnect,
  onLine: (line: string) => void,
  opts: ReconnectOptions,
): Promise<void> {
  const min = opts.minBackoffMs ?? 500;
  const max = opts.maxBackoffMs ?? 30_000;
  const wait = opts.sleep ?? sleep;
  let backoff = min;
  let attempt = 0;
  while (!opts.signal.aborted) {
    attempt += 1;
    let lines = 0;
    let error: unknown;
    try {
      await connect((line) => {
        lines += 1;
        onLine(line);
      }, opts.signal);
    } catch (e) {
      error = e;
    }
    if (opts.signal.aborted) return;
    opts.onConnectionEnd?.({ attempt, lines, ...(error !== undefined ? { error } : {}) });
    if (lines > 0) {
      // It was working, then it ended (the idle close): straight back.
      backoff = min;
      await wait(min, opts.signal);
    } else {
      await wait(backoff, opts.signal);
      backoff = Math.min(max, backoff * 2);
    }
  }
}

/** Notify fields that carry no news about devices: counters and bookkeeping. */
const QUIET_NOTIFY_KEYS: ReadonlySet<string> = new Set(['Version', 'SessionID', 'Engine']);

/**
 * Does this `ipn.Notify` line mean the device list may have changed?
 *
 * MEASURED on 1.102.4: the first message is `{Version, SessionID, State: 6}`
 * (state news), then `{Version, Engine: {…}}` traffic counters (not news).
 * Anything with a non-empty field other than the quiet ones — State, NetMap,
 * Prefs, Health, LoginFinished, BrowseToURL, ErrMessage, and whatever a later
 * version adds — is treated as news.
 */
export function notifyNeedsRefresh(line: string): boolean {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  return Object.entries(o as Record<string, unknown>).some(
    ([k, v]) =>
      !QUIET_NOTIFY_KEYS.has(k) &&
      v !== null &&
      v !== undefined &&
      v !== '' &&
      v !== false &&
      !(Array.isArray(v) && v.length === 0),
  );
}

/**
 * A digest of everything a Devices surface shows. Two statuses with the same
 * digest look the same, so a watcher reports only real changes — the daemon's
 * minute-by-minute reconnects and traffic counters do not repaint the list.
 */
export function statusDigest(s: TailnetStatus): string {
  const peers = [...s.peers]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => [
      p.id,
      p.hostname,
      p.os,
      p.ip,
      p.self,
      p.online,
      p.active,
      p.expired,
      p.dnsName ?? '',
      p.curAddr ?? '',
      p.relay ?? '',
      p.peerRelay ?? '',
      p.lastSeen ?? '',
      p.keyExpiry ?? '',
      p.userId ?? '',
      p.tags.join(','),
      p.sharee,
    ]);
  return JSON.stringify([
    s.available,
    s.state ?? '',
    s.reason ?? '',
    s.authUrl ?? '',
    s.selfUserId ?? '',
    s.tailnet ?? null,
    s.health ?? [],
    peers,
  ]);
}
