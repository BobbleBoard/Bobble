/**
 * LOOK at a diagram being made — the card building in the chat while the
 * model types its Mermaid, and the finished card taking over.
 *
 * the user (2026-09-25): "custom mermaid arrows and box styling and ensure those
 * animate/build in real time smoothly". A `diagram` call's arguments arrive a
 * few characters at a time; this plays one into the store the way a turn does
 * (the call's argsText growing every 40 ms, ~75 tokens a second, then the
 * parsed arguments, then the present and the tool's result — in that order,
 * as the app sees them), films the thread through the CDP screencast, and logs
 * every animation frame's delta and the page's long tasks while it runs.
 *
 * Out: filmstrip.png (frames ~100 ms apart), close-build.png and
 * close-handover.png (every compositor frame of a stretch of the build and of
 * the hand-over), the last building frame beside the finished card,
 * frames.json (the rAF deltas), and the checks: the card appears before the
 * tool answers, it grows as lines arrive, the finished card takes its place
 * without moving, and never two cards at once. What the tool's ANSWER then
 * does to the thread above the card (the chain's own rows) is reported as
 * `answerShift`, not judged.
 *
 *   SHOT_DIR=/tmp/diagram-build node apps/desktop/tests/e2e/diagram-build-look.mjs
 *   FORM=cli …    the same call typed as a `diagram` command through bash
 *   MODE=dark …   in the dark theme
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importTs, launchChromium } from '../../../../tools/visual-eval/lib/env.mjs';
import { filmstrip, readFrameLog, startFilm, startFrameLog } from './_film.mjs';
import { APP_ROOT, launchApp } from './harness.mjs';
import { cropPng } from './png.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/diagram-build';
const FORM = process.env.FORM === 'cli' ? 'cli' : 'schema';
const MODE = process.env.MODE === 'dark' ? 'dark' : 'light';
mkdirSync(SHOT_DIR, { recursive: true });

const TITLE = 'Order fulfilment';
const SUBTITLE = 'Checkout to delivery';
const SOURCE = `flowchart TD
  A([Order placed]) --> B{Payment ok?}
  B -- yes --> C[Pick & pack]
  B -- no --> E[Email customer]
  E -. retry .-> B
  subgraph Warehouse
    C --> D{Quality ok?}
    D -- no, repack --> C
  end
  D -- yes --> F[Ship] --> G([Delivered])`;
const SVG_PATH = '/w/diagrams/order-fulfilment.svg';

/** The call's argument text, as the model writes it in either form. */
const ARGS_TEXT =
  FORM === 'cli'
    ? JSON.stringify({
        command: `diagram "${TITLE}" --subtitle "${SUBTITLE}" --source '${SOURCE}'`,
      })
    : JSON.stringify({ title: TITLE, subtitle: SUBTITLE, source: SOURCE });
const ARGS = JSON.parse(ARGS_TEXT);
const TOOL = FORM === 'cli' ? 'bash' : 'diagram';

/** The finished card's payload, drawn by the repo's own renderer (both modes). */
async function finishedPayload() {
  const dp = await importTs('apps/desktop/electron/gen/diagram-page.ts');
  const dk = await importTs('packages/design-kit/src/index.ts');
  const browser = await launchChromium();
  try {
    const page = await (await browser.newContext({ bypassCSP: true })).newPage();
    await page.setContent(dp.PAGE_HTML);
    await page.addScriptTag({
      content: readFileSync(path.join(APP_ROOT, 'resources/mermaid/mermaid.min.js'), 'utf8'),
    });
    await page.addScriptTag({ content: dp.PAGE_SCRIPT });
    const kit = dk.kitOrDefault('paper-teal');
    const reply = await dp.runDiagram(
      {
        parse: (s) => page.evaluate((x) => window.__pdParse(x), s),
        render: (r) => page.evaluate((x) => window.__pdRender(x), r),
      },
      {
        source: SOURCE,
        title: TITLE,
        subtitle: SUBTITLE,
        themes: {
          light: dk.diagramTheme(kit, 'light', 'mac'),
          dark: dk.diagramTheme(kit, 'dark', 'mac'),
        },
      },
    );
    if (!reply.ok) throw new Error(`the finished drawing failed: ${reply.error}`);
    return {
      title: TITLE,
      subtitle: SUBTITLE,
      kind: reply.kind,
      kit: kit.id,
      source: reply.source,
      light: { ...reply.light, paper: kit.light.paper },
      dark: { ...reply.dark, paper: kit.dark.paper },
    };
  } finally {
    await browser.close();
  }
}

/**
 * The finished card as the APP draws it, when this build can: the tool's
 * drawing comes from main's hidden Mermaid window, and so does the live one,
 * so the handover compares like with like. An older build has no such call;
 * the eval's Chromium draws it instead.
 */
