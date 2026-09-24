import { describe, expect, it } from 'vitest';
import { layoutChart } from './layout.ts';
import {
  contrastRatio,
  deltaE,
  judgePairs,
  lookPairs,
  oklch,
  PALETTE_GATES,
} from './palette-check.ts';
import { normalizeChartSpec } from './spec.ts';
import {
  DARK_GROUND,
  EVERYDAY_LOOKS,
  hue,
  LIGHT_GROUND,
  LOOK_NAMES,
  LOOKS,
  liftForDark,
  lightness,
  linePath,
  normalizeStyle,
  pickLook,
  resolveStyle,
  roundedBarPath,
  sliceColour,
} from './style.ts';
import { chartToSvg } from './svg.ts';

describe('the looks', () => {
  it('are eleven, each with a six-colour palette and an accent', () => {
    expect(LOOK_NAMES.length).toBe(11);
    for (const l of LOOKS) {
      expect(l.palette.length).toBe(6);
      expect(l.accent).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('never reach for purple (the app brief) — no hue between 255° and 300° anywhere', () => {
    for (const l of LOOKS) {
      for (const c of [...l.palette, l.accent, ...(l.dark?.palette ?? []), l.dark?.accent ?? '']) {
        if (c === '') continue;
        const h = hue(c);
        expect(h < 255 || h > 300, `${l.name} ${c} is ${Math.round(h)}°`).toBe(true);
      }
    }
  });

  it('keep every colour readable on both grounds (never near-black, never near-white)', () => {
    for (const l of LOOKS) {
      if (l.ground !== undefined) continue; // a fixed ground brings its own contrast
      for (const c of l.palette) {
        const y = lightness(c);
        expect(y > 0.08 && y < 0.93, `${l.name} ${c} lightness ${y.toFixed(2)}`).toBe(true);
      }
    }
  });

  it('pickLook is stable for a title and varies across titles', () => {
    expect(pickLook('Units Sold by Year')).toBe(pickLook('Units Sold by Year'));
    const seen = new Set(
      [
        'Units Sold by Year',
        'Market share',
        'Revenue vs Cost',
        'Latency p50',
        'Signups',
        'Churn',
      ].map(pickLook),
    );
    expect(seen.size).toBeGreaterThan(2);
    for (const name of seen) expect(EVERYDAY_LOOKS).toContain(name);
  });
});

describe('normalizeStyle — the knobs as a model writes them', () => {
  it('reads a look, a palette, an accent, a radius word, a line word', () => {
    expect(
      normalizeStyle({
        look: 'Editorial',
        palette: '#264653, #2a9d8f, teal',
        accent: 'coral',
        radius: 'pill',
        line: 'curved',
        grid: 'off',
        font: 'serif',
        labels: 'show',
      }),
    ).toEqual({
      look: 'editorial',
      palette: ['#264653', '#2a9d8f', '#3FB3AC'],
      accent: '#F0563C',
      radius: 'pill',
      line: 'smooth',
      grid: 'none',
      font: 'serif',
      labels: 'on',
    });
  });

  it('drops what it cannot read rather than throwing, and returns nothing for nothing', () => {
    expect(
      normalizeStyle({ look: 'neon-disco', accent: 'not a colour', radius: 'huge' }),
    ).toBeUndefined();
    expect(normalizeStyle({ title: 'x', labels: ['a'] })).toBeUndefined();
  });

  it('takes the same keys from a nested style object and a snake_case flat spec', () => {
    expect(normalizeStyle({ style: { radius: 12, bar_width: 40 } })).toEqual({
      radius: 12,
      barWidth: 0.4,
    });
    expect(normalizeChartSpec({ labels: ['a'], values: [1], look: 'slate' }).style).toEqual({
      look: 'slate',
    });
  });
});

describe('resolveStyle', () => {
  it('layers the spec over the look, and the fallback under a spec with no look', () => {
    const r = resolveStyle({ look: 'soft', radius: 0, accent: '#000000' });
    expect(r.look).toBe('soft');
    expect(r.radius).toBe(0);
    expect(r.accent).toBe('#000000');
    expect(r.grid).toBe('dots');
    expect(resolveStyle(undefined, 'sunset').look).toBe('sunset');
    expect(resolveStyle({ radius: 2 }, 'sunset').look).toBe('sunset');
  });

  it('a fixed-ground look brings its ground; a background of its own picks an ink for contrast', () => {
    expect(resolveStyle({ look: 'slate' }).ground?.paper).toBe('#1C1F26');
    expect(resolveStyle({ look: 'clean' }).ground).toBeNull();
    expect(resolveStyle({ background: '#102030' }).ground?.ink).toBe('#F2F2F5');
    expect(resolveStyle({ background: '#FAF3E0' }).ground?.ink).toBe('#1D1D1F');
  });
});

describe('the shapes', () => {
  it('a rounded bar rounds only the side away from the axis, and never more than half its size', () => {
    const top = roundedBarPath(0, 10, 40, 100, 8, 'top');
    expect(top.startsWith('M0 110')).toBe(true);
    expect(top).toContain('a8 8 0 0 1');
    // A pill on a bar 40 wide is r=20 no matter how big the radius asked for.
    expect(roundedBarPath(0, 0, 40, 100, 999, 'top')).toContain('a20 20');
    // Square when asked.
    expect(roundedBarPath(0, 0, 40, 100, 0, 'top')).toBe('M0 0h40v100h-40Z');
  });

  it('a smooth line passes through every point and never overshoots (monotone)', () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 50, y: 20 },
      { x: 100, y: 25 },
      { x: 150, y: 90 },
    ];
    const d = linePath(pts, 'smooth');
    expect(d.startsWith('M0 100')).toBe(true);
    expect(d.endsWith('150 90')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
    // The control points of a flat-ish segment stay between its endpoints in y.
    const seg = d.split('C')[2] ?? '';
    const ys = seg
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((_v, i) => i % 2 === 1);
    for (const y of ys) expect(y >= 20 - 1e-6 && y <= 25 + 1e-6).toBe(true);
    expect(linePath(pts, 'step')).toContain('H25 V20');
  });

  it('the layout carries the bar side and whether it is the outer segment of a stack', () => {
    const L = layoutChart(
      normalizeChartSpec({
        type: 'stacked',
        labels: ['a'],
        values: ['A: 3', 'B: 2'],
      }),
      { width: 400, height: 300 },
    );
    expect(L.bars.map((b) => [b.series, b.outer])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(L.bars[0]?.side).toBe('top');
  });
});

describe('the SVG wears the look', () => {
  const spec = normalizeChartSpec({
    type: 'area',
    title: 'Signups',
    labels: ['Jan', 'Feb', 'Mar'],
    values: [3, 5, 4],
    look: 'ocean',
  });
  it('rounded bars are paths, a gradient area has its defs, a fixed ground paints its paper', () => {
    const svg = chartToSvg(spec);
    expect(svg).toContain('<linearGradient id="c-area-0"');
    expect(svg).toContain('fill="url(#c-area-0)"');
    expect(svg).toContain('stroke-width="3"');
    const bars = chartToSvg(
      normalizeChartSpec({ labels: ['a', 'b'], values: [1, 2], look: 'bold' }),
    );
    expect(bars).toContain('a10 10 0 0 1');
    const paper = chartToSvg(normalizeChartSpec({ labels: ['a'], values: [1], look: 'paper' }));
    expect(paper).toContain('Georgia');
    // The green "terminal" look is gone (the user: "it shouldn't be there") — a
    // chart that names it gets the fallback look, never a black-and-phosphor one.
    const gone = chartToSvg(normalizeChartSpec({ labels: ['a'], values: [1], look: 'terminal' }));
    expect(gone).not.toContain('#0B0F0A');
    expect(gone).not.toContain('#39FF14');
  });

  it('a chart with no look takes the caller’s fallback, so the file matches the card', () => {
    const plain = normalizeChartSpec({ labels: ['a'], values: [1] });
    expect(chartToSvg(plain, { fallbackLook: 'sunset' })).toContain(
      LOOKS.find((l) => l.name === 'sunset')?.palette[0],
    );
    expect(chartToSvg(plain)).toContain('#2F6FE4');
  });
});

describe('a dark ground', () => {
  it('a theme-following look wears its own dark steps; a fixed ground decides for itself', () => {
    const light = resolveStyle({ look: 'editorial' });
    const dark = resolveStyle({ look: 'editorial' }, 'clean', { theme: 'dark' });
    const editorial = LOOKS.find((l) => l.name === 'editorial');
    expect(light.palette).toEqual(editorial?.palette);
    expect(dark.palette).toEqual(editorial?.dark?.palette);
    expect(dark.accent).toBe(editorial?.dark?.accent);
    // The navy that sank into the charcoal reads now.
    expect(lightness(dark.palette[0] ?? '')).toBeGreaterThan(lightness('#1F3A5F'));
    // A dark background of the chart's own is a dark ground too.
    expect(resolveStyle({ look: 'editorial', background: '#101820' }).palette).toEqual(
      editorial?.dark?.palette,
    );
    // Slate brings its own dark ground: the same colours whatever the app's theme.
    expect(resolveStyle({ look: 'slate' }).palette).toEqual(
      resolveStyle({ look: 'slate' }, 'clean', { theme: 'dark' }).palette,
    );
  });

  it('colours the chart brought itself are lifted just enough to read — nobody stepped them for the dark', () => {
    const own = resolveStyle({ palette: ['#1F3A5F', '#C0504D'], accent: '#102030' }, 'clean', {
      theme: 'dark',
    });
    expect(own.palette[0]).toBe(liftForDark('#1F3A5F'));
    expect(own.palette[0]).not.toBe('#1F3A5F');
    expect(own.palette[1]).toBe('#C0504D'); // already readable: left alone
    expect(own.accent).toBe(liftForDark('#102030'));
  });
});

/**
 * THE ACCEPTANCE FOR VQ-03. Every look, on every ground it is drawn on:
 *   - neighbours (series i ↔ i+1, wrapping; the highlight against every other
 *     colour; a highlighted donut's shorter ring) ≥ 15 ΔE in normal vision and
 *     ≥ 8 for protan/deutan readers — 6–8 only on a look that writes its values
 *     on the marks (labels 'on');
 *   - every mark ≥ 3:1 against the ground.
 * The grounds: a fixed-ground look's own paper; a theme-following look's light
 * steps on the static SVG's white and on the app's light thread grounds, its
 * dark steps on the SVG's dark paper and the app's dark thread grounds (the
 * card is transparent over the thread: bobble / claude / codex flavours).
 */
const APP_LIGHT_GROUNDS = ['#F5F5F7', '#FAF9F5', '#FFFFFF'];
const APP_DARK_GROUNDS = ['#151517', '#262624', '#181818'];

describe('every look passes the palette checks (VQ-03)', () => {
  const cases: Array<{ name: string; theme: 'light' | 'dark'; grounds: string[] }> = [];
  for (const l of LOOKS) {
    if (l.ground !== undefined) {
      cases.push({ name: l.name, theme: 'light', grounds: [l.ground.paper] });
    } else {
      cases.push({
        name: l.name,
        theme: 'light',
        grounds: [LIGHT_GROUND.paper, ...APP_LIGHT_GROUNDS],
      });
      cases.push({
        name: l.name,
        theme: 'dark',
        grounds: [DARK_GROUND.paper, ...APP_DARK_GROUNDS],
      });
    }
  }

  it.each(cases)('$name on $theme', ({ name, theme, grounds }) => {
    const st = resolveStyle({ look: name as never }, 'clean', { theme });
    const v = judgePairs(lookPairs(st.palette, st.accent));
    const worst = `worst CVD ${v.worstCvd?.cvd.toFixed(1)} (${v.worstCvd?.where}), worst normal ${v.worstNormal?.normal.toFixed(1)} (${v.worstNormal?.where})`;
    expect(v.normal, worst).toBe(true);
    expect(v.cvd === 'pass' || (v.cvd === 'floor' && st.labels === 'on'), worst).toBe(true);
    for (const g of grounds) {
      for (const c of [...st.palette, st.accent]) {
        expect(contrastRatio(c, g), `${name} ${theme}: ${c} on ${g}`).toBeGreaterThanOrEqual(
          PALETTE_GATES.markContrast,
        );
      }
    }
  });

  it('no lavender either: a light blue never sits past OKLCH hue 262 toward violet', () => {
    // A lightened royal blue drifts to periwinkle, which reads as purple — the
    // app brief rules that out — so light blues stay at the blue end. (A deep
    // royal blue, #1D4ED8, reads blue at 264°: the drift is a light colour's.)
    for (const l of LOOKS) {
      for (const c of [...l.palette, l.accent, ...(l.dark?.palette ?? []), l.dark?.accent ?? '']) {
        if (c === '') continue;
        const { l: light, h, c: chroma } = oklch(c);
        expect(
          chroma < 0.04 || light < 0.6 || h <= 262 || h >= 340,
          `${l.name} ${c} at OKLCH ${h.toFixed(0)}°`,
        ).toBe(true);
      }
    }
  });

  it('the highlight is never a look\u2019s first colour (a highlighted bar must show)', () => {
    for (const l of LOOKS) {
      expect(l.accent, l.name).not.toBe(l.palette[0]);
      if (l.dark !== undefined) expect(l.dark.accent, `${l.name} dark`).not.toBe(l.dark.palette[0]);
    }
  });

  it('every theme-following look has dark steps, six of them, and a fixed-ground look has none', () => {
    for (const l of LOOKS) {
      if (l.ground === undefined) expect(l.dark?.palette.length, l.name).toBe(6);
      else expect(l.dark, l.name).toBeUndefined();
    }
  });
});

describe('a donut never meets itself in one colour', () => {
  const clean = resolveStyle({ look: 'clean' });
  const ring = (count: number, highlight: number | null) =>
    Array.from({ length: count }, (_v, i) =>
      sliceColour(clean, i, count, i === highlight, highlight !== null),
    );
  const seams = (fills: string[]) =>
    fills.map((c, i) => [c, fills[(i + 1) % fills.length] as string] as const);

  it('six slices round a highlight (five colours left): the last slice is not the first colour', () => {
    const fills = ring(6, 2);
    expect(fills[2]).toBe(clean.accent);
    expect(fills.filter((c) => c === clean.accent).length).toBe(1);
    for (const [a, b] of seams(fills)) expect(a).not.toBe(b);
  });

  it('seven slices on six colours: the seam is two different colours that read apart', () => {
    const fills = ring(7, null);
    for (const [a, b] of seams(fills)) expect(a).not.toBe(b);
    const last = fills[6] as string;
    expect(
      Math.min(
        deltaE(last, fills[5] as string, 'deutan'),
        deltaE(last, fills[0] as string, 'deutan'),
      ),
    ).toBeGreaterThan(6);
  });

  it('a ring that fits its palette is the plain cycle', () => {
    expect(ring(6, null)).toEqual([...clean.palette]);
    expect(ring(4, null)).toEqual(clean.palette.slice(0, 4));
  });
});

describe('pill bars are skinny; rounded-corner bars are thick', () => {
  it('a pill look caps its bars in px and centres them; a rounded look fills most of the band', () => {
    const data = { labels: ['a', 'b', 'c', 'd'], values: [1, 2, 3, 4] };
    const pill = layoutChart(normalizeChartSpec({ ...data, look: 'candy' }), {
      width: 960,
      height: 400,
    });
    const rounded = layoutChart(normalizeChartSpec({ ...data, look: 'clean' }), {
      width: 960,
      height: 400,
    });
    const pillW = pill.bars[0]?.w ?? 0;
    const roundW = rounded.bars[0]?.w ?? 0;
    expect(pillW).toBeLessThanOrEqual(30);
    expect(roundW).toBeGreaterThan(pillW * 3);
    // Centred in its band.
    const band = pill.categories[0]?.band;
    const bar = pill.bars[0];
    if (band === undefined || bar === undefined) throw new Error('no bar');
    expect(Math.abs(bar.x + bar.w / 2 - (band.x + band.w / 2))).toBeLessThan(0.5);
    // A chart that set its own bar width keeps it, pill or not.
    const wide = layoutChart(normalizeChartSpec({ ...data, look: 'candy', bars: 'wide' }), {
      width: 960,
      height: 400,
    });
    expect(wide.bars[0]?.w ?? 0).toBeGreaterThan(100);
    // The same cap sideways.
    const hpill = layoutChart(normalizeChartSpec({ ...data, type: 'hbar', look: 'soft' }), {
      width: 960,
      height: 400,
    });
    expect(hpill.bars[0]?.h ?? 0).toBeLessThanOrEqual(30);
  });
});
