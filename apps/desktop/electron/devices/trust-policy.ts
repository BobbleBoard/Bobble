/**
 * WHO MAY USE THIS COMPUTER'S MODELS — the rules, and nothing else.
 *
 * Being on the tailnet is not permission (devices-tailscale §4.5, §4.11): a
 * family or company tailnet has other people's machines on it, and any web
 * page on a trusted device can make requests. So every pairing request is
 * judged on WHO Tailscale says is asking (`whois` of the source address):
 *
 *   | Caller                                          | Default                                     |
 *   |-------------------------------------------------|---------------------------------------------|
 *   | Same Tailscale user, untagged, not shared-in    | One click; auto-approved when "Trust my     |
 *   |                                                 | devices" is on (default on for a one-user   |
 *   |                                                 | tailnet, otherwise off)                     |
 *   | Another user in the tailnet (family/company)    | Approval dialog on this device, with code   |
 *   | Tagged node / shared-in node                    | Approval dialog, labelled "server without   |
 *   |                                                 | an owner" / "shared by <user>"              |
 *   | Request with an Origin header, a foreign Host,  | Rejected (403), no CORS headers ever        |
 *   | or a non-Tailscale source address               |                                             |
 *
 * And after pairing, a token is honoured only from the node it was issued to,
 * and sent only to the node the client paired with (the StableID pinned on
 * both sides), so an address that moves to another machine gets nothing.
 *
 * Pure functions over structural types: the identity shape matches
 * `@pi-desktop/cluster`'s `WhoisResult`, which the gateway will pass straight
 * in (DEV-4), without this file depending on that package.
 */

/** Who Tailscale says a caller is: the whois answer for its source address. */
export interface PeerIdentity {
  /** The node's stable id — what a token is bound to. */
  readonly stableId: string;
  /** The node owner's user id (decimal string). A tagged node's is "tagged-devices". */
  readonly userId: string;
  readonly loginName?: string;
  readonly displayName?: string;
  /** The machine's short name, for the dialog ("my-macbook-pro"). */
  readonly nodeName?: string;
  /** ACL tags. A tagged node has no human owner. */
  readonly tags: readonly string[];
  /** Shared into this tailnet from another one. */
  readonly shared: boolean;
}

/** Who may pair, as this device advertises it in its hello. */
export type PairingMode = 'auto' | 'approval' | 'closed';

/** The dialog's heading for a caller. */
export type CallerKind = 'my-device' | 'other-user' | 'tagged' | 'shared';

export type TrustDecision =
  /** Approve without asking (and announce it). */
  | { readonly kind: 'auto'; readonly caller: 'my-device' }
  /** Show the approval dialog on this device, with the code. */
  | { readonly kind: 'ask'; readonly caller: CallerKind }
  /** Refuse: sharing is closed, or Tailscale could not say who is asking. */
  | { readonly kind: 'reject'; readonly reason: 'closed' | 'no-identity' };

export interface TrustContext {
  /** This device's own Tailscale user id; unknown when this node is tagged. */
  readonly selfUserId?: string;
  readonly pairing: PairingMode;
}

/** The advertised mode for the current settings: off → closed; trust my devices → auto. */
export function pairingModeFor(sharing: {
  readonly enabled: boolean;
  readonly trustMyDevices: boolean;
}): PairingMode {
  if (!sharing.enabled) return 'closed';
  return sharing.trustMyDevices ? 'auto' : 'approval';
}

function hasIdentity(peer: PeerIdentity | null | undefined): peer is PeerIdentity {
  return (
    peer !== null &&
    peer !== undefined &&
    typeof peer.stableId === 'string' &&
    peer.stableId !== '' &&
    typeof peer.userId === 'string' &&
    peer.userId !== ''
  );
}

/**
 * The §4.5 table, exactly. Tags and shares are checked before ownership: a
 * tagged node's "owner" is Tailscale's tagged-devices user, and a shared-in
 * node belongs to someone in another tailnet — neither is "my device" even if
 * an id happened to line up.
 */
