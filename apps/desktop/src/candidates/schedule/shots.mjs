/**
 * Headless screenshots of the schedule candidates — and of the shipping screens
 * they are measured against.
 *
 *   MODE=baseline node src/candidates/schedule/shots.mjs   # chat / Scheduled / Models as shipped
 *   node src/candidates/schedule/shots.mjs                  # every candidate × flavor × mode
 *
 * Needs the renderer dev server from vite.candidates.config.mjs on :5311 (or
 * VITE_DEV_SERVER_URL). Built on tests/e2e/harness.mjs, so the window is never
 * shown, $HOME is a throwaway, pi is the mock, and the run FAILS if focus moved.
 *
 * Data is REAL: tasks are created through `tasks:create` (main normalises and
 * persists them in the throwaway home); run records use the TaskRun shape and
 * are handed to the same zustand store the candidates read, through a hook the
 * candidate route exposes only on `?candidates=`.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from '../../../tests/e2e/harness.mjs';
import { AGED_TASK_INDEX, SEED_RUNS, SEED_TASKS } from './seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE ?? 'candidates';
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5311';
const ONLY = process.env.ONLY; // one candidate id, for a quick iteration loop
const STATES = process.env.STATES?.split(','); // e.g. STATES=default for a theme sweep
const EMPTY = process.env.EMPTY === '1'; // no seed: the first-run screen
const THEMES = process.env.THEMES?.split(',') ?? ['bobble-dark', 'bobble-light'];
const OUT = path.join(HERE, 'shots', MODE === 'baseline' ? 'current' : '');
mkdirSync(OUT, { recursive: true });
process.env.SHOT_DIR = OUT;

const WIDE = { width: 1440, height: 900 };
const CONTENT_WIDE = { width: 1168, height: 860 };
const CONTENT_NARROW = { width: 640, height: 760 };

async function setTheme(page, flavor, mode) {
  await page.evaluate(
    ([f, m]) => {
      document.documentElement.setAttribute('data-flavor', f);
      document.documentElement.setAttribute('data-mode', m);
    },
    [flavor, mode],
  );
  await page.waitForTimeout(160);
}

async function seedTasks(page) {
  const ids = [];
  for (const draft of SEED_TASKS) {
    const res = await page.evaluate(
      (task) => window.piDesktop.invoke('tasks:create', { task }),
      draft,
    );
    ids.push(res.task.id);
  }
  // One task pretends to be a week old, so a slot that passed with nobody home
  // can show as MISSED. `tasks:update` normalises whatever it is handed.
  const aged = ids[AGED_TASK_INDEX];
  if (aged !== undefined) {
    await page.evaluate(
      ([id, createdAt]) => window.piDesktop.invoke('tasks:update', { id, patch: { createdAt } }),
      [aged, Date.now() - 8 * 86_400_000],
    );
  }
  return ids;
}

/** Runs keyed by SEED index → keyed by the real ids main handed back. */
function runsFor(ids) {
  const now = Date.now();
  const out = {};
  ids.forEach((id, i) => {
    const runs = SEED_RUNS[i];
    if (runs === undefined) return;
    out[id] = runs(now).map((r) => ({ ...r, taskId: id }));
  });
  return out;
}

/**
 * A crashed probe must still close its app — an orphaned hidden Electron keeps
 * the mock pi, the port and the RAM, and the NEXT run hangs on page load.
 */
async function guarded(launch, body) {
  const ctx = await launch();
  try {
    await body(ctx);
  } finally {
    await ctx.finish();
  }
}

async function baseline() {
  await guarded(
    () => launchApp('cand-baseline', { env: { VITE_DEV_SERVER_URL: DEV_URL } }),
    baselineBody,
  );
}

