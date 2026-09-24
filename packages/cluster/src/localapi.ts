/**
 * THE DAEMON'S OWN API — Tailscale's LocalAPI, read-only.
 *
 * `tailscaled` answers HTTP on a local socket; the CLI is a client of it. Going
 * to it directly skips a process spawn per question (MEASURED on this Mac:
 * `status` in 6 ms over the LocalAPI against ~120 ms for `tailscale status
 * --json`) and adds the one thing the CLI cannot do cheaply: a live stream of
 * changes (`watch-ipn-bus`), so the Devices list updates without polling.
 *
 * It is NOT a stable interface (namespaced `v0`, undocumented), so this is an
 * optimisation with the CLI as the fallback (tailnet-backend.ts), and every
 * answer goes through the same tolerant parsers as the CLI's.
 *
 * Where it lives (safesocket_darwin.go, paths.go, client/local; the macsys row
 * MEASURED here: `ipnport -> 49238`, `sameuserproof-49238` root:admin 0640):
 *
 *   Linux                 unix socket /var/run/tailscale/tailscaled.sock
 *   macOS open source     unix socket /var/run/tailscaled.socket
 *   macOS Standalone      TCP 127.0.0.1:<readlink /Library/Tailscale/ipnport>,
 *     ("macsys")          token in /Library/Tailscale/sameuserproof-<port>
 *   macOS App Store       TCP port + token from the IPNExtension's open
 *                         `…/sameuserproof-<port>-<token>` file (lsof)
 *   Windows               named pipe \\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled
 *
 * Requests carry `Host: local-tailscaled.sock` (the daemon rejects other hosts
 * without a password) and, on TCP, HTTP Basic auth with an empty user and the
 * token as the password — both MEASURED (no auth → 401 "auth required").
 *
 * ONLY FOUR CALLS EXIST HERE, all read-only: status, whois, ping and the watch
 * stream. There is deliberately no generic "request a path" method: Bobble
 * must never change Tailscale's state (devices-tailscale §4.10), and the
 * surest way is not to be able to.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import http from 'node:http';

export const LOCALAPI_HOST = 'local-tailscaled.sock';

/**
 * The client capability version sent as `Tailscale-Cap`. The daemon uses it
 * to stay compatible with older clients; an older number only ever gets the
 * older shapes, which the parsers here read. 130 answered every call on
 * Tailscale 1.102.4 (MEASURED).
 */
export const TAILSCALE_CAP_VERSION = 130;

export const MACSYS_DIR = '/Library/Tailscale';
export const MACOS_OSS_SOCKET = '/var/run/tailscaled.socket';
export const LINUX_SOCKETS: readonly string[] = [
  '/var/run/tailscale/tailscaled.sock',
  '/run/tailscale/tailscaled.sock',
];
export const WINDOWS_PIPE = '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled';

/**
 * `watch-ipn-bus` options (ipn.NotifyWatchOpt bits): NotifyInitialState (2) so
 * the first message carries the current state, NotifyNoPrivateKeys (16), and
 * NotifyRateLimit (256) so a busy tailnet does not flood the stream.
 */
export const WATCH_MASK = 2 | 16 | 256;

export type LocalApiTarget =
  | { readonly kind: 'unix'; readonly path: string; readonly variant: 'linux' | 'macos-oss' }
  | { readonly kind: 'pipe'; readonly path: string; readonly variant: 'windows' }
  | {
      readonly kind: 'tcp';
      readonly port: number;
      /** The same-user proof. Never logged, never put in a label. */
      readonly token: string;
      readonly variant: 'macsys' | 'appstore';
    };

/** A label for diagnostics and the Devices card: where, never the token. */
export function describeTarget(target: LocalApiTarget): string {
  switch (target.kind) {
    case 'tcp':
      return `LocalAPI 127.0.0.1:${target.port} (${target.variant === 'macsys' ? 'Tailscale app' : 'App Store Tailscale'})`;
    case 'pipe':
      return 'LocalAPI named pipe';
    default:
      return `LocalAPI ${target.path}`;
  }
}

