/**
 * A PRESENTED CARD, WHEN THE CHAIN WORKS ON — does it move, or is it rebuilt?
 *
 * STATUS (thread track): "a finished card moves into the chain (and remounts)
 * when the next tool call starts". turn-cards.ts files a presented card into
 * its chain while that chain is still working, and brings it back out beneath
 * the chain when it is done — so the card changes places twice. Each time it
 * was a NEW card: a different element, and a chart grew its bars from the axis
 * again (`data-enter`), as if it had only just arrived.
 *
 * Staged with no model (turn-cards-look's seam): a chart call answered and its
 * card presented beneath the live chain; then the next call starts (the card
 * files in); then the turn ends (the card comes back out). At each move the
 * probe records whether the chart is the SAME element, and whether it replayed
 * its entrance; a screencast of the first move is cut to the chat column.
 *
 *   OUT=<dir> node apps/desktop/tests/e2e/turn-card-move-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';
import { cropPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = probeHome('turn-card-move');
const dir = path.join(home, 'Bobble', 'generated', 'units');
mkdirSync(dir, { recursive: true });
const chartPath = path.join(dir, 'units.svg');

const { page, check, finish, shotDir } = await launchApp('turn-card-move', {
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const shot = (label) => page.screenshot({ path: path.join(OUT, `${label}.png`) });

const thought = (text) => ({ type: 'thinking', thinking: text });
const assistant = (id, blocks, t, streaming = false) => ({
  kind: 'assistant',
  id,
  blocks,
  timestamp: t,
  ...(streaming ? { isStreaming: true } : {}),
});
const chartCall = {
  type: 'toolCall',
  id: 'c1',
  name: 'chart',
  arguments: { type: 'bar', title: 'Units sold', labels: '2021, 2022, 2023', values: '12, 19, 27' },
};
const chartResult = {
  kind: 'toolResult',
  id: 'tr-b1-c1',
  toolCallId: 'c1',
  assistantId: 'b1',
  toolName: 'chart',
  text: 'Drew a bar chart "Units sold": units.svg (the spec beside it: units.chart.json)',
  isError: false,
  timestamp: 220,
};
const writeCall = {
  type: 'toolCall',
  id: 'w1',
  name: 'write',
  arguments: { path: 'summary.md', content: '# Units\n' },
};
const user = {
  kind: 'user',
  id: 'cu',
  text: 'Chart units sold by year, then write it up.',
  timestamp: 200,
};
const b1 = assistant('b1', [thought('A bar chart fits.'), chartCall], 210);

/** The chart's card: which element, where, and whether it is building in. */
const chart = () =>
  page.evaluate(() => {
    const view = document.querySelector(
      '[data-testid="presented-chart"] [data-testid="chart-view"]',
    );
    if (view === null) return null;
    window.__probeSeq ??= 0;
    if (view.__probeTag === undefined) view.__probeTag = ++window.__probeSeq;
    return {
      tag: view.__probeTag,
      inChain: view.closest('.pd-chain') !== null,
      entering: view.hasAttribute('data-enter'),
      top: Math.round(view.getBoundingClientRect().top),
    };
  });
