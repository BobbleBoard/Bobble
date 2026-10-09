/**
 * A FAKE `tailscale` — the CLI, answering from fixtures, so a probe never
 * touches the real tailnet or opens Tailscale's GUI.
 *
 * On macOS the Tailscale CLI IS the app binary, and it decides between GUI and
 * CLI mode from the environment (memory: devices doc §2.1, defect 1): a probe
 * that ran the real one could put Tailscale's window over the user's work, or
 * change their tailnet. Devices (track 5) points the app at this instead with
 * `PI_CLUSTER_TAILSCALE_BIN`, and `readTailnet({ candidates: [fake.bin] })`
 * reads it in tests.
 *
 * ## States (fixtures/tailscale/*.json)
 *
 *   running             self + eight peers: online-direct, online-relayed,
 *                       offline (with LastSeen), expired, paired, in-use,
 *                       shared-in (another user's) and tagged — see PEER_ROLES
 *   needs-login         AuthURL set, no IPs, no peers
 *   needs-machine-auth  logged in, not yet approved by the admin
 *   stopped             `tailscale down`
 *   not-installed       there is no binary at all (the shim is removed, so
 *                       spawning it fails with ENOENT, exactly as a missing
 *                       install does)
 *
 * "paired" and "in-use" are Bobble's notions, not Tailscale's: to Tailscale
 * those two are ordinary online peers. PEER_ROLES names them so a Devices
 * probe can seed its own device store and fake node for exactly those hosts.
 *
 * ## Commands
 *
 *   status [--json]                   the state's fixture (text mode like the CLI)
 *   ip [-4|-6] [peer]                 this node's (or a peer's) address
 *   ping [--c N] [--until-direct=false] [--tsmp|--icmp|--peerapi] <peer>
 *                                     direct: one pong "via <ip:port> in 8ms";
 *                                     relayed: "via DERP(<region>) in 42ms" then
 *                                     "direct connection not established";
 *                                     offline/expired: timed out
 *   whois [--json] <ip[:port]>        the node and its user profile
 *   version [--json]
 *
 * Every call is appended to `<home>/calls.jsonl` with its argv and the
 * environment variables that matter (TAILSCALE_BE_CLI, TERM), so a test can
 * assert HOW the app ran the CLI, not only that it did.
 *
 * ## Use
 *
 *   const ts = createFakeTailscale({ state: 'running' });
 *   await readTailnet({ candidates: [ts.bin] });
 *   ts.setState('stopped');                // takes effect on the next call
 *   launchApp(…, { env: { ...ts.env } });  // PI_CLUSTER_TAILSCALE_BIN
 *   ts.calls(); ts.cleanup();
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'tailscale');
const SELF = fileURLToPath(import.meta.url);

export const FAKE_TAILSCALE_STATES = Object.freeze([
  'running',
  'needs-login',
  'needs-machine-auth',
  'stopped',
  'not-installed',
]);

/** Which fixture peer stands for which case (hostname → role). */
export const PEER_ROLES = Object.freeze({
  'linux-gpu': 'online-direct',
  'win-desktop': 'online-relayed',
  'old-laptop': 'offline',
  'expired-pc': 'expired',
  'paired-mini': 'paired',
  'inuse-studio': 'in-use',
  'friends-gpu': 'shared-in',
  'ci-runner': 'tagged',
});

