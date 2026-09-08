/**
 * THE SCHEDULED SCREEN, PHOTOGRAPHED AND FILMED — the evidence for a design
 * judgement, not a pass/fail suite (scheduled-probe.mjs is that).
 *
 *   MODE=seeded node tests/e2e/scheduled-design-probe.mjs   # nine tasks, a week of runs, every state
 *   MODE=empty  node tests/e2e/scheduled-design-probe.mjs   # first run: the suggestions, the dialog, the parse
 *   MODE=all    (default) both
 *
 * Built on harness.mjs: hidden window, throwaway $HOME, mock pi, focus guard.
 * Loads the BUILT renderer (dist/) — what the app actually runs. Data is real:
 * tasks go through `tasks:create`, run records are written to the throwaway
 * home's scheduled-runs dir in the exact shape the runner writes, one run is
 * REAL (Run now through the mock pi, with a fixture slow enough to be seen
 * running and then stopped). Every state is shot in bobble dark and light at
 * 1440×868; the list and a task's page are also shot at 1172, 900 and 760
 * (the app's own minimum). Motion is recorded through CDP's screencast and
 * written as a GIF plus a labelled filmstrip. Computed styles and boxes for
 * the elements a review would measure are dumped to `measure.json`.
 *
 * Frames land under src/scheduled/shots/<mode>/.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGED_TASK_INDEX,
  holdStampFor,
  SEED_RUNS,
  SEED_TASKS,
  withRunsDir,
} from '../../src/candidates/schedule/seed.mjs';
import { APP_ROOT, launchApp } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE ?? 'all';
const SHOTS_ROOT = path.join(APP_ROOT, 'src', 'scheduled', 'shots');
const SLOW_FIXTURE = path.join(HERE, 'fixtures', 'scheduled-slow.json');
const PORTRAIT = path.join(APP_ROOT, 'src', 'candidates', 'schedule', 'fixtures', 'portrait.png');

const THEMES = ['bobble-dark', 'bobble-light'];
/** the user's window: 1512x868 work area clamps the 1440x940 default to this. */
const WINDOW = { width: 1440, height: 868 };
const WIDTHS = [
  ['laptop', { width: 1172, height: 800 }],
  ['small', { width: 900, height: 700 }],
  ['minimum', { width: 760, height: 560 }],
];

const NAV = '[data-testid="nav-scheduled"]';
const VIEW = '[data-testid="scheduled-view"]';
/** Playwright's engine, for clicks and hovers: a row by the name on it. */
const ROW = (name) => `.sd-list .sd-row:has-text("${name}")`;
/** A DOM-valid selector for the same row, for `measure`/`boxOf` (querySelector). */
const rowSel = (page, name) =>
  page.evaluate(
    (n) =>
      [...document.querySelectorAll('.sd-list .sd-row')]
        .filter((e) => (e.textContent ?? '').includes(n))
        .map((e) => `[data-testid="${e.getAttribute('data-testid')}"]`)[0] ?? '.sd-row',
    name,
  );

let OUT = SHOTS_ROOT;
let DPR = 1;
const measurements = {};
const consoleErrors = [];

/* ---- helpers ------------------------------------------------------------- */

async function setTheme(page, theme) {
  const [flavor, mode] = theme.split('-');
  await page.evaluate(
    ([f, m]) => {
      document.documentElement.setAttribute('data-flavor', f);
      document.documentElement.setAttribute('data-mode', m);
    },
    [flavor, mode],
  );
  await page.waitForTimeout(220);
}