/** Sample the chart every frame for `ms`: every element it was, and any entrance. */
const watch = (ms) =>
  page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const seen = [];
        const t0 = performance.now();
        const tick = () => {
          const view = document.querySelector(
            '[data-testid="presented-chart"] [data-testid="chart-view"]',
          );
          if (view !== null) {
            window.__probeSeq ??= 0;
            if (view.__probeTag === undefined) view.__probeTag = ++window.__probeSeq;
            seen.push({
              t: Math.round(performance.now() - t0),
              tag: view.__probeTag,
              inChain: view.closest('.pd-chain') !== null,
              entering: view.hasAttribute('data-enter'),
            });
          } else seen.push({ t: Math.round(performance.now() - t0), tag: null });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(seen);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
const summarise = (seen) => ({
  frames: seen.length,
  tags: [...new Set(seen.map((s) => s.tag))],
  gone: seen.filter((s) => s.tag === null).length,
  enteringFrames: seen.filter((s) => s.entering).length,
  endsInChain: seen.at(-1)?.inChain ?? null,
});

try {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.evaluate(() => {
    window.__pi_theme?.()?.setFlavor?.('bobble');
    window.__pi_theme?.()?.setMode?.('dark');
  });
  await sleep(1000);

  /* ── the chart is presented; its call is the chain's last ── */
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
    session: { cwd: dir },
    agent: {
      ...(await page.evaluate(() => window.__pi_store().getState().agent)),
      isStreaming: true,
    },
    messages: [user, b1, chartResult, assistant('b2', [thought('Now the write-up.')], 230, true)],
    runningToolCalls: [],
  });
  await page.waitForSelector('[data-testid="presented-chart"] [data-testid="chart-view"]', {
    timeout: 10000,
  });
  // Let its own entrance finish: what follows must not be mistaken for it.
  await sleep(2000);
  const a = await chart();
  await shot('a-presented');
  console.log('presented:', JSON.stringify(a));
  check(
    a !== null && !a.inChain && !a.entering,
    `the chart stands beneath the chain, settled (${JSON.stringify(a)})`,
  );

  /* ── the next call starts: the chart files into the chain ── */
  const cdp = await page.context().newCDPSession(page);
  const film = [];
  cdp.on('Page.screencastFrame', (f) => {
    film.push({ t: f.metadata.timestamp, w: f.metadata.deviceWidth, data: f.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  const watching = watch(1600);
  await set({
    messages: [
      user,
      b1,
      chartResult,
      assistant('b2', [thought('Now the write-up.'), writeCall], 230, true),
    ],
    runningToolCalls: ['w1'],
  });
  const moveIn = summarise(await watching);
  await cdp.send('Page.stopScreencast').catch(() => undefined);
  const b = await chart();
  await shot('b-filed-in-chain');
  console.log('filed in:', JSON.stringify({ ...moveIn, now: b }));
  check(b?.inChain === true, `while the chain works on, the chart is in it (${JSON.stringify(b)})`);
  check(
    moveIn.tags.filter((t) => t !== null).length === 1 && moveIn.tags[0] === a?.tag,
    `…and it is the SAME card, moved — not a new one (${JSON.stringify(moveIn.tags)})`,
  );
  check(
    moveIn.enteringFrames === 0,
    `…which does not build itself in again (${moveIn.enteringFrames} frames)`,
  );
  check(moveIn.gone === 0, `…and is never missing from the page for a frame (${moveIn.gone})`);

  // The filmstrip, cut to the chat column.
  const filmDir = path.join(OUT, 'move-in-film');
  mkdirSync(filmDir, { recursive: true });
  const t0 = film[0]?.t ?? 0;
  for (const [i, f] of film.entries()) {
    const buf = Buffer.from(f.data, 'base64');
    const scale = buf.readUInt32BE(16) / f.w;
    try {
      writeFileSync(
        path.join(filmDir, `${String(i).padStart(3, '0')}-${Math.round((f.t - t0) * 1000)}ms.png`),
        cropPng(buf, {
          x: Math.round(300 * scale),
          y: 0,
          width: Math.round(900 * scale),
          height: Math.round(820 * scale),
        }),
      );
    } catch {
      writeFileSync(path.join(filmDir, `${String(i).padStart(3, '0')}-full.png`), buf);
    }
  }

  /* ── the turn ends: the chart is the answer, beneath the folded chain ── */
  const watchingOut = watch(1600);
  await set({
    agent: {
      ...(await page.evaluate(() => window.__pi_store().getState().agent)),
      isStreaming: false,
    },
    messages: [
      user,
      b1,
      chartResult,
      assistant('b2', [thought('Now the write-up.'), writeCall], 230),
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
  const moveOut = summarise(await watchingOut);
  const c = await chart();
  await shot('c-answer');
  console.log('turn ended:', JSON.stringify({ ...moveOut, now: c }));
  check(
    c !== null && !c.inChain,
    `when the turn ends, the chart is the answer beneath the chain (${JSON.stringify(c)})`,
  );
  check(
    moveOut.tags.filter((t) => t !== null).length === 1 && moveOut.tags[0] === a?.tag,
    `…still the same card (${JSON.stringify(moveOut.tags)})`,
  );
  check(
    moveOut.enteringFrames === 0,
    `…not building itself in a third time (${moveOut.enteringFrames} frames)`,
  );
} finally {
  await finish();
}
