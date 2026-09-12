/**
 * THE GUARDIAN, IN THE PROCESS THAT CAN ACT.
 *
 * packages/inference/src/guardian.ts decides; this file gives it eyes and hands:
 *
 *   EYES   a one-second reading of the OS's own memory numbers while heavy work
 *          runs (fifteen seconds when idle), and a quarter-second heartbeat on
 *          main's event loop — the app's own starvation, which is the pointer
 *          freezing measured from the inside.
 *   HANDS  `shed` cancels the running heavy generation with the reason the user
 *          will read; `hold` closes admission; `calm` reopens it and pumps the
 *          queue. Admission itself asks `fits` about the SPECIFIC job.
 *
 * It lives in main rather than the inference worker because the generation
 * queue lives here, and a verdict that has to cross a process boundary before
 * it can cancel anything is a verdict that arrives after the freeze.
 *
 * the user: "needs monitoring for cpu and mem pressure to ensure extremes like this
 * absolutely never happen". The two jetsam reports from the same day are in
 * /Library/Logs/DiagnosticReports; both name a 6 GB python worker.
 */
import { execFile } from 'node:child_process';
import { cpus, loadavg, platform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import {
  createGuardian,
  defaultReserveGB,
  fits,
  type Guardian,
  type GuardianVerdict,
  HEARTBEAT_MS,
  limitsFor,
  type PowerMode,
  samplePressure,
} from '@pi-desktop/inference';
import type { GenQueueControl } from './gen-manager';

const execFileAsync = promisify(execFile);

export interface GuardianMainOptions {
  /** The queue's levers — from `registerGenIpc`. */
  readonly queue: () => GenQueueControl | null;
  /** The user's power mode, read live so a change applies to the next reading. */
  readonly mode: () => PowerMode;
  /** The reserve the user named, if any; otherwise derived from the machine. */
  readonly reserveGB: () => number | undefined;
  /** Tell the app. Every change of verdict, and every shed. */
  readonly announce: (event: {
    verdict: GuardianVerdict;
    reason: string;
    memoryFree?: number;
    shed?: readonly string[];
  }) => void;
  readonly log?: (line: string) => void;
}

export interface GuardianMain {
  /** Admission: may a heavy job of this footprint start right now? */
  readonly admit: (footprintGB?: number) => { ok: boolean; reason?: string; never?: boolean };
  readonly verdict: () => GuardianVerdict;
  readonly stop: () => void;
  /** For diagnostics and the probe: the last reading's free fraction. */
  readonly memoryFree: () => number | undefined;
}

const TOTAL_GB = totalmem() / 1024 ** 3;

export function startGuardian(opts: GuardianMainOptions): GuardianMain {
  const log = opts.log ?? ((line: string) => console.log(`[pi-guardian] ${line}`));
  const plat = platform();
  const platformName: 'darwin' | 'win32' | 'linux' =
    plat === 'darwin' ? 'darwin' : plat === 'win32' ? 'win32' : 'linux';

  let lastVerdict: GuardianVerdict = 'calm';
  let lastReason = '';

  const guardian: Guardian = createGuardian({
    sample: () =>
      samplePressure({
        quick: true,
        platform: platformName,
        cpuCount: cpus().length,
        loadAvg: () => loadavg(),
        memory: () => ({ total: totalmem(), free: 0 }),
        run: async (cmd, args) => {
          try {
            // Bounded hard: under a real thrash even `sysctl` can take a while
            // to get scheduled, and a reading that never returns is no reading.
            const { stdout } = await execFileAsync(cmd, [...args], { timeout: 1500 });
            return stdout;
          } catch {
            return null;
          }
        },
        readFile: async () => null,
      }),
    busy: () => opts.queue()?.running() === true,
    limits: () => {
      const limits = limitsFor(opts.mode());
      /*
       * THE PROBE'S SEAM. The shed path — reading → verdict → cancel → the
       * banner — cannot be exercised for real without doing to the machine the
       * thing it exists to prevent. Raising the free-memory lines from the
       * environment makes an ordinary reading cross them, so a probe can watch
       * a job stop with the reason attached on a machine that is perfectly fine.
       */
      const shed = Number(process.env.PI_GUARDIAN_SHED_FREE);
      const hold = Number(process.env.PI_GUARDIAN_HOLD_FREE);
      return {
        ...limits,
        ...(Number.isFinite(shed) && shed > 0 ? { shedFree: shed } : {}),
        ...(Number.isFinite(hold) && hold > 0 ? { holdFree: hold } : {}),
      };
    },
    onVerdict: (verdict, reason, reading) => {
      const changed = verdict !== lastVerdict || reason !== lastReason;
      lastVerdict = verdict;
      lastReason = reason;
      const q = opts.queue();
      if (verdict === 'shed') {
        /*
         * THE ONE MOMENT THIS FILE EXISTS FOR. Cancel the heavy job now, with
         * the reason attached, and say so. Then the reading changes on its own
         * and the guardian settles into a hold that lifts when the machine has
         * stayed calm — nothing here retries the job; the person decides that.
         */
        const stopped = q?.shedRunning(`Stopped to keep your Mac responsive — ${reason}`) ?? [];
        if (stopped.length > 0) log(`SHED ${stopped.join(', ')}: ${reason}`);
        opts.announce({
          verdict,
          reason,
          ...(reading.memoryFree !== undefined ? { memoryFree: reading.memoryFree } : {}),
          shed: stopped,
        });
        return;
      }
      if (changed) {
        log(`${verdict}: ${reason}`);
        opts.announce({
          verdict,
          reason,
          ...(reading.memoryFree !== undefined ? { memoryFree: reading.memoryFree } : {}),
        });
      }
      // Breathing again: a job held at admission should not wait for the next
      // unrelated queue event to find out.
      if (verdict === 'calm') q?.reconsider();
    },
  });

  /*
   * THE HEARTBEAT. A timer that should fire every 250 ms and fires late is the
   * main thread not getting scheduled — the OS thrashing, felt from inside the
   * app. Lateness is what is measured, not duration: `setInterval` drift is
   * exactly "how long was the machine unable to run this process".
   */
  let expected = Date.now() + HEARTBEAT_MS;
  const beat = setInterval(() => {
    const now = Date.now();
    const late = Math.max(0, now - expected);
    expected = now + HEARTBEAT_MS;
    guardian.heartbeat(late);
  }, HEARTBEAT_MS);
  beat.unref?.();

  guardian.start();

  return {
    admit: (footprintGB) => {
      const verdict = guardian.verdict();
      const reserveGB = opts.reserveGB() ?? defaultReserveGB(TOTAL_GB);
      // A job that could not fit on this Mac at all is refused before any
      // reading is consulted — that answer does not depend on one.
      if (footprintGB !== undefined) {
        const ever = fits({ footprintGB, totalGB: TOTAL_GB, freeFraction: undefined, reserveGB });
        if (ever.never === true) return { ok: false, reason: ever.reason, never: true };
      }
      // At the wall nothing starts, whatever its size.
      if (verdict === 'shed') return { ok: false, reason: lastReason };
      // A job of unknown size is admitted only on a calm machine; one of known
      // size is admitted on the numbers, which is what makes a hold
      // proportionate — small things still go through.
      if (footprintGB === undefined) {
        return verdict === 'calm' ? { ok: true } : { ok: false, reason: lastReason };
      }
      const reading = guardian.last();
      const fit = fits({
        footprintGB,
        totalGB: TOTAL_GB,
        freeFraction: reading?.memoryFree,
        reserveGB,
      });
      if (fit.ok) return { ok: true };
      return { ok: false, reason: fit.reason, ...(fit.never === true ? { never: true } : {}) };
    },
    verdict: () => guardian.verdict(),
    stop: () => {
      clearInterval(beat);
      guardian.stop();
    },
    memoryFree: () => guardian.last()?.memoryFree,
  };
}
