/**
 * The impure half: running the Tailscale CLI, and describing this machine.
 *
 * Split from {@link ./tailscale.ts} so every decision that can be wrong — which
 * peers exist, which are reachable, what a peer's answer means — is testable
 * without a tailnet, and this file holds only the parts that must touch the OS.
 */
import { execFile as execFileCb } from 'node:child_process';
import { arch, cpus, hostname, platform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { parseTailscaleStatus, TAILSCALE_PATHS, type TailnetStatus } from './tailscale.js';

const execFile = promisify(execFileCb);

/**
 * The environment every Tailscale CLI spawn gets.
 *
 * On macOS the CLI IS the app binary (`/Applications/Tailscale.app/Contents/
 * MacOS/Tailscale`; `/usr/local/bin/tailscale` is a shim that execs it), and
 * that binary decides between GUI and CLI from environment variables such as
 * `TERM`, `SHLVL` and `PS1` (Tailscale CLI docs, macOS tab). A terminal has
 * them; a Bobble launched from the Finder has none — so without this the same
 * `status --json` that passes in a terminal-run test can start Tailscale's own
 * window, or fail, in the shipped app. `TAILSCALE_BE_CLI=1` forces CLI mode and
 * is ignored everywhere else, so it is set on every platform, every spawn.
 */
export function tailscaleCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, TAILSCALE_BE_CLI: '1' };
}

/** The options every CLI spawn passes: a deadline, the CLI-mode env, no console window. */
export interface TailscaleExecOptions {
  readonly timeout?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly windowsHide?: boolean;
}

export interface ReadTailnetOptions {
  /** Injected for tests; defaults to running the real CLI. */
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

/**
 * Ask Tailscale who is on this tailnet.
 *
 * Tries each known location for the platform in turn, because "is Tailscale
 * installed" has a different answer per OS and PATH is not a reliable witness
 * on any of them — least of all macOS, where the App Store build keeps its CLI
 * inside the bundle.
 */
export async function readTailnet(opts: ReadTailnetOptions = {}): Promise<TailnetStatus> {
  const exec = opts.execFileImpl ?? execFile;
  const candidates = opts.candidates ?? TAILSCALE_PATHS[platform()] ?? ['tailscale'];
  const env = tailscaleCliEnv(opts.env ?? process.env);
  let lastError = 'Tailscale was not found on this machine.';
  let found = false;
  for (const bin of candidates) {
    try {
      const { stdout } = await exec(bin, ['status', '--json'], {
        timeout: 5000,
        env,
        windowsHide: true,
      });
      return parseTailscaleStatus(stdout);
    } catch (e) {
      /*
       * A missing binary and a broken one are different problems with the same
       * shape here, so keep the last message and keep looking — reporting
       * "not installed" because the FIRST candidate was absent is how a working
       * install gets called broken.
       */
      const message = e instanceof Error ? e.message : String(e);
      if (isMissingBinary(e)) {
        if (!found) lastError = message;
      } else {
        found = true;
        lastError = message;
      }
    }
  }
  /*
   * Every location missing is "not installed" (offer the download); a binary
   * that ran and failed is "not running" (offer to open Tailscale). The Devices
   * card says different things for the two.
   */
  return found
    ? {
        available: false,
        reason: `Tailscale is installed but did not answer: ${lastError}`,
        peers: [],
        state: 'NotRunning',
      }
    : {
        available: false,
        reason: `Tailscale was not found on this machine (${lastError}).`,
        peers: [],
        state: 'NotInstalled',
      };
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
