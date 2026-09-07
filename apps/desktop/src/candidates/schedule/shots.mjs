/**
 * Headless screenshots of the schedule candidates — and of the shipping screens
 * they are measured against.
 *
 *   MODE=baseline node src/candidates/schedule/shots.mjs      # chat / Scheduled / Models as shipped
 *   node src/candidates/schedule/shots.mjs                     # every candidate × flavor × state
 *   EMPTY=1 node src/candidates/schedule/shots.mjs             # the first-run screens
 *   MODE=interactions node src/candidates/schedule/shots.mjs  # Ledger+ touched by a hand (see below)
 *   EMPTY=1 MODE=interactions node src/candidates/schedule/shots.mjs
 *   MODE=chrome node src/candidates/schedule/shots.mjs        # Ledger+ inside the app's own shell
 *   MODE=film node src/candidates/schedule/shots.mjs          # the motion, recorded at real speed
 *   MODE=chat node src/candidates/schedule/shots.mjs          # a task made in the chat, as the chat shows it
 *
 * Needs the renderer dev server from vite.candidates.config.mjs on :5311 (or
 * VITE_DEV_SERVER_URL). Built on tests/e2e/harness.mjs, so the window is never
 * shown, $HOME is a throwaway, pi is the mock, and the run FAILS if focus moved.
 *
 * Data is REAL: tasks are created through `tasks:create` (main normalises and
 * persists them in the throwaway home); run records use the TaskRun shape and
 * are handed to the same zustand store the candidates read, through a hook the
 * candidate route exposes only on `?candidates=`.
 *
 * TIME IS FROZEN in the renderer for the whole run (`Date.now` pinned to the
 * moment the seed was built), so every shot of a run holds the same data — the
 * round-three judge caught the dark and light `ledger-plus-default` disagreeing
 * because the wall clock crossed 9:00 between them. Main's clock is NOT frozen
 * (it cannot be), which is what seed.mjs's HOLD_MS stamp is for. The other
 * flavours (claude, codex) are shot in the SAME run for the same reason: a
 * flavour shot from an earlier run shows an earlier design (round 4 found four
 * of those, two rounds stale).
 *
 * INTERACTIONS: every state shot is a still of a hidden window, so it says
 * nothing about hover, focus, the chips appearing as you type, the pane swap,
 * the two-step delete or the search expanding. `MODE=interactions` drives
 * those with the mouse and keyboard and photographs each one; the file names
 * carry `ix-`. A few carry a measurement too — "the list did not move while
 * typing", "the list did not move when an editor opened" — asserted, not
 * eyeballed.
 *
 * FILM: the stills cannot say whether the motion is any good. `MODE=film`
 * records the window through CDP's screencast — real frames at the
 * compositor's rate, real timestamps, the hidden window painting exactly as
 * a shown one does — and writes each clip as a GIF at recorded speed plus a
 * filmstrip of eight frames labelled with their millisecond offsets, so the
 * curve can be read frame by frame.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from '../../../tests/e2e/harness.mjs';
import { AGED_TASK_INDEX, holdStampFor, SEED_RUNS, SEED_TASKS, withRunsDir } from './seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE ?? 'candidates';
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5311';
const ONLY = process.env.ONLY; // one candidate id, for a quick iteration loop
const STATES = process.env.STATES?.split(','); // e.g. STATES=default for a theme sweep
const EMPTY = process.env.EMPTY === '1'; // no seed: the first-run screen
const THEMES = process.env.THEMES?.split(',') ?? ['bobble-dark', 'bobble-light'];
/** The flavours shot in their default state only, in the same run as THEMES. `FLAVORS=` skips them. */
const FLAVORS =
  process.env.FLAVORS === ''
    ? []
    : (process.env.FLAVORS?.split(',') ?? [
        'claude-dark',
        'claude-light',
        'codex-dark',
        'codex-light',
      ]);
const OUT = path.join(
  HERE,
  'shots',
  MODE === 'baseline' ? 'current' : MODE === 'film' ? 'motion' : '',
);
mkdirSync(OUT, { recursive: true });
process.env.SHOT_DIR = OUT;

const WIDE = { width: 1440, height: 900 };
const WIDE_LAPTOP = { width: 1172, height: 800 }; // a 13" window: the sidebar open leaves 900px
const CONTENT_WIDE = { width: 1168, height: 860 };
const CONTENT_MID = { width: 900, height: 800 }; // the sidebar open in a ~1170px window
const CONTENT_NARROW = { width: 640, height: 760 };

const SHELL_READY = '[data-testid="candidate-shell"]';
const CHROME_READY = '[data-testid="sc-app-chrome"] [data-testid="sc-ledger-plus"]';

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

/**
 * Pin the renderer's clock to `now` for the rest of the run. An init script
 * only applies to navigations after it is added, so the page reloads once —
 * before anything is seeded, so nothing is lost.
 */
async function freezeClock(page, now, ready = SHELL_READY) {
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
  }, now);
  await page.reload();
  await page.waitForSelector(ready, { timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__scheduleCandidates?.seedRuns === 'function');
}

