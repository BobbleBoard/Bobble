/**
 * A source's name, icon and picture: read from the page's own head, first-party
 * only, small, and kept — and a page that cannot be reached costs a few
 * minutes' memory, never a wrong answer or a thrown error.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeSourceUrl } from './source-fetch';
import { clearSourceMetaMemory, sourceMeta, sourceMetaUrl } from './source-meta';
import { decodeEntities, parsePageMeta, tagAttributes } from './source-meta-parse';

describe('parsePageMeta — what a page says about itself', () => {
  const HEAD = `<!doctype html><html><head>
    <meta charset="utf-8">
    <title>Complete wiring map &amp; more | Health Research</title>
    <meta property="og:site_name" content="Health Research">
    <meta property="og:title" content="Complete wiring map of an adult fruit fly brain">
    <meta name="description" content="Fallback description">
    <meta property='og:description' content='At a glance: scientists built a roadmap.'>
    <meta property="og:image" content="/img/fly.jpg">
    <link rel="icon" href="/favicon.ico">
    <link rel="icon" type="image/png" sizes="32x32" href="/icons/32.png">
    <link rel="apple-touch-icon" href="https://cdn.example/touch.png">
    <link rel="mask-icon" href="/mask.svg" color="#000">
  </head><body><meta property="og:image" content="/not-this.jpg"></body></html>`;

  it('reads the Open Graph fields, resolving relative URLs against the page', () => {
    const meta = parsePageMeta(HEAD, 'https://health.example/news/x');
    expect(meta.siteName).toBe('Health Research');
    expect(meta.title).toBe('Complete wiring map of an adult fruit fly brain');
    expect(meta.description).toBe('At a glance: scientists built a roadmap.');
    expect(meta.image).toBe('https://health.example/img/fly.jpg');
  });

  it('ranks icons for a 16px row: a sized PNG, then the touch icon, then the bare ico — never a mask', () => {
    const meta = parsePageMeta(HEAD, 'https://health.example/news/x');
    expect(meta.icons).toEqual([
      'https://health.example/icons/32.png',
      'https://cdn.example/touch.png',
      'https://health.example/favicon.ico',
    ]);
  });

  it('falls back to <title> and the plain description, and honours <base href>', () => {
    const meta = parsePageMeta(
      '<head><base href="https://cdn.example/site/"><title>Just &#8220;a&#8221; title</title><meta name="description" content="D"><meta name="twitter:image" content="pic.png"></head>',
      'https://page.example/',
    );
    expect(meta.title).toBe('Just “a” title');
    expect(meta.description).toBe('D');
    expect(meta.image).toBe('https://cdn.example/site/pic.png');
    expect(meta.siteName).toBeUndefined();
  });

  it('reads attributes in any quoting, entities decoded', () => {
    expect(
      tagAttributes(`<meta property=og:title content="A &quot;b&quot; c" data-x='y'>`),
    ).toEqual({
      property: 'og:title',
      content: 'A "b" c',
      'data-x': 'y',
    });
    expect(decodeEntities('&lt;&#x27;&amp;&nbsp;&unknown;')).toBe("<'& &unknown;");
  });

  it('drops a share picture that is not http(s)', () => {
    expect(
      parsePageMeta(
        '<meta property="og:image" content="javascript:alert(1)">',
        'https://a.example/',
      ).image,
    ).toBeUndefined();
  });
});

describe('routeSourceUrl — the probe seam', () => {
  it('is the identity outside a probe', () => {
    expect(routeSourceUrl('https://a.example/p?q=1', {})).toBe('https://a.example/p?q=1');
    expect(
      routeSourceUrl('https://a.example/p', { PI_E2E_SOURCES_ORIGIN: 'http://127.0.0.1:9' }),
    ).toBe('https://a.example/p');
  });

  it('sends a probe to its loopback double', () => {
    expect(
      routeSourceUrl('https://a.example/p?q=1', {
        PI_E2E: '1',
        PI_E2E_SOURCES_ORIGIN: 'http://127.0.0.1:9/',
      }),
    ).toBe('http://127.0.0.1:9/site/a.example/p?q=1');
  });
});

/* ── the fetching half, against a fake site ──────────────────────────────── */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPG = Buffer.alloc(3000, 7);

interface Route {
  status?: number;
  type: string;
  body: Buffer | string;
}

