/**
 * FILM cards arriving in the chat — the ones with no live build of their own.
 *
 * the user (2026-09-25): build "in real time smoothly … apply that to whatever
 * possible generally". Three arrivals, each presented the way main presents a
 * card (with its `shownAt`), each filmed through the CDP screencast:
 *
 *   svg      a small drawing the model wrote: it draws itself in;
 *   diagram  a diagram with no live card (a file handed over, say): it builds
 *            in from nothing;
 *   edit     the same diagram a turn later with a step added (diagram_edit):
 *            the new card moves on from the previous version;
 *   file     a document handed over (PresentCard): it comes up into place;
 *   sources  the Sources card under an answer that used the web, as the
 *            answer finishes: it comes up into place too.
 *
 * Out: <case>.png close-ups (every compositor frame) and frames.json with the
 * rAF deltas.
 *
 *   SHOT_DIR=/tmp/arrival node apps/desktop/tests/e2e/arrival-film.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { filmstrip, readFrameLog, startFilm, startFrameLog } from './_film.mjs';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/arrival';
const MODE = process.env.MODE === 'dark' ? 'dark' : 'light';
mkdirSync(SHOT_DIR, { recursive: true });

/** A small line drawing, the kind a model writes and presents: a lighthouse. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200" viewBox="0 0 240 200">
  <rect x="0" y="0" width="240" height="200" fill="#F4F1EA"/>
  <path d="M20 170 Q70 150 120 170 T220 170" fill="none" stroke="#2F6F8F" stroke-width="3" stroke-linecap="round"/>
  <path d="M20 184 Q70 164 120 184 T220 184" fill="none" stroke="#2F6F8F" stroke-width="3" stroke-linecap="round"/>
  <path d="M100 160 L108 60 L132 60 L140 160 Z" fill="#FFFFFF" stroke="#1E1C19" stroke-width="3" stroke-linejoin="round"/>
  <path d="M104 110 L136 110 M102 135 L138 135" stroke="#C4452B" stroke-width="6"/>
  <rect x="106" y="40" width="28" height="20" rx="3" fill="#F2C14E" stroke="#1E1C19" stroke-width="3"/>
  <path d="M100 40 L120 22 L140 40 Z" fill="#1E1C19"/>
  <path d="M140 48 L200 30 M140 52 L204 60" stroke="#F2C14E" stroke-width="3" stroke-linecap="round"/>
  <circle cx="190" cy="36" r="5" fill="#F2C14E"/>
</svg>`;

const V1 = `flowchart TD
  A([Order placed]) --> B{Payment ok?}
  B -- yes --> C[Pick & pack]
  B -- no --> E[Email customer]
  C --> F[Ship]`;
const V2 = `flowchart TD
  A([Order placed]) --> B{Payment ok?}
  B -- yes --> C[Pick & pack]
  B -- no --> E[Email customer]
  C --> D{Quality ok?}
  D -- no --> C
  D -- yes --> F[Ship] --> G([Delivered])`;

const { app, page, check, finish } = await launchApp('arrival-film', {
  waitFor: '[data-testid="composer-input"]',
});
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) =>
    /index\.html|localhost/.test(w.webContents.getURL()),
  );
  win?.setContentSize(1280, 1500);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A diagram card's payload, both modes, drawn by the app's own renderer. */
const draw = (source, title) =>
  page.evaluate(
    async ({ source, title }) => {
      const one = (mode) =>
        window.piDesktop.invoke('diagram:live', { id: `arrival-${title}`, source, title, mode });
      const [light, dark] = [await one('light'), await one('dark')];
      if (!light.ok || !dark.ok) throw new Error('the diagram did not draw');
      return {
        title,
        kind: light.kind,
        kit: light.kit,
        source: light.source,
        light: { svg: light.svg, width: light.width, height: light.height, paper: light.paper },
        dark: { svg: dark.svg, width: dark.width, height: dark.height, paper: dark.paper },
      };
    },
    { source, title },
  );

const present = (record) =>
  page.evaluate((r) => window.__present_store().getState().add(r), record);

