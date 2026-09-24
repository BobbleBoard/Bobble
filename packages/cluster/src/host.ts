/**
 * The impure half: running the Tailscale CLI, and describing this machine.
 *
 * Split from {@link ./tailscale.ts} so every decision that can be wrong — which
 * peers exist, which are reachable, what a peer's answer means — is testable
 * without a tailnet, and this file holds only the parts that must touch the OS.
 *
 * ONE WAY TO RUN THE CLI. `readTailnet` asks each candidate through the CLI
 * backend (cli-backend.ts), so the CLI-mode environment, the spawn options and
 * the wording of "not installed" / "not answering" live in one place.
 */
import { arch, cpus, hostname, platform, totalmem } from 'node:os';
import { CliMissingError, type CliRunner, createCliBackend, runCli } from './cli-backend.js';
import { TAILSCALE_PATHS, type TailnetStatus } from './tailscale.js';

export { tailscaleCliEnv } from './cli-backend.js';

/** The options every CLI spawn passes: a deadline, the CLI-mode env, no console window. */
export interface TailscaleExecOptions {
  readonly timeout?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly windowsHide?: boolean;
}

export interface ReadTailnetOptions {
  /** Injected for tests; defaults to running the real CLI. Throws on a failed run, like execFile. */
  readonly execFileImpl?: (
    file: string,
    args: readonly string[],
    opts?: TailscaleExecOptions,
  ) => Promise<{ stdout: string }>;
  /** Override the search order (tests, or a user-configured path). */
  readonly candidates?: readonly string[];
  /** Base environment for the spawn (default `process.env`); CLI mode is forced on top. */
  readonly env?: NodeJS.ProcessEnv;
}

/** "No such file" in any of the shapes a missing binary arrives as. */
function isMissingBinary(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (code === 'ENOENT') return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('ENOENT');
}

/** An execFile-style function (throws on failure) as the backend's runner (never throws). */
function runnerFrom(exec: NonNullable<ReadTailnetOptions['execFileImpl']>): CliRunner {
  return async (bin, args, opts) => {
    try {
      const { stdout } = await exec(bin, args, {
        timeout: opts.timeoutMs,
        env: opts.env,
        windowsHide: true,
      });
      return { stdout, stderr: '', code: 0, missing: false, timedOut: false };
    } catch (e) {
      const err = e as {
        stdout?: unknown;
        stderr?: unknown;
        code?: unknown;
        killed?: unknown;
        message?: unknown;
      };
      const message = typeof err.message === 'string' ? err.message : String(e);
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' && err.stderr !== '' ? err.stderr : message,
        code: typeof err.code === 'number' ? err.code : null,
        missing: isMissingBinary(e),
        timedOut: err.killed === true,
      };
    }
  };
}

/**
 * Ask Tailscale who is on this tailnet.
 *
 * Tries each known location for the platform in turn, because "is Tailscale
 * installed" has a different answer per OS and PATH is not a reliable witness
 * on any of them — least of all macOS, where the App Store build keeps its CLI
 * inside the bundle.
 */
export async function readTailnet(opts: ReadTailnetOptions = {}): Promise<TailnetStatus> {
  const run: CliRunner = opts.execFileImpl !== undefined ? runnerFrom(opts.execFileImpl) : runCli;
  const candidates = opts.candidates ?? TAILSCALE_PATHS[platform()] ?? ['tailscale'];
  let missingDetail = 'Tailscale was not found on this machine.';
  let notAnswering: TailnetStatus | undefined;
  for (const bin of candidates) {
    try {
      const status = await createCliBackend({
        bin,
        run,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      }).status();
      if (status.state !== 'NotRunning') return status;
      /*
       * A binary that ran and failed is kept, and the search goes on: another
       * location may be the one that works. Reporting "not installed" because
       * the FIRST candidate was absent is how a working install gets called
       * broken.
       */
      notAnswering = status;
    } catch (e) {
      if (e instanceof CliMissingError) {
        missingDetail = e.detail;
        continue;
      }
      throw e;
    }
  }
  /*
   * Every location missing is "not installed" (offer the download); a binary
   * that ran and failed is "not running" (offer to open Tailscale). The Devices
   * card says different things for the two.
   */
  return (
    notAnswering ?? {
      available: false,
      reason: `Tailscale was not found on this machine (${missingDetail}).`,
      peers: [],
      state: 'NotInstalled',
    }
  );
}

/** What this machine answers when another one asks what it can do. */
export interface HostDescription {
  readonly hostname: string;
  readonly platform: string;
  readonly arch: string;
  readonly ramGB: number;
  readonly cpuCount: number;
  readonly chip: string | undefined;
  /** Best-guess accelerator. Honest about not knowing rather than assuming CPU. */
  readonly accelerator: 'metal' | 'cuda' | 'rocm' | 'cpu' | 'unknown';
}

/**
 * Describe this machine, on any platform.
 *
 * `os.totalmem()` and `os.cpus()` work everywhere, which is the whole reason
 * this is short: the app's existing hardware probe shells out to `sysctl` and
 * therefore knew nothing off macOS. A cluster whose members cannot say how much
 * memory they have cannot schedule anything.
 *
 * The accelerator is a CLAIM, not a measurement — Apple Silicon implies Metal,
 * and anything else needs a real probe this package does not own yet. It says
 * 'unknown' rather than guessing 'cpu', because "no GPU" and "we did not look"
 * lead to different scheduling decisions.
 */
export function describeHost(): HostDescription {
  const isMac = platform() === 'darwin';
  const isAppleSilicon = isMac && arch() === 'arm64';
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    ramGB: Math.round(totalmem() / 1024 ** 3),
    cpuCount: cpus().length,
    chip: cpus()[0]?.model,
    accelerator: isAppleSilicon ? 'metal' : 'unknown',
  };
}
