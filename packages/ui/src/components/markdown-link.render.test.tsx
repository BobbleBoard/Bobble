import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown.tsx';

/*
 * Every hyperlink in every reply used to be inert — the anchor rendered, the
 * click scheduled a navigation, and the main process cancelled it. A model that
 * cited its sources produced a list of dead text, which for an app whose job is
 * answering questions is close to the worst small bug available.
 *
 * These render statically (this package's convention), so they pin the part
 * that renders: which hrefs become anchors at all. The click routing through
 * the app's opener needs a live tree and is covered where that opener lives.
 */
describe('markdown links', () => {
  const html = (text: string) => renderToStaticMarkup(<Markdown>{text}</Markdown>);

  it('renders an http(s) link as a real anchor', () => {
    const out = html('see [the docs](https://example.com/docs)');
    expect(out).toContain('<a');
    expect(out).toContain('href="https://example.com/docs"');
  });

  it('allows mailto, which is a normal thing to cite', () => {
    expect(html('[mail](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
  });

  it('refuses javascript: and file:, rendering them as inert text', () => {
    /*
     * Link text in a reply is model-authored and can be quoted verbatim from a
     * web page, so it is untrusted input arriving at a click handler. Something
     * that LOOKS clickable and does something else is worse than something
     * inert, so these render as a span with no href at all.
     */
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd']) {
      const out = html(`[click](${href})`);
      expect(out).toContain('click');
      expect(out).not.toContain('<a');
      expect(out).not.toContain('href=');
    }
  });

  it('is not fooled by casing or leading whitespace', () => {
    for (const href of [' JavaScript:alert(1)', 'FILE:///etc/passwd']) {
      expect(html(`[x](${href})`)).not.toContain('<a');
    }
  });
});
