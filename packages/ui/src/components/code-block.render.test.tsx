import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from './code-block.tsx';
import { Markdown } from './markdown.tsx';

/*
 * The chat's fences had no syntax colour at all — a `function` and a string
 * were the same grey. They render statically here (this package's
 * convention), pinning what reaches the DOM: hljs spans for a known language,
 * plain escaped text otherwise, the diff class for a diff fence, and line
 * numbers that survive a span crossing the line break.
 */
describe('CodeBlock highlighting', () => {
  it('colours a TypeScript fence through hljs classes', () => {
    const html = renderToStaticMarkup(
      <CodeBlock code={'const x: number = 1;\nreturn "hi";'} language="ts" />,
    );
    expect(html).toContain('class="hljs"');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-string');
    expect(html).toContain('data-language="typescript"');
  });

  it('leaves an unknown language plain, escaped, and without the hljs class', () => {
    const html = renderToStaticMarkup(<CodeBlock code="a < b" language="zzz" />);
    expect(html).not.toContain('hljs-');
    expect(html).toContain('a &lt; b');
  });

  it('never lets the fence body through as markup', () => {
    const html = renderToStaticMarkup(
      <CodeBlock code={'<img src=x onerror="alert(1)">'} language="html" />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain('&lt;');
    expect(html).toContain('&quot;alert(1)&quot;');
  });

  it('marks a diff fence for the row tints', () => {
    const html = renderToStaticMarkup(<CodeBlock code={'-a\n+b'} language="diff" />);
    expect(html).toContain('pd-code-block--diff');
    expect(html).toContain('hljs-deletion');
    expect(html).toContain('hljs-addition');
  });

  it('numbers lines with the highlighting kept per line', () => {
    const html = renderToStaticMarkup(
      <CodeBlock code={'/* a\nb */\nlet c;'} language="js" showLineNumbers />,
    );
    expect(html.match(/data-line-number="/g)?.length).toBe(3);
    // The comment crosses the first break, so both halves carry the class.
    expect(html.match(/hljs-comment/g)?.length).toBe(2);
  });

  it('renders pre-highlighted children untouched', () => {
    const html = renderToStaticMarkup(
      <CodeBlock code="x" language="ts">
        <b>custom</b>
      </CodeBlock>,
    );
    expect(html).toContain('<b>custom</b>');
    expect(html).not.toContain('class="hljs"');
  });

  it('reaches a markdown fence in a reply', () => {
    const html = renderToStaticMarkup(<Markdown>{'```python\nprint("hi")\n```'}</Markdown>);
    expect(html).toContain('hljs-built_in');
    expect(html).toContain('hljs-string');
  });
});
