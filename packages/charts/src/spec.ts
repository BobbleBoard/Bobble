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

import { ChartDataError, parseNumber, parseNumberList } from './numbers.ts';
import { type ChartSize, chartSizeOf } from './sizes.ts';
import { type ChartStyle, normalizeStyle } from './style.ts';

export { formatValue } from './format.ts';

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
  /** Where the file is going: the canvas and type scale of the static SVG (sizes.ts). */
  readonly size?: ChartSize;
}

/** How strictly `normalizeChartSpec` reads what it was handed. */
export interface NormalizeOptions {
  /**
   * The chart TOOL's reading: a value that is not a number, a list that reads
   * two ways, or a series with a different count from the labels is an error
   * that names it (ChartDataError) — never a dropped token or a silent zero.
   * Off (the default), a card or a sidecar is read as forgivingly as before.
   */
  readonly strict?: boolean;
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
  return parseNumber(v)?.value ?? null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v);
}

/** A list read: its numbers, and the unit they were all written in (if one). */
interface ReadList {
  readonly values: number[];
  readonly unit?: string;
}

/**
 * "1, 2, 3" / "1 2 3" / "12k 19k" / "22M, 3,100" / "$1.2M, $2.4M" → numbers
 * (numbers.ts), counted against `expected` labels to tell a thousands comma
 * from a list comma. Strict: an unreadable token throws. Forgiving: it is
 * dropped, as it always was (a card must never throw for a sidecar's typo).
 */
function numberList(v: unknown, expected?: number, strict = false): ReadList {
  if (!Array.isArray(v) && typeof v !== 'string' && typeof v !== 'number') return { values: [] };
  try {
    return parseNumberList(v, expected);
  } catch (err) {
    if (strict) throw err;
    const parts = Array.isArray(v) ? v : String(v).split(/[,;\n]+|\s{2,}|\s(?=\d)/);
    return { values: parts.map(num).filter((n): n is number => n !== null) };
  }
}

/**
 * Labels: "2021, 2022" / "Q1;Q2" / a JSON list. When the list is written with
 * ", " between labels, a comma WITHOUT a space is part of a label ("1,000-2,000,
 * 2,000-3,000" is two ranges); written with bare commas, every comma separates.
 */
