/**
 * LOOK at a hovered canvas tab, at 3×. the user (2026-09-12): "raise the bottom
 * bar of the hover animation for the canvas tabs."
 *
 *   OUT=/tmp/tab-hover node apps/desktop/tests/e2e/canvas-tab-hover-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const OUT = process.env.OUT ?? path.join(tmpdir(), 'tab-hover');
mkdirSync(OUT, { recursive: true });
const { page: win, finish } = await launchApp('tab-hover', {
  waitFor: '[data-testid="composer-input"]',
});
try {
  await win.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });
  // Boot resets the canvas once the session settles; open the tabs after that.
  await win.waitForTimeout(3000);
  // Boot may reset the canvas once more after the composer is up; open until
  // the strip really shows the tabs.
  for (let i = 0; i < 6; i++) {
    await win.evaluate(() => {
      const c = window.__pi_canvas();
      if (c.getState().tabs.length >= 3) return;
      c.reset();
      c.openTab({ kind: 'terminal', title: 'Terminal' });
      // A subtitle, like the Activity tab carries (an activity tab itself needs
      // the router's data; a terminal with a subtitle draws the same chrome).
      c.openTab({ kind: 'terminal', title: 'Activity', subtitle: 'bash -c "bash"' });
      c.openTab({ kind: 'terminal', title: 'Second' });
      const first = c.getState().tabs[0];
      if (first) c.focusTab(first.id);
    });
    await win.waitForTimeout(1000);
    if ((await win.locator('.pd-canvas-tab').count()) >= 3) break;
    const toggle = win.locator('[data-testid="canvas-toggle"]').first();
    if ((await toggle.count()) > 0) await toggle.click().catch(() => {});
    await win.waitForTimeout(800);
  }
  const tabs = win.locator('.pd-canvas-tab');
  const n = await tabs.count();
  console.log(
    'tabs:',
    n,
    JSON.stringify(
      await win.evaluate(() =>
        window
          .__pi_canvas()
          .getState()
          .tabs.map((t) => t.kind),
      ),
    ),
  );
  const inactive = win.locator('.pd-canvas-tab:not([data-active])').first();
  await inactive.hover();
  await win.waitForTimeout(400);
  const box = await inactive.boundingBox();
  const strip = await win.locator('.pd-canvas-tablist').first().boundingBox();
  const m = await inactive.evaluate((el) => {
    const cs = getComputedStyle(el);
    const strip = el.closest('.pd-canvas-tablist');
    const sr = strip?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      tab: { top: r.top, bottom: r.bottom, h: r.height },
      strip: sr ? { top: sr.top, bottom: sr.bottom, h: sr.height } : null,
      bg: cs.backgroundColor,
      radius: cs.borderRadius,
      gapBelow: sr ? sr.bottom - r.bottom : null,
      gapAbove: sr ? r.top - sr.top : null,
    };
  });
  console.log('hovered tab:', JSON.stringify(m));
  const clip = {
    x: Math.max(0, (strip?.x ?? box.x) - 8),
    y: Math.max(0, (strip?.y ?? box.y) - 10),
    width: Math.min(560, (strip?.width ?? box.width) + 16),
    height: (strip?.height ?? box.height) + 24,
  };
  writeFileSync(path.join(OUT, 'hover-strip.png'), await win.screenshot({ clip }));
  await win.evaluate(() => {
    const s = window.__pi_canvas().getState();
    if (s.tabs[1]) window.__pi_canvas().focusTab(s.tabs[1].id);
  });
  await win.locator('.pd-canvas-tab:not([data-active])').first().hover();
  await win.waitForTimeout(400);
  writeFileSync(path.join(OUT, 'hover-strip-2.png'), await win.screenshot({ clip }));
} finally {
  await finish();
}
