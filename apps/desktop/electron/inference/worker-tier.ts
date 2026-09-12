/**
 * EVERY HEAVY WORKER RUNS BEHIND THE POINTER.
 *
 * The three runtimes that render pictures, clips, sounds and meshes — the uv
 * worker (mflux / mlx-audio), the ComfyUI server and the gen3d sidecar — each
 * take a `spawnFn`. This is the one they all get: the real spawn, followed by
 * the scheduler hint from process-priority.ts, so a twelve-thread diffusion
 * step loses ties to the window server instead of winning them.
 *
 * The tier follows the user's power mode, read at spawn time: 'utility' (CPU
 * yields, disk does not — weights still load at full speed) in full and auto,
 * 'background' (both yield) in low. It is a hint the OS honours under
 * contention and ignores otherwise, so an idle machine gives nothing away.
 */
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { readSettings } from '../settings/settings-main';
import { setWorkerTier, type WorkerTier } from './process-priority';

export function workerTier(): WorkerTier {
  return readSettings().powerMode === 'low' ? 'background' : 'utility';
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
