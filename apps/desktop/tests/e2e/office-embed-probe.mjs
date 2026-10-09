/**
 * OFFICE EMBED PROBE — a chart into a deck, a report, a workbook and a PDF,
 * through the real tools, with the document OPEN in the canvas the whole time.
 *
 * The user (2026-09-16): "ensure these can be embedded into docs or charts or
 * whatever, that's mainly the use case, say you put a pdf in and ask the model
 * to slot a chart in with the data on the second page … and of course you
 * should be able to see the pdf or any xlsx pptx docx being edited live".
 *
 * Two halves:
 *
 *   1. THE MECHANISM (no model): each fixture opens in its native editor; the
 *      `chart` CLI draws the chart; `office edit <file> --chart <svg> …` puts
 *      it in; the open tab reloads BY ITSELF (the manager's file watcher), the
 *      tab bar pulses, and a capture of the editor shows the chart. Filmed by
 *      the flicker guard throughout.
 *   2. THE MODEL (rapid-mlx 4B unless MODEL/ENGINE say otherwise): several
 *      charts in ONE answer, and the user's PDF case — "slot a chart in with the
 *      data on the second page" — end to end. SKIP_MODEL=1 runs only (1).
 *
 * Headless as always (PI_E2E_BACKGROUND via launchApp; PI_E2E_HEADED shows the
 * window unfocused so the editors get a compositor). Throwaway HOME, real
 * cache (the office venv + the model live there).
 *
 *   SHOT_DIR=/tmp/office-embed node apps/desktop/tests/e2e/office-embed-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { watchFlicker } from './flicker.mjs';
import { launchApp, probeHome, REAL_CACHE } from './harness.mjs';
import { compositePng } from './png.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ENGINE = process.env.ENGINE ?? 'rapid-mlx/mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/office-embed';
const SKIP_MODEL = process.env.SKIP_MODEL === '1';
/** ONLY_MODEL=1: skip the mechanism half (the model draws its own charts). */
const ONLY_MODEL = process.env.ONLY_MODEL === '1' && !SKIP_MODEL;
const TURN_CAP_MS = Number(process.env.TURN_CAP_S ?? 480) * 1000;
mkdirSync(SHOT_DIR, { recursive: true });

const here = path.dirname(new URL(import.meta.url).pathname);
const VENV_PY = path.join(REAL_CACHE, 'engines', 'office-venv', 'bin', 'python');
if (!existsSync(VENV_PY)) {
  console.error(`office venv missing at ${VENV_PY} — open Bobble once so it installs`);
  process.exit(1);
}

