/**
 * PAIRING — two Bobbles agreeing to trust each other, with the person watching.
 *
 * Bluetooth-style numeric comparison (devices-tailscale §4.5). WireGuard
 * already rules out a man in the middle; the six digits prove the person
 * approved THIS request, from THIS computer:
 *
 *   1. The client sends `{clientId, clientName, clientNonce}`.
 *   2. The serving device asks Tailscale who is calling (whois), applies the
 *      rate limits, and answers `{requestId, serverNonce, serverId, status}`.
 *   3. Both sides compute the same 6-digit code from the two nonces and ids.
 *   4. The serving device auto-approves its owner's own devices when "Trust my
 *      devices" is on, and otherwise shows the approval dialog with the code.
 *   5. On approval it mints a 256-bit token and hands it over ONCE, on the
 *      client's next poll — only then is the client recorded (hash only).
 *
 * Limits, per calling node (its Tailscale StableID, not anything it claims):
 * one pending request at a time (a new one supersedes it), five requests a
 * minute, and a lock-out after five denials. Requests expire after 120 s; an
 * approved token nobody collected within 120 s of approval is dropped, and
 * nothing was persisted for it.
 *
 * Transport-free and Electron-free: the gateway (DEV-4) maps these results to
 * HTTP and the long-poll; the dialog (DEV-7) renders `pending()` and the
 * events.
 */
import { createHash } from 'node:crypto';
import {
  hashToken,
  mintId,
  mintNonce,
  mintToken,
  type RandomBytes,
  tokenFingerprint,
} from './tokens.js';
import {
  type CallerKind,
  DEFAULT_SCOPES,
  type DeviceScopes,
  decideTrust,
  type PairingMode,
  type PeerIdentity,
} from './trust-policy.js';

/** A request, and an approved-but-uncollected token, live this long. */
export const PAIR_TTL_MS = 120_000;
/** Pairing requests one node may make per rolling minute. */
export const PAIR_REQUESTS_PER_MINUTE = 5;
/** Denials from one node before it is locked out. */
export const PAIR_LOCKOUT_AFTER_DENIALS = 5;
/** How long a lock-out lasts (the plan leaves the length open; an hour is the default here). */
export const PAIR_LOCKOUT_MS = 60 * 60_000;
/** Pending requests across all callers, so a flood cannot grow memory. */
export const PAIR_MAX_PENDING = 16;

const SAS_CONTEXT = 'bobble-pair-sas-v1';

export interface SasInput {
  readonly clientNonce: string;
  readonly serverNonce: string;
  readonly clientId: string;
  readonly serverId: string;
}

/**
 * The 6-digit comparison code: SHA-256 over the two nonces and the two ids,
 * the first 32 bits mod 10^6, zero-padded. Each field is length-prefixed (and
 * the whole domain-separated) so no two different inputs can concatenate to
 * the same bytes. Both sides call this; the codes match only when both saw the
 * same four values.
 */
export function computeSas(input: SasInput): string {
  const h = createHash('sha256');
  for (const part of [
    SAS_CONTEXT,
    input.clientNonce,
    input.serverNonce,
    input.clientId,
    input.serverId,
  ]) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    h.update(len);
    h.update(bytes);
  }
  return String(h.digest().readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** "482913" → "482 913", as both dialogs show it. */
export function formatSas(sas: string): string {
  return sas.length === 6 ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas;
}

/** What a client sends to start pairing. */
export interface PairRequest {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientNonce: string;
}

/**
 * Control characters and bidi controls (U+200E/F, U+202A–E, U+2066–9, U+061C): never in a
 * name shown in a security dialog, where an override could make one name read as another.
 */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Bidi_Control}]/gu;

/** A pairing request body, validated; null when any field is unusable. */
export function validatePairRequest(body: unknown): PairRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.clientId !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(o.clientId)) return null;
  if (typeof o.clientNonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(o.clientNonce)) {
    return null;
  }
  if (typeof o.clientName !== 'string') return null;
  const clientName = o.clientName.replace(UNSAFE_NAME_CHARS, '').trim().slice(0, 100);
  if (clientName === '') return null;
  return { clientId: o.clientId, clientName, clientNonce: o.clientNonce };
}

