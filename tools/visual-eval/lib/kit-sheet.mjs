/**
 * THE KIT SHEET (VQ-04's acceptance): each design kit rendered as the things it
 * dresses — a slide, a chart, a page hero, a motion frame and a diagram — side
 * by side, so a kit is judged by eye the way the user judges one, and every tile
 * comes from the SAME tokens by a different reader:
 *
 *   slide    python-pptx, reading tools/office-gen/design_tokens.json (py/kit_slide.py)
 *   chart    packages/charts, through lookFromKit
 *   hero     HTML on the kit's CSS custom properties (design-kit kitCssVars)
 *   motion   the app's HyperFrames title-card template, in the kit's deep and ink
 *   diagram  the app's diagram renderer (electron/gen/diagram-page.ts) + the bundled Mermaid
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importTs } from './env.mjs';

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

/** A page hero in the kit: nav, eyebrow, headline, lead, two actions, and a stat card drawn in the series. */
export function heroHtml(dk, kit, mode = 'light') {
  const vars = dk.kitCssVars(kit, mode, 'mac');
  const bars = [38, 52, 47, 66, 74, 92];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { ${vars} }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--kit-paper); color: var(--kit-ink); font-family: var(--kit-font-text); }
  .wrap { width: 1440px; height: 720px; padding: 0 var(--kit-margin); display: grid; grid-template-rows: 88px 1fr; }
  nav { display: flex; align-items: center; justify-content: space-between; border-bottom: var(--kit-stroke) solid var(--kit-line); }
  .brand { font-family: var(--kit-font-display); font-weight: var(--kit-weight-display); font-size: 24px; letter-spacing: var(--kit-tracking-display); }
  .links { display: flex; gap: 32px; color: var(--kit-mute); font-size: var(--kit-page-body); }
  .hero { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 64px; align-items: center; }
  .eyebrow { color: var(--kit-accent-ink); font-weight: var(--kit-weight-bold); font-size: var(--kit-page-caption); letter-spacing: var(--kit-tracking-caps); text-transform: uppercase; }
  h1 { font-family: var(--kit-font-display); font-weight: var(--kit-weight-display); font-size: var(--kit-page-h1); line-height: var(--kit-leading-heading); letter-spacing: var(--kit-tracking-display); margin: 16px 0 20px; text-wrap: balance; }
  .lead { color: var(--kit-mute); font-size: var(--kit-page-lead); line-height: var(--kit-leading-body); max-width: 34em; margin: 0 0 32px; }
  .actions { display: flex; gap: 12px; }
  .btn { font: inherit; font-size: var(--kit-page-body); font-weight: var(--kit-weight-medium); padding: 14px 22px; border-radius: var(--kit-radius-small); border: var(--kit-stroke) solid transparent; }
  .primary { background: var(--kit-accent); color: var(--kit-on-accent); }
  .ghost { background: transparent; color: var(--kit-ink); border-color: var(--kit-line); }
  .card { background: var(--kit-surface); border: var(--kit-stroke) solid var(--kit-line); border-radius: var(--kit-radius-card); padding: 28px; }
  .card .k { color: var(--kit-mute); font-size: var(--kit-page-caption); }
  .card .v { font-family: var(--kit-font-display); font-weight: var(--kit-weight-display); font-size: 56px; letter-spacing: var(--kit-tracking-display); margin: 6px 0 2px; }
  .card .d { color: var(--kit-good); font-weight: var(--kit-weight-medium); font-size: var(--kit-page-caption); }
  .bars { display: flex; align-items: flex-end; gap: 10px; height: 120px; margin-top: 24px; }
  .bars div { flex: 1; border-radius: var(--kit-radius-small) var(--kit-radius-small) 0 0; background: var(--kit-series-1); }
  .bars div:last-child { background: var(--kit-highlight); }
</style></head><body><div class="wrap">
  <nav><div class="brand">Tidewell</div><div class="links"><span>Product</span><span>Buildings</span><span>Pricing</span></div><button class="btn primary">Book a demo</button></nav>
  <section class="hero">
    <div>
      <div class="eyebrow">Leak response</div>
      <h1>Stop leaks before they start</h1>
      <p class="lead">A $39 sensor on every unit and a valve that closes itself in under two seconds — with or without the internet.</p>
      <div class="actions"><button class="btn primary">Protect a building</button><button class="btn ghost">See how it works</button></div>
    </div>
    <div class="card">
      <div class="k">Leaks stopped this year</div>
      <div class="v">1,284</div>
      <div class="d">+18% month on month</div>
      <div class="bars">${bars.map((h) => `<div style="height:${h}%"></div>`).join('')}</div>
    </div>
  </section>
