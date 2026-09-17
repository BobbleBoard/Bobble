/**
 * The chart as MEASURED ELEMENTS — what the office pipeline turns into native
 * shapes in a deck, a document or a PDF.
 *
 * the user (2026-09-16): "ensure these can be embedded into docs or charts or
 * whatever, that's mainly the use case, say you put a pdf in and ask the
 * model to slot a chart in with the data on the second page".
 *
 * tools/office-gen's html2pptx / html2docx / html2pdf take one record per
 * visible element as a browser would measure it (`getBoundingClientRect` +
 * computed style: tag, x, y, w, h, bg, color, radius, fontSize, text, points…)
 * and emit one NATIVE, editable shape per record — a rectangle is a rectangle,
 * a label is text, a line is a freeform. This module produces that record
 * list straight from the chart's layout, so no browser runs, and a chart
 * dropped into a slide is the same shapes the card shows, in the deck's own
 * units, still editable in PowerPoint.
 *
 * Coordinates are the chart's own pixels (0..width, 0..height); the pipeline
 * scales them into whatever box it is given. Curves arrive as sampled
 * polylines (identical geometry in every format); a fixed-ground look brings
 * its ground as the first element, a theme-following look draws on the page.
 */

import { type ChartLayout, layoutChart } from './layout.ts';
import { type ChartSpec, formatValue } from './spec.ts';
import {
  barRadius,
  LIGHT_GROUND,
  type LineStyle,
  type LookName,
  linePath,
  type ResolvedStyle,
  resolveStyle,
} from './style.ts';
import { seriesColour } from './svg.ts';

/** One measured element, as the office pipeline's converters read it. */
export interface MeasuredElement {
  readonly tag: 'div' | 'span' | 'polyline' | 'polygon' | 'circle';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly bg?: string;
  readonly color?: string;
  readonly radius?: number;
  readonly fontSize?: number;
  readonly fontWeight?: string;
  readonly fontFamily?: string;
  readonly italic?: boolean;
  readonly align?: 'left' | 'center' | 'right';
  readonly text?: string;
  readonly points?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly fillC?: string;
  readonly cx?: number;
  readonly cy?: number;
  readonly rr?: number;
  readonly opacity?: string;
}

export interface ChartElements {
  readonly width: number;
  readonly height: number;
  /** The look the elements were drawn in. */
  readonly look: LookName;
  readonly elements: readonly MeasuredElement[];
}

export interface ElementsOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fallbackLook?: LookName;
}

const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "#RRGGBB" → "rgb(r, g, b)" — the form a computed style reports. */
export function cssRgb(hex: string): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/** A colour at an opacity over a paper, flattened — the converters have no alpha. */
export function over(hex: string, paper: string, alpha: number): string {
  const c = (s: string, i: number): number =>
    Number.parseInt(s.replace('#', '').slice(i, i + 2), 16);
  const mix = (i: number): number => Math.round(c(hex, i) * alpha + c(paper, i) * (1 - alpha));
  return `rgb(${mix(0)}, ${mix(2)}, ${mix(4)})`;
}

/**
 * The points of a line in the chosen style, sampled so a smooth curve becomes
 * a polyline the converters draw as-is (a monotone cubic sampled 12× per
 * segment is indistinguishable from the curve at slide size).
 */
export function linePoints(
  pts: readonly { x: number; y: number }[],
  style: LineStyle,
  samples = 12,
): { x: number; y: number }[] {
  if (pts.length < 2 || style === 'straight') return pts.map((p) => ({ x: p.x, y: p.y }));
  if (style === 'step') {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i] as { x: number; y: number };
      if (i > 0) {
        const a = pts[i - 1] as { x: number; y: number };
        const mx = (a.x + p.x) / 2;
        out.push({ x: mx, y: a.y }, { x: mx, y: p.y });
      }
      out.push({ x: p.x, y: p.y });
    }
    return out;
  }
  // Read the cubic segments back out of the path the renderers draw.
  const d = linePath(pts, 'smooth');
  const segs = d.split(/(?=C)/).slice(1);
  const out: { x: number; y: number }[] = [{ x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0 }];
  let prev = out[0] as { x: number; y: number };
  for (const seg of segs) {
    const n = seg.slice(1).trim().split(/\s+/).map(Number);
    const [x1, y1, x2, y2, x3, y3] = n as [number, number, number, number, number, number];
    for (let s = 1; s <= samples; s += 1) {
      const t = s / samples;
      const mt = 1 - t;
      const x = mt * mt * mt * prev.x + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
      const y = mt * mt * mt * prev.y + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
      out.push({ x, y });
    }
    prev = { x: x3, y: y3 };
  }
  return out;
}

