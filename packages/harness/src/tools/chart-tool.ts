/**
 * `chart` — a data visual, drawn in the chat in a second.
 *
 * the user (2026-09-16), with Claude's inline bar chart beside the one Bobble made
 * through the office pipeline: "this was way quicker and is a much stronger
 * result from claude here, we need parity on these datavisuals, it's a common
 * use case and very formulaic and doable … not just bar charts, all
 * datavisuals". Claude's is an interactive card in the thread — hover a bar
 * and the value reads out, a chart ⇄ table toggle in the corner, one line of
 * insight under it. Bobble's was a 15-second pipeline run through a second
 * model that turned a brief back into numbers, and a static picture on the
 * canvas.
 *
 * The formula is the whole point: the model already HAS the numbers, so the
 * tool takes them flat — a type, a title, the labels, the values — and draws.
 * No second model, no brief, nothing invented. It writes the spec beside a
 * static SVG of the same layout (`@pi-desktop/charts`, the one renderer the
 * chat card and the file share), and presents the SVG; the app reads the spec
 * beside it and renders the interactive card inline, with an Open-in-canvas
 * corner for the larger view.
 *
 *   chart bar "Units Sold by Year" --labels "2021, 2022, 2023, 2024" --values "12, 19, 15, 22"
 *
 * is the whole call. `office make chart` stays for a chart inside a document
 * flow; this is the chart the chat asks for.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  CHART_TYPES,
  type ChartSpec,
  type ChartType,
  chartToSvg,
  formatValue,
  normalizeChartSpec,
  pointCount,
} from '@pi-desktop/charts';
import { Type } from '@sinclair/typebox';
import type { PresentBridge } from './present.js';

export const CHART_TOOL = 'chart';
/** The spec written beside the SVG: `<stem>.svg` + `<stem>.chart.json`. */
export const CHART_SIDECAR_SUFFIX = '.chart.json';

export interface ChartToolDeps {
  readonly bridge: PresentBridge | null;
  /** The workspace root a relative path is resolved against. */
  readonly root: (ctxCwd: string | undefined) => string;
  /** Injected for tests. */
  readonly writeFileImpl?: (p: string, text: string) => Promise<void>;
}

const TYPE_WORD = new Set<string>([
  ...CHART_TYPES,
  'bars',
  'column',
  'columns',
  'pie',
  'doughnut',
  'ring',
  'horizontal',
  'ranked',
  'trend',
  'points',
  'xy',
  'stack',
  'grouped',
]);

/** A file name from the title: "Units Sold by Year" → units-sold-by-year. */
export function chartSlug(title: string, type: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug !== '' ? slug : `${type}-chart`;
}

