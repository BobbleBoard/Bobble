/**
 * A SMALL, POLITE INTERNET ON LOOPBACK — DuckDuckGo, some articles, a PDF,
 * and the page DuckDuckGo shows bots.
 *
 * Web search and research are exactly the features a probe must not run
 * against the real thing: results change daily, DuckDuckGo rate-limits
 * automated requests (and serves its anomaly page with a 2xx status, so a
 * status check alone misses it), and a suite that fires thirty queries at a
 * third party is not polite. This serves the same shapes the app already
 * parses — `html.duckduckgo.com/html/` result blocks, the `lite` table, the
 * challenge interstitial — plus the pages the results point at, from a corpus
 * the test controls.
 *
 * ## Routes
 *
 *   POST|GET /html/        DuckDuckGo's html results (current markup: direct
 *                          hrefs, `<b>` highlights, one ad block first). `q`, `s`
 *                          (offset) from the form body or the query string
 *   POST|GET /lite/        the lite table
 *   GET /site/<host>/<path> the corpus page for https://<host>/<path>
 *   GET /__mock/log        every request, in order
 *
 * ## Reaching it
 *
 * `mockWeb.fetch` is a drop-in `fetch` that sends DuckDuckGo's two endpoints
 * and every corpus host to the mock, follows redirects itself (so nothing ever
 * leaves loopback) and reports the PUBLIC final URL as `response.url`. Hand
 * it to anything with a `fetchImpl` seam:
 *
 *   runWebSearch(resolveSearchBackends({ backend: 'duckduckgo', fetchImpl: web.fetch }), q, …)
 *   fetchReadable(url, { fetchImpl: web.fetch })
 *
 * An unknown host gets a 404 from the mock, never the network. For a consumer
 * that cannot take a fetch (the app, through an endpoint env var), start with
 * `linkMode: 'loopback'` and every result link is a loopback URL already.
 *
 * ## The corpus
 *
 * Pages live on hosts under the reserved `.example` TLD (RFC 2606), so no link
 * in a fixture can ever resolve to a real site, and each page carries its
 * `kind` — primary, research, news, reference, paper, farm — so a ranking test
 * can say "the primary source outranks the content farm" without the fixture
 * pretending to be a real organisation. The default corpus answers
 * "solid state battery" in the order a search engine plausibly would (the
 * content farm first), which is the order a ranker has to fix.
 *
 *   const web = await startMockWeb();                 // DEFAULT_CORPUS
 *   web.challengeNext(1, { endpoints: ['html'] });    // html is "rate-limited" once
 *   … web.log, web.close()
 *
 *   node tests/e2e/_mock-web.mjs --port 8090 [--corpus corpus.json] [--link-mode loopback]
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ── the default corpus ──────────────────────────────────────────────────────

/** Pages for one research question, each labelled with what kind of source it is. */
export const DEFAULT_CORPUS = Object.freeze({
  pages: [
    {
      url: 'https://top10batterytips.example/best-solid-state-batteries-2026',
      kind: 'farm',
      title: '10 AMAZING Solid State Battery Facts You Need To Know (2026)',
      description: 'Everything about solid state batteries, the best batteries of 2026, and more!',
      published: '2026-08-30',
      paragraphs: [
        'Solid state batteries are the future! Experts say they could be up to 10x better than anything you have seen before.',
        'In this article we list the top 10 facts about solid state batteries, so keep reading and share with your friends.',
        'Fact 1: solid state batteries use a solid electrolyte. Fact 2: they might charge really fast. Fact 3: they are coming soon.',
      ],
    },
    {
      url: 'https://www.techdaily.example/2026/09/solid-state-batteries-pilot-line',
      kind: 'news',
      title: 'Pilot line for solid-state cells starts production — TechDaily',
      description: 'A pilot line has begun producing solid-state cells in small volumes.',
      published: '2026-09-12',
      author: 'R. Okafor',
      paragraphs: [
        'A pilot production line for solid-state battery cells started running this month, producing small volumes for vehicle testing.',
        'The company behind the line said the cells reached 450 Wh/kg in its own tests, a figure that has not yet been independently verified.',
        'Analysts cautioned that moving from a pilot line to mass production usually takes several years.',
      ],
      aliases: ['https://www.techdaily.example/amp/solid-state-pilot'],
    },
    {
      url: 'https://www.energy-agency.example/vehicles/solid-state-batteries',
      kind: 'primary',
      title: 'Solid-State Batteries | Energy Agency Vehicle Technologies Office',
      description: 'Program overview of solid-state battery research funded by the agency.',
      published: '2026-06-02',
      paragraphs: [
        'Solid-state batteries replace the liquid electrolyte of a lithium-ion cell with a solid one, which can allow a lithium-metal anode.',
        'The agency funded 14 solid-state battery research projects in fiscal year 2026, with a combined budget of 62 million dollars.',
        'Key open problems are dendrite growth at the lithium interface, the cost of manufacturing thin solid electrolytes, and performance at low temperature.',
      ],
    },
    {
      url: 'https://batterylab.university.example/research/interfaces',
      kind: 'research',
      title: 'Interface stability in sulfide solid electrolytes — Battery Lab',
      description: 'Research group page on interface stability of sulfide solid electrolytes.',
      published: '2026-03-18',
      author: 'Battery Lab',
      paragraphs: [
        'Our group studies why sulfide solid electrolytes degrade at the interface with high-voltage cathodes.',
        'In 2025 we showed that a 5 nm oxide coating reduced interfacial resistance growth by 70 percent over 500 cycles.',
      ],
    },
    {
      url: 'https://papers.openarchive.example/2026/solid-state-review.pdf',
      kind: 'paper',
      pdf: true,
      title: 'A Review of Solid-State Lithium Batteries (2026)',
      description: 'Review paper, 2026.',
      published: '2026-05-01',
      paragraphs: [
        'Abstract. We review progress on solid-state lithium batteries between 2020 and 2026.',
        'Oxide, sulfide and polymer electrolytes each trade ionic conductivity against stability and processability.',
        'We identify interface engineering and scalable thin-film manufacturing as the two main barriers to commercialisation.',
      ],
    },
    {
      url: 'https://encyclopedia.example/wiki/Solid-state_battery',
      kind: 'reference',
      title: 'Solid-state battery — Encyclopedia',
      description: 'Encyclopedia article on solid-state batteries.',
      paragraphs: [
        'A solid-state battery is a battery that uses a solid electrolyte instead of the liquid or polymer gel electrolytes found in lithium-ion batteries.',
        'Materials proposed for solid electrolytes include ceramics such as oxides and sulfides, and solid polymers.',
      ],
    },
    {
      url: 'https://gone.example/old-battery-news',
      kind: 'news',
      status: 404,
      title: 'Page not found',
      paragraphs: ['This page has moved or no longer exists.'],
    },
  ],
  /** Normalised query → result URLs, in the order the "engine" returns them. */
  results: {
    'solid state battery': [
      'https://top10batterytips.example/best-solid-state-batteries-2026',
      'https://www.techdaily.example/amp/solid-state-pilot',
      'https://www.energy-agency.example/vehicles/solid-state-batteries',
      'https://papers.openarchive.example/2026/solid-state-review.pdf',
      'https://batterylab.university.example/research/interfaces',
      'https://encyclopedia.example/wiki/Solid-state_battery',
      'https://gone.example/old-battery-news',
    ],
  },
});

