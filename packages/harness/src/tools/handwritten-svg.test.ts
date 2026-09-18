import { describe, expect, it } from 'vitest';
import {
  countInlineDrawnSvgs,
  handwrittenInlineSvgRefusal,
  handwrittenSvgRefusal,
  hasHandwrittenInlineSvg,
  isHandwrittenSvg,
} from './handwritten-svg.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M1 1"/></svg>';

describe('isHandwrittenSvg', () => {
  it('catches the measured case: a fresh .svg of markup while svg is on', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: svg,
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(true);
  });

  it('is nothing without the command — there is nothing to point at', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: svg,
        exists: false,
        svgCommandAvailable: false,
      }),
    ).toBe(false);
  });

  it('leaves an existing file alone: rewriting is editing', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: svg,
        exists: true,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });

  it('only fires on markup, and only on a .svg path', () => {
    expect(
      isHandwrittenSvg({
        path: 'notes.svg',
        content: 'todo: draw a heart',
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
    expect(
      isHandwrittenSvg({
        path: 'index.html',
        content: `<div>${svg}</div>`,
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });
});

describe('hasHandwrittenInlineSvg', () => {
  const page = `<!doctype html><header><a class="logo">${svg}</a></header><main>text</main>`;

  it('catches a logo drawn inline in a page — the website shape of the mistake', () => {
    expect(
      hasHandwrittenInlineSvg({ path: 'index.html', content: page, svgCommandAvailable: true }),
    ).toBe(true);
    expect(countInlineDrawnSvgs(`${page}${svg}<svg viewBox="0 0 1 1"><circle r="1"/></svg>`)).toBe(
      3,
    );
  });

  it('ignores an <svg> that draws nothing: a sprite <use>, an empty wrapper', () => {
    const sprite = '<svg class="icon"><use href="#gear"/></svg>';
    expect(
      hasHandwrittenInlineSvg({ path: 'index.html', content: sprite, svgCommandAvailable: true }),
    ).toBe(false);
    expect(
      hasHandwrittenInlineSvg({
        path: 'a.tsx',
        content: '<svg viewBox="0 0 1 1"></svg>',
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });

  it('leaves a page alone when the command is off, and leaves .svg files to the other check', () => {
    expect(
      hasHandwrittenInlineSvg({ path: 'index.html', content: page, svgCommandAvailable: false }),
    ).toBe(false);
    expect(
      hasHandwrittenInlineSvg({ path: 'logo.svg', content: svg, svgCommandAvailable: true }),
    ).toBe(false);
  });

  it('is not fooled by an <img src="x.svg"> — that is the right way', () => {
    expect(
      hasHandwrittenInlineSvg({
        path: 'index.html',
        content: '<img src="assets/logo.svg" alt="logo">',
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });
});

describe('refusals', () => {
  it('name the command, the call shape with --out, and the way through', () => {
    const r = handwrittenSvgRefusal('heart.svg');
    expect(r).toContain('svg "a red heart');
    expect(r).toContain('--out heart.svg');
    expect(r).toContain('UNCHANGED');
    const p = handwrittenInlineSvgRefusal('index.html', 2, false);
    expect(p).toContain('2 SVG graphics drawn by hand');
    expect(p).toContain('--out assets/logo.svg');
    expect(p).toContain('<img src="assets/logo.svg"');
    expect(handwrittenInlineSvgRefusal('index.html', 1, true)).toContain('Not edited');
  });
});

describe('isHandwrittenSvg — when the markup is what was asked for', () => {
  // The exact shape of the user's sample.svg (2026-09-17): a prolog, a comment
  // block that titles itself, then the markup — the file WAS the answer.
  const lesson = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!--',
    '  SVG File Format Examples',
    '  ------------------------',
    '  Common formatting conventions for SVG files.',
    '-->',
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">',
    '  <rect x="10" y="10" width="50" height="50"/>',
    '</svg>',
  ].join('\n');
  const bare = svg;

  it('lets a self-explaining file through, whatever it is called', () => {
    expect(
      isHandwrittenSvg({
        path: 'shapes.svg',
        content: lesson,
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });

  it('lets a sample/template/fixture through by its name', () => {
    for (const path of [
      'sample.svg',
      'examples/icon-template.svg',
      'fixtures/tiny.svg',
      'demo.svg',
    ]) {
      expect(
        isHandwrittenSvg({ path, content: bare, exists: false, svgCommandAvailable: true }),
      ).toBe(false);
    }
  });

  it('lets bare markup through when the person asked about SVG as a format', () => {
    for (const request of [
      'show me how svg is generlaly formatted',
      'what does the syntax of an SVG look like?',
      'give me an example svg file',
      'explain svg markup',
    ]) {
      expect(
        isHandwrittenSvg({
          path: 'shapes.svg',
          content: bare,
          exists: false,
          svgCommandAvailable: true,
          request,
        }),
      ).toBe(false);
    }
  });

  it('still catches a hand-drawn picture asked for as a picture', () => {
    for (const request of [
      'make me an svg icon of a red heart',
      'draw a logo for my coffee shop',
    ]) {
      expect(
        isHandwrittenSvg({
          path: 'heart.svg',
          content: bare,
          exists: false,
          svgCommandAvailable: true,
          request,
        }),
      ).toBe(true);
    }
  });

  it('a one-word comment is not a lesson', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: '<!-- heart --><svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>',
        exists: false,
        svgCommandAvailable: true,
        request: 'make me an svg icon of a red heart',
      }),
    ).toBe(true);
  });
});
