/**
 * ADVANCED → ENGINE → "Shared across engines": one value, every engine's own
 * flag — headless, real app, real cache (the installed MLX engines are what
 * make the engine select offer more than llama.cpp).
 *
 * The user: "ensure settings and such transfer between engines as seamlessly as
 * possible and are removed/greyed out if unsupported by engine, keeping
 * preferences saved."
 *
 * Proves: (1) the section lists the knobs above the engine's own flags;
 * (2) a context window typed once is shown as `--ctx-size` on llama.cpp and
 * `--context-window` on mlx-dspark, and greyed "not on mlx-lm" there while
 * the value stays; (3) Save persists `portableKnobs` and the supervisor's
 * effective config for each engine carries the spelled flag (the same pure
 * function both sides use, exercised through the saved settings);
 * (4) a `--ctx-size` the user set on llama.cpp's own flags is read back as
 * "from llama.cpp" on another engine when no knob is set.
 *
 *   SHOT_DIR=/tmp/knobs node apps/desktop/tests/e2e/engine-knobs-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'knobs');
mkdirSync(SHOT_DIR, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const home = probeHome('engine-knobs');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    toolInterface: 'bash-cli',
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: MODEL },
    // A flag set the old way on llama.cpp alone: the knob has to read it back.
    engineLaunch: { llamacpp: { flags: { '--parallel': 3 }, rawArgs: [] } },
  }),
);
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'knobs-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const shot = async (win, name) =>
  writeFileSync(path.join(SHOT_DIR, `${name}.png`), await win.screenshot());
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(1500);
  await win.locator('[data-testid="advanced-params-toggle"]').click();
  await win.waitForSelector('[data-testid="engine-settings-tab"]', { timeout: 10000 });
  await win.waitForSelector('[data-testid="engine-knobs"]', { timeout: 10000 });
  await win.waitForTimeout(400);

  /** Pick an option in the app's own dropdown (Radix Select): open, click the row. */
  const pick = async (triggerTestId, optionText) => {
    await win.click(`[data-testid="${triggerTestId}"]`);
    await win.waitForSelector('[role="option"]', { timeout: 5000 });
    await win.locator('[role="option"]', { hasText: optionText }).first().click();
    await win.waitForTimeout(300);
  };
  const readRow = (id) =>
    win.evaluate((id) => {
      const r = document.querySelector(`[data-testid="engine-knob-${id}"]`);
      return r === null
        ? null
        : {
            supported: r.getAttribute('data-supported'),
            set: r.getAttribute('data-set'),
            flag: r.getAttribute('data-flag'),
            unsupported:
              r.querySelector('[data-testid="engine-knob-unsupported"]')?.textContent ?? null,
            inherited:
              r.querySelector('[data-testid="engine-knob-inherited"]')?.textContent ?? null,
            value: r.querySelector(`[data-testid="engine-knob-input-${id}"]`)?.value ?? null,
            labelColor: getComputedStyle(r.querySelector('.pd-knob-label')).color,
          };
    }, id);

  // 1. The section is the Engine tab's Settings, with every knob (the
  //    engine's own flags have their own tab now).
  const order = await win.evaluate(() => {
    const knobs = document.querySelector('[data-testid="engine-knobs"]');
    const flagsTab = document.querySelector('[data-testid="advanced-tab-flags"]');
    return {
      knobsFirst: knobs !== null && flagsTab !== null,
      ids: [
        ...document.querySelectorAll(
          '[data-testid^="engine-knob-"]:not([data-testid^="engine-knob-input"])',
        ),
      ]
        .map((e) => e.getAttribute('data-testid'))
        .filter((t) => !/unsupported|inherited|info/.test(t)),
    };
  });
  log('order:', JSON.stringify(order));
  check(order.knobsFirst, 'the shared section is on the Engine tab and Flags has its own tab');
  check(order.ids.length >= 6, `six knobs listed (${order.ids.join(',')})`);

  // 2. llama.cpp: the context knob is spelled --ctx-size; the parallel knob reads
  //    the flag the user had set on llama.cpp ("from llama.cpp" is not shown on
  //    the engine it came from — it is that engine's own flag, so it is
  //    "overridden by --parallel" there instead).
  const ctxLlama = await readRow('context');
  log('llama context:', JSON.stringify(ctxLlama));
  check(
    ctxLlama?.supported === 'yes' && ctxLlama.flag === '--ctx-size',
    `--ctx-size on llama.cpp (${JSON.stringify(ctxLlama)})`,
  );
  await win.fill('[data-testid="engine-knob-input-context"]', '32768');
  await win.waitForTimeout(200);
  const dirty1 = await win.locator('[data-testid="engine-settings-apply"]').isEnabled();
  check(dirty1, 'typing a knob value lights Apply/Save');
  await shot(win, '01-llama-knobs');

  // 3. Switch the engine: the value stays; mlx-dspark spells it --context-window;
  //    mlx-lm has no such flag and says so, greyed.
  await win.click('[data-testid="engine-settings-engine"]');
  await win.waitForSelector('[role="option"]', { timeout: 5000 });
  const choices = await win.evaluate(() =>
    [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? ''),
  );
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  log('engines offered:', choices.join(','));
  if (choices.some((c) => c.startsWith('mlx-dspark'))) {
    await pick('engine-settings-engine', 'mlx-dspark');
    await win.waitForTimeout(500);
    const ctxDspark = await readRow('context');
    const parDspark = await readRow('parallel');
    log('dspark context:', JSON.stringify(ctxDspark), 'parallel:', JSON.stringify(parDspark));
    check(
      ctxDspark?.supported === 'yes' &&
        ctxDspark.flag === '--context-window' &&
        ctxDspark.value === '32768',
      `the same value is --context-window on mlx-dspark (${JSON.stringify(ctxDspark)})`,
    );
    check(
      parDspark?.inherited === 'from llama.cpp' &&
        parDspark.value === '3' &&
        parDspark.flag === '--max-batch',
      `a flag set on llama.cpp alone carries to mlx-dspark as --max-batch, marked from llama.cpp (${JSON.stringify(parDspark)})`,
    );
    await shot(win, '02-dspark-knobs');
  } else {
    console.log('mlx-dspark not installed here — its spelling case skipped');
  }
  if (choices.some((c) => c.startsWith('mlx-lm'))) {
    await pick('engine-settings-engine', 'mlx-lm');
    await win.waitForTimeout(500);
    const ctxMlx = await readRow('context');
    const ctxRowLlama = ctxLlama;
    log('mlx-lm context:', JSON.stringify(ctxMlx));
    check(
      ctxMlx?.supported === 'no' &&
        /not on mlx-lm/.test(ctxMlx.unsupported ?? '') &&
        ctxMlx.value === '32768',
      `mlx-lm has no context flag: greyed "not on mlx-lm", value kept (${JSON.stringify(ctxMlx)})`,
    );
    check(
      ctxMlx !== null && ctxRowLlama !== null && ctxMlx.labelColor !== ctxRowLlama.labelColor,
      `the unsupported row is visibly greyed (${ctxMlx?.labelColor} vs ${ctxRowLlama?.labelColor})`,
    );
    await shot(win, '03-mlxlm-greyed');
  }

  // 4. Save: the knob persists, and the effective launch config per engine (the
  //    supervisor's own expansion) carries the spelled flag.
  await pick('engine-settings-engine', 'llama.cpp');
  await pick('engine-knob-input-kvQuant', '8-bit');
  await win.waitForTimeout(200);
  await win.click('[data-testid="engine-settings-apply"]');
  await win.waitForTimeout(1200);
  const saved = await win.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
  log(
    'saved knobs:',
    JSON.stringify(saved.portableKnobs),
    'launch:',
    JSON.stringify(saved.engineLaunch),
  );
  check(
    saved.portableKnobs?.context === 32768 && saved.portableKnobs?.kvQuant === '8',
    `portableKnobs persisted (${JSON.stringify(saved.portableKnobs)})`,
  );
  check(
    saved.engineLaunch?.llamacpp?.flags?.['--parallel'] === 3,
    'the engine’s own flags are untouched by the knobs',
  );
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'engine-knobs-probe OK' : `FAILED: ${failures.length}`);
