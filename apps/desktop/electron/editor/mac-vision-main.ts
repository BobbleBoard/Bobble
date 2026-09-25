/**
 * The app's one MacVisionExecutor (mac-vision.ts), wired to the bundled helper.
 *
 * Electron-dependent glue only: the executor itself is electron-free and unit
 * tested. The op router (ED-04) takes the executor from `macVision()`; nothing
 * starts a helper until the first op asks for one.
 *
 * Quit: the `--vision-serve` helper exits when its stdin closes, which happens
 * whenever this process ends (quit, crash or SIGKILL), so it cannot outlive the
 * app (MEASURED by mac-vision-probe: ~50 ms after its parent is SIGKILLed).
 * `disposeMacVision()` exists for an orderly stop; ED-04 registers it with
 * electron/lifecycle.ts once that seam lands (W0-A).
 */
import path from 'node:path';
import { cacheRoot } from '@pi-desktop/inference';
import { piMacHelperPath } from '../mac/pi-mac-path';
import { MacVisionExecutor } from './mac-vision';

let executor: MacVisionExecutor | null = null;

/** The shared executor; masks and cutouts land under the cache root unless an
 * op names a folder (the editor passes its document's `masks/`). */
export function macVision(): MacVisionExecutor {
  executor ??= new MacVisionExecutor({
    helperPath: piMacHelperPath(),
    outDir: path.join(cacheRoot(), 'vision'),
  });
  return executor;
}

export function disposeMacVision(): void {
  executor?.dispose();
  executor = null;
}