async function seedTasks(page, now) {
  const ids = [];
  for (const [i, draft] of SEED_TASKS.entries()) {
    const res = await page.evaluate(
      (task) => window.piDesktop.invoke('tasks:create', { task }),
      draft,
    );
    ids.push(res.task.id);
    // Stamp it BEFORE the scheduler's next 30s tick can see a task whose slot
    // passed with no lastRunAt and run it for real (through the mock pi),
    // replacing the seeded history mid-shoot. The stamp is HOLD_MS ahead, so
    // a slot that comes round during the shoot cannot fire either.
    const lastRunAt = holdStampFor(i, now);
    if (lastRunAt !== undefined) {
      await page.evaluate(
        ([id, at]) => window.piDesktop.invoke('tasks:update', { id, patch: { lastRunAt: at } }),
        [res.task.id, lastRunAt],
      );
    }
  }
  // One task pretends to be a week old, so a slot that passed with nobody home
  // can show as MISSED. `tasks:update` normalises whatever it is handed.
  const aged = ids[AGED_TASK_INDEX];
  if (aged !== undefined) {
    await page.evaluate(
      ([id, createdAt]) => window.piDesktop.invoke('tasks:update', { id, patch: { createdAt } }),
      [aged, now - 8 * 86_400_000],
    );
  }
  return ids;
}

/** Runs keyed by SEED index → keyed by the real ids main handed back. */
function runsFor(ids, now) {
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

  await seedTasks(page, Date.now());
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

function launchCandidates() {
  return launchApp('cand-schedule', {
    env: { VITE_DEV_SERVER_URL: DEV_URL, PI_DESKTOP_CANDIDATES: 'schedule' },
    waitFor: SHELL_READY,
  });
}

/**
 * The setup every candidate run shares: the run folders and the portrait
 * fixture in the throwaway HOME, the frozen clock, the seed (unless EMPTY),
 * the runs into the store, and the content-area viewport.
 */
async function prepare({ page, home }, { ready = SHELL_READY, viewport = CONTENT_WIDE } = {}) {
  // Seeded run folders live in the throwaway HOME, under the one root the
  // pd-file:// scheme serves for runs — and the portrait run's picture is a
  // real file there, so its thumbnail renders rather than silently 403ing.
  const runsDir = path.join(home, '.pi', 'desktop', 'scheduled-runs');
  mkdirSync(path.join(runsDir, 'task', 'run_h2'), { recursive: true });
  copyFileSync(
    path.join(HERE, 'fixtures', 'portrait.png'),
    path.join(runsDir, 'task', 'run_h2', 'portrait.png'),
  );
  withRunsDir(runsDir);

  const now = Date.now();
  await freezeClock(page, now, ready);

  // The candidate route has no sidebar, so the viewport IS the content area:
  // 1440 − 272px sidebar wide, and a 900px window with the sidebar open narrow.
  // (The chrome mode passes the whole window instead.)
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);

  const ids = EMPTY ? [] : await seedTasks(page, now);
  // Runs BEFORE the reload: once seeded, the candidates skip their own fetch,
  // so the order is what stops an empty disk read landing over the seed.
  await page.evaluate((runs) => window.__scheduleCandidates.seedRuns(runs), runsFor(ids, now));
  await page.evaluate(() => window.__scheduleCandidates.reload());
  await page.waitForTimeout(400);
  return { ids, now };
}

async function candidates() {
  await guarded(launchCandidates, candidatesBody);
}

async function candidatesBody(ctx) {
  const { page, shot, check } = ctx;
  await prepare(ctx);

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
    // open editor) through the same hook, so the probe stays generic — and
    // announces them as a function of the data, so an empty list is never
    // photographed "running".
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
        await page.waitForTimeout(320);
        await shot(`${EMPTY ? 'empty-' : ''}${id}-${state}-${flavor}-${mode}`);
      }
      await page.evaluate((cid) => window.__scheduleCandidates.setState?.(cid, 'default'), id);
    }
    // The other flavours, default state only — in THIS run, under the same
    // frozen clock, so the folder never again holds a flavour shot of a design
    // two rounds old beside a bobble shot of the current one.
    if (!EMPTY && (STATES === undefined || STATES.includes('default'))) {
      for (const theme of FLAVORS) {
        const [flavor, mode] = theme.split('-');
        await setTheme(page, flavor, mode);
        await page.evaluate((cid) => window.__scheduleCandidates.setState?.(cid, 'default'), id);
        await page.waitForTimeout(320);
        await shot(`${id}-default-${flavor}-${mode}`);
      }
    }
    // 900px: the width the brief asks about, and the one a 1170px window with the sidebar open gives.
    await page.setViewportSize(CONTENT_MID);
    await setTheme(page, 'bobble', 'dark');
    await page.waitForTimeout(300);
    await shot(`${EMPTY ? 'empty-' : ''}${id}-default-mid-bobble-dark`);
    // Narrow window, bobble-dark only — the user resizes. Every state, because a
    // stacked layout's detail view is a different screen from its list.
    await page.setViewportSize(CONTENT_NARROW);
    await setTheme(page, 'bobble', 'dark');
    for (const state of states) {
      if (STATES !== undefined && !STATES.includes(state)) continue;
      await page.evaluate(
        ([cid, s]) => window.__scheduleCandidates.setState?.(cid, s),
        [id, state],
      );
      await page.waitForTimeout(320);
      await shot(`${EMPTY ? 'empty-' : ''}${id}-${state}-narrow-bobble-dark`);
    }
    await page.evaluate((cid) => window.__scheduleCandidates.setState?.(cid, 'default'), id);
    await page.setViewportSize(CONTENT_WIDE);
    await page.waitForTimeout(200);
  }
}