function pointsAttr(pts: readonly { x: number; y: number }[]): string {
  return pts.map((p) => `${f(p.x)},${f(p.y)}`).join(' ');
}

function bbox(pts: readonly { x: number; y: number }[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** A text element: the box is where a browser would have laid the string. */
function label(
  x: number,
  baseline: number,
  text: string,
  size: number,
  colour: string,
  font: string,
  opts: { weight?: number; anchor?: 'start' | 'middle' | 'end' } = {},
): MeasuredElement | null {
  if (text === '') return null;
  // Generous on purpose: a box narrower than its string is what made the deck
  // viewer close up "Units Sold" into "UnitsSold" (SEEN, pptx title), while a
  // box wider than the string costs nothing — the anchor below places it, and
  // the converters align the text inside it the same way.
  const bold = (opts.weight ?? 400) >= 600;
  const w = Math.max(8, text.length * size * (bold ? 0.66 : 0.6) + size * 0.8 + 4);
  const h = size * 1.25;
  const anchor = opts.anchor ?? 'start';
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return {
    tag: 'span',
    x: left,
    y: baseline - size * 0.9,
    w,
    h,
    text,
    fontSize: size,
    fontWeight: String(opts.weight ?? 400),
    fontFamily: font,
    color: colour,
    align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
  };
}

/** Compute the chart's elements at a size (default 960×560, the file's). */
export function chartToElements(spec: ChartSpec, opts: ElementsOptions = {}): ChartElements {
  const width = opts.width ?? 960;
  const height = opts.height ?? 560;
  const style = resolveStyle(spec.style, opts.fallbackLook, { theme: 'light' });
  const ground = style.ground ?? LIGHT_GROUND;
  const out: MeasuredElement[] = [];
  const font = style.fontFamily;
  const pad = 32;
  if (style.ground !== null) {
    out.push({ tag: 'div', x: 0, y: 0, w: width, h: height, bg: cssRgb(ground.paper), radius: 14 });
  }
  let headY = pad;
  const push = (el: MeasuredElement | null): void => {
    if (el !== null) out.push(el);
  };
  if (spec.title !== '') {
    headY += 22;
    push(
      label(pad, headY, spec.title, 22, cssRgb(ground.ink), font, { weight: style.titleWeight }),
    );
  }
  if (spec.subtitle !== undefined) {
    headY += 20;
    push(label(pad, headY, spec.subtitle, 14, cssRgb(ground.mute), font));
  }
  const top = headY + (spec.title !== '' || spec.subtitle !== undefined ? 14 : 0);
  const bottom = spec.note !== undefined ? 22 : 0;
  const L = layoutChart(spec, {
    width: width - 2 * pad,
    height: height - top - pad - bottom,
    top: 0,
    bottom: 0,
    style,
  });
  const ox = pad;
  const oy = top;
  drawBody(spec, L, style, ground, ox, oy, out);
  if (spec.note !== undefined) {
    push(label(pad, height - 14, spec.note, 11.5, cssRgb(ground.mute), font));
  }
  return { width, height, look: style.look, elements: out };
}

function drawBody(
  spec: ChartSpec,
  L: ChartLayout,
  style: ResolvedStyle,
  ground: { paper: string; ink: string; mute: string; grid: string },
  ox: number,
  oy: number,
  out: MeasuredElement[],
): void {
  const font = style.fontFamily;
  const ink = cssRgb(ground.ink);
  const mute = cssRgb(ground.mute);
  const gridColour = cssRgb(ground.grid);
  const colour = (series: number, highlighted: boolean): string =>
    seriesColour(style, series, highlighted, spec.series.length);
  const push = (el: MeasuredElement | null): void => {
    if (el !== null) out.push(el);
  };
  const showValues = style.labels !== 'off';

  if (L.legend.length > 0 && L.donut === undefined) {
    let lx = L.plot.x;
    for (const e of L.legend) {
      out.push({
        tag: 'div',
        x: ox + lx,
        y: oy + L.plot.y - 24,
        w: 12,
        h: 12,
        bg: cssRgb(colour(e.series, false)),
        radius: style.radius === 0 ? 0 : 3,
      });
      push(label(ox + lx + 18, oy + L.plot.y - 14, e.name, 12, mute, font));
      lx += 18 + 7 * e.name.length + 22;
    }
  }

  if (L.radar !== undefined) {
    const R = L.radar;
    const ringPts = (k: number): { x: number; y: number }[] =>
      R.axes.map((ax) => ({
        x: ox + R.cx + R.r * k * Math.cos(ax.angle),
        y: oy + R.cy + R.r * k * Math.sin(ax.angle),
      }));
    for (const k of [0.25, 0.5, 0.75, 1]) {
      const pts = ringPts(k);
      if (pts.length < 2) continue;
      out.push({
        tag: 'polyline',
        ...bbox([...pts, pts[0] as { x: number; y: number }]),
        points: pointsAttr([...pts, pts[0] as { x: number; y: number }]),
        stroke: cssRgb(ground.grid),
        strokeWidth: 1,
      });
    }
    for (const ax of R.axes) {
      const pts = [
        { x: ox + R.cx, y: oy + R.cy },
        { x: ox + ax.x, y: oy + ax.y },
      ];
      out.push({
        tag: 'polyline',
        ...bbox(pts),
        points: pointsAttr(pts),
        stroke: cssRgb(ground.grid),
        strokeWidth: 1,
      });
      push(label(ox + ax.labelX, oy + ax.labelY, ax.label, 12, mute, font, { anchor: ax.anchor }));
    }
    for (const sh of R.shapes) {
      const c = colour(sh.series, false);
      const pts = sh.points.map((p) => ({ x: ox + p.x, y: oy + p.y }));
      if (pts.length > 2) {
        out.push({
          tag: 'polygon',
          ...bbox(pts),
          points: pointsAttr(pts),
          fillC: over(c, ground.paper, 0.18),
          stroke: cssRgb(c),
          strokeWidth: style.strokeWidth,
        });
      }
      for (const p of sh.points) {
        const rr = 3.5;
        out.push({
          tag: 'circle',
          x: ox + p.x - rr,
          y: oy + p.y - rr,
          w: 2 * rr,
          h: 2 * rr,
          cx: ox + p.x,
          cy: oy + p.y,
          rr,
          bg: cssRgb(p.highlighted ? style.accent : c),
          radius: rr,
        });
      }
    }
    return;
  }

  if (L.donut !== undefined) {
    const shades =
      spec.highlight !== undefined
        ? style.palette.filter((c) => c !== style.accent)
        : style.palette;
    const { cx, cy, r, ring } = L.donut;
    let a0 = -Math.PI / 2;
    for (const s of L.slices) {
      const a1 = a0 + s.fraction * 2 * Math.PI;
      const steps = Math.max(4, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 96));
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= steps; i += 1) {
        const a = a0 + ((a1 - a0) * i) / steps;
        pts.push({ x: ox + cx + r * Math.cos(a), y: oy + cy + r * Math.sin(a) });
      }
      for (let i = steps; i >= 0; i -= 1) {
        const a = a0 + ((a1 - a0) * i) / steps;
        pts.push({ x: ox + cx + (r - ring) * Math.cos(a), y: oy + cy + (r - ring) * Math.sin(a) });
      }
      a0 = a1;
      const fill = s.highlighted ? style.accent : (shades[s.point % shades.length] ?? ground.ink);
      out.push({
        tag: 'polygon',
        ...bbox(pts),
        points: pointsAttr(pts),
        fillC: cssRgb(fill),
        stroke: cssRgb(ground.paper),
        strokeWidth: 1.5,
      });
    }
    if (L.donut.centre.big !== '') {
      push(
        label(ox + cx, oy + cy + 8, L.donut.centre.big, 22, ink, font, {
          weight: style.titleWeight,
          anchor: 'middle',
        }),
      );
      push(
        label(ox + cx, oy + cy + 26, L.donut.centre.small, 11, mute, font, { anchor: 'middle' }),
      );
    }
    for (const c of L.categories) {
      const s = L.slices[c.index];
      if (s === undefined) continue;
      const fill = s.highlighted ? style.accent : (shades[s.point % shades.length] ?? ground.ink);
      const y = c.band.y + c.band.h / 2;
      out.push({
        tag: 'div',
        x: ox + c.band.x,
        y: oy + y - 6,
        w: 12,
        h: 12,
        bg: cssRgb(fill),
        radius: 3,
      });
      push(
        label(ox + c.band.x + 20, oy + y + 4, c.label, 13, ink, font, {
          weight: s.highlighted ? 600 : 400,
        }),
      );
      push(
        label(
          ox + L.width,
          oy + y + 4,
          spec.unit === '%'
            ? formatValue(s.value, '%')
            : `${formatValue(s.value, spec.unit)}  ·  ${Math.round(s.fraction * 100)}%`,
          12,
          mute,
          font,
          { anchor: 'end' },
        ),
      );
    }
    return;
  }

  const horizontal = spec.type === 'hbar';
  for (const tick of L.ticks) {
    const zero = tick.value === 0;
    const drawLine = style.grid !== 'none' || zero;
    if (horizontal) {
      if (drawLine) {
        out.push({
          tag: 'div',
          x: ox + tick.at,
          y: oy + L.plot.y,
          w: 1,
          h: L.plot.h,
          bg: zero ? mute : gridColour,
        });
      }
      push(
        label(ox + tick.at, oy + L.plot.y + L.plot.h + 16, tick.label, 11, mute, font, {
          anchor: 'middle',
        }),
      );
    } else {
      if (drawLine) {
        out.push({
          tag: 'div',
          x: ox + L.plot.x,
          y: oy + tick.at,
          w: L.plot.w,
          h: 1,
          bg: zero ? mute : gridColour,
        });
      }
      push(
        label(ox + L.plot.x - 8, oy + tick.at + 4, tick.label, 11, mute, font, { anchor: 'end' }),
      );
    }
  }
  for (const tick of L.xTicks) {
    if (style.grid !== 'none') {
      out.push({
        tag: 'div',
        x: ox + tick.at,
        y: oy + L.plot.y,
        w: 1,
        h: L.plot.h,
        bg: gridColour,
      });
    }
    push(
      label(ox + tick.at, oy + L.plot.y + L.plot.h + 16, tick.label, 11, mute, font, {
        anchor: 'middle',
      }),
    );
  }
  if (spec.type !== 'scatter') {
    for (const c of L.categories) {
      if (horizontal)
        push(label(ox + L.plot.x - 10, oy + c.at + 4, c.label, 12.5, ink, font, { anchor: 'end' }));
      else
        push(
          label(ox + c.at, oy + L.plot.y + L.plot.h + 17, c.label, 12, mute, font, {
            anchor: 'middle',
          }),
        );
    }
  }
  const roomForValues = L.bars.length <= 24;
  for (const b of L.bars) {
    const r = b.outer ? barRadius(style.radius, b.w, b.h) : 0;
    out.push({
      tag: 'div',
      x: ox + b.x,
      y: oy + b.y,
      w: b.w,
      h: b.h,
      bg: cssRgb(colour(b.series, b.highlighted)),
      radius: r,
    });
    if (showValues && roomForValues && spec.type !== 'stacked') {
      if (horizontal) {
        push(
          label(
            ox + b.x + b.w + 8,
            oy + b.y + b.h / 2 + 4,
            formatValue(b.value, spec.unit),
            12,
            ink,
            font,
            { weight: 600 },
          ),
        );
      } else {
        push(
          label(
            ox + b.x + b.w / 2,
            oy + (b.value >= 0 ? b.y - 6 : b.y + b.h + 14),
            formatValue(b.value, spec.unit),
            11.5,
            ink,
            font,
            { weight: 600, anchor: 'middle' },
          ),
        );
      }
    }
  }
  for (const l of L.lines) {
    const c = colour(l.series, false);
    const pts = linePoints(
      l.markers.map((m) => ({ x: ox + m.x, y: oy + m.y })),
      style.line,
    );
    if (spec.type === 'area' && style.area !== 'none' && pts.length > 1) {
      const first = pts[0] as { x: number; y: number };
      const last = pts[pts.length - 1] as { x: number; y: number };
      const poly = [...pts, { x: last.x, y: oy + L.zero }, { x: first.x, y: oy + L.zero }];
      out.push({
        tag: 'polygon',
        ...bbox(poly),
        points: pointsAttr(poly),
        fillC: over(c, ground.paper, style.area === 'gradient' ? 0.22 : 0.14),
      });
    }
    if (pts.length > 1) {
      out.push({
        tag: 'polyline',
        ...bbox(pts),
        points: pointsAttr(pts),
        stroke: cssRgb(c),
        strokeWidth: style.strokeWidth,
      });
    }
    for (const m of l.markers) {
      if (style.markers === 'none' && !m.highlighted) continue;
      const rr = m.highlighted ? 5.5 : style.markers === 'ring' ? 4 : 3.5;
      const mc = m.highlighted ? style.accent : c;
      if (style.markers === 'ring') {
        out.push({
          tag: 'circle',
          x: ox + m.x - rr - 1.25,
          y: oy + m.y - rr - 1.25,
          w: 2 * rr + 2.5,
          h: 2 * rr + 2.5,
          cx: ox + m.x,
          cy: oy + m.y,
          rr: rr + 1.25,
          bg: cssRgb(mc),
          radius: rr + 1.25,
        });
        out.push({
          tag: 'circle',
          x: ox + m.x - rr + 1.25,
          y: oy + m.y - rr + 1.25,
          w: 2 * rr - 2.5,
          h: 2 * rr - 2.5,
          cx: ox + m.x,
          cy: oy + m.y,
          rr: rr - 1.25,
          bg: cssRgb(ground.paper),
          radius: rr - 1.25,
        });
      } else {
        out.push({
          tag: 'circle',
          x: ox + m.x - rr,
          y: oy + m.y - rr,
          w: 2 * rr,
          h: 2 * rr,
          cx: ox + m.x,
          cy: oy + m.y,
          rr,
          bg: cssRgb(mc),
          radius: rr,
        });
      }
      if (showValues && L.lines.length === 1 && l.markers.length <= 16) {
        push(
          label(ox + m.x, oy + m.y - 11, formatValue(m.value, spec.unit), 11.5, ink, font, {
            weight: 600,
            anchor: 'middle',
          }),
        );
      }
    }
  }
  for (const m of L.scatter) {
    const rr = m.highlighted ? 6 : 4.5;
    out.push({
      tag: 'circle',
      x: ox + m.x - rr,
      y: oy + m.y - rr,
      w: 2 * rr,
      h: 2 * rr,
      cx: ox + m.x,
      cy: oy + m.y,
      rr,
      bg: over(colour(m.series, m.highlighted), ground.paper, 0.85),
      radius: rr,
    });
  }
  if (spec.xLabel !== undefined) {
    push(
      label(ox + L.plot.x + L.plot.w / 2, oy + L.height - 4, spec.xLabel, 12, mute, font, {
        anchor: 'middle',
      }),
    );
  }
  if (spec.yLabel !== undefined && !horizontal) {
    // No rotated text in the converters: the axis title sits above the axis.
    push(
      label(ox + L.plot.x - 8, oy + L.plot.y - 8, spec.yLabel, 11, mute, font, { anchor: 'end' }),
    );
  }
}
