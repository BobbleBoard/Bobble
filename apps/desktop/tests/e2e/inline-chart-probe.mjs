/**
 * INLINE DATA VISUALS — the user (2026-09-16), Claude's inline chart beside ours:
 * "some items showing inline cards like anthropic has here, while larger
 * things go to the canvas still … a quick button in the canvas and on the
 * inline items to with a smooth animation have an inline thing either resize
 * and move over smoothly … or a tab in the canvas dropping out and becoming
 * an inline card. not just bar charts, all datavisuals though of course."
 *
 * Real app, real pi, HEADED (the window on screen, never focused). Two halves:
 *
 *   1. THE MECHANISM — the `chart` command run through pi's own bash, for a
 *      bar, a two-series line and a donut: each lands in the thread as an
 *      interactive card (hover reads a value, chart ⇄ table), the corner
 *      control lifts it into a chart tab (screenshots mid-transition and
 *      after), the tab's Show-in-chat drops it back. Nothing else opens the
 *      canvas on its own.
 *   2. THE MODEL — the units-sold prompt to the 4B: does it reach for `chart`
 *      (not the office pipeline, not image generation, not matplotlib) and
 *      does the card appear, and how long did it take.
 *
 *   MODEL=qwen3.5-4b-mtp ENGINE=rapid-mlx/mtp SHOT_DIR=/tmp/inline-chart \
 *     node apps/desktop/tests/e2e/inline-chart-probe.mjs
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ENGINE = process.env.ENGINE ?? 'rapid-mlx/mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/inline-chart';
const SKIP_MODEL = process.env.SKIP_MODEL === '1';
const TURN_CAP_MS = Number(process.env.TURN_CAP_S ?? 420) * 1000;
mkdirSync(SHOT_DIR, { recursive: true });

const home = probeHome('inline-chart');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }, null, 2)}\n`,
);
const { app, page, check, finish } = await launchApp('inline-chart', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_E2E_HEADED: '1',
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = async (label) => {
  const file = path.join(SHOT_DIR, `${label}.png`);
  await page.screenshot({ path: file });
  log(`shot ${label}`);
  return file;
};
const findings = [];
const note = (name, pass, detail = '') => {
  findings.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The chat's presented cards, the canvas tabs, the panel state — one read. */