const CLIP = {
  svg: '[data-testid="presented-svg"]',
  diagram: '[data-testid="presented-diagram"]',
  edit: '[data-testid="presented-diagram"]',
  file: '[data-testid="presented"] .pd-present-card',
  sources: '[data-testid="sources-card"]',
};

/** Film one arrival: `act` presents it; the close-up is the card's column. */
async function film(name, act, windowMs = 900) {
  const f = await startFilm(app, page);
  await startFrameLog(page);
  const t0 = Date.now();
  await act();
  await sleep(windowMs);
  const log = await readFrameLog(page);
  await f.stop();
  const clip = await page.evaluate((sel) => {
    const scroll = document.querySelector('[data-testid="chat-scroll"]')?.getBoundingClientRect();
    const card = [...document.querySelectorAll(sel)].at(-1);
    const r = card?.getBoundingClientRect();
    if (!scroll || !r) return null;
    return {
      x: r.x - 12,
      y: Math.max(scroll.y, r.y - 12),
      width: r.width + 24,
      height: Math.min(r.height + 24, scroll.height),
      vw: window.innerWidth,
    };
  }, CLIP[name]);
  const strip = await filmstrip(f.frames, {
    dir: SHOT_DIR,
    name: `close-${name}`,
    clip,
    viewportWidth: clip?.vw ?? 1280,
    stepMs: 33,
    cols: 8,
    cellWidth: 240,
    from: t0 - 60,
    to: t0 + windowMs,
  });
  return { name, sheet: strip.sheet, raf: log.summary };
}

