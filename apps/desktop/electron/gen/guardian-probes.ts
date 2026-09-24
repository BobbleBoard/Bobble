/**
 * THE GUARDIAN'S EYES, PER OS — the probes main hands `samplePressure`.
 *
 * crossplatform.md §2.4 A6, package XP-01. Main used to give every OS the same
 * two stand-ins: `free: 0`, and a `readFile` that never read anything. macOS
 * consults neither (it is asked for its own verdict; pressure.ts explains why
 * its `os.freemem()` is page-cache fiction), so nothing showed on the Mac. Off
 * macOS they were the whole reading. Linux's /proc came back empty, the
 * portable floor took "0 bytes free" at its word, and `verdictFromFree(0,
 * total)` is `critical`. The first reading shed whatever ran. With the memory
 * guard on (the default), a shed with nothing of ours to end parks the chat
 * model, so an idle PC had its chat model unloaded at every reading.
 *
 * Each OS is now read in its own language:
 *
 *   darwin  EXACTLY the probes it always had: the same commands under the same
 *           bound, `free` still 0 and `readFile` still inert. Neither is ever
 *           consulted on a Mac, and keeping them inert means the Mac's reading
 *           cannot move. guardian-main.platforms.test.ts pins the probes, the
 *           commands and the reading, and passes against the code from before
 *           this file.
 *   linux   the kernel's own files: PSI, MemAvailable and the swap counters.
 *           Nothing is spawned at the guardian's half-second cadence.
 *   win32   `os.freemem()`, which there is `ullAvailPhys`: the free, zeroed
 *           and standby lists, i.e. what could be handed out without writing
 *           anything to disk (crossplatform.md §3.4).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import type { PressureProbes } from '@pi-desktop/inference';

const execFileAsync = promisify(execFile);

/**
 * Every probe answers within this or not at all. Under a real thrash even
 * `sysctl` can take a while to get scheduled, and a reading that never returns
 * is no reading.
 */
export const PROBE_TIMEOUT_MS = 1500;

/** The three platforms the sampler speaks. */
export type GuardianPlatform = PressureProbes['platform'];

/** The Node calls the probes read the machine through; tests hand in their own. */
export interface GuardianHost {
  readonly platform: GuardianPlatform;
  readonly totalmem: () => number;
  readonly freemem: () => number;
  readonly cpuCount: () => number;
  readonly loadavg: () => readonly number[];
  /** A command's stdout, or null when it is missing, fails or overruns. */
  readonly run: (cmd: string, args: readonly string[]) => Promise<string | null>;
  /** A file's text, or null when it is missing, unreadable or overruns. */
  readonly readFile: (path: string) => Promise<string | null>;
}

/**
 * Node's platform name → the sampler's. Anything that is neither a Mac nor
 * Windows is read as Linux, as it always was.
 */
export function guardianPlatform(name: string): GuardianPlatform {
  return name === 'darwin' ? 'darwin' : name === 'win32' ? 'win32' : 'linux';
}

/**
 * The probes for ONE reading. Built per reading, as before, so the core count
 * and the memory figures are the ones in force when the reading is taken.
 */
export function guardianProbes(host: GuardianHost): PressureProbes {
  if (host.platform === 'darwin') {
    return {
      quick: true,
      platform: 'darwin',
      cpuCount: host.cpuCount(),
      loadAvg: () => host.loadavg(),
      memory: () => ({ total: host.totalmem(), free: 0 }),
      run: host.run,
      readFile: async () => null,
    };
  }
  return {
    quick: true,
    platform: host.platform,
    cpuCount: host.cpuCount(),
    loadAvg: () => host.loadavg(),
    memory: () => ({ total: host.totalmem(), free: host.freemem() }),
    run: host.run,
    readFile: host.readFile,
  };
}

/**
 * A small text file (a /proc or /sys entry), or null, within the same bound as
 * the commands. The bound is on the WAIT: fs reads queue on libuv's thread
 * pool, and a pool busy with a download's writes must not hold up the reading
 * that decides whether the machine is in trouble.
 */
export async function readSmallFile(
  path: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const content = Promise.resolve()
    .then(() => read(path))
    .catch(() => null);
  try {
    return await Promise.race([content, overrun]);
  } finally {
    clearTimeout(timer);
  }
}

/** This machine, through Node. */
export function nodeGuardianHost(): GuardianHost {
  return {
    platform: guardianPlatform(platform()),
    totalmem: () => totalmem(),
    freemem: () => freemem(),
    cpuCount: () => cpus().length,
    loadavg: () => loadavg(),
    run: async (cmd, args) => {
      try {
        const { stdout } = await execFileAsync(cmd, [...args], { timeout: PROBE_TIMEOUT_MS });
        return stdout;
      } catch {
        return null;
      }
    },
    readFile: (path) => readSmallFile(path),
  };
}
