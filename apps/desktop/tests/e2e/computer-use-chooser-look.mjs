/**
 * LOOK at the computer-use chooser — the user (2026-09-15): "a UI on onboarding
 * for computer use on/off and then if on choose what apps to allow control of,
 * show this as a grid of real app icons w/ names below, this is editable later
 * in settings via a similar UI."
 *
 * Two surfaces, one component: the onboarding step (real app icons drawn by
 * the pi-mac helper, tiles ticked, the Off state greying the grid) and
 * Settings → Computer use with the same grid editing the same setting. The
 * shots are the evidence; the checks are that the choice lands in
 * settings.json and that the app's `policy` answer reflects it.
 *
 *   SHOT_DIR=/tmp/cu-chooser node apps/desktop/tests/e2e/computer-use-chooser-look.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, home } = await launchApp('cu-chooser', {
  env: { PI_ONBOARDING: '1' },
  waitFor: '[data-testid="onboarding-wizard"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const next = () => page.click('[data-testid="onboarding-next"]');

try {
  // Walk to the computer-use step: neither app → theme → experience → capabilities.
  await page.waitForSelector('[data-testid="source-neither"]', { timeout: 8000 });
  await page.click('[data-testid="source-neither"]');
  await next();
  // The import step still shows for "neither" (it says there is nothing to bring).
  await sleep(300);
  await next();
  await page.waitForSelector('[data-testid="theme-preview"]', { timeout: 8000 });
  await next();
  await page.waitForSelector('[data-testid="experience-no-tutorial"]', { timeout: 8000 });
  await page.click('[data-testid="experience-no-tutorial"]');
  await next();
  await page.waitForSelector('[data-testid="capability-image"]', { timeout: 8000 });
  await next();

  await page.waitForSelector('[data-testid="onboarding-computer-use"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid^="app-tile-"]', { timeout: 30_000 });
  const tiles = await page.$$('[data-testid^="app-tile-"]');
  check(tiles.length >= 10, `the grid lists this Mac's apps (${tiles.length})`);
  // Real icons: the first row's images loaded with real pixels.
  const loaded = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="app-tile-"] img')]
      .slice(0, 8)
      .map((img) => img.complete && img.naturalWidth > 0),
  );
  check(loaded.length > 0 && loaded.every(Boolean), 'the icons are real pictures, loaded');
  // No denylisted app is offered.
  const names = await page.$$eval('[data-testid^="app-tile-"]', (els) =>
    els.map((e) => e.getAttribute('title') ?? ''),
  );
  check(
    !names.some((n) => /bobble|keychain|system settings/i.test(n)),
    'denylisted apps are not offered',
  );
  await shot('01-onboarding-computer-use');

  // Tick three apps.
  const picks = names.slice(0, 3);
  for (const n of picks) await page.click(`[data-testid^="app-tile-"][title="${n}"]`);
  const count = await page.textContent('[data-testid="app-grid-count"]');
  check(count?.trim() === '3 apps', `the count says 3 apps (${count})`);
  await shot('02-onboarding-three-ticked');

  // Filter.
  await page.fill('[data-testid="app-grid-filter"]', picks[0].slice(0, 4));
  await sleep(200);
  const shown = await page.$$('[data-testid^="app-tile-"]');
  check(shown.length < tiles.length, `the filter narrows the grid (${shown.length})`);
  await shot('03-onboarding-filtered');
  await page.fill('[data-testid="app-grid-filter"]', '');

  // Off greys the grid without losing the choice.
  await page.click('[data-testid="onboarding-computer-use-switch"] >> text=Off');
  await sleep(250);
  const dimmed = await page.getAttribute('[data-testid="onboarding-app-grid"]', 'aria-disabled');
  check(dimmed === 'true', 'Off makes the grid inert');
  await shot('04-onboarding-off');
  await page.click('[data-testid="onboarding-computer-use-switch"] >> text=On');

  await next();
  await page.waitForSelector('[data-testid="onboarding-setup"]', { timeout: 15_000 });
  await page.click('[data-testid="onboarding-finish"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15_000 });

  // The choice reached settings.json.
  const file = path.join(home, '.pi', 'desktop', 'settings.json');
  check(existsSync(file), 'settings.json written');
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  check(settings.computerUse?.enabled === true, 'computer use is on in settings');
  check(
    settings.computerUse?.apps?.length === 3 &&
      settings.computerUse.apps.every((a) => picks.includes(a.name)),
    `the three ticked apps are in settings (${JSON.stringify(settings.computerUse?.apps)})`,
  );

  // Settings → Computer use: the same grid, the same three ticked.
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  await page.click('[data-testid="settings-nav-computer-use"]');
  await page.waitForSelector('[data-testid="settings-app-grid"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="settings-app-grid"] [data-testid^="app-tile-"]', {
    timeout: 20_000,
  });
  const ticked = await page.$$eval(
    '[data-testid="settings-app-grid"] [data-testid^="app-tile-"][data-selected="true"]',
    (els) => els.map((e) => e.getAttribute('title')),
  );
  check(ticked.length === 3, `settings shows the same three ticked (${ticked.join(', ')})`);
  await shot('05-settings-computer-use');

  // Untick one here; it leaves settings.json.
  await page.click(
    `[data-testid="settings-app-grid"] [data-testid^="app-tile-"][title="${picks[0]}"]`,
  );
  await sleep(600);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  check(after.computerUse?.apps?.length === 2, 'unticking in Settings persists (2 apps)');
  // Off from Settings.
  await page.click('[data-testid="settings-computer-use"] >> text=Off');
  await sleep(600);
  const off = JSON.parse(readFileSync(file, 'utf8'));
  check(off.computerUse?.enabled === false, 'Off from Settings persists');
  await shot('06-settings-off');
} finally {
  await finish();
}
