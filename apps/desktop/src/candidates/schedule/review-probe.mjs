/**
 * DESIGN-REVIEW PROBE — the shipping Scheduled screen and the Ledger+ candidate,
 * driven by a hand, photographed, measured and filmed. Written for the review in
 * `src/scheduled/DESIGN-REVIEW.md`; every frame that document cites comes from
 * here, under `shots/review/<mode>/`.
 *
 *   MODE=ship        node src/candidates/schedule/review-probe.mjs   # the shipping screen, every state
 *   MODE=cand        node src/candidates/schedule/review-probe.mjs   # Ledger+, seeded, driven
 *   MODE=cand-empty  node src/candidates/schedule/review-probe.mjs   # Ledger+, first run
 *   MODE=cand-chrome node src/candidates/schedule/review-probe.mjs   # Ledger+ inside the real shell
 *   MODE=chat        node src/candidates/schedule/review-probe.mjs   # a task made in the chat, as shipped
 *
 * Built on tests/e2e/harness.mjs: hidden window, throwaway $HOME, mock pi, and
 * the run FAILS if focus moved. Loads the BUILT renderer (dist/), i.e. what the
 * app actually runs — no dev server. Data is real: tasks through `tasks:create`,
 * run records written to the throwaway home's scheduled-runs dir in the exact
 * shape the runner writes, so the shipping drawer reads them from disk the way
 * it would read a real week. One run is REAL — "Run now" through the mock pi —
 * so the running → ok transition is the app's own, not a seeded still.
 *
 * Every state is shot in bobble dark and light. Motion is recorded through
 * CDP's screencast (as shots.mjs does) and written as a GIF + a labelled
 * filmstrip. Computed styles and boxes for the elements the review names are
 * dumped to `measure.json` beside the frames, so a size in the document is a
 * number read from the page, not an estimate.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from '../../../tests/e2e/harness.mjs';
import { AGED_TASK_INDEX, holdStampFor, SEED_RUNS, SEED_TASKS, withRunsDir } from './seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE ?? 'ship';
const OUT = path.join(HERE, 'shots', 'review', MODE);
mkdirSync(OUT, { recursive: true });
process.env.SHOT_DIR = OUT;

const THEMES = process.env.THEMES?.split(',') ?? ['bobble-dark', 'bobble-light'];
/** The user's window: 1512x868 work area clamps the 1440x940 default to this. */
const WINDOW = { width: 1440, height: 868 };
const LAPTOP = { width: 1172, height: 800 };
const SMALL = { width: 900, height: 700 };
const MINIMUM = { width: 760, height: 560 };
const CONTENT_WIDE = { width: 1168, height: 860 };
const CONTENT_MID = { width: 900, height: 800 };
const CONTENT_NARROW = { width: 640, height: 760 };

const measurements = {};
const consoleErrors = [];
/**
 * The screencast delivers frames at the window's DEVICE scale (2× on this
 * Mac), while every box the probe measures is in CSS pixels. The first cut
 * cropped clips in CSS pixels and every strip showed the top-left quadrant of
 * the region it named. Read once per launch; crops are scaled by it.
 */
let DPR = 1;

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
  await page.waitForTimeout(180);
}

function watchConsole(page) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      consoleErrors.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${String(e).slice(0, 300)}`));
}

/** Pin the renderer's clock; reloads once, before anything is seeded. */
async function freezeClock(page, now, ready) {
  await page.addInitScript((frozen) => {
    Date.now = () => frozen;
  }, now);
  await page.reload();
  await page.waitForSelector(ready, { timeout: 30_000 });
}

/** Computed style + box for a selector (first match), for the measure dump. */
async function measure(page, label, selectors) {
  const out = {};
  for (const [name, sel] of Object.entries(selectors)) {
    out[name] = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el === null) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? '').trim().slice(0, 60),
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
        outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor} offset ${cs.outlineOffset}`,
        transition:
          cs.transitionProperty === 'all' || cs.transitionProperty === 'none'
            ? cs.transitionProperty
            : `${cs.transitionProperty} ${cs.transitionDuration}`,
        animation: cs.animationName,
        opacity: cs.opacity,
      };
    }, sel);
  }
  measurements[label] = out;
  return out;
}

