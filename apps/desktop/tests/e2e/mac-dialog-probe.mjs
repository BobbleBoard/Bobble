/**
 * Does the model actually SEE and DRIVE an app's own dialog?
 *
 * Drives a REAL TextEdit in the background through the app's helper: a new
 * document, real typing, ⌘S, and then the save sheet — asserting that the sheet
 * arrives in the RESULT of the key that summoned it, that its own controls are
 * indexed, that its filename field accepts text, that its Cancel button can be
 * clicked, and that an index belonging to the window BEHIND it is refused
 * rather than silently dropped by macOS.
 *
 * Accessibility only — no Screen Recording needed, so this runs before the
 * capture grant exists. TextEdit is quit and left with nothing unsaved.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bundle = process.env.BOBBLE_APP ?? '/Applications/Bobble.app';
let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};
const osa = (script) => run('osascript', ['-e', script]).catch(() => undefined);

/** A clean TextEdit: no leftover documents, no leftover panels.
 *
 * A save sheet BLOCKS AppleScript quit, so a previous run that left one up
 * would otherwise poison every run after it — and the failures land on
 * assertions that have nothing to do with the cause. Escape first. */
await osa('tell application "TextEdit" to close every document without saving');
await sleep(400);
await osa('tell application "TextEdit" to quit saving no');
await sleep(1400);

const app = await electron.launch({
  executablePath: path.join(bundle, 'Contents/MacOS/Bobble'),
  env: {
    ...process.env,
    HOME: probeHome('mac-dialog-probe'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_MAC_PRECONSENT: '1',
  },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-dialog-'))}`],
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30_000,
  });
  const dbg = async (op, params) => {
    const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
    if (res.ok !== true) throw new Error(`${op}: ${res.error}`);
    return res.result;
  };
  /** Re-look until `want` is satisfied — UI takes its own time to arrive. */
  const until = async (want, tries = 10, gap = 400, params = {}) => {
    let snap = await dbg('snapshot', params);
    for (let i = 0; i < tries && !want(snap); i += 1) {
      await sleep(gap);
      snap = await dbg('snapshot', params);
    }
    return snap;
  };

  const tcc = await dbg('check');
  console.log('TCC:', JSON.stringify(tcc));
  if (tcc.accessibility !== true) {
    console.log('SKIP: Accessibility is not granted to this bundle');
    process.exit(0);
  }

  const launch = await dbg('launch', { app: 'TextEdit', background: true });
  const pid = launch.pid;
  console.log('TextEdit pid', pid);

  // TextEdit with no document opens its Open panel; ⌘N gives a document to type
  // into. ("Click New" is the step that matters, and it is a menu item.)
  await dbg('key', { pid, combo: 'cmd+n' });
  const doc = await until((s) => (s.elements ?? []).some((e) => e.role === 'AXTextArea'), 12, 400, {
    pid,
  });
  const area = (doc.elements ?? []).find((e) => e.role === 'AXTextArea');
  check(area !== undefined, 'a new document is open and its text area is indexed');
  check(
    Array.isArray(doc.menus) && doc.menus.includes('Format'),
    'the menu bar is in the snapshot',
    JSON.stringify(doc.menus),
  );
  if (area === undefined) throw new Error('no text area to drive');

  // Real keystrokes, so the document is genuinely dirty and TextEdit will offer
  // to save it (a value set does not dirty a document).
  const typed = await dbg('type', { pid, index: area.index, text: 'bobble computer-use probe', append: true });
  await sleep(600);
  const typedSnap = await dbg('snapshot', { pid });
  const areaNow = (typedSnap.elements ?? []).find((e) => e.role === 'AXTextArea');
  // Case-insensitive on purpose: the keystrokes go through the app's own text
  // substitution exactly as a person's would, and TextEdit autocapitalises the
  // first letter. That is the behaviour we want, not a mismatch.
  check(
    String(areaNow?.value ?? '').toLowerCase().includes('bobble computer-use probe'),
    'the keystrokes really landed in the document',
    `${JSON.stringify(typed.mode)} value=${JSON.stringify(String(areaNow?.value ?? '').slice(0, 40))}`,
  );

  // Save is a DOCUMENT command: macOS runs those only for the frontmost app, so
  // in the background it does nothing at all. The tool says so rather than
  // pretending, and offers to borrow the focus for that one command.
  const refused = await dbg('menuClick', { pid, path: 'File > Save' });
  check(
    refused.ok === false && /frontmost/i.test(String(refused.error ?? '')),
    'a background document command is refused with a reason, not silently dropped',
    String(refused.error ?? '').slice(0, 80),
  );

  const saved = await dbg('menuClick', { pid, path: 'File > Save', activate: true });
  check(saved.focusRestored === true, 'the borrowed focus is handed back', JSON.stringify({ borrowed: saved.focusBorrowed, restored: saved.focusRestored }));
  const announced = saved.dialog ?? (saved.opened ?? [])[0] ?? null;
  check(announced !== null, 'the act reports the surface it opened', JSON.stringify(announced));
  check(
    !/textedit/i.test(String((await dbg('frontmost')).app)),
    'the focus is back with the user once the command has run',
  );

  const withSheet = await until((s) => s.dialog?.sheet === true, 12, 400, { pid });
  check(withSheet.dialog?.sheet === true, 'the snapshot names the save sheet', JSON.stringify(withSheet.dialog ?? null));
  const sheetId = withSheet.dialog?.windowId;
  const inSheet = (withSheet.elements ?? []).filter((e) => e.win === sheetId);
  check(inSheet.length > 2, "the sheet's own controls are indexed", JSON.stringify(inSheet.map((e) => [e.index, e.role, e.name])));

  const behind = (withSheet.elements ?? []).find((e) => e.win !== undefined && e.win !== sheetId);
  if (behind !== undefined) {
    const res = await dbg('click', { pid, index: behind.index });
    check(res.found === false && res.blocked === true, 'an act on the blocked window is refused, not silently dropped', String(res.error ?? '').slice(0, 90));
  }

  const field = inSheet.find((e) => e.editable === true);
  check(field !== undefined, 'the sheet has an indexed filename field');
  if (field !== undefined) {
    await dbg('type', { pid, index: field.index, text: 'bobble-dialog-probe' });
    await sleep(400);
    const after = await dbg('snapshot', { pid });
    const now = (after.elements ?? []).find((e) => e.name === 'bobble-dialog-probe' || e.index === field.index);
    check(String(now?.value ?? now?.name ?? '').includes('bobble-dialog-probe'), 'the typed filename is really in the field', String(now?.value ?? now?.name ?? ''));
  }

  const cancel = inSheet.find((e) => /^cancel$/i.test(String(e.name)));
  check(cancel !== undefined, 'the sheet has a Cancel button to click');
  if (cancel !== undefined) {
    const res = await dbg('click', { pid, index: cancel.index });
    check(res.found === true, "clicking the sheet's own Cancel button works", String(res.mode ?? ''));
    const gone = await until((s) => s.dialog === undefined || s.dialog === null, 10, 400, { pid });
    check(gone.dialog === undefined || gone.dialog === null, 'the sheet is gone after the click');
  }

  console.log(failures === 0 ? '\nmac-dialog-probe: OK' : `\nmac-dialog-probe: ${failures} FAILED`);
} finally {
  await app.close().catch(() => {});
  await osa('tell application "TextEdit" to quit saving no');
}
process.exit(failures === 0 ? 0 : 1);
