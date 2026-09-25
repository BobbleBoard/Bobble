/**
 * Which pages a turn saw, which of them its answer cites, and the order the
 * Sources card lists them in — the rules behind every chip.
 */
import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  collectTurnSources,
  linkedKeys,
  orderForCard,
  parseFetchedPages,
  siteLabel,
  sourceKey,
  webCallsOf,
  webCommandKinds,
} from './source-model';

/** What `web search` / web_search prints (packages/web-tools). */
function searchText(rows: { title: string; url: string; snippet: string }[], hint = true): string {
  const lines = rows.map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`);
  const cite = hint
    ? '\n\nIn your reply, cite each page you use as [site name](url) right after the sentence it supports.'
    : '';
  return `${rows.length} result(s) via duckduckgo\n\n${lines.join('\n\n')}${cite}`;
}

const A = {
  title: 'Fly brain wiring diagram',
  url: 'https://www.atlas.example/news/fly/',
  snippet: 'All 139,255 neurons.',
};
const B = {
  title: 'Cell types | Neuro Journal',
  url: 'https://journal.example/a/1?utm_source=x',
  snippet: '8,453 types.',
};
const C = {
  title: 'Nerve cord map',
  url: 'https://medschool.example/nerve-cord',
  snippet: 'A spinal cord.',
};

describe('sourceKey — one page, however it is written', () => {
  it('ignores scheme, www., trailing slashes, fragments and tracking parameters', () => {
    const k = sourceKey('https://www.atlas.example/news/fly/');
    expect(k).toBe('atlas.example/news/fly');
    for (const same of [
      'http://atlas.example/news/fly',
      'https://atlas.example/news/fly#methods',
      'https://ATLAS.example/news/fly/?utm_source=newsletter&utm_medium=email',
      'https://atlas.example/news/fly/index.html',
    ]) {
      expect(sourceKey(same)).toBe(k);
    }
  });

  it('keeps what changes the page: the path case and real parameters, in any order', () => {
    expect(sourceKey('https://x.example/Wiki/Foo')).not.toBe(
      sourceKey('https://x.example/wiki/foo'),
    );
    expect(sourceKey('https://x.example/p?id=2&lang=en')).toBe(
      sourceKey('https://x.example/p?lang=en&id=2'),
    );
    expect(sourceKey('https://x.example/p?id=2')).not.toBe(sourceKey('https://x.example/p?id=3'));
  });

  it('reads percent-encoding and the character it stands for as the same path', () => {
    expect(sourceKey('https://en.example/wiki/A%E2%80%93B')).toBe(
      sourceKey('https://en.example/wiki/A–B'),
    );
  });

  it('is null for anything that is not a web page', () => {
    for (const bad of [
      'mailto:a@b.example',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(sourceKey(bad)).toBeNull();
    }
  });
});

describe('which calls were web research', () => {
  it('knows the native tools', () => {
    expect(webCallsOf('web_search', { query: 'q' })).toEqual([{ kind: 'search' }]);
    expect(webCallsOf('web_fetch', { url: 'https://a.example' })).toEqual([{ kind: 'fetch' }]);
    expect(webCallsOf('read', { path: 'x' })).toEqual([]);
  });

  it('knows the CLI lines, wherever they sit in the shell line', () => {
    expect(webCommandKinds('web search "fly connectome"')).toEqual({ search: true, fetch: false });
    expect(webCommandKinds('  web fetch https://a.example')).toEqual({
      search: false,
      fetch: true,
    });
    expect(webCommandKinds('cd /tmp && web fetch https://a.example | head -40')).toEqual({
      search: false,
      fetch: true,
    });
    expect(webCallsOf('bash', { command: 'web search "a"; web fetch https://b.example' })).toEqual([
      { kind: 'search' },
      { kind: 'fetch' },
    ]);
    // Not ours: a word that merely contains "web".
    expect(webCommandKinds('cobweb search things')).toEqual({ search: false, fetch: false });
    expect(webCallsOf('bash', { command: 'curl https://a.example' })).toEqual([]);
  });
});

describe('parseFetchedPages', () => {
  it('reads the title, the URL and the opening of the article', () => {
    const text =
      '# The Title\nURL: https://a.example/p\n\nFirst **bold** paragraph with a [link](https://x.example).\n\nMore.';
    expect(parseFetchedPages(text)).toEqual([
      {
        url: 'https://a.example/p',
        title: 'The Title',
        snippet: 'First bold paragraph with a link. More.',
      },
    ]);
  });

  it('reads every page a shell line fetched, and nothing from a failure', () => {
    const text =
      '# One\nURL: https://a.example/1\n\nAlpha.\n# Two\nURL: https://b.example/2\n(content truncated)\n\nBeta.';
    expect(parseFetchedPages(text).map((p) => [p.title, p.url, p.snippet])).toEqual([
      ['One', 'https://a.example/1', 'Alpha.'],
      ['Two', 'https://b.example/2', 'Beta.'],
    ]);
    expect(parseFetchedPages('Fetch failed: HTTP 404 Not Found')).toEqual([]);
  });
});

describe('collectTurnSources', () => {
  it('collects searches and fetches, native and CLI alike, first sighting first', () => {
    const sources = collectTurnSources([
      {
        name: 'bash',
        args: { command: 'web search "fly brain"' },
        result: { text: searchText([A, B]), isError: false },
      },
      {
        name: 'web_search',
        args: { query: 'nerve cord' },
        result: { text: searchText([C, A]), isError: false },
      },
      {
        name: 'bash',
        args: { command: `web fetch ${C.url}` },
        result: { text: `# Nerve cord map — full\nURL: ${C.url}\n\nThe article.`, isError: false },
      },
    ]);
    expect(sources.map((s) => s.key)).toEqual([
      'atlas.example/news/fly',
      'journal.example/a/1',
      'medschool.example/nerve-cord',
    ]);
    const c = sources[2];
    // Listed by a search, then opened: one source, read, keeping what the
    // search showed the model.
    expect(c?.read).toBe(true);
    expect(c?.title).toBe('Nerve cord map');
    expect(c?.rank).toBe(1);
    expect(c?.search).toBe(1);
    // The citation hint the tools print is not the last result's snippet.
    expect(sources[1]?.snippet).toBe('8,453 types.');
  });

  it('a page whose printed header was cut off is still the page the call asked for', () => {
    const tail = 'the last lines of a long article\n'.repeat(3);
    const sources = collectTurnSources([
      {
        name: 'bash',
        args: { command: 'web fetch "https://long.example/a"' },
        result: { text: tail, isError: false },
      },
      {
        name: 'web_fetch',
        args: { url: 'https://long.example/b' },
        result: { text: tail, isError: false },
      },
      {
        name: 'web_fetch',
        args: { url: 'https://down.example/' },
        result: { text: 'Fetch failed: HTTP 403 Forbidden', isError: false },
      },
    ]);
    expect(sources.map((s) => [s.url, s.read])).toEqual([
      ['https://long.example/a', true],
      ['https://long.example/b', true],
    ]);
  });

  it('ignores calls that failed, are still running, or are not research', () => {
    expect(
      collectTurnSources([
        { name: 'web_search', args: {}, result: { text: searchText([A]), isError: true } },
        { name: 'web_search', args: {} },
        { name: 'read', args: {}, result: { text: searchText([B]), isError: false } },
      ]),
    ).toEqual([]);
  });
});

