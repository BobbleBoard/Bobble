/**
 * b14: the accessibility surface.
 *
 * The run was silent to assistive tech, there was no main landmark to jump to,
 * and the canvas tabs carried `role="tab"` without the rest of the pattern —
 * which is worse than plain buttons, because a screen reader then promises
 * behaviour that is not there.
 *
 * VoiceOver itself cannot be driven from a probe. What is asserted here is
 * everything the DOM can answer for; the listening pass is a separate job.
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
const PROBE_HOME = probeHome('a11y-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`a11y-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-a11y-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  // --- the main landmark ----------------------------------------------------
  const mains = await page.evaluate(() => document.querySelectorAll('main, [role="main"]').length);
  if (mains !== 1) fail(`expected exactly one main landmark, found ${mains}`);
  else console.log('[a11y] OK: one main landmark');

  // --- the live region exists, is polite, and starts silent ------------------
  const region = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="stage-announcer"]');
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return {
      live: el.getAttribute('aria-live'),
      atomic: el.getAttribute('aria-atomic'),
      role: el.getAttribute('role'),
      text: el.textContent ?? '',
      // It must be in the accessibility tree — `display:none` would remove it.
      display: cs.display,
      visibility: cs.visibility,
    };
  });
  if (region === null) fail('there is no live region');
  else if (region.live !== 'polite') fail(`live region is "${region.live}", not polite`);
  else if (region.display === 'none' || region.visibility === 'hidden') {
    fail('the live region is hidden in a way that removes it from the a11y tree');
  } else console.log('[a11y] OK: a polite live region, present to the tree');

  // --- it announces a STAGE, and never the tokens ----------------------------
  await page.click('.pd-composer-editor');
  await page.keyboard.type('say something');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const during = await page.evaluate(
    () => document.querySelector('[data-testid="stage-announcer"]')?.textContent ?? '',
  );
  if (during.trim() === '') fail('nothing was announced during a turn');
  else if (during.length > 40) fail(`the region is carrying content, not a stage: "${during}"`);
  else console.log(`[a11y] OK: announced a stage — "${during}"`);

  // --- the canvas tab pattern ------------------------------------------------
  await page.keyboard.press('Meta+t');
  await page.waitForTimeout(1200);
  const tabs = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    if (list === null) return null;
    const items = [...document.querySelectorAll('[role="tab"]')];
    const panel = document.querySelector('[role="tabpanel"]');
    return {
      count: items.length,
      allHaveIds: items.every((t) => t.id !== ''),
      allControlAPanel: items.every((t) => t.getAttribute('aria-controls') !== null),
      controlsExist: items.every(
        (t) => document.getElementById(t.getAttribute('aria-controls') ?? '') !== null,
      ),
      tabbable: items.filter((t) => t.getAttribute('tabindex') !== '-1').length,
      panelLabelled: panel?.getAttribute('aria-labelledby') ?? null,
    };
  });
  if (tabs === null || tabs.count === 0) {
    fail('no canvas tabs to check');
  } else {
    if (!tabs.allHaveIds) fail('a tab has no id, so nothing can reference it');
    if (!tabs.allControlAPanel) fail('a tab does not say which panel it controls');
    if (!tabs.controlsExist) fail('a tab points at a panel that does not exist');
    // Roving tabindex: exactly one stop for the whole strip.
    if (tabs.tabbable !== 1) fail(`${tabs.tabbable} tabs are tabbable; the pattern wants 1`);
    if (tabs.panelLabelled === null) fail('the panel does not name the tab that selected it');
    if (process.exitCode !== 1) console.log(`[a11y] OK: ${tabs.count} tabs, full pattern`);
  }
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('a11y-probe OK');
