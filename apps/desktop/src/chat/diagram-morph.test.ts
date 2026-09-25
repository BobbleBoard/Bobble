// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DiagramMorph,
  diffKeys,
  easeOut,
  flattenPath,
  lengthOf,
  mixColor,
  mixPoints,
  type Pt,
  parseColor,
  polyline,
  resample,
  roleOfKey,
} from './diagram-morph';

const near = (a: readonly Pt[], b: readonly Pt[], eps = 1e-6) =>
  a.length === b.length &&
  a.every(
    (p, i) =>
      Math.abs(p[0] - (b[i]?.[0] ?? Number.NaN)) < eps &&
      Math.abs(p[1] - (b[i]?.[1] ?? Number.NaN)) < eps,
  );

describe('flattenPath — an edge as points', () => {
  it('reads lines, H and V, absolute and relative', () => {
    expect(flattenPath('M0,0L10,0H20V5')).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [20, 5],
    ]);
    expect(flattenPath('m0 0 l10 0 l0 10')).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('samples curves (Mermaid’s basis edges, the post-pass’s rounded elbows)', () => {
    const pts = flattenPath('M0,0C0,10,10,10,10,0', 4) ?? [];
    expect(pts).toHaveLength(5);
    expect(pts[4]).toEqual([10, 0]);
    // The midpoint of that symmetric cubic is at x 5, y 7.5.
    expect(pts[2]?.[0]).toBeCloseTo(5);
    expect(pts[2]?.[1]).toBeCloseTo(7.5);
    const q = flattenPath('M0,0Q5,10 10,0', 2) ?? [];
    expect(q[1]?.[1]).toBeCloseTo(5);
  });

  it('refuses arcs and anything with fewer than two points', () => {
    expect(flattenPath('M0,0A5,5 0 0 1 10,10')).toBeNull();
    expect(flattenPath('M0,0')).toBeNull();
  });
});

describe('resample — two edges with the same number of points, so one bends into the other', () => {
  it('spaces points evenly along the line and keeps the ends', () => {
    const line: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const r = resample(line, 5);
    expect(
      near(r, [
        [0, 0],
        [5, 0],
        [10, 0],
        [10, 5],
        [10, 10],
      ]),
    ).toBe(true);
    expect(lengthOf(line)).toBe(20);
  });

  it('copes with a point and a zero-length line', () => {
    expect(resample([[3, 4]], 3)).toEqual([
      [3, 4],
      [3, 4],
      [3, 4],
    ]);
    expect(
      resample(
        [
          [1, 1],
          [1, 1],
        ],
        2,
      ),
    ).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it('mixes two point lists and writes them as a polyline', () => {
    const a: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    const b: Pt[] = [
      [0, 10],
      [20, 10],
    ];
    expect(mixPoints(a, b, 0.5)).toEqual([
      [0, 5],
      [15, 5],
    ]);
    expect(
      polyline([
        [0, 0],
        [1.234, 5.678],
      ]),
    ).toBe('M0,0L1.23,5.68');
  });
});

describe('colours, easing and keys', () => {
  it('reads #RGB, #RRGGBB and rgb(), and mixes two', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#0E7B74')).toEqual([14, 123, 116]);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseColor('none')).toBeNull();
    expect(mixColor('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    // Not a colour: the new one, at once.
    expect(mixColor('none', '#FFFFFF', 0.2)).toBe('#FFFFFF');
  });

  it('eases out, from 0 to 1 and no further', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });

  it('says what stayed, came and went', () => {
    expect(diffKeys(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({
      kept: ['b', 'c'],
      added: ['d'],
      removed: ['a'],
    });
  });

  it('reads a part’s role from its key (diagram-page.ts gives them)', () => {
    expect(roleOfKey('e:L_A_B_0')).toBe('edge');
    expect(roleOfKey('m:i3')).toBe('edge');
    expect(roleOfKey('al:C')).toBe('line');
    expect(roleOfKey('lp:0:line:2')).toBe('line');
    expect(roleOfKey('n:flowchart-A')).toBe('step');
    expect(roleOfKey('a:C')).toBe('step');
    expect(roleOfKey('l:L_A_B_0')).toBe('label');
    expect(roleOfKey('mt:i3')).toBe('label');
    expect(roleOfKey('head:title')).toBe('head');
    expect(roleOfKey('c:Warehouse:name')).toBe('label');
    expect(roleOfKey('c:Warehouse:box')).toBe('group');
    expect(roleOfKey('no:i9:rect')).toBe('group');
  });
});

describe('DiagramMorph — without motion', () => {
  it('shows each frame sanitised, in place, and ignores the same frame twice', () => {
    const host = document.createElement('div');
    const seen: string[] = [];
    const morph = new DiagramMorph(host, {
      sanitize: (s) => {
        seen.push(s);
        return s.replace(/<script[\s\S]*?<\/script>/g, '');
      },
      reducedMotion: () => true,
    });
    const one =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect data-k="n:a" width="1" height="1"/></svg>';
    morph.show(one, true);
    expect(host.querySelector('svg rect')?.getAttribute('data-k')).toBe('n:a');
    morph.show(one, true);
    expect(seen).toHaveLength(1);
    morph.show(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><circle r="2"/></svg>',
      true,
    );
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('circle')).not.toBeNull();
    expect(morph.moving).toBe(false);
    morph.dispose();
  });
});