async function baselineBody({ page, shot }) {
  await page.setViewportSize(WIDE);
  await page.waitForTimeout(600);
  await setTheme(page, 'bobble', 'dark');
  await shot('chat-bobble-dark');

  await page.click('[data-testid="nav-scheduled"]');
  await page.waitForSelector('[data-testid="scheduled-view"]', { timeout: 8000 });
  await page.waitForTimeout(400);
  await shot('scheduled-empty-bobble-dark');

  await seedTasks(page);
  // The store ignores the echo of its own file write, and the seed bypassed the
  // store — so remount the view to make it re-read the file.
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForSelector('[data-testid="models-view"]', { timeout: 8000 });
  await page.click('[data-testid="nav-scheduled"]');
  await page.waitForSelector('[data-testid="tasks-list"]', { timeout: 8000 });
  await page.waitForTimeout(400);
  await shot('scheduled-list-bobble-dark');
  await setTheme(page, 'bobble', 'light');
  await shot('scheduled-list-bobble-light');

  // The dialog and the past-runs drawer, as shipped.
  await page.click('[data-testid="tasks-new"]');
  await page.waitForSelector('[data-testid="task-dialog"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot('scheduled-dialog-bobble-light');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const runsBtn = await page.$('[data-testid^="task-runs-"]');
  if (runsBtn !== null) {
    await runsBtn.click();
    await page.waitForSelector('[data-testid="task-runs"]', { timeout: 5000 });
    await page.waitForTimeout(300);
    await shot('scheduled-runs-drawer-bobble-light');
    await page.keyboard.press('Escape');
    await page.click('[data-testid="task-runs-close"]').catch(() => undefined);
  }

  await setTheme(page, 'bobble', 'dark');
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForSelector('[data-testid="models-view"]', { timeout: 8000 });
  await page.waitForTimeout(900);
  await shot('models-bobble-dark');
  await setTheme(page, 'bobble', 'light');
  await shot('models-bobble-light');

  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 8000 });
  await page.waitForTimeout(600);
  await shot('connectors-bobble-light');
}

async function candidates() {
  await guarded(
    () =>
      launchApp('cand-schedule', {
        env: { VITE_DEV_SERVER_URL: DEV_URL, PI_DESKTOP_CANDIDATES: 'schedule' },
        waitFor: '[data-testid="candidate-shell"]',
      }),
    candidatesBody,
  );
}

async function candidatesBody({ page, shot, check }) {
  // The candidate route has no sidebar, so the viewport IS the content area:
  // 1440 − 272px sidebar wide, and a 900px window with the sidebar open narrow.
  await page.setViewportSize(CONTENT_WIDE);
  await page.waitForTimeout(400);

  const ids = EMPTY ? [] : await seedTasks(page);
  await page.waitForFunction(() => typeof window.__scheduleCandidates?.seedRuns === 'function');
  // Runs BEFORE the reload: once seeded, the candidates skip their own fetch,
  // so the order is what stops an empty disk read landing over the seed.
  await page.evaluate((runs) => window.__scheduleCandidates.seedRuns(runs), runsFor(ids));
  await page.evaluate(() => window.__scheduleCandidates.reload());
  await page.waitForTimeout(400);

  const tabs = await page.$$('[data-testid^="candidate-tab-"]');
  const entries = [];
  for (const t of tabs)
    entries.push((await t.getAttribute('data-testid')).slice('candidate-tab-'.length));
  check(entries.length > 0, 'no candidate tabs rendered');

  for (const id of entries) {
    if (ONLY !== undefined && id !== ONLY) continue;
    await page.click(`[data-testid="candidate-tab-${id}"]`);
    await page.waitForTimeout(350);
    // Each candidate may register its own extra states (a selected task, an
    // open editor) through the same hook, so the probe stays generic.
    const states = await page.evaluate(
      (cid) => window.__scheduleCandidates.states?.(cid) ?? ['default'],
      id,
    );
    for (const theme of THEMES) {
      const [flavor, mode] = theme.split('-');
      await setTheme(page, flavor, mode);
      for (const state of states) {
        if (STATES !== undefined && !STATES.includes(state)) continue;
        await page.evaluate(
          ([cid, s]) => window.__scheduleCandidates.setState?.(cid, s),
          [id, state],
        );
        await page.waitForTimeout(260);
        await shot(`${EMPTY ? 'empty-' : ''}${id}-${state}-${flavor}-${mode}`);
      }
      await page.evaluate((cid) => window.__scheduleCandidates.setState?.(cid, 'default'), id);
    }
    // Narrow window, bobble-dark only — the user resizes.
    await page.setViewportSize(CONTENT_NARROW);
    await setTheme(page, 'bobble', 'dark');
    await page.waitForTimeout(300);
    await shot(`${id}-default-narrow-bobble-dark`);
    await page.setViewportSize(CONTENT_WIDE);
    await page.waitForTimeout(200);
  }
}

if (MODE === 'baseline') await baseline();
else await candidates();