const home = probeHome('office-embed');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify(
    {
      userMode: 'power',
      modelSelection: SKIP_MODEL
        ? { mode: 'tier', tier: 'balanced' }
        : { mode: 'model', modelId: MODEL },
    },
    null,
    2,
  )}\n`,
);
const { app, page, check, finish } = await launchApp('office-embed', {
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
const flickerNote = (report, what) =>
  note(
    `no flicker while ${what}`,
    report.flickers.length === 0,
    report.flickers.length === 0
      ? `${report.frames} frames clean`
      : report.flickers
          .map(
            (f) =>
              `${f.frames.during} (${f.revertedAfterMs}ms, ${f.changedCells} cells): ${f.dom.slice(0, 4).join('; ')}`,
          )
          .join(' | '),
  );
const png = (dataUrl) =>
  typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')
    ? Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
    : null;
/** Capture the editor behind an office tab (the native view; Playwright cannot see it). */
const capture = async (tabId, label) => {
  const r = await page.evaluate(
    (id) => window.piDesktop.invoke('office:capture', { tabId: id }),
    tabId,
  );
  const buf = png(r?.dataUrl);
  if (buf === null) {
    log(`capture ${label}: NONE (${r?.error ?? 'unknown'})`);
    return null;
  }
  const file = path.join(SHOT_DIR, `${label}.png`);
  writeFileSync(file, buf);
  log(`capture ${label}: ${buf.length} bytes`);
  return buf;
};
/**
 * What the screen shows: the DOM screenshot with the native editor's capture
 * laid over its slot (Playwright cannot see a WebContentsView; the capture
 * cannot see the DOM). The slot is 1px in from the rail's edge so the canvas
 * divider stays visible beside the editor — the user (2026-09-16): "the canvas
 * border seems obstructed or gone in this situation".
 */
const composite = async (tabId, label) => {
  const dom = await page.screenshot();
  const r = await page.evaluate(
    (id) => window.piDesktop.invoke('office:capture', { tabId: id }),
    tabId,
  );
  const view = png(r?.dataUrl);
  const geom = await page.evaluate(() => {
    const b = document.querySelector('.pd-office-slot')?.getBoundingClientRect();
    const rail = document
      .querySelector('[data-testid="canvas-tabs-panel"]')
      ?.getBoundingClientRect();
    return b
      ? {
          x: b.x,
          y: b.y,
          w: b.width,
          h: b.height,
          railX: rail?.x ?? null,
          dpr: window.devicePixelRatio,
        }
      : null;
  });
  const file = path.join(SHOT_DIR, `${label}.png`);
  if (view === null || geom === null) {
    writeFileSync(file, dom);
    return geom;
  }
  const d = geom.dpr;
  writeFileSync(
    file,
    compositePng(dom, view, {
      x: geom.x * d,
      y: geom.y * d,
      width: geom.w * d,
      height: geom.h * d,
    }),
  );
  log(`composite ${label}`);
  return geom;
};
const run = async (cmd, { retries = 1 } = {}) => {
  const r = await page.evaluate((c) => window.piDesktop.invoke('pi:bash', { command: c }), cmd);
  const out = r.result?.output ?? r.error ?? '';
  // pi restarts once around model selection settles; a command that lands on
  // that restart reads "pi exited (143)" — it did not run, so run it again.
  if (/pi exited|pi is not running/.test(out) && retries > 0) {
    log(`  (pi restarted under "${cmd.slice(0, 40)}…" — again in 3 s)`);
    await sleep(3000);
    return run(cmd, { retries: retries - 1 });
  }
  log(`$ ${cmd.slice(0, 90)}${cmd.length > 90 ? '…' : ''}\n  ${out.split('\n')[0].slice(0, 160)}`);
  return out;
};
/** pi answers a trivial command — the bridge is up and not mid-restart. */
const waitForPi = async () => {
  for (let i = 0; i < 40; i += 1) {
    const r = await page
      .evaluate(() => window.piDesktop.invoke('pi:bash', { command: 'echo pi-ready' }))
      .catch(() => null);
    if (/pi-ready/.test(r?.result?.output ?? '')) {
      await sleep(2000);
      return true;
    }
    await sleep(1000);
  }
  return false;
};
const KIND = { pptx: 'slides', docx: 'docs', xlsx: 'sheets', pdf: 'pdf' };
// Navigate an editor through its view-state hook (a thumbnail click depends
// on a rail the slides editor hides at canvas widths).
const clickSlide = (tabId, n) =>
  page.evaluate(
    ({ tabId, n }) =>
      window.piDesktop.invoke('office:view-state', { tabId, state: { slide: n - 1 } }),
    { tabId, n },
  );
const clickPage = (tabId, n) =>
  page.evaluate(
    ({ tabId, n }) => window.piDesktop.invoke('office:view-state', { tabId, state: { page: n } }),
    { tabId, n },
  );
const openOffice = async (file) => {
  const title = path.basename(file);
  const kind = KIND[file.split('.').pop()];
  // The app's own key for a file tab (`file:<abs path>`, file-tabs.ts): a
  // present of the same file must land on THIS tab, not open a second one.
  const tabId = await page.evaluate(
    ({ filePath, title, key }) =>
      window.__pi_canvas().upsertTab(key, { kind: 'office', key, title, filePath }),
    { filePath: file, title, key: `file:${file}` },
  );
  await sleep(1000);
  await page.evaluate(
    ({ tabId, filePath, kind }) =>
      window.piDesktop.invoke('office:create', { tabId, kind, filePath }),
    { tabId, filePath: file, kind },
  );
  return tabId;
};
const tabUpdatedAt = (tabId) =>
  page.evaluate(
    (id) =>
      window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.id === id)?.updatedAt ?? null,
    tabId,
  );
/** Wait for the tab's editor to swap to the new bytes (office:reloaded → updatedAt). */
const waitReloaded = async (tabId, since, timeout = 20_000) => {
  const t0 = Date.now();
  const ok = await page
    .waitForFunction(
      ({ id, since }) => {
        const t = window
          .__pi_canvas()
          .getState()
          .tabs.find((t) => t.id === id);
        return t !== undefined && t.updatedAt !== undefined && t.updatedAt !== since;
      },
      { id: tabId, since },
      { timeout, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  return { ok, ms: Date.now() - t0 };
};
const differs = (a, b) => a !== null && b !== null && !a.equals(b);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await sleep(3000);
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('light'));

  if (!SKIP_MODEL) {
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
  }

  // Where the tools write: the chat's workspace once a message has named one,
  // the sandbox root (~/Bobble) before that. Every path below is absolute so
  // the commands do not depend on which.
  const { realpathSync } = await import('node:fs');
  mkdirSync(path.join(home, 'Bobble'), { recursive: true });
  // realpath: the tools answer with resolved paths (/private/var/… for a
  // /var/… tmp home) and the canvas keys file tabs by path — a present of the
  // edited file must land on the tab the probe opened, not beside it.
  const dir = realpathSync(
    (await page.evaluate(() => window.__pi_workspace?.() ?? null)) ?? path.join(home, 'Bobble'),
  );
  execFileSync(VENV_PY, [path.join(here, 'office-fixtures.py'), dir], { stdio: 'pipe' });
  log(`fixtures in ${dir}`);
  const officeOk = await page.evaluate(() => window.piDesktop.invoke('office:available', {}));
  note('office editors available', officeOk?.available === true, JSON.stringify(officeOk));
  note('pi answers', await waitForPi());

  // ── 1. The mechanism: chart → office edit --chart, tab reloads by itself ──
  // (ONLY_MODEL=1 skips it: the model draws its own charts.)
  if (ONLY_MODEL) log('ONLY_MODEL: skipping the mechanism half');
  if (!ONLY_MODEL) {
    const guard = await watchFlicker(page, { dir: SHOT_DIR, label: 'embed' });
    const drew = await run(
      'chart bar "Units Sold by Year" --labels "2021, 2022, 2023, 2024" --values "12, 19, 15, 22" --highlight 2024 --unit units --look clean',
    );
    note('chart drew units.svg', /Drew a bar chart/.test(drew), drew.split('\n')[0].slice(0, 100));
    const svg =
      drew.match(/Drew [^:]+: (\S+\.svg)/)?.[1] ?? path.join(dir, 'units-sold-by-year.svg');
    note(
      'chart svg + elements on disk',
      existsSync(svg) && existsSync(svg.replace(/\.svg$/, '.chart.elements.json')),
      svg,
    );
    const trend = await run(
      'chart line "Signups" --labels "Jan, Feb, Mar, Apr, May, Jun" --values "120, 180, 150, 260, 310, 290" --look ocean --area gradient',
    );
    note(
      'chart drew signups.svg',
      /Drew a line chart/.test(trend),
      trend.split('\n')[0].slice(0, 100),
    );
    const trendSvg = trend.match(/Drew [^:]+: (\S+\.svg)/)?.[1] ?? path.join(dir, 'signups.svg');

    // Open the rail once (the first office tab opens the panel; widen it so the
    // editors get real room — office-shots.mjs drags the handle the same way).
    const cases = [
      { file: 'deck.pptx', flags: '--slide 2', view: (id) => clickSlide(id, 2), label: 'deck-2' },
      { file: 'report.docx', flags: '--after p2', view: null, label: 'report' },
      { file: 'sales.xlsx', flags: '--anchor D2 --width 5', view: null, label: 'sales' },
      { file: 'brief.pdf', flags: '--page 2', view: (id) => clickPage(id, 2), label: 'brief-2' },
    ];
    let first = true;
    for (const c of cases) {
      const file = path.join(dir, c.file);
      const tabId = await openOffice(file);
      await sleep(first ? 7000 : 5000);
      if (first) {
        const handle = page.locator('[data-testid="canvas-rail-handle"]');
        for (let i = 0; i < 3; i++) {
          const box = await handle.boundingBox();
          if (!box) break;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x - 320, box.y + box.height / 2, { steps: 10 });
          await page.mouse.up();
          await sleep(600);
        }
        await sleep(2000);
        first = false;
      }
      if (c.view) {
        await c.view(tabId);
        await sleep(1500);
      }
      const before = await capture(tabId, `${c.label}-before`);
      const since = await tabUpdatedAt(tabId);
      const out = await run(`office edit ${file} --chart ${svg} ${c.flags}`);
      note(
        `office edit put the chart into ${c.file}`,
        /ok insert_chart/.test(out) && !/could not|FAIL /.test(out),
        out.split('\n')[0].slice(0, 140),
      );
      const reloaded = await waitReloaded(tabId, since);
      note(`${c.file} tab reloaded by itself`, reloaded.ok, `${reloaded.ms} ms after the edit`);
      // No re-click: the fresh editor is expected to come back on the slide /
      // page the reader was on (the __pdViewState hand-over).
      await sleep(2500);
      const pulse = await page.evaluate(
        () => document.querySelectorAll('[data-testid="canvas-tab-updated"]').length,
      );
      note(`${c.file} tab shows the updated pulse`, pulse > 0, `${pulse} pulse element(s)`);
      const after = await capture(tabId, `${c.label}-after`);
      note(`${c.file} editor shows a different page after the edit`, differs(before, after));
      if (c.view) {
        const where = await page.evaluate(
          (id) => window.piDesktop.invoke('office:view-state', { tabId: id }),
          tabId,
        );
        note(
          `${c.file} came back on the same ${c.file.endsWith('pdf') ? 'page' : 'slide'}`,
          where?.state?.slide === 1 || where?.state?.page === 2,
          JSON.stringify(where?.state ?? where),
        );
      }
      const geom = await composite(tabId, `app-${c.label}`);
      if (c === cases[0]) {
        note(
          'the native editor leaves the canvas divider visible',
          geom !== null && geom.railX !== null && geom.x >= geom.railX + 1,
          geom ? `slot x ${geom.x}, rail x ${geom.railX}` : 'no geometry',
        );
      }
      await page.evaluate((id) => window.__pi_canvas().closeTab(id), tabId);
      await sleep(800);
    }
    flickerNote(await guard.stop(), 'charts went into four documents');

    // The re-present path: an open tab + `present` of the same file → forced reload.
    {
      const file = path.join(dir, 'deck.pptx');
      const tabId = await openOffice(file);
      await sleep(5000);
      const since = await tabUpdatedAt(tabId);
      await run(`office edit ${file} --chart ${trendSvg} --slide 3`);
      await sleep(600);
      await run(`coordinate present ${file} --note "the deck with two charts"`);
      const reloaded = await waitReloaded(tabId, since, 25_000);
      note('re-presenting an open deck reloads it', reloaded.ok, `${reloaded.ms} ms`);
      await sleep(1500);
      await clickSlide(tabId, 3);
      await sleep(1500);
      await composite(tabId, 'deck-3-after-present');
      await page.evaluate((id) => window.__pi_canvas().closeTab(id), tabId);
      await sleep(800);
    }

    // Unsaved-edits guard: the docs editor with a dirty document must NOT be
    // yanked out from under the user — checked through office:reload's reason.
    {
      const file = path.join(dir, 'report.docx');
      const tabId = await openOffice(file);
      await sleep(5000);
      const r = await page.evaluate(
        (id) => window.piDesktop.invoke('office:reload', { tabId: id, force: false }),
        tabId,
      );
      note(
        'reload of an unchanged file is a no-op',
        r?.ok === true && r?.reloaded === false,
        JSON.stringify(r),
      );
      const f0 = await page.evaluate(
        (id) => window.piDesktop.invoke('office:reload', { tabId: id, force: true }),
        tabId,
      );
      note(
        'a forced reload of the bytes already shown is a no-op too',
        f0?.ok === true && f0?.reloaded === false,
        JSON.stringify(f0),
      );
      // Rewrite the file (same content, new stamp) with the editor left alone:
      // a forced reload must swap the editor now.
      copyFileSync(file, `${file}.tmp`);
      const { renameSync } = await import('node:fs');
      renameSync(`${file}.tmp`, file);
      await sleep(100);
      const f = await page.evaluate(
        (id) => window.piDesktop.invoke('office:reload', { tabId: id, force: true }),
        tabId,
      );
      note(
        'forced reload swaps the editor',
        f?.ok === true && f?.reloaded === true,
        JSON.stringify(f),
      );
      await page.evaluate((id) => window.__pi_canvas().closeTab(id), tabId);
      await sleep(800);
    }
  }

  // ── 2. The model ───────────────────────────────────────────────────────
  if (!SKIP_MODEL) {
    const newChat = async () => {
      await page.click('[data-testid="new-chat"]').catch(() => {});
      await sleep(1500);
    };
    const turn = async (prompt, label, { fresh = true } = {}) => {
      if (fresh) await newChat();
      const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
      const g = await watchFlicker(page, { dir: SHOT_DIR, label });
      await page.click('[data-testid="composer-input"]');
      // Pasted, not typed: a "/" typed mid-sentence (an absolute path) opens
      // the composer's reference menu for a frame, which a person pasting a
      // path never sees — and the mouse parks over the sidebar, where a chart
      // card appearing under it cannot raise a tooltip.
      await page.keyboard.insertText(prompt);
      await page.mouse.move(180, 700);
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
      const ms = Date.now() - t0;
      await sleep(2500);
      // Tool calls are `toolCall` blocks on assistant messages; their results
      // are `toolResult` messages (engine/src/types/chat.ts).
      const calls = await page.evaluate((k) => {
        const s = window.__pi_store().getState();
        const results = new Map();
        for (const m of s.messages.slice(k)) {
          if (m.kind === 'toolResult') results.set(m.toolCallId, m.isError === true);
        }
        const out = [];
        for (const m of s.messages.slice(k)) {
          for (const b of m.blocks ?? []) {
            if (b.type === 'toolCall') {
              out.push({
                name: b.name,
                ok: results.get(b.id) !== true,
                args: JSON.stringify(b.arguments ?? {}).slice(0, 160),
              });
            }
          }
        }
        return out;
      }, n);
      const charts = await page.evaluate(
        () => document.querySelectorAll('[data-testid="presented-chart"]').length,
      );
      const report = await g.stop();
      return { ended, ms, calls, charts, report, n };
    };

    // Several charts in one answer.
    const multi = await turn(
      'Here are our numbers. Units sold (thousands): 2021: 12, 2022: 19, 2023: 15, 2024: 22. Signups by month: Jan 120, Feb 180, Mar 150, Apr 260, May 310, Jun 290. Market share: Acme 38%, Globex 27%, Initech 20%, Others 15%. Show me three charts: a bar chart of the units, a line chart of the signups, and a donut of the market share.',
      'model-multi',
    );
    note(
      'model turn (three charts) ended',
      multi.ended,
      `${Math.round(multi.ms / 1000)} s; calls: ${multi.calls.map((c) => c.name).join(', ')}`,
    );
    note('three chart cards in one answer', multi.charts >= 3, `${multi.charts} card(s)`);
    await shot('model-multi');
    flickerNote(multi.report, 'the model drew three charts');

    // The user's PDF case: the data is on page 2; the chart goes there. The file
    // is named by its absolute path — a new chat has no workspace of its own
    // until its first message, and this one's first message IS the ask.
    const modelPdf = path.join(dir, 'brief-model.pdf');
    copyFileSync(path.join(dir, 'brief.pdf'), modelPdf);
    // The canvas is per chat: the new chat first, THEN the tab, then the ask.
    await newChat();
    const pdfTab = await openOffice(modelPdf);
    await sleep(5000);
    const pdfSince = await tabUpdatedAt(pdfTab);
    const pdf = await turn(
      `Here is a PDF: ${modelPdf} — its second page has a units-sold-by-year table (2021: 12, 2022: 19, 2023: 15, 2024: 22). Slot a bar chart of that data into the PDF on the second page.`,
      'model-pdf',
      { fresh: false },
    );
    note(
      'model turn (chart into the PDF) ended',
      pdf.ended,
      `${Math.round(pdf.ms / 1000)} s; calls: ${pdf.calls.map((c) => `${c.name}${c.ok ? '' : '!'}`).join(', ')}`,
    );
    const pages = Number(
      execFileSync(VENV_PY, [
        '-c',
        `from pypdf import PdfReader;print(len(PdfReader(${JSON.stringify(modelPdf)}).pages))`,
      ])
        .toString()
        .trim(),
    );
    const usedOfficeEdit = pdf.calls.some(
      (c) => c.name === 'office_edit' || (c.name === 'bash' && /office edit/.test(c.args)),
    );
    const readPdf = pdf.calls.some((c) => c.name === 'read' && /\.pdf/.test(c.args));
    const hasChartShapes = execFileSync(VENV_PY, [
      '-c',
      `
