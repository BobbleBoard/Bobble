import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fenceLatexDisplay } from './latex-math.ts';
import { Markdown } from './markdown.tsx';

/*
 * MEASURED 2026-10-06: `\(x^2\)` rendered as the text "(x^2)" — CommonMark
 * reads `\(` as an escaped parenthesis — and a `\[ … \]` display as brackets
 * around raw TeX. Many models write maths no other way.
 */
const render = (md: string, streaming = false) =>
  renderToStaticMarkup(<Markdown streaming={streaming}>{md}</Markdown>);
/** The TeX of every formula drawn, inline or display. */
const formulas = (html: string) =>
  [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map(
    (m) => (m[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
  );
const displays = (html: string) => (html.match(/class="katex-display"/g) ?? []).length;

describe('\\(…\\) is inline maths', () => {
  it('renders inline, beside text', () => {
    const html = render('The area of a circle is \\(\\pi r^2\\), as before.');
    expect(formulas(html)).toEqual(['\\pi r^2']);
    expect(displays(html)).toBe(0);
    expect(html).toContain('as before.');
  });

  it('keeps TeX escapes and emphasis characters inside', () => {
    expect(formulas(render('So \\(\\$1.10 - \\$0.05 = \\$1.05\\).'))).toEqual([
      '\\$1.10 - \\$0.05 = \\$1.05',
    ]);
    const stars = render('Then \\(a*b*c\\) and \\(x_1 + x_2\\).');
    expect(formulas(stars)).toEqual(['a*b*c', 'x_1 + x_2']);
    expect(stars).not.toContain('<em>');
    expect(formulas(render('Rows: \\(a \\\\ b\\)'))).toEqual(['a \\\\ b']);
  });

  it('leaves code, an escaped backslash and an unclosed or empty one alone', () => {
    expect(formulas(render('Run `\\(x\\)` as typed.'))).toEqual([]);
    expect(render('Run `\\(x\\)` as typed.')).toContain('<code class="pd-md-code">\\(x\\)</code>');
    expect(formulas(render('```tex\n\\(x\\)\n\\[y\\]\n```'))).toEqual([]);
    expect(formulas(render('A path \\\\(x\\\\) here'))).toEqual([]);
    expect(render('Half \\(x^2 so far')).toContain('Half (x^2 so far');
    expect(formulas(render('Empty \\(\\) here'))).toEqual([]);
  });

  it('sits beside dollar maths and prices', () => {
    const html = render("They're $1.10 together, so \\(x + (x + 2) = 1.10\\) and $y^2$.");
    expect(formulas(html)).toEqual(['x + (x + 2) = 1.10', 'y^2']);
    expect(html).toContain('$1.10 together');
  });
});

describe('\\[…\\] is display maths', () => {
  it('on one line', () => {
    const html = render('\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]');
    expect(formulas(html)).toEqual([' x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} ']);
    expect(displays(html)).toBe(1);
  });

  it('across lines, with a line that markdown would make a list item', () => {
    const md = 'Expand:\n\\[\na^2 + 2ab\n  + b^2\n\\]\nwhich is the square.';
    const html = render(md);
    expect(formulas(html)).toEqual(['a^2 + 2ab\n  + b^2']);
    expect(displays(html)).toBe(1);
    expect(html).not.toContain('<li>');
    expect(html).toContain('<p>Expand:</p>');
    expect(html).toContain('<p>which is the square.</p>');
  });

  it('turns the delimiters into fence lines in place', () => {
    expect(fenceLatexDisplay('\\[\nx^2\n\\]')).toBe('$$\nx^2\n$$');
    expect(fenceLatexDisplay('The formula is \\[ x^2 +\ny^2 \\]')).toBe(
      'The formula is\n$$\nx^2 +\ny^2\n$$',
    );
    expect(fenceLatexDisplay('\\[\nx^2\n\\].')).toBe('$$\nx^2\n.\n$$');
    expect(fenceLatexDisplay('\\[\nx\n\\] where x is a length')).toBe(
      '$$\nx\n$$\nwhere x is a length',
    );
    expect(fenceLatexDisplay('> \\[\n> x\n> \\]')).toBe('> $$\n> x\n> $$');
    expect(fenceLatexDisplay('- Area: \\[\n  \\pi r^2\n  \\]')).toBe(
      '- Area:\n  $$\n  \\pi r^2\n  $$',
    );
  });

  it('inside a quote and a list item', () => {
    expect(displays(render('> Note\n> \\[\n> x^2\n> \\]'))).toBe(1);
    const item = render('- Area: \\[\n  \\pi r^2\n  \\]');
    expect(formulas(item)).toEqual(['\\pi r^2']);
    expect(item).toContain('<li>');
  });

  it('leaves code fences, $$ blocks and an unclosed \\[ on a finished reply alone', () => {
    const fenced = '```\n\\[\nx\n\\]\n```';
    expect(fenceLatexDisplay(fenced)).toBe(fenced);
    const dollars = '$$\n\\[ x \\]\n$$';
    expect(fenceLatexDisplay(dollars)).toBe(dollars);
    expect(fenceLatexDisplay('\\[\nx^2')).toBe('\\[\nx^2');
  });

  it('opens while streaming, so the equation fills in as it arrives', () => {
    expect(fenceLatexDisplay('Area:\n\\[\n\\pi r', true)).toBe('Area:\n$$\n\\pi r');
    expect(displays(render('Area:\n\\[\n\\pi r', true))).toBe(1);
    // A half-arrived `\(` is held back, not drawn as a backslash.
    expect(render('The area is \\', true)).not.toContain('\\');
  });
});
