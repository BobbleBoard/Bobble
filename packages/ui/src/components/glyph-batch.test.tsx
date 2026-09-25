import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GLYPHS, Glyph, type GlyphName } from './glyph';

/*
 * The W0-A batch (deliverables/research/PLAN.md §2.3): one glyph for each new
 * surface of the push, landed together so no lane has to edit glyph.tsx.
 * Hugeicons' own stroke paths — so each one is on the 24 grid, stroked, and
 * drawn by the one <Glyph> like every other.
 */
const BATCH: GlyphName[] = [
  'memory',
  'help',
  'devices',
  'training',
  'diagram',
  'layers',
  'markup',
  'comment',
  'removeBackground',
  'erase',
  'expand',
  'upscale',
  'presets',
  'brush',
  'lasso',
];

/** Every number in a path, in order (coordinates and arc parameters alike). */
const numbersIn = (d: string): number[] => (d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);

describe('the W0-A glyph batch', () => {
  it.each(BATCH)('%s is in the set and draws through <Glyph>', (name) => {
    const paths = GLYPHS[name];
    expect(paths.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<Glyph name={name} />);
    expect(html).toContain(`data-glyph="${name}"`);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('fill="none"');
    expect((html.match(/<path /g) ?? []).length).toBe(paths.length);
    // Every stroke is non-scaling, so the token stays a pixel width.
    expect((html.match(/vector-effect="non-scaling-stroke"/g) ?? []).length).toBe(paths.length);
  });

  it.each(BATCH)('%s stays on the 24 grid', (name) => {
    for (const p of GLYPHS[name]) {
      expect(p.d.startsWith('M')).toBe(true);
      for (const n of numbersIn(p.d)) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(24);
      }
    }
  });

  it('adds names only — every glyph that was there is still there', () => {
    for (const old of [
      'scheduled',
      'studio3d',
      'engine',
      'storage',
      'models',
      'toCanvas',
      'toInline',
      'video',
      'image',
      'audio',
      'newChat',
      'extensions',
      'folder',
      'folderOpen',
      'discover',
      'onDevice',
      'experimental',
      'computerUse',
    ] as GlyphName[]) {
      expect(GLYPHS[old]).toBeDefined();
    }
  });
});
