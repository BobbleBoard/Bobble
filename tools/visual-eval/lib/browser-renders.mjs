/**
 * Everything the eval draws in a browser, in ONE headless Chromium (no window,
 * no focus): SVG files to PNG, pages at desktop and phone width, HyperFrames
 * stills through the app's own scene/seek code, HTML design-system slides
 * measured into element records for the native emitters, and the Mermaid
 * diagram prototype.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importTs } from './env.mjs';

/** An SVG file to a PNG at its own size. */
export async function svgToPng(browser, svgFile, pngFile) {
  const src = readFileSync(svgFile, 'utf8');
  const vb = /viewBox="([^"]+)"/.exec(src)?.[1]?.split(/\s+/).map(Number);
  const w = Math.round(vb?.[2] ?? Number(/width="([\d.]+)/.exec(src)?.[1] ?? 960));
  const h = Math.round(vb?.[3] ?? Number(/height="([\d.]+)/.exec(src)?.[1] ?? 560));
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  try {
    await page.goto(pathToFileURL(svgFile).href);
    await page.evaluate(() => document.fonts?.ready);
    await page.screenshot({ path: pngFile });
  } finally {
    await page.close();
  }
  return pngFile;
}

/**
 * A page at desktop (1440) and phone (390) width, full length, after its
 * entrances settle. Reports the phone view's horizontal overflow, the font
 * families actually used, and how much text is set under 14 px.
 */
export async function pageShots(browser, htmlFile, stem, settleMs = 1500) {
  const out = { shots: {}, overflow: {}, fonts: [], text: null };
  for (const [tag, vp] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
    try {
      await page.goto(pathToFileURL(htmlFile).href);
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(settleMs);
      out.overflow[tag] = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (tag === 'desktop') {
        const m = await page.evaluate(() => {
          let chars = 0;
          let small = 0;
          const fams = new Set();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.textContent.replace(/\s+/g, '');
            if (!t) continue;
            const el = n.parentElement;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            chars += t.length;
            if (parseFloat(cs.fontSize) < 14) small += t.length;
            fams.add(cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
          }
          return { chars, small, fams: [...fams].sort() };
        });
        out.fonts = m.fams;
        out.text = {
          chars: m.chars,
          small_threshold: '14px',
          small_pct: m.chars ? Math.round((1000 * m.small) / m.chars) / 10 : 0,
        };
      }
      const file = `${stem}-${tag}.png`;
      await page.screenshot({ path: file, fullPage: true });
      out.shots[tag] = file;
    } finally {
      await page.close();
    }
  }
  return out;
}

/**
 * HyperFrames stills rendered the way the app renders them: the scene document
 * from hyperframes-still.ts's own buildSceneDocument (a plain-text prompt
 * becomes exactly the title card the app makes), every frame pinned by its own
 * seekScript, at its own frameTimes. Only the window differs: headless Chromium
 * instead of Electron's offscreen BrowserWindow.
 */
export async function hyperframesStills(
  browser,
  input,
  outdir,
  { seconds = 6, fps = 12, width = 1280, height = 720 } = {},
) {
  const hf = await importTs('apps/desktop/electron/gen/hyperframes-still.ts');
  const prompt = existsSync(input) ? readFileSync(input, 'utf8') : input;
  const html = hf.buildSceneDocument(prompt, { width, height, seconds, fps });
  mkdirSync(outdir, { recursive: true });
  writeFileSync(path.join(outdir, 'scene.html'), html);
  const times = hf.frameTimes(seconds, fps);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const frames = [];
  const digests = new Set();
  let domText = '';
  try {
    await page.setContent(html);
    await page.evaluate(() => document.fonts?.ready);
    for (let i = 0; i < times.length; i++) {
      await page.evaluate(hf.seekScript(times[i]));
      const png = await page.screenshot({ type: 'png' });
      digests.add(createHash('sha1').update(png).digest('hex'));
      const file = path.join(outdir, hf.frameFileName(i, times.length));
      writeFileSync(file, png);
      frames.push(file);
    }
    domText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  } finally {
    await page.close();
  }
  const words = (s) => s.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
  const pw = words(prompt);
  const dw = new Set(words(domText));
  const shared = pw.filter((w) => dw.has(w)).length;
  return {
    frames,
    metrics: {
      frames: frames.length,
      distinct: digests.size,
      scene: hf.looksLikeScene(prompt),
      dom_text: domText.slice(0, 160),
      // The instruction printed as the title (D31): most of the prompt's words
      // are on screen and the screen says little else.
      prints_prompt: !hf.looksLikeScene(prompt) && pw.length > 0 && shared / pw.length >= 0.6,
    },
  };
}

/**
 * HTML slides (`section.slide`) -> measured element records, ONE RECORD PER
 * RENDERED LINE of each text node, which is what the native emitters need to
 * keep the browser's line breaks (the research's html_to_pptx.mjs).
 */
export async function measureHtml(
  browser,
  htmlFile,
  recordsFile,
  { width = 1280, height = 720 } = {},
) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  let slides;
  try {
    await page.goto(pathToFileURL(htmlFile).href);
    await page.evaluate(() => document.fonts?.ready);
    slides = await page.evaluate(() => {
      const rec = (el, extra) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        return {
          tag,
          x: r.x,
          y: r.y + window.scrollY,
          w: r.width,
          h: r.height,
          bg: cs.backgroundColor,
          color: cs.color,
          opacity: cs.opacity,
          bgImage: cs.backgroundImage,
          boxShadow: cs.boxShadow,
          transform: cs.transform,
          radius: cs.borderTopLeftRadius.endsWith('%')
            ? (Math.min(r.width, r.height) * parseFloat(cs.borderTopLeftRadius)) / 100
            : parseFloat(cs.borderTopLeftRadius) || 0,
          borderW: parseFloat(cs.borderTopWidth) || 0,
          borderC: cs.borderTopColor,
          fontSize: parseFloat(cs.fontSize),
          fontWeight: cs.fontWeight,
          fontFamily: cs.fontFamily,
          italic: cs.fontStyle === 'italic',
          align: cs.textAlign,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing,
          text: '',
          points: tag === 'polyline' || tag === 'polygon' ? el.getAttribute('points') : null,
          d: tag === 'path' ? el.getAttribute('d') : null,
          stroke: cs.stroke,
          strokeWidth: parseFloat(cs.strokeWidth) || 0,
          fillC: cs.fill,
          ...extra,
        };
      };
      const lines = (node) => {
        const chars = [];
        const t = node.textContent;
        for (let i = 0; i < t.length; i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rc = range.getClientRects()[0];
          if (!rc) continue;
          chars.push({ ch: t[i], x: rc.left, y: rc.top, r: rc.right, b: rc.bottom });
        }
        const out = [];
        let cur = null;
        for (const c of chars) {
          if (cur === null || Math.abs(c.y - cur.y) > (c.b - c.y) * 0.5) {
            if (cur) out.push(cur);
            cur = { text: '', x: c.x, y: c.y, r: c.r, b: c.b };
          }
          cur.text += c.ch;
          if (c.ch.trim() !== '') {
            cur.r = Math.max(cur.r, c.r);
            cur.x = Math.min(cur.x, c.x);
          }
          cur.b = Math.max(cur.b, c.b);
        }
        if (cur) out.push(cur);
        return out
          .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
          .filter((l) => l.text);
      };
      const result = [];
      for (const slide of document.querySelectorAll('section.slide')) {
        const top = slide.getBoundingClientRect().top + window.scrollY;
        const out = [];
        const walk = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 0.5 || r.height < 0.5) return;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          const base = rec(el, {});
          base.y -= top;
          out.push(base);
          if (!(el instanceof SVGElement)) {
            for (const node of el.childNodes) {
              if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
              for (const l of lines(node)) {
                out.push({
                  ...rec(el, {}),
                  tag: 'span',
                  x: l.x,
                  y: l.y + window.scrollY - top,
                  w: l.r - l.x + 2,
                  h: l.b - l.y,
                  bg: 'rgba(0, 0, 0, 0)',
                  bgImage: 'none',
                  boxShadow: 'none',
                  borderW: 0,
                  align: 'left',
                  text: l.text,
                });
              }
            }
          }
          if (el.tagName.toLowerCase() === 'circle') {
            base.cx = parseFloat(el.getAttribute('cx'));
            base.cy = parseFloat(el.getAttribute('cy'));
          }
          for (const c of el.children) walk(c);
        };
        walk(slide);
        result.push(out);
      }
      return result;
    });
  } finally {
    await page.close();
  }
  writeFileSync(recordsFile, JSON.stringify(slides));
  return { slides: slides.length, records: slides.reduce((n, s) => n + s.length, 0) };
}

