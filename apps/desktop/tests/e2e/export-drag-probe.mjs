/**
 * b8: a chat you can keep, and a file you can drag out.
 *
 * Everything the app produces is already a real file at a real path, and none
 * of it could leave: no export, no drag-to-Finder, no save-a-copy. Those are
 * the gestures a desktop app can offer and a browser tab cannot.
 *
 * Drives the real app through the IPC contract — the round trip, not a rendered
 * menu — because the OS dialogs cannot be driven from a probe.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
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
  console.error(`export-drag-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const dir = path.join(homedir(), '.pi/agent/sessions', '-tmp-export-probe-');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `export-probe-${Date.now()}.jsonl`);
writeFileSync(
  file,
  `${[
    JSON.stringify({ type: 'session', id: 'e1', cwd: '/tmp/w', timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'build the thing' } }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Built it.' },
          { type: 'toolCall', name: 'write' },
        ],
      },
    }),
  ].join('\n')}\n`,
);

const media = path.join(tmpdir(), `pd-drag-${Date.now()}.txt`);
writeFileSync(media, 'draggable');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-export-'))}`],
  env: { ...process.env, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  // --- clipboard export: markdown, through the real handler -----------------
  const md = await page.evaluate(
    async (f) =>
      window.piDesktop.invoke('fs:export-session', {
        file: f,
        format: 'markdown',
        title: 'Renamed by the user',
        to: 'clipboard',
      }),
    file,
  );
  if (md?.ok !== true || typeof md.text !== 'string')
    fail(`markdown export failed: ${JSON.stringify(md)}`);
  else if (!md.text.startsWith('# Renamed by the user')) fail('the export ignored the given title');
  else if (!md.text.includes('_Ran: `write`_')) fail('the export lost the tool call');
  else console.log('[export] OK: markdown carries the renamed title and the tools');

  // --- raw JSONL is verbatim -------------------------------------------------
  const raw = await page.evaluate(
    async (f) =>
      window.piDesktop.invoke('fs:export-session', {
        file: f,
        format: 'jsonl',
        title: 't',
        to: 'clipboard',
      }),
    file,
  );
  if (raw?.text !== readFileSync(file, 'utf8')) fail('the raw export is not the file verbatim');
  else console.log('[export] OK: raw JSONL is verbatim');

  // --- the fence: anything that is not a session file is refused -------------
  const refused = await page.evaluate(
    async (p) =>
      window.piDesktop.invoke('fs:export-session', {
        file: p,
        format: 'markdown',
        title: 't',
        to: 'clipboard',
      }),
    '/etc/hosts',
  );
  if (refused?.ok !== false || !String(refused.error ?? '').includes('refused')) {
    fail(`the export fence let a non-session path through: ${JSON.stringify(refused)}`);
  } else console.log('[export] OK: a non-session path is refused');

  // --- drag: main accepts a real path and rejects a missing one --------------
  const dragOk = await page.evaluate(
    async (p) => window.piDesktop.invoke('canvas:start-drag', { path: p }),
    media,
  );
  if (dragOk?.ok !== true) fail(`start-drag refused a real file: ${JSON.stringify(dragOk)}`);
  else console.log('[export] OK: a real file starts an OS drag');

  const dragGone = await page.evaluate(async () =>
    window.piDesktop.invoke('canvas:start-drag', { path: '/nope/gone.png' }),
  );
  if (dragGone?.ok !== false) fail('start-drag claimed success for a missing file');
  else console.log('[export] OK: a missing file does not start one');
} finally {
  await app.close();
  rmSync(file, { force: true });
  rmSync(media, { force: true });
}
if (process.exitCode !== 1) console.log('export-drag-probe OK');
