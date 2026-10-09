import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The user's standing rule is "no purple in the UI", and it keeps being broken in
 * the places nobody thinks of as UI — the syntax palette was the largest purple
 * surface in the product, because keywords and properties are on almost every
 * line of every file the canvas shows.
 *
 * A rule that is only remembered is a rule that comes back, so it is measured
 * here instead: a colour counts as purple when blue and red are both clearly
 * ahead of green, which is what separates violet from the blues, pinks and
 * magentas the palette is allowed to use.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

function isPurple(hex: string): boolean {
  const n = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1);
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  // Violet: blue clearly leads green, red is also above green, and blue is
  // level with red or ahead of it. A blue (red below green) and a pink (blue
  // well behind red) both fall out — which is the line that matters, because
  // pink is a colour this product uses on purpose.
  return b > g + 20 && r > g && b >= r - 10;
}

describe('no purple', () => {
  it('classifies the hues it is meant to', () => {
    for (const violet of [
      '#8b2fa8',
      '#d69bff',
      '#7a3ba8',
      '#e0a6ff',
      '#6c5ce7',
      '#4338ca',
      '#6d28d9',
      '#251b3d',
    ]) {
      expect(isPurple(violet), violet).toBe(true);
    }
    for (const ok of [
      '#a3236b',
      '#ff9ac8',
      '#4a6fa5',
      '#9fbcd8',
      '#1a52c4',
      '#0a6b3d',
      '#c0392b',
      // pinks the product uses on purpose — the mark itself is teal/yellow/pink
      '#f9a8d4',
      '#f6b6d2',
      '#3a0f26',
    ]) {
      expect(isPurple(ok), ok).toBe(false);
    }
  });

  it('keeps purple out of the emitted themes', () => {
    const src = readFileSync(path.join(here, 'emit.ts'), 'utf8');
    const offenders = [...src.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)]
      .map((m) => m[0])
      .filter((hex) => isPurple(hex));
    expect(offenders).toEqual([]);
  });
});