/* ---- interactions: Ledger+ touched by a hand -------------------------------- */

async function interactions() {
  await guarded(launchCandidates, interactionsBody);
}

const ID = 'ledger-plus';
const ROW = (name) => `[data-testid^="sc-ledger-row-"]:has-text("${name}")`;
const COMPOSER = '[data-testid="sc-composer-input"]';
const LIST_HEAD = '[data-testid="sc-ledger-search"]';
const PANES = '[data-testid="sc-panes"]';
const SENTENCE = 'every friday at 4pm, write up what I worked on this week';
/** Long enough that nameFrom has to cut it — the guessed-name lead line's case. */
const LONG_SENTENCE =
  'every day at 8am, generate one portrait in the style of a 1970s passport photo of a different animal';

/**
 * Scroll the detail pane to its very end, so the delete footer sits clear of
 * the edge — and PROVE it did: the footer's bottom must be inside the window
 * with the pane's own padding under it, or the pane is taller than the screen.
 */
async function scrollPaneToEnd(page, check, tag) {
  await page.evaluate(() => {
    const footer = document.querySelector('[data-testid="sc-delete-footer"]');
    const viewport = footer?.closest('.pd-scroll');
    if (viewport instanceof HTMLElement) viewport.scrollTop = viewport.scrollHeight;
  });
  await page.waitForTimeout(240);
  const m = await page.evaluate(() => {
    const footer = document.querySelector('[data-testid="sc-delete-footer"]');
    const viewport = footer?.closest('.pd-scroll');
    if (!(footer instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return null;
    return {
      footerBottom: Math.round(footer.getBoundingClientRect().bottom),
      viewportBottom: Math.round(viewport.getBoundingClientRect().bottom),
      window: window.innerHeight,
    };
  });
  check(m !== null, `${tag}: no delete footer in a scroll viewport`);
  if (m !== null)
    check(
      m.footerBottom <= m.window - 12 && m.viewportBottom <= m.window,
      `${tag}: the delete footer is not clear of the window's edge (${JSON.stringify(m)})`,
    );
}

const topOf = (page, sel) =>
  page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().top, sel);

const isFocused = (page, testid) =>
  page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testid);

/** Every value in `heights` equals the first, to the pixel — or say which moved. */
function stillness(check, tag, what, heights) {
  const entries = Object.entries(heights);
  const [, base] = entries[0];
  const moved = entries.filter(([, y]) => Math.abs(y - base) >= 1);
  check(
    moved.length === 0,
    `${tag}: ${what} moved — ${entries.map(([k, y]) => `${k}=${Math.round(y)}`).join(' ')}`,
  );
}