export function decideTrust(
  peer: PeerIdentity | null | undefined,
  ctx: TrustContext,
): TrustDecision {
  if (ctx.pairing === 'closed') return { kind: 'reject', reason: 'closed' };
  if (!hasIdentity(peer)) return { kind: 'reject', reason: 'no-identity' };
  if (peer.tags.length > 0) return { kind: 'ask', caller: 'tagged' };
  if (peer.shared) return { kind: 'ask', caller: 'shared' };
  const mine =
    ctx.selfUserId !== undefined && ctx.selfUserId !== '' && peer.userId === ctx.selfUserId;
  if (!mine) return { kind: 'ask', caller: 'other-user' };
  return ctx.pairing === 'auto'
    ? { kind: 'auto', caller: 'my-device' }
    : { kind: 'ask', caller: 'my-device' };
}

/**
 * "Trust my devices" starts ON when the tailnet has one user — every untagged,
 * not-shared node belongs to the same person — and OFF otherwise
 * (devices-tailscale §4.5). Tagged and shared-in nodes have no say.
 */
export function defaultTrustMyDevices(
  nodes: readonly {
    readonly userId?: string;
    readonly tags: readonly string[];
    readonly sharee: boolean;
  }[],
): boolean {
  const users = new Set<string>();
  for (const n of nodes) {
    if (n.tags.length > 0 || n.sharee) continue;
    if (n.userId === undefined || n.userId === '') return false; // an owner we cannot name
    users.add(n.userId);
  }
  return users.size === 1;
}

/**
 * Serving side, every request: the token's record must belong to the node the
 * request came from (whois of the source), not merely to someone who has the
 * token.
 */
export function tokenBoundToPeer(
  record: { readonly tsStableId: string },
  peer: { readonly found: boolean; readonly stableId?: string } | null | undefined,
): boolean {
  return (
    peer !== null &&
    peer !== undefined &&
    peer.found === true &&
    typeof peer.stableId === 'string' &&
    peer.stableId !== '' &&
    peer.stableId === record.tsStableId
  );
}

/**
 * Client side, before sending a token: the address must still be the node
 * paired with (its StableID pinned at pairing). Tailscale can hand an address
 * to another machine; that machine never receives the token.
 */
export function mayPresentToken(
  pinnedStableId: string,
  whois: { readonly found: boolean; readonly stableId?: string } | null | undefined,
): boolean {
  return tokenBoundToPeer({ tsStableId: pinnedStableId }, whois);
}

// --- The shape of a request: origin, host, source ------------------------------

/** What the gateway sees of a request before any route runs. */
export interface RequestShape {
  /** The `Origin` header, if any. A Bobble never sends one; a browser does. */
  readonly origin?: string | undefined;
  /** The `Host` header. */
  readonly host?: string | undefined;
  /** The socket's remote address. */
  readonly remoteAddress?: string | undefined;
}

export type ShapeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403; readonly reason: 'origin' | 'host' | 'source' };

/** An IPv4-mapped IPv6 address ("::ffff:100.101.102.110") as the IPv4 it carries. */
export function normalizeRemoteAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

