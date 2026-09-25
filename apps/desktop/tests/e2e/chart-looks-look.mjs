/**
 * LOOK AT EVERY CHART LOOK, LIGHT AND DARK — the before/after sheets for VQ-03.
 *
 * The visual-quality research ran the eleven looks through the data-viz palette
 * validator and every one failed at least one check; seven could not be told
 * apart by a colour-blind reader. The looks are re-stepped to pass
 * (packages/charts/src/palette-check.ts pins the numbers in a unit test); this
 * is the part a test cannot do — what they LOOK like, so the user can judge that
 * each look kept its character.
 *
 * Headless (harness.mjs: hidden window, throwaway HOME, focus guard):
 *
 *   1. STATIC SHEETS. Every look × four sample charts (six series of grouped
 *      bars, one series with a highlighted bar, a donut with a highlighted
 *      slice, three lines), drawn by the real `chartToSvg` from this tree's
 *      SOURCE, on the light and the dark ground, with the palette check's
 *      verdict under each look's name. Rendered in an offscreen window of the
 *      running app (the same Chromium the app draws with).
 *   2. THE CARDS IN THE THREAD. The same looks as interactive cards
 *      (ChartView, from the BUILT app — run `npm run build` first), in the
 *      light and the dark theme, photographed card by card into one sheet.
 *
 *   SHOT_DIR=/tmp/chart-looks node tests/e2e/chart-looks-look.mjs
 *
 * The charts package is imported as TypeScript directly (Node ≥ 23.6 strips
 * the types; the package imports its own files with `.ts` extensions).
 */
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, REPO_ROOT } from './harness.mjs';

