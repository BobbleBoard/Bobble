// @vitest-environment jsdom
/**
 * The Sources card: what an answer that used the web ends with — the three
 * that matter most, the rest folded (inert, asking main nothing) until "Show
 * all". And the letter a site's tile shows before (or instead of) its icon.
 */
import type { AssistantMsg, ToolResultMsg } from '@pi-desktop/engine';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tileLetter } from './SourceFavicon';
import { SourcesCard } from './SourcesCard';
import { TurnSourcesProvider } from './turn-sources';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const rows = Array.from({ length: 5 }, (_, i) => ({
  title: `Page ${i + 1}`,
  url: `https://site${i + 1}.example/p`,
  snippet: `About page ${i + 1}.`,
}));
const SEARCH = `5 result(s) via duckduckgo\n\n${rows
  .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
  .join('\n\n')}`;

function turn(answer: string): { group: AssistantMsg[]; results: Map<string, ToolResultMsg> } {
  return {
    group: [
      {
        kind: 'assistant',
        id: 'a1',
        timestamp: 1,
        blocks: [{ type: 'toolCall', id: 'c1', name: 'web_search', arguments: { query: 'q' } }],
      },
      { kind: 'assistant', id: 'a2', timestamp: 2, blocks: [{ type: 'text', text: answer }] },
    ],
    results: new Map([
      [
        'c1',
        {
          kind: 'toolResult',
          id: 'tr-a1-c1',
          toolCallId: 'c1',
          toolName: 'web_search',
          text: SEARCH,
          isError: false,
          timestamp: 1,
        } satisfies ToolResultMsg,
      ],
    ]),
  };
}

describe('SourcesCard', () => {
  it('lists what the answer cites first, three on show, the rest folded and inert', () => {
    const { group, results } = turn('Claim. [Five](https://site5.example/p)');
    const html = renderToStaticMarkup(
      <TurnSourcesProvider group={group} resultFor={results}>
        <SourcesCard />
      </TurnSourcesProvider>,
    );
    const titles = [...html.matchAll(/data-testid="source-row-title">([^<]+)</g)].map((m) => m[1]);
    expect(titles).toEqual(['Page 5', 'Page 1', 'Page 2', 'Page 3', 'Page 4']);
    expect(html).toContain('Show all');
    // The folded rows are there to animate open, but out of the tab order.
    const folded = html.slice(html.indexOf('pd-sources-more-inner'));
    expect(folded).toContain('inert=""');
    expect(folded).toContain('Page 3');
  });

  it('comes up into place under an answer that just finished, and only then', () => {
    const { group, results } = turn('No citations.');
    const shown = (arriving?: boolean) =>
      renderToStaticMarkup(
        <TurnSourcesProvider group={group} resultFor={results}>
          <SourcesCard {...(arriving === undefined ? {} : { arriving })} />
        </TurnSourcesProvider>,
      );
    expect(shown(true)).toContain('class="pd-sources pd-arrive"');
    expect(shown()).toContain('class="pd-sources"');
    expect(shown(false)).not.toContain('pd-arrive');
  });

  it('draws nothing for a turn that saw no web pages', () => {
    const html = renderToStaticMarkup(
      <TurnSourcesProvider group={[]} resultFor={new Map()}>
        <SourcesCard />
      </TurnSourcesProvider>,
    );
    expect(html).toBe('');
  });

  it('"Show all" opens the rest in place and becomes "Show less"', async () => {
    const { group, results } = turn('No citations.');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TurnSourcesProvider group={group} resultFor={results}>
          <SourcesCard />
        </TurnSourcesProvider>,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="sources-toggle"]');
    expect(toggle?.textContent).toContain('Show all');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.textContent).toContain('Show less');
    expect(container.querySelector('.pd-sources-more')?.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('.pd-sources-more-inner')?.hasAttribute('inert')).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe('tileLetter', () => {
  it("takes the site's name, else its own label — not `www.` or `en.`", () => {
    expect(tileLetter('Neuro Journal', 'journal.example')).toBe('N');
    expect(tileLetter(undefined, 'en.wikipedia.org')).toBe('W');
    expect(tileLetter(undefined, 'nature.com')).toBe('N');
    expect(tileLetter('  «Le Monde»', 'lemonde.fr')).toBe('L');
  });
});
