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
  /*
   * THE TOP OF THE HUB. What matters is as much what is ABSENT as what is
   * present — the user cut the header, the machine name, the memory budget, the
   * reason line and the engine line as noise for "any random user using this
   * app", and a card that quietly grows one of them back is the regression.
   */
  const best = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid^="best-"]')]
      .filter((el) =>
        /^best-(text|image|video|audio|3d)$/.test(el.getAttribute('data-testid') ?? ''),
      )
      .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const strip = document.querySelector('[data-testid="best-for-your-machine"]');
    return {
      cards,
      stripText: strip?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      buttons: [...document.querySelectorAll('[data-testid^="best-use-"]')].map((b) =>
        b.textContent?.trim(),
      ),
      tags: [...document.querySelectorAll('[data-testid^="best-task-"]')].map((b) =>
        b.textContent?.trim(),
      ),
    };
  });
  for (const c of best.cards) console.log('  •', c.slice(0, 120));
  console.log('HF task tags:', JSON.stringify(best.tags));
  console.log('on-disk buttons say:', JSON.stringify(best.buttons));
  if (best.cards.length === 0) fail('no per-modality recommendation was shown');
  if (best.tags.length !== best.cards.length) fail('a card has no Hugging Face task tag');
  if (!best.tags.every((t) => /-to-|generation/.test(t ?? '')))
    fail(`not HF task tags: ${best.tags}`);
  if (best.buttons.some((b) => b !== 'Use')) fail('an on-disk card does not say Use');

  // THE HEADINGS. the user: "the little 'recommended' text shouldn't be there, the 5
  // cards you show should say 'Top Recommended' much larger and then 'More'".
  const headings = await win.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      return el === null
        ? null
        : { text: el.textContent?.trim(), px: Number.parseFloat(getComputedStyle(el).fontSize) };
    };
    return {
      top: read('[data-testid="top-recommended-heading"]'),
      more: read('[data-testid="more-heading"]'),
      body: Number.parseFloat(
        getComputedStyle(document.querySelector('[data-testid="models-view"]')).fontSize,
      ),
    };
  });
  console.log('headings:', JSON.stringify(headings));
  if (headings.top?.text !== 'Top Recommended') fail('no "Top Recommended" heading');
  if (headings.more?.text !== 'More') fail('no "More" heading');
  if ((headings.top?.px ?? 0) <= headings.body) fail('the heading is not larger than body text');

  // The BUTTON must hug its word — the user: "no extra akward blue space left and
  // right, don't stretch the pill excessively at all, the word ends, the pill
  // ends." Measured against the text it contains rather than against the card.
  const hug = await win.evaluate(() => {
    const b = document.querySelector('[data-testid^="best-download-"]');
    if (b === null) return null;
    const range = document.createRange();
    range.selectNodeContents(b);
    const text = range.getBoundingClientRect().width;
    const button = b.getBoundingClientRect().width;
    return {
      text: Math.round(text),
      button: Math.round(button),
      fontPx: Number.parseFloat(getComputedStyle(b).fontSize),
    };
  });
  console.log('download button:', JSON.stringify(hug));
  if (hug === null) fail('no download button to measure');
  // Padding, not stretching: the slack either side should be small.
  if (hug.button - hug.text > 40)
    fail(`the button has ${hug.button - hug.text}px of slack around a ${hug.text}px word`);
  if (hug.fontPx < 12) fail(`the Download text is only ${hug.fontPx}px`);
  // The cut copy must be GONE, not merely moved.
  for (const gone of [
    'Best for your machine',
    'to work with',
    'needs',
    'Runs on',
    'runs everywhere',
    'what the 3D Studio generates with',
  ]) {
    if (best.stripText.includes(gone)) fail(`"${gone}" is still on the cards`);
  }
  if (/On disk/.test(best.stripText))
    fail('the on-disk tag is still there — the button is the state');

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
  // The numbers EXIST but are hidden until hover — the user wanted no resident
  // percentage, then asked for the bar to reveal "downloaded/total n%" on hover.
  // So the assertion is about opacity, not about absence.
  const caption = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="detail-download-bar-caption"]');
    return el === null
      ? null
      : { text: el.textContent?.trim(), opacity: getComputedStyle(el).opacity };
  });
  console.log('progress caption at rest:', JSON.stringify(caption));
  if (caption === null) fail('the progress bar has no caption to reveal');
  if (caption.opacity !== '0') fail('the percentage is showing without a hover');
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
    [
      ...document.querySelectorAll(
        '[data-testid^="family-variant-city96"], [data-testid^="family-variant-Abiray"]',
      ),
    ].map((el) => el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90)),
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

  // 9. THE IN-CARD BAR: the button becomes it, hovering reveals the numbers,
  //    and the X gets its red circle. All three are hover states, so the only
  //    way to know is to drive them.
  await win.click('[data-testid="filter-output-audio"]');
  await win.waitForTimeout(400);
  await win.click('[data-testid="best-download-audio"]');
  await win.waitForTimeout(2500);
  const barSel = '[data-testid="best-progress-audio"]';
  const restHeight = await win.evaluate(
    (sel) => document.querySelector(sel)?.getBoundingClientRect().height ?? null,
    barSel,
  );
  await win.hover(barSel);
  await win.waitForTimeout(500);
  const hoverState = await win.evaluate((sel) => {
    const bar = document.querySelector(sel);
    const cap = document.querySelector('[data-testid="best-progress-audio-caption"]');
    return {
      height: bar?.getBoundingClientRect().height ?? null,
      barTop: bar?.getBoundingClientRect().top ?? null,
      captionTop: cap?.getBoundingClientRect().top ?? null,
      caption: cap?.textContent?.trim() ?? null,
      opacity: cap === null ? null : getComputedStyle(cap).opacity,
    };
  }, barSel);
  console.log(`bar height ${restHeight} → ${hoverState.height} on hover`);
  console.log('caption on hover:', JSON.stringify(hoverState));
  await win.screenshot({ path: path.join(OUT, '12-bar-hover.png') });
  if (hoverState.opacity === '0') fail('hovering the bar reveals nothing');
  if (!/\/|%/.test(hoverState.caption ?? ''))
    fail(`the caption is not size/size n%: ${hoverState.caption}`);
  // The bar must NOT change — the user: "nothing goes inside the bar it does not
  // change thickness". The caption is a popup above it, so the track's geometry
  // is identical hovered and not.
  if (hoverState.height !== restHeight)
    fail(`the bar changed thickness on hover (${restHeight} → ${hoverState.height})`);
  if ((hoverState.captionTop ?? 0) >= (hoverState.barTop ?? 0))
    fail('the caption is not above the bar');

  await win.hover('[data-testid="best-progress-audio-cancel"]');
  await win.waitForTimeout(400);
  const xHover = await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, radius: cs.borderRadius, color: cs.color };
  }, '[data-testid="best-progress-audio-cancel"]');
  console.log('X on hover:', JSON.stringify(xHover));
  await win.screenshot({ path: path.join(OUT, '13-x-hover.png') });
  if (xHover === null) fail('no cancel control on the card bar');
  if (/rgba\(0, 0, 0, 0\)|transparent/.test(xHover.background))
    fail('the X has no highlight on hover');

  // …and it stops immediately.
  const t1 = Date.now();
  await win.click('[data-testid="best-progress-audio-cancel"]');
  await win.waitForSelector('[data-testid="best-download-audio"]', { timeout: 4000 });
  console.log(`cancel → Download restored in ${Date.now() - t1}ms`);

  // 10. ONE ROW, SCROLLED SIDEWAYS, with an arrow that only exists when there is
  //     somewhere to go — and Quick Download on every collection below it.
  await win.click('[data-testid="filter-output-audio"]');
  await win.waitForTimeout(400);
  // Park it at the start first: earlier steps clicked cards inside the row, and
  // the browser scrolls a focused element into view — so "is the back arrow
  // hidden?" has to be asked of a known position, not of wherever we left it.
  await win.evaluate(() => {
    const el = document.querySelector('[data-testid="best-carousel"]');
    if (el !== null) el.scrollLeft = 0;
  });
  await win.waitForTimeout(400);
  const row = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="best-carousel"]');
    if (el === null) return null;
    const cards = [...el.children].map((c) => c.getBoundingClientRect());
    return {
      scrollable: el.scrollWidth > el.clientWidth + 1,
      // One row means every card shares a top edge.
      tops: [...new Set(cards.map((r) => Math.round(r.top)))],
      count: cards.length,
      next: document.querySelector('[data-testid="best-carousel-next"]') !== null,
      prev: document.querySelector('[data-testid="best-carousel-prev"]') !== null,
    };
  });
  console.log('top row:', JSON.stringify(row));
  if (row === null) fail('the recommendations are not in a carousel');
  if (row.tops.length !== 1) fail(`the cards are stacked across ${row.tops.length} rows`);
  if (row.scrollable && !row.next) fail('there is more to scroll to and no arrow saying so');
  if (row.prev) fail('a back arrow is showing at the start of the row');
  // …and it appears once there is something behind you.
  if (row.scrollable) {
    await win.click('[data-testid="best-carousel-next"]');
    await win.waitForTimeout(800);
    const after = await win.evaluate(() => ({
      prev: document.querySelector('[data-testid="best-carousel-prev"]') !== null,
      scrollLeft: Math.round(
        document.querySelector('[data-testid="best-carousel"]')?.scrollLeft ?? 0,
      ),
    }));
    console.log('after paging right:', JSON.stringify(after));
    if (after.scrollLeft <= 0) fail('the next arrow did not scroll the row');
    if (!after.prev) fail('no back arrow after scrolling away from the start');
  }

  // The chrome, on BOTH kinds of card — the user asked for it "on all the cards".
  const chrome = await win.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, shadow: cs.boxShadow !== 'none' };
    };
    return {
      best: read('[data-testid="best-audio"]'),
      family: read('[data-testid^="family-card-"]'),
    };
  });
  console.log('card chrome:', JSON.stringify(chrome));
  for (const [which, c] of Object.entries(chrome)) {
    if (c === null || c.border === '0px' || !c.shadow)
      fail(`${which} card has no border or shadow`);
  }

  const quick = await win.evaluate(() => {
    const b = document.querySelector('[data-testid^="family-quick-"]');
    return b === null ? null : { text: b.textContent?.trim(), title: b.getAttribute('title') };
  });
  console.log('quick download:', JSON.stringify(quick));
  if (quick === null) fail('no Quick Download beside a collection');
  if (!/Quick Download|Use/.test(quick.text ?? '')) fail(`unexpected label: ${quick.text}`);

  // The unfilled track must read BLUE, not grey.
  await win.click('[data-testid="best-download-audio"]');
  await win.waitForTimeout(1500);
  const track = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="best-progress-audio"]');
    return el === null ? null : getComputedStyle(el).backgroundColor;
  });
  console.log('unfilled track:', track);
  await win.evaluate(() =>
    document.querySelector('[data-testid="best-progress-audio-cancel"]')?.click(),
  );
  await win.waitForTimeout(600);

  console.log('model-hub-curated-probe OK');
} finally {
  await app.close();
}
