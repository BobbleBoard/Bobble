import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { compileSpec, evaluatorsScript, startValues, steadyYRange } from './build';
import { checkMath } from './checks';
import { ALL, FOURIER, KINETIC, SHM } from './fixtures';
import { renderMath } from './index';
import { mvPiLabel, mvRuns, mvScene, mvTicks, runtimeSource } from './runtime';
import { normalizeMathSpec, SpecError } from './spec';

const problems = (input: unknown) => renderMath(input).problems;
const fixes = (input: unknown) => problems(input).filter((p) => p.level === 'fix');

describe('the spec, as a small model writes it', () => {
  it('reads the loose forms: a bare curve, a slider shorthand, snake_case, a range in π', () => {
    const s = normalizeMathSpec({
      title: 'Waves',
      sliders: ['k = 2 in 1..10'],
      plot: { x_range: '-2pi..2pi', curves: ['y = sin(kx)', { f: 'cos(x)', color: 'reference' }] },
      steps: ['Drag k.'],
    });
    expect(s.params[0]).toMatchObject({ name: 'k', min: 1, max: 10, value: 2, step: 1 });
    expect(s.plot?.x).toMatchObject({ min: -2 * Math.PI, max: 2 * Math.PI, pi: true });
    expect(s.plot?.curves.map((c) => [c.expr, c.role])).toEqual([
      ['sin(kx)', 'main'],
      ['cos(x)', 'reference'],
    ]);
    expect(s.steps[0]).toEqual({ text: 'Drag k.', highlight: [], set: {} });
  });

  it('gives the first real curve the main colour, even after a reference', () => {
    const s = normalizeMathSpec(FOURIER);
    expect(s.plot?.curves.map((c) => c.role)).toEqual(['reference', 'main']);
  });

  it('slides a time smoothly and counts a count', () => {
    const s = normalizeMathSpec({
      ...SHM,
      params: ['t = 0 in 0..4', 'A = 1.5 in 0.5..2', 'n = 3 in 1..20'],
    });
    expect(s.params.find((p) => p.name === 't')?.step).toBeLessThan(0.05);
    expect(s.params.find((p) => p.name === 'n')?.step).toBe(1);
  });

  it('takes emoji out, and says so', () => {
    const s = normalizeMathSpec({
      title: '🌊 Waves ✨',
      plot: { curves: ['sin(x)'] },
      steps: ['Look 👀 at it.'],
    });
    expect(s.title).toBe('Waves');
    expect(s.steps[0]?.text).toBe('Look at it.');
    expect(s.notes.join(' ')).toMatch(/emoji removed/);
  });

  it('says what is wrong in words the next call can act on', () => {
    const bad = (spec: unknown) => () => normalizeMathSpec(spec);
    expect(bad({ title: 'x' })).toThrow(/needs a "plot".*or a "figure"/);
    expect(bad({ title: 'x', plot: { curves: ['sin(x'] } })).toThrow(SpecError);
    expect(bad({ title: 'x', plot: { curves: ['sin(q)'] } })).toThrow(/q/);
    expect(bad({ title: 'x', params: ['x = 1 in 0..2'], plot: { curves: ['x'] } })).toThrow(
      /cannot be named x/,
    );
    expect(bad({ title: 'x', figure: { shapes: [{ kind: 'blob', at: [0, 0] }] } })).toThrow(
      /not one of point, segment/,
    );
    expect(bad({ title: 'x', plot: { curves: ['x'], areas: [{ under: 'nope' }] } })).toThrow(
      /curves are c1/,
    );
  });
});

describe('the renderer the page runs is the one Node measured', () => {
  it('runs from its own text in an empty context, and draws the same scene', () => {
    const spec = renderMath(FOURIER).spec;
    const compiled = compileSpec(spec);
    const start = startValues(spec, compiled.E);
    const here = mvScene(spec, compiled.E, start, 2);
    const ctx = vm.createContext({});
    vm.runInContext(`${runtimeSource()}\nvar E = ${evaluatorsScript(compiled)};`, ctx);
    const there = vm.runInContext(
      `JSON.stringify(mvScene(${JSON.stringify(spec)}, E, ${JSON.stringify(start)}, 2))`,
      ctx,
    );
    expect(JSON.parse(there)).toEqual(JSON.parse(JSON.stringify(here)));
  });
});

