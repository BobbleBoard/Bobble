/**
 * Layout: a ChartSpec at a size → the shapes to draw.
 *
 * Both renderers read this — the static SVG the tool writes beside the spec,
 * and the interactive card the chat and canvas show — so a bar is in the same
 * place on disk and on screen, and the hover band the card draws is the band
 * the layout computed. No DOM, no colours beyond an index into a palette.
 */

import { type ChartSpec, categoryLabels, formatValue } from './spec.ts';
import { areaPath, linePath, type ResolvedStyle, resolveStyle } from './style.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Tick {
  readonly value: number;
  /** Pixel position along the value axis (y for vertical charts, x for hbar). */
  readonly at: number;
  readonly label: string;
}

export interface Category {
  readonly index: number;
  readonly label: string;
  /** Centre along the category axis. */
  readonly at: number;
  /** The hover band around the category (x/w for vertical, y/h for hbar). */
  readonly band: Rect;
}

export interface BarShape extends Rect {
  readonly series: number;
  readonly point: number;
  readonly label: string;
  readonly value: number;
  readonly highlighted: boolean;
  /** The side that faces away from the axis — the one that gets the rounding. */
  readonly side: 'top' | 'bottom' | 'right' | 'left';
  /** Whether that side is the outer edge (a stacked segment under another is not). */
  readonly outer: boolean;
}

export interface MarkerShape {
  readonly x: number;
  readonly y: number;
  readonly series: number;
  readonly point: number;
  readonly label: string;
  readonly value: number;
  readonly highlighted: boolean;
}

export interface LineShape {
  readonly series: number;
  /** SVG path data for the line. */
  readonly d: string;
  /** …and for the filled area under it (area charts). */
  readonly area: string;
  readonly markers: readonly MarkerShape[];
}

export interface SliceShape {
  readonly point: number;
  readonly d: string;
  readonly label: string;
  readonly value: number;
  readonly fraction: number;
  readonly highlighted: boolean;
  /** Where a label/leader would sit (unit vector from the centre). */
  readonly midAngle: number;
}

export interface LegendEntry {
  readonly series: number;
  readonly name: string;
}

export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  /** The plotting area (inside axes and labels). */
  readonly plot: Rect;
  /** Value-axis ticks (gridlines). */
  readonly ticks: readonly Tick[];
  readonly categories: readonly Category[];
  readonly bars: readonly BarShape[];
  readonly lines: readonly LineShape[];
  readonly scatter: readonly MarkerShape[];
  readonly slices: readonly SliceShape[];
  readonly legend: readonly LegendEntry[];
  /** Donut geometry, when a donut. */
  readonly donut?: {
    readonly cx: number;
    readonly cy: number;
    readonly r: number;
    readonly ring: number;
    readonly total: number;
    /**
     * What the hole says: the total with its unit — or, when the values are
     * already shares ("%"), the total is 100 by construction and says nothing,
     * so the leading slice (the highlighted one, else the largest) reads out.
     */
    readonly centre: { readonly big: string; readonly small: string };
  };
  /** Scatter x-axis ticks. */
  readonly xTicks: readonly Tick[];
  /** Where the value axis' zero line sits. */
  readonly zero: number;
}

export interface LayoutOptions {
  readonly width: number;
  readonly height: number;
  /** Space reserved above the plot for a title/subtitle drawn by the caller. */
  readonly top?: number;
  /** Space reserved below the plot for a note. */
  readonly bottom?: number;
  /** Compact layouts drop the axis titles' reserved space. */
  readonly compact?: boolean;
  /** The resolved look: bar width, line style, ring thickness. Default: the spec's own. */
  readonly style?: ResolvedStyle;
}