const charts = await import(
  pathToFileURL(path.join(REPO_ROOT, 'packages/charts/src/index.ts')).href
);
let check = null;
try {
  check = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/charts/src/palette-check.ts')).href
  );
} catch {
  check = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const {
  app,
  page,
  check: assert,
  finish,
  shotDir,
} = await launchApp('chart-looks', {
  waitFor: '[data-testid="composer-input"]',
});

const SAMPLES = [
  {
    type: 'bar',
    title: 'Six series',
    labels: ['Q1', 'Q2', 'Q3'],
    values: ['A: 5, 7, 6', 'B: 6, 5, 7', 'C: 4, 6, 5', 'D: 7, 4, 6', 'E: 5, 6, 4', 'F: 6, 7, 5'],
  },
  {
    type: 'bar',
    title: 'One series, one highlighted',
    labels: ['2021', '2022', '2023', '2024', '2025'],
    values: [12, 19, 15, 22, 17],
    highlight: '2024',
  },
  {
    type: 'donut',
    title: 'Donut, one highlighted',
    labels: ['A', 'B', 'C', 'D', 'E', 'F'],
    values: [30, 22, 16, 12, 11, 9],
    highlight: 'C',
  },
  {
    type: 'line',
    title: 'Three lines',
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    values: ['North: 3, 4, 6, 5, 7, 8', 'South: 2, 3, 3, 5, 6, 6', 'East: 4, 3, 5, 6, 5, 7'],
  },
];

/** The palette check's verdict for a look on a ground, as one line (or '' before it existed). */
function verdict(lookName, theme) {
  if (check === null || typeof check.lookPairs !== 'function') return '';
  const st = charts.resolveStyle({ look: lookName }, 'clean', { theme });
  const ground =
    st.ground?.paper ?? (theme === 'dark' ? charts.DARK_GROUND.paper : charts.LIGHT_GROUND.paper);
  const v = check.judgePairs(check.lookPairs(st.palette, st.accent));
  const minContrast = Math.min(
    ...[...st.palette, st.accent].map((c) => check.contrastRatio(c, ground)),
  );
  const ok =
    v.normal && minContrast >= 3 && (v.cvd === 'pass' || (v.cvd === 'floor' && st.labels === 'on'));
  return `${ok ? 'PASS' : 'FAIL'} · CVD ${v.worstCvd.cvd.toFixed(1)} · normal ${v.worstNormal.normal.toFixed(1)} · marks ${minContrast.toFixed(2)}:1`;
}

const W = 380;
const H = 240;

function sheetHtml(theme, looks) {
  const ink = theme === 'dark' ? '#EDEDF0' : '#1D1D1F';
  const mute = theme === 'dark' ? '#9A9AA3' : '#6E6E73';
  const rows = looks.map((look) => {
    const cells = SAMPLES.map((s) => {
      const spec = charts.normalizeChartSpec({ ...s, look: look.name });
      return `<div class="cell">${charts.chartToSvg(spec, { width: W, height: H, theme })}</div>`;
    }).join('');
    const pal = charts.resolveStyle({ look: look.name }, 'clean', { theme });
    const chips = [...pal.palette]
      .map((c) => `<i style="background:${c}"></i>`)
      .concat(`<i class="acc" style="background:${pal.accent}"></i>`)
      .join('');
    return `<div class="row"><div class="name"><b>${look.name}</b><span class="chips">${chips}</span><small>${verdict(look.name, theme)}</small></div>${cells}</div>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: ${theme === 'dark' ? '#101012' : '#E9E9EC'}; }
    body { font-family: -apple-system, 'Helvetica Neue', sans-serif; padding: 12px; }
    .row { display: flex; gap: 10px; margin-bottom: 10px; align-items: flex-start; }
    .name { width: 170px; color: ${ink}; font-size: 17px; padding-top: 10px; }
    .name small { display: block; color: ${mute}; font-size: 11px; line-height: 1.4; margin-top: 6px; }
    .chips { display: flex; gap: 3px; margin-top: 8px; flex-wrap: wrap; }
    .chips i { width: 18px; height: 18px; border-radius: 4px; display: inline-block; }
    .chips i.acc { border-radius: 9px; margin-left: 6px; }
    .cell svg { display: block; }
  </style></head><body>${rows.join('')}</body></html>`;
}

/**
 * Render an HTML document in an offscreen window of the running app → PNG bytes.
 * Through a file: a sheet of inlined screenshots is past Chromium's data-URL limit.
 */
let sheetNo = 0;
async function renderHtml(html, width, height) {
  sheetNo += 1;
  const file = path.join(shotDir, `.sheet-${sheetNo}.html`);
  writeFileSync(file, html);
  const b64 = await app.evaluate(
    async ({ BrowserWindow }, [doc, w, h]) => {
      const win = new BrowserWindow({
        width: w,
        height: h,
        show: false,
        frame: false,
        webPreferences: {
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      try {
        win.webContents.setZoomFactor(1);
        await win.loadFile(doc);
        await new Promise((r) => setTimeout(r, 300));
        const image = await win.webContents.capturePage();
        const size = image.getSize();
        const out =
          size.width > w || size.height > h
            ? image.resize({ width: w, height: h, quality: 'best' })
            : image;
        return out.toPNG().toString('base64');
      } finally {
        win.destroy();
      }
    },
    [file, width, height],
  );
  rmSync(file, { force: true });
  return Buffer.from(b64, 'base64');
}

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1500);

  // ── 1. the static sheets ────────────────────────────────────────────────
  const chunks = [charts.LOOKS.slice(0, 4), charts.LOOKS.slice(4, 8), charts.LOOKS.slice(8)];
  for (const theme of ['light', 'dark']) {
    for (const [i, looks] of chunks.entries()) {
      const width = 12 * 2 + 170 + SAMPLES.length * (W + 10);
      const height = 24 + looks.length * (H + 10);
      const png = await renderHtml(sheetHtml(theme, looks), width, height);
      const file = path.join(shotDir, `sheet-${theme}-${i + 1}.png`);
      writeFileSync(file, png);
      assert(png.length > 20_000, `sheet ${theme} ${i + 1} came back blank (${png.length} bytes)`);
    }
    for (const look of charts.LOOKS)
      console.log(`${theme} ${look.name.padEnd(10)} ${verdict(look.name, theme)}`);
  }

  // ── 2. the cards in the thread ─────────────────────────────────────────
  const user = { kind: 'user', id: 'u1', text: 'show me every look', timestamp: Date.now() };
  const assistant = {
    kind: 'assistant',
    id: 'a1',
    blocks: [{ type: 'text', text: 'Here they are.' }],
    timestamp: Date.now(),
    isStreaming: false,
  };
  await page.evaluate(
    ([u, a]) => window.__pi_store().setState({ session: { cwd: '/w/looks' }, messages: [u, a] }),
    [user, assistant],
  );
  await page.evaluate(
    ([looks, samples]) => {
      const st = window.__present_store().getState();
      for (const look of looks) {
        for (const [i, s] of [samples[0], samples[2]].entries()) {
          st.add({
            path: `/w/looks/${look}-${i}.svg`,
            chat: '',
            afterMessageId: 'a1',
            chart: { ...s, title: `${look} · ${s.title}`, look },
          });
        }
      }
    },
    [charts.LOOKS.map((l) => l.name), SAMPLES],
  );
  await sleep(1800);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-mode', t), theme);
    await sleep(900);
    const cards = page.locator('[data-testid="presented-chart"]');
    const n = await cards.count();
    assert(n === charts.LOOKS.length * 2, `expected ${charts.LOOKS.length * 2} cards, saw ${n}`);
    const shots = [];
    let tallest = 0;
    for (let i = 0; i < n; i += 1) {
      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded();
      await sleep(120);
      const box = await card.boundingBox();
      if (box !== null) tallest = Math.max(tallest, (box.height * 420) / box.width);
      shots.push((await card.screenshot()).toString('base64'));
    }
    const html = `<!doctype html><html><head><style>
      html, body { margin: 0; background: ${theme === 'dark' ? '#151517' : '#F5F5F7'}; }
      body { display: grid; grid-template-columns: repeat(4, 420px); gap: 8px; padding: 8px; align-items: start; }
      img { width: 420px; display: block; }
    </style></head><body>${shots.map((b) => `<img src="data:image/png;base64,${b}">`).join('')}</body></html>`;
    const rowsOfCards = Math.ceil(n / 4);
    const png = await renderHtml(html, 16 + 4 * 428, 16 + rowsOfCards * (Math.ceil(tallest) + 8));
    writeFileSync(path.join(shotDir, `cards-${theme}.png`), png);
    assert(png.length > 20_000, `the ${theme} card sheet came back blank`);
  }
  console.log(`sheets in ${shotDir}`);
} finally {
  await finish();
}
