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

export interface ReadTailnetOptions {
  /** Injected for tests; defaults to running the real CLI. */
  readonly execFileImpl?: (
    file: string,
    args: readonly string[],
    opts?: { timeout?: number },
  ) => Promise<{ stdout: string }>;
  /** Override the search order (tests, or a user-configured path). */
  readonly candidates?: readonly string[];
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
  let lastError = 'Tailscale was not found on this machine.';
  for (const bin of candidates) {
    try {
      const { stdout } = await exec(bin, ['status', '--json'], { timeout: 5000 });
      return parseTailscaleStatus(stdout);
    } catch (e) {
      /*
       * A missing binary and a broken one are different problems with the same
       * shape here, so keep the last message and keep looking — reporting
       * "not installed" because the FIRST candidate was absent is how a working
       * install gets called broken.
       */
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { available: false, reason: lastError, peers: [] };
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