function fakeSite(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (r === undefined) {
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
    return new Response(new Uint8Array(body), {
      status: r.status ?? 200,
      headers: { 'content-type': r.type },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const PAGE = 'https://atlas.example/news/fly';
const HTML = `<html><head><title>T</title><meta property="og:site_name" content="Brain Atlas">
<meta property="og:image" content="https://atlas.example/og.jpg"><link rel="icon" type="image/png" sizes="32x32" href="/i.png"></head><body>`;

let dir: string;
beforeEach(() => {
  clearSourceMetaMemory();
  dir = mkdtempSync(path.join(tmpdir(), 'pd-source-meta-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sourceMeta', () => {
  it('reads the head, the icon and the picture — each from the site itself', async () => {
    const site = fakeSite({
      [PAGE]: { type: 'text/html', body: HTML },
      'https://atlas.example/i.png': { type: 'image/png', body: PNG },
      'https://atlas.example/og.jpg': { type: 'image/jpeg', body: JPG },
    });
    const meta = await sourceMeta(`${PAGE}#frag`, {
      fetchImpl: site.fetchImpl,
      cacheDir: dir,
      thumbnail: (bytes, type) => ({ data: bytes.subarray(0, 4), type }),
      hostIcon: async () => null,
    });
    expect(meta).toMatchObject({ url: PAGE, siteName: 'Brain Atlas', title: 'T' });
    expect(meta?.icon).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(meta?.image).toBe(`data:image/jpeg;base64,${JPG.subarray(0, 4).toString('base64')}`);
    // FIRST-PARTY: every request went to the page's own site.
    expect(site.calls.every((u) => u.startsWith('https://atlas.example/'))).toBe(true);
  });

  it('asks once: kept in memory and on disk, so a restart does not fetch again', async () => {
    const site = fakeSite({ [PAGE]: { type: 'text/html', body: HTML } });
    const deps = { fetchImpl: site.fetchImpl, cacheDir: dir, hostIcon: async () => null };
    await Promise.all([sourceMeta(PAGE, deps), sourceMeta(PAGE, deps)]);
    const first = site.calls.length;
    expect(site.calls.filter((u) => u === PAGE)).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    clearSourceMetaMemory(); // a new process
    const again = await sourceMeta(PAGE, deps);
    expect(again?.siteName).toBe('Brain Atlas');
    expect(site.calls.length).toBe(first);
  });

  it('a page that cannot be reached: an answer with what is known, not kept on disk, asked again later', async () => {
    let now = 1_000_000;
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const deps = {
      fetchImpl: offline,
      cacheDir: dir,
      hostIcon: async () => 'data:image/png;base64,AAAA',
      now: () => now,
    };
    const meta = await sourceMeta(PAGE, deps);
    expect(meta).toEqual({ url: PAGE, icon: 'data:image/png;base64,AAAA' });
    expect(readdirSync(dir)).toHaveLength(0);
    // Remembered briefly…
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await sourceMeta(PAGE, { ...deps, fetchImpl: counting });
    expect(calls).toBe(0);
    // …and asked again once that has passed.
    now += 6 * 60 * 1000;
    await sourceMeta(PAGE, { ...deps, fetchImpl: counting });
    expect(calls).toBeGreaterThan(0);
  });

  it('refuses what is not an icon or not a picture, and anything past its cap', async () => {
    const site = fakeSite({
      [PAGE]: { type: 'text/html', body: HTML },
      // An HTML error page served at the icon's URL is common.
      'https://atlas.example/i.png': { type: 'text/html', body: '<h1>404</h1>' },
      'https://atlas.example/og.jpg': { type: 'image/jpeg', body: Buffer.alloc(5 * 1024 * 1024) },
    });
    const meta = await sourceMeta(PAGE, {
      fetchImpl: site.fetchImpl,
      cacheDir: null,
      hostIcon: async () => null,
    });
    expect(meta?.icon).toBeUndefined();
    expect(meta?.image).toBeUndefined();
  });

  it('keeps an undecodable picture only when it is small', async () => {
    const small = Buffer.alloc(2000, 1);
    const site = fakeSite({
      [PAGE]: { type: 'text/html', body: HTML },
      'https://atlas.example/og.jpg': { type: 'image/webp', body: small },
    });
    const meta = await sourceMeta(PAGE, {
      fetchImpl: site.fetchImpl,
      cacheDir: null,
      thumbnail: () => null,
      hostIcon: async () => null,
    });
    expect(meta?.image).toBe(`data:image/webp;base64,${small.toString('base64')}`);
  });

  it('is null for what is not a web page, and never throws', async () => {
    expect(sourceMetaUrl('file:///etc/hosts')).toBeNull();
    expect(sourceMetaUrl('https://u:p@a.example/')).toBeNull();
    expect(await sourceMeta('javascript:alert(1)')).toBeNull();
  });

  /*
   * A search result is text from the internet: a row that fetched the user's
   * router because a page listed it would be a GET against their own network.
   */
  it('never asks a host on this machine or its network', async () => {
    for (const local of [
      'http://localhost:8080/admin',
      'http://127.0.0.1/',
      'http://192.168.1.1/',
      'http://10.0.0.5/x',
      'http://172.20.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.101.102.103/',
      'http://[::1]/',
      'http://[fd12::1]/',
      'http://printer.local/',
      'http://nas/',
      'http://router.home.arpa/',
    ]) {
      expect(sourceMetaUrl(local), local).toBeNull();
    }
    expect(sourceMetaUrl('https://8.8.8.8/')).toBe('https://8.8.8.8/');
    expect(sourceMetaUrl('https://nature.com/articles/x')).toBe('https://nature.com/articles/x');
  });

  it('checks every redirect: a public page cannot bounce the request inward', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === PAGE) {
        return new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/' } });
      }
      return new Response('<html><head><title>LAN</title></head>', {
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;
    const meta = await sourceMeta(PAGE, { fetchImpl, cacheDir: null, hostIcon: async () => null });
    expect(calls).toEqual([PAGE]);
    expect(meta).toEqual({ url: PAGE });
  });
});
