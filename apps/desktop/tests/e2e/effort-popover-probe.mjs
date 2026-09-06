/**
 * Where the effort popover opens.
 *
 * THIS PROBE USED TO ASSERT THE WRONG THING, and it is worth writing down why,
 * because it was red for months while the app was doing exactly what it was
 * asked to. An adversarial report (b5) measured 56.63px of the popover sitting
 * over the editor and called it a defect; this asserted zero overlap. the user then
 * looked at the alternative — the panel anchored to the composer CARD, so it
 * cleared the text by floating above the whole thing — and rejected it: "effort
 * bar shows all the way up there rather than right above where it should be."
 *
 * Above the trigger and clear of the editor are mutually exclusive: the trigger
 * is at the bottom of the composer and the editor is what is above it. the user
 * picked proximity. So the measurement that matters is not the intersection with
 * the editor, it is the distance to the BUTTON — the thing that was actually
 * wrong and the thing that could silently come back if the anchor ever slips
 * back to `.pd-composer-root`.
 *
 * It still opens with a multi-line draft in the box, because that is the case
 * that made the old anchoring look broken: the taller the draft, the further the
 * card-anchored panel flew from its own control.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { openWorkMode, probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('effort-popover-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-effort-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

// A tall draft is the case a fixed offset gets wrong.
await page.click('.pd-composer-editor');
for (let i = 0; i < 4; i++) {
  await page.keyboard.type(`line ${i} of a draft the user is reading while choosing effort`);
  await page.keyboard.press('Shift+Enter');
}
await page.waitForTimeout(300);
// The effort dial, the project chip and the instruction files live on the WORK
// ledge, which the app now ships collapsed (and `inert`) behind the Chat|Work
// toggle in the top left. A probe that drives one of them opens it first.
await openWorkMode(page);
await page.click('[data-testid="composer-effort"]');
await page.waitForSelector('.pd-effort-popover', { timeout: 5000 });
await page.waitForTimeout(400);

const m = await page.evaluate(() => {
  const pop = document.querySelector('.pd-effort-popover');
  const ed = document.querySelector('.pd-composer-editor');
  const btn = document.querySelector('[data-testid="composer-effort"]');
  const card = document.querySelector('.pd-composer-root');
  if (!pop || !ed || !btn) return { missing: { pop: !pop, editor: !ed, trigger: !btn } };
  const p = pop.getBoundingClientRect();
  const e = ed.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const c = card?.getBoundingClientRect() ?? null;
  return {
    // The measurement that matters: how far the panel's bottom edge sits from
    // the top of its own button, and how far their right edges are apart.
    gapToTrigger: +(b.top - p.bottom).toFixed(2),
    rightEdgeSkew: +Math.abs(p.right - b.right).toFixed(2),
    // Kept for the record — this is the number the old assertion was built on.
    editorOverlapY: +Math.max(0, Math.min(p.bottom, e.bottom) - Math.max(p.top, e.top)).toFixed(2),
    // If it ever anchors to the CARD again, this is what gives it away: the
    // panel would clear the card's top edge instead of hugging the button.
    aboveCardTop: c !== null ? p.bottom <= c.top + 1 : false,
    draftHeight: +e.height.toFixed(2),
  };
});
console.log('[effort]', JSON.stringify(m));
await page.screenshot({ path: process.env.SHOT ?? '/tmp/effort-popover.png' });
await app.close();
if (m === null || m.missing !== undefined) {
  console.error('[effort] FAIL: could not measure', JSON.stringify(m));
  process.exit(1);
}
// `sideOffset={8}`, so 8px is the intended gap. The tolerance is for subpixel
// layout, not for a second opinion about where the panel belongs.
if (!(m.gapToTrigger >= 0 && m.gapToTrigger <= 16)) {
  console.error(
    `[effort] FAIL: the popover is ${m.gapToTrigger}px from its own button — it should sit just above it (sideOffset 8), not float off with the draft height (${m.draftHeight}px)`,
  );
  process.exit(1);
}
if (m.aboveCardTop) {
  console.error(
    '[effort] FAIL: the popover cleared the whole composer card — it is anchored to the card again, not to the trigger',
  );
  process.exit(1);
}
if (m.rightEdgeSkew > 4) {
  console.error(
    `[effort] FAIL: align="end" should keep the right edges together, off by ${m.rightEdgeSkew}px`,
  );
  process.exit(1);
}
console.log(
  `[effort] OK: the popover opens ${m.gapToTrigger}px above its own trigger, right edges aligned to ${m.rightEdgeSkew}px, with a ${m.draftHeight}px draft in the box (it covers ${m.editorOverlapY}px of the editor BY DESIGN — see the header)`,
);
