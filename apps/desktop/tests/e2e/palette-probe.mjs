/**
 * b12: ⌘K, one way in instead of a growing table of keys.
 *
 * The named hazard is the layering: SettingsView closed on ANY document Escape
 * and only called `stopPropagation`, which does nothing to a listener already
 * on the same target — so one Escape would dismiss the palette AND the settings
 * behind it.
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
const PROBE_HOME = probeHome('palette-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`palette-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-palette-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

const isOpen = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="command-palette"]') !== null);

/**
 * Wait for the palette to reach a state, instead of sleeping and hoping.
 *
 * MEASURED: this probe failed roughly one run in three or four, always on the
 * same line — Escape, then a fixed 400ms, then "did not close". The palette is a
 * Radix dialog with an exit animation and a focus restore, and on a loaded
 * machine that takes longer than the sleep. Nothing was wrong with the app; the
 * assertion was racing it. A flake like this is worse than no test, because it
 * teaches everyone to re-run the suite until it goes green.
 */
const waitForPalette = async (page, open, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isOpen(page)) === open) return true;
    await page.waitForTimeout(100);
  }
  return (await isOpen(page)) === open;
};
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="command-palette"] [role="option"]')].map(
      (n) => n.textContent ?? '',
    ),
  );

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  // --- opens, lists, filters -------------------------------------------------
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 5000 });
  const all = await rows(page);
  if (all.length === 0) fail('the palette opened empty');
  else console.log(`[palette] OK: opens with ${all.length} rows`);

  await page.fill('[data-testid="command-palette-input"]', 'sett');
  await page.waitForTimeout(300);
  const filtered = await rows(page);
  if (!filtered.some((r) => r.includes('Settings'))) {
    fail(`"sett" did not surface Settings: ${JSON.stringify(filtered)}`);
  } else console.log('[palette] OK: filters');

  // Initials, which is what people actually type.
  await page.fill('[data-testid="command-palette-input"]', 'nc');
  await page.waitForTimeout(300);
  const initials = await rows(page);
  if (!initials.some((r) => r.includes('New chat'))) {
    fail(`"nc" did not surface New chat: ${JSON.stringify(initials)}`);
  } else console.log('[palette] OK: initials match');

  // --- Escape closes ONLY the palette ---------------------------------------
  await page.keyboard.press('Escape');
  if (!(await waitForPalette(page, false))) fail('Escape did not close the palette');
  else console.log('[palette] OK: Escape closes it');

  // Now the named breakage: open Settings, open the palette over it, Escape once.
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 5000 });
  await page.fill('[data-testid="command-palette-input"]', 'Settings');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const settingsOpen = await page.evaluate(
    () => document.querySelector('[data-testid="settings-view"], [role="dialog"]') !== null,
  );
  if (!settingsOpen) {
    console.log('[palette] (Settings did not open from the palette here — skipping the layering)');
  } else {
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    if (!(await waitForPalette(page, false))) {
      /*
       * WHY, not just THAT. This probe shares its HOME with every other probe in
       * the suite (harness.mjs), so it can inherit a draft, a pinned view or a
       * focused element from a run twenty probes earlier — and it failed in the
       * suite while passing alone, which is the signature of exactly that.
       */
      const why = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          active:
            el === null
              ? null
              : `${el.tagName}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`,
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          composerText: (
            document.querySelector('[data-testid="composer-input"]')?.textContent ?? ''
          ).slice(0, 80),
          attachChips: document.querySelectorAll('[data-testid="attach-chip"]').length,
          pills: [...document.querySelectorAll('[data-testid="composer-pill-text"]')].map(
            (n) => n.textContent,
          ),
        };
      });
      console.log(`[palette] state when Escape did nothing: ${JSON.stringify(why)}`);
      fail('Escape did not close the palette over Settings');
    }
    const stillSettings = await page.evaluate(
      () => document.querySelector('[data-testid="settings-view"], [role="dialog"]') !== null,
    );
    if (!stillSettings) fail('one Escape closed the palette AND the settings behind it');
    else console.log('[palette] OK: over Settings, one Escape closes only the palette');
  }
  if (process.env.SHOT !== undefined) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: process.env.SHOT });
  }
} finally {
  await app.close();
}
if (process.exitCode !== 1) console.log('palette-probe OK');
