/**
 * THE GUARDIAN, IN THE PROCESS THAT CAN ACT.
 *
 * packages/inference/src/guardian.ts decides; this file gives it eyes and hands:
 *
 *   EYES   a one-second reading of the OS's own memory numbers while heavy work
 *          runs (fifteen seconds when idle), each OS asked in its own language
 *          (guardian-probes.ts), and a quarter-second heartbeat on main's event
 *          loop — the app's own starvation, which is the pointer freezing
 *          measured from the inside.
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
import { totalmem } from 'node:os';
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
import { guardianProbes, nodeGuardianHost } from './guardian-probes';
import { createPausables, type Pausable, type PausablesRegistry } from './pausables';

/**
 * THE MEMORY GUARD'S HANDS, shared by every heavy run in the app.
 *
 * the user (2026-09-16): "runs should be paused and even totally terminated if
 * pausing fails for some reason quickly … kernel level hangs are 100%
 * unacceptable." A uv generation worker, the ComfyUI server while a job is
 * in it, the 3D sidecar while a stage runs, a pi child mid-turn: each
 * registers here for the length of its run (see pausables.ts), and the
 * guardian's `pause` / `shed` reach them all — not only the queue's own jobs,
 * which was the gap the restart went through (a 3D stage ran outside the
 * queue, so the guardian sampled it at the idle cadence and could not shed).
 */
export const pausables: PausablesRegistry = createPausables();

/** Register a heavy run with the guard for as long as it runs. */
export function guardRun(entry: Pausable): () => void {
  return pausables.register(entry);
}

