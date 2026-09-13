/**
 * LOOK at Settings → Engines with the new rows (mlx-dspark, oMLX, mlx-lm,
 * NInfer, NInfer 3090) and their install state on this machine. Mock pi, no
 * model server (PI_E2E_NO_SERVER) — this is about the panel, not inference.
 *
 *   SHOT_DIR=/tmp/engines node apps/desktop/tests/e2e/engines-panel-look.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('engines-panel', {
  env: { PI_E2E_NO_SERVER: '1' },
  realCache: true,
});
try {
  await page.waitForSelector('.pd-composer-root', { timeout: 20_000 });
  await page.click('[data-testid="profile-button"]');
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 10_000 });
  await page.click('[data-testid="settings-nav-engines"]');
  await page.waitForSelector('[data-testid="engine-panel"]', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="engine-row-"]')].map((r) => ({
      id: r.dataset.testid.replace('engine-row-', ''),
      supported: r.dataset.supported,
      installed: r.dataset.installed,
      text: r.textContent?.replace(/\s+/g, ' ').slice(0, 110),
    })),
  );
  for (const r of rows) console.log(' ', JSON.stringify(r));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  check(byId['mlx-dspark']?.installed === 'yes', 'mlx-dspark reads installed on this Mac');
  check(byId.omlx?.installed === 'yes', 'oMLX reads installed on this Mac');
  check(byId['mlx-lm']?.installed === 'yes', 'mlx-lm reads installed on this Mac');
  check(
    byId.ninfer?.supported === 'no' && /RTX 5090/.test(byId.ninfer?.text ?? ''),
    'NInfer is greyed with the card it needs',
  );
  await shot('01-engines-panel');
  const el = await page.$('[data-testid="engine-row-ninfer"]');
  if (el) await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('02-engines-panel-bottom');
  console.log(`shots → ${shotDir}`);
} finally {
  await finish();
}
