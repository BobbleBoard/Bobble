/**
 * THE `pi-mac` binary, as a real on-disk path — the resolver every mode the app
 * spawns is meant to share (the computer-use bridge, the cursor overlay, the
 * vision helper).
 *
 * The package is asarUnpack'd (electron-builder.yml) because a mach-o cannot be
 * exec'd from inside the asar, so a packaged path is rewritten from app.asar
 * to app.asar.unpacked; in dev the resolver already yields the SwiftPM output.
 *
 * editor/mac-vision-main.ts (the vision helper) takes its path from here.
 * mac-agent.ts (the bridge and the overlay) still carries its own copy of these
 * lines (resolveMacHelperPath) because another lane owns that file this wave
 * (PLAN.md §2.10: HELP in W1, PLAT-b in Sweep A); it moves to this one the next
 * time its owner touches it. Until then the two compute the same path from the
 * same inputs.
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
