import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { guardCurrencyDollars, holdBackPartialTail, Markdown } from './markdown.tsx';

/*
 * MEASURED by the flicker guard on a streamed reply: "I have the data:" then
 * a lone "-" (the first byte of "- 2021: 12") is a setext underline, so the
 * paragraph flashed as an <h2> for one frame. A trailing line that is only
 * structure characters is held back until it has more in it.
 */
describe('a streamed structural tail is held back', () => {
  it('a lone dash after a paragraph does not make it a heading', () => {
    expect(holdBackPartialTail('I have the data:\n-')).toBe('I have the data:\n');
    expect(holdBackPartialTail('I have the data:\n--')).toBe('I have the data:\n');
    expect(holdBackPartialTail('done\n```')).toBe('done\n');
    expect(holdBackPartialTail('done\n#')).toBe('done\n');
    const html = renderToStaticMarkup(<Markdown streaming>{'I have the data:\n-'}</Markdown>);
    expect(html).toContain('<p>I have the data:</p>');
    expect(html).not.toContain('<h2>');
  });

  it('leaves a finished line, a list item, a real heading and a real rule alone', () => {
    expect(holdBackPartialTail('I have the data:\n- 2021: 12')).toBe(
      'I have the data:\n- 2021: 12',
    );
    expect(holdBackPartialTail('Title\n===\n\nBody')).toBe('Title\n===\n\nBody');
    expect(holdBackPartialTail('above\n\n---\n\nbelow')).toBe('above\n\n---\n\nbelow');
    expect(holdBackPartialTail('# Heading')).toBe('# Heading');
    expect(holdBackPartialTail('plain text')).toBe('plain text');
    const html = renderToStaticMarkup(
      <Markdown streaming>{'I have the data:\n- 2021: 12'}</Markdown>,
    );
    expect(html).toContain('<li>');
  });
});

/*
 * "Revenue was $412,000, up 14% on Q2, and margin $3" rendered "412,000, up
 * 14% on Q2, and margin" as an equation. Pandoc's rule — a closing `$` is
 * not followed by a digit — tells a price from a formula.
 */
describe('a dollar amount is not a formula', () => {
  it('escapes the opener of a pair whose closer is followed by a digit', () => {
    expect(guardCurrencyDollars('from $5-$10')).toBe('from \\$5-\\$10');
    expect(guardCurrencyDollars('It costs $12 and $19 each.')).toBe(
      'It costs \\$12 and \\$19 each.',
    );
    expect(guardCurrencyDollars('from $5 to $10')).toBe('from \\$5 to \\$10');
    expect(guardCurrencyDollars('Revenue was $412,000, up 14% on Q2, and margin $3.')).toBe(
      'Revenue was \\$412,000, up 14% on Q2, and margin \\$3.',
    );
  });

  it('leaves real math and code alone', () => {
    expect(guardCurrencyDollars('Solve $x^2 + 1$ for x.')).toBe('Solve $x^2 + 1$ for x.');
    expect(guardCurrencyDollars('$2\\pi$ radians')).toBe('$2\\pi$ radians');
    expect(guardCurrencyDollars('run `echo $1 $2` now')).toBe('run `echo $1 $2` now');
    expect(guardCurrencyDollars('```sh\necho $12 $34\n```\n$5 and $6')).toBe(
      '```sh\necho $12 $34\n```\n\\$5 and \\$6',
    );
    expect(guardCurrencyDollars('$$\nx^2\n$$')).toBe('$$\nx^2\n$$');
    expect(guardCurrencyDollars('$$a$$ costs $5')).toBe('$$a$$ costs \\$5');
    expect(guardCurrencyDollars('see https://x.com/?p=$5')).toBe('see https://x.com/?p=$5');
  });

  it('renders the prices as text and the formula as math', () => {
    const prices = renderToStaticMarkup(
      <Markdown>{'Revenue was $412,000, up 14% on Q2, and margin $3.'}</Markdown>,
    );
    expect(prices).not.toContain('katex');
    expect(prices).toContain('$412,000');
    const math = renderToStaticMarkup(<Markdown>{'Solve $x^2 + 1$ for x.'}</Markdown>);
    expect(math).toContain('katex');
  });

  it('holds back a trailing $ while the stream decides what it is', () => {
    expect(holdBackPartialTail('It costs $12 and $')).toBe('It costs $12 and ');
    expect(holdBackPartialTail('price in \\$')).toBe('price in \\$');
    expect(holdBackPartialTail('It costs $12 and $19')).toBe('It costs $12 and $19');
  });
});

/*
 * SEEN 2026-10-02, a 4B on "And if the bat cost $2.00 more than the ball?":
 * the closer is followed by a comma, so pandoc's digit rule calls the pair
 * maths, and the chat drew "1.10, thenx + …" in italic KaTeX. A pair that
 * opens on a money amount and runs on through English is money.
 */
describe('a price that runs on into a sentence is not a formula', () => {
  const BAT = "together they're $1.10, then x + (x + 2.00) = 1.10$, so 2x = -0.90";
  const KATEX = /class="katex"/g;
  const katexCount = (md: string, streaming = false) =>
    (renderToStaticMarkup(<Markdown streaming={streaming}>{md}</Markdown>).match(KATEX) ?? [])
      .length;

  it('escapes both dollars of the bat-and-ball sentence', () => {
    expect(guardCurrencyDollars(BAT)).toBe(
      "together they're \\$1.10, then x + (x + 2.00) = 1.10\\$, so 2x = -0.90",
    );
    const html = renderToStaticMarkup(<Markdown>{BAT}</Markdown>);
    expect(html).not.toContain('katex');
    expect(html).toContain('$1.10, then x + (x + 2.00) = 1.10$, so 2x = -0.90');
  });

  it('keeps real inline maths, a number first or not', () => {
    expect(katexCount('The area of a circle is $\\pi r^2$.')).toBe(1);
    expect(guardCurrencyDollars('The area of a circle is $\\pi r^2$.')).toBe(
      'The area of a circle is $\\pi r^2$.',
    );
    for (const formula of ['$2\\pi$', '$2 + 3 = 5$', '$5 cm$', '$2 \\text{ apples}$', '$ x^2 $']) {
      expect(guardCurrencyDollars(`so ${formula} here`)).toBe(`so ${formula} here`);
    }
    // Both in one reply: the price stays text, the formula is maths.
    expect(katexCount(`${BAT}\n\nThe area of a circle is $\\pi r^2$.`)).toBe(1);
  });

  it('frees the closer to open the next pair', () => {
    expect(guardCurrencyDollars('It costs $5 and $x$ is the unknown')).toBe(
      'It costs \\$5 and $x$ is the unknown',
    );
  });

  it('never pairs dollars across a line break', () => {
    expect(guardCurrencyDollars('Bat: $1.05\nBall: $0.05')).toBe('Bat: \\$1.05\nBall: \\$0.05');
    expect(katexCount('Bat: $1.05\nBall: $0.05')).toBe(0);
  });

  it('renders a finished reply that ends on maths; holds the $ back only while streaming', () => {
    expect(katexCount('**Answer:** $x = 5$')).toBe(1);
    expect(katexCount('The area is\n\n$$\\pi r^2$$')).toBe(1);
    expect(katexCount('**Answer:** $x = 5$', true)).toBe(0);
  });
});
