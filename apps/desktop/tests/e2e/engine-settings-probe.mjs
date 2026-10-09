/**
 * ADVANCED → ENGINE, and calibration per model — headless, real app, real cache.
 *
 * The user: "calibration is per model, so if I switch to minicpm 5-2b from the
 * default qwen model, calibration should be an option again, switching back
 * to a ready calibrated model however should have its config cached and
 * should load with the calibrated optimal config" and "expand the advanced
 * settings top right button to expose absolutely everything … a pinned apply
 * button that restarts the server … a tab for also just pasting args … a tab
 * for speculative".
 *
 * Proves: (1) the calibrated model comes up on its verdict, the uncalibrated
 * one says so and offers Calibrate; (2) the Engine tab lists the pinned
 * build's own flags, categorised, with a Popular group; (3) Apply is grey
 * until a flag changes, restarts the server, and the flag is on the running
 * command line; (4) the Speculative bar offers only what the model has;
 * (5) a pasted command becomes rows.
 *
 *   SHOT_DIR=/tmp/engset node apps/desktop/tests/e2e/engine-settings-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const CALIBRATED = process.env.CALIBRATED ?? 'qwen3.5-4b-mtp';
const OTHER = process.env.OTHER ?? 'minicpm5-2b';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'engset');
mkdirSync(SHOT_DIR, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const home = probeHome('engine-settings');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    toolInterface: 'bash-cli',
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: CALIBRATED },
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
const mainLog = [];
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'engset-udd-'))}`],
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
const onLog = (d) => {
  for (const line of String(d).split('\n')) if (line.trim() !== '') mainLog.push(line);
};
app.process().stdout?.on('data', onLog);
app.process().stderr?.on('data', onLog);

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(1500);
  const status = () => win.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));
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
    await win.waitForTimeout(800);
    return status();
  };

  // 1. The calibrated model comes up on its verdict; the other one is uncalibrated.
  const s1 = await start(CALIBRATED);
  log(
    `${CALIBRATED}: engine=${s1.profile?.engine} spec=${s1.profile?.spec} fingerprint=${s1.launchConfigFingerprint}`,
  );
  const rec = await win.evaluate(
    (m) => window.piDesktop.invoke('llm:calibration-record', { modelId: m }),
    CALIBRATED,
  );
  check(rec.record !== null, `${CALIBRATED} has a stored calibration`);
  check(
    rec.record !== null && s1.profile?.engine === rec.record.chosen?.engine,
    `it came up on the calibrated engine (${s1.profile?.engine} vs ${rec.record?.chosen?.engine})`,
  );
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  const menuBtn = win.locator('[data-testid="engine-menu-button"]');
  await menuBtn.click();
  await win.waitForSelector('[data-testid="engine-menu"]', { timeout: 5000 });
  await win.waitForTimeout(500);
  const m1 = await win.evaluate(() => ({
    calibrate: document.querySelector('[data-testid="engine-calibrate"]')?.textContent,
    uncal: document.querySelector('[data-testid="engine-menu-uncalibrated"]')?.textContent ?? null,
    section: document.querySelector('[data-testid="engine-calibration"]') !== null,
  }));
  log('menu on calibrated model:', JSON.stringify(m1));
  check(
    m1.calibrate === 'Recalibrate' && m1.section && m1.uncal === null,
    'calibrated model: Recalibrate + verdict shown',
  );
  writeFileSync(path.join(SHOT_DIR, '01-menu-calibrated.png'), await win.screenshot());
  await win.keyboard.press('Escape');

  const s2 = await start(OTHER);
  log(`${OTHER}: engine=${s2.profile?.engine} spec=${s2.profile?.spec}`);
  await menuBtn.click();
  await win.waitForSelector('[data-testid="engine-menu"]', { timeout: 5000 });
  await win.waitForTimeout(500);
  const m2 = await win.evaluate(() => ({
    calibrate: document.querySelector('[data-testid="engine-calibrate"]')?.textContent,
    disabled: document.querySelector('[data-testid="engine-calibrate"]')?.disabled,
    uncal: document.querySelector('[data-testid="engine-menu-uncalibrated"]')?.textContent ?? null,
    section: document.querySelector('[data-testid="engine-calibration"]') !== null,
  }));
  log('menu on other model:', JSON.stringify(m2));
  // Per model: whatever the other model's verdict says, THIS one shows its own
  // state — either its own record (Recalibrate + its rows) or "not calibrated
  // yet" with Calibrate live. The user calibrated MiniCPM5 themselves on 2026-09-12,
  // so on their cache the first branch is the one that runs.
  const otherRec = await win.evaluate(
    (m) => window.piDesktop.invoke('llm:calibration-record', { modelId: m }),
    OTHER,
  );
  check(
    otherRec.record === null
      ? m2.calibrate === 'Calibrate' && m2.disabled === false && m2.uncal !== null && !m2.section
      : m2.calibrate === 'Recalibrate' && m2.section && m2.uncal === null,
    `the other model shows its OWN calibration state (record: ${otherRec.record === null ? 'none' : otherRec.record.chosen?.engine})`,
  );
  check(
    otherRec.record === null || otherRec.record.modelId === OTHER,
    'a record shown for the other model is that model’s, not the first one’s',
  );
  writeFileSync(path.join(SHOT_DIR, '02-menu-uncalibrated.png'), await win.screenshot());
  await win.keyboard.press('Escape');

  // 2. The Engine tab.
  await win.locator('[data-testid="advanced-params-toggle"]').click();
  await win.waitForSelector('[data-testid="engine-settings-tab"]', { timeout: 10000 });
  // The flags live on their own tab now (the user: "a separate tab for Flags").
  await win.locator('[data-testid="advanced-tab-flags"]').click();
  await win.waitForFunction(
    () => document.querySelectorAll('.pd-flag-row[data-testid^="flag-"]').length > 10,
    undefined,
    { timeout: 60000 },
  );
  await win.waitForTimeout(500);
  const t1 = await win.evaluate(() => ({
    engine: document.querySelector('[data-testid="engine-flags-engine"]')?.textContent?.trim(),
    popular: document.querySelectorAll(
      '[data-testid="engine-flags-popular"] .pd-flag-row[data-testid^="flag-"]',
    ).length,
    groups: [...document.querySelectorAll('[data-testid^="engine-flags-group-"]')].map((g) =>
      g.textContent?.replace(/\s+/g, ' ').slice(0, 40),
    ),
    search: document.querySelector('[data-testid="engine-flags-search"]')?.placeholder,
    apply: document.querySelector('[data-testid="engine-settings-apply"]')?.disabled,
    dirty: document.querySelector('[data-testid="engine-settings-note"]')?.textContent,
  }));
  log('engine tab:', JSON.stringify(t1));
  check(/^llama\.cpp/.test(t1.engine ?? ''), `the running engine is selected (${t1.engine})`);
  check(t1.popular >= 10, `the Popular group lists the common flags (${t1.popular})`);
  check(
    /Search \d{3} settings/.test(t1.search ?? ''),
    `the search box counts the build's flags (${t1.search})`,
  );
  check(t1.apply === true, 'Apply is grey with nothing changed');
  writeFileSync(path.join(SHOT_DIR, '03-engine-settings.png'), await win.screenshot());

  // Change a popular flag: reasoning budget → 512.
  const budget = win.locator('[data-testid="flag---reasoning-budget"] input');
  await budget.fill('512');
  await win.waitForTimeout(300);
  const t2 = await win.evaluate(() => ({
    apply: document.querySelector('[data-testid="engine-settings-apply"]')?.disabled,
    dirty: document.querySelector('[data-testid="engine-settings-note"]')?.textContent,
    setCount: document.querySelector('[data-testid="engine-flags-set-count"]')?.textContent,
  }));
  log('after edit:', JSON.stringify(t2));
  check(t2.apply === false, 'Apply lights up after a change');
  writeFileSync(path.join(SHOT_DIR, '04-engine-settings-dirty.png'), await win.screenshot());

  // Search filters.
  await win.locator('[data-testid="engine-flags-search"]').fill('cache-type');
  await win.waitForTimeout(300);
  const t3 = await win.evaluate(() =>
    [...document.querySelectorAll('.pd-flag-row[data-testid^="flag-"]')].map((r) =>
      r.dataset.testid.slice(5),
    ),
  );
  log('search cache-type →', JSON.stringify(t3));
  // Matches on any spelling: `--spec-draft-type-k` is also `--cache-type-k-draft`.
  check(
    t3.includes('--cache-type-k') && t3.length < 12,
    `search narrows to matching flags (${t3.length})`,
  );
  await win.locator('[data-testid="engine-flags-search"]').fill('');

  // 3. Apply → restart → the flag is on the running command line.
  await win.locator('[data-testid="engine-settings-apply"]').click();
  await win.waitForFunction(
    () =>
      /Restarted|failed/.test(
        document.querySelector('[data-testid="engine-settings-note"]')?.textContent ?? '',
      ),
    undefined,
    { timeout: 180_000 },
  );
  const s3 = await status();
  const argv = s3.launchArgs ?? [];
  const idx = argv.lastIndexOf('--reasoning-budget');
  log(
    'after apply:',
    JSON.stringify({ phase: s3.phase, budget: argv[idx + 1], fp: s3.launchConfigFingerprint }),
  );
  check(idx >= 0 && argv[idx + 1] === '512', 'the running server carries --reasoning-budget 512');
  const t4 = await win.evaluate(() => ({
    apply: document.querySelector('[data-testid="engine-settings-apply"]')?.disabled,
    dirty: document.querySelector('[data-testid="engine-settings-note"]')?.textContent,
  }));
  check(t4.apply === true, `Apply is grey again after the restart (${t4.dirty})`);
  await win.locator('[data-testid="advanced-tab-engine"]').click();
  await win.waitForTimeout(200);
  await win.locator('[data-testid="engine-subtab-running"]').click();
  await win.waitForTimeout(300);
  const runningText = await win.evaluate(
    () => document.querySelector('[data-testid="running-tab"] pre')?.textContent ?? '',
  );
  check(
    /--reasoning-budget 512/.test(runningText),
    'the Running now tab shows the command line with the flag',
  );
  writeFileSync(path.join(SHOT_DIR, '05-running-now.png'), await win.screenshot());

  // 4. Speculative.
  await win.locator('[data-testid="engine-subtab-speculative"]').click();
  await win.waitForSelector('[data-testid="speculative-tab"]', { timeout: 5000 });
  await win.waitForTimeout(300);
  const sp = await win.evaluate(() => ({
    chips: [...document.querySelectorAll('[data-testid^="spec-method-"]')]
      .filter((b) => b.tagName === 'BUTTON')
      .map((b) => ({
        id: b.dataset.testid.replace('spec-method-', ''),
        on: b.getAttribute('aria-pressed'),
        disabled: b.disabled,
        ready: b.dataset.ready,
        text: b.textContent?.slice(0, 30),
      })),
    drafts: document.querySelectorAll('[data-testid="speculative-tab"] [data-testid^="flag-"]')
      .length,
  }));
  log('speculative:', JSON.stringify(sp));
  check(sp.chips.find((c) => c.id === 'custom')?.disabled === false, 'Custom is always offered');
  check(sp.drafts > 15, `draft settings list the build's spec flags (${sp.drafts})`);
  writeFileSync(path.join(SHOT_DIR, '06-speculative.png'), await win.screenshot());
  await win.locator('[data-testid="spec-method-custom"]').click();
  await win.waitForSelector('[data-testid="custom-draft-picker"]', { timeout: 5000 });
  await win.waitForTimeout(600);
  const picker = await win.evaluate(() => ({
    local: document.querySelectorAll('[data-testid^="custom-draft-local-"]').length,
  }));
  log('custom picker:', JSON.stringify(picker));
  check(picker.local > 0, 'the Downloaded list offers local GGUFs');
  writeFileSync(path.join(SHOT_DIR, '07-custom-draft.png'), await win.screenshot());

  // 5. Paste a command.
  await win.locator('[data-testid="engine-subtab-command"]').click();
  await win
    .locator('[data-testid="command-text"]')
    .fill('llama-server -m x.gguf -c 8192 --jinja --port 9 --mystery 1 --temp=0.7');
  await win.locator('[data-testid="command-parse"]').click();
  await win.waitForTimeout(300);
  const cmd = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="command-rows"] label')].map((l) => ({
      flag: l.querySelector('code')?.textContent,
      managed: l.dataset.managed,
      checked: l.querySelector('input')?.checked,
    })),
  );
  log('command rows:', JSON.stringify(cmd));
  check(cmd.length === 6, `six rows parsed (${cmd.length})`);
  check(
    cmd.find((r) => r.flag === '--model')?.managed === 'refused' &&
      cmd.find((r) => r.flag === '--model')?.checked === false,
    '-m is refused and unticked',
  );
  check(
    cmd.find((r) => r.flag === '--ctx-size')?.managed === 'override',
    '-c is marked as replacing Bobble’s value',
  );
  writeFileSync(path.join(SHOT_DIR, '08-command.png'), await win.screenshot());

  // 6. Back to the calibrated model: its verdict still loads it.
  await win.keyboard.press('Escape');
  const s4 = await start(CALIBRATED);
  log(`back to ${CALIBRATED}: engine=${s4.profile?.engine} spec=${s4.profile?.spec}`);
  check(
    s4.profile?.engine === rec.record?.chosen?.engine,
    'switching back loads the calibrated config',
  );
} finally {
  writeFileSync(path.join(SHOT_DIR, 'main.log'), mainLog.join('\n'));
  await app.close().catch(() => undefined);
  if (failures.length > 0) console.error(`engine-settings-probe: ${failures.length} failure(s)`);
  else console.log('engine-settings-probe OK');
  console.log(`shots → ${SHOT_DIR}`);
}
