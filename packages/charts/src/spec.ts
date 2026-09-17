/**
 * The chart model — what a data visual IS, independent of who draws it.
 *
 * the user (2026-09-16), with Claude's inline chart beside Bobble's: "we need
 * parity on these datavisuals, it's a common use case and very formulaic and
 * doable … not just bar charts, all datavisuals". One spec, three readers: the
 * `chart` tool writes it (and a static SVG beside it), the chat renders it as
 * an interactive card, the canvas renders the same card larger. The office
 * pipeline's chart kind writes the same shape (tools/office-gen/chart_render.py
 * reads it), so a chart made for a deck and a chart made for the chat are one
 * thing.
 *
 * `normalizeChartSpec` is deliberately forgiving: a 4B writes `labels` +
 * `values`, or `[["2021", 12], …]`, or `items: [{label, value}]`, or
 * `numbers_data` — MEASURED, all four in one afternoon — and every one of them
 * is the same four bars.
 */

import { type ChartStyle, normalizeStyle } from './style.ts';

export type ChartType =
  | 'bar'
  | 'stacked'
  | 'hbar'
  | 'line'
  | 'area'
  | 'scatter'
  | 'donut'
  | 'pie'
  | 'radar';

export const CHART_TYPES: readonly ChartType[] = [
  'bar',
  'stacked',
  'hbar',
  'line',
  'area',
  'scatter',
  'donut',
  'pie',
  'radar',
];

export interface ChartPoint {
  /** The category / x label. */
  readonly label: string;
  /** The value (y). */
  readonly value: number;
  /** Numeric x for scatter charts; the label is then a name for the tooltip. */
  readonly x?: number;
}

export interface ChartSeries {
  readonly name: string;
  readonly points: readonly ChartPoint[];
}

export interface ChartSpec {
  readonly type: ChartType;
  readonly title: string;
  readonly subtitle?: string;
  readonly xLabel?: string;
  readonly yLabel?: string;
  readonly series: readonly ChartSeries[];
  /** A label to single out (its bar/point/slice takes the accent). */
  readonly highlight?: string;
  /** A source line under the chart. */
  readonly note?: string;
  /** Value prefix/suffix for tooltips and axes: "$", "%", "GW". */
  readonly unit?: string;
  /** How it looks — a named look and/or its own knobs (style.ts). */
  readonly style?: ChartStyle;
}

const TYPE_ALIASES: Readonly<Record<string, ChartType>> = {
  bar: 'bar',
  bars: 'bar',
  column: 'bar',
  columns: 'bar',
  grouped: 'bar',
  stacked: 'stacked',
  'stacked-bar': 'stacked',
  stack: 'stacked',
  hbar: 'hbar',
  horizontal: 'hbar',
  'horizontal-bar': 'hbar',
  ranked: 'hbar',
  line: 'line',
  lines: 'line',
  trend: 'line',
  area: 'area',
  scatter: 'scatter',
  points: 'scatter',
  xy: 'scatter',
  donut: 'donut',
  doughnut: 'donut',
  ring: 'donut',
  // A pie is its own type — a donut with no hole — because the user asked for
  // pies that "expand smoothly", and the reading in the hole has nowhere to
  // go on one.
  pie: 'pie',
  // Several measures on spokes: strengths, ratings, a profile.
  radar: 'radar',
  spider: 'radar',
  web: 'radar',
  polar: 'radar',
};

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[,$%€£\s]/g, '').replace(/[kK]$/, '000');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v);
}

/** Split "1, 2, 3" / "1 2 3" / "12k 19k" into numbers; a list is passed through. */
function numberList(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(num).filter((n): n is number => n !== null);
  if (typeof v === 'string') {
    return v
      .split(/[,;\n]+|\s{2,}|\s(?=\d)/)
      .map((s) => num(s))
      .filter((n): n is number => n !== null);
  }
  return [];
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s) => s !== '');
  if (typeof v === 'string') {
    return v
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  return [];
}

/** `[{label, value}]`, `[[label, value]]`, `{label: value}` → points. */
function pointsOf(v: unknown): ChartPoint[] {
  if (Array.isArray(v)) {
    const out: ChartPoint[] = [];
    for (const p of v) {
      if (Array.isArray(p) && p.length >= 2) {
        const value = num(p[1]);
        if (value !== null) {
          const x = p.length >= 3 ? num(p[2]) : num(p[0]);
          out.push({ label: str(p[0]), value, ...(x !== null && p.length >= 3 ? { x } : {}) });
        }
      } else if (p !== null && typeof p === 'object') {
        const o = p as Record<string, unknown>;
        const value = num(o.value ?? o.y ?? o.count ?? o.amount ?? o.total);
        if (value === null) continue;
        const label = str(o.label ?? o.name ?? o.category ?? o.key ?? o.x ?? '');
        const x = num(o.x);
        out.push({
          label,
          value,
          ...(x !== null && typeof o.x !== 'string' ? { x } : {}),
        });
      }
    }
    return out;
  }
  if (v !== null && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([label, value]) => ({ label, value: num(value) }))
      .filter((p): p is ChartPoint => p.value !== null);
  }
  return [];
}

/** "Revenue: 4.2, 5.1, 6.4" → { name, values }; "4.2, 5.1" → { name: '', values }. */
function namedValues(v: string): { name: string; values: number[] } {
  const m = /^\s*([^:]+?)\s*:\s*(.+)$/.exec(v);
  if (m !== null && numberList(m[2]).length > 0) {
    return { name: m[1] ?? '', values: numberList(m[2]) };
  }
  return { name: '', values: numberList(v) };
}

