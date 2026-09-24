/**
 * THE FIXED SET: the six research prompts (deliverables/research/visual-quality.md
 * §2.2), every variant the research made of each, and the REAL 4B captures.
 * Nothing here calls a model: office cases run the real `office.py make` against
 * canned replies (py/replay_server.py), chart cases run the real chart tool on
 * command lines, motion runs the app's own HyperFrames scene code.
 *
 * A case returns one or more ARTIFACTS: { id, kind, file?, spec?, office?,
 * pngs?, metrics?, checks? }. kind pptx | docx | pdf | svg are rendered by
 * QuickLook / Chromium and measured by py/measure.py; page | motion | check
 * carry the metrics their own renderer computed.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  hyperframesStills,
  measureHtml,
  pageShots,
  renderMermaid,
  svgToPng,
} from './lib/browser-renders.mjs';
import { renderChartSpecs, runChartLines } from './lib/chart.mjs';
import { FIXTURES, importTs, PROMPTS } from './lib/env.mjs';

const brief = (name) => readFileSync(path.join(PROMPTS, `${name}.txt`), 'utf8').trim();
const replies = (name) => path.join(FIXTURES, 'replies', `${name}.json`);
const captured = (name) => path.join(FIXTURES, 'captured-4b', name);
const html = (name) => path.join(FIXTURES, 'html', name);

/** `office make` through the replay stub → one artifact (spec = what office.py rendered). */
async function make(ctx, id, { repliesFile, kind, briefText, name, args = [] }) {
  const file = path.join(ctx.files(id), `${name}.${kind === 'chart' ? 'svg' : kind}`);
  const r = ctx.officeMake(id, repliesFile, [
    'make',
    kind,
    '--brief',
    briefText,
    '--out',
    file,
    ...args,
  ]);
  const specFile = path.join(ctx.work(id), `last_${kind}_spec.json`);
  return {
    id,
    kind: kind === 'chart' ? 'svg' : kind,
    file: r.ok ? r.path : null,
    spec: existsSync(specFile) ? specFile : null,
    office: r,
  };
}

