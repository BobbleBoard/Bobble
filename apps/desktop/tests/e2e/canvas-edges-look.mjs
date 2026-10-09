/**
 * THE CANVAS'S EDGES, AT DEVICE PIXELS — the selected tab's flares and the
 * corner where the canvas meets the chat area.
 *
 * The user (2026-10-08): "there's a bit of wierdness around the edges of the tabs,
 * the curve up a bit thicker or something than the rest and then the top of
 * the border between the canvas and chat area … there's an inexplicable rounded
 * corner". Opens two tabs, then photographs at 2x (CDP clip, scale 1 on the 2x
 * window) the selected tab's bottom-left flare, its top-left corner, and the
 * canvas panel's top-left corner, each also blown up 4x for reading, and prints
 * the computed borders and radii that draw them.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/canvas-edges-look.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, check, shotDir, finish } = await launchApp('canvas-edges', {
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdp = await page.context().newCDPSession(page);
async function crop(name, x, y, w, h) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: w, height: h, scale: 1 },
    captureBeyondViewport: false,
  });
  writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
  const big = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: w, height: h, scale: 4 },
    captureBeyondViewport: false,
  });
  writeFileSync(path.join(shotDir, `${name}-x4.png`), Buffer.from(big.data, 'base64'));
}
try {
  if (process.env.THEME === 'light') {
    await page.click('[data-testid="profile-button"]');
    await page.click('[data-testid="toggle-mode"]');
    await page.keyboard.press('Escape');
  }
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.evaluate(() => window.__pi_canvas().openTab({ kind: 'browser', title: 'New tab' }));
  await page.evaluate(() => window.__pi_canvas().openTab({ kind: 'browser', title: 'Second' }));
  await sleep(1500);
  const geo = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const panel = document.querySelector('[data-testid="canvas-tabs-panel"]');
    const active =
      document.querySelector('.pd-canvas-tab[data-active="true"]') ??
      document.querySelector('.pd-canvas-tab[aria-selected="true"]');
    const style = (el, props) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
    };
    // The panel and every ancestor up to the main area: who rounds the corner?
    const chain = [];
    for (let el = panel; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (
        cs.borderTopLeftRadius !== '0px' ||
        cs.borderLeftWidth !== '0px' ||
        cs.overflow !== 'visible'
      ) {
        chain.push({
          cls: (el.className?.toString?.() ?? '').slice(0, 80),
          radius: cs.borderTopLeftRadius,
          borderLeft: `${cs.borderLeftWidth} ${cs.borderLeftStyle} ${cs.borderLeftColor}`,
          borderTop: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
          shadow: cs.boxShadow.slice(0, 80),
          overflow: cs.overflow,
        });
      }
    }
    return {
      panel: box(panel),
      active: box(active),
      activeStyle: style(active, [
        'border-top-left-radius',
        'border-left',
        'box-shadow',
        'background-color',
      ]),
      activeBefore: active ? getComputedStyle(active, '::before').cssText || null : null,
      chain,
    };
  });
  console.log(JSON.stringify(geo, null, 1));
  check(geo.panel !== null && geo.active !== null, 'the canvas and its selected tab are on screen');
  if (geo.active !== null && geo.panel !== null) {
    const a = geo.active;
    await crop('1-tab-bottom-left', a.x - 18, a.y + a.h - 18, 40, 28);
    await crop('2-tab-top-left', a.x - 6, a.y - 6, 30, 26);
    await crop('3-tab-whole', a.x - 20, a.y - 8, a.w + 40, a.h + 16);
    const p = geo.panel;
    await crop('4-panel-top-left', p.x - 14, p.y - 6, 40, 40);
    await crop('5-panel-top', p.x - 40, p.y - 10, 200, 70);
  }
} finally {
  await finish();
}
