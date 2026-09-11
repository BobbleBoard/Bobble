import { describe, expect, it } from 'vitest';
import { handwrittenSvgRefusal, isHandwrittenSvg } from './handwritten-svg.js';

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

describe('handwrittenSvgRefusal', () => {
  it('names the command, the call shape, and the way through', () => {
    const r = handwrittenSvgRefusal('heart.svg');
    expect(r).toContain('svg "a red heart');
    expect(r).toContain('--image');
    expect(r).toContain('write the same file again');
  });
});
