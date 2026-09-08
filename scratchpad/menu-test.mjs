import { call, done, sleep } from './mac-drive.mjs';
import { execFile } from 'node:child_process';
const osa = (s) => new Promise((r) => execFile('osascript', ['-e', s], () => r()));

await osa('tell application "TextEdit" to quit saving no');
await sleep(1200);
await osa('tell application "TextEdit" to launch');
await sleep(1800);
const front = await call('frontmost');
const pid = (await call('windows', { app: 'TextEdit' })).pid;
console.log('TextEdit pid', pid, '| frontmost:', front.app);

console.log('\n-- menus (top level) --');
console.log(JSON.stringify((await call('menus', { pid })).items?.map((i) => i.title)));

console.log('\n-- File menu --');
const file = await call('menus', { pid, path: 'File' });
console.log(JSON.stringify(file.items?.slice(0, 10).map((i) => [i.path, i.shortcut, i.enabled])));

console.log('\n-- press File > New --');
console.log(JSON.stringify(await call('menuClick', { pid, path: 'File > New' })));
await sleep(1200);

const snap = await call('snapshot', { pid });
const area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
console.log('text area:', JSON.stringify(area && [area.index, area.role]));
if (area) {
  console.log('type:', JSON.stringify(await call('type', { pid, index: area.index, text: 'driven by bobble', append: true })));
  await sleep(500);
}

console.log('\n-- press File > Save… (menu, not a key chord) --');
const save = await call('menuClick', { pid, path: 'File > Save' });
console.log(JSON.stringify(save).slice(0, 400));
await sleep(1200);
const withSheet = await call('snapshot', { pid });
console.log('dialog:', JSON.stringify(withSheet.dialog));
console.log('sheet controls:', JSON.stringify((withSheet.elements ?? []).filter((e) => e.win === withSheet.dialog?.windowId).map((e) => [e.index, e.role, e.name])));

console.log('\n-- bold via Format > Font > Bold --');
console.log(JSON.stringify(await call('menuClick', { pid, path: 'Format' })).slice(0, 300));

done();
process.exit(0);
