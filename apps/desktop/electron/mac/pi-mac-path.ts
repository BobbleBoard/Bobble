/**
 * THE `pi-mac` binary, as a real on-disk path — one resolver for every mode the
 * app spawns (the computer-use bridge, the cursor overlay, the vision helper).
 *
 * The package is asarUnpack'd (electron-builder.yml) because a mach-o cannot be
 * exec'd from inside the asar, so a packaged path is rewritten from app.asar
 * to app.asar.unpacked; in dev the resolver already yields the SwiftPM output.
 *
 * mac-agent.ts still carries its own copy of these lines (resolveMacHelperPath);
 * it moves to this one the next time its owning lane touches it, so the two
 * helpers can never drift onto different binaries.
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
