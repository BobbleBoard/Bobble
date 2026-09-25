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
import { FIXTURES, importTs, PROMPTS, REPO } from './lib/env.mjs';
import {
  heroHtml,
  htmlShot,
  kitCharts,
  measureDiagramSvg,
  motionFrame,
  renderDiagramTool,
} from './lib/kit-sheet.mjs';

/** The design kits, by their files (packages/design-kit/src/kits) — one kit sheet each (VQ-04). */
const KIT_IDS = readdirSync(path.join(REPO, 'packages', 'design-kit', 'src', 'kits'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

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
      // A chart that did not go in is a broken pipeline, not a variant.
      if (!r.ok || a.checks.insert_chart === 0)
        a.error = `insert_chart failed: ${r.error ?? r.missed}`;
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
      const page = `<!doctype html><html><body>${bare}</body></html>`;
      /* VQ-10: the guard now ROUTES — a diagram-shaped flow goes to the diagram
         tool (even one written with a <title>: the tool draws it better than any
         hand-typed boxes), other hand-typed art to OmniSVG. main has no route,
         so there this reads the old yes/no guard as the OmniSVG redirect. */
      const routeOf = (content) =>
        g.handwrittenSvgRoute
          ? g.handwrittenSvgRoute({
              path: 'flow.svg',
              content,
              exists: false,
              svgCommandAvailable: true,
              diagramAvailable: true,
              request,
            })
          : g.isHandwrittenSvg({
                path: 'flow.svg',
                content,
                exists: false,
                svgCommandAvailable: true,
                request,
              })
            ? 'svg'
            : null;
      const inlineRoute = g.inlineSvgRoute
        ? g.inlineSvgRoute({
            path: 'index.html',
            content: page,
            svgCommandAvailable: true,
            diagramAvailable: true,
            request,
          })
        : g.hasHandwrittenInlineSvg({
              path: 'index.html',
              content: page,
              svgCommandAvailable: true,
            })
          ? 'svg'
          : null;
      const route = routeOf(bare);
      const refusedFile = route !== null;
      const refusedCareful = routeOf(raw) !== null;
      const refusedInline = inlineRoute !== null;
      return [
        {
          id,
          kind: 'check',
          checks: {
            refused_as_written_by_4b: refusedFile,
            refused_with_title: refusedCareful,
            refused_inline_in_page: refusedInline,
            redirects_to:
              route === 'diagram' ? 'diagram (Mermaid)' : route === 'svg' ? 'svg (OmniSVG)' : null,
            inline_redirects_to:
              inlineRoute === 'diagram'
                ? 'diagram (Mermaid)'
                : inlineRoute === 'svg'
                  ? 'svg (OmniSVG)'
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
  {
    id: 'flow-diagram/d',
    what: 'the diagram tool (VQ-10): the same flow, unstyled, through the app’s own renderer — bundled Mermaid, the house kit, its semantic colours, light and dark',
    run: async (ctx, id) => {
      if (!ctx.mermaid)
        return [{ id, kind: 'check', skipped: 'no mermaid.min.js (pass --mermaid or VQ_MERMAID)' }];
      const src = readFileSync(path.join(FIXTURES, 'flow', 'd-diagram-source.mmd'), 'utf8');
      const r = await renderDiagramTool(
        await ctx.browser(),
        ctx.mermaid,
        src,
        path.join(ctx.files(id), 'flow'),
        { title: 'Order fulfilment', subtitle: 'Checkout to review request' },
      );
      // Measured in the browser, where Mermaid's translated groups are laid out
      // (see measureDiagramSvg) — the file ruler reads them all at the origin.
      const labels = [...r.reply.nodes, ...r.reply.labelledEdges];
      return [
        {
          id,
          kind: 'diagram',
          file: r.svg,
          pngs: [r.png, r.darkPng],
          metrics: await measureDiagramSvg(await ctx.browser(), r.svg, labels),
          checks: {
            source_lines: src.trim().split('\n').length,
            nodes: r.reply.nodes.length,
            edges: r.reply.edges,
            labelled_edges: r.reply.labelledEdges.length,
            failure_edges: r.reply.failEdges,
            decisions: r.reply.decisions,
            notes: r.reply.notes,
          },
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
  // ── the design kits (VQ-04): one sheet per kit ────────────────────────────
  ...KIT_IDS.map((kitId) => ({
    id: `kits/${kitId}`,
    what: `the ${kitId} design kit: a slide (python-pptx from design_tokens.json), two charts (lookFromKit), a page hero (kit CSS), a motion frame (the title card), a diagram (the diagram tool)`,
    run: async (ctx, id) => {
      const dk = await importTs('packages/design-kit/src/index.ts');
      const kit = dk.kitOrDefault(kitId);
      const report = dk.validateKit(kit);
      const pptx = path.join(ctx.files(id), 'slide.pptx');
      const python = JSON.parse(ctx.py('kit_slide.py', [kitId, pptx]));
      const [bars, donut] = await kitCharts(ctx.files(id), kit);
      const hero = await htmlShot(
        await ctx.browser(),
        heroHtml(dk, kit, 'light'),
        path.join(ctx.renders(id), 'hero.png'),
      );
      const motion = await motionFrame(
        await ctx.browser(),
        kit,
        path.join(ctx.renders(id), 'motion.png'),
      );
      const arts = [
        { id: `${id}/slide`, kind: 'pptx', file: pptx },
        { id: `${id}/chart-bars`, kind: 'svg', file: bars },
        { id: `${id}/chart-donut`, kind: 'svg', file: donut },
        { id: `${id}/hero`, kind: 'page', pngs: [hero] },
        { id: `${id}/motion`, kind: 'motion', pngs: [motion] },
      ];
      if (ctx.mermaid) {
        const dg = await renderDiagramTool(
          await ctx.browser(),
          ctx.mermaid,
          readFileSync(path.join(FIXTURES, 'flow', 'd-diagram-source.mmd'), 'utf8'),
          path.join(ctx.files(id), 'diagram'),
          { kit: kitId, title: 'Order fulfilment' },
        );
        arts.push({
          id: `${id}/diagram`,
          kind: 'diagram',
          file: dg.svg,
          pngs: [dg.png],
          metrics: await measureDiagramSvg(await ctx.browser(), dg.svg, [
            ...dg.reply.nodes,
            ...dg.reply.labelledEdges,
          ]),
        });
      }
      arts.push({
        id,
        kind: 'check',
        checks: {
          validates: report.ok,
          issues: report.issues.map((i) => `${i.mode}: ${i.what}`),
          python_read: python,
        },
      });
      return arts;
    },
  })),
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