</div></body></html>`;
}

/** The kit's motion frame: the HyperFrames title card on the kit's deep ground, settled. */
export async function motionFrame(browser, kit, outPng) {
  const hf = await importTs('apps/desktop/electron/gen/hyperframes-templates.ts');
  const still = await importTs('apps/desktop/electron/gen/hyperframes-still.ts');
  const c = kit.light;
  const html = hf.titleCardDocument(
    {
      title: 'Tidewell',
      tagline: 'Stop leaks before they start',
      ink: c.onDeep,
      paper: c.deep,
      light: false,
      pulse: false,
      bold: true,
    },
    { width: 1280, height: 720, seconds: 6 },
  );
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(html);
    await page.evaluate(() => document.fonts?.ready);
    await page.evaluate(still.seekScript(6));
    await page.screenshot({ path: outPng });
  } finally {
    await page.close();
  }
  return outPng;
}

/** A page of HTML at a fixed size, as a PNG. */
export async function htmlShot(browser, html, outPng, { width = 1440, height = 720 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html);
    await page.evaluate(() => document.fonts?.ready);
    await page.screenshot({ path: outPng });
  } finally {
    await page.close();
  }
  return outPng;
}

/**
 * The app's own diagram renderer, in the eval's headless Chromium: the same
 * page, script and job (diagram-page.ts runDiagram) the app's hidden window
 * runs, with the bundled Mermaid and a kit's two themes. Writes both drawings.
 */
export async function renderDiagramTool(
  browser,
  mermaidJs,
  source,
  outStem,
  { kit: kitId = 'paper-teal', title = '', subtitle = '' } = {},
) {
  const dp = await importTs('apps/desktop/electron/gen/diagram-page.ts');
  const dk = await importTs('packages/design-kit/src/index.ts');
  const kit = dk.kitOrDefault(kitId);
  const context = await browser.newContext({ bypassCSP: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await page.setContent(dp.PAGE_HTML);
    await page.addScriptTag({ content: readFileSync(mermaidJs, 'utf8') });
    await page.addScriptTag({ content: dp.PAGE_SCRIPT });
    const reply = await dp.runDiagram(
      {
        parse: (s) => page.evaluate((x) => window.__pdParse(x), s),
        render: (r) => page.evaluate((x) => window.__pdRender(x), r),
      },
      {
        source,
        ...(title ? { title } : {}),
        ...(subtitle ? { subtitle } : {}),
        themes: {
          light: dk.diagramTheme(kit, 'light', 'mac'),
          dark: dk.diagramTheme(kit, 'dark', 'mac'),
        },
      },
    );
    if (!reply.ok) throw new Error(`diagram: line ${reply.line}: ${reply.error} — ${reply.hint}`);
    const out = {
      reply,
      svg: `${outStem}.svg`,
      png: `${outStem}.png`,
      darkPng: `${outStem}-dark.png`,
    };
    writeFileSync(out.svg, reply.light.svg);
    writeFileSync(`${outStem}-dark.svg`, reply.dark.svg);
    for (const [drawing, png] of [
      [reply.light, out.png],
      [reply.dark, out.darkPng],
    ]) {
      const shot = await context.newPage();
      await shot.setViewportSize({ width: drawing.width, height: drawing.height });
      await shot.setContent(
        `<!doctype html><html><body style="margin:0">${drawing.svg}</body></html>`,
      );
      await shot.screenshot({ path: png });
      await shot.close();
    }
    return out;
  } finally {
    await context.close();
  }
}

/**
 * A diagram measured in a browser, where its geometry is real. py/measure.py
 * reads a .svg's <text> x/y as written, which is right for a chart and wrong
 * for Mermaid's output: every label sits inside a translated <g>, so all of
 * them read as stacked at the origin (78 "overlaps" in an 8-node flow) and
 * every label on a filled node reads as set on the white paper. Here: each
 * label's laid-out box (overlaps > 2 px both ways — the lint's L1), the
 * painted shape it actually sits on (contrast, WCAG 4.5:1, 3:1 at 24 px+ — L4),
 * the sizes and faces, and the labels the source asked for that were not drawn
 * (L6, "nodes in = nodes out").
 */
export async function measureDiagramSvg(browser, svgFile, expected = []) {
  const markup = readFileSync(svgFile, 'utf8');
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(`<!doctype html><html><body style="margin:0">${markup}</body></html>`);
    return await page.evaluate((want) => {
      const lum = (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c || '');
        if (!m) return null;
        const p = m[1].split(',').map(Number);
        if (p.length > 3 && p[3] < 0.5) return null;
        const ch = p.slice(0, 3).map((v) => {
          const x = v / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
      };
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const root = document.querySelector('svg');
      const shapes = [...root.querySelectorAll('rect, polygon, path, circle, ellipse')]
        .filter((s) => !s.closest('marker, defs') && lum(getComputedStyle(s).fill) !== null)
        .map((s) => ({ s, r: s.getBoundingClientRect() }));
      const texts = [...root.querySelectorAll('text')]
        .map((t) => ({ t, r: t.getBoundingClientRect(), words: t.textContent.trim() }))
        .filter((x) => x.words !== '' && x.r.width > 0);
      const overlaps = [];
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i].r;
          const b = texts[j].r;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 2 && h > 2)
            overlaps.push({
              a: texts[i].words,
              b: texts[j].words,
              px: Math.round(Math.min(w, h) * 10) / 10,
            });
        }
      }
      const contrastFails = [];
      const sizes = new Set();
      const fonts = new Set();
      let small = 0;
      for (const { t, r, words } of texts) {
        const cs = getComputedStyle(t);
        const size = parseFloat(cs.fontSize);
        sizes.add(size);
        fonts.add(cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
        if (size < 14) small += words.length;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        let under = null;
        for (const x of shapes) {
          if (cx < x.r.left || cx > x.r.right || cy < x.r.top || cy > x.r.bottom) continue;
          if (!(x.s.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          if (under === null || x.r.width * x.r.height < under.r.width * under.r.height) under = x;
        }
        const bg = under ? lum(getComputedStyle(under.s).fill) : 1;
        const fg = lum(cs.fill);
        if (bg === null || fg === null) continue;
        const need = size >= 24 ? 3 : 4.5;
        const got = ratio(fg, bg);
        if (got < need)
          contrastFails.push({ text: words, ratio: Math.round(got * 100) / 100, need });
      }
      const drawn = texts.map((x) => x.words);
      const chars = drawn.join('').length;
      return {
        overlaps,
        offcanvas: [],
        empty_regions: [],
        dropped: want.filter((w) => !drawn.includes(w)),
        fonts: [...fonts].sort(),
        text: {
          labels: texts.length,
          sizes_px: [...sizes].sort((a, b) => a - b),
          small_threshold: '14px',
          small_pct: chars ? Math.round((1000 * small) / chars) / 10 : 0,
        },
        palette: { contrast_fails: contrastFails },
        measured_by: 'browser (laid-out boxes, the painted shape under each label)',
      };
    }, expected);
  } finally {
    await page.close();
  }
}

/** The kit's two charts (a highlighted bar series, a donut of five shares), as the chart tool draws them. */
export async function kitCharts(dir, kit) {
  const charts = await importTs('packages/charts/src/index.ts');
  const style = charts.lookFromKit(kit);
  const bars = charts.normalizeChartSpec({
    type: 'bar',
    title: 'Leaks stopped per month',
    subtitle: '2026, all buildings',
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    values: [38, 52, 47, 66, 74, 92],
    highlight: 'Jun',
    style,
  });
  const donut = charts.normalizeChartSpec({
    type: 'donut',
    title: 'Where leaks start',
    labels: ['Water heater', 'Washer hose', 'Toilet', 'Dishwasher', 'Other'],
    values: [34, 26, 18, 12, 10],
    unit: '%',
    style,
  });
  const files = [];
  for (const [name, spec] of [
    ['chart-bars', bars],
    ['chart-donut', donut],
  ]) {
    const file = path.join(dir, `${name}.svg`);
    writeFileSync(file, charts.chartToSvg(spec));
    files.push(file);
  }
  return files;
}

export { esc };
