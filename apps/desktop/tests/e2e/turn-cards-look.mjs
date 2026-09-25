/**
 * WHERE A TURN'S FINISHED PICTURES SIT WHILE IT IS STILL WORKING — and after.
 *
 * the user (2026-09-24): "the 4b qwen model has gone on and iterated visually over
 * the generated images improving each time toward the goal. however on each of
 * it's iterations the full image cards are presented at the very bottom of the
 * chat as if totally finished, these should be embedded in thinking blocks, not
 * the generating card, that stays out".
 *
 * Stages exactly that turn — no model, no GPU: three `edit_image` calls, each
 * taking the previous result as its input, all finished, and a fourth still
 * running (its generating card up) — then lets the fourth finish and the turn
 * end. At each stage it records WHERE every card is (inside the activity chain,
 * or beneath it) and shoots the thread:
 *
 *   a-during-turn      three results filed in the chain, the generating card out
 *   b-result-landed    the fourth result beneath the chain, where its card stood
 *   c-turn-ended       the chain folded; only the final picture beneath it
 *   d-chain-reopened   the iterations are still there, in their rows
 *   e-overview-*       the same states with the whole turn in one frame
 *
 * Checks assert the new placement, so the unmodified app FAILS them — that run
 * is the "before" picture, not a regression.
 *
 *   OUT=/tmp/turn-cards node apps/desktop/tests/e2e/turn-cards-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { launchApp, probeHome } from './harness.mjs';

const OUT = process.env.OUT ?? '/tmp/turn-cards';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── fixtures: four versions of one picture, warmer each time ─────────── */

/** A W×H RGB PNG painted by `paint(x, y) → [r, g, b]`. No dependencies. */
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* A "cat" (a round head with two ears) on a ground that warms from grey-blue
   to amber across the versions, so four iterations read as four pictures. */
const W = 640;
const H = 480;
const versions = [
  { ground: [84, 96, 120], head: [150, 150, 160] },
  { ground: [120, 104, 104], head: [190, 160, 140] },
  { ground: [168, 118, 80], head: [226, 170, 110] },
  { ground: [214, 140, 60], head: [250, 196, 120] },
];
const catPainter =
  ({ ground, head }) =>
  (x, y) => {
    const dx = x - W / 2;
    const dy = y - H * 0.58;
    const inHead = dx * dx + dy * dy < 130 * 130;
    const ear = (cx) => y > H * 0.22 && y < H * 0.42 && Math.abs(x - cx) < (y - H * 0.22) * 0.55;
    const inEar = ear(W / 2 - 80) || ear(W / 2 + 80);
    const eye = (cx) => (x - cx) ** 2 + (y - H * 0.55) ** 2 < 14 * 14;
    if (inHead && (eye(W / 2 - 45) || eye(W / 2 + 45))) return [40, 30, 30];
    if (inHead || inEar) return head;
    const shade = 1 - y / (H * 3);
    return ground.map((c) => Math.round(c * shade));
  };

const home = probeHome('turn-cards');
const dir = path.join(home, 'Bobble', 'generated', 'warmer-cat');
mkdirSync(dir, { recursive: true });
const photo = path.join(dir, 'photo.png');
writeFileSync(photo, png(W, H, catPainter(versions[0])));
const V = versions.map((v, i) => {
  const p = path.join(dir, `edit_00${i}.png`);
  writeFileSync(p, png(W, H, catPainter(v)));
  return p;
});

/* ── the turn ─────────────────────────────────────────────────────────── */

