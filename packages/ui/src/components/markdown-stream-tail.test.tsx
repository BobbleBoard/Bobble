import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { holdBackPartialTail, Markdown } from './markdown.tsx';

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
    const html = renderToStaticMarkup(<Markdown>{'I have the data:\n-'}</Markdown>);
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
    const html = renderToStaticMarkup(<Markdown>{'I have the data:\n- 2021: 12'}</Markdown>);
    expect(html).toContain('<li>');
  });
});