describe('linkedKeys', () => {
  it('finds markdown links and autolinks in order, once each', () => {
    const md = `Claim. [Atlas](${A.url}) and [again](https://atlas.example/news/fly). See https://journal.example/a/1.`;
    expect(linkedKeys(md)).toEqual(['atlas.example/news/fly', 'journal.example/a/1']);
  });

  it('keeps parentheses that belong to the URL', () => {
    expect(linkedKeys('[x](https://en.example/wiki/Fly_(insect))')).toEqual([
      'en.example/wiki/Fly_(insect)',
    ]);
  });
});

describe('orderForCard', () => {
  const sources = collectTurnSources([
    { name: 'web_search', args: {}, result: { text: searchText([A, B]), isError: false } },
    {
      name: 'web_search',
      args: {},
      result: { text: searchText([C, { ...A, url: 'https://z.example/' }]), isError: false },
    },
    {
      name: 'web_fetch',
      args: {},
      result: { text: '# Read one\nURL: https://read.example/x\n\nText.', isError: false },
    },
  ]);

  it('cited first (in citation order), then read, then by rank across searches', () => {
    const order = orderForCard(sources, ['journal.example/a/1']).map((s) => s.host);
    expect(order).toEqual([
      'journal.example', // cited
      'read.example', // opened
      'atlas.example', // rank 1 of search 0
      'medschool.example', // rank 1 of search 1
      'z.example', // rank 2 of search 1
    ]);
  });
});

describe('labels', () => {
  it('drops the site name hung on the end of a title, and only that', () => {
    expect(cleanTitle('Cell types | Neuro Journal', 'Neuro Journal', 'journal.example')).toBe(
      'Cell types',
    );
    expect(cleanTitle('Complete map - NIH', undefined, 'nih.gov')).toBe('Complete map');
    expect(cleanTitle('Fly brain - a primer', 'Neuro Journal', 'journal.example')).toBe(
      'Fly brain - a primer',
    );
  });

  it('names a site by its own name, else its host', () => {
    expect(siteLabel('  Brain  Atlas ', 'atlas.example')).toBe('Brain Atlas');
    expect(siteLabel(undefined, 'atlas.example')).toBe('atlas.example');
  });
});