const user = {
  kind: 'user',
  id: 'u1',
  text: 'Make the cat in my photo warmer — golden-hour light.',
  timestamp: 1,
};
const thought = (text) => ({ type: 'thinking', thinking: text });
const edit = (id, input, instruction) => ({
  type: 'toolCall',
  id,
  name: 'edit_image',
  arguments: { image_path: input, instruction },
});
const assistant = (id, blocks, t, streaming = false) => ({
  kind: 'assistant',
  id,
  blocks,
  timestamp: t,
  ...(streaming ? { isStreaming: true } : {}),
});
const result = (callId, assistantId, out, t) => ({
  kind: 'toolResult',
  id: `tr-${assistantId}-${callId}`,
  toolCallId: callId,
  assistantId,
  toolName: 'edit_image',
  text: `pd-file://f${out}\nEdited image saved at ${out}`,
  isError: false,
  timestamp: t,
});
const iterations = [
  assistant(
    'a1',
    [
      thought('The user wants a warmer photo. Start with the light.'),
      edit('e1', photo, 'warmer light'),
    ],
    10,
  ),
  result('e1', 'a1', V[0], 20),
  assistant(
    'a2',
    [
      thought('Still too cold in the shadows. Push it further.'),
      edit('e2', V[0], 'warmer shadows'),
    ],
    30,
  ),
  result('e2', 'a2', V[1], 40),
  assistant(
    'a3',
    [thought('Better. The background should glow too.'), edit('e3', V[1], 'golden background')],
    50,
  ),
  result('e3', 'a3', V[2], 60),
];
const running = assistant(
  'a4',
  [thought('Nearly there — one last pass on the fur.'), edit('e4', V[2], 'golden-hour fur')],
  70,
  true,
);

const { page, check, finish } = await launchApp('turn-cards', {
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
});

const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const shot = (label) => page.screenshot({ path: path.join(OUT, `${label}.png`) });
const toBottom = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el) el.scrollTop = el.scrollHeight;
  });
/** Where each card is: in a chain row, or beneath the chain (outside it). */
const where = () =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="media-card"]')];
    const pending = document.querySelector('[data-testid="pending-media-card"]');
    const name = (el) => el.querySelector('img')?.getAttribute('alt') ?? '?';
    return {
      inside: cards.filter((c) => c.closest('.pd-chain') !== null).map(name),
      outside: cards.filter((c) => c.closest('.pd-chain') === null).map(name),
      pendingInChain: pending === null ? null : pending.closest('.pd-chain') !== null,
      chainExpanded: document.querySelector('.pd-chain')?.getAttribute('data-expanded') ?? null,
      /* Whatever is lowest in the thread — "the bottom of the chat". */
      lowestCard: (() => {
        let low = null;
        for (const c of [...cards, ...(pending ? [pending] : [])]) {
          const b = c.getBoundingClientRect().bottom;
          if (low === null || b > low.b) low = { b, what: c === pending ? 'pending' : name(c) };
        }
        return low?.what ?? null;
      })(),
    };
  });
/** Every image decoded — a shot of empty frames proves nothing. */
const decoded = () =>
  page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="media-card"] img')].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      undefined,
      { timeout: 8000 },
    )
    .catch(() => undefined);
/**
 * The whole turn in one frame: the same page laid out in a TALL viewport (the
 * device-metrics override a DevTools device frame uses), so the thread shows
 * the entire turn at its real size instead of the last screenful of it.
 */