function ipv4Octets(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** Tailscale addresses: IPv4 100.64.0.0/10 (CGNAT) and IPv6 fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(address: string): boolean {
  const ip = normalizeRemoteAddress(address.trim());
  const v4 = ipv4Octets(ip);
  if (v4 !== null) return v4[0] === 100 && (v4[1] ?? 0) >= 64 && (v4[1] ?? 0) <= 127;
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/** Loopback: 127.0.0.0/8 and ::1. */
export function isLoopbackAddress(address: string): boolean {
  const ip = normalizeRemoteAddress(address.trim());
  const v4 = ipv4Octets(ip);
  if (v4 !== null) return v4[0] === 127;
  return ip === '::1';
}

/** Split a Host header into a lowercased host (no brackets, no trailing dot) and a port. */
export function parseHostHeader(host: string): { host: string; port?: number } | null {
  const h = host.trim().toLowerCase();
  if (h === '') return null;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(h);
  if (bracketed !== null) {
    return {
      host: bracketed[1] ?? '',
      ...(bracketed[2] !== undefined ? { port: Number(bracketed[2]) } : {}),
    };
  }
  const withPort = /^([^:]+):(\d{1,5})$/.exec(h);
  const name = withPort !== null ? (withPort[1] ?? '') : h;
  if (name.includes(':')) return null; // a bare IPv6 must be bracketed in a Host header
  return {
    host: name.replace(/\.$/, ''),
    ...(withPort?.[2] !== undefined ? { port: Number(withPort[2]) } : {}),
  };
}

function hostAllowed(
  hostHeader: string | undefined,
  allowed: readonly string[],
  port: number,
): boolean {
  if (hostHeader === undefined) return false;
  const parsed = parseHostHeader(hostHeader);
  if (parsed === null) return false;
  if (parsed.port !== undefined && parsed.port !== port) return false;
  const names = new Set(
    allowed.map((a) =>
      a
        .trim()
        .toLowerCase()
        .replace(/\.$/, '')
        .replace(/^\[|\]$/g, ''),
    ),
  );
  return names.has(parsed.host);
}

/** How the gateway is reachable: its own tailnet addresses and MagicDNS name, on its port. */
export interface GatewayAddressing {
  readonly hosts: readonly string[];
  readonly port: number;
  /**
   * Accept loopback sources and hosts too. ONLY for `PI_CLUSTER_BIND=127.0.0.1`
   * (two instances on one Mac, under PI_E2E) — never in a shipped setup.
   */
  readonly allowLoopback?: boolean;
}

/**
 * The gateway's first check on every request (the last row of the §4.5 table):
 * no `Origin` (a browser), a `Host` that is this device's own tailnet address
 * or name (DNS rebinding sends the attacker's name), and a source address on
 * the tailnet. Rejections are 403 with no CORS headers.
 */
export function checkGatewayRequest(
  req: RequestShape,
  addressing: GatewayAddressing,
): ShapeVerdict {
  if (req.origin !== undefined) return { ok: false, status: 403, reason: 'origin' };
  const loopbackOk = addressing.allowLoopback === true;
  const hosts = loopbackOk
    ? [...addressing.hosts, '127.0.0.1', 'localhost', '::1']
    : addressing.hosts;
  if (!hostAllowed(req.host, hosts, addressing.port))
    return { ok: false, status: 403, reason: 'host' };
  const src = req.remoteAddress ?? '';
  if (!(isTailscaleAddress(src) || (loopbackOk && isLoopbackAddress(src)))) {
    return { ok: false, status: 403, reason: 'source' };
  }
  return { ok: true };
}

/**
 * The local relay's check (devices-tailscale §4.6.1): loopback source, a
 * loopback `Host` on the relay's port, and no `Origin` — so a web page in the
 * person's own browser cannot borrow the relay and its token.
 */
export function checkRelayRequest(
  req: RequestShape,
  relay: { readonly port: number },
): ShapeVerdict {
  if (req.origin !== undefined) return { ok: false, status: 403, reason: 'origin' };
  if (!hostAllowed(req.host, ['127.0.0.1', 'localhost', '::1'], relay.port)) {
    return { ok: false, status: 403, reason: 'host' };
  }
  if (!isLoopbackAddress(req.remoteAddress ?? ''))
    return { ok: false, status: 403, reason: 'source' };
  return { ok: true };
}

/** Permission a paired client holds on this device. */
export interface DeviceScopes {
  readonly chat: boolean;
  readonly generate: boolean;
  readonly manage: boolean;
}

/** New clients get chat and generation; managing models is opt-in (§4.5 Scopes). */
export const DEFAULT_SCOPES: DeviceScopes = { chat: true, generate: true, manage: false };

/** Does a client with `scopes` get to do `needed`? */
export function scopeAllows(scopes: DeviceScopes, needed: keyof DeviceScopes): boolean {
  return scopes[needed] === true;
}
