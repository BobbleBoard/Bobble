/**
 * WHO IS AT THIS ADDRESS — the identity Tailscale vouches for.
 *
 * `tailscale whois --json <ip>` and the LocalAPI's `/localapi/v0/whois?addr=`
 * answer with the same `apitype.WhoIsResponse`: the node (its stable id, tags,
 * whether it was shared in) and its owner's profile. MEASURED shape:
 *
 *   {Node:{ID, StableID, Name, User, Key, KeyExpiry, Addresses, Hostinfo{OS,
 *    Hostname}, Online, ComputedName, Tags?, Sharer?, …},
 *    UserProfile:{ID, LoginName, DisplayName, ProfilePicURL}, CapMap}
 *
 * This is what binds a pairing token to a machine (devices-tailscale §4.5): the
 * serving side accepts a token only from the node it was issued to, and a
 * client sends one only to the node it paired with. Being on the tailnet is not
 * enough — whois says WHICH node, and whose.
 */
import { idString, parseTailscaleJson, timeField } from './tailscale.js';

export type WhoisResult =
  | {
      readonly found: true;
      /** The node's stable id — the identity a token is bound to. */
      readonly stableId: string;
      /** Short name (ComputedName), e.g. "linux-ms-7e59". */
      readonly nodeName: string;
      /** The machine's own hostname, when reported. */
      readonly hostName?: string;
      readonly os?: string;
      /** Owner's user id (decimal string). For a tagged node, the "tagged-devices" user. */
      readonly userId: string;
      readonly loginName: string;
      readonly displayName: string;
      /** ACL tags: a tagged node has no human owner. */
      readonly tags: readonly string[];
      /** Shared into this tailnet from another one (Node.Sharer is set). */
      readonly shared: boolean;
      /** Who shared it, when shared. */
      readonly sharerUserId?: string;
      readonly online?: boolean;
      readonly keyExpiry?: string;
      /** Tailnet addresses without the prefix length. */
      readonly addresses: readonly string[];
    }
  | {
      readonly found: false;
      /** `not-found`: no node has that address. `error`: the lookup itself failed. */
      readonly reason: 'not-found' | 'error';
      readonly detail: string;
    };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Read a whois answer — the CLI's `--json` text or the LocalAPI's body, as text
 * or already parsed. Anything without a node stable id and an owner id is not
 * an identity, and says so rather than guessing.
 */
export function parseWhois(input: string | unknown): WhoisResult {
  let doc: unknown = input;
  if (typeof input === 'string') {
    try {
      doc = parseTailscaleJson(input);
    } catch {
      return { found: false, reason: 'error', detail: 'whois returned something that is not JSON' };
    }
  }
  if (typeof doc !== 'object' || doc === null) {
    return { found: false, reason: 'error', detail: 'whois returned no object' };
  }
  const o = doc as Record<string, unknown>;
  const node =
    typeof o.Node === 'object' && o.Node !== null ? (o.Node as Record<string, unknown>) : undefined;
  const profile =
    typeof o.UserProfile === 'object' && o.UserProfile !== null
      ? (o.UserProfile as Record<string, unknown>)
      : undefined;
  const stableId = str(node?.StableID);
  const userId = idString(profile?.ID) ?? idString(node?.User);
  if (node === undefined || stableId === undefined || userId === undefined) {
    return { found: false, reason: 'error', detail: 'whois answer carries no node identity' };
  }
  const hostinfo =
    typeof node.Hostinfo === 'object' && node.Hostinfo !== null
      ? (node.Hostinfo as Record<string, unknown>)
      : {};
  const sharer = idString(node.Sharer);
  const tags = Array.isArray(node.Tags)
    ? node.Tags.filter((t): t is string => typeof t === 'string' && t !== '')
    : [];
  const addresses = Array.isArray(node.Addresses)
    ? node.Addresses.filter((a): a is string => typeof a === 'string').map((a) =>
        a.replace(/\/\d+$/, ''),
      )
    : [];
  const hostName = str(hostinfo.Hostname);
  const os = str(hostinfo.OS);
  const keyExpiry = timeField(node.KeyExpiry);
  const name = str(node.ComputedName) ?? str(node.Name)?.split('.')[0] ?? stableId;
  return {
    found: true,
    stableId,
    nodeName: name,
    ...(hostName !== undefined ? { hostName } : {}),
    ...(os !== undefined ? { os } : {}),
    userId,
    loginName: typeof profile?.LoginName === 'string' ? profile.LoginName : '',
    displayName: typeof profile?.DisplayName === 'string' ? profile.DisplayName : '',
    tags,
    shared: sharer !== undefined,
    ...(sharer !== undefined ? { sharerUserId: sharer } : {}),
    ...(typeof node.Online === 'boolean' ? { online: node.Online } : {}),
    ...(keyExpiry !== undefined ? { keyExpiry } : {}),
    addresses,
  };
}

