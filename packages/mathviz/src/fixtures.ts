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
      highlight: ['x'],
      set: { A: 2 },
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

export const ALL = { FOURIER, KINETIC, SHM, TANGENT, INTEGRAL } as const;
