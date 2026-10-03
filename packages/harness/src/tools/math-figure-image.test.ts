import { renderMath } from '@pi-desktop/mathviz';
import { describe, expect, it } from 'vitest';
import { MATH_MOVING_SPEC, mathFigureImage, mathFigureImageRefusal } from './math-figure-image';

/* The visual-learner student, turn 2 (2026-10-01, Gemma 4 12B, bash-CLI): the
   student's message, and the prompt the model gave the image model — as far as
   the run's log kept it. */
const STUDENT =
  'ok i watched the page on the side. i kind of get cutting it like a pizza but the slices never actually move into the rectangle, its just a box next to the circle. how do the slices actually make a rectangle?? the edges are all curvy. can you show it with an actual picture';
const GEMMA_PROMPT =
  'A high-quality, educational 3D illustration showing a circle being sliced into hundreds of extremely thin, needle-';

describe('a maths figure asked of the image model', () => {
  it('is the 12B’s call for the student — its prompt alone says so', () => {
    expect(mathFigureImage({ prompt: GEMMA_PROMPT, request: STUDENT })?.words).toEqual([
      'circle',
      'sliced',
    ]);
    expect(mathFigureImage({ prompt: GEMMA_PROMPT })).not.toBeNull();
  });

  it('reads the person’s words when the prompt only describes the shapes', () => {
    const prompt =
      'a circle cut into thin wedges laid side by side to form a rectangle, clean 3D render';
    expect(mathFigureImage({ prompt, request: STUDENT })?.words).toEqual([
      'circle',
      'wedges',
      'rectangle',
    ]);
    // The same prompt with nobody asking how or why is a picture.
    expect(mathFigureImage({ prompt })).toBeNull();
    expect(
      mathFigureImage({ prompt, request: 'make me a cool 3D render of a circle and a rectangle' }),
    ).toBeNull();
  });

  it('still refuses what gen-tools refused by its notation', () => {
    // MEASURED (the STEM suite, 4B): the prompt it gave image generation, trimmed.
    expect(
      mathFigureImage({
        prompt:
          'Mathematical visualization showing why d/dx(sin x) = cos x. Create a clean diagram with two panels: ' +
          'Top panel: Unit circle showing a point at angle θ with coordinates (cos θ, sin θ). ' +
          'Bottom panel: Graph with sin(x) in blue and cos(x) in green curves on the same axes.',
      }),
    ).not.toBeNull();
    expect(
      mathFigureImage({ prompt: 'a diagram proving the pythagorean theorem, a² + b² = c²' }),
    ).not.toBeNull();
    // MEASURED (the maths suite, 4B): the lever, painted with its torques written wrong.
    expect(
      mathFigureImage({
        prompt:
          'A physics diagram showing a seesaw with a small weight far from the pivot balancing a heavy weight close to the pivot.',
      }),
    ).not.toBeNull();
  });

  it('lets art that only touches maths be painted', () => {
    for (const prompt of [
      'a child on a seesaw in a sunny park, watercolor',
      'a neon sine wave poster, synthwave',
      'Pythagoras teaching his students, renaissance fresco',
      'a mathematician at a chalkboard full of equations, oil painting',
      'a red fox in a forest, watercolour',
      'a pizza cut into eight slices on a wooden table, food photography',
      'a cute cartoon of Isaac Newton under an apple tree, gravity, storybook style',
    ]) {
      expect(mathFigureImage({ prompt }), prompt).toBeNull();
    }
    // A poster for a maths class is a picture — nobody asked how or why.
    expect(
      mathFigureImage({
        prompt: 'a colourful poster of circles and triangles, flat design',
        request: 'make me a poster for my maths class with circles and triangles on it',
      }),
    ).toBeNull();
  });
});

describe('the spec it hands over', () => {
  /* Drawn by the math command's own renderer, the way the model would fill it in. */
  const filled = MATH_MOVING_SPEC.replace('"title": "…"', '"title": "Slices into a rectangle"')
    .replace('"label": "…"', '"label": "circle"')
    .replace('"label": "…"', '"label": "one slice"')
    .replace('"… the {disc} …"', '"Cut the {disc} into slices like a pizza."')
    .replace('"… the {piece} moves …"', '"Now the {piece} slides over to start the row."');

  it('is a real spec — math draws it with nothing to fix, even copied word for word', () => {
    expect(filled).not.toContain('…');
    const drawn = renderMath(JSON.parse(filled));
    expect(drawn.problems.filter((p) => p.level === 'fix')).toEqual([]);
    expect(() => renderMath(JSON.parse(MATH_MOVING_SPEC))).not.toThrow();
  });

  it('moves a part, on a slider the steps play', () => {
    const drawn = renderMath(JSON.parse(filled));
    expect(drawn.spec.params.map((p) => p.name)).toEqual(['t']);
    expect(drawn.spec.steps.map((s) => s.set)).toEqual([{ t: 0 }, { t: 1 }]);
    expect(drawn.problems.map((p) => p.text).join('\n')).not.toMatch(/moves nothing|unused/i);
  });
});

describe('the answer at the call', () => {
  const words = ['circle', 'sliced'];

  it('names what it saw, the math command, the spec to write — with the spec in it — and the way past', () => {
    const why = mathFigureImageRefusal({ words, cli: true });
    expect(why).toMatch(/^Not generated: this picture is a maths figure \("circle", "sliced"\)/);
    expect(why).toContain('The math command draws the figure itself');
    expect(why).toContain('Write the figure as a spec to circle-sliced.math.json');
    expect(why).toContain(MATH_MOVING_SPEC);
    expect(why).toContain('"slide" {"by": [dx, dy], "t": "0..1"}');
    expect(why).toMatch(/run the same command again UNCHANGED\.$/);
    expect(mathFigureImageRefusal({ words, cli: false })).toMatch(
      /make the same call again UNCHANGED\.$/,
    );
  });

  it('puts the spec where the picture was to be saved, inside the working folder', () => {
    const at = (saveTo: string) =>
      /spec to (\S+)\.math\.json/.exec(mathFigureImageRefusal({ words, saveTo }))?.[1];
    expect(at('visualizations/slices.png')).toBe('visualizations/slices');
    expect(at('visualizations/')).toBe('visualizations/circle-sliced');
    expect(at('/Users/j/Pictures/slices.png')).toBe('circle-sliced');
    expect(at('~/Pictures')).toBe('circle-sliced');
    expect(/spec to (\S+)\.math/.exec(mathFigureImageRefusal({ words: [] }))?.[1]).toBe('figure');
  });
});