async function appPayload(page) {
  return page.evaluate(
    async ({ source, title, subtitle }) => {
      const draw = (mode) =>
        window.piDesktop.invoke('diagram:live', {
          id: 'probe-final',
          source,
          title,
          subtitle,
          mode,
          root: '/w/diagrams',
        });
      try {
        const [light, dark] = [await draw('light'), await draw('dark')];
        if (!light?.ok || !dark?.ok) return null;
        return {
          title,
          subtitle,
          kind: light.kind,
          kit: light.kit,
          source: light.source,
          light: { svg: light.svg, width: light.width, height: light.height, paper: light.paper },
          dark: { svg: dark.svg, width: dark.width, height: dark.height, paper: dark.paper },
        };
      } catch {
        return null;
      }
    },
    { source: SOURCE, title: TITLE, subtitle: SUBTITLE },
  );
}

const payloadFromEval = await finishedPayload();
const { app, page, check, finish } = await launchApp('diagram-build', {
  waitFor: '[data-testid="composer-input"]',
});
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) =>
    /index\.html|localhost/.test(w.webContents.getURL()),
  );
  win?.setContentSize(1280, 1500);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const user = { kind: 'user', id: 'u1', text: 'map out order fulfilment', timestamp: Date.now() };
const assistant = (blocks, isStreaming) => ({
  kind: 'assistant',
  id: 'a1',
  blocks,
  timestamp: Date.now(),
  isStreaming,
});
const call = (argsText, args = {}) => ({
  type: 'toolCall',
  id: 'd1',
  name: TOOL,
  arguments: args,
  argsText,
});
const lead = { type: 'text', text: 'I will draw the flow.' };

/** What the thread shows right now: the building card, the finished card, and where. */
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
    const pending = document.querySelector('[data-testid="pending-diagram"]');
    const done = document.querySelector('[data-testid="presented-diagram"]');
    const drawing = (card) => card?.querySelector('.pd-inline-widget-box svg') ?? null;
    return {
      pending: pending !== null,
      pendingBox: box(pending),
      pendingSvg: box(drawing(pending)),
      pendingNodes: pending?.querySelectorAll('g.node').length ?? 0,
      done: done !== null,
      doneBox: box(done),
      doneSvg: box(drawing(done)),
      cards: document.querySelectorAll('[data-testid="presented-diagram"]').length,
    };
  });