/** Tab through the page from `start`, recording where focus lands and whether a ring is drawn. */
async function tabOrder(page, label, { start, max = 40, until } = {}) {
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
        ring: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`,
        boxShadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 80),
        visible: r.width > 0 && r.height > 0,
        y: Math.round(r.y),
      };
    });
    stops.push(s);
    if (until !== undefined && (s.testid === until || s.tag === 'BODY')) break;
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
  const dir = mkdtempSync(path.join(tmpdir(), `pd-review-film-${name}-`));
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

/** Run records on disk, exactly where and how the runner writes them. */
function writeRunFiles(runsDir, ids, now) {
  const out = {};
  ids.forEach((id, i) => {
    const runs = SEED_RUNS[i];
    if (runs === undefined) return;
    const dir = path.join(runsDir, id);
    mkdirSync(dir, { recursive: true });
    out[id] = runs(now).map((r) => ({ ...r, taskId: id }));
    for (const r of out[id])
      writeFileSync(path.join(dir, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
  });
  return out;
}

function prepareRunsDir(home) {
  const runsDir = path.join(home, '.pi', 'desktop', 'scheduled-runs');
  mkdirSync(path.join(runsDir, 'task', 'run_h2'), { recursive: true });
  copyFileSync(
    path.join(HERE, 'fixtures', 'portrait.png'),
    path.join(runsDir, 'task', 'run_h2', 'portrait.png'),
  );
  withRunsDir(runsDir);
  return runsDir;
}

async function guarded(launch, body) {
  const ctx = await launch();
  watchConsole(ctx.page);
  DPR = await ctx.page.evaluate(() => window.devicePixelRatio);
  measurements.devicePixelRatio = DPR;
  try {
    await body(ctx);
  } finally {
    writeFileSync(path.join(OUT, 'measure.json'), `${JSON.stringify(measurements, null, 2)}\n`);
    writeFileSync(path.join(OUT, 'console.txt'), `${consoleErrors.join('\n')}\n`);
    await ctx.finish();
  }
}

/* ======================================================================== */
/* SHIP: the shipping Scheduled screen                                        */
/* ======================================================================== */

const NAV = '[data-testid="nav-scheduled"]';
const VIEW = '[data-testid="scheduled-view"]';

async function openScheduled(page) {
  await page.click(NAV);
  await page.waitForSelector(VIEW, { timeout: 10_000 });
  await page.waitForTimeout(350);
}

/**
 * Close the past-runs drawer. Escape is tried first because that is what a
 * person does; the drawer has no key handler (measured: `ship-drawer:escape-closes`),
 * so the ✕ is the fallback — and the fact is recorded, not papered over.
 */
async function closeDrawer(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const stillOpen = (await page.$('[data-testid="task-runs"]')) !== null;
  measurements['ship-drawer:escape-closes'] = !stillOpen;
  if (stillOpen) await page.click('[data-testid="task-runs-close"]');
  await page.waitForTimeout(250);
}

/** The shipping store only re-reads on mount: leave and come back. */
async function remountScheduled(page) {
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForSelector('[data-testid="models-view"]', { timeout: 10_000 });
  await openScheduled(page);
}

async function ship() {
  await guarded(() => launchApp('review-ship'), shipBody);
}

async function shipBody(ctx) {
  const { page, shot, check, home } = ctx;
  const runsDir = prepareRunsDir(home);
  await page.setViewportSize(WINDOW);
  const now = Date.now();
  await freezeClock(page, now, '.pd-composer-editor');
  await page.waitForTimeout(400);

  /* ---- 1. empty, both themes, then hover / focus / typing ---------------- */
  await openScheduled(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`ship-empty-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  await measure(page, 'ship-empty', {
    h1: `${VIEW} h1`,
    subtitle: `${VIEW} header p`,
    schedulingPill: '[data-testid="tasks-enabled"]',
    newTask: '[data-testid="tasks-new"]',
    quickInput: '[data-testid="tasks-quick-input"]',
    quickGo: '[data-testid="tasks-quick-go"]',
    emptyLine: '[data-testid="tasks-empty"] > p',
    templateCard: '[data-testid="tasks-template-morning-brief"]',
    templateName: '[data-testid="tasks-template-morning-brief"] > span:first-child',
    templateIcon: '[data-testid="tasks-template-morning-brief"] > span:first-child > span',
    templateBlurb: '[data-testid="tasks-template-morning-brief"] > span:last-child',
    container: `${VIEW} > div`,
  });
  // the template under the pointer, and the empty screen's first Tab stops
  await page.hover('[data-testid="tasks-template-morning-brief"]');
  await page.waitForTimeout(250);
  await shot('ship-empty-template-hover-bobble-dark');
  await measure(page, 'ship-empty-template-hover', {
    card: '[data-testid="tasks-template-morning-brief"]',
  });
  await page.mouse.move(5, 5);
  const emptyTabs = await tabOrder(page, 'ship-empty', {
    start: '[data-testid="tasks-enabled"]',
    max: 16,
  });
  // photograph the ring where it lands on a template card
  await page.focus('[data-testid="tasks-template-morning-brief"]');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(120);
  await shot('ship-empty-focus-template-bobble-dark');
  await page.focus('[data-testid="tasks-enabled"]');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(120);
  await shot('ship-empty-focus-pill-bobble-dark');
  check(emptyTabs.length > 0, 'no tab stops on the empty screen');

  // the composer typed into: is anything parsed live?
  await page.click('[data-testid="tasks-quick-input"]');
  await page.keyboard.type('every friday at 4pm, write up what I worked on this week');
  await page.waitForTimeout(250);
  await shot('ship-empty-quick-typed-bobble-dark');
  await measure(page, 'ship-quick-typed', {
    input: '[data-testid="tasks-quick-input"]',
    go: '[data-testid="tasks-quick-go"]',
  });
  // ↵ → the dialog, prefilled
  const listBefore = await boxOf(page, '[data-testid="tasks-empty"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="task-dialog"]', { timeout: 5000 });
  await page.waitForTimeout(320);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`ship-dialog-from-sentence-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  const nameFromSentence = await page.inputValue('[data-testid="task-name"]');
  measurements['ship-dialog-from-sentence:name'] = nameFromSentence;
  measurements['ship-dialog-from-sentence:focused'] = await focusedId(page);
  await measure(page, 'ship-dialog', {
    panel: '[data-testid="task-dialog"] > div.relative',
    backdrop: '[data-testid="task-dialog"] > button',
    title: '[data-testid="task-dialog"] h2',
    close: '[data-testid="task-dialog-close"]',
    nameLabel: '[data-testid="task-dialog"] label',
    name: '[data-testid="task-name"]',
    prompt: '[data-testid="task-prompt"]',
    hint: '[data-testid="task-prompt"] + p',
    frequency: '[data-testid="task-frequency"]',
    hour: '[data-testid="task-hour"]',
    minute: '[data-testid="task-minute"]',
    preview: '[data-testid="task-when-preview"]',
    folder: '[data-testid="task-folder"]',
    enabled: '[data-testid="task-enabled"]',
    cancel: '[data-testid="task-cancel"]',
    save: '[data-testid="task-save"]',
  });
  await tabOrder(page, 'ship-dialog', { start: '[data-testid="task-name"]', max: 14 });
  // the pickers open
  await page.click('[data-testid="task-frequency"]');
  await page.waitForTimeout(250);
  await shot('ship-dialog-frequency-open-bobble-dark');
  await measure(page, 'ship-dialog-frequency-menu', {
    menu: '[data-testid="task-frequency-menu"]',
    item: '[data-testid="task-frequency-opt-weekly"]',
  });
  await page.click('[data-testid="task-frequency-opt-weekly"]');
  await page.waitForTimeout(250);
  await shot('ship-dialog-weekly-bobble-dark');
  await page.click('[data-testid="task-hour"]');
  await page.waitForTimeout(250);
  await shot('ship-dialog-hour-open-bobble-dark');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  // Escape while a picker is open: did it close the picker, or the whole dialog?
  measurements['ship-dialog:escape-with-picker-open-closed-dialog'] =
    (await page.$('[data-testid="task-dialog"]')) === null;
  if ((await page.$('[data-testid="task-dialog"]')) !== null) {
    await page.click('[data-testid="task-folder"]');
    await page.waitForTimeout(250);
    await shot('ship-dialog-folder-open-bobble-dark');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    if ((await page.$('[data-testid="task-dialog"]')) !== null) {
      await page.click('[data-testid="task-cancel"]');
    }
  }
  await page.waitForTimeout(250);
  const listAfter = await boxOf(page, '[data-testid="tasks-empty"]');
  measurements['ship-dialog:page-moved-under-dialog'] =
    JSON.stringify(listBefore) !== JSON.stringify(listAfter);
  measurements['ship-dialog:focus-after-close'] = await focusedId(page);
  measurements['ship-dialog:quick-input-after-close'] = await page.inputValue(
    '[data-testid="tasks-quick-input"]',
  );

  /* ---- 2. film: the dialog appearing and leaving, the template hover ------ */
  const centre = { x: 300, y: 80, w: 900, h: 720 };
  let frames = await record(page, () => page.click('[data-testid="tasks-new"]'), 600);
  measurements['film:ship-dialog-open'] = writeClip('ship-film-dialog-open', frames, {
    spanMs: 400,
    crop: centre,
  });
  await page.waitForTimeout(200);
  frames = await record(page, () => page.keyboard.press('Escape'), 500);
  measurements['film:ship-dialog-close'] = writeClip('ship-film-dialog-close', frames, {
    spanMs: 300,
    crop: centre,
  });
  const cardBox = await boxOf(page, '[data-testid="tasks-template-morning-brief"]');
  if (cardBox !== null) {
    await page.mouse.move(5, 5);
    frames = await record(
      page,
      () => page.hover('[data-testid="tasks-template-morning-brief"]'),
      500,
    );
    measurements['film:ship-template-hover'] = writeClip('ship-film-template-hover', frames, {
      spanMs: 300,
      crop: { x: cardBox.x - 8, y: cardBox.y - 8, w: cardBox.w + 16, h: cardBox.h + 16 },
    });
    await page.mouse.move(5, 5);
  }

  /* ---- 3. a template → the dialog; New task → blank; create one ----------- */
  await page.click('[data-testid="tasks-template-morning-brief"]');
  await page.waitForSelector('[data-testid="task-dialog"]');
  await page.waitForTimeout(300);
  await shot('ship-dialog-template-bobble-dark');
  measurements['ship-dialog-template:focused'] = await focusedId(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.click('[data-testid="tasks-new"]');
  await page.waitForSelector('[data-testid="task-dialog"]');
  await page.waitForTimeout(300);
  measurements['ship-dialog-new:focused'] = await focusedId(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`ship-dialog-new-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  await page.click('[data-testid="task-prompt"]');
  await page.keyboard.type('Run the test suite and tell me only what failed.');
  await page.waitForTimeout(200);
  await shot('ship-dialog-new-typed-bobble-dark');
  measurements['ship-dialog-new-typed:name-placeholder'] = await page.getAttribute(
    '[data-testid="task-name"]',
    'placeholder',
  );
  // Does ⌘↩ save? (the candidate editor does; the reference's Save is a click)
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(300);
  measurements['ship-dialog:cmd-enter-saves'] =
    (await page.$('[data-testid="task-dialog"]')) === null;
  if ((await page.$('[data-testid="task-dialog"]')) !== null) {
    frames = await record(page, () => page.click('[data-testid="task-save"]'), 700);
    measurements['film:ship-create'] = writeClip('ship-film-create', frames, {
      spanMs: 500,
      crop: centre,
    });
  }
  await page.waitForSelector('[data-testid="tasks-list"]', { timeout: 5000 });
  await page.waitForTimeout(350);
  measurements['ship-one-task:focus-after-create'] = await focusedId(page);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`ship-one-task-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  const oneId = (await page.getAttribute('[data-testid^="task-row-"]', 'data-testid')).slice(
    'task-row-'.length,
  );
  measurements['ship-one-task:name'] = await page.textContent(
    `[data-testid="task-row-${oneId}"] p`,
  );
  await measure(page, 'ship-one-task', {
    list: '[data-testid="tasks-list"]',
    row: `[data-testid="task-row-${oneId}"]`,
    dot: `[data-testid="task-toggle-${oneId}"]`,
    name: `[data-testid="task-row-${oneId}"] p:first-of-type`,
    meta: `[data-testid="task-row-${oneId}"] p:last-of-type`,
    next: `[data-testid="task-next-${oneId}"]`,
    runNow: `[data-testid="task-run-${oneId}"]`,
    pastRuns: `[data-testid="task-runs-${oneId}"]`,
    edit: `[data-testid="task-edit-${oneId}"]`,
    del: `[data-testid="task-delete-${oneId}"]`,
  });
  // the empty drawer
  await page.click(`[data-testid="task-runs-${oneId}"]`);
  await page.waitForSelector('[data-testid="task-runs"]');
  await page.waitForTimeout(300);
  await shot('ship-runs-drawer-empty-bobble-dark');
  await measure(page, 'ship-drawer-empty', {
    panel: '[data-testid="task-runs"] > div.relative',
    header: '[data-testid="task-runs"] header',
    title: '[data-testid="task-runs"] h2',
    sub: '[data-testid="task-runs"] header p',
    runNow: '[data-testid="task-runs-run"]',
    empty: '[data-testid="runs-empty"]',
  });
  await closeDrawer(page);

  /* ---- 4. many tasks, with a week of history on disk ---------------------- */
  const ids = await seedTasks(page, now);
  const runsById = writeRunFiles(runsDir, ids, now);
  await remountScheduled(page);
  await page.waitForTimeout(500);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`ship-many-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  const rowIds = await page.$$eval('[data-testid^="task-row-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').slice('task-row-'.length)),
  );
  measurements['ship-many:row-order'] = await page.$$eval('[data-testid^="task-row-"]', (els) =>
    els.map((e) => ({
      name: e.querySelector('p')?.textContent,
      meta: e.querySelectorAll('p')[1]?.textContent,
      next: e.querySelector('[data-testid^="task-next-"]')?.textContent,
      run: e.querySelector('[data-testid^="task-run-"]')?.textContent,
      h: Math.round(e.getBoundingClientRect().height),
    })),
  );
  const byName = (name) => ids[SEED_TASKS.findIndex((t) => t.name === name)];
  const morning = byName('Morning brief');
  const portrait = byName('Portrait of the day');
  const downloads = byName('Sort my Downloads');
  const deps = byName('Dependency check');
  const missed = byName('What did I miss');
  await measure(page, 'ship-many', {
    row: `[data-testid="task-row-${morning}"]`,
    name: `[data-testid="task-row-${morning}"] p:first-of-type`,
    meta: `[data-testid="task-row-${morning}"] p:last-of-type`,
    next: `[data-testid="task-next-${morning}"]`,
    pausedName: `[data-testid="task-row-${deps}"] p:first-of-type`,
    pausedNext: `[data-testid="task-next-${deps}"]`,
    runningLabel: `[data-testid="task-run-${portrait}"]`,
  });
  // hover a row: does the row respond? then a button
  await page.hover(`[data-testid="task-row-${morning}"] p`);
  await page.waitForTimeout(250);
  await shot('ship-many-row-hover-bobble-dark');
  await measure(page, 'ship-many-row-hover', { row: `[data-testid="task-row-${morning}"]` });
  await page.hover(`[data-testid="task-run-${morning}"]`);
  await page.waitForTimeout(250);
  await shot('ship-many-button-hover-bobble-dark');
  await page.mouse.move(5, 5);
  await tabOrder(page, 'ship-many', { start: '[data-testid="tasks-quick-go"]', max: 12 });
  await page.focus(`[data-testid="task-toggle-${morning}"]`);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(120);
  await shot('ship-many-focus-dot-bobble-dark');

  // pause / resume, and film the dot
  const rowBox = await boxOf(page, `[data-testid="task-row-${morning}"]`);
  frames = await record(page, () => page.click(`[data-testid="task-toggle-${morning}"]`), 500);
  measurements['film:ship-pause'] = writeClip('ship-film-pause', frames, {
    spanMs: 300,
    crop: { x: rowBox.x, y: rowBox.y - 4, w: rowBox.w, h: rowBox.h + 8 },
  });
  await page.waitForTimeout(200);
  await shot('ship-many-paused-row-bobble-dark');
  await page.click(`[data-testid="task-toggle-${morning}"]`);
  await page.waitForTimeout(300);

  // scheduling off
  const listBox = await boxOf(page, '[data-testid="tasks-list"]');
  await page.click('[data-testid="tasks-enabled"]');
  await page.waitForTimeout(350);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`ship-many-off-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  measurements['ship-off:list-moved-by'] =
    (await boxOf(page, '[data-testid="tasks-list"]')).y - listBox.y;
  await measure(page, 'ship-off', {
    note: '[data-testid="tasks-off-note"]',
    pill: '[data-testid="tasks-enabled"]',
    next: `[data-testid="task-next-${morning}"]`,
  });
  await page.click('[data-testid="tasks-enabled"]');
  await page.waitForTimeout(300);

  // delete: armed, disarmed by leaving, then for real on the paused task
  await page.click(`[data-testid="task-delete-${deps}"]`);
  await page.waitForTimeout(200);
  await shot('ship-many-delete-armed-bobble-dark');
  await measure(page, 'ship-delete-armed', { btn: `[data-testid="task-delete-${deps}"]` });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  measurements['ship-delete:disarmed-on-leave'] =
    (await page.textContent(`[data-testid="task-delete-${deps}"]`)) === 'Delete';
  await page.click(`[data-testid="task-delete-${deps}"]`);
  await page.waitForTimeout(100);
  const depsRow = await boxOf(page, `[data-testid="task-row-${deps}"]`);
  frames = await record(page, () => page.click(`[data-testid="task-delete-${deps}"]`), 600);
  measurements['film:ship-delete'] = writeClip('ship-film-delete', frames, {
    spanMs: 400,
    crop: { x: listBox.x, y: depsRow.y - 60, w: listBox.w, h: 200 },
  });
  measurements['ship-delete:row-gone'] =
    (await page.$(`[data-testid="task-row-${deps}"]`)) === null;

  // edit
  await page.click(`[data-testid="task-edit-${morning}"]`);
  await page.waitForSelector('[data-testid="task-dialog"]');
  await page.waitForTimeout(300);
  await shot('ship-dialog-edit-bobble-dark');
  measurements['ship-dialog-edit:focused'] = await focusedId(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  /* ---- 5. past runs: ok / failed / running / artifact, from disk ---------- */
  await page.click(`[data-testid="task-runs-${morning}"]`);
  await page.waitForSelector('[data-testid="run-card-run_a1"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`ship-runs-drawer-week-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  await measure(page, 'ship-drawer-week', {
    card: '[data-testid="run-card-run_a1"]',
    when: '[data-testid="run-card-run_a1"] > div > span:nth-child(2)',
    took: '[data-testid="run-card-run_a1"] > div > span:nth-child(3)',
    summary: '[data-testid="run-card-run_a1"] > p',
    trail: '[data-testid="run-card-run_a1"] > p:last-child',
    del: '[data-testid="run-delete-run_a1"]',
    errCard: '[data-testid="run-card-run_a3"]',
    err: '[data-testid="run-card-run_a3"] > p',
  });
  await page.hover('[data-testid="run-card-run_a1"]');
  await page.waitForTimeout(200);
  await shot('ship-runs-drawer-card-hover-bobble-dark');
  await closeDrawer(page);
  // the running record + the picture
  await page.click(`[data-testid="task-runs-${portrait}"]`);
  await page.waitForSelector('[data-testid="run-card-run_h1"]', { timeout: 5000 });
  await page.waitForTimeout(500);
  await shot('ship-runs-drawer-running-artifact-bobble-dark');
  measurements['ship-drawer-artifact:img-loaded'] = await page.evaluate(() => {
    const img = document.querySelector('[data-testid="run-artifact"] img');
    return img instanceof HTMLImageElement
      ? { complete: img.complete, naturalWidth: img.naturalWidth }
      : null;
  });
  await closeDrawer(page);

  /* ---- 6. a REAL run: Run now on a by-hand task, through the mock pi ------- */
  const dlRow = await boxOf(page, `[data-testid="task-row-${downloads}"]`);
  frames = await record(page, () => page.click(`[data-testid="task-run-${downloads}"]`), 1500);
  measurements['film:ship-run-now'] = writeClip('ship-film-run-now', frames, {
    spanMs: 1200,
    crop: { x: dlRow.x, y: dlRow.y - 4, w: dlRow.w, h: dlRow.h + 8 },
  });
  await page.waitForTimeout(200);
  await shot('ship-many-running-bobble-dark');
  // wait for it to finish (mock pi is quick), watching the row label
  let finished = false;
  for (let i = 0; i < 60; i++) {
    const label = await page.textContent(`[data-testid="task-run-${downloads}"]`);
    if (label === 'Run now') {
      finished = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  measurements['ship-run-now:finished'] = finished;
  await page.waitForTimeout(300);
  await shot('ship-many-after-run-bobble-dark');
  await page.click(`[data-testid="task-runs-${downloads}"]`);
  await page.waitForSelector('[data-testid="task-runs"]');
  await page.waitForTimeout(500);
  await shot('ship-runs-drawer-real-run-bobble-dark');
  measurements['ship-run-now:drawer-cards'] = await page.$$eval(
    '[data-testid^="run-card-"]',
    (els) =>
      els.map((e) => ({
        status: e.getAttribute('data-status'),
        text: (e.textContent ?? '').slice(0, 160),
      })),
  );
  await closeDrawer(page);

  /* ---- 7. sizes: laptop, small, minimum ----------------------------------- */
  for (const [name, size] of [
    ['laptop', LAPTOP],
    ['small', SMALL],
    ['minimum', MINIMUM],
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    await shot(`ship-many-${name}-bobble-dark`);
    measurements[`ship-${name}:rows`] = await page.$$eval('[data-testid^="task-row-"]', (els) =>
      els.slice(0, 4).map((e) => ({
        h: Math.round(e.getBoundingClientRect().height),
        wraps: e.getBoundingClientRect().height > 60,
      })),
    );
  }
  await page.setViewportSize(MINIMUM);
  await page.click('[data-testid="tasks-new"]');
  await page.waitForSelector('[data-testid="task-dialog"]');
  await page.waitForTimeout(300);
  await shot('ship-dialog-minimum-bobble-dark');
  await page.keyboard.press('Escape');
  await page.setViewportSize(WINDOW);
  await page.waitForTimeout(300);
  check(ids.length === SEED_TASKS.length, `seeded ${ids.length} of ${SEED_TASKS.length}`);
  check(Object.keys(runsById).length > 0, 'no run files written');
  check(rowIds.length >= SEED_TASKS.length, `list shows ${rowIds.length} rows`);
  measurements['ship:missed-task-next'] = await page
    .textContent(`[data-testid="task-next-${missed}"]`)
    .catch(() => null);
}

/* ======================================================================== */
/* SHIP-MOTION: the list-level transitions, filmed on the whole content area  */
/* ======================================================================== */

/**
 * The row-cropped clips in MODE=ship could not show what happens to the REST
 * of the list when one row changes — and that is where the shipping screen
 * moves: a pause re-sorts the row, the kill switch reshuffles and pushes the
 * list, an armed Delete shoves its neighbours, the drawer arrives. Filmed on
 * the content area, with ten tasks seeded and their histories on disk.
 */
async function shipMotion() {
  await guarded(() => launchApp('review-ship-motion'), shipMotionBody);
}

async function shipMotionBody(ctx) {
  const { page, home, check } = ctx;
  const runsDir = prepareRunsDir(home);
  await page.setViewportSize(WINDOW);
  const now = Date.now();
  await freezeClock(page, now, '.pd-composer-editor');
  await page.waitForTimeout(400);
  await openScheduled(page);
  await setTheme(page, 'bobble-dark');
  const content = { x: 272, y: 44, w: 1168, h: 824 };

  // EMPTY first: a template under the pointer, and the dialog arriving from ↵ and leaving.
  const card = await boxOf(page, '[data-testid="tasks-template-morning-brief"]');
  await page.mouse.move(5, 5);
  let frames = await record(
    page,
    () => page.hover('[data-testid="tasks-template-morning-brief"]'),
    500,
  );
  measurements['film:ship-template-hover'] = writeClip('ship-film-template-hover', frames, {
    spanMs: 300,
    crop: { x: card.x - 8, y: card.y - 8, w: card.w + 16, h: card.h + 16 },
  });
  await page.mouse.move(5, 5);
  await page.click('[data-testid="tasks-quick-input"]');
  await page.keyboard.type('every friday at 4pm, write up what I worked on this week');
  await page.waitForTimeout(200);
  frames = await record(page, () => page.keyboard.press('Enter'), 600);
  measurements['film:ship-dialog-open'] = writeClip('ship-film-dialog-open', frames, {
    spanMs: 400,
    crop: content,
  });
  await page.waitForTimeout(200);
  frames = await record(page, () => page.keyboard.press('Escape'), 500);
  measurements['film:ship-dialog-close'] = writeClip('ship-film-dialog-close', frames, {
    spanMs: 300,
    crop: content,
  });
  await page.waitForTimeout(200);
  // …and a task being created: the dialog leaving and the list appearing where the templates were.
  await page.click('[data-testid="tasks-template-test-run"]');
  await page.waitForSelector('[data-testid="task-dialog"]');
  await page.waitForTimeout(300);
  frames = await record(page, () => page.click('[data-testid="task-save"]'), 700);
  measurements['film:ship-create'] = writeClip('ship-film-create', frames, {
    spanMs: 500,
    crop: content,
  });
  await page.waitForTimeout(300);

  const ids = await seedTasks(page, now);
  writeRunFiles(runsDir, ids, now);
  await remountScheduled(page);
  await page.waitForTimeout(500);
  const byName = (name) => ids[SEED_TASKS.findIndex((t) => t.name === name)];
  const morning = byName('Morning brief');
  const deps = byName('Dependency check');
  const downloads = byName('Sort my Downloads');

  // Run now, for real, through the mock pi: the row while it runs and when it ends.
  frames = await record(page, () => page.click(`[data-testid="task-run-${downloads}"]`), 2500);
  measurements['film:ship-run-now'] = writeClip('ship-film-run-now', frames, {
    spanMs: 2200,
    crop: content,
  });
  await page.waitForTimeout(500);

  // the drawer arriving and leaving
  frames = await record(page, () => page.click(`[data-testid="task-runs-${morning}"]`), 700);
  measurements['film:ship-drawer-open'] = writeClip('ship-film-drawer-open', frames, {
    spanMs: 400,
    crop: content,
  });
  await page.waitForTimeout(300);
  frames = await record(page, () => page.click('[data-testid="task-runs-close"]'), 600);
  measurements['film:ship-drawer-close'] = writeClip('ship-film-drawer-close', frames, {
    spanMs: 300,
    crop: content,
  });
  await page.waitForTimeout(300);

  // pause: the row leaves its place
  const before = await boxOf(page, `[data-testid="task-row-${morning}"]`);
  frames = await record(page, () => page.click(`[data-testid="task-toggle-${morning}"]`), 700);
  measurements['film:ship-pause-list'] = writeClip('ship-film-pause-list', frames, {
    spanMs: 400,
    crop: content,
  });
  const after = await boxOf(page, `[data-testid="task-row-${morning}"]`);
  measurements['ship-pause:row-moved-by'] = after.y - before.y;
  await page.click(`[data-testid="task-toggle-${morning}"]`);
  await page.waitForTimeout(400);
  measurements['ship-resume:row-back-at'] =
    (await boxOf(page, `[data-testid="task-row-${morning}"]`)).y - before.y;

  // the kill switch: banner, dots, order
  const orderBefore = await page.$$eval('[data-testid^="task-row-"] p:first-of-type', (els) =>
    els.map((e) => e.textContent),
  );
  frames = await record(page, () => page.click('[data-testid="tasks-enabled"]'), 700);
  measurements['film:ship-off'] = writeClip('ship-film-off', frames, {
    spanMs: 400,
    crop: content,
  });
  const orderAfter = await page.$$eval('[data-testid^="task-row-"] p:first-of-type', (els) =>
    els.map((e) => e.textContent),
  );
  measurements['ship-off:order-before'] = orderBefore;
  measurements['ship-off:order-after'] = orderAfter;
  measurements['ship-off:reordered'] = JSON.stringify(orderBefore) !== JSON.stringify(orderAfter);
  frames = await record(page, () => page.click('[data-testid="tasks-enabled"]'), 700);
  measurements['film:ship-on'] = writeClip('ship-film-on', frames, { spanMs: 400, crop: content });
  await page.waitForTimeout(300);

  // Delete armed: the neighbours move
  const runNowBefore = await boxOf(page, `[data-testid="task-run-${deps}"]`);
  frames = await record(page, () => page.click(`[data-testid="task-delete-${deps}"]`), 500);
  measurements['film:ship-delete-arm'] = writeClip('ship-film-delete-arm', frames, {
    spanMs: 300,
    crop: content,
  });
  const runNowAfter = await boxOf(page, `[data-testid="task-run-${deps}"]`);
  measurements['ship-delete-arm:run-now-moved-by'] = runNowAfter.x - runNowBefore.x;
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);

  // New task from the list state: does the list move under the dialog?
  const listBefore = await boxOf(page, '[data-testid="tasks-list"]');
  await page.click('[data-testid="tasks-new"]');
  await page.waitForSelector('[data-testid="task-dialog"]');
  await page.waitForTimeout(300);
  measurements['ship-dialog-over-list:list-moved-by'] =
    (await boxOf(page, '[data-testid="tasks-list"]')).y - listBefore.y;
  measurements['ship-dialog-over-list:scroll-locked'] = await page.evaluate(() => {
    const v = document.querySelector('[data-testid="scheduled-view"]');
    if (!(v instanceof HTMLElement)) return null;
    const before = v.scrollTop;
    v.scrollTop = 200;
    const moved = v.scrollTop !== before;
    v.scrollTop = before;
    return !moved;
  });
  await page.keyboard.press('Escape');
  check(ids.length === SEED_TASKS.length, `seeded ${ids.length}`);
}

/* ======================================================================== */
/* CAND-MOTION: Ledger+'s transitions, filmed with the crop at device scale   */
/* ======================================================================== */

async function candMotion() {
  await guarded(() => launchCand(), candMotionBody);
}

async function candMotionBody(ctx) {
  const { page, check } = ctx;
  const { now } = await prepareCand(ctx, { empty: true });
  await setState(page, 'default');
  const page1 = { x: 0, y: 44, w: 1168, h: 816 };
  const slot = { x: 0, y: 44, w: 1168, h: 300 };

  // EMPTY: a template under the pointer (the tile swaps to "+"), then the sentence, ↵, Edit sentence.
  const card = await boxOf(page, '[data-testid="sc-template-morning-brief"]');
  await page.mouse.move(5, 5);
  let frames = await record(
    page,
    () => page.hover('[data-testid="sc-template-morning-brief"]'),
    500,
  );
  measurements['film:cand-template-hover'] = writeClip('cand-film-template-hover', frames, {
    spanMs: 300,
    crop: { x: card.x - 8, y: card.y - 8, w: card.w + 16, h: card.h + 16 },
  });
  await page.mouse.move(5, 5);
  await page.click(COMPOSER);
  frames = await record(
    page,
    () => page.keyboard.type('every friday at 4pm, write up', { delay: 40 }),
    400,
  );
  measurements['film:cand-typing'] = writeClip('cand-film-typing', frames, {
    spanMs: 1500,
    crop: slot,
  });
  await page.keyboard.type(' what I worked on this week');
  await page.waitForTimeout(300);
  frames = await record(page, () => page.keyboard.press('Enter'), 700);
  measurements['film:cand-enter'] = writeClip('cand-film-enter', frames, {
    spanMs: 420,
    crop: page1,
  });
  await page.waitForTimeout(200);
  frames = await record(page, () => page.click('[data-testid="sc-sentence-strip-action"]'), 700);
  measurements['film:cand-edit-sentence'] = writeClip('cand-film-edit-sentence', frames, {
    spanMs: 420,
    crop: slot,
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Now seed a week of history through the same seams the seeded run uses, and reload the store.
  const ids = await seedTasks(page, now);
  const runs = {};
  ids.forEach((id, i) => {
    const r = SEED_RUNS[i];
    if (r !== undefined) runs[id] = r(now).map((x) => ({ ...x, taskId: id }));
  });
  await page.evaluate((r) => window.__scheduleCandidates.seedRuns(r), runs);
  await page.evaluate(() => window.__scheduleCandidates.reload());
  await page.waitForTimeout(500);
  await setState(page, 'default');
  await page.mouse.move(5, 5);

  // the pane swap, the run-now transition, the kill switch, Edit, the delete arm
  frames = await record(page, () => page.click(ROW('Portrait of the day')), 700);
  measurements['film:cand-pane-swap'] = writeClip('cand-film-pane-swap', frames, {
    spanMs: 420,
    crop: page1,
  });
  await page.waitForTimeout(200);
  await page.click(ROW('Sort my Downloads'));
  await page.waitForTimeout(400);
  frames = await record(page, () => page.click('[data-testid="sc-run-now"]'), 2500);
  measurements['film:cand-run-now'] = writeClip('cand-film-run-now', frames, {
    spanMs: 2200,
    crop: page1,
  });
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);
  frames = await record(page, () => page.click('[data-testid="sc-scheduling-switch"]'), 700);
  measurements['film:cand-switch-off'] = writeClip('cand-film-switch-off', frames, {
    spanMs: 500,
    crop: page1,
  });
  await page.waitForTimeout(300);
  await page.click('[data-testid="sc-scheduling-switch"]');
  await page.waitForTimeout(300);
  await setState(page, 'default');
  frames = await record(page, () => page.click('[data-testid="sc-edit"]'), 700);
  measurements['film:cand-edit'] = writeClip('cand-film-edit', frames, {
    spanMs: 420,
    crop: page1,
  });
  await page.click('[data-testid="sc-edit-strip-action"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const f = document.querySelector('[data-testid="sc-delete-footer"]');
    const v = f?.closest('.pd-scroll');
    if (v instanceof HTMLElement) v.scrollTop = v.scrollHeight;
  });
  await page.waitForTimeout(300);
  const footer = await boxOf(page, '[data-testid="sc-delete-footer"]');
  frames = await record(page, () => page.click('[data-testid="sc-delete"]'), 500);
  measurements['film:cand-delete-arm'] = writeClip('cand-film-delete-arm', frames, {
    spanMs: 300,
    crop: { x: footer.x - 8, y: footer.y - 24, w: footer.w + 16, h: footer.h + 48 },
  });
  check(ids.length === SEED_TASKS.length, `seeded ${ids.length}`);
}

/* ======================================================================== */
/* CAND: Ledger+                                                             */
/* ======================================================================== */

const SHELL_READY = '[data-testid="candidate-shell"]';
const CHROME_READY = '[data-testid="sc-app-chrome"] [data-testid="sc-ledger-plus"]';
const ROW = (name) => `[data-testid^="sc-ledger-row-"]:has-text("${name}")`;
const COMPOSER = '[data-testid="sc-composer-input"]';

function launchCand(extra = {}) {
  return launchApp('review-cand', {
    env: { PI_DESKTOP_CANDIDATES: 'schedule', ...extra },
    waitFor: extra.PI_DESKTOP_CANDIDATE_V === undefined ? SHELL_READY : CHROME_READY,
  });
}

async function prepareCand(
  ctx,
  { empty = false, ready = SHELL_READY, viewport = CONTENT_WIDE } = {},
) {
  const { page, home } = ctx;
  prepareRunsDir(home);
  const now = Date.now();
  await freezeClock(page, now, ready);
  await page.waitForFunction(() => typeof window.__scheduleCandidates?.seedRuns === 'function');
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);
  const ids = empty ? [] : await seedTasks(page, now);
  const runs = {};
  ids.forEach((id, i) => {
    const r = SEED_RUNS[i];
    if (r !== undefined) runs[id] = r(now).map((x) => ({ ...x, taskId: id }));
  });
  await page.evaluate((r) => window.__scheduleCandidates.seedRuns(r), runs);
  await page.evaluate(() => window.__scheduleCandidates.reload());
  await page.waitForTimeout(400);
  return { ids, now };
}

