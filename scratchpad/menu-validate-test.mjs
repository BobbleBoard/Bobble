/** Does making the document window AXMain (without activating the app) let a
 * document-scoped menu item validate and press in the background? */
import { call, done, sleep } from './mac-drive.mjs';
import { execFile } from 'node:child_process';
const osa = (s) => new Promise((r) => execFile('osascript', ['-e', s], () => r()));

await osa('tell application "TextEdit" to quit saving no');
await sleep(1200);
await osa('tell application "TextEdit" to launch');
await sleep(1800);
const pid = (await call('windows', { app: 'TextEdit' })).pid;
await call('menuClick', { pid, path: 'File > New' });
await sleep(1000);
const snap = await call('snapshot', { pid });
const area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
await call('type', { pid, index: area.index, text: 'validation test', append: true });
await sleep(500);

const fileItems = async () =>
  (await call('menus', { pid, path: 'File' })).items
    .filter((i) => ['File > Save', 'File > Close'].includes(i.path))
    .map((i) => [i.path, i.enabled === false ? 'disabled' : 'enabled']);

console.log('before focusWindow:', JSON.stringify(await fileItems()));
console.log('focusWindow:', JSON.stringify(await call('focusWindow', { pid })));
await sleep(400);
console.log('after  focusWindow:', JSON.stringify(await fileItems()));
const save = await call('menuClick', { pid, path: 'File > Save' });
console.log('press Save:', JSON.stringify(save).slice(0, 300));
await sleep(1500);
const after = await call('snapshot', { pid });
console.log('dialog:', JSON.stringify(after.dialog));
console.log('frontmost:', JSON.stringify((await call('frontmost')).app));
done();
process.exit(0);