/** A captured spec replayed through `office.py make` with its own brief. */
function capturedReplies(ctx, id, spec, kind) {
  const obj =
    kind === 'pptx'
      ? {
          plan: {
            theme: spec.theme,
            running_title: spec.running_title,
            slides: spec.slides.map((s) => ({
              layout: s.layout,
              title: s.title ?? '',
              intent: '',
            })),
          },
          fills: spec.slides,
        }
      : kind === 'chart'
        ? { chart: spec }
        : { doc: spec };
  const file = path.join(ctx.work(id), 'replies.json');
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

export const CASES = [
  // ── 1. six-slide pitch deck ────────────────────────────────────────────────
  {
    id: 'pitch-deck/a',
    what: 'office make pptx — replay of 4B-style replies (habits copied from captured 4B output)',
    run: async (ctx, id) => [
      await make(ctx, id, {
        repliesFile: replies('pitch-deck-a'),
        kind: 'pptx',
        briefText: brief('pitch-deck'),
        name: 'deck',
      }),
    ],
  },
  {
    id: 'pitch-deck/b1',
    what: 'office make pptx — the same pipeline with an expert spec',
    run: async (ctx, id) => [
      await make(ctx, id, {
        repliesFile: replies('pitch-deck-b1'),
        kind: 'pptx',
        briefText: brief('pitch-deck'),
        name: 'deck',
      }),
    ],
  },
  {
    id: 'pitch-deck/c',
    what: 'design-system HTML slides → measured records → html2pptx (native pptx)',
    run: async (ctx, id) => {
      const recs = path.join(ctx.work(id), 'records.json');
      await measureHtml(await ctx.browser(), html('pitch-deck-c-slides.html'), recs);
      const file = path.join(ctx.files(id), 'deck.pptx');
      ctx.py('html_records_build.py', ['pptx', recs, file]);
      return [{ id, kind: 'pptx', file }];
    },
  },
  // ── 2. one-page report ─────────────────────────────────────────────────────
  {
    id: 'one-page-report/a',
    what: 'office make docx — replay of 4B-style replies',
    run: async (ctx, id) => [
      await make(ctx, id, {
        repliesFile: replies('one-page-report-a'),
        kind: 'docx',
        briefText: brief('one-page-report'),
        name: 'report',
      }),
    ],
  },
  {
    id: 'one-page-report/a-pdf',
    what: 'office make pdf — the same 4B-style spec through pdf_render',
    run: async (ctx, id) => [
      await make(ctx, id, {
        repliesFile: replies('one-page-report-a'),
        kind: 'pdf',
        briefText: brief('one-page-report'),
        name: 'report',
      }),
    ],
  },
  {
    id: 'one-page-report/b',
    what: 'office make docx with an expert spec, then the chart tool hbar put in with office apply insert_chart',
    run: async (ctx, id) => {
      const a = await make(ctx, id, {
        repliesFile: replies('one-page-report-b'),
        kind: 'docx',
        briefText: brief('one-page-report'),
        name: 'report',
      });
      if (!a.file) return [a];
      for (const f of readdirSync(path.join(FIXTURES, 'charts')).filter((n) =>
        n.startsWith('share-of-q3-tickets'),
      )) {
        copyFileSync(path.join(FIXTURES, 'charts', f), path.join(ctx.work(id), f));
      }
      const outline = ctx.office(['inspect', a.file]).outline ?? '';
      const pid = /^(p\d+)\s+"Each has a fix/m.exec(outline)?.[1] ?? 'end';
      const ops = [
        {
          op: 'insert_chart',
          file: path.join(ctx.work(id), 'share-of-q3-tickets.svg'),
          after: pid,
        },
      ];
      const r = ctx.office(['apply', a.file, '--ops', JSON.stringify(ops)]);
      a.checks = { insert_chart: r.ok ? (r.applied ?? []).length : 0, after: pid };
      return [a];
    },
  },
  {
    id: 'one-page-report/c',
    what: 'design-system HTML page (tokens + browser layout) → html2pdf (vector, letter)',
    run: async (ctx, id) => {
      const recs = path.join(ctx.work(id), 'records.json');
      await measureHtml(await ctx.browser(), html('one-page-report-c-page.html'), recs, {
        width: 1280,
        height: 1656,
      });
      const file = path.join(ctx.files(id), 'report.pdf');
      ctx.py('html_records_build.py', ['pdf', recs, file, '612', '792']);
      return [{ id, kind: 'pdf', file }];
    },
  },
  // ── 3. flow diagram ────────────────────────────────────────────────────────
  {
    id: 'flow-diagram/a-guard',
    what: 'the hand-written-SVG guard on a 4B-style flow.svg and on the same diagram inline in a page',
    run: async (_ctx, id) => {
      const g = await importTs('packages/harness/src/tools/handwritten-svg.ts');
      const raw = readFileSync(path.join(FIXTURES, 'flow', 'b-handwritten.svg'), 'utf8');
      // "as a 4B writes it": no <title>, <desc> or comments
      const bare = raw.replace(
        /<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>|<!--[\s\S]*?-->/g,
        '',
      );
      const request = brief('flow-diagram');
      const refusedFile = g.isHandwrittenSvg({
        path: 'flow.svg',
        content: bare,
        exists: false,
        svgCommandAvailable: true,
        request,
      });
      const refusedCareful = g.isHandwrittenSvg({
        path: 'flow.svg',
        content: raw,
        exists: false,
        svgCommandAvailable: true,
        request,
      });
      const refusedInline = g.hasHandwrittenInlineSvg({
        path: 'index.html',
        content: `<!doctype html><html><body>${bare}</body></html>`,
        svgCommandAvailable: true,
      });
      return [
        {
          id,
          kind: 'check',
          checks: {
            refused_as_written_by_4b: refusedFile,
            refused_with_title: refusedCareful,
            refused_inline_in_page: refusedInline,
            redirects_to: refusedFile
              ? /`svg`|svg "/.test(g.handwrittenSvgRefusal('flow.svg'))
                ? 'svg (OmniSVG)'
                : 'other'
              : null,
          },
        },
      ];
    },
  },
  {
    id: 'flow-diagram/a3',
    what: 'office make pptx — the flow layout as the only diagram primitive (7 steps, 2 branches)',
    run: async (ctx, id) => [
      await make(ctx, id, {
        repliesFile: replies('flow-diagram-a3'),
        kind: 'pptx',
        briefText: brief('flow-diagram'),
        name: 'flow',
      }),
    ],
  },
  {
    id: 'flow-diagram/b',
    what: 'a hand-written SVG (a strong author)',
    run: async (ctx, id) => {
      const file = path.join(ctx.files(id), 'flow.svg');
      copyFileSync(path.join(FIXTURES, 'flow', 'b-handwritten.svg'), file);
      return [{ id, kind: 'svg', file }];
    },
  },
  {
    id: 'flow-diagram/c',
    what: 'the proposed diagram tool, prototyped: Mermaid → dagre layout, house theme (needs --mermaid)',
    run: async (ctx, id) => {
      if (!ctx.mermaid)
        return [{ id, kind: 'check', skipped: 'no mermaid.min.js (pass --mermaid or VQ_MERMAID)' }];
      const src = readFileSync(path.join(FIXTURES, 'flow', 'c-diagram-source.mmd'), 'utf8');
      const stem = path.join(ctx.files(id), 'flow');
      const r = await renderMermaid(await ctx.browser(), ctx.mermaid, src, stem, {
        title: 'Order fulfilment',
        subtitle: 'Happy path left to right · failures loop back in orange',
      });
      const nodes = (src.match(/^\s*\w+[([{]/gm) ?? []).length;
      return [
        {
          id,
          kind: 'svg',
          file: r.svg,
          pngs: [r.png],
          checks: { source_lines: src.split('\n').length, nodes_declared: nodes },
        },
      ];
    },
  },
  // ── 4. chart set ───────────────────────────────────────────────────────────
  {
    id: 'chart-set/a',
    what: 'the chart tool driven the way the REAL 4B dataviz session drove it (JSON arrays, no titles, one folder)',
    run: async (ctx, id) => {
      const lines = ctx.readJson(path.join(FIXTURES, 'charts', 'lines.json')).a;
      const r = await runChartLines(ctx.files(id), lines);
      const arts = r.svgs.map((f) => ({
        id: `${id}/${path.basename(f, '.svg')}`,
        kind: 'svg',
        file: f,
      }));
      arts.unshift({
        id,
        kind: 'check',
        checks: {
          calls: r.calls.length,
          files_written: r.svgs.length,
          overwrote: r.svgs.length < r.calls.filter((c) => !c.error).length,
          replies: r.calls.map((c) => c.reply.split('\n')[0]),
        },
      });
      return arts;
    },
  },
  {
    id: 'chart-set/a-office',
    what: 'office make chart — the second chart renderer (chart_render.py), 4B-style spec',
    run: async (ctx, id) => [
      await make(ctx, id, {
        repliesFile: replies('chart-set-a-office'),
        kind: 'chart',
        briefText: brief('chart-set'),
        name: 'mau',
      }),
    ],
  },
  {
    id: 'chart-set/a-real',
    what: 'the REAL 4B dataviz-session specs (2026-09-17) drawn again by today’s packages/charts',
    run: async (ctx, id) => {
      const specs = readdirSync(path.join(FIXTURES, 'captured-4b'))
        .filter((f) => f.endsWith('.chart.json'))
        .sort()
        .map((f) => captured(f));
      const out = await renderChartSpecs(ctx.files(id), specs, ctx.readJson);
      return out.map((o) =>
        o.svg
          ? { id: `${id}/${o.name}`, kind: 'svg', file: o.svg }
          : { id: `${id}/${o.name}`, kind: 'check', error: o.error },
      );
    },
  },
  {
    id: 'chart-set/b',
    what: 'the chart tool used well (insight titles, units, one look, opposed hues)',
    run: async (ctx, id) => {
      const r = await runChartLines(
        ctx.files(id),
        ctx.readJson(path.join(FIXTURES, 'charts', 'lines.json')).b,
      );
      return r.svgs.map((f) => ({ id: `${id}/${path.basename(f, '.svg')}`, kind: 'svg', file: f }));
    },
  },
  {
    id: 'chart-set/parse',
    what: 'value parsing: "22M, 3,100" and "$1.2M, $2.4M" (D22, D23)',
    run: async (ctx, id) => {
      const r = await runChartLines(
        ctx.files(id),
        ctx.readJson(path.join(FIXTURES, 'charts', 'lines.json')).parse,
      );
      const data = r.calls.map((c) => {
        const m = /^Data: (.*)$/m.exec(c.reply);
        return c.error ? `error: ${c.reply.split('\n')[0]}` : (m?.[1] ?? c.reply.split('\n')[0]);
      });
      const arts = r.svgs.map((f) => ({
        id: `${id}/${path.basename(f, '.svg')}`,
        kind: 'svg',
        file: f,
      }));
      arts.unshift({ id, kind: 'check', checks: { data } });
      return arts;
    },
  },
  // ── 5. landing page ────────────────────────────────────────────────────────
  {
    id: 'landing-page/a',
    what: 'the 4B house style with the Kiln brief (a labelled reconstruction)',
    run: async (ctx, id) => [await page(ctx, id, html('landing-a-4b-house-style.html'))],
  },
  {
    id: 'landing-page/a-real',
    what: 'the only two pages the 4B wrote in Bobble chats (REAL)',
    run: async (ctx, id) => {
      const dir = path.join(FIXTURES, 'html', 'real-4b-pages');
      const out = [];
      for (const f of readdirSync(dir)
        .filter((n) => n.endsWith('.html'))
        .sort()) {
        out.push(await page(ctx, `${id}/${f.replace(/\.html$/, '')}`, path.join(dir, f)));
      }
      return out;
    },
  },
  {
    id: 'landing-page/b',
    what: 'the same toolchain used well (tokens, generated photographs)',
    run: async (ctx, id) => [await page(ctx, id, html('landing-b-designed.html'))],
  },
  // ── 6. motion graphic ──────────────────────────────────────────────────────
  {
    id: 'motion-graphic/a',
    what: 'the text prompt through HyperFrames (buildSceneDocument) — 6 s at 12 fps',
    run: async (ctx, id) => [await motion(ctx, id, brief('motion-graphic'))],
  },
  {
    id: 'motion-graphic/b',
    what: 'an authored, seekable scene in the deck’s brand',
    run: async (ctx, id) => [await motion(ctx, id, html('motion-b-authored-scene.html'))],
  },
  // ── REAL 4B captures, through today's pipeline ─────────────────────────────
  ...['solar-deck', 'tea-docx', 'units-pdf', 'units-chart', 'cookie-docx'].map((key) => ({
    id: `captured/${key}`,
    what: 'a REAL 4B spec (fixtures/captured-4b) replayed through office.py make with its brief',
    run: async (ctx, id) => {
      const b = ctx.readJson(captured('briefs.json'))[key];
      const spec = ctx.readJson(captured(b.spec));
      const file = capturedReplies(ctx, id, spec, b.kind);
      return [
        await make(ctx, id, { repliesFile: file, kind: b.kind, briefText: b.brief, name: key }),
      ];
    },
  })),
];

async function page(ctx, id, file) {
  const stem = path.join(ctx.renders(id), 'page');
  const r = await pageShots(await ctx.browser(), file, stem);
  return {
    id,
    kind: 'page',
    pngs: [r.shots.desktop, r.shots.phone],
    metrics: { overflow_px: r.overflow, fonts: r.fonts, text: r.text },
  };
}

async function motion(ctx, id, input) {
  const r = await hyperframesStills(await ctx.browser(), input, ctx.renders(id), {
    seconds: 6,
    fps: 12,
  });
  // One still per second, plus the settled last frame.
  const pick = r.frames.filter((_, i) => i % 12 === 0);
  return { id, kind: 'motion', pngs: pick, frame0: r.frames[0], metrics: r.metrics };
}

export { svgToPng };
