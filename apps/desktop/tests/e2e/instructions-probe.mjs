/**
 * b15: the AGENTS.md chain, made visible.
 *
 * The model reads a project's instruction files on every turn and the app said
 * nothing about which ones — so "why did it do that" had an answer on disk that
 * nothing in the UI would surface, and a user who wrote an AGENTS.md had no way
 * to confirm it was picked up. The failure mode is silence.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('instructions-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`instructions-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const proj = mkdtempSync(path.join(tmpdir(), 'pd-instr-'));
mkdirSync(path.join(proj, 'sub'), { recursive: true });
writeFileSync(path.join(proj, 'AGENTS.md'), '# House rules\n\nAlways use tabs.\n');
const bare = mkdtempSync(path.join(tmpdir(), 'pd-bare-'));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-instr-udd-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const ask = (page, cwd) =>
  page.evaluate((c) => window.piDesktop.invoke('fs:project-instructions', { cwd: c }), cwd);

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  const found = await ask(page, proj);
  if (!(found?.files ?? []).some((f) => f.path.endsWith('AGENTS.md'))) {
    fail(`the project's AGENTS.md was not reported: ${JSON.stringify(found)}`);
  } else console.log('[instr] OK: reports the project file');

  const first = found.files.find((f) => f.path.endsWith('AGENTS.md'));
  if (!(first.bytes > 0)) fail('reported a size of zero for a file with content');
  else if (first.label === undefined) fail('no display label — the renderer cannot shorten a path');
  else console.log(`[instr] OK: with a size and a label (${first.label} · ${first.bytes} B)`);

  // The chain is inherited: a subdirectory of the project still sees it.
  const sub = await ask(page, path.join(proj, 'sub'));
  if (!(sub?.files ?? []).some((f) => f.path.endsWith('AGENTS.md'))) {
    fail('a subdirectory did not inherit the project chain');
  } else console.log('[instr] OK: a subdirectory inherits it');

  // A project with none reports none, so the chip can be absent rather than
  // rendering "0 instruction files".
  const none = await ask(page, bare);
  const projectLocal = (none?.files ?? []).filter((f) => f.path.startsWith(bare));
  if (projectLocal.length !== 0) fail(`invented files for a bare project: ${JSON.stringify(none)}`);
  else console.log('[instr] OK: a bare project reports none of its own');

  // A path that is not a directory must not throw or guess.
  const bogus = await ask(page, '/nope/not/a/dir');
  if (bogus?.files === undefined) fail('no answer for a missing directory');
  else console.log('[instr] OK: a missing directory answers cleanly');
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('instructions-probe OK');
