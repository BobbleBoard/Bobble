/**
 * The static SVG — what the `chart` tool writes beside the spec, what a page
 * references and a deck or document embeds. Same layout as the interactive
 * card; no hover, no toggle, a note line and a title on paper.
 */

import { type ChartLayout, layoutChart } from './layout.ts';
import { type ChartSpec, formatValue } from './spec.ts';

export interface ChartTheme {
  readonly paper: string;
  readonly ink: string;
  readonly mute: string;
  readonly grid: string;
  /** Series colours, first is the primary. */
  readonly colours: readonly string[];
  /** The highlight colour. */
  readonly accent: string;
}

/** Bobble's own look: the app's blue on paper, a warm accent for a highlight. */
export const LIGHT_THEME: ChartTheme = {
  paper: '#FFFFFF',
  ink: '#1D1D1F',
  mute: '#6E6E73',
  grid: '#E6E6EA',
  colours: ['#2F6FE4', '#E8863A', '#3FB3AC', '#D9B44A', '#9AC05F', '#97A3AD'],
  accent: '#E8863A',
};

const FONT = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function text(
  x: number,
  y: number,
  s: string,
  size: number,
  fill: string,
  opts: { weight?: number; anchor?: 'start' | 'middle' | 'end'; extra?: string } = {},
): string {
  if (s === '') return '';
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${fill}" text-anchor="${opts.anchor ?? 'start'}"${opts.extra ?? ''}>${esc(s)}</text>`;
}

export interface SvgOptions {
  readonly width?: number;
  readonly height?: number;
  readonly theme?: ChartTheme;
}

/** Render a spec to a complete SVG document. */
export function chartToSvg(spec: ChartSpec, opts: SvgOptions = {}): string {
  const width = opts.width ?? 960;
  const height = opts.height ?? 560;
  const t = opts.theme ?? LIGHT_THEME;
  const pad = 32;
  let headY = pad;
  const head: string[] = [];
  if (spec.title !== '') {
    headY += 22;
    head.push(text(pad, headY, spec.title, 22, t.ink, { weight: 600 }));
  }
  if (spec.subtitle !== undefined) {
    headY += 20;
    head.push(text(pad, headY, spec.subtitle, 14, t.mute));
  }
  const top = headY + (spec.title !== '' || spec.subtitle !== undefined ? 14 : 0);
  const bottom = spec.note !== undefined ? 22 : 0;
  const inner = layoutChart(spec, {
    width: width - 2 * pad,
    height: height - top - pad - bottom,
    top: 0,
    bottom: 0,
  });
  const body = drawBody(spec, inner, t);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title || 'chart')}">`,
    `<rect width="${width}" height="${height}" rx="14" fill="${t.paper}"/>`,
    ...head,
    `<g transform="translate(${pad} ${top})">`,
    ...body,
    '</g>',
    spec.note !== undefined ? text(pad, height - 14, spec.note, 11.5, t.mute) : '',
    '</svg>',
  ];
  return `${parts.filter((p) => p !== '').join('\n')}\n`;
}