function watchConsole(page) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      consoleErrors.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e).slice(0, 300)}`));
}

async function measure(page, label, selectors) {
  const out = {};
  for (const [name, sel] of Object.entries(selectors)) {
    out[name] = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el === null) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? '').trim().slice(0, 80),
        box: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
        font: `${cs.fontSize}/${cs.lineHeight} ${cs.fontWeight}`,
        color: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderTopWidth !== '0px' ? `${cs.borderTopWidth} ${cs.borderTopColor}` : 'none',
        radius: cs.borderTopLeftRadius,
        opacity: cs.opacity,
      };
    }, sel);
  }
  measurements[label] = out;
  return out;
}

async function tabOrder(page, label, { start, max = 40 } = {}) {
  if (start !== undefined) await page.focus(start).catch(() => undefined);
  const stops = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const a = document.activeElement;
      if (a === null || a === document.body) return { tag: 'BODY' };
      const cs = getComputedStyle(a);
      const r = a.getBoundingClientRect();
      return {
        tag: a.tagName,
        testid: a.getAttribute('data-testid'),
        label: a.getAttribute('aria-label'),
        text: (a.textContent ?? '').trim().slice(0, 40),
        ring: `${cs.outlineWidth} ${cs.outlineStyle}`,
        visible: r.width > 0 && r.height > 0,
        y: Math.round(r.y),
      };
    });
    stops.push(s);
    if (s.tag === 'BODY') break;
  }
  measurements[`tab-order:${label}`] = stops;
  return stops;
}

const focusedId = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a === null || a === document.body
      ? 'BODY'
      : (a.getAttribute('data-testid') ?? a.getAttribute('aria-label') ?? a.tagName);
  });

const boxOf = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r === undefined
      ? null
      : { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);

const rowNames = (page) =>
  page.$$eval('.sd-list .sd-row-name', (els) => els.map((e) => (e.textContent ?? '').trim()));

/** Does the page's body scroll sideways? It must never. */
const overflows = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="scheduled-view"]');
    return el === null ? null : el.scrollWidth > el.clientWidth + 1;
  });

/** Record the window through CDP while `action` runs, then `settleMs` more. */
async function record(page, action, settleMs) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, png: Buffer.from(f.data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.waitForTimeout(200);
  const startedAt = frames.length > 0 ? frames[frames.length - 1].t : undefined;
  await action();
  await page.waitForTimeout(settleMs);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  const zero = startedAt ?? frames[0]?.t ?? 0;
  return frames.map((f) => ({ ...f, ms: Math.round(f.t - zero) })).filter((f) => f.ms >= 0);
}

const LABEL_FONT = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
].find((f) => existsSync(f));

/** A GIF at recorded speed plus a filmstrip of eight labelled frames, cropped to `crop`. */
function writeClip(name, frames, { spanMs, crop, columns = 4 }) {
  if (frames.length === 0) return { frames: 0 };
  const dir = mkdtempSync(path.join(tmpdir(), `pd-sd-film-${name}-`));
  const cs = (ms) => Math.max(1, Math.round(ms / 10));
  const px = (v) => Math.round(v * DPR);
  const region = `${px(crop.w)}x${px(crop.h)}+${px(crop.x)}+${px(crop.y)}`;
  const toCss = `${Math.round(100 / DPR)}%`;
  const gifArgs = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `f${String(i).padStart(4, '0')}.png`);
    writeFileSync(file, f.png);
    const next = frames[i + 1];
    gifArgs.push('-delay', String(cs(next === undefined ? 400 : next.ms - f.ms)), file);
  });
  execFileSync('magick', [
    ...gifArgs,
    '-crop',
    region,
    '+repage',
    '-resize',
    toCss,
    '-loop',
    '0',
    '-layers',
    'optimize',
    path.join(OUT, `${name}.gif`),
  ]);
  const want = Array.from({ length: 7 }, (_, i) => Math.round((spanMs * (i + 1)) / 7));
  const picks = [frames[0]];
  for (const ms of want) {
    const f = frames.reduce((best, cur) =>
      Math.abs(cur.ms - ms) < Math.abs(best.ms - ms) ? cur : best,
    );
    if (!picks.includes(f)) picks.push(f);
  }
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
    execFileSync('magick', [src, '-crop', region, '+repage', '-resize', toCss, ...label, tile]);
    return tile;
  });
  execFileSync('montage', [
    ...tiles,
    ...(LABEL_FONT === undefined ? [] : ['-font', LABEL_FONT]),
    '-tile',
    `${columns}x`,
    '-geometry',
    '+4+4',
    '-background',
    '#333333',
    path.join(OUT, `${name}-strip.png`),
  ]);
  return { frames: frames.length, picked: picks.map((f) => f.ms) };
}

/* ---- seeding: real IPC for tasks, real files for runs -------------------- */

async function seedTasks(page, now) {
  const ids = [];
  for (const [i, draft] of SEED_TASKS.entries()) {
    const res = await page.evaluate(
      (task) => window.piDesktop.invoke('tasks:create', { task }),
      draft,
    );
    ids.push(res.task.id);
    const lastRunAt = holdStampFor(i, now);
    if (lastRunAt !== undefined)
      await page.evaluate(
        ([id, at]) => window.piDesktop.invoke('tasks:update', { id, patch: { lastRunAt: at } }),
        [res.task.id, lastRunAt],
      );
  }
  const aged = ids[AGED_TASK_INDEX];
  if (aged !== undefined)
    await page.evaluate(
      ([id, createdAt]) => window.piDesktop.invoke('tasks:update', { id, patch: { createdAt } }),
      [aged, now - 8 * 86_400_000],
    );
  return ids;
}

const WEB_BLOCKED =
  'web_search was blocked: the web tools are off for scheduled runs (Settings › Tools › Web). ' +
  'Turn them on and the task will work from the next run.';

/** Run records on disk, exactly where and how the runner writes them. */
function writeRunFiles(runsDir, ids, now) {
  const out = {};
  ids.forEach((id, i) => {
    const runs = SEED_RUNS[i];
    if (runs === undefined) return;
    const dir = path.join(runsDir, id);
    mkdirSync(dir, { recursive: true });
    out[id] = runs(now).map((r) => ({ ...r, taskId: id }));
    // "Watch llama.cpp releases": its NEWEST run failed, so the row and the
    // page have a failure to lead with — the case the old screen hid.
    if (i === 4 && out[id][0] !== undefined) {
      out[id][0] = {
        ...out[id][0],
        status: 'error',
        summary: '',
        error: WEB_BLOCKED,
        finishedAt: out[id][0].startedAt + 4000,
      };
    }
    // The model on a record, where the runner now writes it.
    out[id] = out[id].map((r, k) =>
      k === 0 || r.status === 'running'
        ? r
        : { ...r, model: { id: 'gemma-4-12b', displayName: 'Gemma 4 12B' } },
    );
    for (const r of out[id])
      writeFileSync(path.join(dir, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
  });
  return out;
}

function prepareRunsDir(home) {
  const runsDir = path.join(home, '.pi', 'desktop', 'scheduled-runs');
  mkdirSync(path.join(runsDir, 'task', 'run_h2'), { recursive: true });
  copyFileSync(PORTRAIT, path.join(runsDir, 'task', 'run_h2', 'portrait.png'));
  withRunsDir(runsDir);
  return runsDir;
}

async function guarded(name, body) {
  OUT = path.join(SHOTS_ROOT, name);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  process.env.SHOT_DIR = OUT;
  const ctx = await launchApp(`scheduled-design-${name}`, { fixture: SLOW_FIXTURE });
  watchConsole(ctx.page);
  // The first-run tips card sits over the bottom-left of every screen in a
  // fresh home; it is not this screen's, and it would be in every frame.
  await ctx.page.addStyleTag({
    content: '[data-testid="first-run-tips"]{display:none !important}',
  });
  DPR = await ctx.page.evaluate(() => window.devicePixelRatio);
  measurements.devicePixelRatio = DPR;
  try {
    await body(ctx);
  } finally {
    const measureFile = path.join(OUT, 'measure.json');
    writeFileSync(measureFile, `${JSON.stringify(measurements, null, 2)}\n`);
    // The frames live under src/, where biome reads JSON too: print it its way.
    try {
      execFileSync(path.join(APP_ROOT, 'node_modules', '.bin', 'biome'), [
        'format',
        '--write',
        measureFile,
      ]);
    } catch {
      // best-effort: the numbers are the point, the layout is not
    }
    writeFileSync(path.join(OUT, 'console.txt'), `${consoleErrors.join('\n')}\n`);
    ctx.check(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
    await ctx.finish();
  }
}

async function openScheduled(page) {
  await page.click(NAV);
  await page.waitForSelector(VIEW, { timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function shotBoth(page, shot, name) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`${name}-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
}

