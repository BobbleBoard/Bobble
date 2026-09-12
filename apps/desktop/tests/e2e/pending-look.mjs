/**
 * LOOK AT THE PENDING CARD — the shape, the bar, and the reveal.
 *
 * the user's rule on anything visual: reproduce, fix, re-reproduce, and LOOK. So this
 * drives a real generation and screenshots the card at the three moments that
 * matter: empty and animating, mid-sweep, and after the handover.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/pending-look';
const STUDIO = process.env.STUDIO ?? 'image';
const MODEL = process.env.MODEL ?? '';
const PROMPT = process.env.PROMPT ?? 'a hand-thrown ceramic mug on a windowsill in morning light';
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pend-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_GEN: '1' },
});

async function shoot(win, name) {
  const card = win
    .locator('[data-testid="pending-media-card"], [data-testid="media-card"]')
    .first();
  if ((await card.count()) > 0) {
    await card.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
  }
  await win.screenshot({ path: path.join(OUT, `${name}-full.png`) });
}

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 40000,
  });
  await win.waitForTimeout(1500);
  // NEVER set powerMode here: settings.json is shared with the real app, and a
  // probe that flips it to 'full' leaves the user's Bobble with the policy off.
  await win.evaluate((v) => window.__modality_store?.().getState().setView(v), STUDIO);
  await win.waitForTimeout(1800);

  if (MODEL !== '') {
    const trigger = win.locator(`[data-testid="${STUDIO}-model"]`);
    await trigger.click({ force: true });
    await win.waitForTimeout(400);
    const item = win.locator('[role="menuitemradio"]', { hasText: new RegExp(MODEL, 'i') }).first();
    if ((await item.count({ timeout: 2000 }).catch(() => 0)) > 0) {
      await item.click({ timeout: 4000 }).catch(() => {});
      say('model picked');
    } else {
      const all = await win
        .locator('[role="menuitemradio"]')
        .allTextContents()
        .catch(() => []);
      say(`model: (default) — offered ${JSON.stringify(all)}`);
      await win.keyboard.press('Escape');
    }
    await win.waitForTimeout(400);
  }

  // SIZE=Draft keeps a look at the card to a 768² job (~8 GB peak for FLUX.2
  // klein) rather than the 12.4 GB of 1024² — a real generation, not a heavy one.
  if (process.env.SIZE) {
    await win.locator(`[data-testid="${STUDIO}-size"]`).click({ force: true });
    await win.waitForTimeout(300);
    const opt = win
      .locator('[role="menuitemradio"]', { hasText: new RegExp(process.env.SIZE, 'i') })
      .first();
    if ((await opt.count()) > 0) {
      await opt.click();
      say(`size: ${process.env.SIZE}`);
    } else await win.keyboard.press('Escape');
    await win.waitForTimeout(300);
  }
  await win.click('[data-testid="studio-prompt"]');
  await win.keyboard.type(PROMPT, { delay: 6 });
  await win.click('[data-testid="studio-run"]');
  say('pressed Run');

  // 1. the empty card, animating
  await win.waitForSelector('[data-testid="pending-media-card"]', { timeout: 60000 });
  await win.waitForTimeout(2500);
  await shoot(win, '01-pending');
  const box = await win
    .locator('[data-testid="pending-media-card"] .pd-media-frame')
    .first()
    .boundingBox();
  say(`frame box: ${JSON.stringify(box)}`);

  // 2. catch the sweep: poll the mask variable the loader publishes
  let shot = 0;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const sweep = await win
      .evaluate(() => {
        const f = document.querySelector('[data-testid="pending-media-card"] .pd-media-frame');
        return f === null
          ? null
          : Number(getComputedStyle(f).getPropertyValue('--pd-pending-sweep') || 0);
      })
      .catch(() => null);
    if (sweep === null) break; // card gone: handed over
    if (sweep > 0.15 && shot < 3) {
      shot += 1;
      await shoot(win, `02-sweep-${shot}`);
      say(`sweep ${sweep.toFixed(2)}`);
    }
    await win.waitForTimeout(shot > 0 ? 150 : 200);
  }
  await win.waitForTimeout(900);
  await shoot(win, '03-done');
  // THE HANDOVER MUST NOT MOVE THE CARD: same box before and after.
  const after = await win
    .locator('[data-testid="media-card"] .pd-media-frame')
    .first()
    .boundingBox();
  say(`frame after: ${JSON.stringify(after)}`);
  if (box && after) {
    const dx = Math.abs(after.x - box.x);
    const dy = Math.abs(after.y - box.y);
    const dw = Math.abs(after.width - box.width);
    say(
      `handover moved the card by dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} dw=${dw.toFixed(0)} ${dx + dy + dw < 4 ? 'SEAMLESS' : 'JUMP'}`,
    );
  }
  say('done');
} finally {
  await app.close().catch(() => {});
}