/** batteries → battery, cells → cell; glass, status and analysis stay as they are. */
function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lower-case, strip punctuation, collapse spaces, singular nouns. */
export function normaliseQuery(q) {
  return String(q)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .map(singular)
    .join(' ');
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'to',
  'is',
  'what',
  'how',
]);

function terms(q) {
  return normaliseQuery(q)
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// ── a minimal, valid PDF ────────────────────────────────────────────────────

/** Wrap text at `width` characters on word boundaries. */
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line.length > 0 ? `${line} ${word}` : word;
  }
  if (line.length > 0) out.push(line);
  return out;
}

const pdfText = (s) =>
  s
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

/**
 * A one-page PDF 1.4 with real text objects (Helvetica), correct xref offsets
 * and an Info title — enough for pypdf, pdf.js or Preview to extract every
 * line, which is what a research step reading a paper needs.
 */
export function makePdf(title, paragraphs) {
  const lines = [title, '', ...paragraphs.flatMap((p) => [...wrap(p, 88), ''])].slice(0, 48);
  const ops = ['BT', '/F1 11 Tf', '14 TL', '72 740 Td'];
  for (const [i, line] of lines.entries()) {
    ops.push(`${i === 0 ? '' : 'T* '}(${pdfText(line)}) Tj`);
  }
  ops.push('ET');
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Title (${pdfText(title)}) /Producer (_mock-web.mjs) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── pages ───────────────────────────────────────────────────────────────────

function articleHtml(page) {
  const date = page.published
    ? `<time datetime="${esc(page.published)}">${esc(page.published)}</time>`
    : '';
  const byline = page.author ? `<p class="byline">By ${esc(page.author)} ${date}</p>` : date;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description ?? '')}">
