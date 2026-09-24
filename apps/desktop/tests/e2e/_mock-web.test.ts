/**
 * The loopback internet (_mock-web.mjs), read by web-tools' REAL parsers.
 *
 * The double is only useful if the app's own DuckDuckGo parsers, challenge
 * detection and readability extraction read it exactly as they read the real
 * thing — so that is what is tested, not the HTML by eye.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fetchReadable } from '../../../../packages/web-tools/src/fetch';
import {
  isDuckDuckGoChallenge,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  resolveSearchBackends,
  runWebSearch,
} from '../../../../packages/web-tools/src/search';
// @ts-expect-error - the mock is plain ESM for probes, not typed app code.
import { DEFAULT_CORPUS, makePdf, normaliseQuery, startMockWeb } from './_mock-web.mjs';

type Web = Awaited<ReturnType<typeof startMockWeb>>;
type LogEntry = { endpoint?: string; status: number; challenged?: boolean; url?: string };
let web: Web | null = null;
afterEach(async () => {
  await web?.close();
  web = null;
});

const Q = 'solid state battery';
const EXPECTED = DEFAULT_CORPUS.results[Q] as string[];
const search = (w: Web, q = Q) =>
  runWebSearch(resolveSearchBackends({ backend: 'duckduckgo', fetchImpl: w.fetch }), q, {
    count: 10,
  });

describe('search through the real runWebSearch', () => {
  it('returns the scripted results in order, with the ad dropped', async () => {
    web = await startMockWeb();
    const out = await search(web);
    expect(out.backend).toBe('duckduckgo');
    expect(out.results.map((r) => r.url)).toEqual(EXPECTED);
    expect(out.results[0]?.title).toContain('Solid State Battery Facts');
    expect(out.results[2]?.snippet).toContain('Program overview');
    expect(out.note).toBeUndefined();
    expect(web.log.map((e: LogEntry) => e.endpoint)).toEqual(['html']);
  });

  it('decodes the legacy //duckduckgo.com/l/?uddg= links to the same URLs', async () => {
    web = await startMockWeb({ linkStyle: 'redirect' });
    expect((await search(web)).results.map((r) => r.url)).toEqual(EXPECTED);
  });

  it('falls back to lite when html is challenged', async () => {
    web = await startMockWeb();
    web.challengeNext(1, { endpoints: ['html'] });
    const out = await search(web);
    expect(out.results.map((r) => r.url)).toEqual(EXPECTED);
    expect(web.log.map((e: LogEntry) => [e.endpoint, e.status])).toEqual([
      ['html', 202],
      ['lite', 200],
    ]);
  });

  it('recognises a challenge served with 200, not just 202', async () => {
    web = await startMockWeb();
    web.challengeNext(1, { endpoints: ['html'], status: 200 });
    expect((await search(web)).results).toHaveLength(EXPECTED.length);
    expect(web.log[0]).toMatchObject({ endpoint: 'html', status: 200, challenged: true });
  });

  it('says it was rate-limited when both endpoints are challenged', async () => {
    web = await startMockWeb();
    web.challengeNext(2);
    const out = await search(web);
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/rate-limiting/);
  });

  it('answers an unscripted query from the corpus text, and a miss with the empty page', async () => {
    web = await startMockWeb();
    const hit = await search(web, 'sulfide electrolyte interface');
    expect(hit.results.map((r) => r.url)).toContain(
      'https://batterylab.university.example/research/interfaces',
    );
    const miss = await search(web, 'zebra migration patterns');
    expect(miss.results).toEqual([]);
    expect(miss.note).toBeUndefined();
  });

  it('serves pages the parsers read directly, and the challenge the detector knows', async () => {
    web = await startMockWeb();
    const html = await (
      await web.fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(Q)}`)
    ).text();
    expect(parseDuckDuckGoHtml(html, 20)).toHaveLength(EXPECTED.length);
    const lite = await (
      await web.fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(Q)}`)
    ).text();
    expect(parseDuckDuckGoLite(lite, 20).map((r) => r.url)).toEqual(EXPECTED);
    web.challengeNext(1);
    const challenge = await (await web.fetch('https://html.duckduckgo.com/html/?q=x')).text();
    expect(isDuckDuckGoChallenge(challenge)).toBe(true);
  });
});

describe('pages', () => {
  it('extracts an article with the real readability path', async () => {
    web = await startMockWeb();
    const page = await fetchReadable(
      'https://www.energy-agency.example/vehicles/solid-state-batteries',
      {
        fetchImpl: web.fetch,
      },
    );
    // Readability's own title heuristic cuts at the hyphen in "Solid-State" —
    // the real extractor's behaviour, which is the point of using it here.
    expect(page.title).toContain('Energy Agency Vehicle Technologies Office');
    expect(page.markdown).toContain('14 solid-state battery research projects');
    expect(page.markdown).not.toContain('Accept all');
  });

  it('follows a redirect on loopback and reports the public final URL', async () => {
    web = await startMockWeb();
    const res = await web.fetch('https://www.techdaily.example/amp/solid-state-pilot');
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe('https://www.techdaily.example/2026/09/solid-state-batteries-pilot-line');
    const page = await fetchReadable('https://www.techdaily.example/amp/solid-state-pilot', {
      fetchImpl: web.fetch,
    });
    expect(page.url).toBe('https://www.techdaily.example/2026/09/solid-state-batteries-pilot-line');
  });

  it('serves a real PDF and a dead link, and never leaves loopback for an unknown host', async () => {
    web = await startMockWeb();
    const pdf = await web.fetch('https://papers.openarchive.example/2026/solid-state-review.pdf');
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 8)
        .toString('latin1'),
    ).toBe('%PDF-1.4');
    expect((await web.fetch('https://gone.example/old-battery-news')).status).toBe(404);
    const unknown = await web.fetch('https://www.not-in-the-corpus.example/');
    expect(unknown.status).toBe(404);
    expect(web.log.at(-1)).toMatchObject({ endpoint: 'site', status: 404 });
    web.fail('https://encyclopedia.example/wiki/Solid-state_battery', 503);
    expect((await web.fetch('https://encyclopedia.example/wiki/Solid-state_battery')).status).toBe(
      503,
    );
  });

  it('can hand out loopback links for a consumer that cannot take a fetch', async () => {
    web = await startMockWeb({ linkMode: 'loopback' });
    const out = await search(web);
    expect(out.results.every((r) => r.url.startsWith(`${web?.url}/site/`))).toBe(true);
    const direct = await fetch(out.results[2]?.url ?? '');
    expect(await direct.text()).toContain('Energy Agency');
  });
});

describe('helpers', () => {
  it('normalises queries: case, punctuation, plurals', () => {
    expect(normaliseQuery('Solid-State  Batteries?')).toBe('solid state battery');
    expect(normaliseQuery('glass status analysis cells')).toBe('glass status analysis cell');
  });

  it('writes a PDF whose xref offsets point at its objects', () => {
    const buf = makePdf('Title (with parens)', ['One paragraph of text.']);
    const text = buf.toString('latin1');
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...text.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => {
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(text).toContain('(Title \\(with parens\\)) Tj');
  });
});