const results = [];
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.evaluate((m) => {
    document.documentElement.setAttribute('data-mode', m);
    document.documentElement.style.colorScheme = m;
  }, MODE);
  await sleep(1200);
  const v1 = await draw(V1, 'Order fulfilment');
  const v2 = await draw(V2, 'Order fulfilment');
  const msg = (id, kind, text) =>
    kind === 'user'
      ? { kind: 'user', id, text, timestamp: Date.now() }
      : {
          kind: 'assistant',
          id,
          blocks: [{ type: 'text', text }],
          timestamp: Date.now(),
          isStreaming: false,
        };
  await page.evaluate(
    (messages) => window.__pi_store().setState({ session: { cwd: '/w' }, messages }),
    [msg('u1', 'user', 'draw a lighthouse'), msg('a1', 'assistant', 'Here it is.')],
  );
  await sleep(500);

  // 1. A small drawing, presented.
  results.push(
    await film('svg', () =>
      present({
        path: '/w/lighthouse.svg',
        chat: '',
        afterMessageId: 'a1',
        svg: { width: 240, height: 200, bytes: SVG.length, text: SVG },
        shownAt: Date.now(),
      }),
    ),
  );
  const svgDone = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="presented-svg"] svg');
    return svg ? [...svg.querySelectorAll('path')].map((p) => p.getAnimations().length) : null;
  });
  check(svgDone?.every((n) => n === 0) === true, `the drawing settled: ${JSON.stringify(svgDone)}`);

  // 2. A diagram with no live card: it builds in.
  await page.evaluate(
    (messages) => window.__pi_store().setState({ messages }),
    [
      msg('u1', 'user', 'draw a lighthouse'),
      msg('a1', 'assistant', 'Here it is.'),
      msg('u2', 'user', 'map out order fulfilment'),
      msg('a2', 'assistant', 'The flow:'),
    ],
  );
  await sleep(300);
  results.push(
    await film('diagram', () =>
      present({
        path: '/w/flow.svg',
        chat: '',
        afterMessageId: 'a2',
        diagram: v1,
        shownAt: Date.now(),
      }),
    ),
  );

  // 3. The same file a turn later, a step added: it moves on from version 1.
  await page.evaluate(
    (messages) => window.__pi_store().setState({ messages }),
    [
      msg('u1', 'user', 'draw a lighthouse'),
      msg('a1', 'assistant', 'Here it is.'),
      msg('u2', 'user', 'map out order fulfilment'),
      msg('a2', 'assistant', 'The flow:'),
      msg('u3', 'user', 'add a quality check before shipping'),
      msg('a3', 'assistant', 'Added it:'),
    ],
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="chat-scroll"]')?.scrollTo({ top: 1e6 });
  });
  await sleep(400);
  results.push(
    await film('edit', () =>
      present({
        path: '/w/flow.svg',
        chat: '',
        afterMessageId: 'a3',
        diagram: v2,
        shownAt: Date.now(),
      }),
    ),
  );
  const cards = await page.evaluate(
    () => document.querySelectorAll('[data-testid="presented-diagram"]').length,
  );
  check(cards === 2, `both versions stand where they were made: ${cards} cards`);

  // 4. A document handed over: its card comes up into place.
  const upTo3 = [
    msg('u1', 'user', 'draw a lighthouse'),
    msg('a1', 'assistant', 'Here it is.'),
    msg('u2', 'user', 'map out order fulfilment'),
    msg('a2', 'assistant', 'The flow:'),
    msg('u3', 'user', 'add a quality check before shipping'),
    msg('a3', 'assistant', 'Added it:'),
  ];
  await page.evaluate(
    (messages) => window.__pi_store().setState({ messages }),
    [...upTo3, msg('u4', 'user', 'write it up'), msg('a4', 'assistant', 'The write-up:')],
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="chat-scroll"]')?.scrollTo({ top: 1e6 });
  });
  await sleep(400);
  results.push(
    await film(
      'file',
      () =>
        present({
          path: '/w/Order fulfilment.pdf',
          chat: '',
          afterMessageId: 'a4',
          shownAt: Date.now(),
        }),
      500,
    ),
  );
  const fileCard = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.pd-present-card')].at(-1);
    return card ? { cls: card.className, anims: card.getAnimations().length } : null;
  });
  check(
    fileCard?.cls.includes('pd-arrive') === true && fileCard.anims === 0,
    `the file card came up and settled: ${JSON.stringify(fileCard)}`,
  );

  // 5. An answer that used the web finishing: the sources come up under it.
  const SEARCH = `3 result(s) via duckduckgo\n\n${[1, 2, 3]
    .map((i) => `[${i}] Page ${i}\n    https://site${i}.example/p\n    About page ${i}.`)
    .join('\n\n')}`;
  const webTurn = (streaming) => [
    ...upTo3,
    msg('u4', 'user', 'write it up'),
    msg('a4', 'assistant', 'The write-up:'),
    msg('u5', 'user', 'what changed in Mermaid 11?'),
    {
      kind: 'assistant',
      id: 'a5',
      blocks: [
        { type: 'toolCall', id: 'c5', name: 'web_search', arguments: { query: 'mermaid 11' } },
      ],
      timestamp: Date.now(),
      isStreaming: false,
    },
    {
      kind: 'toolResult',
      id: 'tr-a5-c5',
      toolCallId: 'c5',
      toolName: 'web_search',
      text: SEARCH,
      isError: false,
      timestamp: Date.now(),
    },
    {
      kind: 'assistant',
      id: 'a6',
      blocks: [
        {
          type: 'text',
          text: 'Mermaid 11 adds new shapes and layouts [Page 1](https://site1.example/p).',
        },
      ],
      timestamp: Date.now(),
      isStreaming: streaming,
    },
  ];
  await page.evaluate((messages) => window.__pi_store().setState({ messages }), webTurn(true));
  await page.evaluate(() => {
    document.querySelector('[data-testid="chat-scroll"]')?.scrollTo({ top: 1e6 });
  });
  await sleep(500);
  results.push(
    await film(
      'sources',
      () => page.evaluate((messages) => window.__pi_store().setState({ messages }), webTurn(false)),
      500,
    ),
  );
  const sources = await page.evaluate(
    () => document.querySelector('[data-testid="sources-card"]')?.className ?? null,
  );
  check(sources?.includes('pd-arrive') === true, `the sources came up: ${sources}`);
  writeFileSync(path.join(SHOT_DIR, 'frames.json'), `${JSON.stringify(results, null, 1)}\n`);
  console.log(
    JSON.stringify(
      results.map((r) => ({
        name: r.name,
        sheet: r.sheet,
        longestMs: r.raf.longestMs,
        longTasks: r.raf.longTasks,
      })),
    ),
  );
} finally {
  await finish();
}