/** "[1, 2]" → the list; anything else as it came. */
function jsonListIfAny(v: unknown): unknown {
  if (typeof v === 'string' && /^\s*\[/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * The flat call → the object `normalizeChartSpec` reads.
 *
 * Forgiving where a small model is loose: the positional order swapped
 * (`chart "Units Sold" bar`), a JSON list typed as a string, several series
 * as "Revenue: 4, 5; Cost: 3, 3", the whole spec handed in `data`.
 */
export function chartInputFromParams(p: Record<string, unknown>): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (typeof p.data === 'string' && p.data.trim() !== '') {
    try {
      const parsed = JSON.parse(p.data) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      } else if (Array.isArray(parsed)) {
        base = { items: parsed };
      }
    } catch {
      /* not JSON — the flat fields carry the chart */
    }
  } else if (p.data !== null && typeof p.data === 'object') {
    base = Array.isArray(p.data) ? { items: p.data } : { ...(p.data as Record<string, unknown>) };
  }
  const rawType = typeof p.type === 'string' ? p.type.trim() : '';
  let type = rawType.toLowerCase();
  let title = typeof p.title === 'string' ? p.title.trim() : '';
  // `chart "Units Sold by Year" bar` — the words in the other order.
  if (type !== '' && !TYPE_WORD.has(type.replace(/\s+chart$/, ''))) {
    if (title === '' || TYPE_WORD.has(title.toLowerCase())) {
      const swapped = title;
      title = rawType;
      type = swapped.toLowerCase();
    }
  }
  let values: unknown = jsonListIfAny(p.values);
  if (typeof values === 'string' && values.includes(':')) {
    // Several named series: "Revenue: 4, 5, 6; Cost: 3, 3, 4".
    const groups = values
      .split(/\s*;\s*|\n+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    values = groups.length > 1 ? groups : values;
  }
  const out: Record<string, unknown> = { ...base };
  if (type !== '') out.type = type;
  if (title !== '') out.title = title;
  if (p.labels !== undefined && p.labels !== '') out.labels = jsonListIfAny(p.labels);
  if (values !== undefined && values !== '') out.values = values;
  for (const key of ['subtitle', 'x_label', 'y_label', 'unit', 'highlight', 'note'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return out;
}

/** A scatter given numeric labels: the label IS the x. */
function withScatterX(spec: ChartSpec): ChartSpec {
  if (spec.type !== 'scatter') return spec;
  return {
    ...spec,
    series: spec.series.map((s) => ({
      ...s,
      points: s.points.map((pt) => {
        if (pt.x !== undefined) return pt;
        const x = Number(pt.label.replace(/[,\s]/g, ''));
        return Number.isFinite(x) ? { ...pt, x } : pt;
      }),
    })),
  };
}

/** The data, read back in one line so the model can check it against the ask. */
export function describeData(spec: ChartSpec): string {
  const lines = spec.series.map((s) => {
    const pts = s.points
      .map((pt) =>
        spec.type === 'scatter' && pt.x !== undefined
          ? `${pt.label !== '' ? `${pt.label} ` : ''}(${formatValue(pt.x)}, ${formatValue(pt.value, spec.unit)})`
          : `${pt.label} ${formatValue(pt.value, spec.unit)}`,
      )
      .join(', ');
    return spec.series.length > 1 && s.name !== '' ? `${s.name}: ${pts}` : pts;
  });
  return lines.join(' | ');
}

type Content = Array<{ type: 'text'; text: string }>;

function errorResult(text: string): { content: Content; isError: true; details: undefined } {
  return { content: [{ type: 'text', text }], isError: true, details: undefined };
}

function resolveOut(root: string, out: string | undefined, slug: string): string {
  if (out === undefined || out.trim() === '') return path.join(root, `${slug}.svg`);
  const trimmed = out.trim();
  const home = process.env.HOME;
  const expanded =
    trimmed.startsWith('~/') && home !== undefined ? path.join(home, trimmed.slice(2)) : trimmed;
  const abs = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
  if (abs.endsWith(CHART_SIDECAR_SUFFIX))
    return `${abs.slice(0, -CHART_SIDECAR_SUFFIX.length)}.svg`;
  if (/\.json$/i.test(abs)) return abs.replace(/\.json$/i, '.svg');
  if (/\.svg$/i.test(abs)) return abs;
  return `${abs}.svg`;
}

const TYPES_LINE =
  'bar (values by category), stacked (parts of each category), hbar (ranked names, long labels), line (a trend), area, scatter (x/y points), donut (shares of a whole)';

export function registerChartTool(pi: ExtensionAPI, deps: ChartToolDeps): void {
  pi.registerTool({
    name: CHART_TOOL,
    label: 'Chart',
    description:
      'Draw a data visual — bar, stacked, horizontal bar, line, area, scatter or donut — from the ' +
      'numbers, straight into the chat as an interactive card (hover reads the values, a chart/table ' +
      'toggle, Open in canvas). Every request to chart, plot, graph or visualise data goes here: ' +
      'sales by year, shares of a total, a trend, a comparison of two series. It draws in under a ' +
      'second from the labels and values you pass; put the real numbers in, never a summary of them. ' +
      'Never image generation for a chart (a painting cannot put a value on an axis), never ' +
      'matplotlib, never hand-written SVG, never a whole deck for one chart. It writes a .svg (and ' +
      'the spec beside it) into the project, so the same chart can go into a page or document.',
    promptSnippet: 'chart: an interactive chart of data in the chat (bar, line, donut, …)',
    promptGuidelines: [
      'A chart, plot or graph of numbers is the chart tool with the labels and values — it appears in the chat instantly; never image generation, matplotlib or hand-written SVG.',
      'After a chart, say ONE line of what it shows (the peak, the trend, the share) — the user is looking at the values, so do not list them again.',
    ],
    parameters: Type.Object({
      type: Type.Union(
        CHART_TYPES.map((t) => Type.Literal(t)),
        {
          description: `Which chart: ${TYPES_LINE}. Left out: bar (line for many points).`,
          cliOptional: true,
        },
      ),
      // Required, so `chart bar "Title"` fills it second — but `cliOptional`:
      // MEASURED, a 4B's first call carried the labels and values and no
      // title, and "missing --title" cost it a second call for a chart that
      // was drawable. An untitled chart is a chart.
      title: Type.String({
        description: 'The chart title, e.g. "Units Sold by Year".',
        cliOptional: true,
      }),
      labels: Type.Optional(
        Type.String({
          description:
            'The categories (x axis), comma-separated: "2021, 2022, 2023, 2024". For scatter, the x values.',
        }),
      ),
      values: Type.Optional(
        Type.String({
          description:
            'The values in the same order: "12, 19, 15, 22". Several series: "Revenue: 4.2, 5.1, 6.4; Cost: 3.1, 3.4, 3.9".',
        }),
      ),
      unit: Type.Optional(
        Type.String({ description: 'The unit of the values: "$", "%", "GW", "units".' }),
      ),
      subtitle: Type.Optional(
        Type.String({ description: 'A line under the title: the population, the period.' }),
      ),
      x_label: Type.Optional(Type.String({ description: 'Axis title for the categories.' })),
      y_label: Type.Optional(Type.String({ description: 'Axis title for the values.' })),
      highlight: Type.Optional(
        Type.String({
          description: 'One label to single out (its bar or slice takes the accent).',
        }),
      ),
      note: Type.Optional(
        Type.String({ description: 'A source line under the chart: "Source: Q3 report".' }),
      ),
      data: Type.Optional(
        Type.String({
          description:
            'Instead of labels/values: the whole spec as JSON — {"series":[{"name":"…","points":[{"label":"…","value":1}]}]}, or [{"label":"…","value":1}, …].',
        }),
      ),
      out: Type.Optional(
        Type.String({
          description:
            'Where to write the .svg, e.g. charts/units.svg. Relative paths land in the project. Default: named from the title, in the project.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as Record<string, unknown>;
      let spec: ChartSpec;
      try {
        spec = withScatterX(normalizeChartSpec(chartInputFromParams(p)));
      } catch (err) {
        return errorResult(
          `chart needs its data: ${err instanceof Error ? err.message : String(err)}. Pass --labels "A, B, C" --values "1, 2, 3" (several series: "Name: 1, 2; Other: 3, 4"), or --data with the JSON spec.`,
        );
      }
      const n = pointCount(spec);
      if (n === 0) return errorResult('chart needs at least one value.');
      const root = deps.root(ctx?.cwd);
      const svgPath = resolveOut(
        root,
        typeof p.out === 'string' ? p.out : undefined,
        chartSlug(spec.title, spec.type),
      );
      const specPath = `${svgPath.slice(0, -4)}${CHART_SIDECAR_SUFFIX}`;
      const write = deps.writeFileImpl ?? ((f, text) => writeFile(f, text, 'utf8'));
      try {
        await mkdir(path.dirname(svgPath), { recursive: true });
        // The spec first: the app reads it when the SVG is presented.
        await write(specPath, `${JSON.stringify(spec, null, 2)}\n`);
        await write(svgPath, chartToSvg(spec));
      } catch (err) {
        return errorResult(
          `chart could not write ${svgPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const what = `a ${spec.type} chart${spec.title !== '' ? ` "${spec.title}"` : ''} (${n} point${n === 1 ? '' : 's'}${spec.series.length > 1 ? `, ${spec.series.length} series` : ''})`;
      let shown = '';
      if (deps.bridge !== null) {
        const r = await deps.bridge.show({ path: svgPath, note: what });
        shown = r.ok
          ? ' It is in the chat as an interactive card (hover reads the values; chart/table toggle; Open in canvas).'
          : ` (it could not be shown in the chat: ${r.error ?? 'unknown'})`;
      }
      /*
       * THE REPLY IS ONE SENTENCE. MEASURED on a 4B: told "do not repeat the
       * numbers", it replied with a bulleted list of every value and then the
       * trend. The card already shows the values; what a person wants under
       * it is the reading — Claude's one line: "sales grew 11%…". Said first,
       * as the instruction, with the values named as the thing NOT to write.
       */
      const text = [
        `Drew ${what}: ${svgPath} (the spec beside it: ${path.basename(specPath)}).${shown}`,
        `Data: ${describeData(spec)}`,
        '',
        'Check that data against what the user asked for; if it is right, you are done. Your reply is ONE sentence saying what the chart shows — its peak, its trend, its share (e.g. "Sales climbed every year, peaking at 22 in 2024."). No list of the values, no description of the chart or the file: the card in front of the user has all of that. To change it, call chart again with the changed data (the same out overwrites).',
      ].join('\n');
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });
}

export type { ChartType };
