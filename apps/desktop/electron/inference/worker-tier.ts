/**
 * EVERY HEAVY WORKER RUNS BEHIND THE POINTER.
 *
 * The three runtimes that render pictures, clips, sounds and meshes — the uv
 * worker (mflux / mlx-audio), the ComfyUI server and the gen3d sidecar — each
 * take a `spawnFn`. This is the one they all get: the real spawn, followed by
 * the scheduler hint from process-priority.ts, so a twelve-thread diffusion
 * step loses ties to the window server instead of winning them.
 *
 * The tier is 'utility' in EVERY power mode. It used to be 'background' in
 * low, on the belief that a tier is a hint the OS honours under contention
 * and ignores otherwise. MEASURED (2026-09-16, an idle M5 Pro, 2048² float32
 * matmuls in torch): default 1826 GFLOP/s, `taskpolicy -c utility` 1779,
 * `taskpolicy -b` 155 — the background tier is confined to the efficiency
 * cores and throttled whether or not anyone wants the cores, twelve times
 * slower. Through the app that was CubePart's part split taking over forty
 * minutes on the default ('low') settings where the same worker took five
 * standalone, and every CPU stage (retopo, mesh post, text encoders) paying
 * the same. Utility is the tier that matches the intent: the pointer wins
 * the ties, and an idle machine gives nothing away. Low power's real levers
 * are elsewhere (power-policy.ts: pacing, no previews, the low-RAM run).
 */
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { setWorkerTier, type WorkerTier } from './process-priority';

export function workerTier(): WorkerTier {
  return 'utility';
}

/** Apply the current tier to a child that was just spawned. Best-effort, logged. */
export function tierChild(child: { readonly pid?: number | undefined }, what: string): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const tier = workerTier();
  void setWorkerTier(pid, tier).then((applied) => {
    // eslint-disable-next-line no-console
    console.log(`[pi-guardian] ${what} pid ${pid}: ${tier} priority ${applied}`);
  });
}

/** `child_process.spawn`, with the tier applied. Drop-in for any `spawnFn`. */
export const tieredSpawn = ((command: string, args: readonly string[], options?: SpawnOptions) => {
  const child: ChildProcess = spawn(command, [...args], options ?? {});
  tierChild(child, command.split('/').pop() ?? command);
  return child;
}) as typeof spawn;
