import { describe, expect, it } from 'vitest';
import { handmadeMathVisual } from './handmade-math';

/* Excerpts of what the 4B made in the STEM suite (2026-09-25), and what it did not. */
const CUBE =
  '<svg viewBox="0 0 400 300"><polygon points="50,200 350,200 350,50 50,50"/><circle cx="150" cy="170" r="5"/><text x="143" y="160">molecule</text><text>u</text><text>L</text></svg>';
const SHM =
  '<html><body><h1>Simple Harmonic Motion</h1><div class="card"><canvas id="c"></canvas></div><p>Displacement against time; the amplitude A and the period T.</p><script>ctx.arc(0,0,Math.sin(t))</script></body></html>';
const LANDING =
  '<html><body><header><svg viewBox="0 0 24 24"><path d="M3 12h18"/></svg> Kiln &amp; Co</header><p>Hand-thrown stoneware, fired slowly.</p></body></html>';

describe('a maths or physics visual made by hand', () => {
  it('is the cube and the SHM page the 4B made', () => {
    expect(handmadeMathVisual(CUBE, 'svg')).toBe(true);
    expect(handmadeMathVisual(SHM, 'html')).toBe(true);
    expect(
      handmadeMathVisual('<html><script src="katex.min.js"></script><svg></svg></html>', 'html'),
    ).toBe(true);
  });

  it('is not a landing page, an icon, a page with no visual, or the math command’s own page', () => {
    expect(handmadeMathVisual(LANDING, 'html')).toBe(false);
    expect(handmadeMathVisual('<svg viewBox="0 0 24 24"><circle r="4"/></svg>', 'svg')).toBe(false);
    expect(
      handmadeMathVisual(
        '<html><p>Complete the square: the vertex of the parabola.</p></html>',
        'html',
      ),
    ).toBe(false);
    expect(
      handmadeMathVisual(
        '<html><figure data-mv-panel><svg></svg></figure><p>tangent slope</p></html>',
        'html',
      ),
    ).toBe(false);
  });
});
