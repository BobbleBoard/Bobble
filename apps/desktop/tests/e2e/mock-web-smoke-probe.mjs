/**
 * DOES THE LOOPBACK WEB ANSWER THE REAL SEARCH? — W0-B's acceptance for _mock-web.
 *
 * Imports web-tools' real `runWebSearch` (the backend chain the `web_search`
 * tool uses, DuckDuckGo html → lite → note) and the real `fetchReadable`
 * (`web_fetch`), points their fetch seam at the double, and checks what a
 * research step would see:
 *
 *   - the scripted results, in order, the ad dropped, every URL one the double
 *     serves (nothing from outside the served set can enter);
 *   - html "rate-limited" once → the same results from lite;
 *   - both rate-limited → no results and a note saying so;
 *   - every result fetched and extracted: articles to markdown, the redirect
 *     reported at its canonical URL, the dead link as HTTP 404, the paper as a
 *     PDF whose text pypdf can read (with the office venv's own pypdf when this
 *     Mac has it — read only, nothing installed).
 *
 * Nothing touches the network: the double's fetch never leaves loopback.
 *
 *   SHOT_DIR=/tmp/out node tests/e2e/mock-web-smoke-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchReadable } from '../../../../packages/web-tools/src/fetch.ts';
import { resolveSearchBackends, runWebSearch } from '../../../../packages/web-tools/src/search.ts';
import { DEFAULT_CORPUS, startMockWeb } from './_mock-web.mjs';
import { focusComplaint, frontmostApp, REAL_CACHE } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'mock-web-smoke');
mkdirSync(OUT, { recursive: true });
const Q = 'solid state battery';
const failures = [];
const check = (ok, message) => {
  if (!ok) {
    failures.push(message);
    console.error(`mock-web-smoke FAILED: ${message}`);
  }
  return ok;
};

const before = frontmostApp();
const web = await startMockWeb();
const served = new Set(web.corpusUrls());
const search = (q) =>
  runWebSearch(resolveSearchBackends({ backend: 'duckduckgo', fetchImpl: web.fetch }), q, {
    count: 10,
  });
const results = {};
try {
  // ── search ──
  const plain = await search(Q);
  results.search = plain;
  check(plain.backend === 'duckduckgo', `backend ${plain.backend}`);
  check(
    JSON.stringify(plain.results.map((r) => r.url)) === JSON.stringify(DEFAULT_CORPUS.results[Q]),
    `results out of order or missing: ${plain.results.map((r) => r.url).join(', ')}`,
  );
  check(
    plain.results.every((r) => served.has(r.url)),
    'a result URL came from outside the served set',
  );
  check(!plain.results.some((r) => /Sponsored/.test(r.title)), 'the ad was not dropped');

  web.challengeNext(1, { endpoints: ['html'] });
  const fallback = await search(Q);
  results.htmlChallenged = { urls: fallback.results.length, note: fallback.note };
  check(
    fallback.results.length === plain.results.length,
    'lite did not answer after html was challenged',
  );

  web.challengeNext(2);
  const limited = await search(Q);
  results.bothChallenged = limited;
  check(limited.results.length === 0, 'results despite both endpoints challenged');
  check(/rate-limiting/.test(limited.note ?? ''), `no rate-limit note: ${limited.note}`);

  // ── every result, fetched the way web_fetch fetches ──
  results.pages = [];
  for (const r of plain.results) {
    if (r.url.endsWith('.pdf')) {
      const res = await web.fetch(r.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(OUT, 'paper.pdf');
      writeFileSync(file, buf);
      const py = path.join(REAL_CACHE, 'engines', 'office-venv', 'bin', 'python3');
      let text = null;
      if (existsSync(py)) {
        text = execFileSync(
          py,
          [
            '-c',
            'import sys,pypdf; print(pypdf.PdfReader(sys.argv[1]).pages[0].extract_text())',
            file,
          ],
          { encoding: 'utf8' },
        );
        check(
          text.includes('A Review of Solid-State Lithium Batteries'),
          'pypdf did not read the title',
        );
        check(text.includes('interface engineering'), 'pypdf did not read the body');
      }
      results.pages.push({
        url: r.url,
        type: res.headers.get('content-type'),
        bytes: buf.length,
        pypdf:
          text === null ? 'office venv not on this Mac: skipped' : text.split('\n').slice(0, 3),
      });
      continue;
    }
    try {
      const page = await fetchReadable(r.url, { fetchImpl: web.fetch });
      results.pages.push({
        url: r.url,
        finalUrl: page.url,
        title: page.title,
        chars: page.markdown.length,
      });
      check(page.markdown.length > 80, `no article text for ${r.url}`);
      check(!page.markdown.includes('Accept all'), `cookie banner survived extraction on ${r.url}`);
    } catch (e) {
      results.pages.push({ url: r.url, error: String(e) });
      check(r.url === 'https://gone.example/old-battery-news', `${r.url} failed: ${e}`);
      check(String(e).includes('HTTP 404'), `the dead link failed the wrong way: ${e}`);
    }
  }
  const amp = results.pages.find((p) => p.url.includes('/amp/'));
  check(
    amp?.finalUrl === 'https://www.techdaily.example/2026/09/solid-state-batteries-pilot-line',
    `the redirect was not reported at its canonical URL: ${amp?.finalUrl}`,
  );

  // ── nothing left loopback ──
  results.requests = web.log.map(
    (e) => `${e.endpoint ?? '-'} ${e.status} ${e.query ?? e.url ?? e.path}`,
  );
  check(
    web.log.every((e) => e.endpoint !== null),
    'a request hit an unknown route',
  );
} catch (e) {
  check(false, `probe threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await web.close();
  const complaint = focusComplaint(before, frontmostApp());
  if (complaint !== null) check(false, complaint);
  writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}

console.log(
  JSON.stringify({ ...results, search: { urls: results.search?.results?.length } }, null, 2),
);
if (failures.length > 0) {
  console.error(`mock-web-smoke: ${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('mock-web-smoke OK');
}
