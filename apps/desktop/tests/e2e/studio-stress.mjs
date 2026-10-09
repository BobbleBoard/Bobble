/**
 * TRYING TO BREAK THE STUDIOS.
 *
 * The user: "you play with it, try to break some animations/visuals clicking a
 * bunch hovering a bunch lots of visual review."
 *
 * The three things that actually break a control strip: a narrow window (does
 * the row wrap into nonsense), long content (does the prompt push the layout
 * around), and fast repeated interaction (does a transition get caught
 * mid-flight and leave a control in a wrong state).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/studio-stress';
mkdirSync(OUT, { recursive: true });

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 25000 });
await win.waitForTimeout(1500);
await win.evaluate(() => window.__modality_store?.().getState().setView('audio'));
await win.waitForTimeout(800);

const layout = async (label) => {
  const r = await win.evaluate(() => {
    const row = document.querySelector('.pd-studio-controls');
    const run = document.querySelector('[data-testid="studio-run"]');
    const prompt = document.querySelector('[data-testid="studio-prompt"]');
    const knobs = [...document.querySelectorAll('.pd-studio-knob')];
    const rects = knobs.map((k) => k.getBoundingClientRect());
    // Distinct row tops = how many lines the control strip wrapped onto.
    const lines = new Set(rects.map((r) => Math.round(r.top))).size;
    const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    const runBox = run?.getBoundingClientRect();
    const rowBox = row?.getBoundingClientRect();
    return {
      win: window.innerWidth,
      lines,
      rowH: rowBox ? Math.round(rowBox.height) : null,
      promptW: prompt ? Math.round(prompt.getBoundingClientRect().width) : null,
      // Is the run button still inside the window?
      runRight: runBox ? Math.round(runBox.right) : null,
      clipped: runBox ? runBox.right > window.innerWidth + 1 : null,
      overflowX,
    };
  });
  console.log(`${label}:`, JSON.stringify(r));
  return r;
};

// 1. Narrow windows.
for (const w of [1440, 1100, 900, 760, 640]) {
  await win.setViewportSize({ width: w, height: 900 });
  await win.waitForTimeout(400);
  await layout(`width ${w}`);
  await win.screenshot({ path: path.join(OUT, `w${w}.png`) });
}
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForTimeout(400);

// 2. A very long prompt.
await win.click('[data-testid="studio-prompt"]');
await win.keyboard.type(`${'A '.repeat(400)}very long description that goes on and on.`);
await win.waitForTimeout(400);
await layout('long prompt');
await win.screenshot({ path: path.join(OUT, 'long-prompt.png') });

// 3. Rapid mode switching — catch a transition mid-flight.
for (let i = 0; i < 12; i++) {
  const m = ['speech', 'music', 'sfx'][i % 3];
  await win.click(`[data-testid="audio-mode-${m}"]`).catch(() => {});
  await win.waitForTimeout(40);
}
await win.waitForTimeout(600);
const after = await layout('after 12 rapid switches');
const modeState = await win.evaluate(() => {
  const on = [...document.querySelectorAll('.pd-seg-item')].filter(
    (b) => b.getAttribute('data-on') === 'true',
  );
  return { selected: on.length, labels: on.map((b) => b.textContent) };
});
console.log('MODE STATE:', JSON.stringify(modeState));
await win.screenshot({ path: path.join(OUT, 'after-rapid.png') });

// 4. Hover every knob + the run button, looking for a jump.
for (const sel of [
  '.pd-studio-select',
  '.pd-studio-input',
  '[data-testid="studio-run"]',
  '[data-testid="studio-back"]',
]) {
  await win.hover(sel).catch(() => {});
  await win.waitForTimeout(150);
}
await win.screenshot({ path: path.join(OUT, 'hovered.png') });

console.log(JSON.stringify({ finalLines: after.lines, clipped: after.clipped }));
await app.close();
console.log('shots in', OUT);