const setState = async (page, s) => {
  await page.evaluate(
    ([cid, st]) => window.__scheduleCandidates.setState?.(cid, st),
    ['ledger-plus', s],
  );
  await page.waitForTimeout(320);
};

async function cand() {
  await guarded(() => launchCand(), candBody);
}

async function candBody(ctx) {
  const { page, shot, check } = ctx;
  const { ids } = await prepareCand(ctx);
  const active = await page.getAttribute('[data-testid="candidate-tab-ledger-plus"]', 'data-state');
  if (active !== 'active') await page.click('[data-testid="candidate-tab-ledger-plus"]');
  await page.waitForTimeout(350);
  const byName = (name) => ids[SEED_TASKS.findIndex((t) => t.name === name)];

  await setState(page, 'default');
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`cand-default-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  await measure(page, 'cand-default', {
    h1: '.sc-title',
    subtitle: '.sc-subtitle',
    switchLabel: '[data-testid="sc-scheduling-switch"]',
    newTask: '[data-testid="sc-new"]',
    composer: '.sc-composer',
    composerInput: COMPOSER,
    go: '[data-testid="sc-composer-go"]',
    lane: '[data-testid="sc-lane"]',
    listHead: '[data-testid="sc-ledger-search"]',
    group: '.sc-list-group',
    row: '.sc-row',
    rowName: '.sc-row .sc-row-name',
    rowMeta: '.sc-row .sc-row-meta',
    selectedRow: '.sc-row[data-selected="true"]',
    detailTitle: '.sc-detail-title',
    detailSub: '[data-testid="sc-ledger-detail"] > div p',
    runNow: '[data-testid="sc-run-now"]',
    edit: '[data-testid="sc-edit"]',
    prompt: '.sc-prompt',
    section: '.sc-section-title',
    facts: '.sc-facts',
    runWhen: '.sc-run-when',
    runTook: '.sc-run-took',
    runHeadline: '.sc-run-headline',
    runBody: '.sc-run-body',
    footer: '[data-testid="sc-delete-footer"]',
    deleteBtn: '[data-testid="sc-delete"]',
    pane: '[data-testid="sc-panes"] section > div > div',
  });
  // full Tab order across the page
  await tabOrder(page, 'cand-default', { start: '[data-testid="sc-scheduling-switch"]', max: 40 });

  // typing, ↵, and the strip
  await page.click(COMPOSER);
  await page.keyboard.type('every friday at 4pm, write up what I worked on this week');
  await page.waitForTimeout(300);
  await shot('cand-typing-bobble-dark');
  await measure(page, 'cand-typing', {
    chip: '.sc-parse .sc-chip',
    quote: '.sc-parse > span:not(.sc-chip)',
    hint: '.sc-parse-hint',
    go: '[data-testid="sc-composer-go"]',
  });
  const listHeadBefore = await boxOf(page, '[data-testid="sc-ledger-search"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`cand-review-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  measurements['cand-review:list-head-moved-by'] =
    (await boxOf(page, '[data-testid="sc-ledger-search"]')).y - listHeadBefore.y;
  measurements['cand-review:focused'] = await focusedId(page);
  measurements['cand-review:name'] = await page.inputValue('[data-testid="sc-editor-name"]');
  await measure(page, 'cand-editor', {
    strip: '.sc-strip',
    stripText: '.sc-strip-text',
    heading: '[data-testid="sc-panes"] h2',
    lead: '[data-testid="sc-editor"] > p',
    label: '.sc-field-label',
    prompt: '[data-testid="sc-editor-prompt"]',
    name: '[data-testid="sc-editor-name"]',
    frequency: '[data-testid="sc-editor-frequency"]',
    preview: '[data-testid="sc-editor-preview"]',
    save: '[data-testid="sc-editor-save"]',
    cancel: '[data-testid="sc-editor-cancel"]',
  });
  await tabOrder(page, 'cand-editor', { start: '[data-testid="sc-scheduling-switch"]', max: 30 });
  // open the frequency select
  await page.click('[data-testid="sc-editor-frequency"]');
  await page.waitForTimeout(300);
  await shot('cand-editor-frequency-open-bobble-dark');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  measurements['cand-editor:escape-on-select-closed-editor'] =
    (await page.$('[data-testid="sc-editor"]')) === null;
  // save it for real
  if ((await page.$('[data-testid="sc-editor-save"]')) !== null) {
    const slot = { x: 0, y: 40, w: 1168, h: 420 };
    const frames0 = await record(page, () => page.click('[data-testid="sc-editor-save"]'), 800);
    measurements['film:cand-save'] = writeClip('cand-film-save', frames0, {
      spanMs: 600,
      crop: slot,
    });
  }
  await page.waitForTimeout(400);
  await shot('cand-after-save-bobble-dark');
  measurements['cand-after-save:selected'] = await page
    .textContent('.sc-row[data-selected="true"] .sc-row-name')
    .catch(() => null);
  measurements['cand-after-save:focused'] = await focusedId(page);

  // hover a row, a run row; focus a row
  await page.hover(ROW('Run the tests'));
  await page.waitForTimeout(250);
  await shot('cand-row-hover-bobble-dark');
  const testsRowId = await page.getAttribute(ROW('Run the tests'), 'data-testid');
  await measure(page, 'cand-row-hover', { row: `[data-testid="${testsRowId}"]` });
  await page.mouse.move(5, 5);

  // the pane swap, filmed
  const pane = { x: 300, y: 200, w: 868, h: 560 };
  let frames = await record(page, () => page.click(ROW('Portrait of the day')), 700);
  measurements['film:cand-pane-swap'] = writeClip('cand-film-pane-swap', frames, {
    spanMs: 420,
    crop: pane,
  });
  await page.waitForTimeout(300);
  await shot('cand-running-bobble-dark');
  const portraitRowId = await page.getAttribute(ROW('Portrait of the day'), 'data-testid');
  await measure(page, 'cand-running', {
    pill: '.sc-pill',
    runNow: '[data-testid="sc-run-now"]',
    edit: '[data-testid="sc-edit"]',
    rowTrail: `[data-testid="${portraitRowId}"] .sc-time`,
    thumb: '[data-testid="sc-run-thumb"]',
  });

  // the failed run (Morning brief run_a3) opened
  await page.click(ROW('Morning brief'));
  await page.waitForTimeout(400);
  await page.click('[data-testid="sc-run-head-run_a3"]');
  await page.waitForTimeout(300);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`cand-failed-run-open-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  await measure(page, 'cand-failed', {
    dot: '[data-testid="sc-run-run_a3"] .sc-run-dot',
    body: '[data-testid="sc-run-run_a3"] .sc-run-body',
    head: '[data-testid="sc-run-head-run_a3"]',
  });

  // a REAL run through the mock pi: Sort my Downloads
  await page.click(ROW('Sort my Downloads'));
  await page.waitForTimeout(400);
  const header = await boxOf(page, '[data-testid="sc-ledger-detail"]');
  frames = await record(page, () => page.click('[data-testid="sc-run-now"]'), 1500);
  measurements['film:cand-run-now'] = writeClip('cand-film-run-now', frames, {
    spanMs: 1200,
    crop: { x: header.x - 10, y: header.y - 10, w: header.w + 20, h: 260 },
  });
  await page.waitForTimeout(200);
  await shot('cand-run-now-live-bobble-dark');
  let finished = false;
  for (let i = 0; i < 60; i++) {
    if ((await page.$('[data-testid="sc-run-now"]')) !== null) {
      finished = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  measurements['cand-run-now:finished'] = finished;
  await page.waitForTimeout(400);
  await shot('cand-run-now-done-bobble-dark');
  measurements['cand-run-now:ledger-head'] = await page.$$eval('.sc-run-head', (els) =>
    els.slice(0, 2).map((e) => (e.textContent ?? '').slice(0, 120)),
  );

  // search, off, delete armed, late, edit
  await page.click('[data-testid="sc-ledger-search"] button');
  await page.waitForTimeout(300);
  await page.keyboard.type('test');
  await page.waitForTimeout(250);
  await shot('cand-search-typed-bobble-dark');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  measurements['cand-search:escape-cleared'] = (
    await page.$$('[data-testid^="sc-ledger-row-"]')
  ).length;
  await setState(page, 'default');
  const panesBox = await boxOf(page, '[data-testid="sc-panes"]');
  frames = await record(page, () => page.click('[data-testid="sc-scheduling-switch"]'), 700);
  measurements['film:cand-switch-off'] = writeClip('cand-film-switch-off', frames, {
    spanMs: 500,
    crop: { x: 0, y: 0, w: 1168, h: 420 },
  });
  await page.waitForTimeout(300);
  measurements['cand-off:panes-moved-by'] =
    (await boxOf(page, '[data-testid="sc-panes"]')).y - panesBox.y;
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`cand-off-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  await page.click('[data-testid="sc-scheduling-switch"]');
  await page.waitForTimeout(300);
  await setState(page, 'late');
  await shot('cand-late-bobble-dark');
  await page.evaluate(() => {
    const f = document.querySelector('[data-testid="sc-delete-footer"]');
    const v = f?.closest('.pd-scroll');
    if (v instanceof HTMLElement) v.scrollTop = v.scrollHeight;
  });
  await page.waitForTimeout(250);
  await page.click('[data-testid="sc-delete"]');
  await page.waitForTimeout(250);
  await shot('cand-delete-armed-bobble-dark');
  await page.click('[data-testid="sc-delete-keep"]');
  await setState(page, 'default');
  await page.click('[data-testid="sc-edit"]');
  await page.waitForTimeout(400);
  await shot('cand-edit-bobble-dark');
  measurements['cand-edit:focused'] = await focusedId(page);
  await page.click('[data-testid="sc-edit-strip-action"]');
  await page.waitForTimeout(300);

  // widths
  await setState(page, 'default');
  await page.setViewportSize(CONTENT_MID);
  await page.waitForTimeout(400);
  await shot('cand-default-mid-bobble-dark');
  await page.setViewportSize(CONTENT_NARROW);
  await page.waitForTimeout(400);
  await shot('cand-default-narrow-bobble-dark');
  await page.click(ROW('Morning brief'));
  await page.waitForTimeout(400);
  await shot('cand-detail-narrow-bobble-dark');
  await page.setViewportSize(CONTENT_WIDE);
  check(ids.length === SEED_TASKS.length, `seeded ${ids.length}`);
  measurements['cand:missed-row'] = await page
    .textContent(ROW('What did I miss'))
    .catch(() => null);
  void byName;
}

