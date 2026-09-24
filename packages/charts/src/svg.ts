/**
 * The static SVG — what the `chart` tool writes beside the spec, what a page
 * references and a deck or document embeds. Same layout and the same LOOK as
 * the interactive card (style.ts); no hover, no toggle, a title on paper.
 */

import { type ChartLayout, layoutChart } from './layout.ts';
import { chartCanvas } from './sizes.ts';
import { type ChartSpec, formatValue } from './spec.ts';
import {
  barRadius,
  DARK_GROUND,
  type Ground,
  LIGHT_GROUND,
  type LookName,
  type ResolvedStyle,
  resolveStyle,
  roundedBarPath,
  sliceColour,
} from './style.ts';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function text(
  x: number,
  y: number,
  s: string,
  size: number,
  fill: string,
  font: string,
  opts: { weight?: number; anchor?: 'start' | 'middle' | 'end'; extra?: string } = {},
): string {
  if (s === '') return '';
  return `<text x="${f(x)}" y="${f(y)}" font-family="${esc(font)}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${fill}" text-anchor="${opts.anchor ?? 'start'}"${opts.extra ?? ''}>${esc(s)}</text>`;
}

export interface SvgOptions {
  /** The canvas; by default the spec's size preset (sizes.ts: card 960×560, …). */
  readonly width?: number;
  readonly height?: number;
  /** The ground for a theme-following look: light (default) or dark. */
  readonly theme?: 'light' | 'dark';
  /** The look used when the spec names none (the tool passes its pick). */
  readonly fallbackLook?: LookName;
}

/**
 * Render a spec to a complete SVG document.
 *
 * The canvas is the spec's size preset (a horizontal bar chart as tall as its
 * rows) unless a width/height is passed. A preset with a type scale above 1 (a
 * slide) is drawn on a smaller page and scaled up whole — type, strokes and
 * bars together — so it reads across a room and keeps its proportions.
 */
export function chartToSvg(spec: ChartSpec, opts: SvgOptions = {}): string {
  const canvas = chartCanvas(spec);
  const outW = opts.width ?? canvas.width;
  const outH = opts.height ?? canvas.height;
  const scale = opts.width === undefined && opts.height === undefined ? canvas.text : 1;
  const width = Math.round(outW / scale);
  const height = Math.round(outH / scale);
  const style = resolveStyle(spec.style, opts.fallbackLook, { theme: opts.theme ?? 'light' });
  const ground = style.ground ?? (opts.theme === 'dark' ? DARK_GROUND : LIGHT_GROUND);
  const pad = 32;
  let headY = pad;
  const head: string[] = [];
  if (spec.title !== '') {
    headY += 22;
    head.push(
      text(pad, headY, spec.title, 22, ground.ink, style.fontFamily, { weight: style.titleWeight }),
    );
  }
  if (spec.subtitle !== undefined) {
    headY += 20;
    head.push(text(pad, headY, spec.subtitle, 14, ground.mute, style.fontFamily));
  }
  const top = headY + (spec.title !== '' || spec.subtitle !== undefined ? 14 : 0);
  const bottom = spec.note !== undefined ? 22 : 0;
  const inner = layoutChart(spec, {
    width: width - 2 * pad,
    height: height - top - pad - bottom,
    top: 0,
    bottom: 0,
    style,
    endLabels: true,
  });
  const { defs, body } = drawBody(spec, inner, style, ground, { idPrefix: 'c', labels: true });
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(spec.title || 'chart')}">`,
    defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '',
    `<rect width="${width}" height="${height}" rx="14" fill="${ground.paper}"/>`,
    ...head,
    `<g transform="translate(${pad} ${top})">`,
    ...body,
    '</g>',
    spec.note !== undefined
      ? text(pad, height - 14, spec.note, 11.5, ground.mute, style.fontFamily)
      : '',
    '</svg>',
  ];
  return `${parts.filter((p) => p !== '').join('\n')}\n`;
}