async function openRow(page, name) {
  await page.click(ROW(name));
  await page.waitForSelector('[data-testid="sd-detail"]', { timeout: 5_000 });
  await page.waitForTimeout(350);
  await page.mouse.move(5, 5);
}

async function back(page) {
  await page.click('[data-testid="sd-back"]');
  await page.waitForSelector('.sd-list', { timeout: 5_000 });
  await page.waitForTimeout(350);
  await page.mouse.move(5, 5);
}

/** The content column (the page minus the sidebar), for film crops. */
async function contentBox(page) {
  const v = await boxOf(page, VIEW);
  return v ?? { x: 272, y: 44, w: 1168, h: 824 };
}

/* ======================================================================== */
/* SEEDED: nine tasks, a week of runs, every state                           */
/* ======================================================================== */

async function seededBody(ctx) {
  const { page, shot, check, home } = ctx;
  const runsDir = prepareRunsDir(home);
  await page.setViewportSize(WINDOW);
  await page.waitForTimeout(300);
  const now = Date.now();
  const ids = await seedTasks(page, now);
  const runsById = writeRunFiles(runsDir, ids, now);
  check(ids.length === SEED_TASKS.length, `seeded ${ids.length} of ${SEED_TASKS.length}`);
  check(Object.keys(runsById).length > 0, 'no run files written');
  await openScheduled(page);
  await page.waitForSelector('.sd-list [data-testid^="sd-row-"]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);

  /* ---- 1. the list: the page at rest, both themes -------------------------- */
  await shotBoth(page, shot, 'list');
  const mb = await rowSel(page, 'Morning brief');
  await measure(page, 'list', {
    topbarTitle: '[data-testid="studio-title"]',
    title: '[data-testid="sd-title"]',
    lede: '[data-testid="sd-lede"]',
    search: '[data-testid="sd-search"] button',
    newTask: '[data-testid="sd-new"]',
    list: '.sd-list',
    row: mb,
    tile: `${mb} .sd-tile`,
    rowName: `${mb} .sd-row-name`,
    rowLine: `${mb} .sd-row-line`,
    running: `${await rowSel(page, 'Portrait of the day')} .sd-row-word`,
    missed: `${await rowSel(page, 'What did I miss')} .sd-row-word`,
    more: '[data-testid="sd-more-templates"]',
  });
  measurements['list:rows'] = await rowNames(page);
  measurements['list:overflows'] = await overflows(page);
  await page.hover(ROW('Run the tests'));
  await page.waitForTimeout(250);
  await shot('list-hover-bobble-dark');
  await measure(page, 'list-hover', { row: await rowSel(page, 'Run the tests') });
  await page.mouse.move(5, 5);

  // the suggestions row opens the suggestions under the list
  await page.click('[data-testid="sd-more-templates"]');
  await page.waitForTimeout(350);
  await page.mouse.move(5, 5);
  await page.$eval('[data-testid="sd-more-templates"]', (e) =>
    e.scrollIntoView({ block: 'start' }),
  );
  await page.waitForTimeout(200);
  await shotBoth(page, shot, 'list-suggestions');
  measurements['list:suggestions'] = (await page.$$('[data-testid^="sd-template-"]')).length;
  await page.click('[data-testid="sd-more-templates"]');
  await page.waitForTimeout(300);
  await page.$eval('.sd-body', (e) => e.scrollIntoView({ block: 'start' }));

  /* ---- 2. a task's page: the richest one, both themes ---------------------- */
  await openRow(page, 'Morning brief');
  await shotBoth(page, shot, 'task');
  await measure(page, 'task', {
    back: '[data-testid="sd-back"]',
    title: '[data-testid="sd-detail-title"]',
    line: '[data-testid="sd-detail-schedule"]',
    tile: '[data-testid="sd-detail"] .sd-tile',
    runNow: '[data-testid="sd-run-now"]',
    prompt: '.sd-prompt',
    facts: '.sd-facts',
    section: '.sd-section-title',
    runWhen: '.sd-run-when',
    runsOn: '[data-testid="sd-runs-on"]',
    footer: '.sd-footer',
  });
  measurements['task:overflows'] = await overflows(page);
  await back(page);

  /* ---- 3. a failed task: the row and the page lead with it ----------------- */
  await openRow(page, 'Watch llama.cpp');
  await shotBoth(page, shot, 'failed');
  await measure(page, 'failed', { headline: '.sd-run-headline[data-tone="error"]' });
  // the newest run opens by itself; a click on its head folds it to one line
  await page.click('[data-testid="sd-ledger"] .sd-run-head');
  await page.waitForTimeout(300);
  await page.mouse.move(5, 5);
  await shot('failed-collapsed-bobble-dark');
  await back(page);

  /* ---- 4. running (seeded), missed, late, by hand -------------------------- */
  await openRow(page, 'Portrait of the day');
  await shotBoth(page, shot, 'running-seeded');
  await measure(page, 'running-seeded', {
    stop: '[data-testid="sd-stop"]',
    state: '[data-testid="sd-state"]',
  });
  await back(page);
  await openRow(page, 'What did I miss');
  await shotBoth(page, shot, 'missed');
  await measure(page, 'missed', { state: '[data-testid="sd-state"]' });
  await back(page);
  await openRow(page, 'What changed today');
  await shot('late-bobble-dark');
  await back(page);
  await openRow(page, 'Sort my Downloads');
  await shot('by-hand-bobble-dark');
  await back(page);

  /* ---- 5. search, kill switch ----------------------------------------------- */
  await page.click('[data-testid="sd-search"] button');
  await page.keyboard.type('test');
  await page.waitForTimeout(250);
  await shot('search-typed-bobble-dark');
  measurements['search:rows-typed'] = (await rowNames(page)).length;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  measurements['search:rows-after-escape'] = (await rowNames(page)).length;
  check(measurements['search:rows-after-escape'] === SEED_TASKS.length, 'Escape clears the filter');

  const listBefore = await boxOf(page, '.sd-list');
  const orderBefore = await rowNames(page);
  await page.click('[data-testid="sd-scheduling-switch"]');
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);
  await shotBoth(page, shot, 'off');
  const listAfter = await boxOf(page, '.sd-list');
  measurements['off:list-moved-by'] = (listAfter?.y ?? 0) - (listBefore?.y ?? 0);
  measurements['off:reordered'] =
    JSON.stringify(await rowNames(page)) !== JSON.stringify(orderBefore);
  check(measurements['off:list-moved-by'] === 0, 'the kill switch moved the list');
  check(measurements['off:reordered'] === false, 'the kill switch reordered the list');
  await page.click('[data-testid="sd-scheduling-switch"]');
  await page.waitForTimeout(400);

  /* ---- 6. edit, new, delete armed -------------------------------------------- */
  await openRow(page, 'Morning brief');
  await page.click('[data-testid="sd-edit"]');
  await page.waitForSelector('[data-testid="sd-editor"]');
  await page.waitForTimeout(400);
  await shotBoth(page, shot, 'edit');
  measurements['edit:focused'] = await focusedId(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check((await page.$('[data-testid="sd-editor"]')) === null, 'Escape in the dialog cancels it');
  measurements['edit:focus-after-escape'] = await focusedId(page);

  await page.click('[data-testid="sd-delete"]');
  await page.waitForSelector('[data-testid="sd-delete-armed"]');
  await page.waitForTimeout(250);
  await shot('delete-armed-bobble-dark');
  await page.click('[data-testid="sd-delete-keep"]');
  await page.waitForTimeout(250);
  await back(page);

  await page.click('[data-testid="sd-new"]');
  await page.waitForSelector('[data-testid="sd-editor"]');
  await page.waitForTimeout(400);
  await shot('new-bobble-dark');
  await page.keyboard.type('every friday at 4pm, write up what I worked on this week');
  await page.waitForTimeout(300);
  await shotBoth(page, shot, 'new-sentence');
  measurements['new-sentence'] = await page.evaluate(() => ({
    read: document.querySelector('[data-testid="sd-parse"]')?.getAttribute('data-read'),
    chip: document.querySelector('[data-testid="sd-parse-schedule"]')?.textContent ?? null,
    hint: document.querySelector('[data-testid="sd-parse-hint"]')?.textContent ?? '',
    frequency: document.querySelector('[data-testid="sd-editor-frequency"]')?.textContent ?? '',
    preview: document.querySelector('[data-testid="sd-editor-preview"]')?.textContent ?? '',
  }));
  await page.click('[data-testid="sd-editor-cancel"]');
  await page.waitForTimeout(400);
  measurements['new:focus-after-cancel'] = await focusedId(page);

  /* ---- 7. the keyboard --------------------------------------------------------- */
  await tabOrder(page, 'list', { start: '[data-testid="sd-search"] button', max: 30 });
  await page.focus(ROW('Morning brief'));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  measurements['keys:after-arrow-down'] = await focusedId(page);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="sd-detail"]', { timeout: 5_000 });
  await page.waitForTimeout(300);
  measurements['keys:enter-opens'] = await page.textContent('[data-testid="sd-detail-title"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sd-list', { timeout: 5_000 });
  await page.waitForTimeout(300);
  measurements['keys:escape-back-focused'] = await focusedId(page);
  await shot('focus-row-bobble-dark');
  await page.mouse.move(5, 5);

  /* ---- 8. widths: the list and a task's page ------------------------------------ */
  for (const [name, size] of WIDTHS) {
    await page.setViewportSize(size);
    await page.waitForTimeout(450);
    await shot(`width-${name}-list-bobble-dark`);
    measurements[`width-${name}-list`] = {
      header: await boxOf(page, '.sd-header'),
      switchLabel: await page.$eval(
        '[data-testid="sd-scheduling-switch"]',
        (s) => s.parentElement?.textContent ?? '',
      ),
      overflows: await overflows(page),
      names: await page.$$eval('.sd-list .sd-row-name', (els) =>
        els.slice(0, 4).map((e) => ({
          text: (e.textContent ?? '').trim(),
          clipped: e.scrollWidth > e.clientWidth + 1,
        })),
      ),
    };
    if (name === 'minimum') {
      await setTheme(page, 'bobble-light');
      await shot('width-minimum-list-bobble-light');
      await setTheme(page, 'bobble-dark');
    }
    await page.click('[data-testid="sd-more-templates"]');
    await page.waitForTimeout(350);
    await page.$eval('[data-testid="sd-more-templates"]', (e) =>
      e.scrollIntoView({ block: 'start' }),
    );
    await page.waitForTimeout(150);
    await page.mouse.move(5, 5);
    await shot(`width-${name}-suggestions-bobble-dark`);
    measurements[`width-${name}-suggestions`] = {
      columns: await page.getAttribute('[data-testid="sd-templates"]', 'data-columns'),
      overflows: await overflows(page),
    };
    await page.click('[data-testid="sd-more-templates"]');
    await page.waitForTimeout(300);
    await page.$eval('.sd-body', (e) => e.scrollIntoView({ block: 'start' }));
    await openRow(page, 'Morning brief');
    await shot(`width-${name}-task-bobble-dark`);
    measurements[`width-${name}-task`] = {
      head: await boxOf(page, '.sd-task-head'),
      actions: await boxOf(page, '.sd-task-actions'),
      overflows: await overflows(page),
    };
    if (name === 'minimum') {
      await setTheme(page, 'bobble-light');
      await shot('width-minimum-task-bobble-light');
      await setTheme(page, 'bobble-dark');
    }
    await back(page);
  }
  await page.setViewportSize(WINDOW);
  await page.waitForTimeout(400);

  /* ---- 9. motion ------------------------------------------------------------------ */
  const content = await contentBox(page);
  const clip = { x: content.x, y: content.y, w: content.w, h: Math.min(content.h, 560) };

  // open a row: the list gives way to the task's page
  let frames = await record(page, () => page.click(ROW('Morning brief')), 500);
  measurements['film:open'] = writeClip('film-open', frames, { spanMs: 400, crop: clip });
  await page.waitForSelector('[data-testid="sd-detail"]');
  await page.mouse.move(5, 5);

  // and back
  frames = await record(page, () => page.click('[data-testid="sd-back"]'), 500);
  measurements['film-back'] = writeClip('film-back', frames, { spanMs: 400, crop: clip });
  await page.waitForSelector('.sd-list');
  await page.mouse.move(5, 5);

  // kill switch: the lede changes, nothing under it moves
  frames = await record(page, () => page.click('[data-testid="sd-scheduling-switch"]'), 500);
  measurements['film:switch-off'] = writeClip('film-switch-off', frames, {
    spanMs: 400,
    crop: clip,
  });
  await page.click('[data-testid="sd-scheduling-switch"]');
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5);

  // the suggestions row opens — filmed around the row, not the top of the page
  await page.$eval('[data-testid="sd-more-templates"]', (e) =>
    e.scrollIntoView({ block: 'center' }),
  );
  await page.waitForTimeout(200);
  const moreBox = (await boxOf(page, '[data-testid="sd-more-templates"]')) ?? clip;
  frames = await record(page, () => page.click('[data-testid="sd-more-templates"]'), 500);
  measurements['film:suggestions'] = writeClip('film-suggestions', frames, {
    spanMs: 400,
    crop: {
      x: content.x,
      y: Math.max(content.y, moreBox.y - 40),
      w: content.w,
      h: Math.min(360, content.y + content.h - Math.max(content.y, moreBox.y - 40)),
    },
  });
  await page.click('[data-testid="sd-more-templates"]');
  await page.waitForTimeout(300);
  await page.$eval('.sd-body', (e) => e.scrollIntoView({ block: 'start' }));
  await page.mouse.move(5, 5);

  /* ---- 10. a REAL run: Run now → running → Stop → stopped ------------------- */
  await openRow(page, 'Sort my Downloads');
  frames = await record(page, () => page.click('[data-testid="sd-run-now"]'), 1800);
  measurements['film:run-now'] = writeClip('film-run-now', frames, { spanMs: 1600, crop: clip });
  await page.waitForSelector('[data-testid="sd-stop"]', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.mouse.move(5, 5);
  await shotBoth(page, shot, 'running-real');
  measurements['running-real'] = {
    state: await page.textContent('[data-testid="sd-state"]').catch(() => null),
  };
  await back(page);
  measurements['running-real:row'] = {
    word: await page
      .textContent(`${await rowSel(page, 'Sort my Downloads')} .sd-row-word`)
      .catch(() => null),
    first: (await rowNames(page))[0],
  };
  await shot('running-real-list-bobble-dark');
  await openRow(page, 'Sort my Downloads');
  frames = await record(page, () => page.click('[data-testid="sd-stop"]'), 1200);
  measurements['film:stop'] = writeClip('film-stop', frames, { spanMs: 1000, crop: clip });
  await page.waitForSelector('[data-testid="sd-ledger"] .sd-run[data-status="stopped"]', {
    timeout: 10_000,
  });
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5);
  await shot('stopped-bobble-dark');
}