const samples = [];
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.evaluate((m) => {
    document.documentElement.setAttribute('data-mode', m);
    document.documentElement.style.colorScheme = m;
  }, MODE);
  await sleep(1500);
  const payload = (await appPayload(page)) ?? payloadFromEval;
  await set({
    session: { cwd: '/w/diagrams' },
    agent: { isStreaming: true },
    messages: [user, assistant([lead], true)],
    runningToolCalls: [],
    toolOutputPartials: {},
  });
  await sleep(600);

  const film = await startFilm(app, page);
  await startFrameLog(page);
  const t0 = Date.now();
  let both = false;
  // The arguments arrive: ~12 characters every 40 ms.
  for (let n = 8; n < ARGS_TEXT.length + 12; n += 12) {
    await set({
      messages: [user, assistant([lead, call(ARGS_TEXT.slice(0, n))], true)],
    });
    await sleep(40);
    if (samples.length === 0 || Date.now() - samples.at(-1).at > 150) {
      samples.push({ at: Date.now(), chars: Math.min(n, ARGS_TEXT.length), ...(await read()) });
    }
  }
  const streamedAt = Date.now();
  // The call is complete and runs: parsed arguments, the tool executing.
  await set({
    messages: [user, assistant([lead, call(ARGS_TEXT, ARGS)], true)],
    runningToolCalls: ['d1'],
  });
  await sleep(900);
  const beforeHandover = await read();
  samples.push({ at: Date.now(), phase: 'running', ...beforeHandover });
  const lastBuilding = await page.screenshot();

  // The tool answers the way the app sees it: present:show first, the result after.
  const handStart = Date.now();
  await page.evaluate(
    ({ p, file }) =>
      window
        .__present_store()
        .getState()
        .add({ path: file, chat: '', afterMessageId: 'a1', diagram: p }),
    { p: payload, file: SVG_PATH },
  );
  const onPresent = await read();
  both ||= onPresent.pending && onPresent.done;
  await sleep(30);
  await set({
    messages: [
      user,
      assistant([lead, call(ARGS_TEXT, ARGS)], true),
      {
        kind: 'toolResult',
        id: 'tr-d1',
        toolCallId: 'd1',
        toolName: TOOL,
        text: `Drew a flowchart "${TITLE}" — 7 steps (2 decisions), 8 connections: ${SVG_PATH} (the source beside it: order-fulfilment.diagram.mmd). It is in the chat as a diagram card.`,
        isError: false,
        timestamp: Date.now(),
      },
    ],
    runningToolCalls: [],
  });
  const handedAt = Date.now();
  const justAfter = await read();
  both ||= justAfter.pending && justAfter.done;
  await sleep(1200);
  const settled = await read();
  const doneShot = await page.screenshot();
  const frameLog = await readFrameLog(page);
  await film.stop();

  // ── the checks ──────────────────────────────────────────────────────────
  const building = samples.filter((s) => s.pending);
  check(
    building.length > 0 && building[0].at < streamedAt,
    `the card appears while the source is still streaming (${building.length} samples showed it)`,
  );
  const nodeCounts = building.map((s) => s.pendingNodes);
  check(
    nodeCounts.length > 2 && nodeCounts.at(-1) > nodeCounts[0],
    `it grows as lines arrive: nodes ${nodeCounts.join(' → ')}`,
  );
  check(
    beforeHandover.pendingNodes === 7,
    `the last building frame has every step: ${beforeHandover.pendingNodes}`,
  );
  check(
    settled.done && !settled.pending && settled.cards === 1,
    `the finished card took its place: ${JSON.stringify({ done: settled.done, pending: settled.pending, cards: settled.cards })}`,
  );
  const delta = (a, b) =>
    a && b ? { dx: b.x - a.x, dy: b.y - a.y, dw: b.w - a.w, dh: b.h - a.h } : null;
  // The swap itself: the live card's last frame against the finished card
  // the moment it is presented (before the answer lands).
  const moved = delta(beforeHandover.pendingSvg, onPresent.doneSvg);
  check(
    moved !== null && Object.values(moved).every((v) => Math.abs(v) <= 1),
    `the drawing did not move at the handover: ${JSON.stringify(moved)}`,
  );
  check(!both, 'never two cards at once');
  // What the answer then does to the thread above the card (the chain's own
  // rows), reported, not judged here.
  const answerShift = delta(onPresent.doneSvg, settled.doneSvg);

  // ── the filmstrip: the reply column, from the first character to settled ──
  const clip = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-scroll"]')?.getBoundingClientRect();
    const col = document.querySelector('[data-testid="turn-cards"]')?.parentElement;
    const r = col?.getBoundingClientRect();
    if (!scroll || !r) return null;
    return {
      x: Math.max(scroll.x, r.x - 12),
      y: scroll.y,
      width: Math.min(r.width + 24, scroll.width),
      height: scroll.height,
      vw: window.innerWidth,
    };
  });
  const firstFrame = film.frames[0]?.t ?? 0;
  const strip = await filmstrip(film.frames, {
    dir: SHOT_DIR,
    clip,
    viewportWidth: clip?.vw ?? 1280,
    stepMs: 100,
    cols: 10,
    cellWidth: 200,
  });
  // Two close-ups at every compositor frame (~30 fps): a stretch of the build
  // (lines landing, parts moving) and the hand-over.
  const closeUp = { dir: SHOT_DIR, clip, viewportWidth: clip?.vw ?? 1280, stepMs: 33, cols: 8 };
  const buildStrip = await filmstrip(film.frames, {
    ...closeUp,
    name: 'close-build',
    from: t0 + 500,
    to: t0 + 1300,
    cellWidth: 240,
  });
  const handStrip = await filmstrip(film.frames, {
    ...closeUp,
    name: 'close-handover',
    from: handStart - 250,
    to: handStart + 650,
    cellWidth: 240,
  });
  const cut = (buf) => {
    if (!clip) return buf;
    const scale = buf.readUInt32BE(16) / clip.vw;
    return cropPng(buf, {
      x: clip.x * scale,
      y: clip.y * scale,
      width: clip.width * scale,
      height: clip.height * scale,
    });
  };
  writeFileSync(path.join(SHOT_DIR, 'last-building.png'), cut(lastBuilding));
  writeFileSync(path.join(SHOT_DIR, 'finished.png'), cut(doneShot));
  const summary = {
    form: FORM,
    mode: MODE,
    streamMs: streamedAt - t0,
    handoverAtMs: handedAt - t0,
    handoverTookMs: handedAt - handStart,
    screencastFrames: film.frames.length,
    filmstrip: strip.sheet,
    filmstripFrames: strip.files.length,
    closeUps: [buildStrip.sheet, handStrip.sheet],
    firstFrame,
    raf: frameLog.summary,
    nodes: nodeCounts,
    moved,
    answerShift,
  };
  writeFileSync(
    path.join(SHOT_DIR, 'frames.json'),
    `${JSON.stringify({ summary, samples, deltas: frameLog.deltas }, null, 1)}\n`,
  );
  console.log(JSON.stringify(summary));
} finally {
  await finish();
}
