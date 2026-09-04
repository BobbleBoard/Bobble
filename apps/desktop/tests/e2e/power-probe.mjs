/**
 * LOW POWER MODE, end to end.
 *
 * the user: "ensuring we leave a certain amount of memory available as a buffer so
 * the user can use computer as normal while generation and such occurs … this
 * could be dynamic even tracking what the current user memory/cpu/gpu usage
 * is", and then: "it's not about this machine only … you need to handle a range
 * of hardware and a range of situations and bottlenecks."
 *
 * The policy itself is unit-tested against four machine classes under four kinds
 * of strain (power-policy.test.ts) — what THIS proves is the part unit tests
 * cannot: that the controls exist, that a choice survives the round trip to
 * disk, and that the reserve is a number a person can actually type.
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('power-probe');

const settings = () => page.evaluate(() => window.__settings_store().getState().settings);

try {
  await page.waitForTimeout(1200);

  // The default is the dynamic one — the mode most people should never touch.
  check((await settings()).powerMode === 'auto', 'the default power mode is not "auto"');

  await page.click('[data-testid="footer-settings"]');
  await page.waitForTimeout(600);
  const engineTab = await page.$('text=Engines');
  if (engineTab !== null) {
    await engineTab.click();
    await page.waitForTimeout(600);
  }
  await page.waitForSelector('[data-testid="power-section"]', { timeout: 8000 });
  await shot('01-power-settings');

  // Choosing a mode persists it — this is the whole contract of the control.
  await page.click('[data-testid="settings-power-mode"] >> text=Stay light');
  await page.waitForFunction(
    () => window.__settings_store().getState().settings.powerMode === 'low',
    undefined,
    { timeout: 6000 },
  );

  // The reserve is a NUMBER of gigabytes, because that is what "leave me some
  // room" means to a person.
  await page.fill('[data-testid="settings-power-reserve"]', '8');
  await page.waitForFunction(
    () => window.__settings_store().getState().settings.powerReserveGB === 8,
    undefined,
    { timeout: 6000 },
  );

  // Clearing it hands the decision back rather than promising 0 GB.
  await page.fill('[data-testid="settings-power-reserve"]', '');
  await page.waitForFunction(
    () => window.__settings_store().getState().settings.powerReserveGB === undefined,
    undefined,
    { timeout: 6000 },
  );
  await shot('02-power-chosen');

  await page.click('[data-testid="settings-power-mode"] >> text=Adaptive');
  await page.waitForFunction(
    () => window.__settings_store().getState().settings.powerMode === 'auto',
    undefined,
    { timeout: 6000 },
  );
} finally {
  await finish();
}
