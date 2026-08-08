/**
 * syntax-colors-probe.mjs — the user, twice: "these text colors on this color scheme
 * is not viable, why all so dark, especailly teh dark blue, absoultely not" and
 * then "these colors are not readable or proper at all".
 *
 * The source says every colour is a `--pd-syntax-*` var and the dark palette is
 * bright (#d69bff keyword, #7ee2a8 string). His screenshot shows dark purple and
 * dark red. One of those is not the running app — so LOOK, and read the resolved
 * values off the live DOM rather than off the stylesheet.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'syntax-colors');
const FILE = process.env.FILE ?? '/Users/user/bobble-testbed/buggyapp/app.py';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'pd-syntax-'));

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env: { ...process.env, PI_E2E: '1', PI_E2E_NO_SERVER: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3500);

/* Open the file straight through the canvas controller rather than clicking a
 * file tree — fewer moving parts between here and the thing being looked at. */
const opened = await win.evaluate(async (file) => {
  const api = window.__pi_canvas ?? window.__pi_canvas_controller;
  if (api?.openFile !== undefined) {
    api.openFile(file);
    return 'controller';
  }
  return 'no-controller';
}, FILE);
console.log('open path:', opened);

if (opened === 'no-controller') {
  // Fall back to the UI: canvas → Files → pick the file from the tree.
  const files = win.getByText('Files', { exact: true }).first();
  if ((await files.count()) > 0) await files.click();
  await win.waitForTimeout(1500);
  const entry = win.getByText(path.basename(FILE), { exact: false }).first();
  if ((await entry.count()) > 0) await entry.click();
}
await win.waitForTimeout(4000);
await win.screenshot({ path: path.join(OUT, 'code.png') });

const report = await win.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const name of [
    'keyword',
    'string',
    'number',
    'comment',
    'function',
    'type',
    'property',
    'punctuation',
  ]) {
    tokens[name] = root.getPropertyValue(`--pd-syntax-${name}`).trim();
  }
  /* What the editor ACTUALLY paints: sample the distinct colours in use. */
  const painted = new Map();
  for (const el of document.querySelectorAll('.cm-line span')) {
    const c = getComputedStyle(el).color;
    if (!painted.has(c)) painted.set(c, el.textContent?.slice(0, 18) ?? '');
  }
  return {
    mode: document.documentElement.getAttribute('data-mode'),
    flavor: document.documentElement.getAttribute('data-flavor'),
    codeBg: root.getPropertyValue('--pd-code-block-bg').trim(),
    tokens,
    paintedCount: painted.size,
    painted: [...painted].slice(0, 14),
    editorPresent: document.querySelector('.cm-editor') !== null,
  };
});
console.log(JSON.stringify(report, null, 2));
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await app.close();
