/**
 * The opening screen: what the app says about itself before anything is typed.
 *
 *   - NO starter chips and NO `@ / !` helper line under the composer. Both
 *     were there — four suggestions and a shortcut legend — and the user had them
 *     removed: "remove all this stuff." The empty screen is one line — the
 *     mark and the name (the user, 2026-09-17: "just a single line larger than
 *     currently that has the app logo and then 'Bobble'") — and the box; the
 *     privacy line went with the greeting.
 *   - the lead is that one line, and nothing else stands between it and the box;
 *   - and the SIDEBAR carries no status badge. It did — "Running on your Mac"
 *     over the model name with a coloured dot — and the user had it removed: "that
 *     'model running on your mac' with solid color circle needs to go."
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/opening node apps/desktop/tests/e2e/opening-screen-probe.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('opening-screen');

try {
  await page.waitForSelector('.pd-composer-root', { timeout: 15_000 });
  // The sidebar slides in over ~300ms (@starting-style translate); a shot taken
  // before it lands photographs a rail, not the panel this probe is about.
  await page.waitForSelector('[data-testid="sidebar-identity"]', { timeout: 10_000 });
  await page.waitForTimeout(900);

  const view = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    return {
      badge: q('[data-testid="local-model-badge"]') !== null,
      chips: document.querySelectorAll('[data-testid="starter-chips"], .pd-starter-chip').length,
      hints: q('[data-testid="composer-hints"]') !== null,
      privacy: q('[data-testid="privacy-line"]')?.textContent ?? null,
      lead: (() => {
        const lead = q('[data-testid="home-lead"]');
        if (lead === null) return null;
        return {
          name: lead.querySelector('.pd-home-lead-name')?.textContent ?? null,
          mark: lead.querySelector('svg') !== null,
          size: Number.parseFloat(getComputedStyle(lead).fontSize),
          lines:
            lead.parentElement === null ? 0 : lead.parentElement.querySelectorAll('p, h1').length,
        };
      })(),
      // Nothing under the composer but the composer's own bottom edge.
      belowComposer: (() => {
        const root = q('.pd-composer-root');
        if (root === null) return null;
        const bottom = root.getBoundingClientRect().bottom;
        return [...document.querySelectorAll('main *')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= bottom + 4 && r.height > 0 && (el.textContent ?? '').trim() !== '';
          })
          .slice(0, 5)
          .map((el) => (el.textContent ?? '').trim().slice(0, 40));
      })(),
    };
  });
  console.log('  ', JSON.stringify(view, null, 1));

  check(!view.badge, 'the sidebar carries no status badge');
  check(view.chips === 0, `no starter chips (got ${view.chips})`);
  check(!view.hints, 'no @ / ! helper line');
  check(
    view.belowComposer !== null && view.belowComposer.length === 0,
    `nothing under the composer (got ${JSON.stringify(view.belowComposer)})`,
  );
  check(
    view.privacy === null &&
      view.lead !== null &&
      view.lead.name === 'Bobble' &&
      view.lead.mark &&
      view.lead.size >= 40 &&
      view.lead.lines === 0,
    `the opening screen is one line, the mark and the name (got ${JSON.stringify(view.lead)}, privacy ${JSON.stringify(view.privacy)})`,
  );
  await shot('01-opening');

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
