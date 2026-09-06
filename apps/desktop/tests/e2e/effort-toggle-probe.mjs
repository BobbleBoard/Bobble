/**
 * AUTO IS A SWITCH, AND WITH IT ON THERE IS NO SLIDER.
 *
 * the user: "increase the size and restyle auto to be a toggle button that just
 * removes the slider while toggled on."
 *
 * Both halves need a real app to check. The size is a computed box, not a
 * declaration — a `min-width` on a flex child loses to a popover that is too
 * narrow, which is exactly how the track ended up at 132px in a 248px panel.
 * And "removes the slider" is a claim about what is on screen, which a unit
 * test can only make about a string of HTML.
 *
 * The third thing here is the one that would actually strand someone: Auto used
 * to be a ONE-WAY reset, survivable only because the slider stayed on screen in
 * Auto and dragging it pinned a level. With the slider gone, a one-way control
 * is a door that locks behind you — so the switch is driven twice, and the way
 * back matters more than the way in.
 *
 * A HOME OF ITS OWN, and not for isolation's sake: `launchApp` gives each probe
 * a fresh user-data dir but leaves HOME alone, and the effort mode is persisted
 * to ~/.pi/desktop/settings.json. An earlier version of this probe pressed an
 * arrow key on the real profile and left the actual app pinned to `level`.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, openWorkMode } from './harness.mjs';

const home = mkdtempSync(path.join(tmpdir(), 'pd-effort-toggle-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });

const { page, shot, check, finish } = await launchApp('effort-toggle-probe', {
  env: { HOME: home },
});

const state = () =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const sw = document.querySelector('.pd-effort-auto');
    return {
      track: box('.pd-effort-track'),
      knob: box('.pd-effort-knob'),
      panel: box('.pd-effort-popover'),
      hasSlider: document.querySelector('[role="slider"]') !== null,
      flanks: [...document.querySelectorAll('.pd-effort-flank')].map((e) => e.textContent),
      checked: sw?.getAttribute('aria-checked') ?? null,
      switchRole: sw?.getAttribute('role') ?? null,
      focused: document.activeElement?.getAttribute('role') ?? null,
    };
  });

// The effort dial, the project chip and the instruction files live on the WORK
// ledge, which the app now ships collapsed (and `inert`) behind the Chat|Work
// toggle in the top left. A probe that drives one of them opens it first.
await openWorkMode(page);
await page.click('[data-testid="composer-effort"]');
await page.waitForSelector('.pd-effort-popover');
await page.waitForTimeout(500);

// --- Auto on: the switch is the control, and it is the only one -------------
const on = await state();
check(on.switchRole === 'switch', `Auto should be a switch, got role=${on.switchRole}`);
check(on.checked === 'true', `a fresh profile is on Auto, got aria-checked=${on.checked}`);
check(!on.hasSlider, 'Auto is on and the slider is still there — it should be removed');
check(on.track === null, `the track survived Auto: ${JSON.stringify(on.track)}`);
check(
  on.flanks.length === 0,
  `the "Faster"/"Smarter" labels outlived their slider: ${JSON.stringify(on.flanks)}`,
);
// The keyboard has to land somewhere real when there is no thumb to land on.
check(on.focused === 'switch', `opening in Auto focused ${on.focused}, not the switch`);
await shot('01-auto-on-no-slider');

// --- flip it off: the slider comes back, at the SIZE the user asked for ---------
await page.click('.pd-effort-auto');
await page.waitForTimeout(500);
const off = await state();
check(off.checked === 'false', `flipping the switch left aria-checked=${off.checked}`);
check(off.hasSlider, 'turning Auto off did not bring the slider back');
/*
 * The floors, not the exact numbers — the design may move, but it may not go
 * back. Before: a 132x12 track with an 18px knob in a 248px panel.
 */
check(
  off.track !== null && off.track.w >= 200 && off.track.h >= 16,
  `the track is back to being small: ${JSON.stringify(off.track)}`,
);
check(
  off.knob !== null && off.knob.w >= 24,
  `the knob is back to being small: ${JSON.stringify(off.knob)}`,
);
check(
  off.panel !== null && off.panel.w >= 320,
  `the panel is too narrow to hold the track at its stated minimum: ${JSON.stringify(off.panel)}`,
);
check(
  off.flanks.join('|') === 'Faster|Smarter',
  `the end labels did not come back: ${JSON.stringify(off.flanks)}`,
);
await shot('02-auto-off-slider-back');

// --- and back on, because a one-way switch is a trap ------------------------
await page.click('.pd-effort-auto');
await page.waitForTimeout(500);
const again = await state();
check(again.checked === 'true', `the switch would not go back on: aria-checked=${again.checked}`);
check(!again.hasSlider, 'turning Auto back on left the slider on screen');
await shot('03-auto-on-again');

await finish();