async function interactionsBody(ctx) {
  const { page, shot, check } = ctx;
  const { ids } = await prepare(ctx);
  // Ledger+ is the first tab, so it is already up; clicking it anyway would
  // hand focus to the shell's tab button, which is not part of the screen.
  const active = await page.getAttribute(`[data-testid="candidate-tab-${ID}"]`, 'data-state');
  if (active !== 'active') await page.click(`[data-testid="candidate-tab-${ID}"]`);
  await page.waitForTimeout(350);
  const prefix = EMPTY ? `empty-${ID}-ix` : `${ID}-ix`;
  const set = async (s) => {
    await page.evaluate(([cid, st]) => window.__scheduleCandidates.setState?.(cid, st), [ID, s]);
    await page.waitForTimeout(320);
  };
  const top = (sel) => topOf(page, sel);

  for (const theme of THEMES) {
    const [flavor, mode] = theme.split('-');
    const tag = `${flavor}-${mode}`;
    await setTheme(page, flavor, mode);
    await set('default');

    if (EMPTY) {
      // 1. The empty screen: the composer takes focus BY ITSELF (nothing clicked).
      await page.waitForTimeout(200);
      check(
        await isFocused(page, 'sc-composer-input'),
        `${tag}: the composer does not have focus on the empty screen`,
      );
      await shot(`${prefix}-composer-focus-${tag}`);
      // 2. A template card under the pointer — the one interaction the references
      //    show. The tile swaps to a "+": the click adds.
      await page.hover('[data-testid="sc-template-morning-brief"]');
      await page.waitForTimeout(260);
      const plusShown = await page.evaluate(() => {
        const plus = document.querySelector(
          '[data-testid="sc-template-morning-brief"] .sc-tile-face--plus',
        );
        return plus instanceof HTMLElement && Number(getComputedStyle(plus).opacity) > 0.9;
      });
      check(plusShown, `${tag}: the hovered template's tile did not swap to "+"`);
      await shot(`${prefix}-template-hover-${tag}`);
      await page.mouse.move(5, 5);
      // 3. Typing on the empty screen: the chips land in the lane, the templates stay put.
      const before = await top('[data-testid="sc-ledger-templates"]');
      await page.click(COMPOSER);
      await page.keyboard.type(SENTENCE);
      await page.waitForTimeout(300);
      const after = await top('[data-testid="sc-ledger-templates"]');
      check(
        Math.abs(before - after) < 1,
        `${tag}: the templates moved ${after - before}px while typing`,
      );
      await shot(`${prefix}-typing-${tag}`);
      await page.keyboard.press('Escape');
      // 4. "New task" on the empty screen: the composer folds to a strip in its
      //    own footprint (the panes' top must not move), the form is BLANK, and
      //    the templates under it say "Or start from one of these" — round 4
      //    photographed "write your own above" under a hidden composer, over a
      //    form still holding the previous sentence.
      const panesIdle = await top(PANES);
      await page.click('[data-testid="sc-new"]');
      await page.waitForTimeout(360);
      stillness(check, tag, 'the panes (New task on the empty screen)', {
        idle: panesIdle,
        new: await top(PANES),
      });
      const heading = await page.textContent('[data-testid="sc-ledger-templates"] h2');
      check(
        heading === 'Or start from one of these',
        `${tag}: under the editor the templates say "${heading}"`,
      );
      const blank = await page.inputValue('[data-testid="sc-editor-prompt"]');
      check(blank === '', `${tag}: the New-task form is not blank ("${blank.slice(0, 40)}…")`);
      await shot(`${prefix}-new-${tag}`);
      // 5. A template picked while the blank form is up: the form takes the
      //    template's values (it is a fresh editor, keyed by the draft) and the
      //    strip says which card.
      await page.click('[data-testid="sc-template-morning-brief"]');
      await page.waitForTimeout(360);
      const filled = await page.inputValue('[data-testid="sc-editor-prompt"]');
      check(filled.length > 0, `${tag}: picking a template left the form blank`);
      const strip = await page.textContent('[data-testid="sc-new-strip"]');
      check(
        strip?.includes('Morning brief') === true,
        `${tag}: the strip does not name the card ("${strip}")`,
      );
      await page.mouse.move(5, 5);
      await shot(`${prefix}-template-picked-${tag}`);
      // …and the way back to the sentence box: caret in it.
      await page.click('[data-testid="sc-new-strip-action"]');
      await page.waitForTimeout(300);
      check(
        await isFocused(page, 'sc-composer-input'),
        `${tag}: "Write a sentence" did not put the caret in the composer`,
      );
      await set('default');
      continue;
    }

    // 1. Focus in the composer, before a word is typed.
    await page.click(COMPOSER);
    await page.waitForTimeout(200);
    await shot(`${prefix}-composer-focus-${tag}`);

    // 2. The chips appearing as you type — three moments, and the list must not move.
    const heads = { idle: await top(LIST_HEAD) };
    await page.keyboard.type('every friday');
    await page.waitForTimeout(260);
    await shot(`${prefix}-typing-1-${tag}`);
    await page.keyboard.type(' at 4pm');
    await page.waitForTimeout(260);
    await shot(`${prefix}-typing-2-${tag}`);
    await page.keyboard.type(', write up what I worked on this week');
    await page.waitForTimeout(260);
    await shot(`${prefix}-typing-3-${tag}`);
    heads.typed = await top(LIST_HEAD);

    // 3. ↵: the editor, with the composer folded to the sentence it came from.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(360);
    heads.enter = await top(LIST_HEAD);
    await shot(`${prefix}-enter-${tag}`);
    // …and the way back: the sentence returns to the composer, caret and all.
    await page.click('[data-testid="sc-sentence-strip-action"]');
    await page.waitForTimeout(300);
    const restored = await page.inputValue(COMPOSER);
    check(
      restored.startsWith('every friday'),
      `${tag}: "Edit sentence" did not restore the sentence`,
    );
    heads.back = await top(LIST_HEAD);
    await shot(`${prefix}-strip-back-${tag}`);
    await page.keyboard.press('Escape');

    // 3b. THE SLOT HOLDS. Round 4 measured the list head at y=225 idle, 192
    //     after ↵ and 144 after "New task": three resting heights for the one
    //     persistent column. Now the composer's slot is one height in every
    //     state — a strip in the box's footprint for ↵, New task and Edit —
    //     and the list head's y is asserted equal across all of them.
    await set('default');
    await page.click('[data-testid="sc-new"]');
    await page.waitForTimeout(360);
    heads.new = await top(LIST_HEAD);
    check(
      (await page.inputValue('[data-testid="sc-editor-prompt"]')) === '',
      `${tag}: "New task" did not open a blank form`,
    );
    await page.mouse.move(5, 5);
    await shot(`${prefix}-new-${tag}`);
    // The strip's action: back to the sentence box, caret in it.
    await page.click('[data-testid="sc-new-strip-action"]');
    await page.waitForTimeout(300);
    check(
      await isFocused(page, 'sc-composer-input'),
      `${tag}: "Write a sentence" did not put the caret in the composer`,
    );
    heads.afterNew = await top(LIST_HEAD);
    await set('default');
    await page.click('[data-testid="sc-edit"]');
    await page.waitForTimeout(360);
    heads.edit = await top(LIST_HEAD);
    await page.mouse.move(5, 5);
    await shot(`${prefix}-edit-${tag}`);
    await page.click('[data-testid="sc-edit-strip-action"]');
    await page.waitForTimeout(300);
    check(
      (await page.$('[data-testid="sc-editor"]')) === null,
      `${tag}: the edit strip's Cancel did not close the editor`,
    );
    heads.afterEdit = await top(LIST_HEAD);
    stillness(check, tag, 'the list head', heads);

    // 3c. A template picked over the blank form fills it — the editor is keyed
    //     by the draft, so the values arrive (they did not, before round 4).
    await set('new');
    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="sc-template-morning-brief"]');
      card?.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(200);
    await page.click('[data-testid="sc-template-morning-brief"]');
    await page.waitForTimeout(360);
    check(
      (await page.inputValue('[data-testid="sc-editor-prompt"]')).length > 0,
      `${tag}: picking a template over the blank form left it blank`,
    );
    await page.mouse.move(5, 5);
    await shot(`${prefix}-template-picked-${tag}`);

    // 3d. A sentence long enough that the name had to be cut: the editor's
    //     lead says so ("The name is its first words — change it if you like").
    await set('default');
    await page.click(COMPOSER);
    await page.keyboard.type(LONG_SENTENCE);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(360);
    const lead = await page.textContent('[data-testid="sc-editor"] > p');
    check(
      lead?.includes('first words') === true,
      `${tag}: the cut-name lead line is missing (got "${lead}")`,
    );
    await shot(`${prefix}-enter-cut-${tag}`);

    // 4. The magnifier: expands into the field in place, filters as you type.
    await set('default');
    await page.click('[data-testid="sc-ledger-search"] button');
    await page.waitForTimeout(300);
    await shot(`${prefix}-search-open-${tag}`);
    await page.keyboard.type('test');
    await page.waitForTimeout(260);
    const rowsLeft = await page.$$('[data-testid^="sc-ledger-row-"]');
    check(rowsLeft.length === 1, `${tag}: search "test" left ${rowsLeft.length} rows, expected 1`);
    await shot(`${prefix}-search-typed-${tag}`);
    await page.keyboard.press('Escape');
    await set('default');

    // 5. A list row under the pointer, and one under keyboard focus.
    await page.hover(ROW('Run the tests'));
    await page.waitForTimeout(260);
    await shot(`${prefix}-row-hover-${tag}`);
    await page.mouse.move(5, 5);
    await page.click(COMPOSER);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const onRow = await page.evaluate(() => document.activeElement?.classList.contains('sc-row'));
      if (onRow) break;
    }
    const focusedRow = await page.evaluate(
      () => document.activeElement?.classList.contains('sc-row') === true,
    );
    check(focusedRow, `${tag}: Tab never reached a list row`);
    await page.waitForTimeout(200);
    await shot(`${prefix}-row-focus-${tag}`);

    // 6. The pane swap: Morning brief → Portrait of the day, caught mid-crossfade
    //    (slowed 5× through the CSS seam for the still) and settled. MODE=film
    //    has the same swap at real speed.
    await set('default');
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--sc-pane-duration', '1100ms'),
    );
    await page.click(ROW('Portrait of the day'));
    await page.waitForTimeout(220);
    await shot(`${prefix}-pane-swap-mid-${tag}`);
    await page.waitForTimeout(1100);
    await shot(`${prefix}-pane-swap-after-${tag}`);
    await page.evaluate(() => document.documentElement.style.removeProperty('--sc-pane-duration'));

    // 7. A run row under the pointer, then opened (the first closes).
    await set('default');
    const secondRun = '[data-testid="sc-run-head-run_a2"]';
    await page.hover(secondRun);
    await page.waitForTimeout(260);
    await shot(`${prefix}-run-hover-${tag}`);
    await page.click(secondRun);
    await page.waitForTimeout(300);
    await shot(`${prefix}-run-open-${tag}`);
    await page.mouse.move(5, 5);

    // 8. Delete asks once, in place, and "Keep" disarms it.
    await set('late');
    await scrollPaneToEnd(page, check, tag);
    await page.click('[data-testid="sc-delete"]');
    await page.waitForTimeout(260);
    await shot(`${prefix}-delete-armed-${tag}`);
    await page.click('[data-testid="sc-delete-keep"]');
    await page.waitForTimeout(260);
    const disarmed = (await page.$('[data-testid="sc-delete"]')) !== null;
    check(disarmed, `${tag}: Keep did not disarm the delete`);
    await shot(`${prefix}-delete-kept-${tag}`);

    // 8b. The other two wordings of what deleting takes: one run, and none.
    await set('default');
    await page.click(ROW('Sort my Downloads'));
    await page.waitForTimeout(400);
    await page.mouse.move(5, 5);
    await scrollPaneToEnd(page, check, `${tag} one-run`);
    const oneRun = await page.textContent('[data-testid="sc-delete-footer"]');
    check(oneRun?.includes('its one run') === true, `${tag}: one-run footer says "${oneRun}"`);
    await shot(`${prefix}-delete-one-run-${tag}`);
    await page.click(ROW('What did I miss'));
    await page.waitForTimeout(400);
    await page.mouse.move(5, 5);
    await scrollPaneToEnd(page, check, `${tag} no-runs`);
    const noRuns = await page.textContent('[data-testid="sc-delete-footer"]');
    check(noRuns?.includes('no runs to lose') === true, `${tag}: no-runs footer says "${noRuns}"`);
    await shot(`${prefix}-delete-no-runs-${tag}`);

    // 9. A model loaded: "Runs on" is its name and nothing else, and the
    //    editor's consequence line names it too. The probe loads no model
    //    (there is none in a throwaway home); it is put in the llm store
    //    through the store's own applyStatus, the seam `llm:status` writes.
    await set('default');
    await page.evaluate(() => window.__scheduleCandidates.setLoadedModel('Gemma 4 12B'));
    await page.waitForTimeout(240);
    const reach = await page.textContent('[data-testid="sc-reach-block"]');
    check(
      reach?.includes('Gemma 4 12B') === true && reach.includes('loaded now') === false,
      `${tag}: "Runs on" with a model loaded reads "${reach}"`,
    );
    await shot(`${prefix}-model-loaded-${tag}`);
    await set('review');
    const preview = await page.textContent('[data-testid="sc-editor-preview"]');
    check(
      preview?.includes('runs on Gemma 4 12B') === true,
      `${tag}: the editor's line with a model loaded reads "${preview}"`,
    );
    await shot(`${prefix}-model-loaded-editor-${tag}`);
    await page.evaluate(() => window.__scheduleCandidates.setLoadedModel(null));
    await set('default');
  }

  if (EMPTY) return;

  // Narrow, bobble-dark: the ones that change shape when the panes stack.
  await setTheme(page, 'bobble', 'dark');
  await page.setViewportSize(CONTENT_NARROW);
  await set('default');
  await page.click(COMPOSER);
  await page.keyboard.type(SENTENCE);
  await page.waitForTimeout(300);
  await shot(`${prefix}-typing-3-narrow-bobble-dark`);
  // ↵ at 640: the strip in the composer's footprint over the stacked editor.
  const panesNarrowIdle = await top(PANES);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(360);
  stillness(check, 'narrow', 'the panes (↵ at 640)', {
    idle: panesNarrowIdle,
    enter: await top(PANES),
  });
  await shot(`${prefix}-enter-narrow-bobble-dark`);
  await page.click('[data-testid="sc-sentence-strip-action"]');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await set('default');
  await page.hover(ROW('Run the tests'));
  await page.waitForTimeout(260);
  await shot(`${prefix}-row-hover-narrow-bobble-dark`);
  await page.mouse.move(5, 5);
  await set('late');
  await scrollPaneToEnd(page, check, 'narrow');
  await page.click('[data-testid="sc-delete"]');
  await page.waitForTimeout(260);
  await shot(`${prefix}-delete-armed-narrow-bobble-dark`);
  await page.click('[data-testid="sc-delete-keep"]');
  await page.setViewportSize(CONTENT_WIDE);
  check(ids.length === SEED_TASKS.length, `seeded ${ids.length} of ${SEED_TASKS.length} tasks`);
}

