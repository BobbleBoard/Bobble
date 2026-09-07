import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { describe, expect, it } from 'vitest';
import { $createPillNode, $isPillNode, PillNode } from './pill-node';

/**
 * THE ONE PROPERTY THAT MAKES PILLS SAFE.
 *
 * Everything inserted rather than typed is a pill now — starter chips, "+" menu
 * actions, `@` file mentions — and the composer builds the outgoing message from
 * `$getRoot().getTextContent()`. So a pill is exactly the words it stands for by
 * the time anything leaves the window, and none of the paths in between (the
 * prompt, the prefill signature, the attachment folding) had to learn what a
 * pill is.
 *
 * If this stops being true the model starts receiving "Make an image" where the
 * user meant "Make an image of a cosy neighbourhood coffee shop at sunrise" — a
 * silent truncation of their own request, which is the worst shape of bug this
 * app can have. Hence a HEADLESS editor rather than bare constructors: a Lexical
 * node cannot exist outside one, and the assertion that matters is the one made
 * through the same root walk the composer does.
 */
const withEditor = <T>(fn: () => T): T => {
  const editor = createEditor({
    nodes: [PillNode],
    onError: (e) => {
      throw e;
    },
  });
  let out: T | undefined;
  editor.update(
    () => {
      out = fn();
    },
    { discrete: true },
  );
  return out as T;
};

const DATA = {
  label: 'Make an image',
  payload: 'Make an image of a cosy neighbourhood coffee shop at sunrise.',
  icon: 'image' as const,
};

describe('PillNode', () => {
  it('reports its PAYLOAD as text, not its label', () => {
    expect(withEditor(() => $createPillNode(DATA).getTextContent())).toBe(DATA.payload);
  });

  /*
   * THE ASSERTION THE WHOLE FEATURE RESTS ON: what the composer reads is what
   * the model gets, and a pill in the middle of a typed sentence contributes its
   * payload in place.
   */
  it('contributes its payload to the root text, in place', () => {
    const text = withEditor(() => {
      const root = $getRoot();
      const p = $createParagraphNode();
      p.append($createTextNode('please '), $createPillNode(DATA), $createTextNode(' today'));
      root.append(p);
      return root.getTextContent();
    });
    expect(text).toBe(`please ${DATA.payload} today`);
  });

  it('is inline, so it sits in a sentence rather than breaking one', () => {
    expect(withEditor(() => $createPillNode(DATA).isInline())).toBe(true);
  });

  it('survives a round trip through JSON', () => {
    const back = withEditor(() => {
      const json = $createPillNode(DATA).exportJSON();
      return PillNode.importJSON(json as never);
    });
    expect(back.getTextContent()).toBe(DATA.payload);
    expect(back.__data.label).toBe(DATA.label);
    expect(back.__data.icon).toBe('image');
  });

  it('reads a malformed serialized pill without throwing', () => {
    const back = withEditor(() => PillNode.importJSON({ type: 'pd-pill', version: 1 } as never));
    expect(back.getTextContent()).toBe('');
    expect(back.__data.icon).toBe('file');
  });

  it('clones with its data intact — Lexical clones on every edit', () => {
    expect(withEditor(() => PillNode.clone($createPillNode(DATA)).getTextContent())).toBe(
      DATA.payload,
    );
  });

  it('recognises itself and nothing else', () => {
    expect(withEditor(() => $isPillNode($createPillNode(DATA)))).toBe(true);
    expect($isPillNode(null)).toBe(false);
    expect($isPillNode(undefined)).toBe(false);
  });
});
