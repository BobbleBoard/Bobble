/**
 * THE OTHER MACHINES — finding them, and finding out what they can do.
 *
 * The roadmap's clustering item is "multiple machines over Tailscale, work
 * scheduled across them". Before anything can be scheduled, three questions
 * have to have honest answers: which machines exist, which are reachable right
 * now, and which of them are running Bobble with something to offer. This file
 * answers the first two from Tailscale itself; {@link probePeer} answers the
 * third by asking the machine.
 *
 * WRITTEN CROSS-PLATFORM FROM THE FIRST LINE, deliberately. Everything else in
 * this app that touches the OS was written for macOS and is now a port, which
 * the roadmap names as the expensive part of running anywhere else. A feature
 * whose entire purpose is to reach Windows and Linux boxes should not repeat
 * that: the only platform-specific thing here is WHERE the tailscale binary
 * lives, and that is a list.
 *
 * NOTHING HERE TRUSTS THE NETWORK. `tailscale status --json` is parsed
 * defensively (a version bump that renames a field must degrade to "no peers",
 * never throw), and a peer's self-report is treated as a claim to be checked,
 * not a fact.
 */

/** Where the CLI actually is, per platform. */
export const TAILSCALE_PATHS: Readonly<Record<string, readonly string[]>> = {
  /*
   * macOS: the App Store build hides the CLI inside the bundle and does NOT put
   * it on PATH — `which tailscale` fails on a machine where Tailscale is
   * running perfectly well, which is exactly the false negative that would make
   * this feature look broken on a working setup. MEASURED on this machine.
   * The bundle binary is GUI and CLI in one: spawn it only through
   * `tailscaleCliEnv` (host.ts), or it can open Tailscale's window.
   */
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    'tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'],
  /*
   * The strings as Windows spells them. These were once written as
   * `'C\\:\\\\Program Files…'`, which evaluates to `C\:\\Program Files\\…` — not
   * a path at all — and only the bare `tailscale.exe` PATH fallback kept that
   * hidden. The test pins the exact characters.
   */
  win32: [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    'tailscale.exe',
  ],
};

/** A machine on the tailnet, as Tailscale describes it. */
export interface TailnetPeer {
  /** Tailscale's stable node id (`ID` in status, `StableID` in whois). */
  readonly id: string;
  readonly hostname: string;
  /** 'macOS' | 'linux' | 'windows' | … exactly as Tailscale reports it. */
  readonly os: string;
  /**
   * The stable tailnet address everything reaches the peer through: the 100.x
   * IPv4 address, or the fd7a:115c:a1e0::/48 IPv6 one when a node has no v4.
   */
  readonly ip: string;
  /** Every tailnet address, as reported (v4 first on every capture seen). */
  readonly ips: readonly string[];
  readonly online: boolean;
  /** True for the machine this process is running on. */
  readonly self: boolean;
  /** MagicDNS name WITHOUT the trailing dot, for display and Host checks only. */
  readonly dnsName?: string;
  /** The direct UDP endpoint in use; present only when the path is direct. */
  readonly curAddr?: string;
  /** Home DERP region code ("lax"), the relay used when the path is not direct. */
  readonly relay?: string;
  /** A peer relay in use (Tailscale ≥ 1.86), when there is one. */
  readonly peerRelay?: string;
  /** Traffic flowed recently. */
  readonly active: boolean;
  /**
   * When an OFFLINE peer was last seen, as an ISO string. Absent for online
   * peers: Tailscale writes Go's zero time (`0001-01-01T00:00:00Z`) for them,
   * which is "no value", not a date two thousand years ago. MEASURED.
   */
  readonly lastSeen?: string;
  /** Node key expiry (ISO). Absent when expiry is disabled for the node. */
  readonly keyExpiry?: string;
  /** The node key has expired: the device must sign in to Tailscale again. */
  readonly expired: boolean;
  /**
   * Owner's Tailscale user id, as a decimal string. Tailscale ids are int64;
   * they are kept as strings so an id past 2^53 can never compare equal to a
   * different one after rounding.
   */
  readonly userId?: string;
  /** ACL tags ("tag:server"). A tagged node has no human owner. */
  readonly tags: readonly string[];
  /** Present only because it is shared with this tailnet (ShareeNode). */
  readonly sharee: boolean;
}