/* ---- chrome: Ledger+ inside the app's own shell ----------------------------- */

/**
 * The shipping shell — sidebar, top bar, "Scheduled" title — around Ledger+,
 * through the same `contentOverride` seam ScheduledView rides (chrome.tsx).
 * Three rounds of judgement had never seen the composer under that title.
 */
async function chrome() {
  await guarded(
    () =>
      launchApp('cand-schedule-chrome', {
        env: {
          VITE_DEV_SERVER_URL: DEV_URL,
          PI_DESKTOP_CANDIDATES: 'schedule',
          PI_DESKTOP_CANDIDATE_V: 'ledger-plus-chrome',
        },
        waitFor: CHROME_READY,
      }),
    chromeBody,
  );
}

async function chromeBody(ctx) {
  const { page, shot, check } = ctx;
  await prepare(ctx, { ready: CHROME_READY, viewport: WIDE });
  const set = async (s) => {
    await page.evaluate(([cid, st]) => window.__scheduleCandidates.setState?.(cid, st), [ID, s]);
    await page.waitForTimeout(320);
  };
  const title = await page.textContent('[data-testid="studio-title"]');
  check(title === 'Scheduled', `the top bar's title is "${title}", expected "Scheduled"`);
  // The sidebar row that names the screen, under the pointer the way the
  // shipping shot (current/scheduled-list-*) has it — the probe clicked it to
  // get there. Here it is the same click; the handler has nowhere else to go.
  await page.click('[data-testid="nav-scheduled"]');
  await page.waitForTimeout(300);
  for (const theme of THEMES) {
    const [flavor, mode] = theme.split('-');
    await setTheme(page, flavor, mode);
    await set('default');
    await shot(`${ID}-chrome-${flavor}-${mode}`);
  }
  await setTheme(page, 'bobble', 'dark');
  await set('typing');
  await shot(`${ID}-chrome-typing-bobble-dark`);
  await set('new');
  await shot(`${ID}-chrome-new-bobble-dark`);
  await set('default');
  // A 13" laptop's window: the sidebar open leaves the 900px content width.
  await page.setViewportSize(WIDE_LAPTOP);
  await page.waitForTimeout(300);
  await shot(`${ID}-chrome-laptop-bobble-dark`);
  await page.setViewportSize(WIDE);
}