/** A pleasant tick step for a span: 1, 2, 2.5, 5 × 10^k. */
export function niceStep(span: number, ticks = 5): number {
  if (!(span > 0)) return 1;
  const raw = span / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

interface ValueScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

function valueScale(values: readonly number[], stacked = false): ValueScale {
  const vmax = Math.max(0, ...values);
  const vmin = Math.min(0, ...values);
  const step = niceStep(vmax - vmin || 1);
  const max = vmax > 0 ? Math.ceil((vmax + (stacked ? 0 : 0)) / step) * step : step;
  const min = vmin < 0 ? Math.floor(vmin / step) * step : 0;
  return { min, max, step };
}

function ticksFor(
  scale: ValueScale,
  unit: string | undefined,
  toPx: (v: number) => number,
): Tick[] {
  const out: Tick[] = [];
  for (let v = scale.min; v <= scale.max + 1e-9; v += scale.step) {
    const value = Math.abs(v) < 1e-9 ? 0 : v;
    out.push({ value, at: toPx(value), label: formatValue(value, unit === '%' ? '%' : undefined) });
  }
  return out;
}

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Compute every shape for `spec` at the given size. */
export function layoutChart(spec: ChartSpec, opts: LayoutOptions): ChartLayout {
  const { width, height } = opts;
  const style = opts.style ?? resolveStyle(spec.style);
  const compact = opts.compact === true;
  const top = opts.top ?? 0;
  const bottom = opts.bottom ?? 0;
  const unit = spec.unit;
  const isHorizontal = spec.type === 'hbar';
  const isDonut = spec.type === 'donut';
  const isScatter = spec.type === 'scatter';
  const legend: LegendEntry[] =
    spec.series.length > 1
      ? spec.series.map((s, i) => ({ series: i, name: s.name || `Series ${i + 1}` }))
      : [];
  const legendH = legend.length > 0 ? 22 : 0;
  const empty: ChartLayout = {
    width,
    height,
    plot: { x: 0, y: 0, w: width, h: height },
    ticks: [],
    categories: [],
    bars: [],
    lines: [],
    scatter: [],
    slices: [],
    legend,
    xTicks: [],
    zero: 0,
  };

  if (isDonut) {
    const s0 = spec.series[0];
    const pts = (s0?.points ?? []).filter((p) => p.value > 0);
    const total = pts.reduce((n, p) => n + p.value, 0) || 1;
    const legendRows = pts.length;
    const plotY = top + 8;
    const plotH = Math.max(80, height - plotY - bottom - 8);
    // The ring on the left, a legend column on the right.
    const r = Math.min(plotH / 2 - 4, width * 0.22);
    const cx = Math.max(r + 12, width * 0.28);
    const cy = plotY + plotH / 2;
    const ring = r * style.ring;
    let a0 = -Math.PI / 2;
    const slices: SliceShape[] = pts.map((p, i) => {
      const fraction = p.value / total;
      const a1 = a0 + fraction * 2 * Math.PI;
      const large = fraction > 0.5 ? 1 : 0;
      const ri = r - ring;
      const [x0, y0] = polar(cx, cy, r, a0);
      const [x1, y1] = polar(cx, cy, r, a1);
      const [xi0, yi0] = polar(cx, cy, ri, a1);
      const [xi1, yi1] = polar(cx, cy, ri, a0);
      const d =
        fraction >= 0.999
          ? `M${fmt(cx + r)} ${fmt(cy)} A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx - r)} ${fmt(cy)} A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx + r)} ${fmt(cy)} M${fmt(cx + ri)} ${fmt(cy)} A${fmt(ri)} ${fmt(ri)} 0 1 0 ${fmt(cx - ri)} ${fmt(cy)} A${fmt(ri)} ${fmt(ri)} 0 1 0 ${fmt(cx + ri)} ${fmt(cy)} Z`
          : `M${fmt(x0)} ${fmt(y0)} A${fmt(r)} ${fmt(r)} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)} L${fmt(xi0)} ${fmt(yi0)} A${fmt(ri)} ${fmt(ri)} 0 ${large} 0 ${fmt(xi1)} ${fmt(yi1)} Z`;
      const mid = (a0 + a1) / 2;
      a0 = a1;
      return {
        point: i,
        d,
        label: p.label,
        value: p.value,
        fraction,
        highlighted: spec.highlight !== undefined && p.label === spec.highlight,
        midAngle: mid,
      };
    });
    return {
      ...empty,
      plot: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r },
      slices,
      donut: { cx, cy, r, ring, total, centre: donutCentre(spec, slices, total) },
      legend: pts.map((p, i) => ({ series: i, name: p.label })),
      // The legend column starts at the ring's right; rows are `legendRows`.
      categories: pts.map((p, i) => ({
        index: i,
        label: p.label,
        at: cx + r + 28,
        band: {
          x: cx + r + 20,
          y: plotY + i * Math.min(30, plotH / Math.max(legendRows, 1)),
          w: width - (cx + r + 20),
          h: Math.min(30, plotH / Math.max(legendRows, 1)),
        },
      })),
    };
  }

  const labels = categoryLabels(spec);
  const allValues = spec.series.flatMap((s) => s.points.map((p) => p.value));
  const stackedTotals =
    spec.type === 'stacked'
      ? labels.map((_l, i) =>
          spec.series.reduce((n, s) => n + Math.max(0, s.points[i]?.value ?? 0), 0),
        )
      : [];
  const scale = valueScale(spec.type === 'stacked' ? stackedTotals : allValues);

  if (isHorizontal) {
    const labelW = Math.min(width * 0.38, 16 + 6.4 * Math.max(4, ...labels.map((l) => l.length)));
    const plot: Rect = {
      x: labelW + 8,
      y: top + legendH + 6,
      w: width - labelW - 8 - 56,
      h: Math.max(40, height - top - legendH - 6 - bottom - (spec.xLabel && !compact ? 22 : 8)),
    };
    const toPx = (v: number): number =>
      plot.x + ((v - scale.min) / (scale.max - scale.min)) * plot.w;
    const ticks = ticksFor(scale, unit, toPx);
    const zero = toPx(0);
    const row = plot.h / Math.max(labels.length, 1);
    const groupH = row * Math.min(0.9, style.barWidth + 0.1);
    const barH = groupH / Math.max(spec.series.length, 1);
    const bars: BarShape[] = [];
    const categories: Category[] = labels.map((label, i) => ({
      index: i,
      label,
      at: plot.y + i * row + row / 2,
      band: { x: 0, y: plot.y + i * row, w: width, h: row },
    }));
    spec.series.forEach((s, si) => {
      s.points.forEach((p, pi) => {
        if (pi >= labels.length) return;
        const slotH = Math.max(barH - 2, 2);
        const h = style.maxBarPx !== null ? Math.min(slotH, style.maxBarPx) : slotH;
        const y = plot.y + pi * row + (row - groupH) / 2 + si * barH + (slotH - h) / 2;
        const x0 = Math.min(zero, toPx(p.value));
        const w = Math.abs(toPx(p.value) - zero);
        bars.push({
          x: x0,
          y,
          w: Math.max(w, 1),
          h,
          series: si,
          point: pi,
          label: p.label,
          value: p.value,
          highlighted: spec.highlight !== undefined && p.label === spec.highlight,
          side: p.value >= 0 ? 'right' : 'left',
          outer: true,
        });
      });
    });
    return { ...empty, plot, ticks, categories, bars, zero };
  }

  // Vertical charts: bar / stacked / line / area / scatter.
  const yAxisW = 14 + 7 * Math.max(...ticksFor(scale, unit, () => 0).map((t) => t.label.length), 2);
  const plot: Rect = {
    x: (spec.yLabel && !compact ? 18 : 0) + yAxisW,
    y: top + legendH + 8,
    w: Math.max(60, width - ((spec.yLabel && !compact ? 18 : 0) + yAxisW) - 12),
    h: Math.max(60, height - top - legendH - 8 - bottom - 22 - (spec.xLabel && !compact ? 18 : 0)),
  };
  const toY = (v: number): number =>
    plot.y + plot.h - ((v - scale.min) / (scale.max - scale.min)) * plot.h;
  const ticks = ticksFor(scale, unit, toY);
  const zero = toY(0);

  if (isScatter) {
    const xs = spec.series.flatMap((s) => s.points.map((p) => p.x ?? 0));
    const xScale = valueScale(xs);
    const toX = (v: number): number =>
      plot.x + ((v - xScale.min) / (xScale.max - xScale.min)) * plot.w;
    const xTicks = ticksFor(xScale, undefined, toX);
    const scatter: MarkerShape[] = [];
    spec.series.forEach((s, si) => {
      s.points.forEach((p, pi) => {
        scatter.push({
          x: toX(p.x ?? 0),
          y: toY(p.value),
          series: si,
          point: pi,
          label: p.label,
          value: p.value,
          highlighted: spec.highlight !== undefined && p.label === spec.highlight,
        });
      });
    });
    return { ...empty, plot, ticks, xTicks, scatter, zero };
  }

  const n = Math.max(labels.length, 1);
  const bandW = plot.w / n;
  const categories: Category[] = labels.map((label, i) => ({
    index: i,
    label,
    at: plot.x + i * bandW + bandW / 2,
    band: { x: plot.x + i * bandW, y: plot.y, w: bandW, h: plot.h },
  }));

  if (spec.type === 'bar' || spec.type === 'stacked') {
    const bars: BarShape[] = [];
    const gap = bandW * (1 - (n > 8 ? Math.min(0.85, style.barWidth + 0.1) : style.barWidth));
    const groupW = bandW - gap;
    const perSeries = spec.type === 'stacked' ? groupW : groupW / Math.max(spec.series.length, 1);
    // A pill look's bars are capped in px and centred in their slot.
    const slotW = Math.max(perSeries - (spec.series.length > 1 ? 2 : 0), 2);
    const barW = style.maxBarPx !== null ? Math.min(slotW, style.maxBarPx) : slotW;
    const stackW = style.maxBarPx !== null ? Math.min(groupW, style.maxBarPx * 1.6) : groupW;
    const stackTop = labels.map(() => 0);
    const stackBottom = labels.map(() => 0);
    spec.series.forEach((s, si) => {
      s.points.forEach((p, pi) => {
        if (pi >= labels.length) return;
        const gx = plot.x + pi * bandW + gap / 2;
        if (spec.type === 'stacked') {
          const from = p.value >= 0 ? (stackTop[pi] ?? 0) : (stackBottom[pi] ?? 0);
          const to = from + p.value;
          if (p.value >= 0) stackTop[pi] = to;
          else stackBottom[pi] = to;
          const y1 = toY(Math.max(from, to));
          const y2 = toY(Math.min(from, to));
          bars.push({
            x: gx + (groupW - Math.max(stackW, 2)) / 2,
            y: y1,
            w: Math.max(stackW, 2),
            h: Math.max(y2 - y1, 0.5),
            series: si,
            point: pi,
            label: p.label,
            value: p.value,
            highlighted: spec.highlight !== undefined && p.label === spec.highlight,
            side: p.value >= 0 ? 'top' : 'bottom',
            // The outermost segment of the stack in this direction: none of the
            // later series adds to it.
            outer: !spec.series
              .slice(si + 1)
              .some((later) => (later.points[pi]?.value ?? 0) * (p.value >= 0 ? 1 : -1) > 0),
          });
        } else {
          const x = gx + si * perSeries + (slotW - barW) / 2;
          const y1 = toY(Math.max(0, p.value));
          const y2 = toY(Math.min(0, p.value));
          bars.push({
            x,
            y: y1,
            w: barW,
            h: Math.max(y2 - y1, 1),
            series: si,
            point: pi,
            label: p.label,
            value: p.value,
            highlighted: spec.highlight !== undefined && p.label === spec.highlight,
            side: p.value >= 0 ? 'top' : 'bottom',
            outer: true,
          });
        }
      });
    });
    return { ...empty, plot, ticks, categories, bars, zero };
  }

  // line / area
  const lines: LineShape[] = spec.series.map((s, si) => {
    const markers: MarkerShape[] = s.points.slice(0, labels.length).map((p, pi) => ({
      x: plot.x + pi * bandW + bandW / 2,
      y: toY(p.value),
      series: si,
      point: pi,
      label: p.label,
      value: p.value,
      highlighted: spec.highlight !== undefined && p.label === spec.highlight,
    }));
    const d = linePath(markers, style.line);
    const area = markers.length > 0 ? areaPath(markers, style.line, zero) : '';
    return { series: si, d, area, markers };
  });
  return { ...empty, plot, ticks, categories, lines, zero };
}

/** The donut hole's reading — see `ChartLayout.donut.centre`. */
function donutCentre(
  spec: ChartSpec,
  slices: readonly SliceShape[],
  total: number,
): { big: string; small: string } {
  if (spec.unit === '%' && slices.length > 0) {
    const lead =
      slices.find((s) => s.highlighted) ??
      slices.reduce((best, s) => (s.value > best.value ? s : best), slices[0] as SliceShape);
    return { big: formatValue(lead.value, '%'), small: lead.label };
  }
  return { big: formatValue(total, spec.unit), small: 'total' };
}
