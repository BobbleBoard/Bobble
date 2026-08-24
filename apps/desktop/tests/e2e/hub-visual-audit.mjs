/**
 * A ZOOMED VISUAL AUDIT of the model hub.
 *
 * the user: "UI oddities should be visually verified with zoom… on any visual
 * verification you need to notice everything, not just fixate on something, even
 * if it's completely out of the scope of the task."
 *
 * So this captures the surface at several states and crops the regions worth
 * staring at, upscaled, rather than one full screenshot in which a 20px control
 * is 20px. The crops are the deliverable; the assertions are deliberately few,
 * because the point is to LOOK.
 */
import { _electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUT = process.env.OUT ?? '/tmp/hub-audit';
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

try {
  await win.click('[data-testid="nav-model-management"]');
  await win.waitForSelector('[data-testid="curated-families"]', { timeout: 10000 });
  await win.waitForTimeout(1500);

  await win.screenshot({ path: path.join(OUT, 'full.png') });

  // The row, hovered, at scroll zero — the left edge and the arrows.
  await win.evaluate(() => {
    const el = document.querySelector('[data-testid="best-carousel"]');
    if (el !== null) el.scrollLeft = 0;
  });
  await win.hover('[data-testid="best-carousel"]');
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(OUT, 'row-hover-start.png') });
  const geom = await win.evaluate(() => {
    const row = document.querySelector('[data-testid="best-carousel"]');
    const first = row?.firstElementChild;
    const heading = document.querySelector('[data-testid="top-recommended-heading"]');
    if (row === null || first == null) return null;
    const r = row.getBoundingClientRect();
    const f = first.getBoundingClientRect();
    const cs = getComputedStyle(row);
    return {
      scrollLeft: Math.round(row.scrollLeft),
      rowLeft: Math.round(r.left),
      firstCardLeft: Math.round(f.left),
      headingLeft: heading === null ? null : Math.round(heading.getBoundingClientRect().left),
      padLeft: cs.paddingLeft,
      overflowY: cs.overflowY,
      mask: (cs.maskImage ?? cs.webkitMaskImage ?? '').slice(0, 80),
    };
  });
  console.log('ROW GEOMETRY:', JSON.stringify(geom, null, 1));

  // Hover the NEXT arrow itself — the user's report is specifically about that.
  await win.hover('[data-testid="best-carousel-next"]');
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(OUT, 'arrow-hovered.png') });
  const arrowBox = await win.evaluate(() => {
    const a = document.querySelector('[data-testid="best-carousel-next"]');
    if (a === null) return null;
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    // What paints at each edge of the arrow, not just its centre — the original
    // check passed because the overlap is at the TOP, not the middle.
    const probe = (dx, dy) => {
      const el = document.elementFromPoint(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
      return el === null ? null : `${el.tagName}.${el.className?.toString().slice(0, 30)}`;
    };
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) },
      background: cs.backgroundColor,
      opacity: cs.opacity,
      centre: probe(0, 0),
      top: probe(0, -r.height / 2 + 3),
      bottom: probe(0, r.height / 2 - 3),
      left: probe(-r.width / 2 + 3, 0),
      right: probe(r.width / 2 - 3, 0),
    };
  });
  console.log('ARROW:', JSON.stringify(arrowBox, null, 1));

  // An EXPANDED family, which is where the variant rows live.
  await win.click('[data-testid="family-toggle-qwen3.5"]');
  await win.waitForTimeout(600);
  await win.click(
    '[data-testid="family-card-qwen3.5"] [data-testid^="family-variant-"] button',
  );
  await win.waitForTimeout(2500);
  await win.screenshot({ path: path.join(OUT, 'expanded.png') });

  // The detail pane, which carries an upstream README verbatim. A
  // single-version family opens its card directly — there is no list of one to
  // expand — so this is one click, not two.
  await win.click('[data-testid="family-toggle-triposr"]');
  await win.waitForTimeout(2500);
  await win.screenshot({ path: path.join(OUT, 'detail.png') });

  const detail = await win.evaluate(() => {
    const btn = document.querySelector('[data-testid="detail-download"]');
    const cs = btn === null ? null : getComputedStyle(btn);
    const card = document.querySelector('[data-testid="model-card"]');
    return {
      downloadWidth: btn === null ? null : Math.round(btn.getBoundingClientRect().width),
      downloadRadius: cs === null ? null : cs.borderTopLeftRadius,
      readmeFirstLine: card?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null,
    };
  });
  console.log('DETAIL:', JSON.stringify(detail, null, 1));

  // The version count on a single-version family.
  const versions = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="family-card-"]')].slice(0, 6).map((el) => {
      const t = el.querySelector('[data-testid^="family-toggle-"]');
      return t?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? '';
    }),
  );
  console.log('FAMILY HEADERS:', JSON.stringify(versions, null, 1));

  console.log('audit captures in', OUT);
} finally {
  await app.close();
}