/* ---- film: the motion, at real speed ---------------------------------------- */

/**
 * Record the window through CDP's screencast while `action` runs, then for
 * `settleMs` more. Frames arrive at the compositor's rate with wall-clock
 * timestamps; the hidden window paints exactly as a shown one does (measured:
 * ~60 fps from `show: false`). Returns the frames with ms offsets from the
 * action's start.
 */
async function record(page, action, settleMs) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, png: Buffer.from(f.data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.waitForTimeout(200);
  const start = Date.now();
  const startedAt = frames.length > 0 ? frames[frames.length - 1].t : undefined;
  await action();
  await page.waitForTimeout(settleMs);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  // Offsets from the last frame BEFORE the action — the idle picture — so 0 ms
  // is "before", and everything after is the motion.
  const zero = startedAt ?? frames[0]?.t ?? 0;
  return {
    frames: frames.map((f) => ({ ...f, ms: Math.round(f.t - zero) })).filter((f) => f.ms >= 0),
    wall: Date.now() - start,
  };
}

/**
 * A font file for the filmstrip's millisecond labels. ImageMagick on this Mac
 * has no default font configured (`-annotate` fails with "unable to read font
 * ''"), so the label is drawn with the first system face that exists; with
 * none, the strip is written unlabelled rather than not at all.
 */
