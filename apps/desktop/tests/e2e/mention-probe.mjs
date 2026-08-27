/**
 * b11: an `@` mention brings the file with it.
 *
 * Picking a file inserted its path as text and stopped, so the model had to
 * spend a turn reading a file the user had already pointed at. And the picker
 * could not SEE parts of the project at all: the walk was depth-first under a
 * fixed budget, so the first big subtree spent it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`mention-probe FAILED: ${m}`);
  process.exitCode = 1;
};

/* A project with a fat subtree first and the interesting file behind it. */
const proj = mkdtempSync(path.join(tmpdir(), 'pd-mention-'));
mkdirSync(path.join(proj, 'aaa-big/nested'), { recursive: true });
for (let i = 0; i < 900; i++) writeFileSync(path.join(proj, 'aaa-big/nested', `f${i}.ts`), '');
mkdirSync(path.join(proj, 'zzz-small'), { recursive: true });
const MARKER = 'PROBE_MARKER_bd2f';
writeFileSync(path.join(proj, 'zzz-small/notes.md'), `# notes\n\n${MARKER}\n`);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-men-udd-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  // --- the walk reaches behind the fat subtree ------------------------------
  const listed = await page.evaluate(
    async (cwd) => window.piDesktop.invoke('fs:list-files', { cwd, query: '', limit: 400 }),
    proj,
  );
  const tops = new Set((listed ?? []).map((f) => f.rel.split('/')[0]));
  if (!tops.has('zzz-small')) {
    fail('the picker cannot see a directory sitting behind a big one');
  } else console.log('[mention] OK: every top-level directory is reachable');

  const byName = await page.evaluate(
    async (cwd) => window.piDesktop.invoke('fs:list-files', { cwd, query: 'notes', limit: 20 }),
    proj,
  );
  if (!(byName ?? []).some((f) => f.rel === 'zzz-small/notes.md')) {
    fail('searching by name did not find the file');
  } else console.log('[mention] OK: found by name');

  // --- picking one folds its CONTENTS in ------------------------------------
  // Whatever this chat's cwd is, `@` offers something from it; picking the first
  // item is enough to prove the fold, which is what changed.
  await page.click('.pd-composer-editor');
  await page.keyboard.type('@');
  await page.waitForSelector('[data-testid="composer-autocomplete"] [role="option"]', {
    timeout: 8000,
  });
  const beforeChips = await page.evaluate(
    () => document.querySelectorAll('[data-testid="composer-attachments"] *').length,
  );
  await page.click('[data-testid="composer-autocomplete"] [role="option"]');
  await page.waitForTimeout(900);

  const state = await page.evaluate(() => ({
    text: document.querySelector('.pd-composer-editor')?.textContent ?? '',
    chips: document.querySelectorAll('[data-testid="composer-attachments"] *').length,
  }));
  if (state.chips <= beforeChips) {
    fail('picking a file attached nothing — the mention did not fold the file in');
  } else console.log('[mention] OK: picking a file attaches its contents');
  if (!state.text.includes('@')) {
    fail('the path left the message — the model no longer knows WHICH file was meant');
  } else console.log('[mention] OK: the path stays in the message too');
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('mention-probe OK');
