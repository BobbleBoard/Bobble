/**
 * ROUND 3 — SWAPPING EFFORT, AND SEEING THE DESIRED BEHAVIOUR.
 *
 * the user: "model + harness competence: swapping effort and seeing the desired
 * behavior."
 *
 * The effort table is unit-tested — the knobs are monotone, the REAL verify
 * turns on at high — and none of that says the slider does anything. Effort
 * reaches the harness ONLY through a slash command fired after the settings
 * write (see settings-store.update), the harness re-derives its tool set from
 * it, and the app decides Adaptive effort per message. Three places to lose it.
 *
 * So this drives REAL pi — mock-pi does not load the harness extension, which
 * is the whole subject here — and reads the harness's OWN published status back
 * out of the renderer store.
 *
 *   1  every level set from the UI reaches the running harness
 *   2  Adaptive is a mode, not a level: the harness always holds a real one
 *   3  the ADVERTISED TOOL SET does not change with effort — that is the
 *      design ("one prompt, one tool list, every effort"), and a tool that
 *      comes and goes cannot be planned around
 *   4  …including talk_to_manager, whose prompt line used to claim high/max
 *   5  the levels round-trip: down as well as up, and back again
 *   6  a level survives the settings write (it is what the next launch loads)
 *
 * No model is loaded and no turn is sent: this is about the harness's
 * configuration, and a real generation would make it a twenty-minute test of
 * something else.
 *
 * Run `npm run build` first.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

/*
 * A THROWAWAY HOME POINTED AT THE REAL MODEL CACHE.
 *
 * Isolated chats and settings — a probe must not add rows to anyone's sidebar
 * — but the actual downloaded weights, because the tool set is only derived
 * once a real message has been classified, and classification needs a model
 * that exists. `PI_DESKTOP_CACHE_DIR` is the documented override for exactly
 * this split (see @pi-desktop/inference paths.ts).
 */
