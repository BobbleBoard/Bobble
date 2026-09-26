import { describe, expect, it } from 'vitest';
import {
  buildVfigRequest,
  svgFromText,
  textLoopStart,
  textStallStart,
  VFIG_FIGURE_PROMPT,
} from './vfig-request';

describe('what VFIG is sent', () => {
  it('a figure: the picture, then the model card’s own instruction', () => {
    const r = buildVfigRequest({ imageBase64: 'AAAA' });
    expect(r.messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: VFIG_FIGURE_PROMPT },
    ]);
    // Greedy, and no limit but the context.
    expect(r).toMatchObject({ temperature: 0, n_predict: -1, stream: true });
  });

  it('an edit: the file, the change, and "the complete edited SVG only"', () => {
    const r = buildVfigRequest({ svg: '<svg><rect/></svg>', instruction: 'make the bar red' });
    expect(r.messages[0]?.content).toBe(
      'Here is an SVG:\n```svg\n<svg><rect/></svg>\n```\nEdit it: make the bar red\nReturn the complete edited SVG code only.',
    );
  });

  it('a description, when there is no picture', () => {
    expect(buildVfigRequest({ prompt: ' a bar chart ' }).messages[0]?.content).toBe(
      'Generate valid SVG code for: a bar chart',
    );
  });
});

describe('a reply that repeats itself', () => {
  const figure = '<svg viewBox="0 0 100 100"><text x="5" y="10">Fig. 3.1</text>';

  it('is cut where the repetition began — the figure before it is kept', () => {
    const loop = '<rect x="1" y="2" width="3" height="4"/>\n'.repeat(80);
    expect(textLoopStart(figure + loop)).toBe(figure.length);
  });

  it('a run of the same coordinates inside one path is caught too', () => {
    const text = `${figure}<path d="M 0 0 ${'L 40 40 '.repeat(400)}`;
    const at = textLoopStart(text);
    expect(at).toBeGreaterThan(figure.length);
    // Everything before the first copy is kept — and closed into a file.
    expect(text.slice(0, at)).not.toContain('L 40 40');
    expect(svgFromText(text.slice(0, at)).svg).toBe(`${figure}</svg>`);
  });

  it('lines that only look alike — their numbers differ — are a drawing, not a loop', () => {
    const bars = Array.from(
      { length: 120 },
      (_, i) => `<rect x="${i * 7}" y="10" width="5" height="${i}"/>`,
    ).join('\n');
    expect(textLoopStart(figure + bars)).toBe(-1);
  });
});

describe('the SVG out of a reply', () => {
  it('is the file when it ended', () => {
    expect(svgFromText('Here it is:\n```svg\n<svg><g/></svg>\n```')).toEqual({
      svg: '<svg><g/></svg>',
      complete: true,
    });
  });

  it('is closed into a file that parses when it was cut short', () => {
    const cut =
      '<svg viewBox="0 0 10 10"><g id="a"><text x="1" y="2">Pressure</text><rect x="1" y="2" wi';
    expect(svgFromText(cut)).toEqual({
      svg: '<svg viewBox="0 0 10 10"><g id="a"><text x="1" y="2">Pressure</text></g></svg>',
      complete: false,
    });
  });

  it('is nothing when there is no SVG', () => {
    expect(svgFromText('I cannot do that.')).toEqual({ svg: null, complete: false });
  });
});

describe('a reply that has stopped drawing', () => {
  const gradient = (i: number) =>
    `<linearGradient id="g${i}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#${(i * 7919).toString(16).padStart(6, '0').slice(0, 6)}"/><stop offset="100%" style="stop-color:#FFFFFF"/></linearGradient>\n`;

  it('is found in a run of definitions that draws nothing (MEASURED: 32,400 tokens of gradients)', () => {
    const head = '<svg viewBox="0 0 100 100"><rect x="1" y="1" width="9" height="9"/>';
    const text = `${head}<defs>${Array.from({ length: 80 }, (_, i) => gradient(i)).join('')}`;
    const at = textStallStart(text);
    expect(at).toBe(head.length);
    expect(svgFromText(text.slice(0, at)).svg).toBe(`${head}</svg>`);
  });

  it('is not a long run of path data, nor a drawing that keeps drawing', () => {
    const path = `<svg><path d="M0 0 ${Array.from({ length: 2000 }, (_, i) => `L${i % 97} ${(i * 13) % 89}`).join(' ')}`;
    expect(textStallStart(path)).toBe(-1);
    const rects = `<svg>${Array.from({ length: 400 }, (_, i) => `<rect x="${i}" y="0" width="1" height="${i % 50}"/>`).join('')}`;
    expect(textStallStart(rects)).toBe(-1);
  });
});