/**
 * Turn whatever a model (or the office pipeline) wrote into a ChartSpec, or
 * throw a message that says what was missing. Accepts:
 *   - `series: [{ name, points: [{label, value}] }]` (the spec itself)
 *   - `labels` + `values` (a list, or "Name: 1,2,3" strings for several series)
 *   - `items` / `points` / `data` as points, pairs, or a label→value object
 *   - snake_case keys (x_label, y_label) and type aliases (pie, column, …)
 */
export function normalizeChartSpec(input: unknown): ChartSpec {
  if (input === null || typeof input !== 'object') {
    throw new Error('a chart needs an object: type, title, and the data');
  }
  const o = input as Record<string, unknown>;
  const rawType = str(o.type ?? o.kind ?? o.chart ?? 'bar').toLowerCase();
  const type = TYPE_ALIASES[rawType] ?? TYPE_ALIASES[rawType.replace(/\s+chart$/, '')] ?? null;

  let series: ChartSeries[] = [];
  if (Array.isArray(o.series) && o.series.length > 0) {
    for (const s of o.series) {
      if (s === null || typeof s !== 'object') continue;
      const so = s as Record<string, unknown>;
      let pts = pointsOf(so.points ?? so.items ?? so.data ?? so.values);
      // `values` as a bare number list beside the spec's `labels`.
      if (pts.length === 0 && Array.isArray(so.values) && Array.isArray(o.labels)) {
        const vals = numberList(so.values);
        pts = stringList(o.labels).map((label, i) => ({ label, value: vals[i] ?? 0 }));
      }
      if (pts.length > 0) series.push({ name: str(so.name ?? so.label ?? ''), points: pts });
    }
  }
  if (series.length === 0) {
    const labels = stringList(o.labels ?? o.categories ?? o.x ?? o.xs);
    const valuesRaw = o.values ?? o.numbers ?? o.numbers_data ?? o.y ?? o.ys ?? o.data_values;
    if (labels.length > 0 && valuesRaw !== undefined) {
      const groups: { name: string; values: number[] }[] = [];
      if (
        Array.isArray(valuesRaw) &&
        valuesRaw.every((x) => typeof x === 'string' && /:/.test(x))
      ) {
        for (const s of valuesRaw) groups.push(namedValues(s as string));
      } else if (Array.isArray(valuesRaw) && valuesRaw.every((x) => Array.isArray(x))) {
        (valuesRaw as unknown[][]).forEach((vals, i) => {
          groups.push({ name: `Series ${i + 1}`, values: numberList(vals) });
        });
      } else if (
        typeof valuesRaw === 'string' &&
        /:/.test(valuesRaw) &&
        !/^\s*[\d.]/.test(valuesRaw)
      ) {
        groups.push(namedValues(valuesRaw));
      } else {
        // One unnamed series: the y-axis title names it, when there is one.
        // (Not the unit — "19 units · units" in a tooltip reads as a stutter.)
        groups.push({
          name: str(o.yLabel ?? o.y_label ?? ''),
          values: numberList(valuesRaw),
        });
      }
      series = groups
        .filter((g) => g.values.length > 0)
        .map((g) => ({
          name: g.name,
          points: labels.map((label, i) => ({ label, value: g.values[i] ?? 0 })),
        }));
    }
  }
  if (series.length === 0) {
    const pts = pointsOf(o.items ?? o.points ?? o.data ?? o.rows ?? o.entries);
    if (pts.length > 0) series = [{ name: str(o.yLabel ?? o.y_label ?? ''), points: pts }];
  }
  if (series.length === 0) {
    throw new Error(
      'a chart needs its data: labels with values ("labels": ["2021", …], "values": [12, …]) or series of points',
    );
  }
  const resolvedType: ChartType =
    type ??
    (series.length === 1 && series[0] !== undefined && series[0].points.length > 12
      ? 'line'
      : 'bar');
  const highlight = str(o.highlight ?? o.emphasis ?? '');
  const style = normalizeStyle(o);
  return {
    type: resolvedType,
    title: str(o.title ?? o.name ?? ''),
    ...(str(o.subtitle) !== '' ? { subtitle: str(o.subtitle) } : {}),
    ...(str(o.xLabel ?? o.x_label) !== '' ? { xLabel: str(o.xLabel ?? o.x_label) } : {}),
    ...(str(o.yLabel ?? o.y_label) !== '' ? { yLabel: str(o.yLabel ?? o.y_label) } : {}),
    series,
    ...(highlight !== '' ? { highlight } : {}),
    ...(str(o.note ?? o.source) !== '' ? { note: str(o.note ?? o.source) } : {}),
    ...(str(o.unit) !== '' ? { unit: str(o.unit) } : {}),
    ...(style !== undefined ? { style } : {}),
  };
}

/** Every point across the series, for sizing decisions. */
export function pointCount(spec: ChartSpec): number {
  return spec.series.reduce((n, s) => n + s.points.length, 0);
}

/** The labels of the first series — the x axis of a categorical chart. */
export function categoryLabels(spec: ChartSpec): readonly string[] {
  return spec.series[0]?.points.map((p) => p.label) ?? [];
}

/** A value with the spec's unit: "$4.2M"-style prefixes, "%"/"GW" suffixes. */
export function formatValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  let body: string;
  if (Number.isInteger(value)) body = value.toLocaleString('en-US');
  else if (abs >= 100) body = value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  else if (abs >= 10) body = value.toLocaleString('en-US', { maximumFractionDigits: 1 });
  else body = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (unit === undefined || unit === '') return body;
  if (/^[$€£¥]$/.test(unit)) return `${unit}${body}`;
  if (unit === '%') return `${body}%`;
  return `${body} ${unit}`;
}