const cdp = await page.context().newCDPSession(page);
const overview = async (label) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 2600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(700);
  await toBottom();
  await sleep(400);
  await shot(label);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1200);

  /* ── a. three results in, the fourth still being made ── */
  await set({
    session: { cwd: dir },
    agent: {
      ...(await page.evaluate(() => window.__pi_store().getState().agent)),
      isStreaming: true,
    },
    messages: [user, ...iterations, running],
    runningToolCalls: ['e4'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  await decoded();
  await sleep(2500);
  await toBottom();
  await sleep(300);
  const a = await where();
  console.log('during the turn:', JSON.stringify(a));
  await shot('a-during-turn');
  await overview('e-overview-during-turn');
  check(
    a.inside.length === 3 && a.outside.length === 0,
    `the three finished iterations are IN the chain, none beneath it (${JSON.stringify(a)})`,
  );
  check(a.pendingInChain === false, 'the generating card stays OUT of the chain');
  check(
    a.lowestCard === 'pending',
    `the bottom of the chat is the generating card (${a.lowestCard})`,
  );

  /* ── b. the fourth lands; the model looks at it before replying ── */
  await set({
    messages: [
      user,
      ...iterations,
      { ...running, isStreaming: false },
      result('e4', 'a4', V[3], 80),
      assistant('a5', [thought('That is the look they asked for.')], 90, true),
    ],
    runningToolCalls: [],
  });
  // The generating card plays its closing sweep over the result, then hands it on.
  await page
    .waitForFunction(
      () => document.querySelector('[data-testid="pending-media-card"]') === null,
      undefined,
      {
        timeout: 10000,
      },
    )
    .catch(() => undefined);
  await decoded();
  await sleep(600);
  await toBottom();
  await sleep(300);
  const b = await where();
  console.log('result landed:', JSON.stringify(b));
  await shot('b-result-landed');
  check(
    b.outside.length === 1 && b.outside[0] === 'edit_003.png',
    `the newest result sits beneath the chain, where its card stood (${JSON.stringify(b)})`,
  );
  check(
    b.inside.length === 3,
    `…and the earlier three stay filed in the chain (${b.inside.length})`,
  );

  /* ── c. the turn ends with its reply ── */
  await set({
    agent: {
      ...(await page.evaluate(() => window.__pi_store().getState().agent)),
      isStreaming: false,
    },
    messages: [
      user,
      ...iterations,
      { ...running, isStreaming: false },
      result('e4', 'a4', V[3], 80),
      assistant(
        'a5',
        [
          thought('That is the look they asked for.'),
          {
            type: 'text',
            text: 'Here it is in golden-hour light — warmer fur, a glowing background.',
          },
        ],
        90,
      ),
    ],
  });
  await sleep(1500);
  await decoded();
  await toBottom();
  await sleep(300);
  const c = await where();
  console.log('turn ended:', JSON.stringify(c));
  await shot('c-turn-ended');
  await overview('e-overview-turn-ended');
  check(c.chainExpanded === 'false', 'the chain folds when the turn is done');
  check(
    c.outside.length === 1 && c.outside[0] === 'edit_003.png',
    `only the FINAL picture is shown beneath the chain (${JSON.stringify(c.outside)})`,
  );

  /* ── d. the iterations are still there when the chain is opened ── */
  await page.click('.pd-chain-summary');
  await sleep(700);
  await decoded();
  const d = await where();
  console.log('chain reopened:', JSON.stringify(d));
  await page.evaluate(() => {
    document.querySelector('.pd-chain')?.scrollIntoView({ block: 'start' });
  });
  await sleep(300);
  await shot('d-chain-reopened');
  check(
    d.inside.length === 3 && d.inside.join() === 'edit_000.png,edit_001.png,edit_002.png',
    `reopening the chain shows each iteration under its own row (${JSON.stringify(d.inside)})`,
  );

  /* ── f–h. "inline cards of ANY kind": a chart the turn presented ─────── */
  // A chart call still being written → its building card; then its presented
  // card while the turn goes on to write a file; then the turn ends.
  const chartPath = path.join(dir, 'units.svg');
  const chartCall = {
    type: 'toolCall',
    id: 'c1',
    name: 'chart',
    arguments: {
      type: 'bar',
      title: 'Units sold',
      labels: '2021, 2022, 2023',
      values: '12, 19, 27',
    },
  };
  const chartUser = {
    kind: 'user',
    id: 'cu',
    text: 'Chart units sold by year, then write it up.',
    timestamp: 200,
  };
  const b1 = assistant('b1', [thought('A bar chart fits.'), chartCall], 210, true);
  await set({
    agent: {
      ...(await page.evaluate(() => window.__pi_store().getState().agent)),
      isStreaming: true,
    },
    messages: [chartUser, b1],
    runningToolCalls: ['c1'],
  });
  await sleep(1200);
  await toBottom();
  const chartWhere = () =>
    page.evaluate(() => {
      const pendingChart = document.querySelector('[data-testid="pending-chart"]');
      const chart = document.querySelector('[data-testid="presented-chart"]');
      return {
        pendingInChain: pendingChart === null ? null : pendingChart.closest('.pd-chain') !== null,
        chartInChain: chart === null ? null : chart.closest('.pd-chain') !== null,
        chainExpanded: document.querySelector('.pd-chain')?.getAttribute('data-expanded') ?? null,
      };
    });
  const f = await chartWhere();
  console.log('chart building:', JSON.stringify(f));
  await shot('f-chart-building');
  check(
    f.pendingInChain === false,
    `the chart being built stands OUTSIDE the chain (${JSON.stringify(f)})`,
  );

  // The chart lands and is presented; the turn moves on to write the summary.
  await page.evaluate(
    ({ p }) =>
      window
        .__present_store()
        .getState()
        .add({
          path: p,
          chat: '',
          afterMessageId: 'b1',
          chart: {
            type: 'bar',
            title: 'Units sold',
            labels: ['2021', '2022', '2023'],
            values: [12, 19, 27],
          },
        }),
    { p: chartPath },
  );
  await set({
    messages: [
      chartUser,
      { ...b1, isStreaming: false },
      {
        kind: 'toolResult',
        id: 'tr-b1-c1',
        toolCallId: 'c1',
        assistantId: 'b1',
        toolName: 'chart',
        text: 'Drew a bar chart "Units sold": units.svg (the spec beside it: units.chart.json)',
        isError: false,
        timestamp: 220,
      },
      assistant(
        'b2',
        [
          thought('Now the write-up.'),
          {
            type: 'toolCall',
            id: 'w1',
            name: 'write',
            arguments: { path: 'summary.md', content: '# Units\n' },
          },
        ],
        230,
        true,
      ),
    ],
    runningToolCalls: ['w1'],
  });
  await sleep(1500);
  await toBottom();
  await sleep(300);
  const g = await chartWhere();
  console.log('chart filed while the turn works on:', JSON.stringify(g));
  await shot('g-chart-filed');
  check(
    g.chartInChain === true,
    `while the turn works on, the chart is filed IN the chain (${JSON.stringify(g)})`,
  );

  // The turn ends with its reply.
  await set({
    agent: {
      ...(await page.evaluate(() => window.__pi_store().getState().agent)),
      isStreaming: false,
    },
    messages: [
      chartUser,
      { ...b1, isStreaming: false },
      {
        kind: 'toolResult',
        id: 'tr-b1-c1',
        toolCallId: 'c1',
        assistantId: 'b1',
        toolName: 'chart',
        text: 'Drew a bar chart "Units sold": units.svg (the spec beside it: units.chart.json)',
        isError: false,
        timestamp: 220,
      },
      assistant(
        'b2',
        [
          thought('Now the write-up.'),
          {
            type: 'toolCall',
            id: 'w1',
            name: 'write',
            arguments: { path: 'summary.md', content: '# Units\n' },
          },
        ],
        230,
      ),
      {
        kind: 'toolResult',
        id: 'tr-b2-w1',
        toolCallId: 'w1',
        assistantId: 'b2',
        toolName: 'write',
        text: 'Wrote summary.md',
        isError: false,
        timestamp: 240,
      },
      assistant(
        'b3',
        [{ type: 'text', text: 'Sales rose every year — 27 thousand units in 2023.' }],
        250,
      ),
    ],
    runningToolCalls: [],
  });
  await sleep(1500);
  await toBottom();
  await sleep(300);
  const h = await chartWhere();
  console.log('chart turn ended:', JSON.stringify(h));
  await shot('h-chart-answer');
  check(
    h.chartInChain === false && h.chainExpanded === 'false',
    `when the turn is done the chart is its answer, beneath the folded chain (${JSON.stringify(h)})`,
  );
} finally {
  await finish();
}
