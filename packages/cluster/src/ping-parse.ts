/**
 * What a Tailscale ping says about the path to a peer.
 *
 * Two sources, one answer: the CLI prints text (`tailscale ping` has no
 * `--json`), and the LocalAPI returns `ipnstate.PingResult` JSON. The Devices
 * row and the Ping button show the same thing either way: direct over the LAN,
 * relayed through a DERP region, or through a peer relay — and how long it
 * took — or why there was no answer.
 *
 * Text forms (cmd/tailscale/cli/ping.go; the first and the failures MEASURED
 * on this Mac, Tailscale 1.102.4):
 *
 *   pong from linux-ms-7e59 (100.101.102.110) via 192.168.1.33:41641 in 9ms
 *   pong from host (100.64.0.2) via DERP(nue) in 46ms
 *   pong from host (100.64.0.2, 41000) via peer-relay(203.0.113.5:7777:vni:3) in 20ms
 *   ping "100.101.102.121" timed out            (stdout)  + "… no reply" (stderr, exit 1)
 *   2026/09/23 18:17:09 peer's node key has expired        (stderr, exit 1)
 *   100.101.102.103 is local Tailscale IP                     (stdout, exit 0)
 */

/** The kind of path a pong came back over. */
export type PingPath = 'direct' | 'derp' | 'peer-relay' | 'unknown';

export type PingResult =
  | {
      readonly ok: true;
      readonly latencyMs: number;
      readonly path: PingPath;
      /** The direct endpoint (ip:port), when direct. */
      readonly endpoint?: string;
      /** DERP region code ("nue"), when relayed through DERP. */
      readonly derpRegion?: string;
      /** The peer relay (ip:port:vni:N), when relayed through one. */
      readonly peerRelay?: string;
      readonly nodeName?: string;
      readonly nodeIp?: string;
    }
  | {
      readonly ok: false;
      /**
       * `timeout`/`no-reply`: nothing answered (asleep, off, or unreachable —
       * Tailscale cannot wake a machine). `key-expired`: the peer must sign in
       * again. `not-found`: no such peer. `local`: that address is this machine.
       * `error`: anything else, with the text.
       */
      readonly reason: 'timeout' | 'no-reply' | 'key-expired' | 'not-found' | 'local' | 'error';
      readonly detail: string;
    };

const GO_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * A Go `time.Duration` string ("9ms", "1.2s", "1m2.5s", "850µs", "0s") in
 * milliseconds, or undefined when it is not one.
 */
export function parseGoDurationMs(text: string): number | undefined {
  const s = text.trim();
  if (s === '0') return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gy;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null = re.exec(s);
  while (m !== null) {
    const unit = GO_UNIT_MS[m[2] ?? ''];
    if (unit === undefined) return undefined;
    total += Number(m[1]) * unit;
    matched = re.lastIndex;
    m = re.exec(s);
  }
  return matched === s.length && matched > 0 ? total : undefined;
}

/** Go's `log` prefix ("2026/09/23 18:17:09 ") off each line. */
export function stripGoLogPrefix(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? /, '').trimEnd())
    .filter((l) => l !== '')
    .join('\n');
}

const PONG_RE = /^pong from (\S+) \(([^,)\s]+)(?:, \d+)?\) via (.+?) in (\S+)$/;

/** Classify an error text from either source. */
function failure(detail: string): PingResult {
  const d = detail.toLowerCase();
  if (d.includes('key has expired') || d.includes('key expired')) {
    return { ok: false, reason: 'key-expired', detail };
  }
  if (d.includes('is local tailscale ip')) return { ok: false, reason: 'local', detail };
  if (
    d.includes('no matching peer') ||
    d.includes('peer not found') ||
    d.includes('unknown peer')
  ) {
    return { ok: false, reason: 'not-found', detail };
  }
  if (d.includes('timed out') || d.includes('deadline exceeded')) {
    return { ok: false, reason: 'timeout', detail };
  }
  if (d.includes('no reply')) return { ok: false, reason: 'no-reply', detail };
  return { ok: false, reason: 'error', detail };
}

function viaToPath(
  via: string,
): Pick<Extract<PingResult, { ok: true }>, 'path' | 'endpoint' | 'derpRegion' | 'peerRelay'> {
  const derp = /^DERP\(([^)]*)\)$/.exec(via);
  if (derp !== null) return { path: 'derp', derpRegion: derp[1] ?? '' };
  const relay = /^peer-relay\((.*)\)$/.exec(via);
  if (relay !== null) return { path: 'peer-relay', peerRelay: relay[1] ?? '' };
  // An ip:port (v4, or [v6]:port) is the direct UDP endpoint.
  if (/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.%a-z]+\]):\d+$/.test(via)) {
    return { path: 'direct', endpoint: via };
  }
  // "TSMP", "ICMP", "disco": the protocol, not a path.
  return { path: 'unknown' };
}

