import { describe, expect, it } from 'vitest';
import { changedRange, emphasizeHtml, pairChanges } from './diff-emphasis.ts';

describe('changedRange', () => {
  it('finds the stretch between a shared prefix and suffix', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the test text IS a template literal
    const r = changedRange('  return "Hello, " + name;', '  return `Hello, ${name}!`;');
    expect(r).toEqual({
      before: { from: 9, to: 25 },
      after: { from: 9, to: 26 },
    });
  });

  it('is null when the lines share nothing at either end', () => {
    expect(changedRange('alpha', 'omega!')).toBeNull();
  });

  it('is null when most of the line changed — that is not a pointer', () => {
    expect(changedRange('a completely different sentence x', 'a x')).toBeNull();
  });
});

describe('pairChanges', () => {
  it('pairs a run of deletions with the same-length run of additions, in order', () => {
    const rows = [
      { kind: 'context', text: 'function greet(name: string) {' },
      { kind: 'del', text: '  return "Hello, " + name;' },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the test text IS a template literal
      { kind: 'add', text: '  return `Hello, ${name}!`;' },
      { kind: 'context', text: '}' },
    ];
    const pairs = pairChanges(rows);
    expect([...pairs.keys()]).toEqual([1, 2]);
  });

  it('does not pair unequal runs', () => {
    const rows = [
      { kind: 'del', text: 'one' },
      { kind: 'add', text: 'one!' },
      { kind: 'add', text: 'two' },
    ];
    expect(pairChanges(rows).size).toBe(0);
  });
});

describe('emphasizeHtml', () => {
  it('wraps a plain range', () => {
    expect(emphasizeHtml('return name;', { from: 7, to: 11 }, 'e')).toBe(
      'return <span class="e">name</span>;',
    );
  });

  it('never crosses a highlight span: closes before the tag, reopens after', () => {
    const html = '<span class="hljs-keyword">return</span> <span class="hljs-string">"x"</span>;';
    // Emphasise `rn "x` — from inside the keyword to inside the string.
    const out = emphasizeHtml(html, { from: 4, to: 9 }, 'e');
    expect(out).toBe(
      '<span class="hljs-keyword">retu<span class="e">rn</span></span><span class="e"> </span>' +
        '<span class="hljs-string"><span class="e">"x</span>"</span>;',
    );
  });

  it('counts an entity as one character', () => {
    expect(emphasizeHtml('a &amp; b', { from: 2, to: 3 }, 'e')).toBe(
      'a <span class="e">&amp;</span> b',
    );
  });
});