/** The client's half: its request, and the code it must show. */
export interface ClientPairing {
  readonly request: PairRequest;
  /** The code to show; it must equal the one on the serving device. */
  sas(serverNonce: string, serverId: string): string;
}

export function beginPairing(
  client: { readonly clientId: string; readonly clientName: string },
  random?: RandomBytes,
): ClientPairing {
  const request: PairRequest = {
    clientId: client.clientId,
    clientName: client.clientName,
    clientNonce: mintNonce(random),
  };
  return {
    request,
    sas: (serverNonce, serverId) =>
      computeSas({
        clientNonce: request.clientNonce,
        serverNonce,
        clientId: request.clientId,
        serverId,
      }),
  };
}

export type PairStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

/** What the approval dialog on the serving device shows. */
export interface PendingPairView {
  readonly requestId: string;
  readonly clientId: string;
  /** What the client calls itself — a claim. */
  readonly clientName: string;
  /** Who Tailscale says it is — the part to trust. */
  readonly caller: CallerKind;
  readonly nodeName?: string;
  readonly loginName?: string;
  readonly displayName?: string;
  readonly sas: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type PairStartResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly serverNonce: string;
      readonly serverId: string;
      /** `approved`: auto-approved — collect the token with the next poll. */
      readonly status: 'pending' | 'approved';
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 409 | 429;
      readonly error:
        | 'invalid'
        | 'closed'
        | 'no-identity'
        | 'locked-out'
        | 'rate-limited'
        | 'busy'
        | 'id-conflict';
      readonly retryAfterMs?: number;
    };

export type PairPollResult =
  | { readonly status: 'pending'; readonly expiresAt: number }
  /** The token, exactly once. */
  | {
      readonly status: 'approved';
      readonly token: string;
      readonly clientId: string;
      readonly scopes: DeviceScopes;
      readonly fingerprint: string;
    }
  /** Approved, and the token was already handed over. */
  | { readonly status: 'approved'; readonly delivered: true }
  | { readonly status: 'denied' | 'expired' | 'cancelled' | 'unknown' }
  /** Recording the client failed; the token was withheld (poll again). */
  | { readonly status: 'error'; readonly error: string };

/** The serving side's record of a client, written when its token is handed over. */
export interface NewClientRecord {
  readonly id: string;
  readonly name: string;
  readonly tsStableId: string;
  readonly tsUserId: string;
  readonly loginName?: string;
  readonly tokenHash: string;
  readonly scopes: DeviceScopes;
  readonly auto: boolean;
  readonly approvedAt: number;
}

export type PairEvent =
  /** Show the approval dialog. */
  | { readonly type: 'request'; readonly request: PendingPairView }
  /** Close it: approved, denied, expired, superseded or cancelled. */
  | { readonly type: 'resolved'; readonly requestId: string; readonly status: PairStatus }
  /** A client now holds a token ("my-macbook-pro connected"). */
  | {
      readonly type: 'paired';
      readonly clientId: string;
      readonly name: string;
      readonly auto: boolean;
      readonly fingerprint: string;
    };

export interface PairingManagerDeps {
  /** This install's device id (devices.json `selfId`). */
  readonly serverId: string;
  /** The policy inputs, read at each request (settings change). */
  readonly trust: () => { readonly pairing: PairingMode; readonly selfUserId?: string };
  /** Scopes a new client gets (settings `sharing.scopes`). Default chat + generate. */
  readonly scopes?: () => DeviceScopes;
  /** Record the client as its token is handed over. Throwing withholds the token. */
  readonly persistClient: (client: NewClientRecord) => Promise<void>;
  /**
   * Is this client id already held by a different node? A client's id is its
   * own claim (and public in its hello), so a request reusing another node's
   * id is refused up front (409) instead of replacing that node's record.
   */
  readonly clientIdConflict?: (clientId: string, stableId: string) => boolean;
  readonly onEvent?: (event: PairEvent) => void;
  readonly now?: () => number;
  readonly random?: RandomBytes;
  readonly ttlMs?: number;
  readonly perPeerPerMinute?: number;
  readonly lockoutAfterDenials?: number;
  readonly lockoutMs?: number;
  readonly maxPending?: number;
}

