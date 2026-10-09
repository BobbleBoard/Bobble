/**
 * THE FIRST RUN, AS A NEW PERSON SEES IT — every onboarding step photographed.
 *
 * For the onboarding review (2026-10-09: "take a look back at onboarding … and
 * get specifics we need to work on"). Hidden window, throwaway HOME, the real
 * first-run gate (PI_ONBOARDING=1), no models in the library: a fresh Mac.
 * Walks the path of someone arriving from no other app, captures each step,
 * then the chat they land in, then what "hi" does with no model on the Mac.
 * Read-only: it presses "Skip for now" (`onboarding-finish`), never "Download
 * and finish" (that downloads gigabytes).
 *
 * Asserts what the 2026-10-09 review asked for: four pages starting fresh, a
 * head and footer that hold still from page to page, Fraunces titles, no old
 * names or in-jokes, a real size on the download button, and the empty chat's
 * one-click model card in place of the tips popover.
 *
 *   SCHEME=light|dark (default light)
 */
import { launchApp } from './harness.mjs';

const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A person reads each page before pressing Continue; the look is taken at that
   pace so what arrives "late" is judged as a person would meet it. */
const PACE_MS = Number(process.env.PACE_MS ?? 2500);
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
  const heads = [];
  const lefts = [];
  const feet = [];
  const labels = [];
  let allText = '';
  for (let i = 0; i < 9; i += 1) {
    // The last page reads the engines and models first; wait for its buttons.
    if (await page.$('[data-testid="onboarding-setup"]')) {
      await page
        .waitForSelector('[data-testid="onboarding-finish"]', { timeout: 20_000 })
        .catch(() => {});
      await sleep(300);
    }
    const title = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
    const stepLabel = await page.evaluate(
      () => document.querySelector('[data-testid="onboarding-step-label"]')?.textContent ?? '',
    );
    labels.push(stepLabel);
    heads.push(await page.evaluate(() => document.querySelector('h1')?.getBoundingClientRect().y));
    lefts.push(await page.evaluate(() => document.querySelector('h1')?.getBoundingClientRect().x));
    feet.push(
      await page.evaluate(
        () =>
          document
            .querySelector('[data-testid="onboarding-next"], [data-testid="onboarding-finish"]')
            ?.getBoundingClientRect().y,
      ),
    );
    if (await page.$('[data-testid="onboarding-hands-on"]')) {
      const tiles = await page.$$eval(
        '[data-testid^="app-tile-"] img',
        (imgs) => imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
      );
      check(tiles > 0, `the app grid is full on arrival (${tiles} icons loaded)`);
    }
    if (i === 0) {
      const font = await page.evaluate(
        () => getComputedStyle(document.querySelector('h1')).fontFamily,
      );
      check(/Fraunces/.test(font), `titles are Fraunces (${font.split(',')[0]})`);
    }
    await shot(
      `${String(i + 1).padStart(2, '0')}-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    );
    const text = await page.evaluate(
      () => document.querySelector('[data-testid="onboarding-wizard"]')?.innerText ?? '',
    );
    allText += `\n${text}`;
    notes.push(`${stepLabel} · ${title}\n${text.split('\n').slice(0, 40).join(' | ')}`);
    // The choices a new person makes on each step.
    if (await page.$('[data-testid="source-neither"]'))
      await page.click('[data-testid="source-neither"]');
    const exp = await page.$('[data-testid^="experience-"]');
    if (exp) await exp.click();
    await sleep(300);
    const download = await page.$('[data-testid="onboarding-download-finish"]');
    if (download) {
      const label = (await download.textContent()) ?? '';
      check(
        /Download and finish · \d/.test(label),
        `the download button says its size ("${label}")`,
      );
    }
    if (await page.$('[data-testid="onboarding-finish"]')) {
      await page.click('[data-testid="onboarding-finish"]');
      break;
    }
    const next = await page.$('[data-testid="onboarding-next"]');
    if (!next) break;
    await sleep(PACE_MS);
    await next.click();
    await sleep(700);
  }
  check(
    labels.length === 4 && labels.every((l) => / of 4$/.test(l)),
    `starting fresh walks four pages (${labels.join(', ')})`,
  );
  const still = (ys) => ys.every((y) => y !== undefined && Math.abs(y - ys[0]) <= 1);
  check(still(heads), `the title holds still from page to page (${heads.join(', ')})`);
  check(still(lefts), `the column holds still sideways (${lefts.join(', ')})`);
  check(still(feet), `the buttons hold still from page to page (${feet.join(', ')})`);
  check(
    !/Model Manager|Gemma|llama\.cpp is|Nothing to import|Matched to your app/.test(allText),
    'no old names, second model, in-jokes or empty pages',
  );
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  await sleep(1500);
  await page
    .waitForSelector('[data-testid="first-model-card"]', { timeout: 15_000 })
    .catch(() => {});
  await shot('10-first-chat');
  check(
    (await page.$('[data-testid="first-model-download"]')) !== null,
    'the empty chat offers the first model in one click',
  );
  check((await page.$('[data-testid="first-run-tips"]')) === null, 'no tips popover over it');
  notes.push(
    `first chat\n${(await page.evaluate(() => document.body.innerText)).split('\n').slice(0, 60).join(' | ')}`,
  );
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  await sleep(4000);
  await shot('11-hi-with-no-model');
  notes.push(
    `after "hi"\n${(await page.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText)).split('\n').slice(-30).join(' | ')}`,
  );
  check(true, 'walked');
} catch (error) {
  check(false, `probe error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  console.log(notes.join('\n\n'));
  await finish();
}
