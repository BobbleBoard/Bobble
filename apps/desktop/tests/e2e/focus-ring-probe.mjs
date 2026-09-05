/**
 * THE BLUE/WHITE OUTLINE ON DROPDOWNS, BUTTONS AND MENUS.
 *
 * the user, twice now: a ring appears around controls he has only ever clicked.
 * The stylesheet already gates every `--pd-*` ring behind `:focus-visible` and
 * additionally kills the UA outline on mouse `:focus`, so the CSS is not the
 * bug — something is making `:focus-visible` MATCH after a pointer interaction.
 *
 * This reproduces it the way he hits it, and reports the two things that
 * distinguish the causes: whether the element matches `:focus-visible`, and
 * what outline it is actually painting. It screenshots each step so the
 * before/after is a picture rather than an assertion.
 *
 * Steps, each a real mouse interaction and nothing else:
 *   1. click a StudioPicker trigger to OPEN its menu
 *   2. click an item to CHOOSE it (Radix returns focus to the trigger)
 *   3. click a plain button
 *   4. press Escape to close a menu instead of choosing
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const OUT =
  process.env.OUT ??
  '<session-scratchpad>/ring';
mkdirSync(OUT, { recursive: true });

const home = mkdtempSync(path.join(tmpdir(), 'pd-ring-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });

const { app, page, check, finish } = await launchApp('focus-ring-probe', {
  env: { HOME: home },
  args: ['--', '--piE2E=1'],
});

/** What the focused element is, and whether it is drawing a ring. */
const ringState = (label) =>
  page.evaluate((l) => {
    const el = document.activeElement;
    if (el === null || el === document.body) return { label: l, focused: '(body)' };
    const cs = getComputedStyle(el);
    return {
      label: l,
      focused: `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')}`,
      testid: el.getAttribute('data-testid'),
      focusVisible: el.matches(':focus-visible'),
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} @${cs.outlineOffset}`,
      /*
       * IS A RING ACTUALLY PAINTED — the only question that matters.
       *
       * `:focus-visible` matching is not the bug: a text field matches it on a
       * plain click, by design, and draws nothing. What the user sees is a coloured
       * outline. So: a real style, a real width, and a colour that is not
       * transparent.
       */
      ringPainted:
        cs.outlineStyle !== 'none' &&
        Number.parseFloat(cs.outlineWidth) > 0 &&
        !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(cs.outlineColor) &&
        cs.outlineColor !== 'transparent',
      boxShadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 60),
    };
  }, label);

const shotOf = async (name, selector) => {
  const el = await page.$(selector);
  if (el === null) return;
  const box = await el.boundingBox();
  if (box === null) return;
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: {
      x: Math.max(0, box.x - 16),
      y: Math.max(0, box.y - 16),
      width: box.width + 32,
      height: box.height + 32,
    },
  });
};

const report = [];
const record = async (label, selector) => {
  const s = await ringState(label);
  report.push(s);
  console.log(
    `  ${label.padEnd(34)} ring=${String(s.ringPainted).padEnd(5)} focus-visible=${String(s.focusVisible).padEnd(5)} outline=${s.outline ?? '-'} on ${s.testid ?? s.focused}`,
  );
  if (typeof selector === 'string')
    await shotOf(label.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), selector);
  return s;
};

try {
  await page.waitForFunction(() => typeof window.__modality_store === 'function', {
    timeout: 20_000,
  });
  await page.waitForSelector('.pd-composer-editor', { timeout: 20_000 });

  // Into the Video studio, where the user's screenshot came from.
  if ((await page.$('[data-testid="modality-video"]')) === null)
    await page.click('text=Modalities');
  await page.click('[data-testid="modality-video"]');
  await page.waitForSelector('.pd-studio', { timeout: 15_000 });
  if ((await page.getAttribute('[data-testid="studio-settings"]', 'data-open')) !== 'true') {
    await page.click('[data-testid="studio-settings-toggle"]');
  }
  await page.waitForTimeout(400);

  const PICKER = '[data-testid="video-model-rail"]';
  await page.waitForSelector(PICKER, { timeout: 10_000 });
  await record('0 · before any click', PICKER);

  // 1. OPEN with the mouse.
  await page.click(PICKER);
  await page.waitForTimeout(250);
  await record('1 · trigger clicked (menu open)', PICKER);

  // 2. CHOOSE an item with the mouse — Radix returns focus to the trigger.
  const item = await page.$('[role="menuitemradio"], [role="menuitem"]');
  if (item !== null) await item.click();
  await page.waitForTimeout(450);
  const afterChoose = await record('2 · item chosen, menu closed', PICKER);

  // 3. A plain button, clicked.
  await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForTimeout(300);
  const afterButton = await record(
    '3 · plain button clicked',
    '[data-testid="studio-settings-toggle"]',
  );
  // Put the rail back.
  await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForTimeout(400);

  // 4. Open then dismiss with Escape (a keyboard act — a ring here is CORRECT).
  await page.click(PICKER);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  const afterEscape = await record('4 · menu dismissed with Escape', PICKER);

  /*
   * 5. THE ONE THE USER ACTUALLY DESCRIBED: "if I click to something else, and then
   * come back to clicking an element, that's when the box appears."
   *
   * A window losing and regaining focus is not a keyboard act, but Chromium
   * restores focus to the element that had it AND restores its focus-visible
   * state — which is right for a keyboard user coming back to the app and wrong
   * for someone who only ever clicked. Blurring the real BrowserWindow is the
   * only way to reproduce it; a synthetic blur() event does not go through the
   * same path.
   */
  await page.click('[data-testid="studio-prompt"]');
  await page.waitForTimeout(150);
  await page.click(PICKER);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.click('[data-testid="studio-prompt"]'); // clear it the way a click does
  await page.waitForTimeout(200);
  await record('5a · clicked away, ring cleared', PICKER);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur());
  await page.waitForTimeout(400);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await page.waitForTimeout(600);
  const afterRefocus = await record('5b · window blurred then refocused', PICKER);

  console.log('');
  const mouseRings = [afterChoose, afterButton, afterRefocus, afterEscape].filter(
    (s) => s.ringPainted === true,
  );
  check(
    mouseRings.length === 0,
    `a ring is drawn after a MOUSE-only interaction on: ${mouseRings.map((s) => s.label).join(', ')}`,
  );
  /*
   * …AND THE KEYBOARD CASE MUST STILL RING, or the fix went too far and
   * keyboard users lost the only thing telling them where they are. Tab is the
   * navigation act; Escape deliberately is not one.
   */
  await page.click('[data-testid="studio-prompt"]');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(250);
  const afterTab = await record('6 · tabbed to the next control', null);
  check(
    afterTab.ringPainted === true,
    `tabbing drew NO ring — the fix went too far (outline was ${afterTab.outline})`,
  );

  /*
   * 7. THE SAME THING IN LIGHT MODE, because that is the theme the user screenshotted
   * and a ring hiding behind a token is a claim about both.
   */
  await page.evaluate(() => window.__pi_theme?.().setState?.({ mode: 'light' }));
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
  await page.waitForTimeout(300);
  await page.click(PICKER);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  const light = await record('7 · light mode, escape-dismissed', PICKER);
  check(light.ringPainted === false, `a ring is painted in light mode: ${light.outline}`);
  console.log(`shots: ${OUT}`);
} finally {
  await finish();
}
