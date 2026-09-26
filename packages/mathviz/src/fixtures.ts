/**
 * Specs as a model would write them for the lessons the visual suite asks
 * for — and the one the user held up (a Fourier series, 2026-09-25) and the
 * kinetic-theory figure he attached (a cube, a molecule, its velocity).
 */
export const FOURIER = {
  title: 'Building a square wave from sine waves',
  caption: 'Each term adds a faster, smaller sine. Drag $n$ to add terms.',
  params: ['n = 1 in 1..25'],
  plot: {
    x: '-pi..pi',
    y: '-1.6..1.6',
    curves: [
      { id: 'sq', expr: 'sign(sin(x))', label: 'square wave', role: 'reference' },
      { id: 'sum', expr: '4/pi * sum(k, 1, n, sin((2k-1)x)/(2k-1))', label: 'sum of {n} terms' },
    ],
  },
  steps: [
    {
      text: 'The target is the {sq}: $+1$ for half a period, $-1$ for the other half.',
      highlight: ['sq'],
      set: { n: 1 },
    },
    {
      text: 'One term is a single sine, $\\frac{4}{\\pi}\\sin x$ — already the right shape, but round.',
      highlight: ['sum'],
      set: { n: 1 },
    },
    {
      text: 'Three terms add $\\sin 3x$ and $\\sin 5x$. The corners start to sharpen.',
      highlight: ['sum', 'sq'],
      set: { n: 3 },
    },
    {
      text: 'With 25 terms the {sum} hugs the square wave, except for a small overshoot at each jump (the Gibbs phenomenon).',
      highlight: ['sum'],
      set: { n: 25 },
    },
  ],
};

export const KINETIC = {
  title: 'A molecule in a cubical box',
  caption: 'Kinetic theory: the pressure a gas exerts comes from molecules hitting the walls.',
  figure: {
    view: { x: '0..10', y: '0..9' },
    shapes: [
      { id: 'box', kind: 'box3d', at: [1, 0.8], size: 5, depth: 3.2, shade: 'right', edge: 'L' },
      { id: 'mol', kind: 'point', at: [3, 3], label: 'molecule, mass m' },
      { id: 'u', kind: 'vector', from: [3, 3], to: [5.4, 3], label: 'u' },
      { id: 'wall', kind: 'label', at: [8.6, 5.2], text: 'shaded face' },
    ],
  },
  steps: [
    { text: 'A single {mol} moves inside a cube of side $L$.', highlight: ['mol', 'box'] },
    {
      text: 'Its velocity towards the shaded face is {u}. It hits the face and bounces back with velocity $-u$.',
      highlight: ['u'],
    },
    {
      text: 'Its momentum changes by $2mu$ each collision, and it returns every $2L/u$ seconds, so the force on the face is $\\frac{mu^2}{L}$.',
      highlight: ['wall', 'u'],
    },
  ],
};

export const SHM = {
  title: 'Simple harmonic motion',
  caption: 'A mass on a spring, and its displacement over time.',
  params: [{ name: 't', min: 0, max: 4, value: 0, label: 't' }, 'A = 1.5 in 0.5..2'],
  play: 't',
  figure: {
    view: { x: '-3..3', y: '-3.2..4' },
    shapes: [
      { id: 'ceiling', kind: 'segment', from: [-1.4, 3.6], to: [1.4, 3.6] },
      { id: 'spring', kind: 'spring', from: [0, 3.6], to: [0, 'A*cos(pi*t) + 0.45'], coils: 12 },
      { id: 'mass', kind: 'circle', center: [0, 'A*cos(pi*t)'], r: 0.45, fill: 'main', label: 'm' },
      {
        id: 'eq',
        kind: 'segment',
        from: [-2.2, 0],
        to: [2.2, 0],
        dashed: true,
        label: 'equilibrium',
      },
    ],
  },
  plot: {
    var: 't',
    x: { range: '0..4', label: 't (s)' },
    y: { range: '-2.2..2.2', label: 'x (m)' },
    curves: [{ id: 'x', expr: 'A*cos(pi*t)', label: 'x = A cos(ωt)' }],
    points: [{ id: 'now', x: 't', y: 'A*cos(pi*t)', label: 'now' }],
  },
  steps: [
    {
      text: 'The {mass} hangs from a spring. At rest it sits at the {eq}.',
      highlight: ['mass', 'eq'],
      set: { t: 0 },
    },
    {
      text: 'Pulled down and let go, it moves back and forth. Press play: the {now} traces its displacement.',
      highlight: ['mass', 'now', 'x'],
    },
    {
      text: 'The curve is $x = A\\cos(\\omega t)$. A bigger amplitude $A$ swings further, but the period stays the same.',
      highlight: ['x', 'mass'],
      set: { A: 2 },
      nudge: { A: -0.6 },
    },
  ],
};

export const TANGENT = {
  title: 'Why the derivative of sin x is cos x',
  params: ['a = 0 in -3.14..3.14'],
  plot: {
    x: '-pi..pi',
    curves: [
      { id: 'f', expr: 'sin(x)', label: 'sin x' },
      { id: 'g', expr: 'cos(x)', label: 'cos x', role: 'second', step: 3 },
    ],
    tangents: [{ id: 'tan', to: 'f', at: 'a', label: 'slope {m}' }],
    points: [{ id: 'p', x: 'a', y: 'cos(a)', label: '(a, cos a)', step: 3 }],
  },
  steps: [
    {
      text: 'The {tan} touches {f} at $x = a$. Its slope is the derivative there.',
      highlight: ['f', 'tan'],
      set: { a: 0 },
    },
    {
      text: 'At the top of the curve, $x = \\pi/2$, the tangent is flat: slope $0$.',
      highlight: ['tan'],
      set: { a: 1.5708 },
    },
    {
      text: 'Plot the slope at every $a$ and you trace {g}: the dot {p} rides it as you drag $a$.',
      highlight: ['g', 'p', 'tan'],
      set: { a: -1 },
    },
  ],
};

