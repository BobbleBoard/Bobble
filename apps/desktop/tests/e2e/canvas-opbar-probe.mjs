/**
 * The two canvas defects the user reported on 2026-09-05, LOOKED AT rather than
 * merely asserted:
 *
 *   1. "the 'rendered/raw' buttons are pretty big and could be a bit smaller
 *      and more in line, they buldge out a bit much"
 *   2. "the line numbers on the left side seem to have transparent background
 *      and overlap with real text if hscroll occurs"
 *
 * Both are geometry, so both get measured as well as photographed. (1) is the
 * segmented control standing proud of the 28px icon buttons beside it and
 * forcing the 36px bar taller than it asks to be; (2) is a sticky gutter with
 * nothing painted behind it, which only shows once the code slides underneath —
 * so the probe SCROLLS before it looks.
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/opbar-after node apps/desktop/tests/e2e/canvas-opbar-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const LONG = (n) =>
  `const veryLongIdentifierNumber${n} = compute(${n}, "a string long enough to run off the right edge of the canvas", { flag: true });`;
const SOURCE = Array.from({ length: 40 }, (_, i) => LONG(i)).join('\n');

const { page, shot, check, finish, shotDir } = await launchApp('canvas-opbar');

const clipShot = async (label, clip) => {
  const file = path.join(shotDir, `${label}.png`);
  writeFileSync(file, await page.screenshot({ clip }));
  return file;
};

try {
  await page.evaluate((text) => {
    window.__pi_canvas().openTab({
      kind: 'code',
      title: 'wide.ts',
      filePath: '/tmp/wide.ts',
      artifact: {
        id: 'wide',
        filename: 'wide.ts',
        content: { kind: 'code', text, language: 'typescript' },
      },
    });
  }, SOURCE);
  await page.waitForSelector('.pd-canvas-view-toggle', { timeout: 10_000 });
  await page.waitForTimeout(500);

  /* ── 1. Does the toggle sit IN the row, or on top of it? ──────────────── */
  const geo = await page.evaluate(() => {
    const h = (el) =>
      el === null ? null : Math.round(el.getBoundingClientRect().height * 10) / 10;
    const seg = document.querySelector('.pd-canvas-view-toggle .pd-segment');
    const toggle = document.querySelector('.pd-canvas-view-toggle');
    return {
      bar: h(document.querySelector('.pd-canvas-opbar')),
      toggle: h(toggle),
      iconBtn: h(document.querySelector('.pd-canvas-opbar .pd-icon-btn')),
      segment: h(seg),
      segFont: seg === null ? null : getComputedStyle(seg).fontSize,
      toggleWidth: toggle === null ? null : Math.round(toggle.getBoundingClientRect().width),
    };
  });
  console.log('  geometry', JSON.stringify(geo));
  check(geo.toggle !== null && geo.iconBtn !== null, 'the bar has both a toggle and icon buttons');
  check(
    geo.toggle !== null && geo.iconBtn !== null && geo.toggle <= geo.iconBtn,
    `toggle (${geo.toggle}px) is no taller than the icon buttons beside it (${geo.iconBtn}px)`,
  );
  check(
    geo.bar !== null && geo.toggle !== null && geo.bar - geo.toggle >= 8,
    `the toggle leaves the 36px bar its padding (bar ${geo.bar}px, toggle ${geo.toggle}px)`,
  );

  await shot('01-canvas');
  await clipShot(
    '02-opbar',
    await page.evaluate(() => {
      const b = document.querySelector('.pd-canvas-opbar').getBoundingClientRect();
      return {
        x: Math.max(0, b.x - 4),
        y: Math.max(0, b.y - 8),
        width: b.width,
        height: b.height + 16,
      };
    }),
  );

  /* ── 2. Gutter: painted, or does scrolled code show through it? ───────── */
  /*
   * NOT a CSS-string check. The first version of this probe asserted only that
   * the background was "not transparent", and went green over a 4% tint you
   * could still read the source through. The honest test is the one the eye
   * does: photograph the gutter strip, scroll the code under it, photograph it
   * again. An opaque gutter is byte-identical between the two; a see-through
   * one changes because different code is now behind the digits.
   */
  const gutterBg = await page.evaluate(
    () => getComputedStyle(document.querySelector('.cm-gutters')).background,
  );
  console.log('  .cm-gutters background:', gutterBg.split(',')[0], '…');

  const stripClip = await page.evaluate(() => {
    const g = document.querySelector('.cm-gutters').getBoundingClientRect();
    return {
      x: g.x,
      y: g.y + 4,
      width: Math.max(1, Math.round(g.width)),
      height: Math.min(160, g.height - 8),
    };
  });
  const stripAt = async (scrollLeft) => {
    await page.evaluate((x) => {
      document.querySelector('.cm-scroller').scrollLeft = x;
    }, scrollLeft);
    await page.waitForTimeout(250);
    return page.screenshot({ clip: stripClip });
  };
  const atRest = await stripAt(0);
  const scrolled = await stripAt(420);
  writeFileSync(path.join(shotDir, 'strip-rest.png'), atRest);
  writeFileSync(path.join(shotDir, 'strip-scrolled.png'), scrolled);
  const identical = Buffer.compare(atRest, scrolled) === 0;
  console.log(`  gutter strip unchanged by a 420px scroll: ${identical}`);
  check(identical, 'the line-number strip does not change when code scrolls under it');

  await shot('03-code-hscrolled');

  const gutterClip = await page.evaluate(() => {
    const g = document.querySelector('.cm-gutters').getBoundingClientRect();
    return {
      x: g.x,
      y: g.y,
      width: Math.min(380, window.innerWidth - g.x),
      height: Math.min(190, g.height),
    };
  });
  await clipShot('04-gutter-zoom', gutterClip);

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
