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
   */
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    'tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'],
  win32: [
    'C\\:\\\\Program Files\\\\Tailscale\\\\tailscale.exe',
    'C\\:\\\\Program Files (x86)\\\\Tailscale\\\\tailscale.exe',
    'tailscale.exe',
  ],
};

/** A machine on the tailnet, as Tailscale describes it. */
export interface TailnetPeer {
  readonly id: string;
  readonly hostname: string;
  /** 'macOS' | 'linux' | 'windows' | … exactly as Tailscale reports it. */
  readonly os: string;
  /** The stable 100.x address. Everything we do reaches the peer through this. */
  readonly ip: string;
  readonly online: boolean;
  /** True for the machine this process is running on. */
  readonly self: boolean;
}

export interface TailnetStatus {
  /** False when Tailscale is not installed, not running, or not logged in. */
  readonly available: boolean;
  /** Why, when it is not available — shown to the user rather than swallowed. */
  readonly reason?: string;
  readonly peers: readonly TailnetPeer[];
}

/** Reads a JSON node object into a peer, tolerating anything missing. */
function toPeer(raw: unknown, self: boolean): TailnetPeer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const ips = Array.isArray(o.TailscaleIPs) ? o.TailscaleIPs : [];
  const ip = ips.find((v): v is string => typeof v === 'string' && v.includes('.'));
  const hostname = typeof o.HostName === 'string' ? o.HostName : '';
  if (ip === undefined || hostname === '') return null;
  return {
    id: typeof o.ID === 'string' ? o.ID : hostname,
    hostname,
    os: typeof o.OS === 'string' ? o.OS : 'unknown',
    ip,
    /*
     * Tailscale reports `Online` only for peers; the local node is online by
     * definition — it is the one answering. Reading the missing field as
     * "offline" would hide this machine from its own cluster view.
     */
    online: self ? true : o.Online === true,
    self,
  };
}

/**
 * Parse `tailscale status --json`.
 *
 * Pure, so the shape handling is testable against real captured output without
 * a tailnet — and every clustering decision downstream depends on this being
 * right about who is reachable.
 */
export function parseTailscaleStatus(json: string): TailnetStatus {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {
      available: false,
      reason: 'Tailscale returned something that is not JSON.',
      peers: [],
    };
  }
  const state = typeof doc.BackendState === 'string' ? doc.BackendState : 'Unknown';
  if (state !== 'Running') {
    return {
      available: false,
      // The state IS the explanation: "NeedsLogin", "Stopped", "NoState".
      reason: `Tailscale is installed but not running (${state}).`,
      peers: [],
    };
  }
  const peers: TailnetPeer[] = [];
  const self = toPeer(doc.Self, true);
  if (self !== null) peers.push(self);
  const rawPeers = typeof doc.Peer === 'object' && doc.Peer !== null ? doc.Peer : {};
  for (const raw of Object.values(rawPeers as Record<string, unknown>)) {
    const peer = toPeer(raw, false);
    if (peer !== null) peers.push(peer);
  }
  return { available: true, peers };
}

/** What a Bobble on another machine says it is and what it can do. */
export interface PeerCapabilities {
  readonly reachable: boolean;
  readonly version?: string;
  /** RAM in GB, as that machine measured it. */
  readonly ramGB?: number;
  readonly cpuCount?: number;
  readonly chip?: string;
  /** Accelerator the peer reports: 'metal' | 'cuda' | 'rocm' | 'cpu'. */
  readonly accelerator?: string;
  /** Model ids it can serve right now. */
  readonly models?: readonly string[];
  readonly error?: string;
}

/** The port a Bobble offers its cluster surface on. */
export const CLUSTER_PORT = 8765;

/** The path a peer answers `GET` on with {@link PeerCapabilities}. */
export const CLUSTER_HELLO_PATH = '/cluster/hello';

export function peerUrl(ip: string, path = CLUSTER_HELLO_PATH): string {
  /*
   * Bracketed for IPv6 — a tailnet hands out both, and `http://fd7a:...:8765/`
   * is not a URL. Costs one line here and avoids an error that only appears on
   * a machine reached over v6.
   */
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${CLUSTER_PORT}${path}`;
}

/**
 * Ask one peer what it is.
 *
 * A short timeout on purpose: this runs across every peer whenever the cluster
 * view opens, and a machine that is asleep must not hold the UI. Failure is a
 * normal answer here — most peers will not be running Bobble.
 */
export async function probePeer(
  peer: TailnetPeer,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PeerCapabilities> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await doFetch(peerUrl(peer.ip), { signal: controller.signal });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      reachable: true,
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
      ...(typeof body.ramGB === 'number' ? { ramGB: body.ramGB } : {}),
      ...(typeof body.cpuCount === 'number' ? { cpuCount: body.cpuCount } : {}),
      ...(typeof body.chip === 'string' ? { chip: body.chip } : {}),
      ...(typeof body.accelerator === 'string' ? { accelerator: body.accelerator } : {}),
      ...(Array.isArray(body.models)
        ? { models: body.models.filter((m): m is string => typeof m === 'string') }
        : {}),
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { reachable: false, error: aborted ? 'timed out' : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
