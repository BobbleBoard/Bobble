/**
 * AN ELECTRON APP IS NOT AN OPAQUE RECTANGLE.
 *
 * Chromium builds its accessibility tree LAZILY: with no assistive client
 * watching, an Electron app publishes nothing at all — not its controls, not
 * even its windows. MEASURED before the fix, on two different Electron apps:
 *
 *   Claude.app : 0 elements, 0 windows
 *   Bobble     : 0 elements, 0 windows
 *
 * ...which computer use could only treat the way it treats Blender — screenshot
 * and guess coordinates — for a whole class of apps that can do far better.
 *
 * Setting `AXManualAccessibility` on the app element is what an assistive
 * technology does, and Chromium honours it: no launch flag, no preference, no
 * Apple Events, no restart, and it works on an app that is ALREADY OPEN. After
 * it, Claude reported 60 indexed elements (25 named buttons) and Bobble 10.
 *
 * This asserts it against Bobble itself, which is always available to a probe.
 */
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIN =
  process.env.PI_MAC_BIN ??
  path.join(
    process.env.BOBBLE_APP ?? '/Applications/Bobble.app',
    'Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/pi-mac/swift/.build/release/pi-mac',
  );
const fail = (m) => {
  throw new Error(`mac-electron-ax-probe failed: ${m}`);
};

/** One long-lived helper, so the priming is exercised exactly as the app does it. */
function serve() {
  const child = spawn(BIN, ['--serve']);
  let buf = '';
  let id = 0;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === '') continue;
      try {
        const m = JSON.parse(line);
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      } catch {
        /* not our line */
      }
    }
  });
  return {
    call: (method, params = {}) =>
      new Promise((r) => {
        id += 1;
        pending.set(id, (m) => r(m.result ?? m));
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      }),
    stop: () => child.stdin.end(),
  };
}

await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
await sleep(2500);
await run('open', ['-g', '-a', process.env.BOBBLE_APP ?? '/Applications/Bobble.app']);
await sleep(9000);

const h = serve();
try {
  // THE FIRST LOOK, cold. The wake-up is paid inside the snapshot, so one call
  // is enough — a probe that had to snapshot twice would be hiding the bug.
  const snap = await h.call('snapshot', { app: 'Bobble' });
  const els = snap.elements ?? [];
  console.log(`first look: ${els.length} elements, window ${JSON.stringify(snap.window)}`);
  if (els.length === 0) {
    fail('an Electron app still reports zero elements — AXManualAccessibility priming regressed');
  }
  const named = els.filter((e) => typeof e.name === 'string' && e.name !== '');
  if (named.length === 0) fail('elements came back but none is named — nothing is actionable');
  console.log(`named controls: ${named.length}`);
  console.log('mac-electron-ax-probe OK');
} finally {
  h.stop();
  await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
}
