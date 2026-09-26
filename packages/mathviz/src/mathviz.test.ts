import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { compileSpec, evaluatorsScript, startValues, steadyYRange } from './build';
import { checkMath } from './checks';
import { ALL, FOURIER, KINETIC, PYTHAGORAS, SHM } from './fixtures';
import { renderMath } from './index';
import { mvPiLabel, mvRuns, mvScene, mvTicks, runtimeSource } from './runtime';
import { lenientJson, normalizeMathSpec, SpecError } from './spec';

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
    expect(bad({ title: 'x', params: ['x = 1 in 0..2'], plot: { curves: ['x'] } })).toThrow(
      /cannot be named x/,
    );
    expect(bad({ title: 'x', figure: { shapes: [{ kind: 'blob', size: 3 }] } })).toThrow(
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

describe('TeX typed into JSON with one backslash', () => {
  it('is TeX — not a form feed, a tab or a parse error — and a real newline stays one', () => {
    const json = String.raw`{"title": "Waves", "plot": {"curves": [{"id": "f", "expr": "\sin(x)", "label": "\theta"}]}, "steps": [{"text": "Half is $\frac{1}{2}$, and \\frac stays.\nThe end.", "highlight": ["f"]}]}`;
    const s = normalizeMathSpec(json);
    expect(s.plot?.curves[0]?.expr).toBe(String.raw`\sin(x)`);
    // A label is drawn text: its TeX command is the character it draws.
    expect(s.plot?.curves[0]?.label).toBe('θ');
    expect(s.steps[0]?.text).toBe('Half is $\\frac{1}{2}$, and \\frac stays.\nThe end.');
  });
});

describe('a spec written like code', () => {
  it('reads comments, single quotes, bare keys and trailing commas — and leaves strings alone', () => {
    const js = `{
      // the plot
      title: 'Don\\'t "panic"', /* a block */
      plot: { x: '0..1', curves: ['x^2',], },
      steps: ['Look: // this is text, not a comment',],
    }`;
    const s = normalizeMathSpec(js);
    expect(s.title).toBe('Don\'t "panic"');
    expect(s.plot?.curves[0]?.expr).toBe('x^2');
    expect(s.steps[0]?.text).toBe('Look: // this is text, not a comment');
  });
  it('still says where strict JSON broke when it is beyond saving', () => {
    expect(() => normalizeMathSpec('{"title": "x", plot: {')).toThrow(/not JSON/);
  });
});

describe('more of what a small model writes', () => {
  it('a name it did not declare is drawn as 1, and the note says how to declare it', () => {
    const s = normalizeMathSpec({ title: 'k', plot: { curves: ['k*x'] } });
    expect(s.params.find((p) => p.name === 'k')).toMatchObject({ value: 1, hidden: true });
    expect(s.notes.join(' ')).toMatch(
      /k has no value in the spec, so it is drawn as 1 — give it a number, or make it a slider \("k = 2 in 1\.\.4"\)/,
    );
  });

  it('an open line through points — a trajectory — and a "line" with points is one', () => {
    const r = renderMath({
      title: 'A throw',
      figure: {
        view: { x: '0..10', y: '0..6' },
        shapes: [
          {
            id: 'path',
            kind: 'trajectory',
            points: [
              [0, 0],
              [2, 3],
              [5, 4.5],
              [8, 3],
              [10, 0],
            ],
            label: 'path of the ball',
            dashed: true,
          },
          {
            id: 'ground',
            type: 'line',
            points: [
              [0, 0],
              [10, 0],
            ],
          },
        ],
      },
      steps: [{ text: 'The ball follows a {path}.', highlight: ['path'] }],
    });
    expect(r.spec.figure?.shapes.map((sh) => sh.kind)).toEqual(['polyline', 'polyline']);
    expect(r.problems.filter((p) => p.level === 'fix')).toEqual([]);
    expect(r.html).toContain('data-id="path"');
  });

  it('steps written as numbered keys read in order', () => {
    const s = normalizeMathSpec({
      title: 's',
      plot: { curves: ['x'] },
      steps: { 1: 'First.', 2: 'Second.' },
    });
    expect(s.steps.map((x) => x.text)).toEqual(['First.', 'Second.']);
  });
});

describe('JSON with bare values, as the 4B wrote it', () => {
  it('quotes ranges and expressions it cannot read as JSON (MEASURED: ten parses of one SHM spec)', () => {
    const raw = `{"title":"SHM","params":["A=1 in 0.5..2","t=0 in 0..12"],"figure":{"view":{"x":-2..2,"y":-3..3},"shapes":[{"id":"spring","kind":"spring","from":[0,2],"to":[0,A*cos(2*t)]}, {"id":"m","kind":"point","at":[max(0, 1), 0.5]}]}, // a comment
      "steps": [{"text": "Play t.", "highlight": ["spring"], "set": {"t": 0}}], "play": None}`;
    const v = lenientJson(raw) as {
      figure: { view: { x: string }; shapes: Array<{ to?: unknown[]; at?: unknown[] }> };
      play: unknown;
    };
    expect(v.figure.view.x).toBe('-2..2');
    expect(v.figure.shapes[0]?.to).toEqual([0, 'A*cos(2*t)']);
    expect(v.figure.shapes[1]?.at).toEqual(['max(0, 1)', 0.5]);
    expect(v.play).toBeNull();
    // And the spec it is draws.
    expect(() => renderMath(raw)).not.toThrow();
  });
});

describe('what the 4B wrote in the STEM suite, drawn', () => {
  it('SHM with ω and φ, no sliders, "x(t) =": the plot is over t, a phase is a slider, the rest values', () => {
    const r = renderMath({ title: 'SHM', equation: 'x(t) = A cos(ωt + φ)' });
    expect(r.spec.plot?.v).toBe('t');
    expect(r.spec.params.map((p) => [p.name, p.hidden === true])).toEqual([
      ['A', true],
      ['omega', true],
      ['phi', false],
    ]);
    // It draws; what is left to fix is that it explains nothing yet.
    expect(r.problems.filter((p) => p.level === 'fix').map((p) => p.text)).toEqual([
      expect.stringMatching(/^the page has no steps/),
    ]);
  });

  it('a cube in L, and points in x, y, z, drawn in the box3d view', () => {
    const r = renderMath({
      title: 'Molecule in a cube',
      figure: {
        view: { x: '0..L', y: '0..L', z: '0..L' },
        shapes: [
          { id: 'box', kind: 'box3d', at: [0, 0], size: 'L', depth: 'L', edge: 'L' },
          { id: 'm', kind: 'point', at: ['L/2', 'L/2', 'L/2'], label: 'molecule' },
          {
            id: 'u',
            kind: 'vector',
            from: ['L/2', 'L/2', 'L/2'],
            to: ['0.9*L', 'L/2', 'L/2'],
            label: 'u',
          },
        ],
      },
      steps: [{ text: 'The {m} moves with speed {u}.', highlight: ['m', 'u'] }],
    });
    expect(r.spec.figure?.x[1]).toBeCloseTo(1.8);
    expect(r.problems.filter((p) => p.level === 'fix')).toEqual([]);
  });
});

describe('a value the spec never declared', () => {
  it('is no slider on the page and no "moves nothing" warning', () => {
    const r = renderMath({
      title: 'Wave',
      plot: { curves: ['A*sin(x)'] },
      steps: [{ text: 'A wave.', highlight: ['c1'] }],
    });
    expect(r.html).not.toContain('data-mv-param="A"');
    expect(r.problems.map((p) => p.text).join('\n')).not.toMatch(/slider A moves nothing/);
    expect(r.problems.map((p) => p.text).join('\n')).toMatch(/A has no value in the spec/);
  });
});

describe('the physics words for shapes', () => {
  it('reads a sphere, a mass and a bob as filled circles, and a block or a wall as a rectangle', () => {
    const s = normalizeMathSpec({
      title: 'Kinds',
      figure: {
        shapes: [
          { id: 'a', kind: 'sphere', center: [2, 2], r: 0.5 },
          { id: 'b', kind: 'mass', center: [4, 2], r: 0.5 },
          { id: 'c', kind: 'block', at: [6, 1], w: 2, h: 1 },
        ],
      },
    });
    expect(s.figure?.shapes.map((sh) => [sh.kind, 'fill' in sh ? sh.fill : undefined])).toEqual([
      ['circle', 'main'],
      ['circle', 'main'],
      ['polygon', 'none'],
    ]);
  });
});

describe('STEM run 3: what the 4B wrote, and what it could not see', () => {
  const cube = (view: unknown, size: unknown, extra: Record<string, unknown> = {}) => ({
    title: 'Molecule bouncing in a cube',
    figure: {
      view,
      shapes: [
        { id: 'cube', kind: 'box3d', at: [0, 0, 0], size, ...extra },
        { id: 'molecule', kind: 'circle', at: [0.25, 0.25, 0.25], r: 0.08, fill: 'main' },
        { id: 'u', kind: 'vector', from: [0.25, 0.25, 0.25], to: [0.75, 0.25, 0.25], label: 'u' },
      ],
    },
    steps: [
      { text: 'The cube has side L.', highlight: ['cube'] },
      { text: 'A molecule moves at u.', highlight: ['molecule', 'u'] },
    ],
  });

  it('one number for a view is no range: the view fits the shapes, and a note says how to choose it', () => {
    const r = renderMath(cube({ x: -2, y: -2, z: -2 }, [1, 1, 1]));
    const fig = r.spec.figure;
    // The cube's far corner, in the oblique view: 1 + 0.8, 1 + 0.55.
    expect(fig?.x[0]).toBeLessThan(0);
    expect(fig?.x[1]).toBeGreaterThan(1.8);
    expect(fig?.y[1]).toBeGreaterThan(1.55);
    expect(fig?.x[1]).toBeLessThan(2.5);
    expect(fig?.fit).toBeUndefined();
    expect(r.problems.map((p) => p.text)).toContain(
      'the figure\'s x is one number (-2), not a range, so the view fits the shapes — write "x": "-2..2" to choose it',
    );
    expect(r.problems.filter((p) => p.level === 'fix')).toEqual([]);
  });

  it('a box is sized [w, h, d] or {w, h, d}; a size of three wins over a "depth" of its own', () => {
    const box = (shape: Record<string, unknown>) =>
      normalizeMathSpec({ title: 'B', figure: { view: { x: '0..5', y: '0..5' }, shapes: [shape] } })
        .figure?.shapes[0];
    expect(box({ kind: 'box3d', size: [2, 1, 0.5] })).toMatchObject({ w: 2, h: 1, depth: 0.5 });
    expect(box({ kind: 'box', size: { w: 3, h: 2, d: 1 } })).toMatchObject({
      w: 3,
      h: 2,
      depth: 1,
    });
    expect(box({ kind: 'cube', size: 2 })).toMatchObject({ w: 2, h: 2, depth: 1 });
    expect(box({ kind: 'box3d', size: [1, 1, 1], depth: 0.2 })).toMatchObject({ depth: 1 });
    expect(box({ kind: 'box3d', size: 1, depth: 0.2 })).toMatchObject({ depth: 0.2 });
  });

  it('no title is a plain one, with a note — the real problem is said first', () => {
    const s = normalizeMathSpec({
      name: 'cube_molecule',
      figure: cube({ x: '0..2', y: '0..2' }, 1).figure,
    });
    expect(s.title).toBe('Cube molecule');
    const untitled = normalizeMathSpec({ plot: { x: '0..1', curves: ['x'] } });
    expect(untitled.title).toBe('Graph');
    expect(untitled.notes.join(' ')).toMatch(/no "title"/);
    expect(() =>
      normalizeMathSpec({ name: 'cube_molecule', parts: { cube: 'Cube of side L' } }),
    ).toThrow(/needs a "plot".*Something that moves.*"play": "t"/);
  });

  it('two arrows on the same two ends are said: one hides the other', () => {
    const spec = cube({ x: '-1..3', y: '-1..3' }, 1);
    const shapes = [
      ...spec.figure.shapes,
      {
        id: 'dp',
        kind: 'vector',
        from: [0.25, 0.25, 0.25],
        to: [0.75, 0.25, 0.25],
        label: 'Δp = 2mu',
      },
    ];
    expect(fixes({ ...spec, figure: { ...spec.figure, shapes } }).map((p) => p.text)).toContain(
      'u and dp are drawn in the same place, so one hides the other — give each its own position (or make them one part)',
    );
  });

  it('labels with no clear spot are said once, as one list — and a smaller view spreads them', () => {
    // MEASURED: the 4B's own unit circle, a view seven units wide.
    const lesson = (view: string, axis: number) => ({
      title: 'Why d/dx(sin x) = cos x',
      figure: {
        view: { x: view, y: view },
        shapes: [
          {
            id: 'unitCircle',
            kind: 'circle',
            center: [0, 0],
            r: 1,
            fill: 'tint',
            label: 'Unit circle',
          },
          { id: 'theta', kind: 'angle', at: [0.5, 0], from: [0, 0], to: [1, 0.87], label: 'θ' },
          { id: 'point', kind: 'point', at: [1, 0.87], label: '(cos θ, sin θ)' },
          { id: 'radius', kind: 'line', from: [0, 0], to: [1, 0.87], label: 'r = 1' },
          { id: 'xProj', kind: 'point', at: [1, 0], label: 'x = cos θ' },
          { id: 'yProj', kind: 'point', at: [0, 0.87], label: 'y = sin θ' },
          { id: 'xLine', kind: 'line', from: [0, 0], to: [1, 0], label: 'x = cos θ' },
          { id: 'yLine', kind: 'line', from: [0, 0], to: [0, 0.87], label: 'y = sin θ' },
          {
            id: 'tangent',
            kind: 'line',
            from: [0.9, 0.8],
            to: [1.1, 1],
            label: 'tangent direction',
          },
          { id: 'slope', kind: 'line', from: [0.5, 0.5], to: [1.2, 1.2], label: 'slope = cos θ' },
          { id: 'xAxis', kind: 'line', from: [-axis, 0], to: [axis, 0], label: 'x-axis' },
          { id: 'yAxis', kind: 'line', from: [0, -axis], to: [0, axis], label: 'y-axis' },
          { id: 'thetaLabel', kind: 'label', at: [1.1, 0.9], text: 'θ' },
        ],
      },
      steps: [
        { text: 'A point at angle θ.', highlight: ['point', 'theta'] },
        { text: 'Its coordinates.', highlight: ['xLine', 'yLine'] },
      ],
    });
    const crowded = (spec: unknown) => fixes(spec).filter((p) => /crowded/.test(p.text));
    const tight = crowded(lesson('-3.5..3.5', 3.5));
    expect(tight.length).toBe(1);
    expect(tight[0]?.text).toMatch(
      /^labels are crowded in the figure: .*“y = sin θ”.* — the parts are too close together for their labels: make the view smaller/,
    );
    const named = (t: string | undefined) => (t?.match(/“[^”]+”/g) ?? []).length;
    const zoomed = crowded(lesson('-1.6..1.6', 1.5));
    expect(named(zoomed[0]?.text)).toBeLessThan(named(tight[0]?.text));
  });
});

describe('motion: parts that slide, fade and take turns', () => {
  it('lerp, ease, between and clamp read the same in Node and on the page', () => {
    const spec = normalizeMathSpec({
      title: 'M',
      params: ['t = 0 in 0..3'],
      figure: {
        view: { x: '0..4', y: '0..4' },
        shapes: [
          { id: 'p', kind: 'point', at: ['lerp(0, 4, ease(between(t, 1, 2)))', 'clamp(t, 0, 2)'] },
        ],
      },
      steps: [],
    });
    const c = compileSpec(spec);
    const page = vm.runInNewContext(`(${evaluatorsScript(c)})`, { Math }) as Record<
      string,
      (s: object) => number
    >;
    for (const t of [0, 1, 1.25, 1.5, 2, 3]) {
      for (const src of ['lerp(0, 4, ease(between(t, 1, 2)))', 'clamp(t, 0, 2)']) {
        expect(page[src]?.({ t })).toBeCloseTo(c.E[src]?.({ t }) ?? Number.NaN, 12);
      }
    }
    expect(c.E['lerp(0, 4, ease(between(t, 1, 2)))']?.({ t: 1.5 })).toBeCloseTo(2, 12);
    expect(c.E['lerp(0, 4, ease(between(t, 1, 2)))']?.({ t: 0.5 })).toBe(0);
  });

  it('a part at opacity 0 is not drawn; between, it is drawn at its opacity', () => {
    const spec = normalizeMathSpec(PYTHAGORAS);
    const c = compileSpec(spec);
    const ids = (t: number) =>
      mvScene(spec, c.E, { t }, 1)
        .panels[0]?.items.filter((it) => it.id === 'c2' && it.t === 'path')
        .map((it) => it.alpha ?? 1) ?? [];
    expect(ids(0)).toEqual([1]);
    expect(ids(0.3)[0]).toBeGreaterThan(0);
    expect(ids(0.3)[0]).toBeLessThan(1);
    expect(ids(1)).toEqual([]);
  });

  it('the rearrangement proof draws, and its checks are clear at every step', () => {
    const r = renderMath(PYTHAGORAS);
    expect(r.problems.filter((p) => p.level !== 'note')).toEqual([]);
    expect(r.html).toContain('opacity=');
  });
});

describe('the 4B, asked for maths that explains itself (2026-09-26)', () => {
  const fig = (shapes: unknown[], extra: Record<string, unknown> = {}) =>
    normalizeMathSpec({
      title: 'F',
      figure: { view: { x: '0..10', y: '0..10' }, shapes },
      ...extra,
    });

  it('reads a shape kind it does not name from what the shape carries', () => {
    const s = fig([
      {
        id: 'tri',
        kind: 'right_triangle',
        vertices: [
          [0, 0],
          [3, 0],
          [0, 4],
        ],
      },
      { id: 'arc', kind: 'arc', center: [0, 0], from: [3, 0], to: [0, 4], label: 'θ' },
      { id: 'ball', kind: 'projectile', center: [1, 1], radius: 0.2 },
      { id: 'name', kind: 'caption', pos: [5, 5], text: 'a = 3' },
    ]);
    expect(s.figure?.shapes.map((x) => x.kind)).toEqual(['polygon', 'angle', 'circle', 'label']);
  });

  it('reads sliders as "a = 3", "Slope (m)", and a dictionary of ranges and values', () => {
    const a = normalizeMathSpec({
      title: 'P',
      params: ['a = 3', 't = angle in 0..360'],
      plot: { x: '0..1', curves: ['a*x'] },
    });
    expect(a.params.find((p) => p.name === 'a')).toMatchObject({ value: 3, hidden: true });
    expect(a.params.find((p) => p.name === 't')).toMatchObject({ min: 0, max: 360, value: 0 });
    const m = normalizeMathSpec({
      title: 'L',
      sliders: [{ name: 'Slope (m)', min: -5, max: 5, value: 1 }],
      plot: { x: '-5..5', curves: ['m*x'] },
    });
    expect(m.params[0]).toMatchObject({ name: 'm', label: 'Slope', value: 1 });
    const d = normalizeMathSpec({
      title: 'D',
      params: { t: { min: 0, max: 3.5 }, g: 9.8, v: '10..30' },
      plot: { x: '0..3', curves: ['v*x - g*x^2/2 + t'] },
    });
    expect(d.params.map((p) => [p.name, p.hidden === true])).toEqual([
      ['t', false],
      ['g', true],
      ['v', false],
    ]);
  });

  it('draws "$h(t)$" in a label as h(t), and \\theta as θ', () => {
    const s = fig([{ id: 'p', kind: 'point', at: [1, 1], label: '$h(t)$ at \\theta' }]);
    expect(s.figure?.shapes[0]).toMatchObject({ label: 'h(t) at θ' });
  });

  it('draws a curve from a formula, over a range the sliders can move: the path so far', () => {
    const r = renderMath({
      title: 'Thrown',
      params: ['t = 1 in 0..2'],
      figure: {
        view: { x: '0..20', y: '0..6' },
        shapes: [
          {
            id: 'path',
            kind: 'trajectory',
            x: '10*s',
            y: '8*s - 4.9*s^2',
            range: '0..t',
            label: 'path',
          },
          { id: 'ball', kind: 'circle', center: ['10*t', '8*t - 4.9*t^2'], r: 0.3, fill: 'main' },
        ],
      },
      steps: [
        {
          text: 'The {ball} leaves its path behind it.',
          highlight: ['ball', 'path'],
          set: { t: 0.5 },
        },
        { text: 'By t = 1.5 it is falling.', highlight: ['ball'], set: { t: 1.5 } },
      ],
    });
    const sh = r.spec.figure?.shapes[0];
    expect(sh).toMatchObject({ kind: 'curve', over: 's', from: 0, to: 't' });
    const c = compileSpec(r.spec);
    const len = (t: number) =>
      (
        mvScene(r.spec, c.E, { t }, 1).panels[0]?.items.find(
          (it) => it.id === 'path' && it.t === 'path',
        ) as { d: string } | undefined
      )?.d.length ?? 0;
    expect(len(1.5)).toBeGreaterThan(len(0.5) * 0.9);
    expect(r.problems.filter((p) => p.level === 'fix')).toEqual([]);
  });

  it('slides, turns and scales a part as a slider runs — written as the move', () => {
    const s = fig(
      [
        {
          id: 'tri',
          kind: 'polygon',
          points: [
            [0, 0],
            [2, 0],
            [0, 1],
          ],
          fill: 'main',
          slide: { by: [3, 1], t: '0..1' },
        },
        {
          id: 'sq',
          kind: 'polygon',
          points: [
            [5, 5],
            [6, 5],
            [6, 6],
            [5, 6],
          ],
          turn: { by: 90, t: '1..2' },
        },
        { id: 'c', kind: 'circle', center: [8, 8], r: 0.5, scale: 2 },
      ],
      { params: ['t = 0 in 0..2'] },
    );
    const c = compileSpec(s);
    const P = (id: string, t: number) => {
      const sh = s.figure?.shapes.find((x) => x.id === id);
      if (sh?.kind !== 'polygon') return [];
      return sh.points.map((p) => [mvEvalNum(c.E, p[0], t), mvEvalNum(c.E, p[1], t)]);
    };
    expect(P('tri', 0)[0]).toEqual([0, 0]);
    expect(P('tri', 1)[0]?.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([3, 1]);
    // 90° about its own centre (5.5, 5.5): the corner (5, 5) goes to (6, 5).
    expect(P('sq', 2)[0]?.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([6, 5]);
    const circ = s.figure?.shapes.find((x) => x.id === 'c');
    expect(circ?.kind === 'circle' && mvEvalNum(c.E, circ.r, 2)).toBeCloseTo(1, 6);
  });
});

function mvEvalNum(
  E: Record<string, (s: Record<string, number>) => number>,
  v: unknown,
  t: number,
): number {
  return typeof v === 'number' ? v : (E[String(v)]?.({ t }) ?? Number.NaN);
}

describe('JavaScript a small model writes into JSON', () => {
  it('joins "m = " + m into the label that shows m live', () => {
    const s = normalizeMathSpec(
      '{"title": "L", "params": ["m = 1 in -5..5"], "figure": {"view": {"x": "0..10", "y": "0..10"}, "shapes": [{"id": "lab", "kind": "label", "at": [5, 5], "text": "m = " + m.toFixed(2) + " (slope)"}]}, "steps": ["The slope.", "Steeper."]}',
    );
    expect(s.figure?.shapes[0]).toMatchObject({ kind: 'label', text: 'm = {m} (slope)' });
  });

  it('says so when no step moves anything on a page with sliders', () => {
    const r = renderMath({
      title: 'Still',
      params: ['t = 0 in 0..2'],
      figure: {
        view: { x: '0..4', y: '0..4' },
        shapes: [{ id: 'b', kind: 'circle', center: ['t', 1], r: 0.2 }],
      },
      steps: [
        { text: 'A ball.', highlight: ['b'] },
        { text: 'It moves.', highlight: ['b'] },
      ],
    });
    expect(r.problems.map((p) => p.text)).toContain(
      'none of the steps moves anything — the page plays its steps like a teacher, so give steps a "set" that moves t (the figure moves while the words appear), or a "nudge" that wiggles a slider to show what it changes',
    );
  });
});
