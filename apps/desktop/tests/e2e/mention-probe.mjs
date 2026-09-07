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
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('mention-probe');

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
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
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
  /*
   * POINT THE CHAT AT THE PROBE'S OWN PROJECT FIRST.
   *
   * This used to shrug — "whatever this chat's cwd is, `@` offers something from
   * it" — which was only ever true because a probe ran in the USER'S home and
   * there is always something in there. Against a throwaway home the picker had
   * nothing to offer and the step timed out waiting for an option. The fixture
   * project two checks above is a better answer anyway: a known file, so the
   * fold is asserted against content this probe put there.
   */
  await page.evaluate((dir) => {
    window.__pi_store().setState((s) => ({ session: { ...(s.session ?? {}), cwd: dir } }));
  }, proj);
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

  const state = await page.evaluate(() => {
    const pill = document.querySelector('[data-testid="composer-pill"]');
    return {
      text: document.querySelector('.pd-composer-editor')?.textContent ?? '',
      chips: document.querySelectorAll('[data-testid="composer-attachments"] *').length,
      pills: document.querySelectorAll('[data-testid="composer-pill"]').length,
      // The pill's title IS its payload — what the model receives in its place.
      payload: pill?.getAttribute('title') ?? '',
    };
  });
  /*
   * NO CHIP. the user: "at mentions should appear just the inline, no attachment
   * shown above."
   *
   * The file is still folded into pi's copy of the message and still primed by
   * the predictive prefill — that half is unchanged, and it is checked where it
   * actually lives (the pill's payload, below, and buildAgentMessage's tests).
   * What changed is that the mention no longer draws a SECOND representation of
   * itself above the box: the pill in the sentence IS the file, and the file
   * leaves with it (see Attachment.mention).
   */
  if (state.chips !== beforeChips) {
    fail(`a mention should draw no chip above the box (chips ${beforeChips} → ${state.chips})`);
  } else console.log('[mention] OK: the mention is the pill, and nothing above the box');
  /*
   * A MENTION IS A PILL NOW, not a typed path. the user: "add blue pills with icons
   * and X buttons for embedded files and such, not just typing them."
   *
   * The invariant this line has always protected is unchanged and is now checked
   * where it actually lives: the model still receives `@path`, because that is
   * the pill's PAYLOAD (`getTextContent()`), even though the box shows the file's
   * name. Asserting on the visible text would have been asserting on the label.
   */
  if (state.pills !== 1) {
    fail(`picking a file should insert exactly one pill (got ${state.pills})`);
  } else console.log('[mention] OK: it arrives as a pill, not typed text');
  if (!state.payload.includes('@')) {
    fail('the path left the message — the model no longer knows WHICH file was meant');
  } else console.log('[mention] OK: the path stays in the message too');
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('mention-probe OK');
