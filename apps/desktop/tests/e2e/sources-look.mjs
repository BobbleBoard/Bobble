/**
 * SOURCES IN AN ANSWER — the chips, their hover card, the Sources card and the
 * search row, on a research turn staged without a model or the internet.
 *
 * the user (2026-09-24): "source citing (for research and such, examples from
 * google search summary shown)" … "hyperframes and the app's own ui for
 * showing sources and such are all very much part of this".
 *
 * Stages two turns the way the app receives them:
 *
 *   turn 1  CLI mode (the default): `web search …` and two `web fetch …` lines
 *           through `bash`, then an answer that cites with markdown links —
 *           after sentences, merged runs, a parenthesised pair, and one link
 *           to a page the turn never saw (which must stay an ordinary link);
 *   turn 2  schemas mode: a native `web_search` call and a one-paragraph
 *           answer citing one result.
 *
 * Every source lives on a reserved `.example` host (RFC 2606, as in
 * _mock-web.mjs), so no fixture can pretend to be a real organisation or ever
 * resolve to one. The pages, their icons and their og:images are served by a
 * loopback double below; the app's main process reaches it through
 * `PI_E2E_SOURCES_ORIGIN`, the seam that rewrites `https://<host>/<path>` to
 * `<origin>/site/<host>/<path>` (the same route shape _mock-web.mjs serves).
 * One site has no icon (the letter tile) and one page has no og:image (a row
 * with no thumbnail), because both happen on the real web.
 *
 * Shots, light and dark (OUT, default /tmp/sources-look):
 *   01-answer-*            the answer with its chips
 *   02-hover-card-*        a merged chip's hover card, open
 *   03-sources-collapsed-* the Sources card: three rows and "Show all"
 *   04-sources-expanded-*  …expanded in place, "Show less"
 *   05-search-row-*        the chain reopened: the search row, compact
 *   06-turn2-*             the schemas-mode turn: its chip and search row
 *
 * The checks assert the new UI, so the unmodified app FAILS them — that run is
 * the "before" picture, not a regression.
 *
 *   OUT=/tmp/sources-look node apps/desktop/tests/e2e/sources-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { cropPng, encodePng } from './png.mjs';

const OUT = process.env.OUT ?? '/tmp/sources-look';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── fixture pictures, painted here (no image library, nothing copied) ─── */

/** A seeded PRNG, so every run paints the same pixels. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A 32×32 site icon: a rounded tile in `bg` with a simple mark in `fg`. */
function icon(bg, fg, mark) {
  const n = 32;
  const data = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      // Rounded-square mask (radius 7).
      const cx = Math.min(Math.max(x, 7), n - 8);
      const cy = Math.min(Math.max(y, 7), n - 8);
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= 7.5 ** 2;
      if (!inside) continue;
      const dx = x - 15.5;
      const dy = y - 15.5;
      let on = false;
      if (mark === 'ring') on = Math.abs(Math.hypot(dx, dy) - 8) < 2.2;
      else if (mark === 'dot') on = Math.hypot(dx, dy) < 6.5;
      else if (mark === 'bars')
        on = Math.abs(dy) < 8 && Math.abs(dx) < 9 && Math.floor((dx + 9) / 4) % 2 === 0;
      else if (mark === 'tri') on = dy > -8 && dy < 7 && Math.abs(dx) < (dy + 8) * 0.62;
      else if (mark === 'plus')
        on = (Math.abs(dx) < 2.2 && Math.abs(dy) < 9) || (Math.abs(dy) < 2.2 && Math.abs(dx) < 9);
      else if (mark === 'wave') on = Math.abs(dy - Math.sin(dx / 2.4) * 4) < 2 && Math.abs(dx) < 10;
      const c = on ? fg : bg;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return encodePng({ width: n, height: n, channels: 4, data });
}

/**
 * A 480×320 "figure": glowing strands on a dark field in the page's own
 * colours — the kind of image a connectomics article leads with, without
 * being anyone's actual picture.
 */