function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s) => s !== '');
  if (typeof v === 'string') {
    const sep = /,\s/.test(v) ? /\s*;\s*|\n+|,\s+/ : /[,;\n]+/;
    return v
      .split(sep)
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
function namedValues(
  v: string,
  expected?: number,
  strict = false,
): { name: string; values: number[]; unit?: string } {
  const m = /^\s*([^:]+?)\s*:\s*(.+)$/.exec(v);
  if (m !== null) {
    try {
      const read = numberList(m[2], expected, strict);
      if (read.values.length > 0) return { name: m[1] ?? '', ...read };
    } catch (err) {
      if (err instanceof ChartDataError) {
        throw new ChartDataError(`series "${(m[1] ?? '').trim()}": ${err.message}`);
      }
      throw err;
    }
  }
  return { name: '', ...numberList(v, expected, strict) };
}

/**
 * Turn whatever a model (or the office pipeline) wrote into a ChartSpec, or
 * throw a message that says what was missing. Accepts:
 *   - `series: [{ name, points: [{label, value}] }]` (the spec itself)
 *   - `labels` + `values` (a list, or "Name: 1,2,3" strings for several series)
 *   - `items` / `points` / `data` as points, pairs, or a label→value object
 *   - snake_case keys (x_label, y_label) and type aliases (pie, column, …)
 */
export function normalizeChartSpec(input: unknown, opts: NormalizeOptions = {}): ChartSpec {
  if (input === null || typeof input !== 'object') {
    throw new Error('a chart needs an object: type, title, and the data');
  }
  const strict = opts.strict === true;
  const o = input as Record<string, unknown>;
  const rawType = str(o.type ?? o.kind ?? o.chart ?? 'bar').toLowerCase();
  const type = TYPE_ALIASES[rawType] ?? TYPE_ALIASES[rawType.replace(/\s+chart$/, '')] ?? null;
  /** The unit the values were written in ("$1.2M" → "$"), when every series agrees. */
  let writtenUnit: string | undefined;

  let series: ChartSeries[] = [];
  if (Array.isArray(o.series) && o.series.length > 0) {
    for (const s of o.series) {
      if (s === null || typeof s !== 'object') continue;
      const so = s as Record<string, unknown>;
      let pts = pointsOf(so.points ?? so.items ?? so.data ?? so.values);
      // `values` (Chart.js: `data`) as a bare number list beside the spec's `labels`.
      const bare = Array.isArray(so.values) ? so.values : Array.isArray(so.data) ? so.data : null;
      // The labels as a list, or as the "April, May, June" string a CLI line gives.
      const labels = stringList(o.labels);
      if (pts.length === 0 && bare !== null && labels.length > 0) {
        const vals = numberList(bare, labels.length, strict).values;
        pts = labels.map((label, i) => ({ label, value: vals[i] ?? 0 }));
      }
      if (pts.length > 0) series.push({ name: str(so.name ?? so.label ?? ''), points: pts });
    }
  }
  if (series.length === 0) {
    const labels = stringList(o.labels ?? o.categories ?? o.x ?? o.xs);
    const valuesRaw = o.values ?? o.numbers ?? o.numbers_data ?? o.y ?? o.ys ?? o.data_values;
    if (labels.length > 0 && valuesRaw !== undefined) {
      const n = labels.length;
      const groups: { name: string; values: number[]; unit?: string }[] = [];
      if (
        Array.isArray(valuesRaw) &&
        valuesRaw.every((x) => typeof x === 'string' && /:/.test(x))
      ) {
        for (const s of valuesRaw) groups.push(namedValues(s as string, n, strict));
      } else if (Array.isArray(valuesRaw) && valuesRaw.every((x) => Array.isArray(x))) {
        (valuesRaw as unknown[][]).forEach((vals, i) => {
          groups.push({ name: `Series ${i + 1}`, ...numberList(vals, n, strict) });
        });
      } else if (
        typeof valuesRaw === 'string' &&
        /:/.test(valuesRaw) &&
        !/^\s*[-+(\u2212]?[$€£¥]?[\d.]/.test(valuesRaw)
      ) {
        groups.push(namedValues(valuesRaw, n, strict));
      } else {
        // One unnamed series: the y-axis title names it, when there is one.
        // (Not the unit — "19 units · units" in a tooltip reads as a stutter.)
        groups.push({
          name: str(o.yLabel ?? o.y_label ?? ''),
          ...numberList(valuesRaw, n, strict),
        });
      }
      if (strict) {
        // One value per label, or the chart would draw zeros (or lose values)
        // the model never wrote — say which series and what it was given.
        for (const g of groups) {
          if (g.values.length === n || g.values.length === 0) continue;
          const who = g.name !== '' ? `series "${g.name}" has` : 'the values have';
          throw new ChartDataError(
            `${who} ${g.values.length} number${g.values.length === 1 ? '' : 's'} but there ${n === 1 ? 'is 1 label' : `are ${n} labels`} (${labels.join(', ')}): give one value per label`,
          );
        }
      }
      const units = new Set(groups.map((g) => g.unit ?? ''));
      const only = units.size === 1 ? [...units][0] : undefined;
      if (only !== undefined && only !== '') writtenUnit = only;
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
  const size = chartSizeOf(o.size);
  // A unit said outright wins; else the one every value was written in ("$1.2M").
  const unit = str(o.unit) !== '' ? str(o.unit) : writtenUnit;
  return {
    type: resolvedType,
    title: str(o.title ?? o.name ?? ''),
    ...(str(o.subtitle) !== '' ? { subtitle: str(o.subtitle) } : {}),
    ...(str(o.xLabel ?? o.x_label) !== '' ? { xLabel: str(o.xLabel ?? o.x_label) } : {}),
    ...(str(o.yLabel ?? o.y_label) !== '' ? { yLabel: str(o.yLabel ?? o.y_label) } : {}),
    series,
    ...(highlight !== '' ? { highlight } : {}),
    ...(str(o.note ?? o.source) !== '' ? { note: str(o.note ?? o.source) } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(size !== undefined ? { size } : {}),
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
