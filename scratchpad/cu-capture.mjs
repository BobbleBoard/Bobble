/**
 * Capture REAL snapshot JSON from the granted helper so the model-facing render
 * can be diffed before/after without re-driving apps each time.
 *
 * Writes scratchpad/cu-cases/*.json. Background only — nothing comes forward.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { call, done, sleep } from './mac-drive.mjs';

const OUT = new URL('./cu-cases/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const osa = (s) => new Promise((r) => execFile('osascript', ['-e', s], () => r()));
const save = (name, data) => {
  writeFileSync(`${OUT}${name}.json`, JSON.stringify(data, null, 1));
  console.log(`${name}: app=${data.app} els=${data.elements?.length} total=${data.summary?.elementCount} truncated=${data.summary?.truncated} dialog=${JSON.stringify(data.dialog)}`);
};

// ── 1 + 2: TextEdit, plain window then with its save sheet ──────────────────
await osa('tell application "TextEdit" to quit saving no');
await sleep(1200);
await osa('tell application "TextEdit" to launch');
await sleep(2000);
const pid = (await call('windows', { app: 'TextEdit' })).pid;
console.log('TextEdit pid', pid, '| frontmost:', (await call('frontmost')).app);

await call('menuClick', { pid, path: 'File > New' });
await sleep(1200);
let snap = await call('snapshot', { pid, cap: 60 });
const area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
if (area) await call('type', { pid, index: area.index, text: 'parity review baseline', append: true });
await sleep(600);
save('plain-textedit', await call('snapshot', { pid, cap: 60 }));

await call('menuClick', { pid, path: 'File > Save', activate: true });
await sleep(2000);
save('save-sheet', await call('snapshot', { pid, cap: 60 }));

// ── 3: something big enough to truncate ─────────────────────────────────────
for (const app of process.argv.slice(2)) {
  try {
    const w = await call('windows', { app });
    if (!w.ok) { console.log(`${app}: not running`); continue; }
    const s = await call('snapshot', { pid: w.pid, cap: 60 });
    save(`big-${app.replace(/\W+/g, '-').toLowerCase()}`, s);
  } catch (e) {
    console.log(`${app}: ${e.message}`);
  }
}

done();