function figure(seed, a, b) {
  const w = 480;
  const h = 320;
  const r = rng(seed);
  const strands = Array.from({ length: 26 }, () => ({
    x: r() * w,
    y: r() * h,
    ang: r() * Math.PI * 2,
    len: 60 + r() * 180,
    t: r(),
  }));
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = 0.12 + 0.1 * (1 - y / h);
      let R = 10 + v * 30;
      let G = 12 + v * 34;
      let B = 20 + v * 60;
      for (const s of strands) {
        const ex = s.x + Math.cos(s.ang) * s.len;
        const ey = s.y + Math.sin(s.ang) * s.len;
        const vx = ex - s.x;
        const vy = ey - s.y;
        const t = Math.max(0, Math.min(1, ((x - s.x) * vx + (y - s.y) * vy) / (vx * vx + vy * vy)));
        const d = Math.hypot(x - (s.x + vx * t), y - (s.y + vy * t));
        if (d > 7) continue;
        const glow = Math.exp(-(d * d) / 6);
        const c = s.t < 0.5 ? a : b;
        R += c[0] * glow * 0.9;
        G += c[1] * glow * 0.9;
        B += c[2] * glow * 0.9;
      }
      data[i] = Math.min(255, R);
      data[i + 1] = Math.min(255, G);
      data[i + 2] = Math.min(255, B);
    }
  }
  return encodePng({ width: w, height: h, channels: 3, data });
}

/* ── the corpus: eight fictional pages on reserved hosts ─────────────────── */

const PAGES = [
  {
    url: 'https://brainatlas.example/news/whole-fly-brain-connectome',
    site: 'Brain Atlas Project',
    title: 'The first complete wiring diagram of an adult fly brain',
    snippet:
      'Researchers have mapped all 139,255 neurons and 54.5 million synapses of an adult fruit fly brain, the largest complete connectome to date.',
    icon: { bg: [24, 88, 160], fg: [255, 255, 255], mark: 'ring' },
    image: { seed: 11, a: [90, 170, 255], b: [255, 120, 180] },
  },
  {
    url: 'https://neurojournal.example/articles/flywire-whole-brain',
    site: 'Neuro Journal',
    title: 'Whole-brain annotation and cell typing of the adult Drosophila brain',
    snippet:
      'A consortium of labs annotated 8,453 cell types across the whole adult fly brain and released the data openly to the research community.',
    icon: { bg: [196, 64, 40], fg: [255, 244, 236], mark: 'bars' },
    image: { seed: 23, a: [255, 170, 80], b: [120, 220, 200] },
  },
  {
    url: 'https://healthresearch.example/news/complete-wiring-map-adult-fruit-fly-brain',
    site: 'National Health Research',
    title: 'Complete wiring map of an adult fruit fly brain',
    snippet:
      'At a glance: scientists built a neuron-by-neuron and synapse-by-synapse roadmap of the brain of an adult fruit fly, funded in part by the agency.',
    icon: { bg: [30, 40, 60], fg: [140, 200, 255], mark: 'dot' },
    image: { seed: 37, a: [110, 200, 255], b: [180, 255, 220] },
  },
  {
    url: 'https://techreview.example/2026/09/how-ai-traced-a-fly-brain',
    site: 'Tech Review',
    title: 'How AI traced fifty million synapses in a fly brain',
    snippet:
      'Machine learning did the first pass on 7,050 electron-microscope sections; human proofreaders spent roughly 33 person-years correcting it.',
    icon: { bg: [20, 20, 20], fg: [255, 214, 60], mark: 'tri' },
    image: { seed: 41, a: [255, 214, 90], b: [110, 150, 255] },
  },
  {
    url: 'https://medschool.example/news/fly-nerve-cord-connectome',
    site: 'Medical School News',
    title: 'Researchers publish first complete connectome of a fly nerve cord',
    snippet:
      'The map of the male fly ventral nerve cord, which works much like a spinal cord, links the brain to the legs and wings for the first time.',
    icon: { bg: [150, 24, 48], fg: [255, 255, 255], mark: 'plus' },
    image: { seed: 53, a: [255, 110, 120], b: [255, 200, 120] },
  },
  {
    url: 'https://forum.example/r/askscience/fly-brain-simulation',
    site: 'Ask Science Forum',
    title: 'ELI5: what did the fly brain simulation actually show?',
    snippet:
      'Simulation fidelity limits: the model reproduces feeding and grooming circuits but leaves out neuromodulators and most of real neurochemistry.',
    // No icon anywhere on this host: the letter tile.
    image: { seed: 67, a: [255, 150, 90], b: [255, 255, 255] },
  },
  {
    url: 'https://labnotes.example/2026/male-cns-connectome',
    site: 'Lab Notes',
    title: 'A connectome of the entire male fly central nervous system',
    snippet:
      'Brain and nerve cord together: 166,000 neurons, the first whole-CNS connectome of any animal with a brain this complex.',
    icon: { bg: [36, 120, 90], fg: [230, 255, 240], mark: 'wave' },
    // No og:image: a row with no thumbnail.
  },
  {
    url: 'https://encyclopedia.example/wiki/Drosophila_connectome',
    site: 'Open Encyclopedia',
    title: 'Drosophila connectome',
    snippet:
      'The Drosophila connectome is the complete map of neural connections in the brain of the fruit fly, published in stages from 2020.',
    icon: { bg: [235, 235, 235], fg: [40, 40, 40], mark: 'ring' },
    image: { seed: 79, a: [200, 200, 210], b: [140, 170, 255] },
  },
];

