/**
 * THE FORMS A CHART CANNOT TAKE, AND WHAT IT TAKES INSTEAD (VQ-02).
 *
 * REAL, from the user's "demo all your dataviz skills" session: a scatter of four
 * categories named X, Y, Z and W drew every point at x = 0 on an axis from 0 to
 * 0.2, and "Product Mix" — four shares adding up to 100% — was asked for as a
 * stack of ONE series, which draws as plain bars. Neither is the model being
 * wrong about its data; both are forms that cannot show it. The tool draws the
 * form that can, and says so in one line, so the model can repeat it to the
 * user or change it.
 *
 * And an untitled chart gets a title from its own data (never invented words),
 * so twelve untitled charts are twelve differently named files, not one file
 * drawn over twelve times.
 */

import type { ChartSpec, ChartType } from './spec.ts';

export interface Coerced {
  readonly spec: ChartSpec;
  /** One line per change, in the tool's voice: "drawn as bars instead: …". */
  readonly notes: readonly string[];
}

const quoteList = (xs: readonly string[], max = 4): string => {
  const shown = xs.slice(0, max).map((x) => `"${x}"`);
  const more = xs.length > max ? ` and ${xs.length - max} more` : '';
  return shown.length <= 1
    ? `${shown.join('')}${more}`
    : `${shown.slice(0, -1).join(', ')}${more === '' ? ' and ' : ', '}${shown.at(-1)}${more}`;
};

function as(spec: ChartSpec, type: ChartType): ChartSpec {
  return { ...spec, type };
}

/**
 * A chart in a form that can show its data. Pure; a spec that is fine comes
 * back as it went in, with no notes.
 */
export function coerceChartForm(spec: ChartSpec): Coerced {
  const notes: string[] = [];
  let out = spec;
  const points = spec.series.flatMap((s) => s.points);

  // A scatter needs a number for x on every point.
  if (spec.type === 'scatter' && points.some((p) => p.x === undefined)) {
    const named = [...new Set(points.filter((p) => p.x === undefined).map((p) => p.label))];
    out = as(out, 'bar');
    notes.push(
      `drawn as bars instead: a scatter needs a number for x on every point, and ${quoteList(named)} ${named.length === 1 ? 'is a name' : 'are names'}`,
    );
  }

  // A stack of one series is plain bars; shares of a whole are a donut.
  if (out.type === 'stacked' && out.series.length === 1) {
    const vals = out.series[0]?.points.map((p) => p.value) ?? [];
    const total = vals.reduce((n, v) => n + v, 0);
    const shares =
      vals.length >= 2 &&
      vals.every((v) => v >= 0) &&
      (out.unit === '%' || Math.abs(total - 100) <= 2 || Math.abs(total - 1) <= 0.02);
    if (shares) {
      out = as(out, 'donut');
      notes.push(
        `drawn as a donut instead: one series of shares adding up to ${Math.abs(total - 1) <= 0.02 ? '1' : '100'} is parts of a whole, and a stack needs two or more series`,
      );
    } else {
      out = as(out, 'bar');
      notes.push('drawn as bars instead: a stack needs two or more series, and this has one');
    }
  }

  // A donut or a pie shows one series of positive parts.
  if (out.type === 'donut' || out.type === 'pie') {
    const word = out.type;
    if (out.series.length > 1) {
      notes.push(
        `drawn as grouped bars instead: a ${word} shows one series, and this has ${out.series.length}`,
      );
      out = as(out, 'bar');
    } else if (points.some((p) => p.value < 0)) {
      notes.push(`drawn as bars instead: a ${word} cannot show a negative value`);
      out = as(out, 'bar');
    }
  }

  // A radar needs three spokes to be a shape.
  if (out.type === 'radar' && (out.series[0]?.points.length ?? 0) < 3) {
    notes.push('drawn as bars instead: a radar needs at least three measures');
    out = as(out, 'bar');
  }

  // A line needs two points to be a line.
  if ((out.type === 'line' || out.type === 'area') && (out.series[0]?.points.length ?? 0) < 2) {
    notes.push(`drawn as a bar instead: a ${out.type} needs two or more points`);
    out = as(out, 'bar');
  }

  return { spec: out, notes };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Whether labels read as a run (years, quarters, months, numbers) — said as "first–last". */
function isRun(labels: readonly string[]): boolean {
  if (labels.length < 2) return false;
  const all = (re: RegExp): boolean => labels.every((l) => re.test(l.trim()));
  if (all(/^\d{4}$/)) return true; // 2020, 2021, …
  if (all(/^(?:Q[1-4]|H[12])(?:\s*(?:'|20)?\d{2,4})?$/i)) return true; // Q1, Q2 2025, H1
  if (all(/^(?:FY\s*)?'?\d{2,4}$/i)) return true;
  if (labels.every((l) => MONTHS.includes(l.trim().slice(0, 3).toLowerCase()))) return true;
  if (all(/^(?:week|wk|day|month|year|w|d)\s*\d+$/i)) return true;
  return all(/^-?\d+(?:\.\d+)?$/);
}

/**
 * A title from the chart's own data, for a chart that came without one:
 * several series by name ("Revenue and Costs"), a run of labels as a range
 * ("Q1–Q4", "2020–2024"), a few categories by name ("Engineering, Design and
 * Product") — words already in the call, nothing made up. Empty when there is
 * nothing to name it by.
 */
export function titleFromData(spec: ChartSpec): string {
  const names = spec.series.map((s) => s.name).filter((n) => n !== '');
  if (spec.series.length > 1 && names.length === spec.series.length) {
    return names.length <= 3
      ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
      : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  }
  const labels = spec.series[0]?.points.map((p) => p.label).filter((l) => l !== '') ?? [];
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0] as string;
  if (isRun(labels)) return `${labels[0]}–${labels.at(-1)}`;
  if (labels.length <= 3) return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  return `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`;
}
