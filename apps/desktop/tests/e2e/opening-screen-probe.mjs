/**
 * The opening screen after the blind test: what the app says about itself
 * before anything is typed.
 *
 *   - the local claim is on screen ("Running on your Mac" / "Runs on your Mac"),
 *     with the model name as the GREY line under it, not the headline;
 *   - four clickable examples, and clicking one FILLS the composer rather than
 *     firing a request the user has not read;
 *   - the empty chat list says where the chats live.
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/opening node apps/desktop/tests/e2e/opening-screen-probe.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('opening-screen');

try {
  await page.waitForSelector('[data-testid="starter-chips"]', { timeout: 15_000 });
  // The sidebar slides in over ~300ms (@starting-style translate); a shot taken
  // before it lands photographs a rail, not the panel this probe is about.
  await page.waitForSelector('[data-testid="local-model-badge"]', { timeout: 10_000 });
  await page.waitForTimeout(900);

  const view = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const badge = q('[data-testid="local-model-badge"]');
    const headline = q('[data-testid="local-headline"]');
    const detail = q('[data-testid="local-detail"]');
    const px = (el) => (el === null ? null : Number.parseFloat(getComputedStyle(el).fontSize));
    const colour = (el) => (el === null ? null : getComputedStyle(el).color);
    return {
      badgeDot: badge?.getAttribute('data-dot') ?? null,
      headline: headline?.textContent ?? null,
      detail: detail?.textContent ?? null,
      headlineSize: px(headline),
      detailSize: px(detail),
      detailColour: colour(detail),
      mutedColour: getComputedStyle(document.documentElement)
        .getPropertyValue('--pd-text-muted')
        .trim(),
      chips: [...document.querySelectorAll('button[data-testid^="starter-"]')].map(
        (b) => b.textContent,
      ),
      privacy: q('[data-testid="privacy-line"]')?.textContent ?? null,
    };
  });
  console.log('  ', JSON.stringify(view, null, 1));

  check(view.headline !== null, 'the sidebar says what the app is');
  check(
    view.headline !== null && /on your Mac/i.test(view.headline),
    `the local claim is on screen (got "${view.headline}")`,
  );
  check(view.detail !== null, 'the model name is present as a second line');
  check(
    view.detailSize !== null && view.headlineSize !== null && view.detailSize < view.headlineSize,
    `the model name is SMALLER than the claim above it (${view.detailSize}px vs ${view.headlineSize}px)`,
  );
  check(view.chips.length === 4, `four starter chips (got ${view.chips.length})`);
  check(
    view.privacy !== null && /stay on this Mac/.test(view.privacy),
    `the sidebar says where the chats live, permanently (got "${view.privacy}")`,
  );

  await shot('01-opening');

  // Clicking fills the box; it must NOT send.
  const before = await page.evaluate(() => window.__pi_store().getState().messages.length);
  await page.click('[data-testid="starter-image"]');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    text: document.querySelector('.pd-composer-editor')?.textContent ?? '',
    messages: window.__pi_store().getState().messages.length,
  }));
  console.log(`   composer now: "${after.text.slice(0, 60)}"`);
  check(after.text.length > 20, 'clicking a chip fills the composer with a whole request');
  check(after.messages === before, 'clicking a chip does NOT send anything');
  await shot('02-chip-clicked');

  /* ── The three states of the badge, photographed ────────────────────────
   *
   * The whole point of this block is that a model coming up LOOKS like a model
   * coming up. Driven through the stores rather than a real llama-server so it
   * is deterministic and costs a second, not a minute.
   */
  const badge = async (label) => {
    await page.waitForTimeout(400);
    const v = await page.evaluate(() => ({
      dot: document.querySelector('[data-testid="local-model-badge"]')?.getAttribute('data-dot'),
      headline: document.querySelector('[data-testid="local-headline"]')?.textContent,
      detail: document.querySelector('[data-testid="local-detail"]')?.textContent,
    }));
    console.log(`   ${label}: [${v.dot}] ${v.headline} / ${v.detail}`);
    return v;
  };

  await page.evaluate(() => {
    window
      .__model_selection_store()
      .getState()
      .setSwitching({ toTier: 'balanced', toName: 'Qwen3.5 9B (MTP)' });
    window.__llm_store().getState().applyStatus({
      phase: 'starting',
      serverRunning: false,
      baseUrl: null,
      model: null,
      metrics: null,
      downloadedModelIds: [],
    });
  });
  const starting = await badge('starting');
  check(starting.dot === 'working', 'a model coming up shows the working dot');
  check(
    /Starting on your Mac/.test(starting.headline ?? '') && !/%/.test(starting.headline ?? ''),
    `the loading line names the event and never a percentage (got "${starting.headline}")`,
  );
  check(starting.detail === 'Qwen3.5 9B (MTP)', 'the model name is the grey line while it starts');
  await page.waitForTimeout(2200);
  const ticked = await badge('starting +2s');
  check(
    /· \d+:\d\d$/.test(ticked.headline ?? ''),
    `the count is running (got "${ticked.headline}")`,
  );
  await shot('03-badge-starting');

  await page.evaluate(() => {
    window.__model_selection_store().getState().setSwitching(null);
    window
      .__llm_store()
      .getState()
      .applyStatus({
        phase: 'ready',
        serverRunning: true,
        baseUrl: 'http://127.0.0.1:8080',
        model: {
          id: 'qwen3.5-9b-mtp',
          displayName: 'Qwen3.5 9B (MTP)',
          quant: 'Q4',
          contextWindow: 65536,
        },
        metrics: null,
        downloadedModelIds: ['qwen3.5-9b-mtp'],
      });
  });
  const ready = await badge('ready');
  check(ready.dot === 'ready', 'a resident model shows the ready dot');
  check(ready.headline === 'Running on your Mac', `the claim settles (got "${ready.headline}")`);
  check(ready.detail === 'Qwen3.5 9B (MTP)', 'and the model stays the grey line');
  await shot('04-badge-ready');

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