/**
 * What Tailscale is doing on this machine.
 *
 * The backend states are Tailscale's own (`ipn.State`); two are this package's:
 * `NotInstalled` (no CLI anywhere this platform keeps one) and `NotRunning`
 * (a CLI exists but the daemon did not answer). `Unknown` is output that could
 * not be read.
 */
export type TailnetState =
  | 'NotInstalled'
  | 'NotRunning'
  | 'NoState'
  | 'InUseOtherUser'
  | 'NeedsLogin'
  | 'NeedsMachineAuth'
  | 'Stopped'
  | 'Starting'
  | 'Running'
  | 'Unknown';

/** A Tailscale user profile, keyed by user id in {@link TailnetStatus.users}. */
export interface TailnetUser {
  readonly id: string;
  readonly loginName: string;
  readonly displayName: string;
}

export interface TailnetStatus {
  /** False when Tailscale is not installed, not running, or not logged in. */
  readonly available: boolean;
  /** Why, when it is not available — shown to the user rather than swallowed. */
  readonly reason?: string;
  readonly peers: readonly TailnetPeer[];
  /** The state behind `available`, for the Devices card. */
  readonly state?: TailnetState;
  /** Where to sign in, when Tailscale is waiting for a login (`NeedsLogin`). */
  readonly authUrl?: string;
  /** The daemon's version string. */
  readonly version?: string;
  /** This node's owner. `sameUserPeers` compares against it. */
  readonly selfUserId?: string;
  readonly tailnet?: {
    readonly name?: string;
    readonly magicDnsSuffix?: string;
    readonly magicDnsEnabled?: boolean;
  };
  /** Tailscale's health warnings, verbatim; shown on an amber line. */
  readonly health?: readonly string[];
  /** Every user profile the status mentions, by id. */
  readonly users?: Readonly<Record<string, TailnetUser>>;
}

const BACKEND_STATES: ReadonlySet<string> = new Set([
  'NoState',
  'InUseOtherUser',
  'NeedsLogin',
  'NeedsMachineAuth',
  'Stopped',
  'Starting',
  'Running',
]);

/** Integer-valued id fields in Tailscale's JSON (int64 in Go). */
const ID_KEYS: ReadonlySet<string> = new Set(['ID', 'UserID', 'NodeID', 'User', 'Sharer']);

/**
 * `JSON.parse` that keeps an integer id past 2^53 exact, as its source text.
 *
 * Uses the reviver's source-text argument (V8 ≥ 11.4: every supported Node and
 * Electron). Where a runtime lacks it the value is kept as the number, which is
 * exact for every id seen so far (they sit below 2^53).
 */
export function parseTailscaleJson(json: string): unknown {
  return JSON.parse(json, (key: string, value: unknown, context?: { source?: string }) =>
    ID_KEYS.has(key) &&
    typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    typeof context?.source === 'string'
      ? context.source
      : value,
  );
}

/** A Tailscale id (number or digit string) as a decimal string; undefined for anything else. */
export function idString(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v) && !/^0+$/.test(v)) return v;
  return undefined;
}

/** An RFC 3339 time as an ISO string; undefined for Go's zero time, '' or junk. */
export function timeField(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '' || v.startsWith('0001-01-01')) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** Reads a JSON node object into a peer, tolerating anything missing. */
function toPeer(raw: unknown, self: boolean): TailnetPeer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const ips = strings(o.TailscaleIPs);
  /*
   * v4 first — a v6-first pick would work everywhere except where it does not,
   * which is the worst kind of intermittent — but a v6-only node is still a
   * node: peerUrl brackets it.
   */
  const ip = ips.find((v) => v.includes('.')) ?? ips.find((v) => v.includes(':'));
  const hostname = typeof o.HostName === 'string' ? o.HostName : '';
  if (ip === undefined || hostname === '') return null;
  const dnsName = str(o.DNSName)?.replace(/\.$/, '');
  const curAddr = str(o.CurAddr);
  const relay = str(o.Relay);
  const peerRelay = str(o.PeerRelay);
  const lastSeen = timeField(o.LastSeen);
  const keyExpiry = timeField(o.KeyExpiry);
  const userId = idString(o.UserID);
  return {
    id: typeof o.ID === 'string' && o.ID !== '' ? o.ID : hostname,
    hostname,
    os: typeof o.OS === 'string' ? o.OS : 'unknown',
    ip,
    ips,
    /*
     * Tailscale reports `Online` only for peers; the local node is online by
     * definition — it is the one answering. Reading the missing field as
     * "offline" would hide this machine from its own cluster view.
     */
    online: self ? true : o.Online === true,
    self,
    ...(dnsName !== undefined && dnsName !== '' ? { dnsName } : {}),
    ...(curAddr !== undefined ? { curAddr } : {}),
    ...(relay !== undefined ? { relay } : {}),
    ...(peerRelay !== undefined ? { peerRelay } : {}),
    active: o.Active === true,
    ...(lastSeen !== undefined ? { lastSeen } : {}),
    ...(keyExpiry !== undefined ? { keyExpiry } : {}),
    expired: o.Expired === true,
    ...(userId !== undefined ? { userId } : {}),
    tags: strings(o.Tags),
    sharee: o.ShareeNode === true,
  };
}

