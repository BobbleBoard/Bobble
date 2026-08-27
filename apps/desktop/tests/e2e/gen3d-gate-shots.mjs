/**
 * THE MODULE GATE, PHOTOGRAPHED ON A MACHINE THAT HAS NOTHING.
 *
 * `GEN3D_CACHE_DIR` points the engine at an empty directory, which is what a
 * fresh Mac looks like: no venvs, no weights, no sidecar. The point of the shots
 * is that the studio is still LOOKABLE — the user: "so we're not gatekeeping the UI
 * from being seen at all as if it's a paid service".
 *
 * TWO launches, deliberately. `PI_DESKTOP_TRIPO=1` forces `?tripo=1`, which
 * re-enters the studio the instant "Chat" exits it — so the sidebar has to be
 * photographed WITHOUT that flag or the back button looks broken when it is not.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? path.join(tmpdir(), 'gate-shots');
const empty = mkdtempSync(path.join(tmpdir(), 'gen3d-empty-'));
const base = { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', GEN3D_CACHE_DIR: empty };

// ── 1. the sidebar, from a normal chat-first launch ────────────────────────
{
  const app = await _electron.launch({ args: ['.'], cwd: process.cwd(), env: base });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('[data-testid="modality-3d"]', { timeout: 30_000 });
  await win.waitForTimeout(2500);
  const row = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="modality-3d"]');
    return {
      installed: el.getAttribute('data-installed'),
      title: el.getAttribute('title'),
      size: document.querySelector('[data-testid="modality-3d-size"]')?.textContent,
      opacity: getComputedStyle(el).opacity,
    };
  });
  console.log('sidebar row:', JSON.stringify(row));
  await win.screenshot({ path: path.join(OUT, 'gate-1-sidebar.png') });
  await app.close();
}

// ── 2. the gate itself ─────────────────────────────────────────────────────
{
  const app = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...base, PI_DESKTOP_TRIPO: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('[data-testid="tp-module-gate"]', { timeout: 30_000 });
  await win.waitForTimeout(2000);
  const gate = await win.evaluate(() => ({
    status: document.querySelector('[data-testid="tp-module-gate"]').getAttribute('data-status'),
    download: document.querySelector('[data-testid="tp-gate-download"]')?.textContent ?? null,
    view: document.querySelector('[data-testid="tp-gate-view"]')?.textContent ?? null,
    blur: getComputedStyle(document.querySelector('.tp-shell')).filter,
    inert: document.querySelector('.tp-shell').hasAttribute('inert'),
  }));
  console.log('gate:', JSON.stringify(gate));
  await win.screenshot({ path: path.join(OUT, 'gate-2-blurred.png') });

  await win.click('[data-testid="tp-gate-view"]');
  await win.waitForTimeout(1800);
  const after = await win.evaluate(() => ({
    gateGone: document.querySelector('[data-testid="tp-module-gate"]') === null,
    blur: getComputedStyle(document.querySelector('.tp-shell')).filter,
    inert: document.querySelector('.tp-shell').hasAttribute('inert'),
    restore: document.querySelector('[data-testid="tp-gate-restore"]')?.textContent ?? null,
  }));
  console.log('after View:', JSON.stringify(after));
  await win.screenshot({ path: path.join(OUT, 'gate-3-viewing.png') });
  await app.close();
}