/** The plot's shapes as SVG fragments (in the layout's coordinate space). */
export function drawBody(spec: ChartSpec, L: ChartLayout, t: ChartTheme): string[] {
  const out: string[] = [];
  const colour = (series: number, highlighted: boolean): string =>
    highlighted && spec.series.length === 1
      ? t.accent
      : (t.colours[series % t.colours.length] ?? t.ink);

  if (L.legend.length > 0 && L.donut === undefined) {
    let lx = L.plot.x;
    for (const e of L.legend) {
      out.push(
        `<rect x="${lx}" y="${L.plot.y - 24}" width="12" height="12" rx="2" fill="${colour(e.series, false)}"/>`,
      );
      out.push(text(lx + 18, L.plot.y - 14, e.name, 12, t.mute));
      lx += 18 + 7 * e.name.length + 22;
    }
  }

  if (L.donut !== undefined) {
    // With a highlight, the accent is the highlight's alone — the other slices
    // stay in the rest of the palette (a second accent slice read as two).
    const shades =
      spec.highlight !== undefined ? t.colours.filter((c) => c !== t.accent) : t.colours;
    const sliceFill = (s: { highlighted: boolean; point: number }): string =>
      s.highlighted ? t.accent : (shades[s.point % shades.length] ?? t.ink);
    for (const s of L.slices) {
      out.push(`<path d="${s.d}" fill="${sliceFill(s)}" stroke="${t.paper}" stroke-width="2"/>`);
    }
    out.push(
      text(L.donut.cx, L.donut.cy + 8, L.donut.centre.big, 22, t.ink, {
        weight: 600,
        anchor: 'middle',
      }),
    );
    out.push(
      text(L.donut.cx, L.donut.cy + 26, L.donut.centre.small, 11, t.mute, { anchor: 'middle' }),
    );
    for (const c of L.categories) {
      const s = L.slices[c.index];
      if (s === undefined) continue;
      const fill = sliceFill(s);
      const y = c.band.y + c.band.h / 2;
      out.push(
        `<rect x="${c.band.x}" y="${(y - 6).toFixed(1)}" width="12" height="12" rx="3" fill="${fill}"/>`,
      );
      out.push(
        text(c.band.x + 20, y + 4, c.label, 13, t.ink, { weight: s.highlighted ? 600 : 400 }),
      );
      out.push(
        text(
          L.width,
          y + 4,
          spec.unit === '%'
            ? formatValue(s.value, '%')
            : `${formatValue(s.value, spec.unit)}  ·  ${Math.round(s.fraction * 100)}%`,
          12,
          t.mute,
          { anchor: 'end' },
        ),
      );
    }
    return out;
  }

  const horizontal = spec.type === 'hbar';
  // Gridlines + ticks.
  for (const tick of L.ticks) {
    const zeroLine = tick.value === 0;
    if (horizontal) {
      out.push(
        `<line x1="${tick.at.toFixed(1)}" y1="${L.plot.y}" x2="${tick.at.toFixed(1)}" y2="${L.plot.y + L.plot.h}" stroke="${zeroLine ? t.mute : t.grid}" stroke-width="1"/>`,
      );
      out.push(
        text(tick.at, L.plot.y + L.plot.h + 16, tick.label, 11, t.mute, { anchor: 'middle' }),
      );
    } else {
      out.push(
        `<line x1="${L.plot.x}" y1="${tick.at.toFixed(1)}" x2="${L.plot.x + L.plot.w}" y2="${tick.at.toFixed(1)}" stroke="${zeroLine ? t.mute : t.grid}" stroke-width="1"/>`,
      );
      out.push(text(L.plot.x - 8, tick.at + 4, tick.label, 11, t.mute, { anchor: 'end' }));
    }
  }
  for (const tick of L.xTicks) {
    out.push(
      `<line x1="${tick.at.toFixed(1)}" y1="${L.plot.y}" x2="${tick.at.toFixed(1)}" y2="${L.plot.y + L.plot.h}" stroke="${t.grid}" stroke-width="1"/>`,
    );
    out.push(text(tick.at, L.plot.y + L.plot.h + 16, tick.label, 11, t.mute, { anchor: 'middle' }));
  }
  // Category labels.
  if (spec.type !== 'scatter') {
    for (const c of L.categories) {
      if (horizontal)
        out.push(text(L.plot.x - 10, c.at + 4, c.label, 12.5, t.ink, { anchor: 'end' }));
      else
        out.push(text(c.at, L.plot.y + L.plot.h + 17, c.label, 12, t.mute, { anchor: 'middle' }));
    }
  }
  // Bars, with the value on each when there is room.
  const roomForValues = L.bars.length <= 24;
  for (const b of L.bars) {
    out.push(
      `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="${Math.min(3, b.w / 3).toFixed(1)}" fill="${colour(b.series, b.highlighted)}"/>`,
    );
    if (roomForValues && spec.type !== 'stacked') {
      if (horizontal)
        out.push(
          text(b.x + b.w + 8, b.y + b.h / 2 + 4, formatValue(b.value, spec.unit), 12, t.ink, {
            weight: 600,
          }),
        );
      else
        out.push(
          text(
            b.x + b.w / 2,
            b.value >= 0 ? b.y - 6 : b.y + b.h + 14,
            formatValue(b.value, spec.unit),
            11.5,
            t.ink,
            { weight: 600, anchor: 'middle' },
          ),
        );
    }
  }
  // Lines / areas.
  for (const l of L.lines) {
    const c = colour(l.series, false);
    if (spec.type === 'area' && l.area !== '')
      out.push(`<path d="${l.area}" fill="${c}" fill-opacity="0.14"/>`);
    if (l.markers.length > 1)
      out.push(
        `<path d="${l.d}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    for (const m of l.markers) {
      out.push(
        `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${m.highlighted ? 5.5 : 4}" fill="${t.paper}" stroke="${m.highlighted ? t.accent : c}" stroke-width="2.5"/>`,
      );
      if (L.lines.length === 1 && l.markers.length <= 16) {
        out.push(
          text(m.x, m.y - 11, formatValue(m.value, spec.unit), 11.5, t.ink, {
            weight: 600,
            anchor: 'middle',
          }),
        );
      }
    }
  }
  for (const m of L.scatter) {
    out.push(
      `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${m.highlighted ? 6 : 4.5}" fill="${colour(m.series, m.highlighted)}" fill-opacity="0.85"/>`,
    );
  }
  // Axis titles.
  if (spec.xLabel !== undefined) {
    out.push(
      text(L.plot.x + L.plot.w / 2, L.height - 4, spec.xLabel, 12, t.mute, { anchor: 'middle' }),
    );
  }
  if (spec.yLabel !== undefined && !horizontal) {
    const cy = L.plot.y + L.plot.h / 2;
    out.push(
      text(12, cy, spec.yLabel, 12, t.mute, {
        anchor: 'middle',
        extra: ` transform="rotate(-90 12 ${cy.toFixed(1)})"`,
      }),
    );
  }
  return out;
}