function toUsers(raw: unknown): Record<string, TailnetUser> {
  const out: Record<string, TailnetUser> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const u = value as Record<string, unknown>;
    const id = idString(u.ID) ?? idString(key);
    if (id === undefined) continue;
    out[id] = {
      id,
      loginName: typeof u.LoginName === 'string' ? u.LoginName : '',
      displayName: typeof u.DisplayName === 'string' ? u.DisplayName : '',
    };
  }
  return out;
}

/**
 * Parse `tailscale status --json` (the same document the LocalAPI's
 * `/localapi/v0/status` returns).
 *
 * Pure, so the shape handling is testable against real captured output without
 * a tailnet — and every clustering decision downstream depends on this being
 * right about who is reachable.
 */
export function parseTailscaleStatus(json: string): TailnetStatus {
  let parsed: unknown;
  try {
    parsed = parseTailscaleJson(json);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      available: false,
      reason: 'Tailscale returned something that is not JSON.',
      peers: [],
      state: 'Unknown',
    };
  }
  const doc = parsed as Record<string, unknown>;
  const raw = typeof doc.BackendState === 'string' ? doc.BackendState : 'Unknown';
  const state: TailnetState = BACKEND_STATES.has(raw) ? (raw as TailnetState) : 'Unknown';
  const version = str(doc.Version);
  const authUrl = str(doc.AuthURL);
  const health = strings(doc.Health);
  const common = {
    state,
    ...(version !== undefined ? { version } : {}),
    ...(authUrl !== undefined ? { authUrl } : {}),
    ...(health.length > 0 ? { health } : {}),
  };
  if (state !== 'Running') {
    return {
      available: false,
      // The state IS the explanation: "NeedsLogin", "Stopped", "NoState".
      reason: `Tailscale is installed but not running (${raw}).`,
      peers: [],
      ...common,
    };
  }
  const peers: TailnetPeer[] = [];
  const self = toPeer(doc.Self, true);
  if (self !== null) peers.push(self);
  const rawPeers = typeof doc.Peer === 'object' && doc.Peer !== null ? doc.Peer : {};
  for (const rawPeer of Object.values(rawPeers as Record<string, unknown>)) {
    const peer = toPeer(rawPeer, false);
    if (peer !== null) peers.push(peer);
  }
  const ct =
    typeof doc.CurrentTailnet === 'object' && doc.CurrentTailnet !== null
      ? (doc.CurrentTailnet as Record<string, unknown>)
      : undefined;
  const name = str(ct?.Name);
  const magicDnsSuffix = str(ct?.MagicDNSSuffix) ?? str(doc.MagicDNSSuffix);
  const tailnet =
    ct !== undefined || magicDnsSuffix !== undefined
      ? {
          ...(name !== undefined ? { name } : {}),
          ...(magicDnsSuffix !== undefined ? { magicDnsSuffix } : {}),
          ...(typeof ct?.MagicDNSEnabled === 'boolean'
            ? { magicDnsEnabled: ct.MagicDNSEnabled }
            : {}),
        }
      : undefined;
  return {
    available: true,
    peers,
    ...common,
    ...(self?.userId !== undefined ? { selfUserId: self.userId } : {}),
    ...(tailnet !== undefined ? { tailnet } : {}),
    users: toUsers(doc.User),
  };
}

