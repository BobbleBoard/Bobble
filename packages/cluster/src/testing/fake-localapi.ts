/**
 * A fake `tailscaled` LocalAPI for tests: the four read-only routes, the Host
 * rule and the Basic-auth rule, behaving like the real daemon did when measured
 * on this Mac (Tailscale 1.102.4):
 *
 *   - any Host but `local-tailscaled.sock` → 403 (the daemon's CSRF guard);
 *   - with a token set, no/wrong Basic auth → 401 "auth required";
 *   - whois of an unknown address → 404 "no match for IP:port";
 *   - watch-ipn-bus → `application/json`, one Notify per line, the first
 *     carrying `State`, then open until an idle timer closes it (the ~60 s
 *     idle kill, #21220, shortened here).
 *
 * It listens on a Unix socket (the Linux / open-source macOS shape) or on
 * loopback TCP (the macOS app's shape). Every request is recorded, so a test
 * can prove nothing outside the allowlist was ever asked.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATUS_FIXTURE = readFileSync(
  path.join(here, '..', 'tailscale-status.fixture.json'),
  'utf8',
);
export const WHOIS_FIXTURE = readFileSync(
  path.join(here, '..', 'tailscale-whois.fixture.json'),
  'utf8',
);
export const PING_FIXTURE = readFileSync(
  path.join(here, '..', 'tailscale-ping.fixture.json'),
  'utf8',
);

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly host: string | undefined;
  readonly cap: string | undefined;
  readonly authorization: string | undefined;
}

export interface FakeLocalApiOptions {
  /** Require HTTP Basic auth with this password (the macsys shape). */
  readonly token?: string;
  /** Close an idle watch stream after this long (the daemon's idle kill). */
  readonly idleKillMs?: number;
  /** Delay every answer (timeouts). */
  readonly delayMs?: number;
}

export interface FakeLocalApi {
  readonly requests: RecordedRequest[];
  /** Watch streams opened so far. */
  watchConnections(): number;
  /** Watch streams open right now. */
  openWatches(): number;
  /** Serve this status document from now on. */
  setStatus(body: string): void;
  /** Require a different same-user token from now on (Tailscale restarted and rotated it). */
  setToken(token: string): void;
  /** Write a Notify line to every open watch stream. */
  push(line: string): void;
  /** Write raw bytes (no newline) to every open watch stream: a line split across chunks. */
  pushRaw(text: string): void;
  listenUnix(socketPath: string): Promise<void>;
  /** Listen on 127.0.0.1; resolves the port. */
  listenTcp(): Promise<number>;
  close(): Promise<void>;
}

const WHOIS_IP = '100.101.102.110';

export function createFakeLocalApi(opts: FakeLocalApiOptions = {}): FakeLocalApi {
  let status = STATUS_FIXTURE;
  let token = opts.token;
  const requests: RecordedRequest[] = [];
  const watches = new Set<{ res: http.ServerResponse; idle: () => void }>();
  let watchCount = 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requests.push({
      method: req.method ?? '',
      url,
      host: req.headers.host,
      cap:
        typeof req.headers['tailscale-cap'] === 'string' ? req.headers['tailscale-cap'] : undefined,
      authorization: req.headers.authorization,
    });
    const answer = (code: number, body: string, type = 'text/plain; charset=utf-8'): void => {
      const send = (): void => {
        if (res.destroyed || res.writableEnded) return; // the client gave up first
        res.writeHead(code, { 'content-type': type });
        res.end(body);
      };
      if (opts.delayMs !== undefined) setTimeout(send, opts.delayMs);
      else send();
    };
    if (req.headers.host !== 'local-tailscaled.sock') {
      answer(403, 'invalid localapi request\n');
      return;
    }
    if (token !== undefined) {
      const expected = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        answer(401, 'auth required\n');
        return;
      }
    }
    const u = new URL(url, 'http://local-tailscaled.sock');
    if (req.method === 'GET' && u.pathname === '/localapi/v0/status') {
      answer(200, status, 'application/json');
      return;
    }
    if (req.method === 'GET' && u.pathname === '/localapi/v0/whois') {
      const addr = u.searchParams.get('addr') ?? '';
      const ip = addr.replace(/:\d+$/, '');
      if (ip === WHOIS_IP) answer(200, WHOIS_FIXTURE, 'application/json');
      else answer(404, 'no match for IP:port\n');
      return;
    }
    if (req.method === 'POST' && u.pathname === '/localapi/v0/ping') {
      const ip = u.searchParams.get('ip') ?? '';
      if (ip === WHOIS_IP) {
        answer(200, PING_FIXTURE, 'application/json');
      } else if (ip === '100.101.102.120') {
        answer(
          200,
          JSON.stringify({
            IP: ip,
            NodeIP: ip,
            NodeName: 'parents-macbook-pro',
            Err: "peer's node key has expired",
            LatencySeconds: 0,
          }),
          'application/json',
        );
      } else if (ip === '100.64.9.9') {
        // A sleeping machine: never answers (the client's deadline decides).
        return;
      } else {
        answer(200, JSON.stringify({ IP: ip, Err: 'no matching peer' }), 'application/json');
      }
      return;
    }
    if (req.method === 'GET' && u.pathname === '/localapi/v0/watch-ipn-bus') {
      watchCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(`${JSON.stringify({ Version: 'fake', SessionID: `s${watchCount}`, State: 6 })}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        res,
        idle: (): void => {
          if (opts.idleKillMs === undefined) return;
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => {
            watches.delete(entry);
            res.end();
          }, opts.idleKillMs);
        },
      };
      watches.add(entry);
      entry.idle();
      res.on('close', () => {
        if (timer !== undefined) clearTimeout(timer);
        watches.delete(entry);
      });
      return;
    }
    answer(404, 'not found\n');
  });

  return {
    requests,
    watchConnections: () => watchCount,
    openWatches: () => watches.size,
    setStatus(body) {
      status = body;
    },
    setToken(next) {
      token = next;
    },
    push(line) {
      for (const w of watches) {
        w.res.write(`${line}\n`);
        w.idle();
      }
    },
    pushRaw(text) {
      for (const w of watches) {
        w.res.write(text);
        w.idle();
      }
    },
    listenUnix: (socketPath) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
      }),
    listenTcp: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const w of watches) w.res.destroy();
        watches.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
