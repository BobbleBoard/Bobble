/**
 * THE DEV ELECTRON NEVER PUTS A TILE IN THE DOCK.
 *
 * Every probe launches node_modules' Electron.app. Its Info.plist is an
 * ordinary app's, so each launch registered a Dock tile before Bobble's own
 * module-scope `app.dock.hide()` ran — and a launch that ended badly (a probe
 * killed by a timeout, a crash at start-up) left that tile behind as a
 * "not responding" ghost. MEASURED 2026-10-09: 99 "Electron" tiles in the
 * user's Dock with no Electron process alive.
 *
 * So the dev bundle is marked an agent (LSUIElement): it is never a Dock app
 * from the first instant. A dev run that wants to be seen (`pnpm dev`, a
 * PI_E2E_VISIBLE probe) turns itself back into a regular app in main.ts.
 * The bundle is re-signed ad hoc afterwards, because Info.plist is sealed into
 * the signature.
 *
 * Idempotent; runs from `postinstall` (pnpm replaces the bundle on install) and
 * from the probe harness before each launch. macOS only; a no-op elsewhere.
 *
 *   node apps/desktop/scripts/electron-agent-mode.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export function devElectronBundle() {
  const require = createRequire(import.meta.url);
  let exe;
  try {
    exe = require('electron');
  } catch {
    return undefined;
  }
  const i = typeof exe === 'string' ? exe.indexOf('Electron.app') : -1;
  return i === -1 ? undefined : exe.slice(0, i + 'Electron.app'.length);
}

/** Make the dev Electron.app an agent app. Returns what it did. */
export function ensureElectronAgentMode(bundle = devElectronBundle()) {
  if (process.platform !== 'darwin' || bundle === undefined) return 'skipped';
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return 'skipped';
  const buddy = (cmd) =>
    execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  let current = '';
  try {
    current = buddy('Print :LSUIElement');
  } catch {
    current = '';
  }
  if (current === 'true') return 'already';
  if (current === '') buddy('Add :LSUIElement bool true');
  else buddy('Set :LSUIElement true');
  execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'ignore' });
  return 'patched';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const did = ensureElectronAgentMode();
  if (did !== 'already') console.log(`electron-agent-mode: ${did}`);
}
