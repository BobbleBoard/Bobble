import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  highlightCode,
  highlightLanguage,
  splitHighlightedLines,
} from './highlight.ts';

/** Text content of an HTML fragment: tags stripped, entities decoded. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('highlightLanguage', () => {
  it('resolves the labels a model writes to a registered grammar', () => {
    expect(highlightLanguage('typescript')).toBe('typescript');
    expect(highlightLanguage('ts')).toBe('typescript');
    expect(highlightLanguage('tsx')).toBe('typescript');
    expect(highlightLanguage('JS')).toBe('javascript');
    expect(highlightLanguage('jsx')).toBe('javascript');
    expect(highlightLanguage('py')).toBe('python');
    expect(highlightLanguage('sh')).toBe('bash');
    expect(highlightLanguage('zsh')).toBe('bash');
    expect(highlightLanguage('console')).toBe('shell');
    expect(highlightLanguage('yml')).toBe('yaml');
    expect(highlightLanguage('html')).toBe('xml');
    expect(highlightLanguage('svg')).toBe('xml');
    expect(highlightLanguage('c++')).toBe('cpp');
    expect(highlightLanguage('rs')).toBe('rust');
    expect(highlightLanguage('kt')).toBe('kotlin');
    expect(highlightLanguage('rb')).toBe('ruby');
    expect(highlightLanguage('md')).toBe('markdown');
    expect(highlightLanguage('patch')).toBe('diff');
    expect(highlightLanguage('toml')).toBe('ini');
    expect(highlightLanguage('text')).toBe('plaintext');
  });

  it('answers null for nothing, blanks and the unknown', () => {
    expect(highlightLanguage(undefined)).toBeNull();
    expect(highlightLanguage('')).toBeNull();
    expect(highlightLanguage('   ')).toBeNull();
    expect(highlightLanguage('brainfuck')).toBeNull();
  });
});

describe('highlightCode', () => {
  it('marks tokens with hljs classes and keeps the text intact', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample IS source text
    const code = 'function greet(name: string) {\n  return `Hello, ${name}!`;\n}';
    const out = highlightCode(code, 'ts');
    expect(out.language).toBe('typescript');
    expect(out.html).toContain('class="hljs-keyword"');
    expect(out.html).toContain('class="hljs-string"');
    expect(textOf(out.html)).toBe(code);
  });

  it('escapes everything the model wrote, highlighted or not', () => {
    const hostile = '<script>alert("x")</script> & <img onerror=1>';
    for (const language of ['html', 'ts', undefined, 'nope']) {
      const out = highlightCode(hostile, language);
      expect(out.html, language).not.toContain('<script');
      expect(out.html, language).not.toContain('<img');
      expect(textOf(out.html), language).toBe(hostile);
    }
  });

  it('leaves an unknown or plain language escaped and unhighlighted', () => {
    expect(highlightCode('a < b', 'brainfuck')).toEqual({ html: 'a &lt; b', language: null });
    expect(highlightCode('a < b', 'text')).toEqual({ html: 'a &lt; b', language: null });
    expect(highlightCode('a < b')).toEqual({ html: 'a &lt; b', language: null });
  });

  it('marks diff lines as additions and deletions', () => {
    const out = highlightCode('-old line\n+new line\n context', 'diff');
    expect(out.language).toBe('diff');
    expect(out.html).toContain('<span class="hljs-deletion">-old line</span>');
    expect(out.html).toContain('<span class="hljs-addition">+new line</span>');
  });

  it('gives up on a fence too large to re-highlight per keystroke', () => {
    const huge = 'x = 1\n'.repeat(30_000);
    expect(highlightCode(huge, 'python').language).toBeNull();
  });

  it('escapeHtml covers the five characters that matter', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;',
    );
  });
});

describe('splitHighlightedLines', () => {
  it('splits on newlines and re-opens spans that cross them', () => {
    const html = 'a <span class="hljs-comment">/* one\ntwo */</span> b';
    expect(splitHighlightedLines(html)).toEqual([
      'a <span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two */</span> b',
    ]);
  });

  it('keeps nested spans nested across the break', () => {
    const html = '<span class="a">x<span class="b">y\nz</span>w</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="a">x<span class="b">y</span></span>',
      '<span class="a"><span class="b">z</span>w</span>',
    ]);
  });

  it('has as many lines as the source, trailing newline included', () => {
    expect(splitHighlightedLines('one\ntwo\n')).toEqual(['one', 'two', '']);
    expect(splitHighlightedLines('')).toEqual(['']);
  });

  it('round-trips real highlighter output line for line', () => {
    const code = 'const s = `a\nb\nc`;\n// done';
    const lines = splitHighlightedLines(highlightCode(code, 'js').html);
    expect(lines.map(textOf)).toEqual(code.split('\n'));
  });
});