/**
 * A whois failure message as a result: "peer not found" (CLI, MEASURED) and
 * "no match for IP:port" (LocalAPI 404, MEASURED) are ordinary answers.
 */
export function whoisFailure(detail: string): WhoisResult {
  const d = detail.toLowerCase();
  const notFound =
    d.includes('peer not found') || d.includes('no match for') || d.includes('not found');
  return { found: false, reason: notFound ? 'not-found' : 'error', detail: detail.trim() };
}

/** "::ffff:100.101.102.110" → "100.101.102.110"; anything else unchanged. */
function unmapV4(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m?.[1] ?? addr;
}

/** The IP of an `ip`, `ip:port` or `[v6]:port` address — whois identity is per address, not per port. */
export function whoisKey(addr: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(addr);
  if (bracketed !== null) return unmapV4(bracketed[1] ?? addr);
  /*
   * A dual-stack listener reports an IPv4 caller as "::ffff:100.101.102.110";
   * Tailscale knows it only as 100.101.102.110.
   */
  const mapped = unmapV4(addr);
  if (mapped !== addr) return mapped;
  // v4 with a port; a bare v6 has several colons and no port.
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(addr);
  if (v4 !== null) return v4[1] ?? addr;
  return addr;
}

export interface WhoisCache {
  /** The identity at `addr` (port ignored), from cache when fresh. */
  get(addr: string): Promise<WhoisResult>;
  /** Forget one address, or everything (Tailscale restarted, a node was removed). */
  invalidate(addr?: string): void;
  readonly size: number;
}

/**
 * Whois, cached per IP for a minute (the gateway checks it on every request,
 * devices-tailscale §4.5 step 6). Found identities are cached; failures are
 * not, so a node that just joined is recognised on its next request. Lookups
 * for the same address in flight at once share one call.
 */
export function createWhoisCache(
  lookup: (addr: string) => Promise<WhoisResult>,
  opts: { ttlMs?: number; max?: number; now?: () => number } = {},
): WhoisCache {
  const ttl = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 256;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; result: WhoisResult }>();
  const inflight = new Map<string, Promise<WhoisResult>>();
  return {
    async get(addr) {
      const key = whoisKey(addr);
      const hit = entries.get(key);
      if (hit !== undefined && now() - hit.at < ttl) {
        // Refresh recency: Map iteration order is the LRU order.
        entries.delete(key);
        entries.set(key, hit);
        return hit.result;
      }
      if (hit !== undefined) entries.delete(key);
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      const p = (async () => {
        try {
          const result = await lookup(key);
          if (result.found) {
            entries.set(key, { at: now(), result });
            while (entries.size > max) {
              const oldest = entries.keys().next().value;
              if (oldest === undefined) break;
              entries.delete(oldest);
            }
          }
          return result;
        } catch (error) {
          return whoisFailure(error instanceof Error ? error.message : String(error));
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    invalidate(addr) {
      if (addr === undefined) entries.clear();
      else entries.delete(whoisKey(addr));
    },
    get size() {
      return entries.size;
    },
  };
}