export interface PairingManager {
  /** POST /cluster/pair. `peer` is whois of the source address (null when unknown). */
  start(body: unknown, peer: PeerIdentity | null): PairStartResult;
  /** GET /cluster/pair/:id — only the node that asked may poll its request. */
  poll(requestId: string, peer: PeerIdentity | null): Promise<PairPollResult>;
  /** The long-poll: resolves when the request leaves `pending`, or after `timeoutMs`. */
  waitForChange(
    requestId: string,
    peer: PeerIdentity | null,
    opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<PairPollResult>;
  /** The dialog's Allow. */
  approve(requestId: string, opts?: { readonly scopes?: DeviceScopes }): boolean;
  /** The dialog's Deny. */
  deny(requestId: string): boolean;
  /** The client gave up (its Cancel). */
  cancel(requestId: string, peer: PeerIdentity | null): boolean;
  /** Requests waiting for the person, oldest first. */
  pending(): PendingPairView[];
  /** Expire what is due. Every call above sweeps first; timers need not. */
  sweep(): void;
}

interface Entry {
  readonly requestId: string;
  readonly req: PairRequest;
  readonly peer: PeerIdentity;
  readonly caller: CallerKind;
  readonly serverNonce: string;
  readonly sas: string;
  readonly createdAt: number;
  expiresAt: number;
  status: PairStatus;
  auto: boolean;
  scopes?: DeviceScopes;
  token?: string;
  approvedAt?: number;
  delivered: boolean;
  delivering?: Promise<PairPollResult>;
  finishedAt?: number;
  readonly waiters: Set<() => void>;
}

interface PeerState {
  times: number[];
  denials: number;
  lockedUntil?: number;
}

/** How long a finished request is remembered (so a late poll gets its answer). */
const FINISHED_RETENTION_MS = 10 * 60_000;

function cleanScopes(s: DeviceScopes | undefined, fallback: DeviceScopes): DeviceScopes {
  if (s === undefined) return fallback;
  return { chat: s.chat === true, generate: s.generate === true, manage: s.manage === true };
}

export function createPairingManager(deps: PairingManagerDeps): PairingManager {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? PAIR_TTL_MS;
  const perMinute = deps.perPeerPerMinute ?? PAIR_REQUESTS_PER_MINUTE;
  const lockoutAfter = deps.lockoutAfterDenials ?? PAIR_LOCKOUT_AFTER_DENIALS;
  const lockoutMs = deps.lockoutMs ?? PAIR_LOCKOUT_MS;
  const maxPending = deps.maxPending ?? PAIR_MAX_PENDING;
  const defaultScopes = (): DeviceScopes => cleanScopes(deps.scopes?.(), DEFAULT_SCOPES);
  const entries = new Map<string, Entry>();
  const peers = new Map<string, PeerState>();

  const emit = (event: PairEvent): void => {
    try {
      deps.onEvent?.(event);
    } catch {
      /* a listener's failure is not pairing's */
    }
  };
  const wake = (e: Entry): void => {
    for (const w of e.waiters) w();
    e.waiters.clear();
  };
  const finish = (e: Entry, status: PairStatus): void => {
    e.status = status;
    e.finishedAt = now();
    delete e.token;
    wake(e);
    emit({ type: 'resolved', requestId: e.requestId, status });
  };
  const peerState = (key: string): PeerState => {
    let s = peers.get(key);
    if (s === undefined) {
      s = { times: [], denials: 0 };
      peers.set(key, s);
    }
    return s;
  };
  const view = (e: Entry): PendingPairView => ({
    requestId: e.requestId,
    clientId: e.req.clientId,
    clientName: e.req.clientName,
    caller: e.caller,
    ...(e.peer.nodeName !== undefined ? { nodeName: e.peer.nodeName } : {}),
    ...(e.peer.loginName !== undefined ? { loginName: e.peer.loginName } : {}),
    ...(e.peer.displayName !== undefined ? { displayName: e.peer.displayName } : {}),
    sas: e.sas,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
  });
  const approveEntry = (e: Entry, scopes: DeviceScopes, auto: boolean): void => {
    const t = now();
    e.status = 'approved';
    e.auto = auto;
    e.scopes = scopes;
    e.token = mintToken(deps.random);
    e.approvedAt = t;
    // The client has a fresh 120 s to collect it, however late the Allow came.
    e.expiresAt = t + ttl;
    peerState(e.peer.stableId).denials = 0;
    wake(e);
    emit({ type: 'resolved', requestId: e.requestId, status: 'approved' });
  };

  const sweep = (): void => {
    const t = now();
    for (const [id, e] of entries) {
      if (e.status === 'pending' && t >= e.expiresAt) finish(e, 'expired');
      else if (
        e.status === 'approved' &&
        !e.delivered &&
        e.delivering === undefined &&
        t >= e.expiresAt
      ) {
        // Nobody collected the token: it is dropped, and nothing was recorded for it.
        finish(e, 'expired');
      }
      if (e.finishedAt !== undefined && t - e.finishedAt > FINISHED_RETENTION_MS)
        entries.delete(id);
    }
    for (const [key, s] of peers) {
      s.times = s.times.filter((x) => t - x < 60_000);
      if (s.lockedUntil !== undefined && t >= s.lockedUntil) {
        delete s.lockedUntil;
        s.denials = 0;
      }
      if (s.times.length === 0 && s.denials === 0 && s.lockedUntil === undefined) peers.delete(key);
    }
  };

  const ownedBy = (e: Entry | undefined, peer: PeerIdentity | null): e is Entry =>
    e !== undefined && peer !== null && peer.stableId === e.peer.stableId;

  const poll = async (requestId: string, peer: PeerIdentity | null): Promise<PairPollResult> => {
    sweep();
    const e = entries.get(requestId);
    if (!ownedBy(e, peer)) return { status: 'unknown' };
    switch (e.status) {
      case 'pending':
        return { status: 'pending', expiresAt: e.expiresAt };
      case 'approved': {
        if (e.delivered) return { status: 'approved', delivered: true };
        if (e.delivering !== undefined) {
          // Someone else's poll is handing it over right now: this one is not it.
          await e.delivering.catch(() => undefined);
          return e.delivered
            ? { status: 'approved', delivered: true }
            : { status: 'pending', expiresAt: e.expiresAt };
        }
        const token = e.token;
        const scopes = e.scopes ?? defaultScopes();
        if (token === undefined) return { status: 'expired' };
        e.delivering = (async (): Promise<PairPollResult> => {
          const tokenHash = hashToken(token);
          await deps.persistClient({
            id: e.req.clientId,
            name: e.req.clientName,
            tsStableId: e.peer.stableId,
            tsUserId: e.peer.userId,
            ...(e.peer.loginName !== undefined ? { loginName: e.peer.loginName } : {}),
            tokenHash,
            scopes,
            auto: e.auto,
            approvedAt: e.approvedAt ?? now(),
          });
          e.delivered = true;
          e.finishedAt = now();
          delete e.token;
          const fingerprint = tokenFingerprint(token);
          emit({
            type: 'paired',
            clientId: e.req.clientId,
            name: e.req.clientName,
            auto: e.auto,
            fingerprint,
          });
          return { status: 'approved', token, clientId: e.req.clientId, scopes, fingerprint };
        })();
        try {
          return await e.delivering;
        } catch (error) {
          return { status: 'error', error: error instanceof Error ? error.message : String(error) };
        } finally {
          delete e.delivering;
        }
      }
      default:
        return { status: e.status };
    }
  };

  return {
    start(body, peer) {
      sweep();
      const req = validatePairRequest(body);
      if (req === null) return { ok: false, status: 400, error: 'invalid' };
      const decision = decideTrust(peer, deps.trust());
      if (decision.kind === 'reject' || peer === null) {
        return {
          ok: false,
          status: 403,
          error: decision.kind === 'reject' ? decision.reason : 'no-identity',
        };
      }
      const t = now();
      const state = peerState(peer.stableId);
      if (state.lockedUntil !== undefined && t < state.lockedUntil) {
        return { ok: false, status: 403, error: 'locked-out', retryAfterMs: state.lockedUntil - t };
      }
      if (state.times.length >= perMinute) {
        const oldest = state.times[0] ?? t;
        return {
          ok: false,
          status: 429,
          error: 'rate-limited',
          retryAfterMs: Math.max(1, oldest + 60_000 - t),
        };
      }
      // One pending request per node: a new one supersedes the old.
      for (const e of entries.values()) {
        if (e.status === 'pending' && e.peer.stableId === peer.stableId) finish(e, 'cancelled');
      }
      let pendingCount = 0;
      for (const e of entries.values()) if (e.status === 'pending') pendingCount += 1;
      if (pendingCount >= maxPending) {
        return { ok: false, status: 429, error: 'busy', retryAfterMs: ttl };
      }
      state.times.push(t);
      if (deps.clientIdConflict?.(req.clientId, peer.stableId) === true) {
        return { ok: false, status: 409, error: 'id-conflict' };
      }
      const serverNonce = mintNonce(deps.random);
      const entry: Entry = {
        requestId: mintId('pair', deps.random),
        req,
        peer,
        caller: decision.caller,
        serverNonce,
        sas: computeSas({
          clientNonce: req.clientNonce,
          serverNonce,
          clientId: req.clientId,
          serverId: deps.serverId,
        }),
        createdAt: t,
        expiresAt: t + ttl,
        status: 'pending',
        auto: false,
        delivered: false,
        waiters: new Set(),
      };
      entries.set(entry.requestId, entry);
      if (decision.kind === 'auto') approveEntry(entry, defaultScopes(), true);
      else emit({ type: 'request', request: view(entry) });
      return {
        ok: true,
        requestId: entry.requestId,
        serverNonce,
        serverId: deps.serverId,
        status: entry.status === 'approved' ? 'approved' : 'pending',
        expiresAt: entry.expiresAt,
      };
    },
    poll,
    async waitForChange(requestId, peer, opts) {
      const first = await poll(requestId, peer);
      if (first.status !== 'pending') return first;
      const e = entries.get(requestId);
      // The caller may have gone while the first poll ran: an abort already
      // fired would never reach a listener added now.
      if (e === undefined || opts.signal?.aborted === true) return first;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', done);
          e.waiters.delete(done);
          resolve();
        };
        // Wake at the deadline, or at expiry so the answer says "expired".
        const timer = setTimeout(
          done,
          Math.max(0, Math.min(opts.timeoutMs, e.expiresAt - now() + 1)),
        );
        e.waiters.add(done);
        opts.signal?.addEventListener('abort', done, { once: true });
      });
      return poll(requestId, peer);
    },
    approve(requestId, opts = {}) {
      sweep();
      const e = entries.get(requestId);
      if (e === undefined || e.status !== 'pending') return false;
      approveEntry(e, cleanScopes(opts.scopes, defaultScopes()), false);
      return true;
    },
    deny(requestId) {
      sweep();
      const e = entries.get(requestId);
      if (e === undefined || e.status !== 'pending') return false;
      const state = peerState(e.peer.stableId);
      state.denials += 1;
      if (state.denials >= lockoutAfter) state.lockedUntil = now() + lockoutMs;
      finish(e, 'denied');
      return true;
    },
    cancel(requestId, peer) {
      sweep();
      const e = entries.get(requestId);
      if (!ownedBy(e, peer) || e.status !== 'pending') return false;
      finish(e, 'cancelled');
      return true;
    },
    pending() {
      sweep();
      return [...entries.values()]
        .filter((e) => e.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(view);
    },
    sweep,
  };
}