export interface LocateLocalApiDeps {
  readonly platform?: NodeJS.Platform;
  readonly readlink?: (p: string) => Promise<string>;
  readonly readFile?: (p: string) => Promise<string>;
  readonly exists?: (p: string) => Promise<boolean>;
  /** `lsof -F` listing of the App Store IPNExtension's open files (macOS). */
  readonly lsof?: () => Promise<string>;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

function defaultLsof(): Promise<string> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-n', '-a', ...(uid !== undefined ? [`-u${uid}`] : []), '-c', 'IPNExtension', '-F'],
      { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout) => resolve(typeof stdout === 'string' ? stdout : ''),
    );
  });
}

/**
 * The App Store variant's port and token, from `lsof -F` output: the extension
 * holds open a file named `…/.tailscale.ipn.macos/sameuserproof-<port>-<token>`
 * (safesocket_darwin.go's own discovery).
 */
export function parseLsofSameUserProof(output: string): { port: number; token: string } | null {
  const marker = '.tailscale.ipn.macos/sameuserproof-';
  for (const line of output.split('\n')) {
    const i = line.indexOf(marker);
    if (i === -1) continue;
    const rest = line.slice(i + marker.length).trim();
    const dash = rest.indexOf('-');
    if (dash <= 0) continue;
    const port = Number(rest.slice(0, dash));
    const token = rest.slice(dash + 1);
    if (Number.isInteger(port) && port > 0 && port < 65536 && /^[A-Za-z0-9]+$/.test(token)) {
      return { port, token };
    }
  }
  return null;
}

/**
 * Every place this machine's LocalAPI could be, most likely first. A listed
 * target is a candidate, not a promise: the macsys files outlive the app, so
 * the chooser (tailnet-backend.ts) asks each one for `status` before using it.
 */
export async function locateLocalApi(deps: LocateLocalApiDeps = {}): Promise<LocalApiTarget[]> {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? pathExists;
  if (platform === 'win32') return [{ kind: 'pipe', path: WINDOWS_PIPE, variant: 'windows' }];
  if (platform === 'linux') {
    const out: LocalApiTarget[] = [];
    for (const p of LINUX_SOCKETS) {
      if (await exists(p)) out.push({ kind: 'unix', path: p, variant: 'linux' });
    }
    return out;
  }
  if (platform !== 'darwin') return [];
  const readlink = deps.readlink ?? ((p: string) => fsp.readlink(p));
  const readFile = deps.readFile ?? ((p: string) => fsp.readFile(p, 'utf8'));
  const out: LocalApiTarget[] = [];
  try {
    const port = (await readlink(`${MACSYS_DIR}/ipnport`)).trim();
    if (/^\d{1,5}$/.test(port)) {
      // Readable by admin users only; a non-admin account falls through to the CLI.
      const token = (await readFile(`${MACSYS_DIR}/sameuserproof-${port}`)).trim();
      if (token !== '') out.push({ kind: 'tcp', port: Number(port), token, variant: 'macsys' });
    }
  } catch {
    /* not the Standalone variant, or not readable by this user */
  }
  if (out.length === 0) {
    try {
      const found = parseLsofSameUserProof(await (deps.lsof ?? defaultLsof)());
      if (found !== null) out.push({ kind: 'tcp', ...found, variant: 'appstore' });
    } catch {
      /* lsof unavailable */
    }
  }
  if (await exists(MACOS_OSS_SOCKET)) {
    out.push({ kind: 'unix', path: MACOS_OSS_SOCKET, variant: 'macos-oss' });
  }
  return out;
}

export interface LocalApiResponse {
  readonly status: number;
  readonly body: string;
}

export interface LocalApiCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface LocalApiClient {
  readonly target: LocalApiTarget;
  /** Where it talks to — never the token. */
  readonly label: string;
  /** `GET /localapi/v0/status` — the same document as `tailscale status --json`. */
  status(opts?: LocalApiCallOptions): Promise<LocalApiResponse>;
  /** `GET /localapi/v0/whois?addr=` — 404 "no match for IP:port" when unknown (MEASURED). */
  whois(addr: string, opts?: LocalApiCallOptions): Promise<LocalApiResponse>;
  /** `POST /localapi/v0/ping?ip=&type=disco` — one disco ping, `ipnstate.PingResult`. */
  ping(ip: string, opts?: LocalApiCallOptions): Promise<LocalApiResponse>;
  /**
   * `GET /localapi/v0/watch-ipn-bus?mask=` — one JSON `ipn.Notify` per line
   * until the daemon closes the stream (it does, after ~60 s idle: #21220) or
   * `signal` aborts. Resolves when the stream ends; rejects on a transport
   * error or a non-200 answer.
   */
  watchIpnBus(onLine: (line: string) => void, signal: AbortSignal, mask?: number): Promise<void>;
}

