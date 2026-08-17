/**
 * The model card renders THIRD-PARTY HTML fetched from the internet, so the
 * sanitiser schema is the one part of it that carries real risk. These tests
 * pin both halves of the bargain: presentation is allowed, behaviour is not.
 *
 * Tested as data rather than through a render because the danger lives in the
 * allow-list itself — a schema that permits `script` is unsafe no matter what
 * the component around it does.
 */
import { describe, expect, it } from 'vitest';
import { CARD_SANITIZE_SCHEMA as S } from './ModelCard';

const tags = (S.tagNames ?? []) as readonly string[];
const attrsFor = (tag: string): readonly unknown[] =>
  ((S.attributes as Record<string, readonly unknown[]>)[tag] ?? []) as readonly unknown[];

describe('what a model card is allowed to show', () => {
  it('allows the presentation HF cards actually use', () => {
    // the user: "links, html, code blocks, videos images, inline tables everything".
    for (const t of ['img', 'video', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'pre', 'code']) {
      expect(tags).toContain(t);
    }
    expect(tags).toContain('details');
    expect(tags).toContain('summary');
  });

  it('keeps img and video usable — src plus intrinsic sizing', () => {
    expect(attrsFor('img')).toContain('src');
    expect(attrsFor('img')).toContain('width');
    expect(attrsFor('video')).toContain('controls');
  });

  it('allows inline style, which the centred badge rows depend on', () => {
    expect(attrsFor('*')).toContain('style');
  });
});

describe('what it can never do', () => {
  it('does not allow anything that executes', () => {
    for (const t of ['script', 'iframe', 'object', 'embed', 'form', 'button', 'style']) {
      expect(tags).not.toContain(t);
    }
  });

  it('allows <input> ONLY as a disabled task-list checkbox', () => {
    /*
     * READMEs use `- [x]` task lists, which remark-gfm renders as an <input>,
     * so banning the tag outright would break a common list. The default
     * (GitHub's) schema pins it to exactly `disabled` + `type=checkbox` — no
     * name, no value, no way to submit anything. That constraint is the reason
     * it is acceptable, so it is asserted rather than assumed.
     */
    const pairs = attrsFor('input').map((a) => (Array.isArray(a) ? a : [a]));
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['disabled', true],
        ['type', 'checkbox'],
      ]),
    );
    for (const [name] of pairs) {
      expect(['disabled', 'type']).toContain(String(name));
    }
  });

  it('carries no event handlers on any element', () => {
    for (const [, list] of Object.entries(S.attributes as Record<string, readonly unknown[]>)) {
      for (const a of list) {
        const name = typeof a === 'string' ? a : Array.isArray(a) ? String(a[0]) : '';
        expect(name.toLowerCase().startsWith('on')).toBe(false);
      }
    }
  });

  it('restricts link and image protocols — no javascript: URLs', () => {
    const href = (S.protocols?.href ?? []) as readonly string[];
    const src = (S.protocols?.src ?? []) as readonly string[];
    expect(href).toEqual(expect.arrayContaining(['http', 'https']));
    expect(href).not.toContain('javascript');
    expect(src).not.toContain('javascript');
  });
});
