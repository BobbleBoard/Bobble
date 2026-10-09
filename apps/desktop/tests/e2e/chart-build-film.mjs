/**
 * FILM a chart being made — the live chart card growing as the call's values
 * arrive, and the finished card taking over (chart-build-look.mjs photographs
 * the states; this films the moves between them).
 *
 * The user (2026-09-25): build "in real time smoothly … apply that to whatever
 * possible generally". A bar chart's call is played into the store the way a
 * turn streams it (its argsText growing value by value), then presented and
 * answered; the CDP screencast films the thread and every animation frame's
 * delta is logged.
 *
 * Out: filmstrip.png (~100 ms apart), close-grow.png and close-handover.png
 * (every compositor frame), frames.json, and the checks: the bars grow as
 * values land, and the finished card takes over without moving.
 *
 *   SHOT_DIR=/tmp/chart-film node apps/desktop/tests/e2e/chart-build-film.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { filmstrip, readFrameLog, startFilm, startFrameLog } from './_film.mjs';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/chart-film';
mkdirSync(SHOT_DIR, { recursive: true });

const ARGS = {
  // CHART_TYPE=line films a line (it keeps its shape while typed and eases).
  type: process.env.CHART_TYPE ?? 'bar',
  title: 'Units sold by month',
  labels: 'Jan, Feb, Mar, Apr, May, Jun, Jul, Aug',
  values: '12, 19, 15, 22, 31, 27, 36, 41',
};
const ARGS_TEXT = JSON.stringify(ARGS);
const SVG_PATH = '/w/charts/units-sold-by-month.svg';

const { app, page, check, finish } = await launchApp('chart-build-film', {
  waitFor: '[data-testid="composer-input"]',
});
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) =>
    /index\.html|localhost/.test(w.webContents.getURL()),
  );
  win?.setContentSize(1280, 1200);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const user = { kind: 'user', id: 'u1', text: 'chart units sold', timestamp: Date.now() };
const lead = { type: 'text', text: 'Charting it.' };
const assistant = (blocks) => ({
  kind: 'assistant',
  id: 'a1',
  blocks: [lead, ...blocks],
  timestamp: Date.now(),
  isStreaming: true,
});
const call = (argsText, args = {}) => ({
  type: 'toolCall',
  id: 'c1',
  name: 'chart',
  arguments: args,
  argsText,
});
const read = () =>
  page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const pending = document.querySelector('[data-testid="pending-chart"]');
    const done = document.querySelector('[data-testid="presented-chart"]');
    return {
      pending: pending !== null,
      bars: pending?.querySelectorAll('.pd-chart-bar').length ?? 0,
      // A line's shape: how many commands its path has (it eases only while that holds).
      lineCmds: (
        pending
          ?.querySelector('.pd-chart-line')
          ?.getAttribute('d')
          ?.match(/[MLCQSTAHV]/gi) ?? []
      ).length,
      pendingSvg: box(pending?.querySelector('.pd-chart-svg')),
      done: done !== null,
      doneSvg: box(done?.querySelector('.pd-chart-svg')),
      entering: done?.querySelector('.pd-chart[data-enter]') != null,
    };
  });

const samples = [];
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1500);
  // OLD_GROWTH=1: the live card's growth rules switched off — what the
  // stylesheet did before them, for a before/after on the same build.
  if (process.env.OLD_GROWTH === '1') {
    await page.addStyleTag({
      content:
        '.pd-chart--building .pd-chart-bar, .pd-chart--building .pd-chart-slice { transition: opacity var(--pd-duration-fast) !important; } .pd-chart--building:not([data-enter]) .pd-chart-bar { animation: none !important; }',
    });
  }
  await set({
    session: { cwd: '/w/charts' },
    agent: { isStreaming: true },
    messages: [user, assistant([])],
    runningToolCalls: [],
    toolOutputPartials: {},
  });
  await sleep(500);
  const film = await startFilm(app, page);
  await startFrameLog(page);
  // The call streams a few characters at a time; the values land one by one,
  // 8 ms a character (SLOW=1: 70 ms, slower than the entrance lasts, so the
  // late bars and the rescales are the card's own).
  const valuesAt = ARGS_TEXT.indexOf('"values"');
  const perChar = process.env.SLOW === '1' ? 70 : 8;
  let growFrom = 0;
  for (let n = 6; n < ARGS_TEXT.length + 6; n += n < valuesAt ? 6 : 1) {
    await set({ messages: [user, assistant([call(ARGS_TEXT.slice(0, n))])] });
    if (n >= valuesAt && growFrom === 0) growFrom = Date.now();
    await sleep(n < valuesAt ? 45 : perChar);
    if (samples.length === 0 || Date.now() - samples.at(-1).at > 120) {
      samples.push({ at: Date.now(), ...(await read()) });
    }
  }
  await set({ messages: [user, assistant([call(ARGS_TEXT, ARGS)])], runningToolCalls: ['c1'] });
  await sleep(700);
  const before = await read();
  const handStart = Date.now();
  await page.evaluate(
    ({ file, args }) =>
      window
        .__present_store()
        .getState()
        .add({
          path: file,
          chat: '',
          afterMessageId: 'a1',
          chart: {
            type: args.type,
            title: args.title,
            labels: args.labels.split(', '),
            values: args.values.split(', ').map(Number),
          },
        }),
    { file: SVG_PATH, args: ARGS },
  );
  const onPresent = await read();
  await sleep(30);
  await set({
    messages: [
      user,
      assistant([call(ARGS_TEXT, ARGS)]),
      {
        kind: 'toolResult',
        id: 'tr-c1',
        toolCallId: 'c1',
        toolName: 'chart',
        text: `Drew a bar chart "${ARGS.title}" (8 points, look clean): ${SVG_PATH}. Shown.`,
        isError: false,
        timestamp: Date.now(),
      },
    ],
    runningToolCalls: [],
  });
  await sleep(1300);
  const settled = await read();
  const frameLog = await readFrameLog(page);
  await film.stop();

  const bars = samples.filter((s) => s.pending).map((s) => s.bars);
  if (ARGS.type === 'line') {
    const shapes = [
      ...new Set(samples.filter((s) => s.pending && s.lineCmds > 0).map((s) => s.lineCmds)),
    ];
    check(
      shapes.length === 1,
      `the line keeps its shape while the values land (path commands: ${shapes.join(', ')})`,
    );
  } else {
    check(
      bars.length > 2 && bars.at(-1) > bars[0],
      `the bars grow as the values land: ${bars.join(' → ')}`,
    );
  }
  const delta = (a, b) =>
    a && b ? { dx: b.x - a.x, dy: b.y - a.y, dw: b.w - a.w, dh: b.h - a.h } : null;
  const moved = delta(before.pendingSvg, onPresent.doneSvg);
  check(
    moved !== null && Object.values(moved).every((v) => Math.abs(v) <= 1),
    `the chart did not move at the handover: ${JSON.stringify(moved)}`,
  );
  check(!(onPresent.pending && onPresent.done), 'never two cards at once');

  const clip = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-scroll"]')?.getBoundingClientRect();
    const col = document.querySelector('[data-testid="turn-cards"]')?.parentElement;
    const r = col?.getBoundingClientRect();
    if (!scroll || !r) return null;
    return {
      x: Math.max(scroll.x, r.x - 12),
      y: scroll.y,
      width: Math.min(r.width + 24, scroll.width),
      height: Math.min(scroll.height, 640),
      vw: window.innerWidth,
    };
  });
  const base = { dir: SHOT_DIR, clip, viewportWidth: clip?.vw ?? 1280 };
  const strip = await filmstrip(film.frames, { ...base, stepMs: 100, cols: 8, cellWidth: 260 });
  const grow = await filmstrip(film.frames, {
    ...base,
    name: 'close-grow',
    stepMs: 33,
    cols: 8,
    cellWidth: 260,
    from: growFrom,
    to: growFrom + (process.env.SLOW === '1' ? 2600 : 900),
  });
  const hand = await filmstrip(film.frames, {
    ...base,
    name: 'close-handover',
    stepMs: 33,
    cols: 8,
    cellWidth: 260,
    from: handStart - 150,
    to: handStart + 1100,
  });
  const summary = {
    bars,
    moved,
    enteringAfterHandover: onPresent.entering,
    raf: frameLog.summary,
    filmstrip: strip.sheet,
    closeUps: [grow.sheet, hand.sheet],
    settled,
  };
  writeFileSync(
    path.join(SHOT_DIR, 'frames.json'),
    `${JSON.stringify({ summary, samples, deltas: frameLog.deltas }, null, 1)}\n`,
  );
  console.log(JSON.stringify(summary));
} finally {
  await finish();
}
