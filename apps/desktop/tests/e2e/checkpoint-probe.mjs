/**
 * b18: a turn's changes are undoable.
 *
 * The only way to undo a turn was git, if the work happened to be in a repo and
 * happened to be committed. What is asserted here is the part only the real app
 * can answer: that the checkpoint root is writable through the fence (otherwise
 * the safety net is refused by the safety net) without widening it.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('checkpoint-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`checkpoint-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-cp-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  // The APP's home, not this process's — they are different now, and the fence
  // is scoped to the app's.
  const probe = path.join(PROBE_HOME, '.pi/desktop/checkpoints/.probe-write-test');
  const wrote = await page.evaluate(
    async (p) => window.piDesktop.invoke('fs:write-file', { path: p, content: 'ok' }),
    probe,
  );
  if (wrote?.ok !== true) {
    fail(`the checkpoint root is not writable: ${JSON.stringify(wrote)}`);
  } else console.log('[cp] OK: the checkpoint root is allowlisted for writes');

  const refused = await page.evaluate(async () =>
    window.piDesktop.invoke('fs:write-file', { path: '/etc/pd-should-refuse', content: 'no' }),
  );
  if (refused?.ok !== false) fail('the fence let a write into /etc through');
  else console.log('[cp] OK: the fence still refuses everything else');

  const status = await page.evaluate(() => window.__pi_store?.().getState()?.harness ?? null);
  if (status === null) {
    console.log('[cp] (no harness status under mock-pi — the shape is unit-tested)');
  } else if (!('changedFiles' in status)) {
    fail('the harness status carries no changedFiles for the app to offer a Restore from');
  } else console.log('[cp] OK: the status carries changedFiles');
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('checkpoint-probe OK');
