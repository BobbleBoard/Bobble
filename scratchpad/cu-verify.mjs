/**
 * Verify the model-facing surface against the real, granted pi-mac helper
 * inside /Applications/Bobble.app. Background only — nothing comes forward.
 *
 * SAFETY: this probe only ever touches a document IT created. TextEdit's Resume
 * reopens whatever the user had open, and an earlier version of this script
 * typed into one of those — so every act here is aimed at `mine`, the window id
 * of a document opened by this run, and any other window is left alone.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { call, done, sleep } from './mac-drive.mjs';

const OUT = new URL('./cu-cases/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const osa = (s) => new Promise((r) => execFile('osascript', ['-e', s], () => r()));
const save = (n, d) => {
  writeFileSync(`${OUT}${n}.json`, JSON.stringify(d, null, 1));
  console.log(`  saved ${n}: els=${d.elements?.length} summary=${JSON.stringify(d.summary)}`);
};

await osa('tell application "TextEdit" to launch');
await sleep(2500);
const pid = (await call('windows', { app: 'TextEdit' })).pid;
console.log('TextEdit pid', pid, '| frontmost stayed:', (await call('frontmost')).app);

/** Window ids that existed BEFORE this run — never acted on. */
const preexisting = new Set(((await call('windows', { pid })).windows ?? []).map((w) => w.windowId));
await call('menuClick', { pid, path: 'File > New' });
await sleep(1500);
const mine = ((await call('windows', { pid })).windows ?? []).find(
  (w) => !preexisting.has(w.windowId),
)?.windowId;
if (mine === undefined) throw new Error('could not open a document of my own — refusing to type');
console.log('my own document window:', mine, `(left ${preexisting.size} of the user's alone)`);

const inMine = (snap, pred) => (snap.elements ?? []).find((e) => e.win === mine && pred(e));

// ── 1. a plain window ───────────────────────────────────────────────────────
let s = await call('snapshot', { pid, cap: 60 });
const area = inMine(s, (e) => e.role === 'AXTextArea');
if (area) await call('type', { pid, index: area.index, text: 'parity review baseline', append: true });
await sleep(800);
save('plain-textedit', await call('snapshot', { pid, cap: 60 }));

// ── 2. the same window with its save sheet up ───────────────────────────────
await call('menuClick', { pid, path: 'File > Save', activate: true });
await sleep(2500);
const sheet = await call('snapshot', { pid, cap: 60 });
save('save-sheet', sheet);
console.log(
  '  default button:',
  JSON.stringify((sheet.elements ?? []).filter((e) => e.isDefault).map((e) => [e.index, e.name])),
);
save('save-sheet-find', await call('snapshot', { pid, cap: 60, find: 'save' }));
// Dismiss the sheet by pressing its OWN Cancel button — escape is unreliable
// against a background app, and every menu read below needs the app unblocked.
for (let i = 0; i < 6; i++) {
  const now = await call('snapshot', { pid, cap: 60 });
  if (!now.dialog) break;
  const cancel = (now.elements ?? []).find(
    (e) => e.win === now.dialog.windowId && /^cancel$/i.test(e.name),
  );
  if (cancel) await call('click', { pid, index: cancel.index });
  else await call('key', { pid, combo: 'escape' });
  await sleep(900);
}
console.log('  sheet dismissed:', !(await call('snapshot', { pid, cap: 60 })).dialog);

// ── 3. a truncated app ──────────────────────────────────────────────────────
for (let i = 0; i < 48; i++) await call('menuClick', { pid, path: 'File > New' });
await sleep(5000);
save('big-textedit', await call('snapshot', { pid, cap: 60 }));
save('big-textedit-find', await call('snapshot', { pid, cap: 60, find: 'bold' }));
save('big-textedit-from', await call('snapshot', { pid, cap: 60, from: 60 }));

console.log('\n-- indices stay stable across pages --');
const p1 = await call('snapshot', { pid, cap: 60 });
const p2 = await call('snapshot', { pid, cap: 60, from: 60 });
const f = await call('snapshot', { pid, cap: 60, find: 'bold' });
console.log('  page1 last index', p1.elements.at(-1)?.index, '| page2 first index', p2.elements[0]?.index);
console.log('  find:"bold" first indices', JSON.stringify(f.elements.map((e) => e.index).slice(0, 6)));
const hit = f.elements.find((e) => e.win === mine) ?? f.elements[0];
console.log('  press a find-result index straight away:', JSON.stringify([hit.index, hit.name]));
console.log('   →', JSON.stringify(await call('click', { pid, index: hit.index })));
const early = p1.elements.find((e) => e.win === mine) ?? p1.elements[0];
console.log('  an index from page ONE after paging:', JSON.stringify([early.index, early.name]));
console.log('   →', JSON.stringify(await call('click', { pid, index: early.index })));

// ── 4. menus: no Apple, and the destructive fence ──────────────────────────
console.log('\n-- menus offered --');
console.log('  snapshot.menus:', JSON.stringify(p1.menus));
console.log('  menus method  :', JSON.stringify((await call('menus', { pid })).items?.map((i) => i.title)));
console.log('  menus "Apple" :', JSON.stringify((await call('menus', { pid, path: 'Apple' })).items));
console.log('\n-- the destructive fence --');
for (const p of ['Apple > Shut Down…', 'Apple > Log Out', 'Shut Down', 'Apple > Restart', 'Apple > Sleep']) {
  const r = await call('menuClick', { pid, path: p });
  console.log(`  ${p} → ok=${r.ok} destructive=${r.destructive === true}`);
}
console.log('  ordinary item still works: Format →', (await call('menuClick', { pid, path: 'Format' })).listed === true);
console.log('  Edit > Delete is NOT fenced:', JSON.stringify(await call('menuClick', { pid, path: 'Edit > Delete' })).slice(0, 120));

// ── 5. index-less typing really is background (S2) ─────────────────────────
console.log('\n-- index-less typing with a controlled app --');
console.log('  ', JSON.stringify(await call('type', { pid, text: '' })));

done();