/**
 * The peers discovery may knock on: this user's own devices, nothing else.
 *
 * Same owner as this node (`UserID`), untagged (a tagged node has no human
 * owner), not shared in from another tailnet, and not this machine. On a
 * family or company tailnet everything else belongs to someone else, and
 * probing it would be a port scan of their machines (devices-tailscale §4.4).
 * A tagged self has no "same user" at all, so it gets none. Online-ness is
 * left to the caller: an offline device is still listed, just not probed.
 */
export function sameUserPeers(status: TailnetStatus): TailnetPeer[] {
  const me = status.selfUserId;
  if (!status.available || me === undefined) return [];
  const self = status.peers.find((p) => p.self);
  if (self !== undefined && self.tags.length > 0) return [];
  return status.peers.filter((p) => !p.self && p.userId === me && p.tags.length === 0 && !p.sharee);
}

// --- The Bobble node's public hello and authenticated info ---------------------

/** The node protocol's major version. A peer on another major is refused with "update Bobble". */
export const NODE_PROTOCOL = 1;

/** The port a Bobble offers its cluster surface on. */
export const CLUSTER_PORT = 8765;

/** The path a peer answers `GET` on with its {@link NodeHello}. Unauthenticated. */
export const CLUSTER_HELLO_PATH = '/cluster/hello';

/** The path a paired client reads {@link NodeInfo} from. Bearer token, scope `chat`. */
export const CLUSTER_INFO_PATH = '/cluster/info';

/** Who may pair with a node: auto-approve its owner's devices, ask each time, or nobody. */
export type PairingMode = 'auto' | 'approval' | 'closed';

/**
 * `GET /cluster/hello` — the ONLY thing a Bobble says to a caller it does not
 * know. Anyone on the tailnet can ask, so it names the app and how to pair,
 * and nothing else: no hardware, no models, no load. Those are in
 * {@link NodeInfo}, behind a token (devices-tailscale §4.3).
 */
export interface NodeHello {
  readonly app: 'bobble';
  readonly protocol: number;
  readonly version: string;
  /** The install's device id (`devices.json` `selfId`). */
  readonly id: string;
  readonly name: string;
  readonly os: string;
  /** Sharing is on: this node serves paired devices. */
  readonly sharing: boolean;
  readonly pairing: PairingMode;
}

const PAIRING_MODES: ReadonlySet<string> = new Set(['auto', 'approval', 'closed']);

/** Upper bound on any string a hello carries — a claim, not a document. */
const HELLO_STRING_MAX = 200;

function helloString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' && v.length <= HELLO_STRING_MAX ? v : undefined;
}

/**
 * Build the hello a node sends: exactly the eight fields, whatever the caller
 * passed. The gateway builds its answer here, so an extra field cannot leak
 * into the one unauthenticated route by being spread in by accident.
 */
export function buildHello(input: Omit<NodeHello, 'app' | 'protocol'>): NodeHello {
  return {
    app: 'bobble',
    protocol: NODE_PROTOCOL,
    version: input.version,
    id: input.id,
    name: input.name,
    os: input.os,
    sharing: input.sharing,
    pairing: input.pairing,
  };
}

/**
 * Read a peer's hello, or null when it is not a Bobble hello.
 *
 * Something else may answer on 8765 (AnkiConnect's default port), so a body
 * without `app: 'bobble'` is "not Bobble", not an error. Fields beyond the
 * eight are dropped rather than passed on.
 */
export function parseHello(body: unknown): NodeHello | null {
  if (typeof body !== 'object' || body === null) return null;
  const o = body as Record<string, unknown>;
  if (o.app !== 'bobble') return null;
  const version = helloString(o.version);
  const id = helloString(o.id);
  const name = helloString(o.name);
  const os = helloString(o.os);
  if (
    typeof o.protocol !== 'number' ||
    !Number.isInteger(o.protocol) ||
    o.protocol < 1 ||
    version === undefined ||
    id === undefined ||
    name === undefined ||
    os === undefined ||
    typeof o.sharing !== 'boolean' ||
    typeof o.pairing !== 'string' ||
    !PAIRING_MODES.has(o.pairing)
  ) {
    return null;
  }
  return {
    app: 'bobble',
    protocol: o.protocol,
    version,
    id,
    name,
    os,
    sharing: o.sharing,
    pairing: o.pairing as PairingMode,
  };
}

/** How a peer's protocol relates to ours: fine, or which side needs updating. */
export type ProtocolCompat = 'ok' | 'peer-older' | 'peer-newer';

