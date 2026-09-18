/**
 * LOOK at the selected canvas tab's two bottom corners at 8×. the user
 * (2026-09-18): "super nitpick, there's some sort of artifacting/sharpness
 * that needs to go at the edges of tabs" — circled where the tab's flares
 * meet the strip's seam.
 *
 * Both themes; a middle tab selected so both flares reach across a
 * neighbour; the corners cut out of a device-pixel screenshot and scaled with
 * nearest-neighbour so every pixel is the pixel.
 *
 *   OUT=/tmp/tab-corner node apps/desktop/tests/e2e/canvas-tab-corner-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { decodePng, encodePng } from './png.mjs';

const OUT = process.env.OUT ?? path.join(tmpdir(), 'tab-corner');
mkdirSync(OUT, { recursive: true });
const {
  page: win,
  check,
  finish,
} = await launchApp('tab-corner', {
  waitFor: '[data-testid="composer-input"]',
});

/** Cut a CSS-pixel box out of a device-pixel PNG and blow it up N×. */
function zoom(pngBuf, box, scale, factor) {
  const png = decodePng(pngBuf);
  const x0 = Math.round(box.x * scale);
  const y0 = Math.round(box.y * scale);
  const w = Math.round(box.width * scale);
  const h = Math.round(box.height * scale);
  const out = Buffer.alloc(w * factor * h * factor * png.channels);
  for (let y = 0; y < h * factor; y += 1) {
    for (let x = 0; x < w * factor; x += 1) {
      const sx = x0 + Math.floor(x / factor);
      const sy = y0 + Math.floor(y / factor);
      const from = (sy * png.width + sx) * png.channels;
      const to = (y * w * factor + x) * png.channels;
      png.data.copy(out, to, from, from + png.channels);
    }
  }
  return encodePng({ width: w * factor, height: h * factor, channels: png.channels, data: out });
}

const setTheme = async (mode) => {
  await win.evaluate(
    (mode) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode } }),
    mode,
  );
  await win.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
};

try {
  await win.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });
  await win.waitForTimeout(3000);
  for (let i = 0; i < 6; i++) {
    await win.evaluate(() => {
      const c = window.__pi_canvas();
      if (c.getState().tabs.length >= 3) return;
      c.reset();
      c.openTab({ kind: 'terminal', title: 'Terminal' });
      c.openTab({ kind: 'terminal', title: 'Subagents' });
      c.openTab({ kind: 'terminal', title: 'Second' });
      const mid = c.getState().tabs[1];
      if (mid) c.focusTab(mid.id);
    });
    await win.waitForTimeout(1000);
    if ((await win.locator('.pd-canvas-tab').count()) >= 3) break;
    const toggle = win.locator('[data-testid="canvas-toggle"]').first();
    if ((await toggle.count()) > 0) await toggle.click().catch(() => {});
    await win.waitForTimeout(800);
  }
  const active = win.locator('.pd-canvas-tab[data-active]').first();
  check((await active.count()) === 1, 'a selected tab is on screen');
  const scale = await win.evaluate(() => window.devicePixelRatio);
  for (const mode of ['dark', 'light']) {
    await setTheme(mode);
    await win.mouse.move(2, 2);
    await win.waitForTimeout(500);
    const box = await active.boundingBox();
    const shot = await win.screenshot();
    writeFileSync(path.join(OUT, `${mode}-strip.png`), shot);
    // 22×22 CSS px around each bottom corner: the flare (radius md) and the seam.
    const size = 22;
    const left = { x: box.x - 12, y: box.y + box.height - 14, width: size, height: size };
    const right = {
      x: box.x + box.width - 10,
      y: box.y + box.height - 14,
      width: size,
      height: size,
    };
    writeFileSync(path.join(OUT, `${mode}-corner-left.png`), zoom(shot, left, scale, 8));
    writeFileSync(path.join(OUT, `${mode}-corner-right.png`), zoom(shot, right, scale, 8));
    /*
     * THE NUMBERS. The seam is the two device rows above the tab's bottom edge
     * (a 1px line at DPR 2). Its brightness well left of the flare is the
     * reference; the flare's foot — the seam rows at the flare's own edge —
     * must be the same line, not a brighter or taller one (MEASURED before the
     * fix, dark: seam 47/47, foot 38/72/66); and the tab's own bottom row must
     * be the pane, with no line under it.
     */
    const png = decodePng(shot);
    const lum = (x, y) => {
      const i = (Math.round(y) * png.width + Math.round(x)) * png.channels;
      return (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    };
    const bottom = (box.y + box.height) * scale; // device row just below the tab
    const rows = [bottom - 3, bottom - 2, bottom - 1]; // one above the seam, the seam's two
    const column = (xCss) => rows.map((y) => Math.round(lum(xCss * scale, y)));
    const seam = column(box.x - 30);
    // The foot: the flare is 8px wide and starts 1px in from the border box,
    // so its outer edge — where the arc is tangent to the seam — is 7px out.
    const footL = column(box.x - 7.5);
    const footR = column(box.x + box.width + 6.5);
    const middle = column(box.x + box.width / 2);
    const pane = Math.round(lum((box.x + box.width / 2) * scale, bottom + 2));
    const ground = Math.round(lum((box.x - 30) * scale, bottom - 6));
    // A line's weight is how far it stands from the ground, whichever way the
    // theme's contrast runs (a dark seam on light, a light seam on dark).
    const weight = (v) => Math.abs(v - ground);
    const seamLine = Math.max(weight(seam[1]), weight(seam[2]));
    const tol = 6;
    console.log(mode, JSON.stringify({ seam, footL, footR, middle, pane, ground }));
    const feet = [footL, footR].map((f) => Math.max(weight(f[1]), weight(f[2])));
    check(
      feet.every((f) => Math.abs(f - seamLine) <= tol),
      `${mode}: the flares' feet are the seam's own weight (seam ${seamLine}, feet ${feet.join('/')})`,
    );
    // The arc leaves the seam at the tangent, so the row above carries some
    // of the line there — but never MORE than the line (that was the knot:
    // 73 over a 47 seam before the fix).
    check(
      weight(footL[0]) <= seamLine + tol && weight(footR[0]) <= seamLine + tol,
      `${mode}: …and nothing heavier than the line where the arc lifts (row above: ${footL[0]}/${footR[0]}, ground ${ground})`,
    );
    check(
      middle.every((v) => Math.abs(v - pane) <= tol),
      `${mode}: no line under the selected tab (${middle} vs pane ${pane})`,
    );
  }
} finally {
  await finish();
}
