/**
 * LOOK at Settings → Experimental — the user (2026-09-16): "disable-able in
 * settings under an experimental menu (place down here alternative inference
 * engine support by the way that's also experimental)."
 *
 * The memory guard's switch and its reserve, then the engines beneath. Both
 * the switch and the reserve land in settings.json.
 *
 *   SHOT_DIR=/tmp/experimental node apps/desktop/tests/e2e/experimental-settings-look.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, home } = await launchApp('experimental-look', {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = () => {
  const file = path.join(home, '.pi', 'desktop', 'settings.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};
try {
  // The chat's top bar with its ordinary status pill — the slot the guard's
  // notice takes over when it has something to say.
  await page.waitForSelector('[data-testid="topbar-status"]', { timeout: 15_000 }).catch(() => {});
  await shot('00-chat-topbar');
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  check(
    (await page.$('[data-testid="settings-nav-engines"]')) === null,
    'Engines is no longer its own section',
  );
  await page.click('[data-testid="settings-nav-experimental"]');
  await page.waitForSelector('[data-testid="experimental-panel"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="engine-panel"]', { timeout: 15_000 });
  await sleep(600);
  await shot('01-experimental');
  const guardOn = await page
    .getAttribute(
      '[data-testid="settings-memory-guard"] [aria-checked="true"], [data-testid="settings-memory-guard"] [data-state="on"]',
      'textContent',
    )
    .catch(() => null);
  await page.click('[data-testid="settings-memory-guard"] >> text=Off');
  await sleep(600);
  check(settings().memoryGuard === false, 'Off lands in settings.json');
  await shot('02-guard-off');
  await page.click('[data-testid="settings-memory-guard"] >> text=On');
  await sleep(600);
  check(settings().memoryGuard !== false, 'On lands in settings.json');
  await page.fill('[data-testid="settings-power-reserve"]', '6');
  await sleep(600);
  check(settings().powerReserveGB === 6, `the reserve lands (${settings().powerReserveGB})`);
  // The engines are here, with their power mode.
  check(
    (await page.$('[data-testid="settings-power-mode"]')) !== null,
    'the engines and their power mode sit under Experimental',
  );
  void guardOn;
} finally {
  await finish();
}