export function protocolCompat(hello: Pick<NodeHello, 'protocol'>): ProtocolCompat {
  if (hello.protocol === NODE_PROTOCOL) return 'ok';
  return hello.protocol < NODE_PROTOCOL ? 'peer-older' : 'peer-newer';
}

/** Permission a paired client holds on a node. */
export interface NodeScopes {
  /** Chat through the node's model server (default on). */
  readonly chat: boolean;
  /** Generation jobs (default on). */
  readonly generate: boolean;
  /** Download / calibrate models on the node (default off). */
  readonly manage: boolean;
}

export type GenModality = 'image' | 'video' | 'audio' | '3d';

/**
 * `GET /cluster/info` — what a node can do, for a client holding a token.
 * Everything a stranger must not learn lives here, not in the hello.
 */
export interface NodeInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly protocol: number;
  readonly os: string;
  readonly hardware: {
    readonly platform: string;
    readonly arch: string;
    readonly ramGB: number;
    readonly cpuCount: number;
    readonly chip?: string;
    /** 'metal' | 'cuda' | 'rocm' | 'vulkan' | 'cpu' | 'unknown' — what the node reports. */
    readonly accelerator: string;
    /** Dedicated GPU memory, when the node has a discrete GPU and measured it. */
    readonly vramGB?: number;
  };
  /** Inference engines the node can run, and whether each is ready. */
  readonly engines: readonly { readonly id: string; readonly ready: boolean }[];
  /** Chat models downloaded on the node. */
  readonly models: readonly { readonly id: string; readonly name?: string }[];
  /** The model its server has up right now, if any. */
  readonly loaded?: {
    readonly modelId: string;
    readonly servedModelId: string;
    readonly provider: 'llamacpp' | 'mlx';
    readonly contextWindow: number;
    readonly vision: boolean;
  };
  /** The node's own Auto/tier picks (its `recommend()`), tier → model id. */
  readonly tiers: Readonly<Record<string, string>>;
  /** Generation models installed per modality. */
  readonly gen: Readonly<Record<GenModality, readonly string[]>>;
  /** Sharing policy as it applies to the asking client. */
  readonly sharing: { readonly slots: number; readonly scopes: NodeScopes };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function idList<T>(v: unknown, read: (o: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const r = read(item as Record<string, unknown>);
    if (r !== undefined) out.push(r);
  }
  return out;
}

const GEN_MODALITIES: readonly GenModality[] = ['image', 'video', 'audio', '3d'];

/**
 * Read a node's info, or null when the body is not one.
 *
 * The identity fields are required (they decide which device a client thinks
 * it is talking to); everything describing capacity degrades to "unknown" or
 * empty rather than failing the whole read, because a newer node may send a
 * shape this build only half understands.
 */