from pypdf import PdfReader
r = PdfReader(${JSON.stringify(modelPdf)})
p = r.pages[1]
c = p.get_contents()
data = c.get_data() if c is not None else b''
print(len(data))
`,
    ])
      .toString()
      .trim();
    note(
      'the PDF was edited through office_edit',
      usedOfficeEdit,
      `pages now ${pages}; page-2 content ${hasChartShapes} bytes; calls: ${pdf.calls.map((c) => `${c.name}(${c.args.slice(0, 60)})`).join(' → ')}`,
    );
    // A `read` of the PDF must answer with its pages' text, never the bytes
    // (the run before this check: two minutes reasoning about "object 13").
    const readOk =
      !readPdf ||
      (await page.evaluate(
        (k) =>
          window
            .__pi_store()
            .getState()
            .messages.slice(k)
            .some((m) => m.kind === 'toolResult' && /pages' text|page 2:/.test(m.text ?? '')),
        pdf.n,
      ));
    note("a read of the PDF answered with its pages' text, not bytes", readOk);
    const reloaded = await waitReloaded(pdfTab, pdfSince, 5_000);
    note('the open PDF tab reloaded after the model edit', reloaded.ok, `${reloaded.ms} ms`);
    await sleep(1500);
    await clickPage(pdfTab, 2);
    await sleep(1500);
    await composite(pdfTab, 'model-pdf');
    flickerNote(pdf.report, 'the model put a chart into the PDF');
  }

  await sleep(500);
  for (const f of findings) check(f.pass, `${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  writeFileSync(path.join(SHOT_DIR, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
  log(`${findings.filter((f) => f.pass).length}/${findings.length} checks pass`);
} catch (err) {
  console.error(err);
  check(false, String(err));
} finally {
  await finish();
  // launchApp only removes a home IT made; this one was made here (probeHome,
  // so its path is known before launch) and holds the model's chat folder —
  // MEASURED 277 such homes, 55 GB, the day the disk filled. Kept on request.
  if (process.env.PI_E2E_KEEP_HOME !== '1') rmSync(home, { recursive: true, force: true });
}
