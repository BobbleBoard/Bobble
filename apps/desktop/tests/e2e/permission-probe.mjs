/**
 * b17: three answers, with a preview of what would happen.
 *
 * The prompt was `ctx.ui.confirm` — a reason, 200 characters of raw arguments,
 * and two buttons. Two is the problem: "allow once" and "allow in this chat"
 * are different decisions, and collapsing them means either re-asking every
 * turn or granting something for good on one click.
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
const PROBE_HOME = probeHome('permission-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`permission-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-perm-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__pi_sink === 'function', { timeout: 10_000 });

  await page.evaluate(() => {
    window.__raisePermission = (spec) =>
      window.__pi_sink().uiRequest({
        id: `perm-${Math.random().toString(36).slice(2)}`,
        method: 'permission',
        title: `Allow ${spec.toolName}?`,
        permission: spec,
      });
  });

  // --- an edit renders as a diff, not as two opaque strings ------------------
  await page.evaluate(() =>
    window.__raisePermission({
      v: 1,
      toolName: 'edit',
      reason: 'this changes a file',
      args: { file_path: '/tmp/app.ts', oldText: 'let x = 1;', newText: 'let x = 2;' },
    }),
  );
  await page.waitForSelector('[data-testid="permission-dialog"]', { timeout: 5000 });
  const shown = await page.evaluate(() => ({
    preview: document.querySelector('[data-testid="permission-preview"]')?.textContent ?? '',
    filePath: document.querySelector('[data-testid="permission-path"]')?.textContent ?? '',
    buttons: [
      document.querySelector('[data-testid="permission-once"]') !== null,
      document.querySelector('[data-testid="permission-session"]') !== null,
      document.querySelector('[data-testid="permission-deny"]') !== null,
    ],
  }));
  if (!shown.buttons.every(Boolean)) fail(`not three answers: ${JSON.stringify(shown.buttons)}`);
  else console.log('[perm] OK: three answers');
  if (!shown.preview.includes('- let x = 1;') || !shown.preview.includes('+ let x = 2;')) {
    fail(`the edit did not render as a diff: ${JSON.stringify(shown.preview)}`);
  } else console.log('[perm] OK: an edit renders as a diff');
  if (!shown.filePath.includes('/tmp/app.ts')) fail('the path is not shown');
  else console.log('[perm] OK: with the path it touches');

  await page.click('[data-testid="permission-deny"]');
  await page.waitForTimeout(600);
  if ((await page.$('[data-testid="permission-dialog"]')) !== null) {
    fail('answering did not close the dialog');
  } else console.log('[perm] OK: answering closes it');

  // --- a bash call shows the command in full, not 200 characters -------------
  const long = `echo ${'a'.repeat(600)}`;
  await page.evaluate(
    (cmd) =>
      window.__raisePermission({
        v: 1,
        toolName: 'bash',
        reason: 'this runs a command',
        args: { command: cmd },
      }),
    long,
  );
  await page.waitForSelector('[data-testid="permission-dialog"]', { timeout: 5000 });
  const body = await page.evaluate(
    () => document.querySelector('[data-testid="permission-preview"]')?.textContent ?? '',
  );
  if (body.length <= 300) fail(`the command was truncated to ${body.length} characters`);
  else console.log(`[perm] OK: the whole command is shown (${body.length} chars)`);
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('permission-probe OK');