async function candEmpty() {
  await guarded(() => launchCand(), candEmptyBody);
}

async function candEmptyBody(ctx) {
  const { page, shot } = ctx;
  await prepareCand(ctx, { empty: true });
  await setState(page, 'default');
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`cand-empty-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  measurements['cand-empty:focused'] = await focusedId(page);
  await measure(page, 'cand-empty', {
    heading: '[data-testid="sc-ledger-templates"] h2',
    sub: '[data-testid="sc-ledger-templates"] p',
    card: '[data-testid="sc-template-morning-brief"]',
    tile: '[data-testid="sc-template-morning-brief"] .sc-tile',
    name: '[data-testid="sc-template-morning-brief"] .text-body',
    blurb: '[data-testid="sc-template-morning-brief"] .text-footnote',
    schedule: '[data-testid="sc-template-morning-brief"] .text-caption',
    composer: '.sc-composer',
  });
  const cardBox = await boxOf(page, '[data-testid="sc-template-morning-brief"]');
  await page.mouse.move(5, 5);
  const frames = await record(
    page,
    () => page.hover('[data-testid="sc-template-morning-brief"]'),
    500,
  );
  measurements['film:cand-template-hover'] = writeClip('cand-film-template-hover', frames, {
    spanMs: 300,
    crop: { x: cardBox.x - 8, y: cardBox.y - 8, w: cardBox.w + 16, h: cardBox.h + 16 },
  });
  await page.waitForTimeout(200);
  await shot('cand-empty-template-hover-bobble-dark');
  await page.mouse.move(5, 5);
  await tabOrder(page, 'cand-empty', { start: '[data-testid="sc-scheduling-switch"]', max: 20 });
  await page.click(COMPOSER);
  await page.keyboard.type('every friday at 4pm, write up what I worked on this week');
  await page.waitForTimeout(300);
  await shot('cand-empty-typing-bobble-dark');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await shot('cand-empty-review-bobble-dark');
  await page.click('[data-testid="sc-editor-save"]');
  await page.waitForTimeout(600);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`cand-one-task-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  measurements['cand-one-task:focused'] = await focusedId(page);
  await page.setViewportSize(CONTENT_NARROW);
  await page.waitForTimeout(400);
  await shot('cand-one-task-narrow-bobble-dark');
}

