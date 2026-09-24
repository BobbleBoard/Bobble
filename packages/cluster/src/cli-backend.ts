/**
 * THE CLI BACKEND — `tailscale` as a subprocess, the path that always works.
 *
 * Every variant on every OS ships the CLI; the LocalAPI (localapi.ts) is faster
 * but undocumented and, on the macOS Standalone app, readable only by admin
 * users. So the CLI is the fallback that keeps the Devices panel honest when
 * the fast path is not there.
 *
 * Every spawn goes through `tailscaleCliEnv` (TAILSCALE_BE_CLI=1): on macOS the
 * CLI is the app binary and would otherwise decide from the environment
 * whether to be Tailscale's window. Read-only commands only: `status --json`,
 * `whois --json`, `ping --c 1`.
 */
import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { tailscaleCliEnv } from './host.js';
import { type PingResult, parsePingOutput, stripGoLogPrefix } from './ping-parse.js';
import type { TailnetBackend } from './tailnet-backend.js';
import { parseTailscaleStatus, TAILSCALE_PATHS, type TailnetStatus } from './tailscale.js';
import { parseWhois, type WhoisResult, whoisFailure } from './whois.js';

export interface CliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code; null when the process was killed or never started. */
  readonly code: number | null;
  /** The binary does not exist (ENOENT). */
  readonly missing: boolean;
  /** Killed at the deadline. */
  readonly timedOut: boolean;
}

export type CliRunner = (
  bin: string,
  args: readonly string[],
  opts: {
    readonly timeoutMs: number;
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  },
) => Promise<CliRunResult>;

/**
 * Run the CLI and always resolve — a non-zero exit is an answer here (`ping`
 * exits 1 for "no reply"), never an exception.
 */
export const runCli: CliRunner = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        timeout: opts.timeoutMs,
        env: opts.env,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, code: 0, missing: false, timedOut: false });
          return;
        }
        const code = (error as { code?: unknown }).code;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' && stderr !== '' ? stderr : error.message,
          code: typeof code === 'number' ? code : null,
          missing: code === 'ENOENT',
          timedOut: error.killed === true && error.signal !== null && code !== 'ABORT_ERR',
        });
      },
    );
  });

export interface LocateCliDeps {
  readonly platform?: NodeJS.Platform;
  readonly candidates?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Resolves when the file is there (and executable, where that means anything). */
  readonly access?: (p: string) => Promise<void>;
}

/**
 * Where the CLI is, without running it: the platform's known locations, then
 * PATH for the bare names. Null when there is none — Tailscale is not
 * installed. Running nothing matters here: probing must never be the thing
 * that opens Tailscale's window.
 */
export async function locateCli(deps: LocateCliDeps = {}): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const access =
    deps.access ??
    ((file: string) =>
      fsp.access(file, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK));
  const candidates = deps.candidates ?? TAILSCALE_PATHS[platform] ?? ['tailscale'];
  const pathVar = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const dirs = pathVar.split(p.delimiter).filter((d) => d !== '');
  for (const candidate of candidates) {
    const options = p.isAbsolute(candidate) ? [candidate] : dirs.map((d) => p.join(d, candidate));
    for (const file of options) {
      try {
        await access(file);
        return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

export interface CliBackendOptions {
  readonly bin: string;
  readonly run?: CliRunner;
  /** Base environment (default `process.env`); CLI mode is forced on top. */
  readonly env?: NodeJS.ProcessEnv;
  readonly statusTimeoutMs?: number;
}

/** Thrown when the binary disappeared, so the adapter looks for Tailscale again. */
export class CliMissingError extends Error {
  constructor(bin: string) {
    super(`The Tailscale CLI is no longer at ${bin}.`);
    this.name = 'CliMissingError';
  }
}

export function createCliBackend(opts: CliBackendOptions): TailnetBackend {
  const run = opts.run ?? runCli;
  const env = tailscaleCliEnv(opts.env ?? process.env);
  const statusTimeout = opts.statusTimeoutMs ?? 5000;
  const exec = async (
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CliRunResult> => {
    const r = await run(opts.bin, args, {
      timeoutMs,
      env,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (r.missing) throw new CliMissingError(opts.bin);
    return r;
  };
  return {
    kind: 'cli',
    label: `CLI ${opts.bin}`,
    async status(o = {}): Promise<TailnetStatus> {
      const r = await exec(['status', '--json'], statusTimeout, o.signal);
      if (r.code === 0 && r.stdout.trim() !== '') return parseTailscaleStatus(r.stdout);
      const why = stripGoLogPrefix(r.stderr) || stripGoLogPrefix(r.stdout);
      return {
        available: false,
        state: 'NotRunning',
        reason: r.timedOut
          ? 'Tailscale did not answer in time.'
          : `Tailscale is installed but did not answer${why !== '' ? `: ${why}` : '.'}`,
        peers: [],
      };
    },
    async whois(addr, o = {}): Promise<WhoisResult> {
      const r = await exec(['whois', '--json', addr], o.timeoutMs ?? 5000, o.signal);
      if (r.code === 0) return parseWhois(r.stdout);
      return whoisFailure(stripGoLogPrefix(r.stderr) || `tailscale whois exited ${r.code}`);
    },
    async ping(ip, o = {}): Promise<PingResult> {
      const timeoutMs = o.timeoutMs ?? 5000;
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      // `--c 1` still waits a second after the pong before exiting (ping.go).
      const r = await exec(
        ['ping', '--c', '1', '--timeout', `${seconds}s`, ip],
        timeoutMs + 5000,
        o.signal,
      );
      if (r.timedOut)
        return { ok: false, reason: 'timeout', detail: 'tailscale ping did not finish' };
      return parsePingOutput(r.stdout, r.stderr, r.code);
    },
  };
}
