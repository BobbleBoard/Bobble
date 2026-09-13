/**
 * THE ENGINE MENU'S "FETCH MISSING" BUTTON — a little button under
 * Calibrate/Recalibrate (the user, 2026-09-13), asked of the supervisor whenever
 * the menu opens: "Fetch missing · N" when the catalogue names twins or
 * drafters that are not on disk, "Nothing missing" (disabled) when they all
 * are — and no "tok/s shows while a reply streams" line anywhere.
 *
 * Real cache, throwaway HOME; starts two small models that are on disk here
 * (MiniCPM5 2B: everything present; Nanbeige 4.2 3B: its GGUF DSpark, MLX
 * twin and MLX DSpark head are not). Nothing is downloaded.
 *
 *   SHOT_DIR=/tmp/fetch-missing node apps/desktop/tests/e2e/engine-fetch-missing-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const COMPLETE = process.env.COMPLETE ?? 'minicpm5-2b';
const INCOMPLETE = process.env.INCOMPLETE ?? 'nanbeige4.2-3b';
const {
  page: win,
  check,
  finish,
  shotDir,
} = await launchApp('engine-fetch-missing', {
  realCache: true,
  waitFor: '[data-testid="composer-input"]',
});
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = async (name) =>
  writeFileSync(path.join(shotDir, `${name}.png`), await win.screenshot());
try {
  await win.waitForTimeout(1500);
  const start = async (id) => {
    const r = await win.evaluate(
      (m) => window.piDesktop.invoke('llm:start-server', { modelId: m }),
      id,
    );
    check(r.success === true, `start ${id}: ${r.error}`);
    await win.waitForFunction(
      (m) =>
        window.__llm_store?.().getState().status.model?.id === m &&
        window.__llm_store().getState().status.phase === 'ready',
      id,
      { timeout: 180_000 },
    );
    await win.waitForTimeout(600);
  };
  const openMenu = async () => {
    const btn = win.locator('[data-testid="engine-menu-button"]');
    if ((await win.locator('[data-testid="engine-menu"]').count()) === 0) await btn.click();
    await win.waitForSelector('[data-testid="engine-menu"]', { timeout: 5000 });
    await win.waitForSelector('[data-testid="engine-fetch-missing"]', { timeout: 5000 });
    await win.waitForTimeout(500);
    return win.evaluate(() => {
      const b = document.querySelector('[data-testid="engine-fetch-missing"]');
      const cal = document.querySelector(
        '[data-testid="engine-calibrate"], [data-testid="engine-calibrate-cancel"]',
      );
      const br = b?.getBoundingClientRect();
      const cr = cal?.getBoundingClientRect();
      return {
        text: b?.textContent?.trim(),
        disabled: b?.disabled,
        title: b?.getAttribute('title'),
        missing: b?.getAttribute('data-missing'),
        underCalibrate:
          br !== undefined &&
          cr !== undefined &&
          br.top >= cr.bottom &&
          Math.abs(br.right - cr.right) < 4,
        idleLine: /tok\/s shows while a reply streams/.test(
          document.querySelector('[data-testid="engine-menu"]')?.textContent ?? '',
        ),
      };
    });
  };
  const closeMenu = async () => {
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);
  };

  await start(COMPLETE);
  const m1 = await openMenu();
  log(COMPLETE, JSON.stringify(m1));
  check(
    m1.text === 'Nothing missing' && m1.disabled === true,
    `${COMPLETE}: every companion is on disk → "Nothing missing", disabled (${m1.text})`,
  );
  check(m1.underCalibrate, 'the button sits under Calibrate, right-aligned with it');
  check(!m1.idleLine, 'no "tok/s shows while a reply streams" line');
  await shot('01-nothing-missing');
  await closeMenu();

  await start(INCOMPLETE);
  const m2 = await openMenu();
  log(INCOMPLETE, JSON.stringify(m2));
  check(
    /^Fetch missing · \d+$/.test(m2.text ?? '') && m2.disabled === false && Number(m2.missing) >= 1,
    `${INCOMPLETE}: "Fetch missing · N", enabled (${m2.text})`,
  );
  check(/MLX weights/.test(m2.title ?? ''), `the title names what would come down (${m2.title})`);
  await shot('02-fetch-missing');
  await closeMenu();
  await win.evaluate(() => window.piDesktop.invoke('llm:stop-server', undefined));
} finally {
  await finish();
}
