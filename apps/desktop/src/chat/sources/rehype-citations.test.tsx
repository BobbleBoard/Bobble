// @vitest-environment jsdom
/**
 * Which links become citations, and how runs of them merge — first on the
 * tree pass alone, then through the chat's real markdown renderer with a
 * turn's sources provided, the way AssistantGroup renders an answer.
 */
import type { AssistantMsg, ToolResultMsg } from '@pi-desktop/engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../markdown';
import { CITE_TAG, rehypeCitations } from './rehype-citations';
import { sourceKey } from './source-model';
import { TurnSourcesProvider } from './turn-sources';

interface H {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: H[];
}
const t = (value: string): H => ({ type: 'text', value });
const a = (href: string, text: string): H => ({
  type: 'element',
  tagName: 'a',
  properties: { href },
  children: [t(text)],
});
const p = (...children: H[]): H => ({ type: 'element', tagName: 'p', properties: {}, children });
const root = (...children: H[]): H => ({ type: 'root', children });

const SOURCES = new Set(['a.example/1', 'b.example/2', 'c.example/3']);
const keyOf = (href: string): string | null => {
  const k = sourceKey(href);
  return k !== null && SOURCES.has(k) ? k : null;
};
const run = (tree: H): H => {
  rehypeCitations({ keyOf })(tree as never);
  return tree;
};
/** The paragraph back as text, a cite written as {keys}. */
function flat(node: H): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.tagName === CITE_TAG) return `{${String(node.properties?.dataKeys)}}`;
  if (node.tagName === 'a') return `<${String(node.properties?.href)}>`;
  return (node.children ?? []).map(flat).join('');
}

describe('rehypeCitations — the tree pass', () => {
  it('turns one source link into one cite', () => {
    const tree = run(root(p(t('Claim. '), a('https://a.example/1', 'A'))));
    expect(flat(tree)).toBe('Claim. {a.example/1}');
  });

  it('merges links that sit together — by spaces, commas, semicolons or "and"', () => {
    const tree = run(
      root(
        p(
          t('Claim. '),
          a('https://a.example/1', 'A'),
          t(' '),
          a('https://b.example/2', 'B'),
          t(', and '),
          a('https://c.example/3', 'C'),
          t(' Next sentence.'),
        ),
      ),
    );
    expect(flat(tree)).toBe('Claim. {a.example/1 b.example/2 c.example/3} Next sentence.');
  });

  it('takes the brackets a run fills, and puts the full stop back before it', () => {
    const tree = run(
      root(
        p(
          t('the result ('),
          a('https://a.example/1', 'A'),
          t(', '),
          a('https://b.example/2', 'B'),
          t(').'),
        ),
      ),
    );
    expect(flat(tree)).toBe('the result. {a.example/1 b.example/2}');
  });

  it('joins "(A) (B)" once their brackets are gone', () => {
    const tree = run(
      root(
        p(t('x ('), a('https://a.example/1', 'A'), t(') ('), a('https://b.example/2', 'B'), t(')')),
      ),
    );
    expect(flat(tree)).toBe('x {a.example/1 b.example/2}');
  });

  it('leaves a link to a page the turn never saw alone — and it breaks a run', () => {
    const tree = run(
      root(
        p(
          a('https://a.example/1', 'A'),
          t(' '),
          a('https://elsewhere.example/', 'X'),
          t(' '),
          a('https://b.example/2', 'B'),
        ),
      ),
    );
    expect(flat(tree)).toBe('{a.example/1} <https://elsewhere.example/> {b.example/2}');
  });

  it('keeps brackets that hold more than citations', () => {
    const tree = run(root(p(t('(see '), a('https://a.example/1', 'A'), t(', page 3)'))));
    expect(flat(tree)).toBe('(see {a.example/1}, page 3)');
  });

  it('marks a citation that is its whole line as a reference-list line', () => {
    const tree = run(
      root({ type: 'element', tagName: 'li', children: [a('https://a.example/1', 'The paper')] }),
    );
    const cite = tree.children?.[0]?.children?.[0];
    expect(cite?.tagName).toBe(CITE_TAG);
    expect(cite?.properties?.dataStandalone).toBe('true');
    expect(cite?.properties?.dataLabel).toBe('The paper');
  });

  it('never looks inside code', () => {
    const code: H = { type: 'element', tagName: 'code', children: [a('https://a.example/1', 'A')] };
    const tree = run(root(p(code)));
    expect(flat(tree)).toBe('<https://a.example/1>');
  });
});

/* ── through the real renderer ────────────────────────────────────────── */

const SEARCH = [
  '3 result(s) via duckduckgo',
  '',
  '[1] Page A',
  '    https://a.example/1',
  '    About A.',
  '',
  '[2] Page B',
  '    https://b.example/2',
  '    About B.',
  '',
  '[3] Page C',
  '    https://c.example/3',
  '    About C.',
  '',
  'Cite a page you use as [site name](url) right after the sentence it supports.',
].join('\n');

function answer(text: string): string {
  const group: AssistantMsg[] = [
    {
      kind: 'assistant',
      id: 'a1',
      timestamp: 1,
      blocks: [
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'web search "x"' } },
      ],
    },
    { kind: 'assistant', id: 'a2', timestamp: 2, blocks: [{ type: 'text', text }] },
  ];
  const results = new Map<string, ToolResultMsg>([
    [
      'c1',
      {
        kind: 'toolResult',
        id: 'tr-a1-c1',
        toolCallId: 'c1',
        toolName: 'bash',
        text: SEARCH,
        isError: false,
        timestamp: 1,
      },
    ],
  ]);
  return renderToStaticMarkup(
    <TurnSourcesProvider group={group} resultFor={results}>
      <Markdown text={text} />
    </TurnSourcesProvider>,
  );
}

describe('citations in the chat renderer', () => {
  it('draws merged chips with "+N", and leaves other links as links', () => {
    const html = answer(
      'One. [A](https://a.example/1) [B](https://www.b.example/2/) [C](http://c.example/3)\n\n' +
        'Two, see the [viewer](https://viewer.example/).',
    );
    const chips = [...html.matchAll(/data-testid="source-chip" data-count="(\d)"/g)].map(
      (m) => m[1],
    );
    expect(chips).toEqual(['3']);
    expect(html).toContain('+2');
    expect(html).toContain('href="https://viewer.example/"');
    expect(html).not.toContain('href="https://a.example/1"');
  });

  it('is ordinary markdown outside a turn that saw sources', () => {
    const html = renderToStaticMarkup(<Markdown text="[A](https://a.example/1)" />);
    expect(html).toContain('href="https://a.example/1"');
    expect(html).not.toContain('source-chip');
  });

  it('leaves code alone', () => {
    const html = answer('`[A](https://a.example/1)`');
    expect(html).not.toContain('source-chip');
  });
});