const LABEL_FONT = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
].find((f) => existsSync(f));

/**
 * Write a clip as (a) a GIF at the recorded speed and (b) a filmstrip of eight
 * frames spread evenly over `spanMs`, each labelled with its offset. Both are
 * cropped to the region that moves, so the frames are large enough to read
 * and the GIF is not a megabyte of still sidebar per clip.
 */
function writeClip(name, frames, { spanMs, crop, columns = 4 }) {
  const dir = mkdtempSync(path.join(tmpdir(), `pd-film-${name}-`));
  const cs = (ms) => Math.max(1, Math.round(ms / 10));
  const region = `${crop.w}x${crop.h}+${crop.x}+${crop.y}`;
  const gifArgs = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `f${String(i).padStart(4, '0')}.png`);
    writeFileSync(file, f.png);
    const next = frames[i + 1];
    gifArgs.push('-delay', String(cs(next === undefined ? 400 : next.ms - f.ms)), file);
  });
  const gif = path.join(OUT, `${name}.gif`);
  execFileSync('magick', [
    ...gifArgs,
    '-crop',
    region,
    '+repage',
    '-loop',
    '0',
    '-layers',
    'optimize',
    gif,
  ]);

  // Eight moments: 0 (idle), then evenly across the span, then the settled end.
  const want = Array.from({ length: 7 }, (_, i) => Math.round((spanMs * (i + 1)) / 7));
  const picks = [frames[0]];
  for (const ms of want) {
    const f = frames.reduce((best, cur) =>
      Math.abs(cur.ms - ms) < Math.abs(best.ms - ms) ? cur : best,
    );
    if (!picks.includes(f)) picks.push(f);
  }
  const strip = path.join(OUT, `${name}-strip.png`);
  const tiles = picks.map((f, i) => {
    const src = path.join(dir, `f${String(frames.indexOf(f)).padStart(4, '0')}.png`);
    const tile = path.join(dir, `tile${i}.png`);
    const label =
      LABEL_FONT === undefined
        ? []
        : [
            '-font',
            LABEL_FONT,
            '-gravity',
            'NorthWest',
            '-fill',
            '#ffffff',
            '-undercolor',
            '#000000c0',
            '-pointsize',
            '16',
            '-annotate',
            '+6+6',
            ` ${f.ms} ms `,
          ];
    execFileSync('magick', [src, '-crop', region, '+repage', '-resize', '50%', ...label, tile]);
    return tile;
  });
  // montage wants a font even with nothing to letter (it exits 1 without one).
  execFileSync('montage', [
    ...tiles,
    ...(LABEL_FONT === undefined ? [] : ['-font', LABEL_FONT]),
    '-tile',
    `${columns}x`,
    '-geometry',
    '+4+4',
    '-background',
    '#333333',
    strip,
  ]);
  return { gif, strip, frames: frames.length, picked: picks.map((f) => f.ms) };
}

async function film() {
  await guarded(launchCandidates, filmBody);
}

