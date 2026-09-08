/** Which background path actually opens TextEdit's save sheet? */
import { call, done, sleep } from './mac-drive.mjs';
import { execFile } from 'node:child_process';
const osa = (s) => new Promise((r) => execFile('osascript', ['-e', s], () => r()));

await osa('tell application "TextEdit" to quit saving no');
await sleep(1500);
await osa('tell application "TextEdit" to launch');
await sleep(2000);
const pid = (await call('windows', { app: 'TextEdit' })).pid;
console.log('pid', pid, '| frontmost', (await call('frontmost')).app);

await call('menuClick', { pid, path: 'File > New' });
await sleep(1200);
let snap = await call('snapshot', { pid });
let area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
console.log('area index', area?.index, 'value', JSON.stringify(area?.value ?? ''));
console.log('type:', JSON.stringify(await call('type', { pid, index: area.index, text: 'save sheet test', append: true })).slice(0, 160));
await sleep(700);
snap = await call('snapshot', { pid });
area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
console.log('after typing, value =', JSON.stringify(area?.value ?? ''));
console.log('window title now:', JSON.stringify(snap.window), '| windows:', JSON.stringify((snap.windows ?? []).map((w) => [w.role, w.title])));

console.log('\n-- A: plain key cmd+s --');
console.log(JSON.stringify(await call('key', { pid, combo: 'cmd+s' })).slice(0, 300));
await sleep(1500);
console.log('dialog:', JSON.stringify((await call('snapshot', { pid })).dialog));

console.log('\n-- B: menuClick File > Save --');
console.log(JSON.stringify(await call('menuClick', { pid, path: 'File > Save' })).slice(0, 300));
await sleep(1500);
console.log('dialog:', JSON.stringify((await call('snapshot', { pid })).dialog));
console.log('frontmost:', (await call('frontmost')).app);
done();
process.exit(0);