/**
 * Parse `tailscale ping` output. Takes the LAST pong (with `--until-direct` the
 * path improves from DERP to direct over successive lines); with no pong, the
 * failure is read from stderr first, then stdout.
 */
export function parsePingOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): PingResult {
  const lines = stdout.split('\n').map((l) => l.trim());
  let last: RegExpExecArray | null = null;
  for (const line of lines) {
    const m = PONG_RE.exec(line);
    if (m !== null) last = m;
  }
  if (last !== null) {
    const latencyMs = parseGoDurationMs(last[4] ?? '');
    if (latencyMs !== undefined) {
      return {
        ok: true,
        latencyMs,
        nodeName: last[1] ?? '',
        nodeIp: last[2] ?? '',
        ...viaToPath(last[3] ?? ''),
      };
    }
  }
  const err = stripGoLogPrefix(stderr);
  const out = stripGoLogPrefix(stdout);
  if (out.includes('is local Tailscale IP')) return failure(out);
  // "timed out" is on stdout and "no reply" on stderr: the timeout is the story.
  if (out.includes('timed out')) return { ok: false, reason: 'timeout', detail: out };
  if (err !== '') return failure(err);
  if (out !== '') return failure(out);
  return {
    ok: false,
    reason: 'error',
    detail:
      exitCode === null ? 'tailscale ping did not finish' : `tailscale ping exited ${exitCode}`,
  };
}

/**
 * Parse the LocalAPI's `POST /localapi/v0/ping` answer (`ipnstate.PingResult`):
 * `{IP, NodeIP, NodeName, Err, LatencySeconds, Endpoint, PeerRelay,
 * DERPRegionID, DERPRegionCode, IsLocalIP?}`. MEASURED shape.
 */
export function parsePingJson(body: unknown): PingResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'error', detail: 'the ping answer was not an object' };
  }
  const o = body as Record<string, unknown>;
  const err = typeof o.Err === 'string' ? o.Err : '';
  if (err !== '') {
    return o.IsLocalIP === true ? { ok: false, reason: 'local', detail: err } : failure(err);
  }
  const seconds = typeof o.LatencySeconds === 'number' ? o.LatencySeconds : undefined;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, reason: 'error', detail: 'the ping answer had no latency' };
  }
  const nodeName = typeof o.NodeName === 'string' ? o.NodeName : undefined;
  const nodeIp = typeof o.NodeIP === 'string' ? o.NodeIP : undefined;
  const common = {
    ok: true as const,
    latencyMs: seconds * 1000,
    ...(nodeName !== undefined ? { nodeName } : {}),
    ...(nodeIp !== undefined ? { nodeIp } : {}),
  };
  // The CLI's precedence: a peer relay, then DERP, then the direct endpoint.
  if (typeof o.PeerRelay === 'string' && o.PeerRelay !== '') {
    return { ...common, path: 'peer-relay', peerRelay: o.PeerRelay };
  }
  if (typeof o.DERPRegionID === 'number' && o.DERPRegionID !== 0) {
    return {
      ...common,
      path: 'derp',
      derpRegion: typeof o.DERPRegionCode === 'string' ? o.DERPRegionCode : '',
    };
  }
  if (typeof o.Endpoint === 'string' && o.Endpoint !== '') {
    return { ...common, path: 'direct', endpoint: o.Endpoint };
  }
  return { ...common, path: 'unknown' };
}

/** The Devices row's path label: "direct · 8 ms", "relayed via DERP (lax) · 46 ms". */
export function describePing(result: PingResult): string {
  if (!result.ok) {
    switch (result.reason) {
      case 'timeout':
      case 'no-reply':
        return 'no reply: the device may be asleep';
      case 'key-expired':
        return 'key expired: sign in to Tailscale on that device';
      case 'not-found':
        return 'not on this tailnet';
      case 'local':
        return 'this device';
      default:
        return result.detail;
    }
  }
  const ms = `${Math.max(0, Math.round(result.latencyMs))} ms`;
  switch (result.path) {
    case 'direct':
      return `direct · ${ms}`;
    case 'derp':
      return `relayed via DERP (${result.derpRegion ?? ''}) · ${ms}`;
    case 'peer-relay':
      return `via a peer relay · ${ms}`;
    default:
      return ms;
  }
}