/** Largest answer read into memory — a big tailnet's status is hundreds of KB. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface LocalApiClientDeps {
  /** Injected for tests. */
  readonly request?: typeof http.request;
  readonly defaultTimeoutMs?: number;
}

export function createLocalApiClient(
  target: LocalApiTarget,
  deps: LocalApiClientDeps = {},
): LocalApiClient {
  const request = deps.request ?? http.request;
  const defaultTimeout = deps.defaultTimeoutMs ?? 5000;
  const headers: Record<string, string> = {
    Host: LOCALAPI_HOST,
    'Tailscale-Cap': String(TAILSCALE_CAP_VERSION),
    ...(target.kind === 'tcp'
      ? { Authorization: `Basic ${Buffer.from(`:${target.token}`).toString('base64')}` }
      : {}),
  };
  const where: http.RequestOptions =
    target.kind === 'tcp' ? { host: '127.0.0.1', port: target.port } : { socketPath: target.path };

  const open = (method: 'GET' | 'POST', path: string): http.ClientRequest =>
    request({ ...where, method, path, headers, agent: false });

  const call = (
    method: 'GET' | 'POST',
    path: string,
    opts: LocalApiCallOptions = {},
  ): Promise<LocalApiResponse> =>
    new Promise((resolve, reject) => {
      if (opts.signal?.aborted === true) {
        reject(abortError());
        return;
      }
      const req = open(method, path);
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        const e = new Error(`LocalAPI ${path.split('?')[0]} timed out`);
        e.name = 'TimeoutError';
        finish(() => reject(e));
        req.destroy();
      }, opts.timeoutMs ?? defaultTimeout);
      const onAbort = (): void => {
        finish(() => reject(abortError()));
        req.destroy();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            finish(() => reject(new Error('LocalAPI answer too large')));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          finish(() =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          ),
        );
        res.on('error', (e) => finish(() => reject(e)));
      });
      req.on('error', (e) => finish(() => reject(e)));
      req.end();
    });

  return {
    target,
    label: describeTarget(target),
    status: (opts) => call('GET', '/localapi/v0/status', opts),
    whois: (addr, opts) => call('GET', `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, opts),
    ping: (ip, opts) =>
      call('POST', `/localapi/v0/ping?ip=${encodeURIComponent(ip)}&type=disco`, opts),
    watchIpnBus: (onLine, signal, mask = WATCH_MASK) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const req = open('GET', `/localapi/v0/watch-ipn-bus?mask=${mask}`);
        let done = false;
        const settle = (fn: () => void): void => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          fn();
        };
        const onAbort = (): void => {
          settle(resolve);
          req.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('response', (res) => {
          if (res.statusCode !== 200) {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => {
              if (text.length < 1000) text += c;
            });
            res.on('end', () =>
              settle(() =>
                reject(new Error(`LocalAPI watch HTTP ${res.statusCode}: ${text.trim()}`)),
              ),
            );
            return;
          }
          let buffered = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            buffered += c;
            let nl = buffered.indexOf('\n');
            while (nl !== -1) {
              const line = buffered.slice(0, nl).trim();
              buffered = buffered.slice(nl + 1);
              if (line !== '') onLine(line);
              nl = buffered.indexOf('\n');
            }
            if (buffered.length > MAX_BODY_BYTES) {
              settle(() => reject(new Error('LocalAPI watch line too long')));
              req.destroy();
            }
          });
          res.on('end', () => {
            const tail = buffered.trim();
            if (tail !== '') onLine(tail);
            settle(resolve);
          });
          res.on('error', (e) => settle(() => (signal.aborted ? resolve() : reject(e))));
          res.on('close', () => settle(resolve));
        });
        req.on('error', (e) => settle(() => (signal.aborted ? resolve() : reject(e))));
        req.end();
      }),
  };
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