<meta name="x-fixture-kind" content="${esc(page.kind ?? 'page')}">
<link rel="canonical" href="${esc(page.url)}">
</head>
<body>
<div class="cookie-banner">We use cookies to improve your experience. <button>Accept all</button></div>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/subscribe">Subscribe</a></nav></header>
<main>
<article>
<h1>${esc(page.title)}</h1>
${byline}
${(page.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`).join('\n')}
</article>
<aside><h3>Related</h3><ul><li><a href="/more">More stories</a></li></ul></aside>
</main>
<footer><p>Fixture page served by _mock-web.mjs. Nothing here is real.</p></footer>
</body>
</html>
`;
}

const CHALLENGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>DuckDuckGo</title></head>
<body>
<div class="anomaly-modal__mask">
  <div class="anomaly-modal__modal" id="anomaly-modal">
    <h1 class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</h1>
    <p class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</p>
    <form id="challenge-form" action="/anomaly.js?sv=html&amp;cc=botnet" method="POST"></form>
    <p class="anomaly-modal__footer">If this error persists, please let us know: error-lite@duckduckgo.com</p>
  </div>
</div>
</body>
</html>
`;

function emptyResultsHtml(q) {
  return `<!DOCTYPE html>
<html lang="en">
<head><title>${esc(q)} at DuckDuckGo</title></head>
<body>
<div class="serp__results">
  <div class="results">
    <div class="no-results">No results.</div>
  </div>
</div>
</body>
</html>
`;
}

/** Bold the query's terms in a snippet, the way DuckDuckGo highlights. */
function highlight(text, q) {
  let out = esc(text);
  for (const t of terms(q)) {
    out = out.replace(
      new RegExp(`\\b(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi'),
      '<b>$1</b>',
    );
  }
  return out;
}

function snippetOf(page) {
  const s = page.snippet ?? page.description ?? page.paragraphs?.[0] ?? '';
  return s.length > 220 ? `${s.slice(0, 217)}…` : s;
}

function displayUrl(u) {
  const x = new URL(u);
  return `${x.host}${x.pathname}`.replace(/\/$/, '');
}

// ── the server ──────────────────────────────────────────────────────────────

/**
 * Start the mock web. Options: `port`, `host`, `corpus` (DEFAULT_CORPUS),
 * `linkStyle` ('direct' — today's markup — or 'redirect', the legacy
 * `//duckduckgo.com/l/?uddg=` wrapper), `linkMode` ('public' | 'loopback'),
 * `ads` (true), `delayMs` (before every response).
 */
