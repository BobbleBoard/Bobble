/**
 * THE QUICK TOUR, WALKED: start it from the bottom-left menu on the chat and on
 * the Models page, photograph every step, and check each one — the spotlight
 * sits on the control the step names, the card is inside the window beside it,
 * Next walks to the end, Got it closes it, and Esc closes it early.
 *
 * the user (2026-10-08): "a quick guided tour button that shows a
 * highlighting/tutorial style guide of whatever's on screen right now."
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/tour-look.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('tour', { args: ['--', '--piE2E=1'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** THEME=light flips the app to light through its own menu before looking. */
async function applyTheme() {
  if (process.env.THEME !== 'light') return;
  const dark = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
  if (dark === 'light') return;
  await page.click('[data-testid="profile-button"]');
  await page.click('[data-testid="toggle-mode"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-mode') === 'light');
}

async function startTour() {
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="start-tour"]');
  await page.click('[data-testid="start-tour"]');
  await page.waitForSelector('[data-testid="tour-card"]', { timeout: 5000 });
  await sleep(700);
}

/** Walk every step; returns the step ids seen. */
async function walk(label) {
  const seen = [];
  for (let n = 0; n < 20; n++) {
    await sleep(500);
    const s = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="tour-card"]');
      const spot = document.querySelector('[data-testid="tour-spot"]');
      if (card === null) return null;
      const c = card.getBoundingClientRect();
      const p = spot?.getBoundingClientRect() ?? null;
      return {
        step: card.getAttribute('data-step'),
        side: card.getAttribute('data-side'),
        count: document.querySelector('[data-testid="tour-count"]')?.textContent ?? '',
        title: document.querySelector('#pd-tour-title')?.textContent ?? '',
        card: { x: c.x, y: c.y, w: c.width, h: c.height },
        spot: p === null ? null : { x: p.x, y: p.y, w: p.width, h: p.height },
        view: { w: innerWidth, h: innerHeight },
        done: document.querySelector('[data-testid="tour-done"]') !== null,
      };
    });
    if (s === null) break;
    seen.push(s.step);
    console.log(
      `${label} ${s.count.padEnd(8)} ${String(s.step).padEnd(12)} ${String(s.side).padEnd(6)} "${s.title}"`,
    );
    const inside =
      s.card.x >= 0 &&
      s.card.y >= 0 &&
      s.card.x + s.card.w <= s.view.w &&
      s.card.y + s.card.h <= s.view.h;
    check(inside, `${label} ${s.step}: the card is inside the window`);
    check(
      s.spot !== null && s.spot.w > 8 && s.spot.h > 8,
      `${label} ${s.step}: the spotlight has a target`,
    );
    // The card does not cover the control it explains.
    if (s.spot !== null) {
      const overlap =
        s.card.x < s.spot.x + s.spot.w &&
        s.card.x + s.card.w > s.spot.x &&
        s.card.y < s.spot.y + s.spot.h &&
        s.card.y + s.card.h > s.spot.y;
      const big = s.spot.w * s.spot.h > 0.4 * s.view.w * s.view.h;
      check(!overlap || big, `${label} ${s.step}: the card sits beside its target, not on it`);
    }
    await shot(`${label}-${String(n + 1).padStart(2, '0')}-${s.step}`);
    if (s.done) {
      await page.click('[data-testid="tour-done"]');
      break;
    }
    await page.click('[data-testid="tour-next"]');
  }
  await sleep(400);
  check(
    (await page.$('[data-testid="tour-card"]')) === null,
    `${label}: Got it closes the tour (${seen.length} steps)`,
  );
  return seen;
}