async function filmBody(ctx) {
  const { page, check } = ctx;
  await prepare(ctx);
  const set = async (s) => {
    await page.evaluate(([cid, st]) => window.__scheduleCandidates.setState?.(cid, st), [ID, s]);
    await page.waitForTimeout(320);
  };
  const slot = { x: 0, y: 44, w: 1168, h: 300 }; // header, composer slot, the top of the panes
  const pane = { x: 300, y: 200, w: 868, h: 560 }; // the detail pane, clear of the list's edge
  const clips = [];

  for (const theme of THEMES) {
    const [flavor, mode] = theme.split('-');
    const tag = `${flavor}-${mode}`;
    await setTheme(page, flavor, mode);

    // ↵: the composer folds to the strip, the editor arrives in the pane.
    await set('default');
    await page.click(COMPOSER);
    await page.keyboard.type(SENTENCE);
    await page.waitForTimeout(400);
    let rec = await record(page, () => page.keyboard.press('Enter'), 700);
    clips.push([
      `${ID}-motion-enter-${tag}`,
      writeClip(`${ID}-motion-enter-${tag}`, rec.frames, { spanMs: 420, crop: slot }),
    ]);

    // Edit sentence: the strip gives the composer back, sentence and caret.
    rec = await record(page, () => page.click('[data-testid="sc-sentence-strip-action"]'), 700);
    clips.push([
      `${ID}-motion-edit-sentence-${tag}`,
      writeClip(`${ID}-motion-edit-sentence-${tag}`, rec.frames, { spanMs: 420, crop: slot }),
    ]);
    await page.keyboard.press('Escape');

    // The pane swap: Morning brief → Portrait of the day.
    await set('default');
    await page.mouse.move(5, 5);
    rec = await record(page, () => page.click(ROW('Portrait of the day')), 700);
    clips.push([
      `${ID}-motion-pane-swap-${tag}`,
      writeClip(`${ID}-motion-pane-swap-${tag}`, rec.frames, { spanMs: 420, crop: pane }),
    ]);
    await page.mouse.move(5, 5);
  }

  for (const [name, c] of clips) {
    check(c.frames >= 12, `${name}: only ${c.frames} frames were recorded`);
    console.log(`${name}: ${c.frames} frames, strip at ${c.picked.join('/')} ms`);
  }
}

/* ---- chat: a task made in a conversation, as the chat shows it -------------- */

const CHAT_FIXTURE = path.join(HERE, 'fixtures', 'chat-task.json');
const CHAT_SENTENCE = 'Every Friday at 4pm, write up what I worked on this week.';

/**
 * The reference's best moment (`12.00.58 AM`) is a task made IN the chat: the
 * model calls its tool and the thread shows a card for the task. Bobble has
 * the tool (`create_scheduled_task`, packages/harness) and three rounds of
 * judgement never saw what its chat shows when the tool fires. This is the
 * real chat and the real activity chain, driven by a scripted turn
 * (fixtures/chat-task.json) in which the model calls that tool with a Friday
 * write-up and confirms — photographed as it lands, then with the chain open,
 * then with the step open. Nothing in the chat was changed for it: the point
 * is to see what is there.
 */
async function chat() {
  await guarded(
    () =>
      launchApp('cand-schedule-chat', {
        fixture: CHAT_FIXTURE,
        env: { VITE_DEV_SERVER_URL: DEV_URL },
      }),
    chatBody,
  );
}

async function chatBody({ page, shot, check }) {
  await page.setViewportSize(WIDE);
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await setTheme(page, 'bobble', 'dark');
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(CHAT_SENTENCE);
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=runs every Friday at 4:00 PM', { timeout: 15_000 });
  await page.waitForTimeout(600);
  const chain = page.locator('[data-testid="activity-chain"]');
  const chains = await chain.count();
  check(chains === 1, `expected one activity chain for the tool call, found ${chains}`);
  await page.mouse.move(5, 5);
  for (const theme of THEMES) {
    const [flavor, mode] = theme.split('-');
    await setTheme(page, flavor, mode);
    await page.waitForTimeout(160);
    await shot(`chat-task-created-${flavor}-${mode}`);
  }
  if (chains !== 1) return;
  await setTheme(page, 'bobble', 'dark');
  // The chain opened: its step list, then the step itself.
  await chain.locator('.pd-chain-summary').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="activity-chain"]')?.getAttribute('data-expanded') ===
      'true',
    undefined,
    { timeout: 8000 },
  );
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5);
  await shot('chat-task-created-open-bobble-dark');
  const step = chain.locator('.pd-chain-step').first();
  const kind = await step.getAttribute('data-kind');
  const summary = await chain.locator('.pd-chain-summary-text').innerText();
  console.log(`create_scheduled_task renders as a "${kind}" step; the chain says "${summary}"`);
  await step.locator('.pd-chain-step-row').first().click();
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5);
  await shot('chat-task-created-step-bobble-dark');
}

if (MODE === 'baseline') await baseline();
else if (MODE === 'interactions') await interactions();
else if (MODE === 'chrome') await chrome();
else if (MODE === 'film') await film();
else if (MODE === 'chat') await chat();
else await candidates();
