import { describe, expect, it } from 'vitest';
import { compile, ExprError, fromLatex, numberOf, parse, toJs } from './expr';

const at = (src: string, scope: Record<string, number>, names = Object.keys(scope)) =>
  compile(src, names)(scope);

describe('expressions as people and small models type them', () => {
  it('reads the usual arithmetic, powers right-to-left, and the functions', () => {
    expect(at('1 + 2*3', {})).toBe(7);
    expect(at('2^3^2', {})).toBe(512);
    expect(at('-x^2', { x: 3 })).toBe(-9);
    expect(at('sqrt(16) + abs(-2) + max(1, 5, 3)', {})).toBe(11);
    expect(at('sin(pi/2) + cos(0)', {})).toBeCloseTo(2);
    expect(at('2**3', {})).toBe(8);
  });

  it('multiplies what is written side by side', () => {
    expect(at('2x', { x: 5 })).toBe(10);
    expect(at('3pi', {})).toBeCloseTo(3 * Math.PI);
    expect(at('(x+1)(x-1)', { x: 3 })).toBe(8);
    expect(at('2sin(x)', { x: Math.PI / 2 })).toBeCloseTo(2);
    expect(at('kx', { k: 2, x: 3 })).toBe(6);
    expect(at('2pix', { x: 1 })).toBeCloseTo(2 * Math.PI);
    expect(at('sin 2x', { x: Math.PI / 4 })).toBeCloseTo(1);
    expect(at('sin x cos x', { x: Math.PI / 4 })).toBeCloseTo(0.5);
  });

  it('sums a series over its own counter — the partial sums a slider walks', () => {
    // 4/π Σ sin((2k−1)x)/(2k−1): the square wave's Fourier series, at x = π/2.
    const sq = compile('4/pi * sum(k, 1, n, sin((2k-1)x)/(2k-1))', ['x', 'n']);
    expect(sq({ x: Math.PI / 2, n: 1 })).toBeCloseTo(4 / Math.PI);
    expect(sq({ x: Math.PI / 2, n: 400 })).toBeCloseTo(1, 2);
    expect(at('prod(i, 1, 5, i)', {})).toBe(120);
    expect(at('if(x > 0, 1, -1)', { x: -2 })).toBe(-1);
  });

  it('reads light LaTeX', () => {
    expect(fromLatex('\\frac{1}{2}\\sin(x)')).toBe('((1)/(2))sin(x)');
    expect(at('\\frac{\\pi}{2} \\cdot x^{2}', { x: 2 })).toBeCloseTo(2 * Math.PI);
    expect(at('\\sqrt{x}', { x: 9 })).toBe(3);
    expect(at('2π·x', { x: 1 })).toBeCloseTo(2 * Math.PI);
  });

  it('says what is wrong, and where', () => {
    expect(() => compile('sin(x) + y', ['x'])).toThrow(
      /"y" at 10 is not a variable here \(these are: x, pi, e, tau, deg\)/,
    );
    expect(() => compile('(x + 1', ['x'])).toThrow(ExprError);
    expect(() => compile('x $ 2', ['x'])).toThrow(/"\$" at 3/);
    expect(() => compile('', [])).toThrow(/empty/);
    expect(numberOf('-pi')).toBeCloseTo(-Math.PI);
    expect(numberOf('2pi/3')).toBeCloseTo((2 * Math.PI) / 3);
  });
});

describe('the same tree, written out for the page', () => {
  it('evaluates in the page exactly as in Node', () => {
    const cases: Array<[string, Record<string, number>]> = [
      ['4/pi * sum(k, 1, n, sin((2k-1)x)/(2k-1))', { x: 0.7, n: 9 }],
      ['if(x > 0, x^2, -x) + prod(i, 1, 4, i)', { x: -1.5 }],
      ['sin x cos x + mod(7, 3) + sgn(-2)', { x: 1.1 }],
      ['2^3^2 - (x+1)(x-1)', { x: 3 }],
    ];
    for (const [src, scope] of cases) {
      const tree = parse(src, Object.keys(scope));
      const fn = new Function('s', `return ${toJs(tree)};`) as (
        s: Record<string, number>,
      ) => number;
      expect(fn(scope)).toBeCloseTo(compile(src, Object.keys(scope))(scope), 10);
    }
  });

  it('writes only numbers, the scope and Math — never the text itself', () => {
    const js = toJs(parse('sin(x) + a', ['x', 'a']));
    expect(js).toBe('(Math.sin(s["x"])+s["a"])');
  });
});

describe('Greek typed straight in', () => {
  it('reads ωt as omega times t, and φ, θ by name', () => {
    expect(
      compile('A cos(ωt + φ)', ['A', 'omega', 't', 'phi'])({ A: 2, omega: 1, t: 0, phi: 0 }),
    ).toBe(2);
    expect(compile('sin(θ)', ['theta'])({ theta: Math.PI / 2 })).toBeCloseTo(1);
  });
});