describe('layout', () => {
  it('ticks in π when the range is written in π', () => {
    expect(mvTicks(-Math.PI, Math.PI, 8, true).map((t) => t.label)).toEqual([
      '−π',
      '−π/2',
      '0',
      'π/2',
      'π',
    ]);
    expect(mvPiLabel(3, 4)).toBe('3π/4');
    expect(mvTicks(0, 10, 5, false).map((t) => t.label)).toEqual(['0', '2', '4', '6', '8', '10']);
  });

  it('sets a label’s light TeX: scripts, Greek, a lone letter in italic', () => {
    expect(mvRuns('v_0^2')).toEqual([
      { s: 'v', it: true },
      { s: '0', sub: true },
      { s: '2', sup: true },
    ]);
    expect(
      mvRuns('\\omega t')
        .map((r) => r.s)
        .join(''),
    ).toBe('ω t');
    expect(mvRuns('molecule')).toEqual([{ s: 'molecule' }]);
  });

  it('holds the y-range still across the sliders, and leaves out a curve’s run to infinity', () => {
    const fourier = normalizeMathSpec({ ...FOURIER, plot: { ...FOURIER.plot, y: undefined } });
    const r = steadyYRange(fourier, compileSpec(fourier).E);
    expect(r.min).toBeLessThanOrEqual(-1.18);
    expect(r.max).toBeGreaterThanOrEqual(1.18);
    const tan = normalizeMathSpec({ title: 't', plot: { x: '-pi..pi', curves: ['tan(x)'] } });
    const t = steadyYRange(tan, compileSpec(tan).E);
    expect(t.clipped).toBe(true);
    expect(t.max).toBeLessThan(100);
  });

  it('breaks a curve where it jumps, rather than drawing the jump', () => {
    const spec = renderMath({
      title: 't',
      plot: { x: '-pi..pi', y: '-5..5', curves: ['tan(x)'] },
    }).spec;
    const path = mvScene(spec, compileSpec(spec).E, {}, 0).panels[0]?.items.find(
      (i) => i.t === 'path' && i.id === 'c1',
    );
    expect(path?.t === 'path' && (path.d.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the checks', () => {
  it('passes every lesson fixture with nothing to fix', () => {
    for (const [name, spec] of Object.entries(ALL)) expect([name, fixes(spec)]).toEqual([name, []]);
  });

  it('catches labels on labels when there is no room to move them apart, and names both', () => {
    // Three nearly coincident points: the layout finds each label a clear spot by itself.
    const three = (k: number) =>
      Array.from({ length: k }, (_, i) => ({
        id: `p${i}`,
        kind: 'point',
        at: [5 + i * 0.05, 5],
        label: `label number ${i + 1}`,
      }));
    const room = {
      title: 'Room',
      figure: { view: { x: '0..10', y: '0..10' }, shapes: three(3) },
      steps: [{ text: 'See {p0}.', highlight: ['p0'] }],
    };
    expect(fixes(room)).toEqual([]);
    // Twelve: the eight spots around a point run out.
    const crowd = { ...room, figure: { view: { x: '0..10', y: '0..10' }, shapes: three(12) } };
    expect(
      fixes(crowd)
        .map((x) => x.text)
        .join('\n'),
    ).toMatch(/labels overlap in the figure: “label number \d+” and “label number \d+” — move one/);
  });

  it('catches a part off the view — the box that ran past the top, at every step, said once', () => {
    const p = fixes({ ...KINETIC, figure: { ...KINETIC.figure, view: { x: '0..10', y: '0..7' } } });
    expect(p).toHaveLength(1);
    expect(p[0]?.text).toMatch(
      /^box at \(8\.56, 7\.56\) is outside the figure \(x 0 to 10, y 0 to 7\)$/,
    );
  });

  it('warns of a slider that moves nothing, a step naming no part, and steps tied to nothing', () => {
    const texts = problems({
      title: 'Loose',
      params: ['a = 1 in 0..2'],
      plot: { x: '0..1', curves: ['x^2'] },
      steps: [{ text: 'First.', highlight: ['nope'] }, 'Second.', 'Third.'],
    }).map((x) => x.text);
    expect(texts).toContain('slider a moves nothing — use it in an expression, or remove it');
    expect(texts.join('\n')).toMatch(
      /step 1 highlights “nope”, which is not a part — the parts are c1/,
    );
    expect(texts.join('\n')).toMatch(/steps 2, 3 point at nothing in the figure/);
  });

  it('warns of a wall of text and of a list for a step', () => {
    const long = Array.from({ length: 90 }, () => 'word').join(' ');
    const texts = problems({
      title: 'Words',
      plot: { x: '0..1', curves: [{ id: 'f', expr: 'x' }] },
      steps: [
        { text: long, highlight: ['f'] },
        { text: '- one\n- two\n- three', highlight: ['f'] },
      ],
    }).map((x) => x.text);
    expect(texts.join('\n')).toMatch(/step 1 is 90 words/);
    expect(texts.join('\n')).toMatch(/step 2 is a list/);
  });

  it('flags a curve with no values, and one flat where it should move', () => {
    const texts = problems({
      title: 'Bad',
      plot: { x: '1..2', curves: ['sqrt(-x)', '0*x'] },
      steps: [],
    }).map((x) => x.text);
    expect(texts.join('\n')).toMatch(/curve c1 has no value anywhere/);
    expect(texts.join('\n')).toMatch(/curve c2 is flat everywhere/);
  });
});

describe('the page', () => {
  const { html } = renderMath(SHM);

  it('stands alone: typeset maths with its fonts inside, no outside script or style', () => {
    expect(html).toContain('class="katex"');
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet/);
  });

  it('wears the kit — its paper and ink, light and dark — and carries no emoji', () => {
    expect(html).toContain('--mv-paper:#FBFAF7');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('has the sliders, Play, and the steps the script wires', () => {
    for (const hook of [
      'data-mv-param="t"',
      'data-mv-play="t"',
      'data-mv-step',
      'data-mv-next',
      'data-mv-ref="mass"',
    ]) {
      expect(html).toContain(hook);
    }
  });

  it('keeps the page’s data from closing its script early', () => {
    const r = renderMath({
      title: 'a </script> b',
      plot: { curves: ['x'] },
      steps: ['</script><b>'],
    });
    expect(r.html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('draws the checks’ scene: what was measured is what is shown', () => {
    const spec = normalizeMathSpec(SHM);
    const c = compileSpec(spec);
    expect(checkMath(spec, c.E, c.reads).filter((p) => p.level === 'fix')).toEqual([]);
  });
});

describe('the words a small model uses for the same things', () => {
  it('reads default for a slider’s start, content for a step, expression for a curve, objects for shapes', () => {
    const s = normalizeMathSpec({
      title: 'Aliases',
      params: [{ name: 'a', min: 0, max: 2, default: 1.5 }],
      plot: { x: '0..1', curves: [{ id: 'f', expression: 'a*x' }] },
      figure: { view: { x: '0..1', y: '0..1' }, objects: [{ type: 'dot', at: [0.5, 0.5] }] },
      steps: [{ title: 'Slope', content: 'The slope is $a$.', highlight: ['f'] }],
    });
    expect(s.params[0]?.value).toBe(1.5);
    expect(s.plot?.curves[0]?.expr).toBe('a*x');
    expect(s.figure?.shapes[0]?.kind).toBe('point');
    expect(s.steps[0]?.text).toBe('**Slope.** The slope is $a$.');
  });
});