async function candChrome() {
  await guarded(() => launchCand({ PI_DESKTOP_CANDIDATE_V: 'ledger-plus-chrome' }), candChromeBody);
}

async function candChromeBody(ctx) {
  const { page, shot } = ctx;
  await prepareCand(ctx, { ready: CHROME_READY, viewport: WINDOW });
  await page.click('[data-testid="nav-scheduled"]').catch(() => undefined);
  await page.waitForTimeout(300);
  await setState(page, 'default');
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`cand-chrome-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  await measure(page, 'cand-chrome', {
    topbarTitle: '[data-testid="studio-title"]',
    h1: '.sc-title',
    composer: '.sc-composer',
    list: '[data-testid="sc-panes"] aside',
  });
  await page.setViewportSize(LAPTOP);
  await page.waitForTimeout(400);
  await shot('cand-chrome-laptop-bobble-dark');
  await page.setViewportSize(SMALL);
  await page.waitForTimeout(400);
  await shot('cand-chrome-small-bobble-dark');
  await page.setViewportSize(MINIMUM);
  await page.waitForTimeout(400);
  await shot('cand-chrome-minimum-bobble-dark');
  await page.setViewportSize(WINDOW);
}

/* ======================================================================== */
/* CHAT: a task made in a conversation, as the shipping chat shows it        */
/* ======================================================================== */

async function chat() {
  await guarded(
    () => launchApp('review-chat', { fixture: path.join(HERE, 'fixtures', 'chat-task.json') }),
    chatBody,
  );
}

async function chatBody({ page, shot, check }) {
  await page.setViewportSize(WINDOW);
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await setTheme(page, 'bobble-dark');
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('Every Friday at 4pm, write up what I worked on this week.');
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=runs every Friday at 4:00 PM', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.mouse.move(5, 5);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await shot(`chat-task-created-${theme}`);
  }
  await setTheme(page, 'bobble-dark');
  const chain = page.locator('[data-testid="activity-chain"]');
  check((await chain.count()) === 1, 'expected one activity chain');
  await chain.locator('.pd-chain-summary').click();
  await page.waitForTimeout(500);
  await shot('chat-task-created-open-bobble-dark');
  measurements['chat:summary'] = await chain
    .locator('.pd-chain-summary-text')
    .innerText()
    .catch(() => null);
  // then go to the Scheduled screen: is the task there, selected, named?
  await page.click(NAV);
  await page.waitForSelector(VIEW, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot('chat-then-scheduled-bobble-dark');
  measurements['chat:rows'] = await page.$$eval('[data-testid^="task-row-"]', (els) =>
    els.map((e) => (e.textContent ?? '').slice(0, 120)),
  );
}

if (MODE === 'ship') await ship();
else if (MODE === 'ship-motion') await shipMotion();
else if (MODE === 'cand') await cand();
else if (MODE === 'cand-motion') await candMotion();
else if (MODE === 'cand-empty') await candEmpty();
else if (MODE === 'cand-chrome') await candChrome();
else if (MODE === 'chat') await chat();
else throw new Error(`unknown MODE ${MODE}`);
