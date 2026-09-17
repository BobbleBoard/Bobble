import { describe, expect, it } from 'vitest';
import { layoutChart } from './layout.ts';
import { normalizeChartSpec } from './spec.ts';
import {
  EVERYDAY_LOOKS,
  hue,
  LOOK_NAMES,
  LOOKS,
  lightness,
  linePath,
  normalizeStyle,
  pickLook,
  resolveStyle,
  roundedBarPath,
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
      for (const c of [...l.palette, l.accent]) {
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
    expect(chartToSvg(plain, { fallbackLook: 'sunset' })).toContain('#F0563C');
    expect(chartToSvg(plain)).toContain('#2F6FE4');
  });
});

describe('a dark ground lifts the darkest inks', () => {
  it('editorial\u2019s navy reads on charcoal; a mid colour is left alone; a fixed ground decides for itself', () => {
    const light = resolveStyle({ look: 'editorial' });
    const dark = resolveStyle({ look: 'editorial' }, 'clean', { theme: 'dark' });
    expect(light.palette[0]).toBe('#1F3A5F');
    expect(dark.palette[0]).not.toBe('#1F3A5F');
    expect(lightness(dark.palette[0] ?? '')).toBeGreaterThan(lightness('#1F3A5F'));
    expect(dark.palette[1]).toBe('#C0504D');
    // Slate brings its own dark ground: lifted whatever the app's theme.
    expect(resolveStyle({ look: 'slate' }).palette).toEqual(
      resolveStyle({ look: 'slate' }, 'clean', { theme: 'light' }).palette,
    );
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
