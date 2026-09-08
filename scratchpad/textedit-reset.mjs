/** Put TextEdit back to nothing: dismiss any modal it is stuck behind, close
 * every document without saving, quit. A save sheet blocks AppleScript quit,
 * which is why the escape comes first. */
import { call, done, sleep } from './mac-drive.mjs';
import { execFile } from 'node:child_process';
const osa = (s) => new Promise((r) => execFile('osascript', ['-e', s], () => r()));
const w = await call('windows', { app: 'TextEdit' });
if (w.ok && w.pid) {
  for (let i = 0; i < 8; i += 1) {
    const now = await call('windows', { pid: w.pid });
    if (!(now.windows ?? []).some((x) => x.modal)) break;
    await call('key', { pid: w.pid, combo: 'escape' });
    await sleep(400);
  }
}
await osa('tell application "TextEdit" to close every document without saving');
await sleep(600);
await osa('tell application "TextEdit" to quit saving no');
await sleep(1200);
done();
console.log('TextEdit reset');
process.exit(0);