/**
 * PROTOTYPE of the proposed `diagram` tool (VQ-10): Mermaid source laid out by
 * a real graph layout in one house theme, with the label-contrast guard.
 */
export async function renderMermaid(
  browser,
  mermaidJs,
  source,
  outStem,
  { title = '', subtitle = '', look = 'clean' } = {},
) {
  const theme = {
    theme: 'base',
    look: look === 'sketch' ? 'handDrawn' : 'classic',
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    flowchart: {
      curve: 'basis',
      nodeSpacing: 40,
      rankSpacing: 48,
      padding: 16,
      htmlLabels: true,
      useMaxWidth: false,
    },
    themeVariables: {
      fontSize: '17px',
      primaryColor: '#FFFFFF',
      primaryTextColor: '#0F1E26',
      primaryBorderColor: '#0F1E26',
      lineColor: '#4A5A63',
      secondaryColor: '#DCEBEA',
      tertiaryColor: '#F5F7F6',
      background: '#F7F8F7',
      edgeLabelBackground: '#F7F8F7',
      clusterBkg: '#F5F7F6',
      clusterBorder: '#C9D3D2',
    },
  };
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#F7F8F7;font-family:"Helvetica Neue"} #wrap{display:inline-block;padding:40px 48px}
  h1{font-size:26px;font-weight:600;color:#0F1E26;margin:0 0 4px} .sub{font-size:15px;color:#4A5A63;margin:0 0 20px}
</style></head><body><div id="wrap"><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div><div id="d"></div></div>
<script>
  window.__go = () => { mermaid.initialize(Object.assign({ startOnLoad: false }, ${JSON.stringify(theme)}));
  mermaid.render('g', ${JSON.stringify(source)}).then(({ svg }) => { document.getElementById('d').innerHTML = svg;
      const lum = (c) => { const m = c.match(/\\d+(\\.\\d+)?/g); if (!m) return 1; const [r, g, b] = m.slice(0, 3).map((v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      for (const node of document.querySelectorAll('#d g.node')) {
        const shape = node.querySelector('rect, path, polygon, circle');
        if (!shape) continue;
        const fill = getComputedStyle(shape).fill;
        if (fill && fill.startsWith('rgb') && lum(fill) < 0.2) for (const l of node.querySelectorAll('.nodeLabel, span, p')) l.style.color = '#FFFFFF';
      }
      window.__svg = document.querySelector('#d svg').outerHTML; window.__done = true; })
    .catch((e) => { window.__err = String(e); window.__done = true; }); };
</script></body></html>`;
  const page = await browser.newPage({
    viewport: { width: 1400, height: 800 },
    deviceScaleFactor: 2,
  });
  try {
    await page.setContent(html);
    await page.addScriptTag({ path: mermaidJs });
    await page.evaluate(() => window.__go());
    await page.waitForFunction(() => window.__done === true);
    const err = await page.evaluate(() => window.__err);
    if (err) throw new Error(`mermaid: ${err}`);
    writeFileSync(`${outStem}.svg`, await page.evaluate(() => window.__svg));
    await page.locator('#wrap').screenshot({ path: `${outStem}.png` });
  } finally {
    await page.close();
  }
  return { svg: `${outStem}.svg`, png: `${outStem}.png` };
}
