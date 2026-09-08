/** Does AXRaise on the document window (no app activation) give the app a main
 * window, so document-scoped commands work in the background? */
import { call, done, sleep } from './mac-drive.mjs';
import { execFile } from 'node:child_process';
const osa = (s) => new Promise((r) => execFile('osascript', ['-e', s], () => r()));
await osa('tell application "TextEdit" to quit saving no');
await sleep(1500);
await osa('tell application "TextEdit" to launch');
await sleep(2000);
const pid = (await call('windows', { app: 'TextEdit' })).pid;
await call('menuClick', { pid, path: 'File > New' });
await sleep(1200);
const snap = await call('snapshot', { pid });
const area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
await call('type', { pid, index: area.index, text: 'raise test', append: true });
await sleep(600);
const before = (await call('menus', { pid, path: 'File' })).items.filter((i) => i.path === 'File > Save');
console.log('Save before raise:', JSON.stringify(before));
console.log('raise:', JSON.stringify(await call('raiseWindow', { pid })));
await sleep(400);
const after = (await call('menus', { pid, path: 'File' })).items.filter((i) => i.path === 'File > Save');
console.log('Save after  raise:', JSON.stringify(after));
console.log('frontmost:', (await call('frontmost')).app);
console.log('cmd+s:', JSON.stringify(await call('key', { pid, combo: 'cmd+s' })).slice(0, 220));
await sleep(1500);
const s2 = await call('snapshot', { pid });
console.log('dialog:', JSON.stringify(s2.dialog));
console.log('windows:', JSON.stringify((s2.windows ?? []).map((w) => [w.role, w.title, w.modal])));
done(); process.exit(0);
