/**
 * THE THREE STUDIOS, DRIVEN AND PHOTOGRAPHED.
 *
 * the user: "you need to iterate on the UI until you're very happy with it, you play
 * with it, try to break some animations/visuals clicking a bunch hovering a
 * bunch lots of visual review."
 *
 * So this opens each room, switches every mode, hovers every control and
 * measures geometry — the things a screenshot alone will not tell you (whether
 * a row wraps, whether two controls disagree about their height, whether the
 * focus ring is clipped).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/studio-visual';
mkdirSync(OUT, { recursive: true });
const MODE = process.env.MODE ?? 'dark';

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 25000 });
await win.waitForTimeout(1500);
if (MODE === 'light') {
  /*
   * Through the STORE, not the attribute. The app re-applies theme attributes
   * from `useThemeStore` in an effect, so a probe that sets `data-mode` by hand
   * gets silently overwritten on the next render and photographs the dark theme
   * while believing it captured the light one.
   */
  await win.evaluate(() => {
    window.__pi_theme?.().setMode?.('light');
  });
  await win.waitForTimeout(600);
}

const open = async (which) => {
  await win.evaluate((w) => {
    // Route directly: the sidebar rows are covered by their own probe, and this
    // one is about the ROOMS.
    window.__modality_store?.().getState().setView(w);
  }, which);
  await win.waitForTimeout(900);
};

// Expose the modality store for the probe.
await win.evaluate(() => {
  if (window.__modality_store === undefined) {
    window.__probe_note = 'no modality store hook';
  }
});

const geom = async (label) => {
  const g = await win.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => (el === null ? null : {
      x: Math.round(el.getBoundingClientRect().x),
      y: Math.round(el.getBoundingClientRect().y),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    });
    const controls = [...document.querySelectorAll('.pd-studio-knob')].map((k) => ({
      label: k.querySelector('.pd-studio-knob-label')?.textContent ?? '',
      h: Math.round(k.getBoundingClientRect().height),
      inputH: Math.round(
        (k.querySelector('input,select')?.getBoundingClientRect().height ?? 0),
      ),
    }));
    const row = q('.pd-studio-controls');
    return {
      head: box(q('.pd-studio-head')),
      prompt: box(q('[data-testid="studio-prompt"]')),
      controlsRow: box(row),
      run: box(q('[data-testid="studio-run"]')),
      controls,
      // Did the control row WRAP? Two lines means the knobs no longer read as one strip.
      wrapped: row === null ? null : row.getBoundingClientRect().height > 60,
      empty: (q('[data-testid="studio-empty"]')?.textContent ?? '').slice(0, 70),
      blocked: q('[data-testid="studio-blocked"]')?.textContent ?? null,
    };
  });
  console.log(`${label}:`, JSON.stringify(g, null, 1));
  return g;
};

for (const which of ['image', 'video', 'audio']) {
  await open(which);
  await win.screenshot({ path: path.join(OUT, `${MODE}-${which}.png`) });
  await geom(which.toUpperCase());
}

// The audio studio's three modes, each with its own control set.
await open('audio');
for (const m of ['speech', 'music', 'sfx']) {
  await win.click(`[data-testid="audio-mode-${m}"]`).catch(() => {});
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(OUT, `${MODE}-audio-${m}.png`) });
  await geom(`AUDIO/${m}`);
}

// Hover states, and a focus ring.
await win.hover('[data-testid="studio-back"]').catch(() => {});
await win.waitForTimeout(250);
await win.screenshot({ path: path.join(OUT, `${MODE}-hover-back.png`) });
await win.click('[data-testid="studio-prompt"]').catch(() => {});
await win.waitForTimeout(250);
await win.screenshot({ path: path.join(OUT, `${MODE}-focus-prompt.png`) });

await app.close();
console.log('shots in', OUT);
