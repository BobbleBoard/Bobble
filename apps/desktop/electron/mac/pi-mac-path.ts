/**
 * THE `pi-mac` binary, as a real on-disk path — one resolver for every mode the
 * app spawns (the computer-use bridge, the cursor overlay, the vision helper).
 *
 * The package is asarUnpack'd (electron-builder.yml) because a mach-o cannot be
 * exec'd from inside the asar, so a packaged path is rewritten from app.asar
 * to app.asar.unpacked; in dev the resolver already yields the SwiftPM output.
 *
 * mac-agent.ts (the bridge and the overlay) and editor/mac-vision-main.ts (the
 * vision helper) both take their path from here, so they can never drift onto
 * different binaries.
 */
import path from 'node:path';
import { app } from 'electron';
import { resolveBundledPackageAsset } from '../app-paths';

export function piMacHelperPath(): string {
  const resolved = resolveBundledPackageAsset('pi-mac', 'swift/.build/release/pi-mac');
  if (!app.isPackaged) return resolved;
  return resolved.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
}
