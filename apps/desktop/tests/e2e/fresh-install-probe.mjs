/**
 * THE OUT-OF-BOX STATE, ON THE SHIPPED BUNDLE.
 *
 * Launches /Applications/Bobble.app with a THROWAWAY profile and an empty gen3d
 * cache, so it sees what a Mac that has never run this app sees — no settings,
 * no models, no 3D module. The user's real profile is never touched.
 */
import { _electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = process.env.APP ?? '/Applications/Bobble.app';
const OUT = process.env.OUT ?? tmpdir();
const profile = mkdtempSync(path.join(tmpdir(), 'bobble-fresh-'));
const gen3d = mkdtempSync(path.join(tmpdir(), 'gen3d-fresh-'));
// An isolated HOME so the on-disk first-run gate reads as "never run", and
// PI_ONBOARDING=1 so the E2E flag does not skip the wizard the way it does for
// every other probe. Together these are the true out-of-box path.
const home = mkdtempSync(path.join(tmpdir(), 'home-fresh-'));

const app = await _electron.launch({
  executablePath: path.join(APP, 'Contents/MacOS/Bobble'),
  args: [`--user-data-dir=${profile}`],
  env: {
    ...process.env,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    ...(process.env.SKIP_ONBOARDING === '1' ? {} : { PI_ONBOARDING: '1' }),
    HOME: home,
    GEN3D_CACHE_DIR: gen3d,
  },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(6000);
await win.screenshot({ path: path.join(OUT, 'fresh-1-boot.png') });

const seen = await win.evaluate(() => {
  const t = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
  const el = document.querySelector('[data-testid="modality-3d"]');
  return {
    onboarding: document.body.textContent?.match(/coming from|experience|Claude|Codex/) !== null,
    buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 10),
    heading: document.querySelector('h1,h2')?.textContent?.trim() ?? null,
    threeD: el === null ? null : {
      installed: el.getAttribute('data-installed'),
      title: el.getAttribute('title'),
      size: t('[data-testid="modality-3d-size"]'),
    },
    chip: t('[data-testid="footer-model-chip"]'),
  };
});
console.log('first run:', JSON.stringify(seen, null, 1));

// The 3D studio on a machine with nothing installed.
await win.click('[data-testid="modality-3d"]').catch(() => {});
await win.waitForTimeout(3000);
const gate = await win.evaluate(() => {
  const g = document.querySelector('[data-testid="tp-module-gate"]');
  const shell = document.querySelector('.tp-shell');
  return g === null ? null : {
    status: g.getAttribute('data-status'),
    download: document.querySelector('[data-testid="tp-gate-download"]')?.textContent ?? null,
    view: document.querySelector('[data-testid="tp-gate-view"]')?.textContent ?? null,
    blurred: shell === null ? null : getComputedStyle(shell).filter,
    inert: shell?.hasAttribute('inert') ?? null,
  };
});
console.log('3D gate:', JSON.stringify(gate));
await win.screenshot({ path: path.join(OUT, 'fresh-2-3d.png') });
console.log('profile:', profile);
await app.close();
