import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const HOME = mkdtempSync(path.join(tmpdir(), 'omni-home-'));
const app = await electron.launch({
  executablePath: '/Applications/Bobble.app/Contents/MacOS/Bobble',
  args: [`--user-data-dir=${path.join(HOME, 'udd')}`],
  env: { ...process.env, HOME, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  await page.getByText('Extensions', { exact: true }).first().click();
  await page.waitForTimeout(1800);
  await page.getByPlaceholder('Search connectors').fill('OmniSVG');
  await page.waitForTimeout(700);
  const card = page
    .locator('[data-testid="connector-download-omnisvg"], [data-testid="connector-add-omnisvg"]')
    .first();
  const heading = page.getByText('OmniSVG', { exact: true }).first();
  await page.screenshot({ path: process.argv[2] ?? '/tmp/omnisvg-connectors.png' });
  const add = await page.locator('[data-testid="connector-download-omnisvg"]').count();
  const list = await page.evaluate(() => window.piDesktop.invoke('connectors:list', undefined));
  console.log('download button:', add, '| installedModels:', JSON.stringify(list.installedModels));
  console.log(
    'catalog has omnisvg:',
    list.catalog.some((c) => c.id === 'omnisvg'),
    '| catalog size:',
    list.catalog.length,
  );
  console.log(
    'model-kind entries:',
    JSON.stringify(list.catalog.filter((c) => c.kind === 'model').map((c) => c.id)),
  );
  await heading.click();
  await page.waitForTimeout(900);
  await page.screenshot({
    path: (process.argv[2] ?? '/tmp/omnisvg-connectors.png').replace('.png', '-detail.png'),
  });
  console.log(
    'status:',
    await page
      .locator('[data-testid="connector-detail-status"]')
      .textContent()
      .catch(() => '?'),
  );
} finally {
  await app.close().catch(() => {});
}