export interface DrawOptions {
  /** Prefix for gradient ids, unique per document. */
  readonly idPrefix: string;
  /** Whether value labels may be drawn (the style's `labels` still decides). */
  readonly labels: boolean;
}

/** The colour of a series (or the accent for a highlighted point in a one-series chart). */
export function seriesColour(
  style: ResolvedStyle,
  series: number,
  highlighted: boolean,
  seriesCount: number,
): string {
  if (highlighted && seriesCount === 1) return style.accent;
  return style.palette[series % style.palette.length] ?? style.palette[0] ?? '#888888';
}

/** The plot's shapes as SVG fragments (in the layout's coordinate space), plus any defs. */
export function drawBody(
  spec: ChartSpec,
  L: ChartLayout,
  style: ResolvedStyle,
  ground: Ground,
  opts: DrawOptions,
): { defs: string[]; body: string[] } {
  const out: string[] = [];
  const defs: string[] = [];
  const font = style.fontFamily;
  const colour = (series: number, highlighted: boolean): string =>
    seriesColour(style, series, highlighted, spec.series.length);
  const showValues = opts.labels && style.labels !== 'off';

  if (L.legend.length > 0 && L.donut === undefined) {
    let lx = L.plot.x;
    for (const e of L.legend) {
      out.push(
        `<rect x="${f(lx)}" y="${f(L.plot.y - 24)}" width="12" height="12" rx="${style.radius === 0 ? 0 : 3}" fill="${colour(e.series, false)}"/>`,
      );
      out.push(text(lx + 18, L.plot.y - 14, e.name, 12, ground.mute, font));
      lx += 18 + 7 * e.name.length + 22;
    }
  }

  if (L.radar !== undefined) {
    const R = L.radar;
    // The web: rings, then spokes, then the labels round the rim.
    for (const ring of R.rings) {
      out.push(`<path d="${ring}" fill="none" stroke="${ground.grid}" stroke-width="1"/>`);
    }
    for (const ax of R.axes) {
      out.push(
        `<line x1="${f(R.cx)}" y1="${f(R.cy)}" x2="${f(ax.x)}" y2="${f(ax.y)}" stroke="${ground.grid}" stroke-width="1"/>`,
      );
      out.push(text(ax.labelX, ax.labelY, ax.label, 12, ground.mute, font, { anchor: ax.anchor }));
    }
    for (const sh of R.shapes) {
      const c = colour(sh.series, false);
      out.push(
        `<path d="${sh.d}" fill="${c}" fill-opacity="0.18" stroke="${c}" stroke-width="${style.strokeWidth}" stroke-linejoin="round"/>`,
      );
      for (const p of sh.points) {
        out.push(
          `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="3.5" fill="${p.highlighted ? style.accent : c}" stroke="${ground.paper}" stroke-width="1.5"/>`,
        );
      }
    }
    return { defs, body: out };
  }

  if (L.donut !== undefined) {
    // With a highlight, the accent is the highlight's alone — the other slices
    // stay in the rest of the palette (a second accent slice read as two); and
    // a wrapped ring never meets itself in one colour (style.ts sliceColour).
    const sliceFill = (s: { highlighted: boolean; point: number }): string =>
      sliceColour(
        style,
        s.point,
        L.slices.length,
        s.highlighted,
        spec.highlight !== undefined,
        ground.ink,
      );
    for (const s of L.slices) {
      out.push(
        `<path d="${s.d}" fill="${sliceFill(s)}" stroke="${ground.paper}" stroke-width="2"/>`,
      );
    }
    // A pie has nothing to say in the middle (centre.big is '').
    if (L.donut.centre.big !== '') {
      out.push(
        text(L.donut.cx, L.donut.cy + 8, L.donut.centre.big, 22, ground.ink, font, {
          weight: style.titleWeight,
          anchor: 'middle',
        }),
      );
      out.push(
        text(L.donut.cx, L.donut.cy + 26, L.donut.centre.small, 11, ground.mute, font, {
          anchor: 'middle',
        }),
      );
    }
    for (const c of L.categories) {
      const s = L.slices[c.index];
      if (s === undefined) continue;
      const fill = sliceFill(s);
      const y = c.band.y + c.band.h / 2;
      out.push(
        `<rect x="${f(c.band.x)}" y="${f(y - 6)}" width="12" height="12" rx="${style.radius === 0 ? 0 : 3}" fill="${fill}"/>`,
      );
      out.push(
        text(c.band.x + 20, y + 4, c.label, 13, ground.ink, font, {
          weight: s.highlighted ? 600 : 400,
        }),
      );
      out.push(
        text(
          L.width,
          y + 4,
          spec.unit === '%'
            ? formatValue(s.value, '%')
            : `${formatValue(s.value, spec.unit)}  ·  ${Math.round(s.fraction * 100)}%`,
          12,
          ground.mute,
          font,
          { anchor: 'end' },
        ),
      );
    }
    return { defs, body: out };
  }

  const horizontal = spec.type === 'hbar';
  const gridAttr = style.grid === 'dots' ? ` stroke-dasharray="1 4" stroke-linecap="round"` : '';
  // Gridlines + ticks.
  for (const tick of L.ticks) {
    const zeroLine = tick.value === 0;
    const drawLine = style.grid !== 'none' || zeroLine;
    if (horizontal) {
      if (drawLine) {
        out.push(
          `<line x1="${f(tick.at)}" y1="${f(L.plot.y)}" x2="${f(tick.at)}" y2="${f(L.plot.y + L.plot.h)}" stroke="${zeroLine ? ground.mute : ground.grid}" stroke-width="1"${zeroLine ? '' : gridAttr}/>`,
        );
      }
      out.push(
        text(tick.at, L.plot.y + L.plot.h + 16, tick.label, 11, ground.mute, font, {
          anchor: 'middle',
        }),
      );
    } else {
      if (drawLine) {
        out.push(
          `<line x1="${f(L.plot.x)}" y1="${f(tick.at)}" x2="${f(L.plot.x + L.plot.w)}" y2="${f(tick.at)}" stroke="${zeroLine ? ground.mute : ground.grid}" stroke-width="1"${zeroLine ? '' : gridAttr}/>`,
        );
      }
      out.push(
        text(L.plot.x - 8, tick.at + 4, tick.label, 11, ground.mute, font, { anchor: 'end' }),
      );
    }
  }
  for (const tick of L.xTicks) {
    if (style.grid !== 'none') {
      out.push(
        `<line x1="${f(tick.at)}" y1="${f(L.plot.y)}" x2="${f(tick.at)}" y2="${f(L.plot.y + L.plot.h)}" stroke="${ground.grid}" stroke-width="1"${gridAttr}/>`,
      );
    }
    out.push(
      text(tick.at, L.plot.y + L.plot.h + 16, tick.label, 11, ground.mute, font, {
        anchor: 'middle',
      }),
    );
  }
  // Category labels.
  if (spec.type !== 'scatter') {
    for (const c of L.categories) {
      if (horizontal)
        out.push(text(L.plot.x - 10, c.at + 4, c.label, 12.5, ground.ink, font, { anchor: 'end' }));
      else
        out.push(
          text(c.at, L.plot.y + L.plot.h + 17, c.label, 12, ground.mute, font, {
            anchor: 'middle',
          }),
        );
    }
  }
  // Bars, with the value on each when there is room.
  const roomForValues = L.bars.length <= 24;
  for (const b of L.bars) {
    const r = b.outer ? barRadius(style.radius, b.w, b.h) : 0;
    out.push(
      `<path d="${roundedBarPath(b.x, b.y, b.w, b.h, r, b.side)}" fill="${colour(b.series, b.highlighted)}"/>`,
    );
    if (showValues && roomForValues && spec.type !== 'stacked') {
      if (horizontal)
        out.push(
          text(
            b.x + b.w + 8,
            b.y + b.h / 2 + 4,
            formatValue(b.value, spec.unit),
            12,
            ground.ink,
            font,
            {
              weight: 600,
            },
          ),
        );
      else
        out.push(
          text(
            b.x + b.w / 2,
            b.value >= 0 ? b.y - 6 : b.y + b.h + 14,
            formatValue(b.value, spec.unit),
            11.5,
            ground.ink,
            font,
            { weight: 600, anchor: 'middle' },
          ),
        );
    }
  }
  // Lines / areas.
  for (const l of L.lines) {
    const c = colour(l.series, false);
    if (spec.type === 'area' && l.area !== '' && style.area !== 'none') {
      if (style.area === 'gradient') {
        const id = `${opts.idPrefix}-area-${l.series}`;
        defs.push(
          `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="0.38"/><stop offset="1" stop-color="${c}" stop-opacity="0.02"/></linearGradient>`,
        );
        out.push(`<path d="${l.area}" fill="url(#${id})"/>`);
      } else {
        out.push(`<path d="${l.area}" fill="${c}" fill-opacity="0.14"/>`);
      }
    }
    if (l.markers.length > 1)
      out.push(
        `<path d="${l.d}" fill="none" stroke="${c}" stroke-width="${style.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    for (const m of l.markers) {
      if (style.markers === 'ring') {
        out.push(
          `<circle cx="${f(m.x)}" cy="${f(m.y)}" r="${m.highlighted ? 5.5 : 4}" fill="${ground.paper}" stroke="${m.highlighted ? style.accent : c}" stroke-width="2.5"/>`,
        );
      } else if (style.markers === 'dot' || m.highlighted) {
        out.push(
          `<circle cx="${f(m.x)}" cy="${f(m.y)}" r="${m.highlighted ? 5.5 : 3.5}" fill="${m.highlighted ? style.accent : c}"/>`,
        );
      }
      if (showValues && L.lines.length === 1 && l.markers.length <= 16) {
        out.push(
          text(m.x, m.y - 11, formatValue(m.value, spec.unit), 11.5, ground.ink, font, {
            weight: 600,
            anchor: 'middle',
          }),
        );
      }
    }
  }
  for (const m of L.scatter) {
    out.push(
      `<circle cx="${f(m.x)}" cy="${f(m.y)}" r="${m.highlighted ? 6 : 4.5}" fill="${colour(m.series, m.highlighted)}" fill-opacity="0.85"/>`,
    );
  }
  // Each line named at its end: the name in ink beside the line's last point,
  // a hairline leader in the line's colour when neighbours pushed it apart.
  for (const e of L.endLabels) {
    const c = colour(e.series, false);
    if (Math.abs(e.y - e.anchorY) > 2) {
      out.push(
        `<path d="M${f(e.anchorX + 6)} ${f(e.anchorY)}L${f(e.x - 4)} ${f(e.y)}" fill="none" stroke="${c}" stroke-width="1"/>`,
      );
    }
    out.push(text(e.x, e.y + 4, e.text, 12, ground.ink, font, { weight: 600 }));
  }
  // Axis titles — the spec's, or a unit that is a word, said once on the value axis.
  const xTitle = spec.xLabel ?? (horizontal ? L.unitTitle : undefined);
  const yTitle = spec.yLabel ?? (!horizontal ? L.unitTitle : undefined);
  if (xTitle !== undefined) {
    out.push(
      text(L.plot.x + L.plot.w / 2, L.height - 4, xTitle, 12, ground.mute, font, {
        anchor: 'middle',
      }),
    );
  }
  if (yTitle !== undefined && !horizontal) {
    const cy = L.plot.y + L.plot.h / 2;
    out.push(
      text(12, cy, yTitle, 12, ground.mute, font, {
        anchor: 'middle',
        extra: ` transform="rotate(-90 12 ${f(cy)})"`,
      }),
    );
  }
  return { defs, body: out };
}
