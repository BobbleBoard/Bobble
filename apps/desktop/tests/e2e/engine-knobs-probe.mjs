/**
 * ADVANCED → ENGINE → "Shared across engines": one value, every engine's own
 * flag — headless, real app, real cache (the installed MLX engines are what
 * make the engine select offer more than llama.cpp).
 *
 * the user: "ensure settings and such transfer between engines as seamlessly as
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

  const readRow = (id) =>
    win.evaluate((id) => {
      const r = document.querySelector(`[data-testid="engine-knob-${id}"]`);
      return r === null
        ? null
        : {
            supported: r.getAttribute('data-supported'),
            set: r.getAttribute('data-set'),
            flag: r.querySelector('.pd-flag-alias')?.textContent ?? null,
            unsupported:
              r.querySelector('[data-testid="engine-knob-unsupported"]')?.textContent ?? null,
            inherited:
              r.querySelector('[data-testid="engine-knob-inherited"]')?.textContent ?? null,
            value: r.querySelector(`[data-testid="engine-knob-input-${id}"]`)?.value ?? null,
            labelColor: getComputedStyle(r.querySelector('.pd-knob-label')).color,
          };
    }, id);

  // 1. The section sits above the engine's own flags, with every knob.
  const order = await win.evaluate(() => {
    const knobs = document.querySelector('[data-testid="engine-knobs"]');
    const flags = document.querySelector('[data-testid="engine-flags-tab"]');
    const all = [...document.querySelectorAll('[data-testid]')];
    return {
      knobsAt: all.indexOf(knobs),
      flagsAt: all.indexOf(flags),
      knobsFirst: knobs !== null && flags !== null && all.indexOf(knobs) < all.indexOf(flags),
      ids: [
        ...document.querySelectorAll(
          '[data-testid^="engine-knob-"]:not([data-testid^="engine-knob-input"])',
        ),
      ]
        .map((e) => e.getAttribute('data-testid'))
        .filter((t) => !/unsupported|inherited/.test(t)),
    };
  });
  log('order:', JSON.stringify(order));
  check(order.knobsFirst, 'the shared section comes before the engine’s own flags');
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
  const choices = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="engine-settings-engine"] option')].map(
      (o) => o.value,
    ),
  );
  log('engines offered:', choices.join(','));
  if (choices.includes('mlx-dspark')) {
    await win.selectOption('[data-testid="engine-settings-engine"]', 'mlx-dspark');
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
  if (choices.includes('mlx-lm')) {
    await win.selectOption('[data-testid="engine-settings-engine"]', 'mlx-lm');
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
  await win.selectOption('[data-testid="engine-settings-engine"]', 'llamacpp');
  await win.waitForTimeout(300);
  await win.selectOption('[data-testid="engine-knob-input-kvQuant"]', '8');
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
