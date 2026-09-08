/** Drive the bundled (signed, granted) pi-mac helper directly: one NDJSON
 * request per argv pair. Fast iteration without launching the whole app. */
import { spawn } from 'node:child_process';
const BIN = '/Applications/Bobble.app/Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/pi-mac/swift/.build/release/pi-mac';
const child = spawn(BIN, ['--serve']);
let buf = '';
const pending = new Map();
let id = 0;
child.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[helper] ${d}`));
export const call = (method, params = {}) =>
  new Promise((resolve) => {
    id += 1;
    pending.set(id, (m) => resolve(m.result ?? m));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
export const done = () => child.stdin.end();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