const SECOND = [
  {
    url: 'https://techreview.example/2026/09/how-ai-traced-a-fly-brain',
    ...PAGES[3],
  },
  {
    url: 'https://sciencenews.example/2024/10/fly-brain-proofreading',
    site: 'Science News Daily',
    title: 'Hundreds of volunteers proofread the fly brain, one neuron at a time',
    snippet:
      'Citizen scientists and 76 labs corrected the automated tracing, a job that would have taken one person about 33 years.',
    icon: { bg: [236, 110, 30], fg: [255, 255, 255], mark: 'dot' },
    image: { seed: 97, a: [255, 180, 90], b: [90, 200, 255] },
  },
];

const ALL = [...PAGES, SECOND[1]];
const byHost = new Map();
for (const p of ALL) {
  const u = new URL(p.url);
  const list = byHost.get(u.host) ?? [];
  list.push(p);
  byHost.set(u.host, list);
}
const slug = (p) => new URL(p.url).pathname.split('/').filter(Boolean).pop();

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function pageHtml(p) {
  const host = new URL(p.url).host;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(p.title)} | ${esc(p.site)}</title>
<meta name="description" content="${esc(p.snippet)}">
<meta property="og:site_name" content="${esc(p.site)}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.snippet)}">
${p.image ? `<meta property="og:image" content="https://${host}/og/${slug(p)}.png">` : ''}
${p.icon ? '<link rel="icon" type="image/png" href="/favicon.png">' : ''}
</head><body><article><h1>${esc(p.title)}</h1><p>${esc(p.snippet)}</p>
<p>Fixture page served by sources-look.mjs. Nothing here is real.</p></article></body></html>`;
}

/* ── the loopback double the app's main process is pointed at ─────────── */

const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const m = /^\/site\/([^/]+)(\/.*)?$/.exec(url.pathname);
  requests.push(url.pathname);
  if (m === null) {
    res.writeHead(404).end();
    return;
  }
  const host = m[1];
  const rest = m[2] ?? '/';
  const pages = byHost.get(host) ?? [];
  const withIcon = pages.find((p) => p.icon !== undefined);
  if (rest === '/favicon.png' && withIcon) {
    const { bg, fg, mark } = withIcon.icon;
    res.writeHead(200, { 'content-type': 'image/png' }).end(icon(bg, fg, mark));
    return;
  }
  const og = /^\/og\/(.+)\.png$/.exec(rest);
  if (og !== null) {
    const p = pages.find((q) => slug(q) === og[1] && q.image !== undefined);
    if (p) {
      res
        .writeHead(200, { 'content-type': 'image/png' })
        .end(figure(p.image.seed, p.image.a, p.image.b));
      return;
    }
  }
  const page = pages.find((p) => new URL(p.url).pathname === rest);
  if (page) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml(page));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not in the fixture');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* ── the turns ──────────────────────────────────────────────────────────── */

/** What `web search` prints (packages/web-tools, the text body both modes see). */
function searchText(rows) {
  const lines = rows.map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`);
  return `${rows.length} result(s) via duckduckgo\n\n${lines.join('\n\n')}`;
}
/** What `web fetch` prints. */
function fetchText(p) {
  return `# ${p.title}\nURL: ${p.url}\n\n${p.snippet}\n\nThe full article continues here.`;
}

