/**
 * THE MODEL HUB, after the user's four asks — photographed doing each one.
 *
 *   1. Recommended is a CURATED, family-grouped list, smallest first — not the
 *      Hub firehose with ten quant repos of the same model at the top.
 *   2. A family card EXPANDS DOWN into its versions.
 *   3. The model card on the right is PINNED: it survives scrolling the list.
 *   4. Every card has a plain Download that becomes a progress bar + red X.
 *   Plus: everything filterable by OUTPUT.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/model-hub';
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1700, height: 1050 });
});
await win.waitForTimeout(600);

const box = (sel) =>
  win.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }, sel);
const fail = (m) => {
  throw new Error(`model-hub-curated-probe: ${m}`);
};

try {
  await win.click('[data-testid="nav-model-management"]');
  await win.waitForSelector('[data-testid="models-view"]', { timeout: 10000 });
  await win.waitForTimeout(1500);

  // 1. CURATED, family-grouped, smallest first.
  await win.waitForSelector('[data-testid="curated-families"]', { timeout: 10000 });
  const families = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="family-card-"]')].map((el) => ({
      id: el.getAttribute('data-testid')?.replace('family-card-', ''),
      title: el.querySelector('button span span span')?.textContent?.trim(),
    })),
  );
  console.log(`families on screen (${families.length}):`, families.map((f) => f.id).join(', '));
  if (families.length < 10) fail(`only ${families.length} families rendered`);
  // THE CORE OF THE WHOLE THING: what this machine should run, per modality,
  // decided from real detected hardware rather than a guess.
  const best = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid^="best-"]')]
      .filter((el) => /^best-(text|image|video|audio|3d)$/.test(el.getAttribute('data-testid') ?? ''))
      .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const header = document
      .querySelector('[data-testid="best-for-your-machine"] span')
      ?.textContent?.trim();
    return { header, cards };
  });
  console.log('detected machine:', JSON.stringify(best.header));
  for (const c of best.cards) console.log('  •', c.slice(0, 150));
  if (best.cards.length === 0) fail('no per-modality recommendation was shown');
  if (!/GB to work with/.test(best.header ?? '')) fail('the strip does not say the memory budget');
  await win.screenshot({ path: path.join(OUT, '1-recommended.png') });

  // 2. EXPAND — measure the card growing rather than trusting the class.
  const first = families[0].id;
  const before = await box(`[data-testid="family-card-${first}"]`);
  await win.click(`[data-testid="family-toggle-${first}"]`);
  await win.waitForTimeout(120);
  const mid = await box(`[data-testid="family-card-${first}"]`);
  await win.waitForTimeout(400);
  const after = await box(`[data-testid="family-card-${first}"]`);
  console.log(`expand "${first}": ${before.h}px → ${mid.h}px (mid) → ${after.h}px`);
  if (after.h <= before.h) fail('the family card did not expand');
  if (mid.h === after.h || mid.h === before.h) fail('the expansion was a jump, not a slide');
  await win.screenshot({ path: path.join(OUT, '2-expanded.png') });

  // 3. PICK A VERSION → the pane fills; then SCROLL and it must stay put.
  const variant = await win.evaluate(() =>
    document.querySelector('[data-testid^="family-variant-"]')?.getAttribute('data-testid'),
  );
  await win.click(`[data-testid="${variant}"] button`);
  await win.waitForTimeout(1200);
  const paneTop = await box('[data-testid="model-detail"]');
  if (paneTop === null) fail('picking a version showed nothing on the right');
  console.log('detail pane:', JSON.stringify(paneTop));
  await win.screenshot({ path: path.join(OUT, '3-detail.png') });

  await win.evaluate(() => {
    const sc = [...document.querySelectorAll('.pd-scroll')].find(
      (e) => e.scrollHeight > e.clientHeight + 40,
    );
    if (sc) sc.scrollTop = sc.scrollHeight;
  });
  await win.waitForTimeout(700);
  const paneScrolled = await box('[data-testid="model-detail"]');
  console.log('detail pane after scrolling to the bottom:', JSON.stringify(paneScrolled));
  if (paneScrolled === null) fail('the model card was lost on scroll');
  if (Math.abs(paneScrolled.y - paneTop.y) > 40)
    fail(`the pane moved ${paneTop.y} → ${paneScrolled.y} — it is not pinned`);
  await win.screenshot({ path: path.join(OUT, '4-pinned-after-scroll.png') });

  // 4. OUTPUT FILTER.
  await win.evaluate(() => {
    const sc = [...document.querySelectorAll('.pd-scroll')].find((e) => e.scrollTop > 0);
    if (sc) sc.scrollTop = 0;
  });
  await win.click('[data-testid="filter-output-video"]');
  await win.waitForTimeout(600);
  const videoOnly = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="family-card-"]')].map((el) =>
      el.getAttribute('data-testid')?.replace('family-card-', ''),
    ),
  );
  console.log('with output=Video:', videoOnly.join(', '));
  if (videoOnly.length === 0 || videoOnly.length >= families.length)
    fail(`the output filter did not narrow the list (${videoOnly.length} of ${families.length})`);
  await win.screenshot({ path: path.join(OUT, '5-output-video.png') });
  await win.click('[data-testid="filter-output-video"]');
  await win.waitForTimeout(400);

  // 5. DOWNLOAD → PROGRESS BAR + RED X → CANCEL RESTORES THE BUTTON.
  //    A real transfer against a real repo, cancelled a second in: the point is
  //    that the X is believed immediately, which a mocked store could not show.
  await win.click('[data-testid="filter-output-text"]');
  await win.waitForTimeout(500);
  await win.click('[data-testid="family-toggle-lfm2.5"]');
  await win.waitForTimeout(500);
  await win.click('[data-testid="family-variant-LiquidAI/LFM2.5-1.2B-Instruct-GGUF:1.2B"] button');
  await win.waitForTimeout(2500);
  const hasButton = await box('[data-testid="detail-download"]');
  console.log('download button before:', JSON.stringify(hasButton));
  if (hasButton === null) fail('no plain Download button on the model card');
  await win.screenshot({ path: path.join(OUT, '6-download-button.png') });

  await win.click('[data-testid="detail-download"]');
  await win.waitForSelector('[data-testid="detail-download-progress"]', { timeout: 15000 });
  await win.waitForTimeout(1800);
  const bar = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="detail-download-bar"]');
    return el === null ? null : el.getAttribute('data-fraction');
  });
  const cancelBtn = await box('[data-testid="detail-download-bar-cancel"]');
  // The bar is pinned to the top bar too — cancellable from anywhere.
  const pinned = await box('[data-testid="topbar-downloads"]');
  console.log('top-bar download indicator:', JSON.stringify(pinned));
  if (pinned === null) fail('the download is not pinned to the top bar');
  const pctText = await win.evaluate(() =>
    document.querySelector('[data-testid="detail-download-progress"]')?.textContent?.trim(),
  );
  if (pctText !== undefined && /%/.test(pctText))
    fail(`the bar still shows a percentage: ${pctText}`);
  console.log('progress bar at:', bar, '· cancel button:', JSON.stringify(cancelBtn));
  if (cancelBtn === null) fail('the progress state has no cancel control');
  await win.screenshot({ path: path.join(OUT, '7-downloading.png') });

  const t0 = Date.now();
  await win.click('[data-testid="detail-download-bar-cancel"]');
  await win.waitForSelector('[data-testid="detail-download"]', { timeout: 4000 });
  console.log(`cancel → Download button restored in ${Date.now() - t0}ms`);
  await win.screenshot({ path: path.join(OUT, '8-cancelled.png') });
  const stillProgress = await box('[data-testid="detail-download-progress"]');
  if (stillProgress !== null) fail('the progress bar survived the cancel');
  const errShown = await win.evaluate(
    () => document.querySelector('[data-testid="models-error"]')?.textContent ?? null,
  );
  if (errShown !== null) fail(`cancel reported an error: ${errShown}`);

  // 6. A GENERATION FAMILY MUST NOT OFFER A DOWNLOAD IT CANNOT DO.
  await win.click('[data-testid="filter-output-text"]');
  await win.waitForTimeout(300);
  await win.click('[data-testid="filter-output-image"]');
  await win.waitForTimeout(500);
  await win.click('[data-testid="family-toggle-z-image"]');
  await win.waitForTimeout(400);
  await win.click('[data-testid="family-variant-Tongyi-MAI/Z-Image-Turbo:Turbo"] button');
  await win.waitForTimeout(1500);
  const genBlock = await win.evaluate(
    () => document.querySelector('[data-testid="detail-gen-install"]')?.textContent?.trim() ?? null,
  );
  const realButton = await box('[data-testid="detail-download"]');
  // the user: the "whole repository, into this app's model store" line "is not
  // needed and especially not true in this case above" — so nothing should be
  // said here at all unless the machine cannot run what it is about to fetch.
  console.log('generation family caveat:', JSON.stringify(genBlock));
  if (realButton === null) fail('a generation model has no Download button');
  if (genBlock !== null && !/memory/.test(genBlock))
    fail(`the card is still explaining itself: ${genBlock}`);
  await win.screenshot({ path: path.join(OUT, '9-generation-family.png') });

  // 7. THE TAGS, AND THE MACHINE-FIT VERDICT.
  await win.click('[data-testid="filter-output-image"]');
  await win.waitForTimeout(300);
  await win.click('[data-testid="filter-output-video"]');
  await win.waitForTimeout(500);
  await win.click('[data-testid="family-toggle-minimax-h3"]');
  await win.waitForTimeout(500);
  await win.click('[data-testid="family-toggle-ltx"]');
  await win.waitForTimeout(600);
  const pills = await win.evaluate(() => {
    const read = (sel) =>
      [...document.querySelectorAll(sel)].map((el) => ({
        text: el.textContent?.trim(),
        tone: el.getAttribute('data-tone'),
        rounded: getComputedStyle(el).borderRadius,
        border: getComputedStyle(el).borderTopWidth,
      }));
    return {
      tasks: read('[data-testid^="task-"]').slice(0, 6),
      fits: read('[data-testid^="fit-"]').slice(0, 4),
      familyFit: read('[data-testid^="family-fit-"]'),
      fast: read('[data-testid^="fast-"]').slice(0, 2),
    };
  });
  console.log('task pills:', JSON.stringify(pills.tasks));
  console.log('fit pills:', JSON.stringify(pills.fits));
  console.log('family-level fit:', JSON.stringify(pills.familyFit));
  await win.screenshot({ path: path.join(OUT, '10-video-tasks-and-fit.png') });
  // The LTX quants must be reachable on THIS 24 GB machine — the point of
  // going GGUF rather than bf16/fp8.
  const ltxSizes = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="family-variant-city96"], [data-testid^="family-variant-Abiray"]')].map(
      (el) => el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90),
    ),
  );
  console.log('LTX recipes:', JSON.stringify(ltxSizes, null, 0));
  if (pills.tasks.length === 0) fail('no in→out task labels on the video variants');
  if (pills.fits.length === 0) fail('nothing told the user what this machine can run');
  for (const p of [...pills.tasks, ...pills.fits]) {
    if (!p.rounded.startsWith('9999') && !p.rounded.includes('px')) fail('a tag is not a pill');
    if (p.border === '0px') fail(`the "${p.text}" tag has no border`);
  }

  // 8. THE CARD'S OWN BAR, and the top-bar twin, on a generation download.
  await win.click('[data-testid="family-toggle-minimax-h3"]');
  await win.waitForTimeout(300);
  await win.click('[data-testid="filter-output-video"]');
  await win.waitForTimeout(300);
  await win.click('[data-testid="filter-output-audio"]');
  await win.waitForTimeout(500);
  await win.click('[data-testid="family-toggle-kokoro"]');
  await win.waitForTimeout(400);
  await win.click('[data-testid="family-download-hexgrad/Kokoro-82M:82M"]');
  await win.waitForTimeout(2500);
  const rowBar = await box('[data-testid="family-progress-hexgrad/Kokoro-82M"]');
  const rowX = await box('[data-testid="family-progress-hexgrad/Kokoro-82M-cancel"]');
  const topBar = await box('[data-testid="topbar-downloads"]');
  console.log('row bar:', JSON.stringify(rowBar), 'row X:', JSON.stringify(rowX));
  console.log('top bar while a repo downloads:', JSON.stringify(topBar));
  await win.screenshot({ path: path.join(OUT, '11-download-bar.png') });
  if (rowBar === null) fail('the family row shows no progress bar');
  if (rowX === null) fail('the family row bar has no cancel');
  if (topBar === null) fail('a store download is not pinned to the top bar');
  // Cancel it from the TOP BAR, which is the point of pinning it there.
  await win.click('[data-testid="topbar-downloads"] button');
  await win.waitForTimeout(1200);
  if ((await box('[data-testid="topbar-downloads"]')) !== null)
    fail('cancelling from the top bar left the indicator up');
  console.log('cancelled from the top bar');

  console.log('model-hub-curated-probe OK');
} finally {
  await app.close();
}
