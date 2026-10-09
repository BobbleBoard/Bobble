/**
 * THE FIRST RUN, AS A NEW PERSON SEES IT — every onboarding step photographed.
 *
 * For the onboarding review (2026-10-09: "take a look back at onboarding … and
 * get specifics we need to work on"). Hidden window, throwaway HOME, the real
 * first-run gate (PI_ONBOARDING=1), no models in the library: a fresh Mac.
 * Walks the path of someone arriving from no other app, captures each step,
 * then the chat they land in, then what "hi" does with no model on the Mac.
 * Read-only: it never presses the setup step's Start (that downloads gigabytes).
 *
 *   SCHEME=light|dark (default light)
 */
import { launchApp } from './harness.mjs';

const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { page, check, shot, finish } = await launchApp(`onboarding-look-${SCHEME}`, {
  env: { PI_ONBOARDING: '1', PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="onboarding-wizard"]',
  colorScheme: SCHEME,
  timeout: 60_000,
});

const notes = [];
try {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page
    .waitForSelector('[data-testid="onboarding-loading"]', { state: 'detached', timeout: 20_000 })
    .catch(() => {});
  await sleep(800);
  for (let i = 0; i < 9; i += 1) {
    const title = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
    const stepLabel = await page.evaluate(
      () => [...document.querySelectorAll('div')].find((d) => /^Step \d+ of \d+$/.test(d.textContent ?? ''))?.textContent ?? '',
    );
    await shot(`${String(i + 1).padStart(2, '0')}-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    const text = await page.evaluate(() => document.querySelector('[data-testid="onboarding-wizard"]')?.innerText ?? '');
    notes.push(`${stepLabel} · ${title}\n${text.split('\n').slice(0, 40).join(' | ')}`);
    // The choices a new person makes on each step.
    if (await page.$('[data-testid="source-neither"]')) await page.click('[data-testid="source-neither"]');
    const exp = await page.$('[data-testid^="experience-"]');
    if (exp) await exp.click();
    await sleep(300);
    if (await page.$('[data-testid="onboarding-finish"]')) {
      await page.click('[data-testid="onboarding-finish"]');
      break;
    }
    const next = await page.$('[data-testid="onboarding-next"]');
    if (!next) break;
    await next.click();
    await sleep(700);
  }
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  await sleep(1500);
  await shot('10-first-chat');
  notes.push(`first chat\n${(await page.evaluate(() => document.body.innerText)).split('\n').slice(0, 60).join(' | ')}`);
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  await sleep(4000);
  await shot('11-hi-with-no-model');
  notes.push(`after "hi"\n${(await page.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText)).split('\n').slice(-30).join(' | ')}`);
  check(true, 'walked');
} catch (error) {
  check(false, `probe error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  console.log(notes.join('\n\n'));
  await finish();
}