const home = mkdtempSync(path.join(tmpdir(), 'pd-effort-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
const realCache = path.join(homedir(), '.cache', 'pi-desktop');

/** Smallest downloaded model that can classify + answer "hi". */
const MODEL = process.env.MODEL ?? 'gemma-4-e2b-it';
if (!existsSync(path.join(realCache, 'models', MODEL))) {
  console.log(`effort-probe: SKIP — ${MODEL} is not downloaded`);
  process.exit(0);
}

const { page, check, finish, shot, shotDir } = await launchApp('effort-probe', {
  // REAL pi: `PI_BIN: undefined` overrides the harness's mock default. The
  // harness extension only exists in the real binary.
  env: {
    HOME: home,
    PI_BIN: undefined,
    MOCK_PI_FIXTURE: undefined,
    PI_DESKTOP_CACHE_DIR: realCache,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
  },
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
});

/** The harness's own published status, as the renderer holds it. */
const harnessStatus = () =>
  page.evaluate(() => {
    const raw = window.__pi_store().getState().extensionStatus?.harness;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

/** Set the effort the way the app does, then wait for the harness to agree. */
const setEffort = async (level) => {
  await page.evaluate(
    ([l]) => window.__settings_store().getState().update({ effort: l, effortMode: 'manual' }),
    [level],
  );
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const s = await harnessStatus();
    if (s?.effort === level) return s;
    await page.waitForTimeout(200);
  }
  return await harnessStatus();
};

try {
  await page.waitForFunction(() => typeof window.__settings_store === 'function', {
    timeout: 30_000,
  });

  // The harness publishes on session start; without it there is nothing to read
  // and every assertion below would be vacuous.
  const ready = await page
    .waitForFunction(
      () => typeof window.__pi_store().getState().extensionStatus?.harness === 'string',
      { timeout: 90_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(ready, 'the harness never published a status — is this real pi?');
  if (!ready) throw new Error('no harness');

  const first = await harnessStatus();
  console.log(`   harness up: effort=${first?.effort} tools=${first?.activeTools?.length ?? '?'}`);

  /*
   * ONE REAL MESSAGE FIRST.
   *
   * `activeTools` is empty until a prompt has been CLASSIFIED — the harness
   * derives the advertised set per message, which is the behaviour under test
   * and the reason a status read before any turn says nothing. So: pick the
   * model, send something trivial, let the turn finish, and only then ask what
   * effort does to the tool list.
   */
  await page.evaluate(
    ([id]) =>
      window
        .__settings_store()
        .getState()
        .update({
          modelSelection: { mode: 'model', modelId: id },
        }),
    [MODEL],
  );
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });
  await page.click('.pd-composer-editor');
  await page.keyboard.type('say hi');
  await page.keyboard.press('Enter');
  const answered = await page
    .waitForFunction(
      () => {
        const ms = window.__pi_store().getState().messages ?? [];
        return ms.some((m) => m.kind === 'assistant') && !ms.some((m) => m.isStreaming === true);
      },
      { timeout: 300_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(answered, 'the model never answered — no classification, so no tool set to compare');
  const classified = await harnessStatus();
  console.log(
    `   after one turn: class=${classified?.activeClass} tools=${classified?.activeTools?.length ?? 0}`,
  );

  /* ------------------------------------------- 1, 3, 4 each level, and the tools */
  const seen = [];
  for (const level of ['low', 'medium', 'high', 'max']) {
    const s = await setEffort(level);
    check(s?.effort === level, `setting effort to ${level} left the harness at ${s?.effort}`);
    const tools = [...(s?.activeTools ?? [])].sort();
    seen.push({ level, tools });
    console.log(`   ${level}: ${tools.length} tools`);
  }

  const baseline = seen[0];
  for (const s of seen.slice(1)) {
    const added = s.tools.filter((t) => !baseline.tools.includes(t));
    const gone = baseline.tools.filter((t) => !s.tools.includes(t));
    check(
      added.length === 0 && gone.length === 0,
      `the tool set changed between low and ${s.level}: +${JSON.stringify(added)} -${JSON.stringify(gone)}`,
    );
  }
  check(
    baseline.tools.length > 5,
    `only ${baseline.tools.length} tools advertised at low effort: ${JSON.stringify(baseline.tools)}`,
  );
  // The corporation is reachable at EVERY level — the gate was removed, and the
  // prompt line that still claimed otherwise was a lie the model read.
  const hasManager = baseline.tools.some((t) => /manager|hierarchy/i.test(t));
  console.log(`   talk_to_manager advertised at low effort: ${hasManager}`);
  check(hasManager, 'talk_to_manager is not advertised at low effort — the gate is back');

  /* ------------------------------------------------ 5 down again, and back up */
  const down = await setEffort('low');
  check(down?.effort === 'low', `effort would not come back DOWN (${down?.effort})`);
  const up = await setEffort('high');
  check(up?.effort === 'high', `effort would not go back up (${up?.effort})`);

  /* ---------------------------------------------------- 2 Adaptive is a MODE */
  await page.evaluate(() => window.__settings_store().getState().update({ effortMode: 'auto' }));
  await page.waitForTimeout(1500);
  const adaptive = await harnessStatus();
  check(
    ['low', 'medium', 'high', 'max'].includes(adaptive?.effort),
    `under Adaptive the harness holds "${adaptive?.effort}", which is not a level it can act on`,
  );

  /* ------------------------------------------------------ 6 …and it persists */
  await page.evaluate(() =>
    window.__settings_store().getState().update({ effort: 'max', effortMode: 'manual' }),
  );
  await page.waitForTimeout(800);
  const persisted = await page.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
  check(
    persisted?.effort === 'max',
    `the effort the harness is running is not what was written (${persisted?.effort})`,
  );

  await shot('1-effort');
  console.log(`shots: ${shotDir}`);
} finally {
  await finish();
}