export const INTEGRAL = {
  title: 'The area under a curve',
  params: ['n = 4 in 1..40'],
  plot: {
    x: '0..3.2',
    y: '0..10',
    curves: [{ id: 'f', expr: 'x^2', label: 'y = x^2' }],
    riemann: [{ id: 'rect', under: 'f', from: 0, to: 3, n: 'n', rule: 'mid' }],
    areas: [{ id: 'area', under: 'f', from: 0, to: 3, label: 'area = 9', step: 3 }],
  },
  steps: [
    {
      text: 'Cut the region under {f} from $0$ to $3$ into $n$ rectangles.',
      highlight: ['f', 'rect'],
      set: { n: 4 },
    },
    { text: 'More rectangles fit the curve more closely.', highlight: ['rect'], set: { n: 30 } },
    {
      text: 'In the limit their total is the integral: $\\int_0^3 x^2\\,dx = 9$, the {area}.',
      highlight: ['area'],
    },
  ],
};

/**
 * THE REARRANGEMENT PROOF — the user (2026-09-26): "if asked for pythagorean
 * theorem explanation visually, do you have text that appears side by side
 * as the triangles are rearranged within the square", then "triangles could
 * be a solid color". One slider t runs the three moves in turn (between),
 * each eased (ease), in an order where no triangle crosses another; the tilted
 * c² fades as the first leaves and a², b² fade in as the last lands.
 */
const move = (k: number) => `ease(between(t, ${k - 1}, ${k}))`;
export const PYTHAGORAS = {
  title: 'Why a² + b² = c²',
  caption: 'Four copies of one right triangle, moved inside the same square.',
  params: ['t = 0 in 0..3'],
  play: 't',
  figure: {
    view: { x: '-0.6..4.6', y: '-0.9..4.4' },
    shapes: [
      {
        id: 'c2',
        kind: 'polygon',
        points: [
          [1.5, 0],
          [4, 1.5],
          [2.5, 4],
          [0, 2.5],
        ],
        fill: 'second-light',
        label: 'c²',
        opacity: '1 - ease(between(t, 0, 0.5))',
      },
      {
        id: 'a2',
        kind: 'polygon',
        points: [
          [0, 0],
          [1.5, 0],
          [1.5, 1.5],
          [0, 1.5],
        ],
        fill: 'second-light',
        label: 'a²',
        opacity: 'ease(between(t, 2.5, 3))',
      },
      {
        id: 'b2',
        kind: 'polygon',
        points: [
          [1.5, 1.5],
          [4, 1.5],
          [4, 4],
          [1.5, 4],
        ],
        fill: 'second-light',
        label: 'b²',
        opacity: 'ease(between(t, 2.5, 3))',
      },
      {
        id: 'T2',
        kind: 'polygon',
        points: [
          [1.5, 0],
          [4, 0],
          [4, 1.5],
        ],
        fill: 'main',
      },
      {
        id: 'T4',
        kind: 'polygon',
        points: [
          [`2.5 + 1.5*${move(1)}`, `4 - 2.5*${move(1)}`],
          [`1.5*${move(1)}`, `4 - 2.5*${move(1)}`],
          [`1.5*${move(1)}`, `2.5 - 2.5*${move(1)}`],
        ],
        fill: 'main',
      },
      {
        id: 'T1',
        kind: 'polygon',
        points: [
          [0, `1.5*${move(2)}`],
          [1.5, `1.5*${move(2)}`],
          [0, `2.5 + 1.5*${move(2)}`],
        ],
        fill: 'main',
      },
      {
        id: 'T3',
        kind: 'polygon',
        points: [
          [`4 - 2.5*${move(3)}`, 1.5],
          [`4 - 2.5*${move(3)}`, 4],
          [`2.5 - 2.5*${move(3)}`, 4],
        ],
        fill: 'main',
      },
      {
        id: 'frame',
        kind: 'polygon',
        points: [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
        fill: 'none',
      },
      { id: 'da', kind: 'dimension', from: [0, 0], to: [1.5, 0], label: 'a', offset: -0.4 },
      { id: 'db', kind: 'dimension', from: [1.5, 0], to: [4, 0], label: 'b', offset: -0.4 },
    ],
  },
  steps: [
    {
      text: 'Four copies of one right triangle — legs $a$ and $b$, hypotenuse $c$ — fit inside a square of side $a+b$. The space they leave is a tilted square, of area $c^2$.',
      highlight: ['c2', 'T1', 'T2', 'T3', 'T4'],
      set: { t: 0 },
    },
    {
      text: 'Slide the top-left triangle down into the corner opposite. Nothing is added or taken away: the same square, the same four triangles.',
      highlight: ['T4'],
      set: { t: 1 },
    },
    { text: 'Slide the bottom-left one up by $a$.', highlight: ['T1'], set: { t: 2 } },
    {
      text: 'Slide the top-right one across by $b$. The triangles now make two rectangles, and the space they leave is two squares, $a^2$ and $b^2$.',
      highlight: ['T3', 'a2', 'b2'],
      set: { t: 3 },
    },
    {
      text: 'The same square, less the same four triangles, left $c^2$ before and $a^2 + b^2$ after — so $a^2 + b^2 = c^2$.',
      highlight: ['a2', 'b2'],
      set: { t: 3 },
    },
  ],
};

export const ALL = { FOURIER, KINETIC, SHM, TANGENT, INTEGRAL, PYTHAGORAS } as const;