const [atlas, journal, health, tech, medschool, forum] = PAGES;
const ANSWER = [
  `Scientists have now mapped the complete wiring diagram of an adult fruit fly brain: about **139,000 neurons** joined by more than **50 million synapses**, the largest brain ever charted at synapse resolution. [Brain Atlas Project](${atlas.url}) [Neuro Journal](${journal.url}) [National Health Research](${health.url})`,
  '',
  '### How it was made',
  '',
  `- **Slicing and imaging:** the brain was cut into about 7,000 ultra-thin sections and imaged with an electron microscope. [Tech Review](${tech.url})`,
  `- **AI plus people:** machine-learning models traced every neuron, and human proofreaders spent roughly 33 person-years checking the result ([Brain Atlas Project](${atlas.url}), [Tech Review](${tech.url})).`,
  '',
  "### What's new",
  '',
  `- **The whole nervous system:** a second team has mapped the male fly's entire central nervous system, including the nerve cord that works like a spinal cord. [Medical School News](${medschool.url})`,
  `- **Brains that run:** the map has been used to simulate a fly brain that reproduces feeding and grooming, though the simulation leaves out most of real neurochemistry. [Ask Science Forum](${forum.url}) [Neuro Journal](${journal.url})`,
  '',
  'The data is open: anyone can explore it in the [open connectome viewer](https://viewer.connectome.example/).',
].join('\n');

const user1 = {
  kind: 'user',
  id: 'u1',
  text: "What's the latest on the fruit fly brain connectome? Give me a short summary with sources.",
  timestamp: 1,
};
const bash = (id, command) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } });
const result = (callId, assistantId, toolName, text, t) => ({
  kind: 'toolResult',
  id: `tr-${assistantId}-${callId}`,
  toolCallId: callId,
  assistantId,
  toolName,
  text,
  isError: false,
  timestamp: t,
});
const turn1 = [
  user1,
  {
    kind: 'assistant',
    id: 'a1',
    timestamp: 10,
    blocks: [
      {
        type: 'thinking',
        thinking:
          'The user wants recent news on the fly connectome. Search first, then read the two most authoritative pages.',
      },
      bash('c1', 'web search "fruit fly brain connectome latest"'),
    ],
  },
  result('c1', 'a1', 'bash', searchText(PAGES), 20),
  {
    kind: 'assistant',
    id: 'a2',
    timestamp: 30,
    blocks: [bash('c2', `web fetch ${atlas.url}`), bash('c3', `web fetch ${health.url}`)],
  },
  result('c2', 'a2', 'bash', fetchText(atlas), 40),
  result('c3', 'a2', 'bash', fetchText(health), 45),
  {
    kind: 'assistant',
    id: 'a3',
    timestamp: 50,
    blocks: [{ type: 'text', text: ANSWER }],
  },
];

const ANSWER2 = `Roughly **33 person-years** of human proofreading, spread across hundreds of volunteers and 76 labs, on top of the automated tracing. [Science News Daily](${SECOND[1].url})`;
const turn2 = [
  { kind: 'user', id: 'u2', text: 'How long did the proofreading take?', timestamp: 60 },
  {
    kind: 'assistant',
    id: 'b1',
    timestamp: 70,
    blocks: [
      {
        type: 'toolCall',
        id: 'n1',
        name: 'web_search',
        arguments: { query: 'fly connectome proofreading person-years' },
      },
    ],
  },
  result('n1', 'b1', 'web_search', searchText(SECOND), 80),
  { kind: 'assistant', id: 'b2', timestamp: 90, blocks: [{ type: 'text', text: ANSWER2 }] },
];

/* ── the run ────────────────────────────────────────────────────────────── */

const { page, check, finish } = await launchApp('sources-look', {
  env: { PI_E2E_NO_SERVER: '1', PI_E2E_SOURCES_ORIGIN: ORIGIN },
  waitFor: '[data-testid="composer-input"]',
});

const shot = async (label) => {
  const buf = await page.screenshot();
  writeFileSync(path.join(OUT, `${label}.png`), buf);
  return buf;
};
/** The card cut out of a full-window shot (element screenshots flash the window). */
const crop = async (label, buf, selector, pad = 16) => {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio };
  }, selector);
  if (box === null) return;
  const s = box.dpr;
  writeFileSync(
    path.join(OUT, `${label}.png`),
    cropPng(buf, {
      x: (box.x - pad) * s,
      y: (box.y - pad) * s,
      width: (box.width + pad * 2) * s,
      height: (box.height + pad * 2) * s,
    }),
  );
};
const scrollTo = (selector, block = 'start') =>
  page.evaluate(
    ([sel, b]) => document.querySelector(sel)?.scrollIntoView({ block: b }),
    [selector, block],
  );