export async function startMockWeb(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const state = {
    corpus: cloneCorpus(opts.corpus ?? DEFAULT_CORPUS),
    linkStyle: opts.linkStyle ?? 'direct',
    linkMode: opts.linkMode ?? 'public',
    ads: opts.ads ?? true,
    delayMs: opts.delayMs ?? 0,
    challenge: { remaining: 0, status: 202, endpoints: ['html', 'lite'], queries: [] },
    failures: new Map(),
    log: [],
    seq: 0,
  };
  let base = '';

  const byUrl = () => {
    const map = new Map();
    for (const p of state.corpus.pages) {
      map.set(p.url, p);
      for (const a of p.aliases ?? []) map.set(a, { ...p, redirectTo: p.url });
    }
    return map;
  };

  /** Public URL → the loopback URL that serves it. */
  const loopbackFor = (publicUrl) => {
    const u = new URL(publicUrl);
    return `${base}/site/${u.host}${u.pathname}${u.search}`;
  };
  /** Loopback `/site/…` URL → the public URL it stands for (or null). */
  const publicFor = (loopUrl) => {
    const u = new URL(loopUrl);
    const m = /^\/site\/([^/]+)(\/.*)?$/.exec(u.pathname);
    return m === null ? null : `https://${m[1]}${m[2] ?? '/'}${u.search}`;
  };

  const linkFor = (publicUrl) => {
    const target = state.linkMode === 'loopback' ? loopbackFor(publicUrl) : publicUrl;
    if (state.linkStyle !== 'redirect') return target;
    return `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=${'0'.repeat(64)}`;
  };

  function resultsFor(q) {
    const pages = byUrl();
    const listed = state.corpus.results?.[normaliseQuery(q)];
    if (listed !== undefined) {
      return listed.map((u) => {
        const p = pages.get(u);
        return { url: u, title: p?.title ?? u, snippet: p ? snippetOf(p) : '' };
      });
    }
    // Not scripted: rank corpus pages by how many query terms they contain.
    const want = terms(q);
    if (want.length === 0) return [];
    return state.corpus.pages
      .filter((p) => (p.status ?? 200) < 400)
      .map((p) => {
        const hay = normaliseQuery(
          `${p.title} ${p.description ?? ''} ${(p.paragraphs ?? []).join(' ')}`,
        );
        const hits = want.filter((t) => hay.includes(t)).length;
        return { p, hits };
      })
      .filter((x) => x.hits === want.length)
      .sort((a, b) => b.hits - a.hits)
      .map(({ p }) => ({ url: p.url, title: p.title, snippet: snippetOf(p) }));
  }

  function htmlResults(q, offset) {
    const all = resultsFor(q);
    if (all.length === 0) return emptyResultsHtml(q);
    const page = all.slice(offset, offset + 10);
    const ad = state.ads
      ? `  <div class="result result--ad result--ad--small">
    <div class="links_main result__body">
      <span class="badge--ad">Ad</span>
      <a class="result__a result--ad__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;ad=1">Sponsored: batteries at great prices</a>
      <a class="result__snippet" href="https://duckduckgo.com/y.js?ad=1">Shop now.</a>
    </div>
  </div>\n`
      : '';
    const blocks = page
      .map((r) => {
        const href = esc(linkFor(r.url));
        return `  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="${href}">${esc(r.title)}</a>
      </h2>
      <a class="result__snippet" href="${href}">${highlight(r.snippet, q)}</a>
      <div class="result__extras">
        <div class="result__extras__url">
          <a class="result__url" href="${href}">${esc(displayUrl(r.url))}</a>
        </div>
      </div>
    </div>
  </div>`;
      })
      .join('\n\n');
    const more =
      offset + 10 < all.length
        ? `\n  <div class="nav-link"><form action="/html/" method="post"><input type="submit" class="btn btn--alt" value="Next" /><input type="hidden" name="q" value="${esc(q)}" /><input type="hidden" name="s" value="${offset + 10}" /></form></div>`
        : '';
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>${esc(q)} at DuckDuckGo</title></head>
<body>
<div id="links" class="results">
${ad}${blocks}${more}
</div>
</body>
</html>
`;
  }

  function liteResults(q, offset) {
    const all = resultsFor(q);
    const rows = all
      .slice(offset, offset + 10)
      .map(
        (r, i) => `  <tr>
    <td valign="top">${offset + i + 1}.&nbsp;</td>
    <td>
      <a rel="nofollow" href="${esc(state.linkMode === 'loopback' ? loopbackFor(r.url) : r.url)}" class='result-link'>${esc(r.title)}</a>
    </td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>
      ${highlight(r.snippet, q)}
    </td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td><span class='link-text'>${esc(displayUrl(r.url))}</span></td>
  </tr>
  <tr><td>&nbsp;</td><td>&nbsp;</td></tr>`,
      )
      .join('\n');
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>${esc(q)} at DuckDuckGo</title></head>
<body>
<form>
  <input name="q" value="${esc(q)}" />
</form>
<table border="0">
${rows.length > 0 ? rows : '  <tr><td>No results.</td></tr>'}
</table>
</body>
</html>
`;
  }

  function challenged(endpoint, q) {
    const c = state.challenge;
    if (!c.endpoints.includes(endpoint)) return false;
    if (c.queries.some((re) => re.test(q))) return true;
    if (c.remaining > 0) {
      c.remaining -= 1;
      return true;
    }
    return false;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, 'text/plain', String(err));
      else res.destroy();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const entry = { seq: ++state.seq, at: Date.now(), method: req.method, path: url.pathname };
    const done = (status, extra = {}) => state.log.push({ ...entry, status, ...extra });
    await sleep(state.delayMs);

    if (url.pathname === '/__mock/log')
      return send(res, 200, 'application/json', JSON.stringify(state.log));

    const endpoint =
      url.pathname.replace(/\/+$/, '') === '/html'
        ? 'html'
        : url.pathname.replace(/\/+$/, '') === '/lite'
          ? 'lite'
          : null;
    if (endpoint !== null) {
      const form =
        req.method === 'POST' ? new URLSearchParams(await readBody(req)) : url.searchParams;
      const q = form.get('q') ?? '';
      const offset = Number(form.get('s') ?? 0) || 0;
      if (challenged(endpoint, q)) {
        done(state.challenge.status, { endpoint, query: q, challenged: true });
        return send(res, state.challenge.status, 'text/html; charset=utf-8', CHALLENGE_HTML);
      }
      const html = endpoint === 'html' ? htmlResults(q, offset) : liteResults(q, offset);
      done(200, {
        endpoint,
        query: q,
        results: Math.max(0, Math.min(10, resultsFor(q).length - offset)),
      });
      return send(res, 200, 'text/html; charset=utf-8', html);
    }

    const publicUrl = publicFor(`${base}${url.pathname}${url.search}`);
    if (publicUrl !== null) {
      const forced = state.failures.get(publicUrl);
      if (forced !== undefined) {
        done(forced, { endpoint: 'site', url: publicUrl, forced: true });
        return send(res, forced, 'text/plain', `forced failure ${forced}`);
      }
      const page = byUrl().get(publicUrl);
      if (page === undefined) {
        done(404, { endpoint: 'site', url: publicUrl });
        return send(
          res,
          404,
          'text/html; charset=utf-8',
          '<!DOCTYPE html><title>Not found</title><h1>Not found</h1>',
        );
      }
      if (page.redirectTo !== undefined) {
        done(301, { endpoint: 'site', url: publicUrl, location: page.redirectTo });
        res.writeHead(301, { location: loopbackFor(page.redirectTo) });
        return res.end();
      }
      await sleep(page.delayMs ?? 0);
      const status = page.status ?? 200;
      done(status, { endpoint: 'site', url: publicUrl, kind: page.kind });
      if (page.pdf === true)
        return send(res, status, 'application/pdf', makePdf(page.title, page.paragraphs ?? []));
      return send(res, status, 'text/html; charset=utf-8', articleHtml(page));
    }

    done(404, { endpoint: null });
    return send(res, 404, 'text/plain', `mock-web: no route ${url.pathname}`);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const { port } = server.address();
  base = `http://${host}:${port}`;

  /** Where a request for `input` really goes: always this server. */
  const route = (input) => {
    const u = new URL(input);
    if (u.origin === base) return u.href;
    if (u.hostname === 'html.duckduckgo.com') return `${base}/html/${u.search}`;
    if (u.hostname === 'lite.duckduckgo.com') return `${base}/lite/${u.search}`;
    if (u.hostname === 'duckduckgo.com' && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target !== null) return route(target.startsWith('//') ? `https:${target}` : target);
    }
    return loopbackFor(u.href);
  };

  /** A drop-in fetch that never leaves loopback (see the header). */
  const mockFetch = async (input, init = {}) => {
    const first = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let publicUrl = new URL(first, base).href;
    let target = route(publicUrl);
    let redirected = false;
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(target, { ...init, redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location !== null) {
        await res.arrayBuffer().catch(() => undefined);
        const next = new URL(location, target).href;
        publicUrl = publicFor(next) ?? next;
        target = route(next);
        redirected = true;
        continue;
      }
      const shown = publicFor(target) ?? publicUrl;
      const out = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      Object.defineProperty(out, 'url', { value: shown });
      Object.defineProperty(out, 'redirected', { value: redirected });
      return out;
    }
    throw new TypeError(`mock-web: too many redirects from ${first}`);
  };

  return {
    url: base,
    port,
    log: state.log,
    fetch: mockFetch,
    /** The loopback URL that serves a public corpus URL. */
    urlFor: loopbackFor,
    /** Every public URL the corpus can answer for (pages and their aliases). */
    corpusUrls: () => [...byUrl().keys()],
    /**
     * The next `n` searches get the anomaly page. `endpoints` narrows it to
     * html or lite; `status` 202 by default (DuckDuckGo also serves it as 200);
     * `queries` challenges every query matching one of these regexes.
     */
    challengeNext(n = 1, { endpoints = ['html', 'lite'], status = 202, queries = [] } = {}) {
      Object.assign(state.challenge, { remaining: n, endpoints, status, queries });
    },
    /** Answer this public URL with an HTTP error from now on (null clears it). */
    fail(publicUrl, status) {
      if (status === null) state.failures.delete(publicUrl);
      else state.failures.set(publicUrl, status);
    },
    setCorpus(corpus) {
      state.corpus = cloneCorpus(corpus);
    },
    addPage(page, { query } = {}) {
      state.corpus.pages.push(page);
      if (query !== undefined) {
        const key = normaliseQuery(query);
        state.corpus.results[key] = [...(state.corpus.results[key] ?? []), page.url];
      }
    },
    setLinks({ style, mode } = {}) {
      if (style !== undefined) state.linkStyle = style;
      if (mode !== undefined) state.linkMode = mode;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function cloneCorpus(c) {
  return {
    pages: (c.pages ?? []).map((p) => ({ ...p })),
    results: Object.fromEntries(
      Object.entries(c.results ?? {}).map(([q, urls]) => [normaliseQuery(q), [...urls]]),
    ),
  };
}

function send(res, status, type, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(raw));
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const corpusFile = arg('--corpus');
  const web = await startMockWeb({
    port: Number(arg('--port') ?? 0),
    corpus: corpusFile ? JSON.parse(readFileSync(corpusFile, 'utf8')) : DEFAULT_CORPUS,
    linkMode: arg('--link-mode') ?? 'public',
    linkStyle: arg('--link-style') ?? 'direct',
  });
  console.log(`MOCK_WEB_READY ${JSON.stringify({ url: web.url })}`);
  const stop = () => web.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