export interface GuardianMainOptions {
  /** The queue's levers — from `registerGenIpc`. */
  readonly queue: () => GenQueueControl | null;
  /** The user's power mode, read live so a change applies to the next reading. */
  readonly mode: () => PowerMode;
  /** The reserve the user named, if any; otherwise derived from the machine. */
  readonly reserveGB: () => number | undefined;
  /**
   * The memory guard's switch (Settings → Experimental). Off, the guard
   * neither pauses nor terminates a run: admission and the queue's own shed
   * behave as they did before the guard existed.
   */
  readonly guardEnabled?: () => boolean;
  /**
   * Unload the chat model. At the wall with nothing else to end, the model
   * itself is what the machine needs back; a turn that dies with a clear
   * error is better than a Mac that stops answering the trackpad.
   */
  readonly parkChatModel?: (reason: string) => Promise<unknown>;
  /** Tell the app. Every change of verdict, and every shed. */
  readonly announce: (event: {
    verdict: GuardianVerdict;
    reason: string;
    memoryFree?: number;
    shed?: readonly string[];
    /** What was stopped in place (a pause), or let run again (a resume). */
    paused?: readonly string[];
    resumed?: readonly string[];
    queued?: number;
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
  /**
   * Take a reading NOW rather than at the next tick — the idle cadence is 15 s,
   * and a chat model parked to make room (make-room.ts) gives its memory back
   * in one; the queue's next look must see it.
   */
  readonly refresh: () => Promise<GuardianVerdict>;
}

const TOTAL_GB = totalmem() / 1024 ** 3;

export function startGuardian(opts: GuardianMainOptions): GuardianMain {
  const log = opts.log ?? ((line: string) => console.log(`[pi-guardian] ${line}`));
  /*
   * THE MACHINE, AS ITS OWN OS DESCRIBES IT. This handed every OS `free: 0`
   * and a readFile that read nothing; macOS never looks at either, but off
   * macOS "0 bytes free" read as critical and every reading shed (XP-01).
   */
  const host = nodeGuardianHost();

  let lastVerdict: GuardianVerdict = 'calm';
  let lastReason = '';

  const guardian: Guardian = createGuardian({
    sample: () => samplePressure(guardianProbes(host)),
    // Heavy work anywhere in the app, not only the queue's own jobs.
    busy: () => opts.queue()?.running() === true || pausables.active(),
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
      const pause = Number(process.env.PI_GUARDIAN_PAUSE_FREE);
      return {
        ...limits,
        ...(Number.isFinite(shed) && shed > 0 ? { shedFree: shed } : {}),
        ...(Number.isFinite(hold) && hold > 0 ? { holdFree: hold } : {}),
        ...(Number.isFinite(pause) && pause > 0 ? { pauseFree: pause } : {}),
      };
    },
    onVerdict: (verdict, reason, reading) => {
      const changed = verdict !== lastVerdict || reason !== lastReason;
      const wasPaused = lastVerdict === 'pause';
      lastVerdict = verdict;
      lastReason = reason;
      const q = opts.queue();
      const guard = opts.guardEnabled?.() !== false;
      if (verdict === 'shed') {
        /*
         * THE ONE MOMENT THIS FILE EXISTS FOR. End the heavy work now, with the
         * reason attached, and say so. The queue's own jobs are cancelled
         * through the queue (their bookkeeping ends cleanly); every other
         * registered run is ended through its own cancel and then the signal.
         * Then the reading changes on its own and the guardian settles into a
         * hold that lifts when the machine has stayed calm — nothing here
         * retries the job; the person decides that.
         */
        const why = `Stopped to keep your Mac responsive — ${reason}`;
        const stopped = q?.shedRunning(why) ?? [];
        if (stopped.length > 0) log(`SHED ${stopped.join(', ')}: ${reason}`);
        if (guard) {
          void pausables.terminateAll(why).then((ended) => {
            if (ended.length > 0) log(`TERMINATED ${ended.join(', ')}: ${reason}`);
            /*
             * THE PAUSE ENDS WITH THE SHED. What was ended is gone; what was
             * only paused (the chat) runs again on the memory that came back
             * — and the registry's "paused" is cleared, or the NEXT run to
             * register would be stopped on arrival and never continued.
             * MEASURED: a CubePart stage sat in ps state T for eighteen
             * minutes after a shed, because the verdict went pause → shed →
             * calm and only pause → calm resumed anything.
             */
            const resumed = pausables.resumeAll();
            if (resumed.length > 0) log(`RESUME ${resumed.join(', ')} after the shed`);
            // Nothing heavy to end but the machine is still at the wall: the
            // chat model is the load, and it goes rather than the Mac.
            if (stopped.length === 0 && ended.length === 0 && opts.parkChatModel !== undefined) {
              log(`PARK the chat model: ${reason}`);
              void opts.parkChatModel(why);
            }
          });
        }
        opts.announce({
          verdict,
          reason,
          ...(reading.memoryFree !== undefined ? { memoryFree: reading.memoryFree } : {}),
          shed: stopped,
        });
        return;
      }
      if (verdict === 'pause' && guard) {
        // Stop every heavy run in place. Idempotent: a run already stopped
        // stays stopped; one registered since is stopped now.
        const paused = pausables.pauseAll(reason);
        if (paused.length > 0) log(`PAUSE ${paused.join(', ')}: ${reason}`);
        if (changed) {
          opts.announce({
            verdict,
            reason,
            ...(reading.memoryFree !== undefined ? { memoryFree: reading.memoryFree } : {}),
            paused: pausables.list().map((e) => e.label),
            queued: q?.queued() ?? 0,
          });
        }
        return;
      }
      if ((wasPaused || pausables.paused()) && verdict !== 'pause') {
        // The machine has breathed: let the stopped runs go on. Checked
        // against the registry too, not only the last verdict — a pause
        // must never outlive the reading that caused it.
        const resumed = pausables.resumeAll();
        if (resumed.length > 0) log(`RESUME ${resumed.join(', ')}: ${reason}`);
        opts.announce({
          verdict,
          reason,
          ...(reading.memoryFree !== undefined ? { memoryFree: reading.memoryFree } : {}),
          resumed,
          queued: q?.queued() ?? 0,
        });
        if (verdict === 'calm') q?.reconsider();
        return;
      }
      if (changed) {
        log(`${verdict}: ${reason}`);
        opts.announce({
          verdict,
          reason,
          ...(reading.memoryFree !== undefined ? { memoryFree: reading.memoryFree } : {}),
          // SEEN: "Waiting to generate — 11% of memory is free" over a chat with
          // nothing queued. A hold is the machine's state; the banner is for the
          // person waiting on a job, and only makes sense when one is waiting.
          queued: q?.queued() ?? 0,
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
      // At the wall nothing starts, whatever its size — and nothing while
      // what is running is stopped in place.
      if (verdict === 'shed' || verdict === 'pause') return { ok: false, reason: lastReason };
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
    refresh: () => guardian.poke(),
    stop: () => {
      clearInterval(beat);
      guardian.stop();
    },
    memoryFree: () => guardian.last()?.memoryFree,
  };
}
