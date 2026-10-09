/**
 * THE HUB IN LIGHT MODE, WITH THE LIST SCROLLED.
 *
 * The user reviews this app in light mode and the audits so far were all dark, so
 * the two surfaces the user flagged — the pinned card's top edge while the list
 * scrolls behind it, and the model card nested inside it — had never been
 * photographed on the theme he actually looks at.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/hub-light';
mkdirSync(OUT, { recursive: true });

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForTimeout(4000);
await win.evaluate(() => {
  // The generated theme sheet keys off :root[data-flavor][data-mode].
  document.documentElement.setAttribute('data-mode', 'light');
  document.documentElement.style.colorScheme = 'light';
});
await win.click('[data-testid="nav-model-management"]');
await win.waitForTimeout(2500);
await win.screenshot({ path: path.join(OUT, '0-light.png') });

// A model that is actually on disk, so the ladder shows a real installed state.
const local = await win.evaluate(() => {
  const el = [...document.querySelectorAll('[data-testid^="family-card-"]')].find((c) =>
    /on disk/i.test(c.textContent ?? ''),
  );
  return el?.getAttribute('data-testid')?.replace('family-card-', '') ?? null;
});
console.log('family with something on disk:', local);
if (local !== null) {
  await win.click(`[data-testid="family-toggle-${local}"]`);
  await win.waitForTimeout(600);
  const v = await win.evaluate(
    (id) =>
      [
        ...document.querySelectorAll(
          `[data-testid="family-card-${id}"] [data-testid^="family-variant-"]`,
        ),
      ]
        .at(-1)
        ?.getAttribute('data-testid') ?? null,
    local,
  );
  if (v !== null) await win.click(`[data-testid="${v}"] button`);
  await win.waitForTimeout(2500);
}
await win.screenshot({ path: path.join(OUT, '1-detail.png') });

// Scroll the LIST while the pane stays pinned — the state the user described.
await win.evaluate(() => {
  const list = document.querySelector('[data-testid="curated-list"]') ?? document.scrollingElement;
  const scroller =
    [...document.querySelectorAll('*')].find(
      (e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY === 'auto',
    ) ?? list;
  scroller.scrollTop = 600;
});
await win.waitForTimeout(600);
await win.screenshot({ path: path.join(OUT, '2-scrolled.png') });

const pane = await win.evaluate(() => {
  const el = document.querySelector('[data-testid="model-detail"]');
  if (el === null) return null;
  const cs = getComputedStyle(el);
  const card = document.querySelector('[data-testid="model-card-body"]');
  const cardCs = card === null ? null : getComputedStyle(card);
  return {
    mask: cs.maskImage,
    borderTop: `${cs.borderTopWidth} ${cs.borderTopColor}`,
    overflow: cs.overflowY,
    scrollbarGutter: cs.scrollbarGutter,
    cardBorder: cardCs === null ? null : `${cardCs.borderTopWidth} ${cardCs.borderTopColor}`,
    cardShadow: cardCs === null ? null : cardCs.boxShadow,
    cardPadding: cardCs === null ? null : cardCs.padding,
  };
});
console.log('PANE:', JSON.stringify(pane, null, 1));
await app.close();
console.log('light captures in', OUT);
