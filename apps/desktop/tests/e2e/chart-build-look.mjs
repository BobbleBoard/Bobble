/**
 * LOOK at a chart being made. the user (2026-09-17): "when a chart is generating
 * show a skeleton card with shimmering items as a preview that builds live …
 * bar ones have bars go up, pie expand smoothly, radar charts show dots going
 * out from the center"; and the chain rows: "'<icon> Rendering <type> Chart'",
 * queued calls not spinning; no stub rows, no file name under the card.
 *
 * Plays the states a real turn produces straight into the store — the call's
 * arguments arriving byte by byte, three calls written at once with one
 * executing, the result and its card — and photographs each.
 *
 *   SHOT_DIR=/tmp/chart-build node apps/desktop/tests/e2e/chart-build-look.mjs
 */
import { mkdirSync } from 'node:fs';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/chart-build';
mkdirSync(SHOT_DIR, { recursive: true });
const { page, check, finish } = await launchApp('chart-build', {
  waitFor: '[data-testid="composer-input"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const shot = async (label, { top = true } = {}) => {
  const thread = page.locator('[data-testid="chat-scroll"]').first();
  await page.evaluate((toTop) => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el) el.scrollTop = toTop ? 0 : el.scrollHeight;
  }, top);
  const box = await thread.boundingBox().catch(() => null);
  if (box) await page.screenshot({ path: `${SHOT_DIR}/${label}.png`, clip: box });
  else await page.screenshot({ path: `${SHOT_DIR}/${label}.png` });
};