const state = () =>
  page.evaluate(() => {
    const c = window.__pi_canvas?.();
    const tabs = c?.getState?.().tabs ?? [];
    const card = document.querySelector('[data-testid="presented-chart"]');
    const stub = document.querySelector('[data-testid="inline-stub"]');
    const tooltip = document.querySelector('[data-testid="chart-tooltip"]');
    const rail = document.querySelector('[data-testid="canvas-tabs-panel"]');
    return {
      charts: document.querySelectorAll('[data-testid="presented-chart"]').length,
      stubs: document.querySelectorAll('[data-testid="inline-stub"]').length,
      cardTitle: card?.querySelector('.pd-chart-title')?.textContent ?? null,
      view:
        card?.querySelector('[data-testid="chart-view"]')?.getAttribute('data-chart-view') ?? null,
      bars: card?.querySelectorAll('.pd-chart-bar').length ?? 0,
      tooltip: tooltip?.textContent ?? null,
      stub: stub?.textContent ?? null,
      tabs: tabs.map((t) => ({ kind: t.kind, title: t.title, inline: t.inline === true })),
      railOpen: rail?.getAttribute('data-open') ?? null,
      showInChat: document.querySelector('.pd-canvas-show-inline') !== null,
      canvasChartBars: document.querySelectorAll('.pd-canvas-tabpanel .pd-chart-bar').length,
      transitionName:
        card?.querySelector('.pd-inline-chart')?.style.getPropertyValue('view-transition-name') ??
        null,
      hasViewTransitions: typeof document.startViewTransition === 'function',
    };
  });

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await sleep(3000);
  log(`starting ${MODEL} on ${ENGINE}…`);
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  const [engine, spec] = ENGINE.split('/');
  const already = await page.evaluate(
    ({ engine, spec }) => {
      const s = window.__llm_store().getState().status;
      return s.profile?.engine === engine && s.profile?.spec === spec;
    },
    { engine, spec },
  );
  if (ENGINE !== 'llamacpp/none' && !already) {
    await page.evaluate(
      ({ engine, spec }) => window.__llm_store().getState().switchProfile(engine, spec),
      { engine, spec },
    );
    await page.waitForFunction(
      ({ engine, spec }) => {
        const s = window.__llm_store().getState().status;
        return s.phase === 'ready' && s.profile?.engine === engine && s.profile?.spec === spec;
      },
      { engine, spec },
      { timeout: 300_000 },
    );
  }
  const want = ENGINE.startsWith('llamacpp') ? MODEL : `${MODEL}@${engine}`;
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    want,
    { timeout: 120_000 },
  );
  await sleep(4000);
  log(`model ${want} up`);

  // ── 1. The mechanism: the command, through pi's bash ────────────────────
  const dir = path.join(home, 'Bobble', 'units-sold');
  mkdirSync(dir, { recursive: true });
  await page.evaluate(
    (d) => window.piDesktop.invoke('pi:prompt', { message: `/harness workspace ${d}` }),
    dir,
  );
  await sleep(2000);
  // A card anchors to a turn: an empty chat shows the greeting, not a thread,
  // so one short exchange first (the model presents inside a turn in real use).
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('Reply with just the word ready.');
  await page.keyboard.press('Enter');
  await page
    .waitForFunction(
      () => {
        const s = window.__pi_store().getState();
        const replied = s.messages.some(
          (x) => x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
        );
        return replied && !s.messages.some((x) => x.isStreaming) && s.promptInFlight !== true;
      },
      undefined,
      { timeout: 180_000, polling: 1000 },
    )
    .catch(() => {});
  await sleep(1500);
  const run = async (cmd) => {
    const r = await page.evaluate((c) => window.piDesktop.invoke('pi:bash', { command: c }), cmd);
    const out = r.result?.output ?? r.error ?? '';
    log(`$ ${cmd.slice(0, 70)}…\n  ${out.split('\n')[0].slice(0, 160)}`);
    return out;
  };
  const out = await run(
    'chart bar "Units Sold by Year" --labels "2021, 2022, 2023, 2024" --values "12, 19, 15, 22" --highlight 2024 --unit units --note "Source: the brief"',
  );
  note(
    'chart command drew the file',
    /Drew a bar chart/.test(out),
    out.split('\n')[0].slice(0, 120),
  );
  await page
    .waitForSelector('[data-testid="presented-chart"] .pd-chart-bar', { timeout: 15_000 })
    .catch(() => {});
  await sleep(800);
  let s = await state();
  note(
    'the chart is an inline card in the thread',
    s.charts === 1 && s.bars === 4,
    JSON.stringify({ title: s.cardTitle, bars: s.bars }),
  );
  note(
    'the canvas did not open on its own',
    s.tabs.length === 0 && s.railOpen !== 'true',
    JSON.stringify({ tabs: s.tabs, rail: s.railOpen }),
  );
  note(
    'the card is named for the view transition',
    (s.transitionName ?? '').startsWith('pd-inline-'),
    s.transitionName ?? '',
  );
  note('the runtime has View Transitions', s.hasViewTransitions, '');
  await page.evaluate(() =>
    document.querySelector('[data-testid="presented-chart"]')?.scrollIntoView({ block: 'center' }),
  );
  await sleep(300);
  await shot('01-inline-card');

  // Hover the second band → the value reads out.
  const band = await page.$('[data-testid="presented-chart"] .pd-chart-band:nth-of-type(2)');
  const bands = await page.$$('[data-testid="presented-chart"] .pd-chart-band');
  const target = bands[1] ?? band;
  if (target) {
    const box = await target.boundingBox();
    if (box) {
      // Two moves, so a pointer already resting on the spot still raises a mouseover.
      await page.mouse.move(box.x + box.width / 2, box.y + 10);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    }
  }
  await page.waitForSelector('[data-testid="chart-tooltip"]', { timeout: 3000 }).catch(() => {});
  await sleep(200);
  s = await state();
  note(
    'hovering a bar reads its value out',
    (s.tooltip ?? '').includes('2022') && (s.tooltip ?? '').includes('19'),
    s.tooltip ?? 'no tooltip',
  );
  await shot('02-hover-tooltip');

  // Chart ⇄ table.
  await page.click('[data-testid="presented-chart"] button[aria-label="Table"]');
  await sleep(300);
  s = await state();
  const rows = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="presented-chart"] [data-testid="chart-table"] tbody tr',
      ),
    ].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent).join(' ')),
  );
  note(
    'the table toggle shows the same rows',
    s.view === 'table' && rows.length === 4 && rows[1] === '2022 19 units',
    rows.join(' | '),
  );
  await shot('03-table');
  await page.click('[data-testid="presented-chart"] button[aria-label="Chart"]');
  await sleep(300);

  // The transition, measured: every startViewTransition is recorded with the
  // animations that ran under it (the named group is the morph), and a CDP
  // screencast catches the frames while it plays — the mid-flight frame is
  // the picture of the card on its way over.
  await page.evaluate(() => {
    window.__vt = [];
    const orig = document.startViewTransition.bind(document);
    document.startViewTransition = (cb) => {
      const t = orig(cb);
      const rec = { started: performance.now(), ready: null, finished: null, animations: [] };
      window.__vt.push(rec);
      t.ready.then(() => {
        rec.ready = performance.now();
        rec.animations = document.getAnimations().map((a) => ({
          pseudo: a.effect?.pseudoElement ?? null,
          duration: a.effect?.getTiming?.().duration ?? null,
        }));
      });
      t.finished.then(() => {
        rec.finished = performance.now();
      });
      return t;
    };
  });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    frames.push({ at: Date.now(), data, ts: metadata?.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const filmed = async (label, act) => {
    frames.length = 0;
    await cdp.send('Page.startScreencast', {
      format: 'png',
      everyNthFrame: 1,
      maxWidth: 1440,
      maxHeight: 867,
    });
    await sleep(120);
    const t0 = Date.now();
    await act();
    await sleep(700);
    await cdp.send('Page.stopScreencast');
    const during = frames.filter((f) => f.at >= t0);
    const mid = during.reduce(
      (best, f) => (Math.abs(f.at - (t0 + 150)) < Math.abs(best.at - (t0 + 150)) ? f : best),
      during[0] ?? frames[frames.length - 1],
    );
    if (mid) writeFileSync(path.join(SHOT_DIR, `${label}.png`), Buffer.from(mid.data, 'base64'));
    log(`filmed ${label}: ${during.length} frames in 700ms, mid at +${mid ? mid.at - t0 : '?'}ms`);
    return during.length;
  };

  // Corner → the canvas, filmed.
  await page.mouse.move(5, 5);
  await sleep(200);
  const toCanvasFrames = await filmed('04-to-canvas-mid', () =>
    page.evaluate(() => document.querySelector('[data-testid="inline-chart-move"]').click()),
  );
  await sleep(300);
  s = await state();
  const vt1 = await page.evaluate(() => window.__vt.at(-1) ?? null);
  const named1 = (vt1?.animations ?? []).filter((a) => (a.pseudo ?? '').includes('pd-inline-'));
  note(
    'the move to the canvas ran as a view transition with the card morphing',
    vt1 !== null &&
      vt1.finished !== null &&
      named1.some((a) => (a.pseudo ?? '').startsWith('::view-transition-group')),
    JSON.stringify({
      took: vt1 ? Math.round(vt1.finished - vt1.started) : null,
      named: named1.map((a) => `${a.pseudo} ${a.duration}ms`),
      frames: toCanvasFrames,
    }),
  );
  note(
    'Open in canvas lifts the card into a chart tab and leaves a stub',
    s.tabs.length === 1 &&
      s.tabs[0].kind === 'chart' &&
      s.tabs[0].inline &&
      s.stubs === 1 &&
      s.charts === 0 &&
      s.railOpen === 'true' &&
      s.canvasChartBars === 4,
    JSON.stringify({
      tabs: s.tabs,
      stubs: s.stubs,
      rail: s.railOpen,
      canvasBars: s.canvasChartBars,
      stub: s.stub,
    }),
  );
  note('the tab offers Show in chat', s.showInChat, '');
  await shot('05-canvas');

  // Back: the tab's own Show in chat, filmed.
  await filmed('06-to-chat-mid', () =>
    page.evaluate(() => document.querySelector('.pd-canvas-show-inline').click()),
  );
  await sleep(300);
  s = await state();
  const vt2 = await page.evaluate(() => window.__vt.at(-1) ?? null);
  const named2 = (vt2?.animations ?? []).filter((a) => (a.pseudo ?? '').includes('pd-inline-'));
  note(
    'the drop back into the chat ran as a view transition with the panel morphing into the card',
    vt2 !== null &&
      vt2 !== vt1 &&
      vt2.finished !== null &&
      named2.some((a) => (a.pseudo ?? '').startsWith('::view-transition-group')),
    JSON.stringify({
      took: vt2 ? Math.round(vt2.finished - vt2.started) : null,
      named: named2.map((a) => `${a.pseudo} ${a.duration}ms`),
    }),
  );
  note(
    'Show in chat drops the tab back into the card',
    s.tabs.length === 0 && s.charts === 1 && s.bars === 4 && s.stubs === 0,
    JSON.stringify({ tabs: s.tabs, charts: s.charts, bars: s.bars }),
  );
  await shot('07-back-inline');

  // The same card on the light ground (the theme sheet keys off data-mode).
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-mode', 'light');
    document.documentElement.style.colorScheme = 'light';
  });
  await sleep(600);
  const lightBands = await page.$$('[data-testid="presented-chart"] .pd-chart-band');
  const lb = lightBands[2];
  if (lb) {
    const box = await lb.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }
  await sleep(400);
  await shot('07b-light-inline');
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.querySelector('[data-testid="inline-chart-move"]').click());
  await sleep(900);
  await shot('07c-light-canvas');
  await page.evaluate(() => document.querySelector('.pd-canvas-show-inline').click());
  await sleep(900);
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-mode', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  });
  await sleep(400);

  // Not just bars: a two-series line and a donut, each its own card.
  const lineOut = await run(
    'chart line "Revenue vs Cost" --labels "Q1, Q2, Q3, Q4" --values "Revenue: 4.2, 5.1, 6.4, 7.0; Cost: 3.1, 3.4, 3.9, 4.2" --unit "$" --subtitle "millions"',
  );
  note(
    'a two-series line chart drew',
    /Drew a line chart .*2 series/.test(lineOut),
    lineOut.split('\n')[0].slice(0, 120),
  );
  const donutOut = await run(
    'chart donut "Market share" --labels "Acme, Globex, Initech, Others" --values "38, 27, 20, 15" --unit % --highlight Acme',
  );
  note(
    'a donut chart drew',
    /Drew a donut chart/.test(donutOut),
    donutOut.split('\n')[0].slice(0, 120),
  );
  await sleep(1500);
  s = await state();
  note(
    'every chart is its own inline card',
    s.charts === 3 && s.tabs.length === 0,
    JSON.stringify({ charts: s.charts, tabs: s.tabs }),
  );
  await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-testid="presented-chart"]');
    cards[cards.length - 1]?.scrollIntoView({ block: 'end' });
  });
  await sleep(400);
  await shot('08-line-and-donut');
  // The donut's hover: a slice reads its share.
  const slice = (await page.$$('[data-testid="presented-chart"] .pd-chart-slice'))[0];
  if (slice) {
    const box = await slice.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(400);
    await shot('09-donut-hover');
  }
  await page.mouse.move(5, 5);

  // ── Looks and edits — the user: "square not rounded looks bad … we CANNOT have
  // 'all charts from bobble look the same generic'" and "say the user asks for
  // edits to the chart in any way … it all needs to work. styling from image".
  const unitsFile = /Drew a bar chart[^:]*: (\S+\.svg)/.exec(out)?.[1] ?? '';
  const cardShot = async (label, index = -1) => {
    const cards = await page.$$('[data-testid="presented-chart"]');
    const card = cards.at(index);
    if (card === undefined) return;
    await card.scrollIntoViewIfNeeded();
    await sleep(350);
    await card.screenshot({ path: path.join(SHOT_DIR, `${label}.png`) });
    log(`shot ${label}`);
  };
  // The chat's own folder: the first message gave the chat a project folder,
  // which is where the charts above landed.
  const chatDir = (await page.evaluate(() => window.__pi_workspace?.() ?? null)) ?? dir;
  log(`chat folder: ${chatDir}`);
  const lastCard = (index = -1) =>
    page.evaluate((i) => {
      const cards = document.querySelectorAll('[data-testid="presented-chart"]');
      const card = cards[i < 0 ? cards.length + i : i];
      const view = card?.querySelector('[data-testid="chart-view"]');
      const bars = [...(card?.querySelectorAll('.pd-chart-bar') ?? [])];
      return {
        look: view?.getAttribute('data-chart-look') ?? null,
        ground: view?.hasAttribute('data-chart-ground') ?? false,
        bars: bars.length,
        fills: [...new Set(bars.map((b) => b.getAttribute('fill')))],
        rounded: bars.some((b) => /a\d/.test(b.getAttribute('d') ?? '')),
        barWidth: bars[0]?.getBBox?.().width ?? null,
        font: view ? getComputedStyle(view).fontFamily : null,
        legend: [...(card?.querySelectorAll('.pd-chart-svg text') ?? [])]
          .map((t) => t.textContent)
          .filter((t) => t === 'Cost' || t === 'Units Sold by Year'),
      };
    }, index);
  // The units chart is the first card; an edit re-presents it at the end.
  const before = await lastCard(0);
  note(
    'bars are rounded, not square',
    before.rounded === true && before.bars === 4,
    JSON.stringify(before),
  );
  // Edit 1: a second series for comparison, thinner bars, a new accent.
  const e1 = await run(
    `chart edit ${unitsFile} --add "Cost: 8, 12, 10, 14" --bars thin --accent coral`,
  );
  note(
    'chart edit added a series, thinned the bars and recoloured',
    /Changed added Cost, the look/.test(e1),
    e1.split('\n')[0].slice(0, 140),
  );
  await sleep(1500);
  const after1 = await lastCard();
  note(
    'the edited card shows grouped bars, thinner, with the new accent',
    after1.bars === 8 &&
      after1.barWidth !== null &&
      before.barWidth !== null &&
      after1.barWidth < before.barWidth * 0.75 &&
      after1.legend.includes('Cost'),
    JSON.stringify({
      before: before.barWidth,
      after: after1.barWidth,
      bars: after1.bars,
      legend: after1.legend,
    }),
  );
  await cardShot('11-edit-add-series-thin-coral');
  // Edit 2: a whole new look.
  const e2 = await run(`chart edit ${unitsFile} --look sunset`);
  note('chart edit changed the look', /Changed the look/.test(e2), e2.split('\n')[0].slice(0, 120));
  await sleep(1500);
  const after2 = await lastCard();
  note(
    'the card wears sunset (pill bars, its palette)',
    after2.look === 'sunset' && after2.fills.includes('#F0563C'),
    JSON.stringify({ look: after2.look, fills: after2.fills }),
  );
  await cardShot('12-edit-look-sunset');
  // Edit 3: colours from a picture — a screenshot of this very window.
  const shotPath = path.join(chatDir, 'reference.png');
  await page.screenshot({ path: shotPath });
  const e3 = await run(`chart edit ${unitsFile} --from_image reference.png`);
  note(
    'chart edit took its colours from an image',
    /Colours from reference\.png/.test(e3),
    e3
      .split('\n')
      .find((l) => l.startsWith('Colours from'))
      ?.slice(0, 160) ?? e3.slice(0, 120),
  );
  await sleep(1500);
  const after3 = await lastCard();
  note(
    'the card wears the picture\u2019s ground and colours',
    after3.ground === true,
    JSON.stringify({ fills: after3.fills, ground: after3.ground }),
  );
  await cardShot('13-edit-from-image');
  // Edit 4: a value, a removed series, a sort into a ranking.
  const e4 = await run(
    `chart edit ${unitsFile} --set "2023: 30" --remove Cost --sort desc --type hbar --look mono`,
  );
  note(
    'chart edit set a value, removed the series, sorted and re-typed',
    /Changed type bar → hbar, removed Cost, the data, the look/.test(e4),
    e4.split('\n')[0].slice(0, 140),
  );
  await sleep(1500);
  await cardShot('14-edit-hbar-ranked-mono');
  // A gallery: the same data in six looks, each its own card.
  const GALLERY = ['soft', 'bold', 'editorial', 'slate', 'terminal', 'candy'];
  for (const look of GALLERY) {
    const g = await run(
      `chart bar "Quarterly revenue (${look})" --labels "Q1, Q2, Q3, Q4" --values "Product: 4.2, 5.1, 6.4, 7.0; Services: 2.1, 2.6, 2.4, 3.3" --unit "$" --subtitle millions --look ${look} --out gallery-${look}.svg`,
    );
    if (!/Drew a bar chart/.test(g)) note(`gallery ${look} drew`, false, g.slice(0, 120));
  }
  await sleep(2500);
  const gallery = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="presented-chart"] [data-testid="chart-view"]')]
      .map((v) => v.getAttribute('data-chart-look'))
      .filter((l) => l !== null),
  );
  note(
    'six looks, six different cards',
    GALLERY.every((l) => gallery.includes(l)),
    gallery.join(', '),
  );
  for (let i = 0; i < GALLERY.length; i += 1) {
    await cardShot(`15-look-${GALLERY[i]}`, i - GALLERY.length);
  }
  const areaOut = await run(
    'chart area "Signups" --labels "Jan, Feb, Mar, Apr, May, Jun" --values "120, 180, 150, 260, 310, 290" --look ocean --out signups.svg',
  );
  note(
    'a smooth gradient area chart drew',
    /Drew an area chart/.test(areaOut),
    areaOut.split('\n')[0].slice(0, 100),
  );
  await sleep(1200);
  await cardShot('16-area-ocean-smooth');

  // Small SVGs go inline too; a poster-sized drawing keeps its canvas tab.
  writeFileSync(
    path.join(chatDir, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="40" fill="#2F6FE4"/><path d="M30 50l12 12 24-28" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );
  writeFileSync(
    path.join(chatDir, 'poster.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#E8863A"/><text x="960" y="560" font-size="120" text-anchor="middle" fill="#fff">POSTER</text></svg>`,
  );
  await run('coordinate present icon.svg');
  await sleep(1500);
  const svgState = await page.evaluate(() => {
    const c = window.__pi_canvas?.();
    return {
      inlineSvgs: document.querySelectorAll(
        '[data-testid="presented-svg"] .pd-inline-widget-box svg',
      ).length,
      tabs: (c?.getState?.().tabs ?? []).map((t) => t.kind),
    };
  });
  note(
    'a small SVG is shown inline, no canvas tab',
    svgState.inlineSvgs === 1 && svgState.tabs.length === 0,
    JSON.stringify(svgState),
  );
  await run('coordinate present poster.svg');
  await sleep(2500);
  const posterState = await page.evaluate(() => {
    const c = window.__pi_canvas?.();
    return {
      inlineSvgs: document.querySelectorAll('[data-testid="presented-svg"]').length,
      cards: document.querySelectorAll(
        '[data-testid="presented"] .pd-present-card, [data-testid="presented"] [data-testid="present-card"]',
      ).length,
      tabs: (c?.getState?.().tabs ?? []).map((t) => ({ kind: t.kind, title: t.title })),
    };
  });
  note(
    'a poster-sized SVG goes to the canvas as before',
    posterState.inlineSvgs === 1 &&
      posterState.tabs.some((t) => t.kind === 'svg' && t.title === 'poster.svg'),
    JSON.stringify(posterState),
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="presented-svg"]')?.scrollIntoView({ block: 'center' });
  });
  await sleep(400);
  await shot('09b-small-svg-inline-poster-canvas');
  // Leave the canvas closed for the model half.
  await page.evaluate(() => {
    const c = window.__pi_canvas?.();
    for (const t of c?.getState?.().tabs ?? []) c.closeTab(t.id);
  });
  await sleep(500);

  // ── 2. The model: does it reach for `chart`? ───────────────────────────
  if (!SKIP_MODEL) {
    await page.click('[data-testid="new-chat"]').catch(() => {});
    await sleep(1500);
    const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
    const prompt =
      'Here are units sold (thousands) by year: 2021: 12, 2022: 19, 2023: 27, 2024: 35. Make a bar chart of it and show me.';
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(prompt);
    await page.keyboard.press('Enter');
    const t0 = Date.now();
    const ended = await page
      .waitForFunction(
        (k) => {
          const s = window.__pi_store().getState();
          const m = s.messages.slice(k);
          const replied = m.some(
            (x) =>
              x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
          );
          return replied && !s.messages.some((x) => x.isStreaming) && s.promptInFlight !== true;
        },
        n,
        { timeout: TURN_CAP_MS, polling: 1000 },
      )
      .then(() => true)
      .catch(() => false);
    await sleep(5000);
    const secs = Math.round((Date.now() - t0) / 1000);
    const tail = await page.evaluate((k) => {
      const s = window.__pi_store().getState();
      const m = s.messages.slice(k);
      const results = new Map();
      for (const x of m) if (x.kind === 'toolResult') results.set(x.toolCallId, x);
      const calls = [];
      for (const x of m) {
        if (x.kind !== 'assistant') continue;
        for (const b of x.blocks ?? []) {
          if (b.type !== 'toolCall') continue;
          const r = results.get(b.id);
          calls.push({
            name: b.name,
            command:
              typeof b.arguments?.command === 'string'
                ? b.arguments.command
                : JSON.stringify(b.arguments ?? {}),
            error: r?.isError === true,
            result: String(r?.text ?? '').slice(0, 200),
          });
        }
      }
      const text = m
        .filter((x) => x.kind === 'assistant')
        .flatMap((x) => (x.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text))
        .join('\n');
      return {
        calls,
        text,
        charts: document.querySelectorAll('[data-testid="presented-chart"]').length,
      };
    }, n);
    const cmdText = tail.calls.map((c) => `${c.name} ${c.command}`).join('\n');
    note('model turn ended', ended, `${secs}s`);
    note(
      'the model reached for chart',
      /\bchart\b/.test(cmdText),
      tail.calls.map((c) => `${c.name}: ${c.command.slice(0, 80)}`).join(' | '),
    );
    note(
      'the model did not paint, plot or pipeline it',
      !/media generate image|matplotlib|office make|office_make/.test(cmdText),
      '',
    );
    note('the chart card appeared', tail.charts >= 1, `${tail.charts} card(s)`);
    // A redundant `coordinate present` with no path after the chart (the card
    // is already shown) is a stray the CLI answers with usage — noted, not a
    // failure of the chart; an error on a chart call is.
    const chartErrors = tail.calls.filter(
      (c) => c.error && /\bchart\b/.test(`${c.name} ${c.command}`),
    );
    const strays = tail.calls.filter((c) => c.error && !/\bchart\b/.test(`${c.name} ${c.command}`));
    note(
      'no chart tool errors',
      chartErrors.length === 0,
      `${chartErrors.map((c) => c.result.slice(0, 100)).join(' | ')}${strays.length > 0 ? ` (stray: ${strays.map((c) => c.command.slice(0, 40)).join(', ')})` : ''}`,
    );
    log(`reply: ${tail.text.slice(0, 300).replace(/\n/g, ' ')}`);
    await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="presented-chart"]');
      cards[cards.length - 1]?.scrollIntoView({ block: 'center' });
    });
    await sleep(500);
    await shot('10-model-chart');
    writeFileSync(
      path.join(SHOT_DIR, 'model-turn.json'),
      JSON.stringify({ secs, ...tail }, null, 2),
    );
  }

  const md = [
    `# Inline data visuals — ${MODEL} on ${ENGINE}`,
    '',
    '| check | result | detail |',
    '|---|---|---|',
    ...findings.map(
      (f) => `| ${f.name} | ${f.pass ? 'PASS' : 'FAIL'} | ${f.detail.replace(/\|/g, '\\|')} |`,
    ),
  ].join('\n');
  writeFileSync(path.join(SHOT_DIR, 'results.md'), `${md}\n`);
  console.log(`\n${md}`);
  check(
    findings.every((f) => f.pass),
    `${findings.filter((f) => !f.pass).length} check(s) failed`,
  );
} finally {
  await finish();
}
