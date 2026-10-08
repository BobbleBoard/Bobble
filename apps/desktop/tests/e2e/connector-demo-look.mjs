/**
 * TRY IT, PLAYED — a connector's page shows its ask going through.
 *
 * the user (2026-10-08): "a prominent card that shows a little animation of an
 * input text bubble sliding up, and then some model response that goes 'Sure
 * i'll use <the connector> to do this' the 'used <connector>' tool visual, a
 * sped up 'worked for nm ns' and then done".
 *
 * Opens Google Calendar's page and photographs the card as it plays — the ask,
 * the reply's line, the row running under a counting "Worked for", then Used and
 * Done — and checks each phase and the final words, then Replay.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/connector-demo-look.mjs
 */
import { launchApp } from './harness.mjs';

const NAME = process.env.CONNECTOR ?? 'Google Calendar';
const { page, check, shot, finish } = await launchApp('connector-demo', {
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () =>
  page.evaluate(() => {
    const demo = document.querySelector('[data-testid="connector-demo"]');
    return {
      phase: demo?.getAttribute('data-phase') ?? null,
      text: (demo?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
try {
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-search"]', { timeout: 10_000 });
  await page.fill('[data-testid="connectors-search"]', NAME);
  await sleep(800);
  await page.getByText(NAME, { exact: true }).first().click();
  await page.waitForSelector('[data-testid="connector-demo"]', { timeout: 10_000 });
  const seen = [];
  const t0 = Date.now();
  for (const at of [500, 1300, 2300, 3200, 4300]) {
    await sleep(Math.max(0, at - (Date.now() - t0)));
    const s = await state();
    seen.push(s.phase);
    console.log(at, s.phase, '|', s.text.slice(0, 160));
    await page.evaluate(() =>
      document.querySelector('[data-testid="connector-demo"]')?.scrollIntoView({ block: 'center' }),
    );
    await shot(`${String(at).padStart(4, '0')}-${s.phase}`);
  }
  const end = await state();
  check(
    seen.includes('asked') || seen.includes('said'),
    `the ask arrives first (${seen.join(' → ')})`,
  );
  check(seen.includes('working'), 'the row works');
  check(end.phase === 'done', `it ends done (${end.phase})`);
  check(
    end.text.includes(`Sure, I’ll use ${NAME} to do this.`),
    'the reply says which connector it will use',
  );
  check(end.text.includes(`Used ${NAME}`), `the row says Used ${NAME}`);
  check(
    /Worked for 1m 12s/.test(end.text),
    `a sped-up Worked for (${end.text.match(/Worked for [^A-Z]*/)?.[0]})`,
  );
  check(/Done/.test(end.text), 'and Done');
  await page.click('[data-testid="connector-demo-replay"]');
  await sleep(400);
  check((await state()).phase !== 'done', 'Replay plays it again');
} finally {
  await finish();
}