export function parseInfo(body: unknown): NodeInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const o = body as Record<string, unknown>;
  const id = helloString(o.id);
  const name = helloString(o.name);
  const version = helloString(o.version);
  const os = helloString(o.os);
  if (
    id === undefined ||
    name === undefined ||
    version === undefined ||
    os === undefined ||
    typeof o.protocol !== 'number' ||
    !Number.isInteger(o.protocol)
  ) {
    return null;
  }
  const hw =
    typeof o.hardware === 'object' && o.hardware !== null
      ? (o.hardware as Record<string, unknown>)
      : {};
  const chip = helloString(hw.chip);
  const vramGB = num(hw.vramGB);
  const loadedRaw =
    typeof o.loaded === 'object' && o.loaded !== null
      ? (o.loaded as Record<string, unknown>)
      : undefined;
  const loadedModel = helloString(loadedRaw?.modelId);
  const loadedServed = helloString(loadedRaw?.servedModelId);
  const loadedProvider = loadedRaw?.provider;
  const loaded: NodeInfo['loaded'] =
    loadedModel !== undefined &&
    loadedServed !== undefined &&
    (loadedProvider === 'llamacpp' || loadedProvider === 'mlx')
      ? {
          modelId: loadedModel,
          servedModelId: loadedServed,
          provider: loadedProvider,
          contextWindow: num(loadedRaw?.contextWindow) ?? 0,
          vision: loadedRaw?.vision === true,
        }
      : undefined;
  const tiers: Record<string, string> = {};
  if (typeof o.tiers === 'object' && o.tiers !== null) {
    for (const [tier, model] of Object.entries(o.tiers as Record<string, unknown>)) {
      const m = helloString(model);
      if (m !== undefined) tiers[tier] = m;
    }
  }
  const genRaw =
    typeof o.gen === 'object' && o.gen !== null ? (o.gen as Record<string, unknown>) : {};
  const gen = Object.fromEntries(GEN_MODALITIES.map((m) => [m, strings(genRaw[m])])) as Record<
    GenModality,
    string[]
  >;
  const sharingRaw =
    typeof o.sharing === 'object' && o.sharing !== null
      ? (o.sharing as Record<string, unknown>)
      : {};
  const scopesRaw =
    typeof sharingRaw.scopes === 'object' && sharingRaw.scopes !== null
      ? (sharingRaw.scopes as Record<string, unknown>)
      : {};
  return {
    id,
    name,
    version,
    protocol: o.protocol,
    os,
    hardware: {
      platform: helloString(hw.platform) ?? 'unknown',
      arch: helloString(hw.arch) ?? 'unknown',
      ramGB: num(hw.ramGB) ?? 0,
      cpuCount: num(hw.cpuCount) ?? 0,
      ...(chip !== undefined ? { chip } : {}),
      accelerator: helloString(hw.accelerator) ?? 'unknown',
      ...(vramGB !== undefined ? { vramGB } : {}),
    },
    engines: idList(o.engines, (e) => {
      const engineId = helloString(e.id);
      return engineId === undefined ? undefined : { id: engineId, ready: e.ready === true };
    }),
    models: idList(o.models, (m) => {
      const modelId = helloString(m.id);
      if (modelId === undefined) return undefined;
      const modelName = helloString(m.name);
      return { id: modelId, ...(modelName !== undefined ? { name: modelName } : {}) };
    }),
    ...(loaded !== undefined ? { loaded } : {}),
    tiers,
    gen,
    sharing: {
      slots: num(sharingRaw.slots) ?? 0,
      // Absent means NOT granted: a scope is a permission, never a default-on guess.
      scopes: {
        chat: scopesRaw.chat === true,
        generate: scopesRaw.generate === true,
        manage: scopesRaw.manage === true,
      },
    },
  };
}

export function peerUrl(ip: string, path = CLUSTER_HELLO_PATH, port = CLUSTER_PORT): string {
  /*
   * Bracketed for IPv6 — a tailnet hands out both, and `http://fd7a:...:8765/`
   * is not a URL. Costs one line here and avoids an error that only appears on
   * a machine reached over v6.
   */
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${port}${path}`;
}

/** What asking one peer "are you a Bobble?" came back with. */
export type PeerProbe =
  | {
      readonly reachable: true;
      readonly hello: NodeHello;
      /** Whether this build can talk to it, and if not, which side is out of date. */
      readonly compat: ProtocolCompat;
      /** Wall time of the hello round trip. */
      readonly rttMs: number;
    }
  | {
      readonly reachable: false;
      /**
       * `not-bobble`: something answered that is not a Bobble (another app on
       * the port). `http`: a Bobble-shaped server refused. `timeout`: asleep or
       * firewalled. `network`: refused / unreachable.
       */
      readonly kind: 'not-bobble' | 'http' | 'timeout' | 'network';
      readonly error: string;
    };

/**
 * Ask one peer what it is.
 *
 * A short timeout on purpose: this runs across the owner's devices whenever
 * the Devices view opens, and a machine that is asleep must not hold the UI.
 * Failure is a normal answer here — most peers will not be running Bobble.
 */
export async function probePeer(
  peer: Pick<TailnetPeer, 'ip'>,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    port?: number;
    now?: () => number;
  } = {},
): Promise<PeerProbe> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
  const started = now();
  try {
    const res = await doFetch(peerUrl(peer.ip, CLUSTER_HELLO_PATH, opts.port), {
      signal: controller.signal,
      // A hello is never cached, and is never a cross-origin read.
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { reachable: false, kind: 'http', error: `HTTP ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { reachable: false, kind: 'not-bobble', error: 'the answer was not JSON' };
    }
    const hello = parseHello(body);
    if (hello === null) {
      return { reachable: false, kind: 'not-bobble', error: 'not a Bobble hello' };
    }
    return { reachable: true, hello, compat: protocolCompat(hello), rttMs: now() - started };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return aborted
      ? { reachable: false, kind: 'timeout', error: 'timed out' }
      : { reachable: false, kind: 'network', error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