/* ======================================================================== */
/* EMPTY: the first run                                                     */
/* ======================================================================== */

async function emptyBody(ctx) {
  const { page, shot, check } = ctx;
  await page.setViewportSize(WINDOW);
  await page.waitForTimeout(300);
  await openScheduled(page);
  await page.waitForSelector('[data-testid="sd-templates"]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.mouse.move(5, 5);
  await shotBoth(page, shot, 'empty');
  measurements['empty:focused'] = await focusedId(page);
  await measure(page, 'empty', {
    title: '[data-testid="sd-title"]',
    lede: '[data-testid="sd-lede"]',
    emptyTitle: '.sd-empty-title',
    grid: '[data-testid="sd-templates"]',
    row: '[data-testid="sd-template-morning-brief"]',
    tile: '[data-testid="sd-template-morning-brief"] .sd-tile',
    name: '[data-testid="sd-template-morning-brief"] .sd-row-name',
    blurb: '[data-testid="sd-template-morning-brief"] .sd-row-line',
    when: '[data-testid="sd-template-morning-brief"] .sd-row-when',
    plus: '[data-testid="sd-template-morning-brief"] .sd-row-plus',
  });
  measurements['empty:columns'] = await page.getAttribute(
    '[data-testid="sd-templates"]',
    'data-columns',
  );
  measurements['empty:overflows'] = await overflows(page);

  // a suggestion under the pointer
  const row = await boxOf(page, '[data-testid="sd-template-morning-brief"]');
  let frames = await record(page, () => page.mouse.move(row.x + row.w / 2, row.y + row.h / 2), 450);
  measurements['film:suggestion-hover'] = writeClip('film-suggestion-hover', frames, {
    spanMs: 350,
    crop: { x: row.x - 8, y: row.y - 8, w: row.w + 16, h: row.h + 16 },
  });
  await shot('suggestion-hover-bobble-dark');
  await page.mouse.move(5, 5);

  // a suggestion picked: the dialog, prefilled
  await page.click('[data-testid="sd-template-morning-brief"]');
  await page.waitForSelector('[data-testid="sd-editor"]');
  await page.waitForTimeout(400);
  await shotBoth(page, shot, 'template-dialog');
  measurements['template-dialog'] = {
    focused: await focusedId(page),
    name: await page.inputValue('[data-testid="sd-editor-name"]'),
    parse: (await page.$('[data-testid="sd-parse"]')) !== null,
  };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // New task, blank: the sentence, letter by letter — nothing is presented as read until it is
  const content = await contentBox(page);
  frames = await record(page, () => page.click('[data-testid="sd-new"]'), 500);
  measurements['film:new'] = writeClip('film-new', frames, {
    spanMs: 400,
    crop: { x: content.x, y: content.y, w: content.w, h: Math.min(content.h, 640) },
  });
  await page.waitForSelector('[data-testid="sd-editor"]');
  await page.waitForTimeout(300);
  await shotBoth(page, shot, 'new-blank');
  measurements['new-blank:focused'] = await focusedId(page);
  await page.keyboard.type('eve', { delay: 30 });
  await page.waitForTimeout(250);
  await shot('typing-eve-bobble-dark');
  measurements['typing:eve'] = {
    parse: (await page.$('[data-testid="sd-parse"]')) !== null,
    frequency: await page.textContent('[data-testid="sd-editor-frequency"]'),
  };
  check(measurements['typing:eve'].parse === false, '"eve" must not show a reading');
  await page.keyboard.type('ry friday');
  await page.waitForTimeout(250);
  await shot('typing-cadence-bobble-dark');
  measurements['typing:cadence'] = await page.evaluate(() => ({
    read: document.querySelector('[data-testid="sd-parse"]')?.getAttribute('data-read'),
    chip: document.querySelector('[data-testid="sd-parse-schedule"]')?.textContent ?? null,
    hint: document.querySelector('[data-testid="sd-parse-hint"]')?.textContent ?? '',
    frequency: document.querySelector('[data-testid="sd-editor-frequency"]')?.textContent ?? '',
    weekday: document.querySelector('[data-testid="sd-editor-weekday"]')?.textContent ?? '',
  }));
  await page.keyboard.type(' at 4pm, write up what I worked on this week');
  await page.waitForTimeout(250);
  await shotBoth(page, shot, 'typing-full');
  measurements['typing:full'] = await page.evaluate(() => ({
    read: document.querySelector('[data-testid="sd-parse"]')?.getAttribute('data-read'),
    chip: document.querySelector('[data-testid="sd-parse-schedule"]')?.textContent ?? null,
    hint: document.querySelector('[data-testid="sd-parse-hint"]')?.textContent ?? '',
    hour: document.querySelector('[data-testid="sd-editor-hour"]')?.textContent ?? '',
    namePlaceholder:
      document.querySelector('[data-testid="sd-editor-name"]')?.getAttribute('placeholder') ?? '',
    preview: document.querySelector('[data-testid="sd-editor-preview"]')?.textContent ?? '',
  }));
  await page.click('[data-testid="sd-editor-save"]');
  await page.waitForSelector('.sd-list [data-testid^="sd-row-"]', { timeout: 5_000 });
  await page.waitForTimeout(450);
  await page.mouse.move(5, 5);
  await shotBoth(page, shot, 'one-task');
  measurements['one-task'] = {
    focused: await focusedId(page),
    rows: await rowNames(page),
    line: await page.textContent('.sd-list .sd-row-line'),
    more: await page.textContent('[data-testid="sd-more-templates"]'),
  };

  // a sentence with no time in it: no reading is shown, the defaults are the form's own
  await page.click('[data-testid="sd-new"]');
  await page.waitForSelector('[data-testid="sd-editor"]');
  await page.waitForTimeout(300);
  await page.keyboard.type('write up what I worked on this week');
  await page.waitForTimeout(250);
  await shot('typing-no-time-bobble-dark');
  measurements['typing:no-time'] = {
    parse: (await page.$('[data-testid="sd-parse"]')) !== null,
    preview: await page.textContent('[data-testid="sd-editor-preview"]'),
  };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // widths: the empty page, and the dialog at the app's minimum
  for (const [name, size] of WIDTHS) {
    await page.setViewportSize(size);
    await page.waitForTimeout(450);
    // the list has one task now; the suggestions are behind their row — open them
    if ((await page.$('[data-testid="sd-more-templates"]')) !== null) {
      await page.click('[data-testid="sd-more-templates"]');
      await page.waitForTimeout(350);
    }
    await page.mouse.move(5, 5);
    await shot(`width-${name}-bobble-dark`);
    measurements[`width-${name}`] = {
      columns: await page.getAttribute('[data-testid="sd-templates"]', 'data-columns'),
      overflows: await overflows(page),
      header: await boxOf(page, '.sd-header'),
    };
    if (name === 'minimum') {
      await setTheme(page, 'bobble-light');
      await shot('width-minimum-bobble-light');
      await setTheme(page, 'bobble-dark');
      await page.click('[data-testid="sd-new"]');
      await page.waitForSelector('[data-testid="sd-editor"]');
      await page.waitForTimeout(400);
      await shot('width-minimum-dialog-bobble-dark');
      measurements['width-minimum-dialog'] = { dialog: await boxOf(page, '.sd-dialog') };
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    if ((await page.$('[data-testid="sd-more-templates"]')) !== null) {
      await page.click('[data-testid="sd-more-templates"]');
      await page.waitForTimeout(250);
    }
  }
  await page.setViewportSize(WINDOW);
}

if (MODE === 'seeded' || MODE === 'all') await guarded('seeded', seededBody);
if (MODE === 'empty' || MODE === 'all') await guarded('empty', emptyBody);
