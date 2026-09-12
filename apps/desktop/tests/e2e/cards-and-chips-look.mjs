/**
 * LOOK: the starter chips on the home screen (one row, larger, nowhere else),
 * and the presented-file cards (a colour and a mark per file family, blue Open).
 *
 *   node tests/e2e/cards-and-chips-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, home } = await launchApp('cards-and-chips-look');
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
await page.waitForTimeout(500);

// 1. Home: chips in one row, larger; hints present.
const chips = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.pd-starter-chip')];
  const tops = new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const h = els[0]?.getBoundingClientRect().height ?? 0;
  return { count: els.length, rows: tops.size, height: h, hints: document.querySelector('[data-testid="composer-hints"]') !== null };
});
check(chips.count === 4 && chips.rows === 1, `chips should sit in ONE row, got ${JSON.stringify(chips)}`);
check(chips.height >= 36, `chips should be larger (>=36px tall), got ${chips.height}`);
await shot('1-home-chips');

// 2. A queued/sent message: chips and hints gone.
await page.evaluate(() => {
  const store = window.__pi_store();
  store.setState({ queuedSends: [{ id: 'q1', text: 'Round 1: reply with one word.', createdAt: Date.now(), reason: 'busy' }] });
});
await page.waitForTimeout(400);
const afterSend = await page.evaluate(() => ({
  chips: document.querySelectorAll('.pd-starter-chip').length,
  hints: document.querySelector('[data-testid="composer-hints"]') !== null,
}));
check(afterSend.chips === 0 && !afterSend.hints, `after a send nothing should remain under the composer, got ${JSON.stringify(afterSend)}`);
await shot('2-after-send-no-chips');
await page.evaluate(() => window.__pi_store().setState({ queuedSends: [] }));

// 3. Presented cards, one per family.
const dir = path.join(home, 'proj', 'out');
mkdirSync(dir, { recursive: true });
const files = ['q3-review.pptx', 'report.docx', 'budget.xlsx', 'brief.pdf', 'hero.png', 'clip.mp4', 'beat.flac', 'index.html', 'stats.py', 'notes.md', 'mug.glb'];
for (const f of files) writeFileSync(path.join(dir, f), 'x');
await page.evaluate(({ dir, files }) => {
  const store = window.__pi_store();
  store.setState({ messages: [{ kind: 'user', id: 'u1', text: 'show me everything', timestamp: Date.now() }] });
  const ps = window.__present_store();
  for (const f of files) ps.getState().add({ path: `${dir}/${f}`, note: f === 'q3-review.pptx' ? 'a 6-slide deck (terracotta) — made from your brief' : undefined });
}, { dir, files });
await page.waitForTimeout(800);
const cards = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.pd-present-thumb')].map((t) => ({
    family: t.getAttribute('data-family'),
    bg: getComputedStyle(t).backgroundColor,
  }));
  const opens = [...document.querySelectorAll('.pd-split-root[data-tone="primary"] .pd-split-main')].map((b) => getComputedStyle(b).color);
  const metas = [...document.querySelectorAll('.pd-present-meta')].map((m) => m.textContent?.trim().slice(0, 30));
  return { tiles, opens: opens.length, metas };
});
check(new Set(cards.tiles.map((t) => t.bg)).size >= 9, `tiles should carry distinct colours, got ${JSON.stringify(cards.tiles)}`);
check(cards.opens === cards.tiles.length, 'every card should have the primary Open');
check(cards.metas.some((m) => m?.startsWith('Slides · PPTX')), `the deck should read "Slides · PPTX", got ${JSON.stringify(cards.metas)}`);
await page.evaluate(() => document.querySelector('[data-testid="presented"]')?.scrollIntoView());
await shot('3-cards');
// Open the dropdown on the first card.
const caret = await page.$('.pd-split-root[data-tone="primary"] .pd-split-caret');
if (caret) {
  await caret.click();
  await page.waitForTimeout(300);
  await shot('4-open-with');
}
console.log(JSON.stringify({ chips, afterSend, families: cards.tiles.map((t) => t.family) }));
await finish();