/** A fresh copy of one state's `status --json` document. */
export function statusFixture(state) {
  if (state === 'not-installed') throw new Error('not-installed has no status: there is no binary');
  return JSON.parse(readFileSync(path.join(FIXTURES, `${state}.json`), 'utf8'));
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Make a fake install in `dir` (a temp dir by default). Returns
 * `{ dir, bin, env, setState, calls, cleanup }`; `bin` is the executable to
 * hand the code under test.
 */
export function createFakeTailscale({ dir, state = 'running' } = {}) {
  const home = dir ?? mkdtempSync(path.join(tmpdir(), 'fake-tailscale-'));
  mkdirSync(path.join(home, 'bin'), { recursive: true });
  const bin = path.join(home, 'bin', process.platform === 'win32' ? 'tailscale.cmd' : 'tailscale');

  const writeShim = () => {
    if (process.platform === 'win32') {
      writeFileSync(
        bin,
        `@echo off\r\nset "FAKE_TAILSCALE_HOME=${home}"\r\n"${process.execPath}" "${SELF}" %*\r\n`,
      );
      return;
    }
    // An absolute node path, so it runs under a Finder-like env with no PATH.
    writeFileSync(
      bin,
      `#!/bin/sh\nFAKE_TAILSCALE_HOME=${shq(home)}\nexport FAKE_TAILSCALE_HOME\nexec ${shq(process.execPath)} ${shq(SELF)} "$@"\n`,
    );
    chmodSync(bin, 0o755);
  };

  const setState = (next) => {
    if (next === 'not-installed') {
      rmSync(bin, { force: true });
      writeFileSync(path.join(home, 'state.json'), `${JSON.stringify({ state: next })}\n`);
      return;
    }
    const doc = typeof next === 'string' ? { state: next } : { state: 'custom', status: next }; // a hand-built status document
    if (typeof next === 'string' && !FAKE_TAILSCALE_STATES.includes(next)) {
      throw new Error(`unknown fake tailscale state "${next}"`);
    }
    writeFileSync(path.join(home, 'state.json'), `${JSON.stringify(doc)}\n`);
    if (!existsSync(bin)) writeShim();
  };

  writeShim();
  setState(state);

  return {
    dir: home,
    bin,
    env: { PI_CLUSTER_TAILSCALE_BIN: bin },
    setState,
    /** Every invocation so far: `{ at, argv, env: { TAILSCALE_BE_CLI, TERM } }`. */
    calls() {
      try {
        return readFileSync(path.join(home, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

// ── the CLI ─────────────────────────────────────────────────────────────────

function currentStatus(home) {
  let doc = { state: process.env.FAKE_TAILSCALE_STATE ?? 'running' };
  if (home) {
    try {
      doc = JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8'));
    } catch {
      /* default: running */
    }
  }
  return doc.state === 'custom' ? doc.status : statusFixture(doc.state);
}

function allNodes(status) {
  return [
    ...(status.Self ? [{ ...status.Self, self: true }] : []),
    ...Object.values(status.Peer ?? {}),
  ];
}

/**
 * The host or address in a CLI argument: `100.1.2.3:8765` → `100.1.2.3`,
 * `[fd7a::1]:8765` → `fd7a::1`. A bare IPv6 address is left whole — its last
 * group can look like a port.
 */
function hostOf(target) {
  const t = target.toLowerCase();
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(t);
  if (bracketed !== null) return bracketed[1];
  return /^[^:]+:\d+$/.test(t) ? t.replace(/:\d+$/, '') : t;
}

function findNode(status, target) {
  const t = hostOf(target);
  return allNodes(status).find(
    (n) =>
      n.HostName?.toLowerCase() === t ||
      n.DNSName?.toLowerCase() === t ||
      n.DNSName?.toLowerCase() === `${t}.` ||
      n.DNSName?.toLowerCase().split('.')[0] === t ||
      (n.TailscaleIPs ?? []).includes(t),
  );
}

const ZERO = '0001-01-01T00:00:00Z';

function textStatus(status) {
  if (status.BackendState === 'NeedsLogin') {
    return { out: `Logged out.\nLog in at: ${status.AuthURL}\n`, code: 1 };
  }
  if (status.BackendState === 'Stopped') return { out: 'Tailscale is stopped.\n', code: 1 };
  if (status.BackendState === 'NeedsMachineAuth') {
    return { out: 'Machine is not yet approved by tailnet admin.\n', code: 1 };
  }
  const users = status.User ?? {};
  const line = (n) => {
    const user = users[n.UserID]?.LoginName?.replace(/@.*$/, '@') ?? '-';
    let st = '-';
    if (!n.self) {
      if (n.Expired) st = 'expired';
      else if (!n.Online)
        st = `offline${n.LastSeen && n.LastSeen !== ZERO ? `, last seen ${n.LastSeen}` : ''}`;
      else if (n.Active)
        st = n.CurAddr
          ? `active; direct ${n.CurAddr}, tx ${n.TxBytes} rx ${n.RxBytes}`
          : `active; relay "${n.Relay}", tx ${n.TxBytes} rx ${n.RxBytes}`;
      else st = 'idle';
    }
    return `${(n.TailscaleIPs?.[0] ?? '-').padEnd(16)}${n.HostName.padEnd(21)}${user.padEnd(16)}${n.OS.padEnd(8)}${st}`;
  };
  return { out: `${allNodes(status).map(line).join('\n')}\n`, code: 0 };
}

function whoisDoc(status, n) {
  const user = status.User?.[n.UserID] ?? {
    ID: n.UserID,
    LoginName: 'unknown',
    DisplayName: 'unknown',
  };
  return {
    Node: {
      ID: Number.parseInt(n.ID.replace(/\D/g, '').slice(0, 9) || '1', 10),
      StableID: n.ID,
      Name: n.DNSName,
      User: n.UserID,
      Key: n.PublicKey,
      KeyExpiry: n.KeyExpiry,
      Addresses: (n.TailscaleIPs ?? []).map((ip) => (ip.includes(':') ? `${ip}/128` : `${ip}/32`)),
      AllowedIPs: n.AllowedIPs ?? [],
      Hostinfo: { OS: n.OS, Hostname: n.HostName },
      Online: n.self ? true : n.Online,
      ...(n.Tags ? { Tags: n.Tags } : {}),
      ComputedName: n.HostName.toLowerCase(),
      ComputedNameWithHost: n.HostName.toLowerCase(),
    },
    UserProfile: {
      ID: user.ID,
      LoginName: user.LoginName,
      DisplayName: user.DisplayName,
      ProfilePicURL: user.ProfilePicURL ?? '',
    },
    CapMap: {},
  };
}

function run(argv, home) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('-')));
  const positional = rest.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
  const flagValue = (name, dflt) => {
    const eq = rest.find((a) => a.startsWith(`${name}=`));
    if (eq !== undefined) return eq.slice(name.length + 1);
    const i = rest.indexOf(name);
    return i !== -1 && rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')
      ? rest[i + 1]
      : dflt;
  };
  const status = currentStatus(home);
  const running = status.BackendState === 'Running';
  const notRunning = () => ({
    err: `no current Tailscale IPs; state: ${status.BackendState}\n`,
    code: 1,
  });

  switch (cmd) {
    case 'status':
      if (flags.has('--json')) return { out: `${JSON.stringify(status, null, 2)}\n`, code: 0 };
      return textStatus(status);
    case 'ip': {
      if (!running) return notRunning();
      const target = positional[0];
      const n = target === undefined ? status.Self : findNode(status, target);
      if (n === undefined) return { err: `unknown peer "${target}"\n`, code: 1 };
      const ips = n.TailscaleIPs ?? [];
      const want = flags.has('-4')
        ? ips.filter((ip) => ip.includes('.'))
        : flags.has('-6')
          ? ips.filter((ip) => ip.includes(':'))
          : ips;
      if (want.length === 0) return notRunning();
      return { out: `${(flags.has('-1') ? want.slice(0, 1) : want).join('\n')}\n`, code: 0 };
    }
    case 'ping': {
      if (!running)
        return { err: `Tailscale is not running (state: ${status.BackendState})\n`, code: 1 };
      const target = positional[0];
      if (target === undefined) return { err: 'usage: tailscale ping <hostname-or-IP>\n', code: 1 };
      const n = findNode(status, target);
      if (n === undefined)
        return { err: `error looking up IP of "${target}": no such host\n`, code: 1 };
      const ip = n.TailscaleIPs?.[0];
      if (!n.self && (!n.Online || n.Expired)) return { err: `ping "${ip}" timed out\n`, code: 1 };
      const count = Number(flagValue('--c', '10')) || 10;
      const untilDirect = flagValue('--until-direct', 'true') !== 'false';
      const kind = flags.has('--tsmp')
        ? 'TSMP'
        : flags.has('--icmp')
          ? 'ICMP'
          : flags.has('--peerapi')
            ? 'peerapi'
            : null;
      if (kind !== null) {
        return {
          out: `pong from ${n.HostName} (${ip}, ${kind === 'TSMP' ? 41641 : 0}) via ${kind} in ${n.CurAddr ? 8 : 42}ms\n`,
          code: 0,
        };
      }
      if (n.self || n.CurAddr) {
        const via = n.self ? 'local' : n.CurAddr;
        return { out: `pong from ${n.HostName} (${ip}) via ${via} in 8ms\n`, code: 0 };
      }
      const pongs = Array.from(
        { length: count },
        () => `pong from ${n.HostName} (${ip}) via DERP(${n.Relay}) in 42ms`,
      ).join('\n');
      if (!untilDirect) return { out: `${pongs}\n`, code: 0 };
      return { out: `${pongs}\n`, err: 'direct connection not established\n', code: 1 };
    }
    case 'whois': {
      if (!running)
        return { err: `Tailscale is not running (state: ${status.BackendState})\n`, code: 1 };
      const target = positional[0];
      if (target === undefined)
        return { err: 'usage: tailscale whois [--json] <ip[:port]>\n', code: 1 };
      const n = findNode(status, target);
      if (n === undefined || !(n.TailscaleIPs ?? []).includes(hostOf(target))) {
        return { err: `no match for IP:port ${target}\n`, code: 1 };
      }
      const doc = whoisDoc(status, n);
      if (flags.has('--json')) return { out: `${JSON.stringify(doc, null, 2)}\n`, code: 0 };
      return {
        out: `Machine:\n  Name:          ${doc.Node.Name}\n  ID:            ${doc.Node.StableID}\n  Addresses:     [${doc.Node.Addresses.join(' ')}]\nUser:\n  Name:     ${doc.UserProfile.LoginName}\n  ID:       ${doc.UserProfile.ID}\n`,
        code: 0,
      };
    }
    case 'version': {
      const short = String(status.Version ?? '1.102.3').split('-')[0];
      if (flags.has('--json')) {
        return {
          out: `${JSON.stringify({ majorMinorPatch: short, short, long: status.Version, unstableBranch: false, cap: 120 }, null, 2)}\n`,
          code: 0,
        };
      }
      return {
        out: `${short}\n  tailscale commit: f4ke0001\n  other commit: f4ke0002\n  go version: go1.26.1\n`,
        code: 0,
      };
    }
    default:
      return { err: `tailscale: unknown subcommand: ${cmd ?? '(none)'}\n`, code: 1 };
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(SELF);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const home = process.env.FAKE_TAILSCALE_HOME;
  const argv = process.argv.slice(2);
  if (home) {
    try {
      appendFileSync(
        path.join(home, 'calls.jsonl'),
        `${JSON.stringify({
          at: Date.now(),
          argv,
          env: {
            TAILSCALE_BE_CLI: process.env.TAILSCALE_BE_CLI ?? null,
            TERM: process.env.TERM ?? null,
          },
        })}\n`,
      );
    } catch {
      /* a read-only home: the call still answers */
    }
  }
  const { out = '', err = '', code } = run(argv, home);
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exitCode = code;
}