const setMode = (mode) =>
  page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), mode);
const cdp = await page.context().newCDPSession(page);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(800);
  await page.evaluate(
    (messages) => window.__pi_store().getState().setMessagesExternal(messages),
    [...turn1, ...turn2],
  );
  await page.waitForSelector('.pd-markdown', { timeout: 10000 });
  // Metadata, icons and thumbnails come through main from the loopback double.
  await sleep(4000);
  const canvasOpen = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-canvas-tab')].map((t) => t.getAttribute('data-kind')),
  );
  check(
    !canvasOpen.includes('browser'),
    `a fetched page is not browsing: the canvas did not open the browser (${JSON.stringify(canvasOpen)})`,
  );

  /* What the answer made of its links. */
  const links = await page.evaluate(() => {
    const first = document.querySelectorAll('.pd-msg')[1] ?? document;
    return {
      chips: [...document.querySelectorAll('[data-testid="source-chip"]')].map((c) => ({
        label: c.textContent?.trim() ?? '',
        count: Number(c.getAttribute('data-count') ?? '0'),
        icon: c.querySelector('img')?.getAttribute('src')?.slice(0, 11) ?? null,
      })),
      plain: [...document.querySelectorAll('.pd-markdown a[href]')].map((a) =>
        a.getAttribute('href'),
      ),
      sourcesCards: document.querySelectorAll('[data-testid="sources-card"]').length,
      firstMsg: first !== document,
      remoteImages: [...document.querySelectorAll('img')]
        .map((i) => i.getAttribute('src') ?? '')
        .filter((s) => /^https?:/i.test(s)),
    };
  });
  console.log(JSON.stringify(links, null, 2));

  // Turn 1: [atlas journal health], [tech], ([atlas], [tech]), [medschool],
  // [forum journal]; turn 2: [sciencenews] — six runs, six chips.
  check(links.chips.length === 6, `the answers' source links became chips (${links.chips.length})`);
  check(
    links.chips.some((c) => c.count === 3 && /\+2$/.test(c.label)),
    `three links in a row merged into ONE chip reading "+2" (${JSON.stringify(links.chips.map((c) => c.label))})`,
  );
  check(
    links.chips.some((c) => c.count === 2 && /\+1$/.test(c.label)),
    'the parenthesised pair merged into one "+1" chip',
  );
  check(
    links.plain.includes('https://viewer.connectome.example/'),
    'a link to a page the turn never saw stays an ordinary link',
  );
  check(
    !links.plain.some((h) => /brainatlas|neurojournal|healthresearch/.test(h ?? '')),
    'no source link is left as plain link text',
  );
  check(
    links.chips.some((c) => c.icon === 'data:image/'),
    'chips carry the site icon as a data: URI (resolved in main)',
  );
  check(links.remoteImages.length === 0, `no remote image in the page (${links.remoteImages})`);
  check(
    links.sourcesCards === 2,
    `each researched answer ends in a Sources card (${links.sourcesCards})`,
  );

  for (const mode of ['dark', 'light']) {
    await setMode(mode);
    await sleep(500);

    /* 01 — the answer */
    await scrollTo('.pd-markdown');
    await page.evaluate(() => {
      document.querySelector('[data-testid="chat-scroll"]')?.scrollBy(0, -24);
    });
    await sleep(400);
    await shot(`01-answer-${mode}`);

    /* 02 — the merged chip's hover card */
    const chip = await page.$('[data-testid="source-chip"][data-count="3"]');
    if (chip !== null) {
      await chip.hover();
      await page
        .waitForSelector('[data-testid="source-hovercard"]', { timeout: 3000 })
        .catch(() => undefined);
      await sleep(500);
      const buf = await shot(`02-hover-card-${mode}`);
      await crop(`02-hover-card-${mode}-crop`, buf, '[data-testid="source-hovercard"]', 24);
      const card = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="source-hovercard"]');
        if (el === null) return null;
        return {
          rows: el.querySelectorAll('[data-testid="source-row"]').length,
          titles: [...el.querySelectorAll('[data-testid="source-row-title"]')].map(
            (t) => t.textContent,
          ),
          thumbs: el.querySelectorAll('img[data-role="thumb"]').length,
        };
      });
      console.log('hover card:', JSON.stringify(card));
      if (mode === 'dark') {
        check(
          card !== null && card.rows === 3,
          `the hover card lists the chip's three sources (${JSON.stringify(card)})`,
        );
        check(card !== null && card.thumbs >= 2, 'rows with an og:image show a thumbnail');
      }
      await page.mouse.move(5, 5);
      await sleep(600);
    } else if (mode === 'dark') {
      check(false, 'no merged chip to hover');
    }

    /* 03/04 — the Sources card */
    const cardSel = '[data-testid="sources-card"]';
    if ((await page.$(cardSel)) !== null) {
      await scrollTo(cardSel, 'center');
      await sleep(400);
      let buf = await shot(`03-sources-collapsed-${mode}`);
      await crop(`03-sources-collapsed-${mode}-crop`, buf, cardSel);
      // Rows on show: the folded ones are in the DOM (they animate open) but
      // inert and zero-height until "Show all".
      const collapsed = await page.evaluate(
        (sel) =>
          [
            ...(document.querySelector(sel)?.querySelectorAll('[data-testid="source-row"]') ?? []),
          ].filter((r) => r.closest('[inert]') === null && r.getBoundingClientRect().height > 0)
            .length,
        cardSel,
      );
      // The row box, measured: the Sources card is judged on its spacing too.
      const metrics = await page.evaluate((sel) => {
        const row = document.querySelector(`${sel} [data-testid="source-row"]`);
        if (row === null) return null;
        const r = row.getBoundingClientRect();
        const part = (q) => {
          const el = row.querySelector(q);
          if (el === null) return null;
          const b = el.getBoundingClientRect();
          return { top: Math.round(b.top - r.top), bottom: Math.round(b.bottom - r.top) };
        };
        return {
          height: Math.round(r.height),
          tracks: getComputedStyle(row).gridTemplateRows,
          children: [...row.children].map(
            (c) =>
              `${c.tagName.toLowerCase()}.${c.className.split(' ')[0]}:${Math.round(c.getBoundingClientRect().height)}`,
          ),
          site: part('.pd-src-row-site'),
          title: part('.pd-src-row-title'),
          snippet: part('.pd-src-row-snippet'),
          thumb: part('.pd-src-row-thumb'),
        };
      }, cardSel);
      console.log('first card row:', JSON.stringify(metrics));
      if (mode === 'dark' && metrics !== null) {
        const content = Math.max(metrics.thumb?.bottom ?? 0, metrics.snippet?.bottom ?? 0);
        check(
          metrics.height - content <= 13,
          `a row ends at its padding, no dead band under it (${metrics.height - content}px below the content)`,
        );
      }
      await page.click(`${cardSel} [data-testid="sources-toggle"]`);
      await sleep(600);
      await scrollTo(cardSel, 'start');
      await sleep(300);
      buf = await shot(`04-sources-expanded-${mode}`);
      /* The whole open card — rows and "Show less" — needs a taller window
         than the app's; the device-metrics override lays the same page out
         taller for one frame (as turn-cards-look does). */
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1500,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await sleep(500);
      await scrollTo(cardSel, 'start');
      await sleep(300);
      await crop(`04-sources-expanded-${mode}-crop`, await page.screenshot(), cardSel);
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(400);
      const expanded = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return {
          rows: el?.querySelectorAll('[data-testid="source-row"]').length ?? 0,
          toggle: el?.querySelector('[data-testid="sources-toggle"]')?.textContent ?? '',
        };
      }, cardSel);
      console.log('sources card:', collapsed, JSON.stringify(expanded));
      if (mode === 'dark') {
        check(collapsed === 3, `collapsed, the card shows the top three (${collapsed})`);
        check(
          expanded.rows === PAGES.length,
          `"Show all" expands every source in place (${expanded.rows})`,
        );
        check(/less/i.test(expanded.toggle), `…and offers "Show less" (${expanded.toggle})`);
      }
      await page.click(`${cardSel} [data-testid="sources-toggle"]`);
      await sleep(400);
    } else if (mode === 'dark') {
      check(false, 'no Sources card');
    }

    /* 05 — the search row, in the reopened chain */
    const summary = await page.$('.pd-chain-summary');
    if (summary !== null) {
      await summary.click();
      await sleep(800);
      await scrollTo('.pd-chain', 'start');
      await sleep(300);
      const buf = await shot(`05-search-row-${mode}`);
      await crop(`05-search-row-${mode}-crop`, buf, '.pd-chain', 12);
      const row = await page.evaluate(() => {
        const chain = document.querySelector('.pd-chain');
        return {
          searchRows: chain?.querySelectorAll('.pd-websearch-row').length ?? 0,
          terminals: chain?.querySelectorAll('.pd-terminal, .pd-term').length ?? 0,
          icons: chain?.querySelectorAll('.pd-websearch-favicon-img').length ?? 0,
          snippets: chain?.querySelectorAll('.pd-websearch-snippet').length ?? 0,
          more: chain?.querySelector('.pd-websearch .pd-showmore')?.textContent ?? null,
          pages: [...(chain?.querySelectorAll('.pd-chain-step-row') ?? [])].filter((r) =>
            /Read a page/.test(r.textContent ?? ''),
          ).length,
        };
      });
      console.log('search row:', JSON.stringify(row));
      if (mode === 'dark') {
        check(
          row.searchRows === 5,
          `the CLI search shows what it found, five rows (${row.searchRows})`,
        );
        check(/Show 3 more/.test(row.more ?? ''), `…and "Show 3 more" for the rest (${row.more})`);
        check(row.icons > 0, 'the rows carry favicons');
        check(row.snippets === 0, 'compact: favicon + title per result, no snippets');
        check(row.terminals === 0, 'no terminal block: the search reads as results, not a log');
        check(row.pages === 2, `the two fetches are "Read a page" rows (${row.pages})`);
      }
      await summary.click();
      await sleep(500);
    }

    /* 06 — the schemas-mode turn */
    const last = await page.$$('.pd-chain-summary');
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-scroll"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    if (last.length > 1) {
      await last[last.length - 1].click();
      await sleep(700);
    }
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-scroll"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await sleep(400);
    await shot(`06-turn2-${mode}`);
    if (last.length > 1) {
      await last[last.length - 1].click();
      await sleep(400);
    }
  }

  /* Keyboard: Tab onto a chip, Enter opens its card with focus inside, Escape closes. */
  await setMode('dark');
  const kb = await page.evaluate(async () => {
    const chip = document.querySelector('[data-testid="source-chip"][data-count="3"]');
    if (!(chip instanceof HTMLElement)) return { ok: false, why: 'no chip' };
    chip.focus();
    return { ok: document.activeElement === chip, tag: chip.tagName };
  });
  if (kb.ok) {
    await page.keyboard.press('Enter');
    await sleep(500);
    const open = await page.evaluate(() => ({
      card: document.querySelector('[data-testid="source-hovercard"]') !== null,
      focusInCard:
        document.activeElement?.closest('[data-testid="source-hovercard"]') !== null &&
        document.activeElement !== null,
    }));
    await page.keyboard.press('Escape');
    await sleep(400);
    const closed = await page.evaluate(() => ({
      card: document.querySelector('[data-testid="source-hovercard"]') !== null,
      onChip: document.activeElement?.getAttribute('data-testid') === 'source-chip',
    }));
    console.log('keyboard:', JSON.stringify({ kb, open, closed }));
    check(kb.tag === 'BUTTON', 'the chip is a button (reachable with Tab)');
    check(open.card && open.focusInCard, 'Enter opens the card and moves focus into it');
    check(!closed.card && closed.onChip, 'Escape closes it and returns focus to the chip');
  } else {
    check(false, `keyboard: ${kb.why}`);
  }

  /* A chip click opens its source in the canvas browser, like every chat link. */
  const opened = await page.evaluate(async () => {
    const title = document.querySelector(
      '[data-testid="sources-card"] [data-testid="source-row-title"]',
    );
    if (!(title instanceof HTMLElement)) return null;
    title.click();
    await new Promise((r) => setTimeout(r, 1500));
    return [...document.querySelectorAll('.pd-canvas-tab')].map((t) => t.getAttribute('data-kind'));
  });
  console.log('canvas tabs after opening a source:', JSON.stringify(opened));
  check(opened?.includes('browser') === true, 'opening a source uses the canvas browser');

  console.log(`fixture requests: ${requests.length}`, JSON.stringify(requests.slice(0, 12)));
  console.log(`\nShots: ${OUT}`);
} finally {
  await finish();
  server.close();
}
