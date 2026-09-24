/**
 * The app's one MacVisionExecutor (mac-vision.ts), wired to the bundled helper.
 *
 * Electron-dependent glue only: the executor itself is electron-free and unit
 * tested. The op router (ED-04) takes the executor from `macVision()`; nothing
 * starts a helper until the first op asks for one.
 *
 * Quit: the `--vision-serve` helper exits when its stdin closes, which happens
 * whenever this process ends (quit, crash or SIGKILL), so it cannot outlive the
 * app. `disposeMacVision()` exists for an orderly stop; ED-04 registers it with
 * electron/lifecycle.ts once that seam lands (W0-A).
 */
import path from 'node:path';
import { cacheRoot } from '@pi-desktop/inference';
import { app } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';
import { MacVisionExecutor } from './mac-vision';

/**
 * The `pi-mac` binary, as a real on-disk path. Same rule as mac-agent.ts's
 * resolver: the package is asarUnpack'd (electron-builder.yml), and a mach-o
 * cannot be exec'd from inside the asar, so app.asar → app.asar.unpacked.
 */
export function macVisionHelperPath(): string {
  const resolved = resolveBundledPackageAsset('pi-mac', 'swift/.build/release/pi-mac');
  if (!app.isPackaged) return resolved;
  return resolved.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
}

let executor: MacVisionExecutor | null = null;

/** The shared executor; masks and cutouts land under the cache root unless an
 * op names a folder (the editor passes its document's `masks/`). */
export function macVision(): MacVisionExecutor {
  executor ??= new MacVisionExecutor({
    helperPath: macVisionHelperPath(),
    outDir: path.join(cacheRoot(), 'vision'),
  });
  return executor;
}

export function disposeMacVision(): void {
  executor?.dispose();
  executor = null;
}
