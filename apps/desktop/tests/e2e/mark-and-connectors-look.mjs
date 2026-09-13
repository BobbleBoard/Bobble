/** LOOK: the white mark in both themes, and the CLI tools connector card. */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('mark-and-connectors-look');
await page.waitForTimeout(500);
for (const m of ['dark', 'light']) {
  await page.evaluate(
    (mm) =>
      window
        .__settings_store?.()
        .getState?.()
        .update?.({ theme: { mode: mm } }),
    m,
  );
  await page.waitForTimeout(600);
  const fills = await page.evaluate(() =>
    [...document.querySelectorAll('svg[aria-label="Bobble"] rect')].map((r) =>
      r.getAttribute('fill'),
    ),
  );
  check(
    fills.length === 3 && fills.every((f) => f?.toLowerCase() === '#ffffff'),
    `${m}: mark tiles should be white, got ${JSON.stringify(fills)}`,
  );
  const logo = await page.$('svg[aria-label="Bobble"]');
  const box = await logo.boundingBox();
  await page.screenshot({
    path: `${process.env.TMPDIR}/pd-shots/mark-and-connectors-look/${m}-mark.png`,
    clip: { x: box.x - 8, y: box.y - 8, width: 200, height: box.height + 16 },
  });
}
await page.click('text=Connectors').catch(() => {});
await page.waitForTimeout(1200);
const card = await page.evaluate(() => {
  const el = [...document.querySelectorAll('button, div, a')].find(
    (e) =>
      /^CLI tools$/.test(e.textContent?.trim() ?? '') ||
      e.getAttribute('data-connector-id') === 'cli-tools',
  );
  return el ? el.textContent?.slice(0, 80) : null;
});
check(
  card !== null || (await page.evaluate(() => document.body.innerText.includes('CLI tools'))),
  'the CLI tools card should be in the gallery',
);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(
    (e) => e.children.length === 0 && e.textContent?.trim() === 'CLI tools',
  );
  el?.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(400);
await shot('connectors');
await finish();