try {
  await applyTheme();
  // ── the chat ──────────────────────────────────────────────────────────────
  await sleep(1500);
  await startTour();
  const chat = await walk('chat');
  check(
    chat.includes('composer') && chat.includes('new-chat'),
    `the chat tour covers the composer and the sidebar (${chat.join(', ')})`,
  );

  // ── Esc closes early ──────────────────────────────────────────────────────
  await startTour();
  await page.keyboard.press('Escape');
  await sleep(400);
  check((await page.$('[data-testid="tour-card"]')) === null, 'Esc ends the tour');

  // ── the pop-out on + (Connectors live there) ─────────────────────────────
  await page.evaluate(() => window.__pi_tip?.('connectors', '[aria-label="Add to message"]'));
  await page.waitForSelector('[data-testid="tip-connectors"]', { timeout: 5000 });
  await sleep(2400); // the Calendar switch is on at this point in its loop
  await shot('chat-tip-connectors');
  await page.click('[data-testid="tip-ok"]');
  await sleep(300);

  // ── the computer-use intro (it opens the first time Bobble drives an app) ─
  await page.evaluate(() => window.__pi_intro?.('computerUse'));
  await page.waitForSelector('[data-testid="intro-computerUse"]', { timeout: 5000 });
  await sleep(1600); // typing, at this point in its loop
  await shot('chat-intro-computer-use');
  check(
    (await page.textContent('[data-testid="intro-action"]'))?.trim() === 'Choose apps',
    'the computer-use intro offers Choose apps beside Got it',
  );
  await page.click('[data-testid="intro-ok"]');
  await sleep(400);

  // ── the Models page ───────────────────────────────────────────────────────
  await page.click('[data-testid="nav-model-management"]');
  await sleep(2500);
  // The display face is the bundled Fraunces, not a fallback serif.
  const face = await page.evaluate(async () => {
    await document.fonts.ready;
    const h1 = document.querySelector('[data-testid="models-view"] h1');
    return {
      loaded: document.fonts.check('40px Fraunces'),
      family: h1 ? getComputedStyle(h1).fontFamily : '',
      axes: h1 ? getComputedStyle(h1).fontVariationSettings : '',
    };
  });
  console.log('display face', JSON.stringify(face));
  check(face.loaded && /Fraunces/.test(face.family), 'the page title is set in Fraunces, loaded');
  await startTour();
  const models = await walk('models');
  check(
    models[0] === 'places',
    `the Models tour starts at the three places (${models.join(', ')})`,
  );

  // ── the 3D Studio: its first-use intro card, then its tour ────────────────
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-viewport"]', { timeout: 20_000 });
  const view = await page.$('[data-testid="tp-gate-view"]');
  if (view) await view.click();
  await sleep(1500);
  check(
    (await page.$('[data-testid="intro-scrim"]')) === null,
    'under test no intro opens by itself (a scrim would swallow a probe click)',
  );
  await page.evaluate(() => window.__pi_intro?.('studio3d'));
  await page.waitForSelector('[data-testid="intro-studio3d"]', { timeout: 5000 });
  await sleep(2700); // the model is part-built at this point in its loop
  await shot('studio3d-intro');
  await page.click('[data-testid="intro-ok"]');
  await sleep(400);
  const seen = await page.evaluate(() => window.localStorage.getItem('pd-intro-seen-v1'));
  check(
    (await page.$('[data-testid="intro-scrim"]')) === null && /studio3d/.test(seen ?? ''),
    `Got it closes the intro and remembers it (${seen})`,
  );
  await startTour();
  const studio = await walk('studio3d');
  check(studio[0] === 'tools', `the 3D Studio tour starts at its stages (${studio.join(', ')})`);

  // ── the pop-out on Segment ────────────────────────────────────────────────
  await page.evaluate(() => window.__pi_tip?.('segment', '[data-testid="tp-rail-segment"]'));
  await page.waitForSelector('[data-testid="tip-segment"]', { timeout: 5000 });
  await sleep(3000); // coloured and lifting apart at this point in its loop
  const tip = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="tip-segment"]')?.getBoundingClientRect();
    const b = document.querySelector('[data-testid="tp-rail-segment"]')?.getBoundingClientRect();
    return t && b
      ? { tipLeft: t.left, btnRight: b.right, tipTop: t.top, btnMid: b.top + b.height / 2 }
      : null;
  });
  console.log('segment tip', JSON.stringify(tip));
  check(
    tip !== null && tip.tipLeft >= tip.btnRight,
    'the Segment pop-out opens to the right of its rail button',
  );
  await shot('studio3d-tip-segment');
  await page.click('[data-testid="tip-ok"]');
  await sleep(300);
  check((await page.$('[data-testid="tip-segment"]')) === null, 'Got it closes the pop-out');
} finally {
  await finish();
}
