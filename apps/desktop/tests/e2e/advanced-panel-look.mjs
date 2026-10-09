/**
 * LOOK at Advanced (the gears): real app, real cache, headless. The user
 * (2026-09-13): ⓘ instead of inline blurbs, the app's own dropdowns, defaults
 * shown as editable values, Reset · Apply top right (no footer), no line under
 * the header, real names instead of flags, a separate Flags tab with the
 * search on top, "Other" not cut off, and the popup never changing size.
 *
 *   SHOT_DIR=/tmp/adv node apps/desktop/tests/e2e/advanced-panel-look.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'adv');
mkdirSync(SHOT_DIR, { recursive: true });
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const home = probeHome('advanced-look');
// The gears are a power-mode control; a fresh install never sees them.
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: 'qwen3.5-4b-mtp' },
  }),
);
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'adv-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'bobble'),
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_E2E_NO_SERVER: '1',
  },
});
const shot = async (win, name) =>
  writeFileSync(path.join(SHOT_DIR, `${name}.png`), await win.screenshot());
const dialogBox = (win) =>
  win.evaluate(() => {
    const r = document.querySelector('.pd-adv-panel')?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 });
  await win.waitForTimeout(1500);
  await win.click('[data-testid="advanced-params-toggle"]');
  await win.waitForSelector('[data-testid="engine-settings-tab"]', { timeout: 15000 });
  await win.waitForSelector('[data-testid="engine-knob-context"]', { timeout: 15000 });
  await win.waitForTimeout(600);

  // 1. Header: no line under the tabs; Reset + Apply top right, same height.
  const head = await win.evaluate(() => {
    const tabs = document.querySelector('.pd-adv-tabs');
    const reset = document.querySelector('[data-testid="engine-settings-reset"]');
    const apply = document.querySelector('[data-testid="engine-settings-apply"]');
    const dialog = document.querySelector('.pd-adv-panel');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      tabsBorder: cs(tabs)?.borderBottomWidth,
      reset: reset
        ? {
            h: Math.round(reset.getBoundingClientRect().height),
            top: Math.round(reset.getBoundingClientRect().top),
            right: Math.round(reset.getBoundingClientRect().right),
            bg: cs(reset).backgroundColor,
            fg: cs(reset).color,
            text: reset.textContent,
          }
        : null,
      apply: apply
        ? {
            h: Math.round(apply.getBoundingClientRect().height),
            top: Math.round(apply.getBoundingClientRect().top),
            right: Math.round(apply.getBoundingClientRect().right),
          }
        : null,
      dialogTop: Math.round(dialog.getBoundingClientRect().top),
      dialogRight: Math.round(dialog.getBoundingClientRect().right),
      footer: document.querySelector('.pd-engine-tab-foot') !== null,
      descriptionsInline: document.querySelectorAll('.pd-flag-desc').length,
      nativeSelects: document.querySelectorAll('.pd-adv-panel select').length,
    };
  });
  console.log('header:', JSON.stringify(head));
  check(head.tabsBorder === '0px', `no line under the header/tabs (${head.tabsBorder})`);
  check(head.reset?.text === 'Reset', `the reset button says Reset (${head.reset?.text})`);
  check(
    head.reset !== null && head.reset.h === head.apply?.h,
    'Reset and Apply are the same height',
  );
  check(
    head.apply !== null && head.apply.top - head.dialogTop < 40,
    'Apply sits at the top of the dialog',
  );
  check(head.dialogRight - (head.apply?.right ?? 0) < 80, 'Apply sits at the right of the dialog');
  check(!head.footer, 'no pinned footer');
  check(head.descriptionsInline === 0, `no inline blurbs (${head.descriptionsInline})`);
  check(head.nativeSelects === 0, `no native <select> (${head.nativeSelects})`);

  // 2. Knob rows: real names, ⓘ, the default as the value (not a placeholder).
  const knobs = await win.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid^="engine-knob-"]:not([data-testid*="input"]):not([data-testid*="info"])',
      ),
    ].map((r) => ({
      name: r.querySelector('.pd-flag-name')?.textContent,
      info: r.querySelector('.pd-info-dot') !== null,
      value:
        r.querySelector('input, [role="combobox"]')?.value ??
        r.querySelector('[role="combobox"]')?.textContent,
      placeholder: r.querySelector('input')?.placeholder ?? '',
      flag: r.getAttribute('data-flag'),
    })),
  );
  console.log('knobs:', JSON.stringify(knobs));
  for (const k of knobs) {
    check(k.info, `${k.name}: has an ⓘ`);
    check(
      !/default/i.test(k.placeholder),
      `${k.name}: no "default" placeholder (${k.placeholder})`,
    );
  }
  await shot(win, '01-engine');

  // 3. ⓘ hover shows the blurb.
  await win.hover('[data-testid="engine-knob-info-context"]');
  await win.waitForTimeout(400);
  const tip = await win.evaluate(() => document.querySelector('.pd-tooltip')?.textContent ?? null);
  console.log('tooltip:', tip);
  check(tip !== null && tip.length > 20, 'the ⓘ shows the blurb on hover');
  await shot(win, '02-info');
  await win.mouse.move(5, 5);

  // 4. The Flags tab: search on top; rows have names, not flags; defaults filled.
  const size1 = await dialogBox(win);
  await win.click('[data-testid="advanced-tab-flags"]');
  await win.waitForSelector('[data-testid="engine-flags-search"]', { timeout: 15000 });
  await win.waitForSelector('[data-testid="engine-flags-popular"]', { timeout: 30000 });
  await win.waitForTimeout(400);
  const flagsTab = await win.evaluate(() => {
    const search = document.querySelector('[data-testid="engine-flags-search"]');
    const body = document.querySelector('.pd-adv-panel .pd-dialog-body');
    const rows = [...document.querySelectorAll('[data-testid="engine-flags-popular"] .pd-flag-row')]
      .slice(0, 6)
      .map((r) => ({
        name: r.querySelector('.pd-flag-name')?.textContent,
        value:
          r.querySelector('input')?.value ??
          r.querySelector('[role="combobox"]')?.textContent ??
          '(switch)',
        placeholder: r.querySelector('input')?.placeholder ?? '',
      }));
    return {
      searchTop: Math.round(search.getBoundingClientRect().top - body.getBoundingClientRect().top),
      rows,
      literalFlagNames: [...document.querySelectorAll('.pd-flag-name')].filter((n) =>
        /^-/.test(n.textContent ?? ''),
      ).length,
    };
  });
  console.log('flags tab:', JSON.stringify(flagsTab));
  check(
    flagsTab.searchTop < 30,
    `the search sits at the top of the Flags tab (${flagsTab.searchTop}px)`,
  );
  check(
    flagsTab.literalFlagNames === 0,
    `no row named by its literal flag (${flagsTab.literalFlagNames})`,
  );
  for (const r of flagsTab.rows)
    check(!/default/i.test(r.placeholder), `${r.name}: default is a value, not a placeholder`);
  const size2 = await dialogBox(win);
  check(
    size1?.w === size2?.w && size1?.h === size2?.h,
    `the popup keeps its size across tabs (${JSON.stringify(size1)} vs ${JSON.stringify(size2)})`,
  );
  await shot(win, '03-flags');

  // 5. Scroll to the bottom: the last group's bottom is inside the body.
  const bottom = await win.evaluate(() => {
    const body = document.querySelector('.pd-adv-panel .pd-dialog-body');
    body.scrollTop = body.scrollHeight;
    const groups = [...document.querySelectorAll('[data-testid^="engine-flags-group-"]')];
    const last = groups[groups.length - 1];
    return new Promise((r) =>
      requestAnimationFrame(() =>
        r({
          lastTitle: last?.querySelector('.pd-flags-group-title')?.textContent,
          lastBottom: Math.round(last.getBoundingClientRect().bottom),
          bodyBottom: Math.round(body.getBoundingClientRect().bottom),
        }),
      ),
    );
  });
  console.log('bottom:', JSON.stringify(bottom));
  check(
    bottom.lastBottom <= bottom.bodyBottom,
    `"${bottom.lastTitle}" is not cut off (${bottom.lastBottom} vs ${bottom.bodyBottom})`,
  );
  await shot(win, '04-flags-bottom');

  // 6. The other tabs keep the size too.
  for (const t of ['sampling', 'context']) {
    await win.click(`[data-testid="advanced-tab-${t}"]`);
    await win.waitForTimeout(300);
    const sz = await dialogBox(win);
    check(sz?.w === size1?.w && sz?.h === size1?.h, `${t}: same size (${JSON.stringify(sz)})`);
  }
  await shot(win, '05-sampling-or-context');

  // 7. Light mode: Reset is the opposite colours.
  await win.click('[data-testid="advanced-tab-engine"]');
  await win.evaluate(() => {
    document.documentElement.setAttribute('data-mode', 'light');
  });
  await win.waitForTimeout(500);
  const light = await win.evaluate(() => {
    const reset = document.querySelector('[data-testid="engine-settings-reset"]');
    return { bg: getComputedStyle(reset).backgroundColor, fg: getComputedStyle(reset).color };
  });
  console.log('reset dark:', head.reset?.bg, head.reset?.fg, 'light:', JSON.stringify(light));
  await shot(win, '06-light');
  console.log('shots in', SHOT_DIR);
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'advanced-panel-look OK' : `FAILED: ${failures.length}`);
