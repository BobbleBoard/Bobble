/**
 * Why does the folder chip still read "No project" after selectPath()?
 *
 * corp-headed-run refuses to start when the chip disagrees with the requested
 * PROJECT — a guard that exists because a run once went to the previous
 * session's folder while the log claimed otherwise. It just fired on a folder
 * that exists and is writable, so either `project:set` is returning nothing or
 * the renderer is not re-rendering from it. This reports BOTH sides: the raw
 * IPC result, the store state, and the text the chip actually shows.
 *
 *   node tests/e2e/project-chip-probe.mjs [dir]
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const dir = path.resolve(process.argv[2] ?? '/Users/user/bobble-testbed/corp-godot');
mkdirSync(dir, { recursive: true });

// ISOLATED on purpose: this only needs the project machinery, and the user's real
// profile carries his project list — a diagnostic must not edit it.
const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-proj-'))}`],
  env: {
    ...process.env,
    PI_BIN: path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs'),
    MOCK_PI_FIXTURE: path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json'),
    PI_E2E: '1',
    PI_E2E_NO_SERVER: '1',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => typeof window.__pi_project === 'function' && typeof window.__pi_store === 'function',
    { timeout: 25000 },
  );
  await page.waitForTimeout(2500);

  const before = await page.evaluate(() => {
    const s = window.__pi_project().getState();
    return { activePath: s.activePath, activeId: s.activeId, projects: s.projects?.length ?? 0 };
  });

  // The raw IPC first, so a null result is distinguishable from a render problem.
  const ipc = await page.evaluate(
    async (d) => await window.piDesktop.invoke('project:set', { path: d }).catch((e) => ({ error: String(e) })),
    dir,
  );

  const viaStore = await page.evaluate(async (d) => {
    await window.__pi_project().getState().selectPath(d);
    const s = window.__pi_project().getState();
    return { activePath: s.activePath, activeId: s.activeId, usingSandbox: s.usingSandbox };
  }, dir);

  await page.waitForTimeout(2000);

  const chip = await page.evaluate(() => {
    const el = document.querySelector('.pd-project-chip');
    // Report every candidate: if the class moved, "chip missing" and "chip says
    // No project" are completely different bugs and must not look the same.
    const cands = [...document.querySelectorAll('[class*="project"]')]
      .slice(0, 6)
      .map((n) => ({ cls: n.className, text: (n.textContent || '').trim().slice(0, 40) }));
    return { chipFound: el !== null, chipText: (el?.textContent || '').trim(), cands };
  });

  console.log(JSON.stringify({ dir, before, ipcProject: ipc?.project ?? ipc, viaStore, chip }, null, 2));
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
}