const user = {
  kind: 'user',
  id: 'u1',
  text: 'demo all your dataviz skills',
  timestamp: Date.now(),
};
const typing = (id, argsText) => ({ type: 'toolCall', id, name: 'chart', arguments: {}, argsText });
const call = (id, args) => ({ type: 'toolCall', id, name: 'chart', arguments: args });
const assistant = (blocks, isStreaming) => ({
  kind: 'assistant',
  id: 'a1',
  blocks,
  timestamp: Date.now(),
  isStreaming,
});
const result = (id, text) => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  toolName: 'chart',
  text,
  isError: false,
  timestamp: Date.now(),
});
const read = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pd-chain-step')].map((r) => ({
      label: r.querySelector('.pd-chain-step-label')?.textContent ?? '',
      status: r.getAttribute('data-status'),
      state: r.querySelector('.pd-chain-step-state')?.textContent ?? null,
      spinner:
        r.querySelector(
          '.pd-chain-step-icon .pd-spinner, .pd-chain-step-icon [class*="spinner"]',
        ) !== null,
    }));
    const pending = [...document.querySelectorAll('[data-testid="pending-chart"]')].map((p) => ({
      live: p.getAttribute('data-live') !== null,
      title: p.querySelector('.pd-chart-title')?.textContent ?? null,
      skeleton: p.querySelector('.pd-chart-skeleton-svg') !== null,
      bars: p.querySelectorAll('.pd-chart-bar').length,
    }));
    return {
      rows,
      pending,
      cards: document.querySelectorAll('[data-testid="presented-chart"]').length,
      stubs: document.querySelectorAll('[data-testid="inline-stub"]').length,
      fileLines: document.querySelectorAll('.pd-inline-file').length,
      entering: document.querySelectorAll('.pd-chart[data-enter]').length,
    };
  });

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(2000);
  await set({ session: { cwd: '/w/dataviz' }, agent: { isStreaming: true } });

  // 1. The type has arrived, nothing else: a bar skeleton, the row says what it is.
  await set({
    messages: [user, assistant([typing('c1', '{"type": "bar", "ti')], true)],
    runningToolCalls: [],
    toolOutputPartials: {},
  });
  await sleep(700);
  let s = await read();
  await shot('1-skeleton');
  check(
    s.pending.length === 1 && s.pending[0].skeleton && !s.pending[0].live,
    `a bar skeleton while only the type is known: ${JSON.stringify(s.pending)}`,
  );
  check(
    s.rows.some((r) => r.label === 'Rendering a bar chart'),
    `the row names the kind of chart: ${JSON.stringify(s.rows)}`,
  );

  // 2. Title + labels + the first values: the chart builds live.
  await set({
    messages: [
      user,
      assistant(
        [
          typing(
            'c1',
            '{"type": "bar", "title": "Units Sold by Year", "labels": "2021, 2022, 2023, 2024", "values": "12, 19, 1',
          ),
        ],
        true,
      ),
    ],
  });
  await sleep(700);
  s = await read();
  await shot('2-building');
  check(
    s.pending.length === 1 && s.pending[0].live && s.pending[0].bars >= 2,
    `the chart draws as the values arrive: ${JSON.stringify(s.pending)}`,
  );
  check(s.pending[0]?.title === 'Units Sold by Year', 'the title is on the building card');

  // 3. Three calls written at once, the first executing: one running, two queued.
  await set({
    messages: [
      user,
      assistant(
        [
          call('c1', {
            type: 'bar',
            title: 'Units Sold by Year',
            labels: '2021, 2022, 2023, 2024',
            values: '12, 19, 15, 22',
          }),
          call('c2', {
            type: 'line',
            title: 'Signups',
            labels: 'Jan, Feb, Mar',
            values: '120, 180, 150',
          }),
          call('c3', { type: 'donut', title: 'Share', labels: 'A, B, C', values: '38, 27, 35' }),
        ],
        true,
      ),
    ],
    runningToolCalls: ['c1'],
  });
  await sleep(800);
  s = await read();
  await shot('3-queued');
  const statuses = s.rows
    .filter((r) => /chart/.test(r.label))
    .map((r) => `${r.label}:${r.status}${r.state ? `(${r.state})` : ''}`);
  check(
    s.rows.filter((r) => r.status === 'running').length === 1 &&
      s.rows.filter((r) => r.status === 'queued').length === 2,
    `one running, two queued: ${statuses.join(' | ')}`,
  );
  check(
    s.rows.filter((r) => r.status === 'queued').every((r) => r.state === 'Queued' && !r.spinner),
    'queued rows are still, marked Queued',
  );
  check(s.pending.length === 3, `three building cards: ${s.pending.length}`);

  // 4. The first result lands and its card is presented: pending → real, in place.
  await page.evaluate(() => {
    const st = window.__present_store ? window.__present_store() : null;
    if (st) {
      st.getState().add({
        path: '/w/dataviz/units-sold-by-year.svg',
        chat: '',
        afterMessageId: 'a1',
        chart: {
          type: 'bar',
          title: 'Units Sold by Year',
          labels: ['2021', '2022', '2023', '2024'],
          values: [12, 19, 15, 22],
          look: 'clean',
        },
      });
    }
  });
  await set({
    messages: [
      user,
      assistant(
        [
          call('c1', {
            type: 'bar',
            title: 'Units Sold by Year',
            labels: '2021, 2022, 2023, 2024',
            values: '12, 19, 15, 22',
          }),
          call('c2', {
            type: 'line',
            title: 'Signups',
            labels: 'Jan, Feb, Mar',
            values: '120, 180, 150',
          }),
          call('c3', { type: 'donut', title: 'Share', labels: 'A, B, C', values: '38, 27, 35' }),
        ],
        true,
      ),
      result(
        'c1',
        'Drew a bar chart "Units Sold by Year" (4 points, look clean): /w/dataviz/units-sold-by-year.svg (the spec beside it: units-sold-by-year.chart.json). Shown.',
      ),
    ],
    runningToolCalls: ['c2'],
  });
  await sleep(250);
  s = await read();
  await shot('4-first-landed-mid-enter');
  check(
    s.entering >= 1,
    `the real card enters with its build-in animation (${s.entering} entering)`,
  );
  await sleep(1200);
  s = await read();
  await shot('5-first-landed');
  check(
    s.cards === 1 && s.pending.length === 2,
    `one real card, two still building: cards ${s.cards}, pending ${s.pending.length}`,
  );
  check(s.fileLines === 0, 'no file name under the card');
  check(
    s.rows.some((r) => r.label === 'Rendered a bar chart' && r.status === 'done'),
    `the first row settled: ${JSON.stringify(s.rows.map((r) => `${r.label}:${r.status}`))}`,
  );

  // 5. A radar and a pie, done, entering: the shapes the user named.
  await page.evaluate(() => {
    const st = window.__present_store();
    st.getState().add({
      path: '/w/dataviz/profile.svg',
      chat: '',
      afterMessageId: 'a1',
      chart: {
        type: 'radar',
        title: 'Profile',
        labels: ['Speed', 'Power', 'Range', 'Cost', 'Style'],
        values: ['Ours: 8, 6, 9, 4, 7', 'Theirs: 5, 8, 6, 7, 5'],
        look: 'ocean',
      },
    });
    st.getState().add({
      path: '/w/dataviz/share.svg',
      chat: '',
      afterMessageId: 'a1',
      chart: {
        type: 'pie',
        title: 'Market share',
        labels: ['Acme', 'Globex', 'Initech', 'Others'],
        values: [38, 27, 20, 15],
        unit: '%',
        look: 'soft',
      },
    });
  });
  await sleep(120);
  await shot('6-radar-pie-entering', { top: false });
  await sleep(1300);
  s = await read();
  await shot('7-radar-pie', { top: false });
  const radar = await page.evaluate(() => ({
    dots: document.querySelectorAll('.pd-chart-radar-dot').length,
    web: document.querySelectorAll('.pd-chart-radar-web').length,
    slices: document.querySelectorAll('[data-chart-type="pie"] .pd-chart-slice').length,
    centre:
      document.querySelector('[data-chart-type="pie"] .pd-chart-text--big')?.textContent ?? null,
  }));
  check(
    radar.web === 1 && radar.dots === 10,
    `the radar has its web and ten dots: ${JSON.stringify(radar)}`,
  );
  check(
    radar.slices === 4 && radar.centre === null,
    `the pie has four slices and nothing in the middle: ${JSON.stringify(radar)}`,
  );
  check(s.cards === 3, `three cards: ${s.cards}`);
  console.log(JSON.stringify({ rows: s.rows, pending: s.pending, radar }, null, 1));
} finally {
  await finish();
}
