/**
 * The Connectors screen on a FRESH install — nothing added, no keys, no
 * skills on — photographed headless at the shell width, light and dark. The
 * design probe's fixture home has six servers in it; this is the other first
 * impression: "Installed ›" with only the way to add something, and the
 * built-ins as the seven things that already work.
 *
 *   pnpm build && node tests/e2e/connectors-fresh-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, launchApp } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(APP_ROOT, 'src', 'connectors', 'shots');

const { page, check, finish } = await launchApp('connectors-fresh', {
  waitFor: '[data-testid="nav-connectors"]',
});

async function setTheme(modeName) {
  await page.evaluate((m) => {
    document.documentElement.setAttribute('data-flavor', 'bobble');
    document.documentElement.setAttribute('data-mode', m);
  }, modeName);
  await page.waitForTimeout(350);
}

async function shot(file) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  const buf = await page.screenshot();
  writeFileSync(path.join(OUT, file), buf);
  check(buf.length > 5000, `blank screenshot ${file}`);
  console.log(`  shot ${file}`);
}

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-installed"]', { timeout: 15_000 });
  await page.waitForTimeout(800);
  check(
    (await page.$$('[data-testid^="connector-tile-"]')).length === 0,
    'nothing in the strip on a fresh install',
  );
  check(
    await page.$('[data-testid="connectors-installed-empty"]'),
    'the strip says what it is for when it is empty',
  );
  check(await page.$('[data-testid="connectors-add-server"]'), 'the way to add a server is there');
  await setTheme('light');
  await shot('fresh-light.png');
  await setTheme('dark');
  await shot('fresh-dark.png');
  await page.click('[data-testid="connectors-installed-toggle"]');
  await page.waitForSelector('[data-testid="connectors-installed-list"]', { timeout: 4000 });
  await page.waitForTimeout(300);
  check(
    await page.$(
      '[data-testid="connectors-installed-list"] [data-testid="connector-card-mac-calendar"]',
    ),
    'open, the built-ins are listed',
  );
  await shot('fresh-installed-open-dark.png');
  await setTheme('light');
  await shot('fresh-installed-open-light.png');
} finally {
  await finish();
}
