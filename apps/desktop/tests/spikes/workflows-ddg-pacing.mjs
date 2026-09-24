#!/usr/bin/env node
/**
 * WF-00b · How much paced fan-out does DuckDuckGo put up with?
 *
 * Track 11's research step (deliverables/research/workflows.md §4.5, step 2b)
 * searches DuckDuckGo many times per run: a Standard run asks about 15 queries,
 * a Deep one 32 or more. The design paces them "≥2 s plus jitter" and turns
 * rate-limit pages into paced retries, but nobody had measured what DuckDuckGo
 * actually tolerates. This spike measures it, politely, and prints a tolerance
 * table plus the search defaults WF-01 records in packages/workflows/src/defaults.ts
 * (WP-00 item 4).
 *
 * POLITE BY CONSTRUCTION
 *  - At most 30 requests reach DuckDuckGo, counted per HTTP request: a search
 *    whose html page is challenged and falls back to lite costs two. A budget
 *    refuses the 31st without touching the network.
 *  - No two requests start less than 2 s apart, the lite fallback included, and
 *    every load gap is drawn from 2–5 s. The only longer waits are cool-downs.
 *  - Slow first: 4.5–5 s, then 3.5–4 s, 2.5–3 s, then a 2–2.5 s burst the size
 *    of a whole Standard research run. The FIRST challenge (or an unexplained
 *    empty page, which may be a quiet block) ends the load for good. What is left
 *    of the budget goes to a few spaced html probes (30 s, 60 s, 120 s, 180 s
 *    apart), and the run stops at the first clean answer.
 *  - One network fan-out on the machine at a time (PLAN.md §4.3 caps it at 1):
 *    the run holds /tmp/bobble-locks/net-0, the same slot shape as
 *    scripts/with-lock.mjs, which has no `net` class yet.
 *
 * THE REQUESTS ARE PRODUCTION'S. Searches go through the real
 * `duckDuckGoBackend` from packages/web-tools: html POST first, lite as the
 * fallback, with the same headers and body. Only its fetch is wrapped, to pace,
 * count, time and classify each request. Run it under the app's own runtime so
 * that DuckDuckGo sees Bobble's TLS and HTTP client (Electron's Node with
 * BoringSSL, the runtime the pi child and main use), not system Node's:
 *
 *   cd apps/desktop
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/spikes/workflows-ddg-pacing.mjs
 *
 * Plain `node` works too. The JSON then records that the client differs from the app's.
 *
 *   DRY=1 node tests/spikes/workflows-ddg-pacing.mjs   # no network: fake DuckDuckGo, fake clock
 *   DRY=block | blocked | silent                       # the same, rehearsing a challenge
 *
 * Output: the whole record as JSON on stdout and in $OUT; the table on stderr.
 * Env: OUT (default /tmp/bobble-spikes/workflows-ddg-pacing), SEED (the jitter
 * draw, default 23), LOCK_WAIT_MS (default 10 min), BOBBLE_LOCK_DIR. BUDGET can
 * only lower the cap, so a repeat run stays inside the 30 requests the whole
 * package may spend. RUN_LABEL is recorded in the JSON.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  duckDuckGoBackend,
  isDuckDuckGoChallenge,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
} from '../../../../packages/web-tools/src/search.ts';

// --- The plan ---------------------------------------------------------------

/**
 * Every number the run obeys. Tiers go from slow to fast. The 2–2.5 s tier is
 * fifteen searches, which is a Standard research run's whole fan-out (5
 * sub-questions × 3 queries), taken after eleven slower ones. `chain` is
 * production's path (html, then lite if html is refused); `lite` pins the
 * fallback on its own.
 */
export const PLAN = Object.freeze({
  budget: 30, // requests that may reach DuckDuckGo: fallbacks and probes count
  floorMs: 2000, // no two requests start closer together than this
  ceilMs: 5000, // load gaps are drawn at or below this
  reserve: 3, // requests the chain tiers leave for recovery probes
  requestTimeoutMs: 15_000,
  resultsPerSearch: 10,
  maxWallMs: 15 * 60_000,
  tiers: Object.freeze([
    { id: 'gap-4.5-5s', path: 'chain', gapMinMs: 4500, gapMaxMs: 5000, searches: 4 },
    { id: 'gap-3.5-4s', path: 'chain', gapMinMs: 3500, gapMaxMs: 4000, searches: 4 },
    { id: 'gap-2.5-3s', path: 'chain', gapMinMs: 2500, gapMaxMs: 3000, searches: 3 },
    { id: 'gap-2-2.5s', path: 'chain', gapMinMs: 2000, gapMaxMs: 2500, searches: 15 },
    // Spends the reserve. Like every tier, it runs only while nothing has been refused.
    {
      id: 'lite-2-2.5s',
      path: 'lite',
      gapMinMs: 2000,
      gapMaxMs: 2500,
      searches: 4,
      usesReserve: true,
    },
  ]),
  recoveryWaitsMs: Object.freeze([30_000, 60_000, 120_000, 180_000]),
});

/**
 * The plan for this run. BUDGET can only LOWER the request cap, never raise it:
 * a repeat run must stay inside what the package may spend in total.
 */
export function planFromEnv(env = process.env, plan = PLAN) {
  const raw = env.BUDGET;
  if (raw === undefined || raw === '') return plan;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`BUDGET must be a whole number from 1 to ${plan.budget}, not "${raw}"`);
  }
  return Object.freeze({ ...plan, budget: Math.min(plan.budget, n) });
}

/**
 * What a research run on the design doc's own example ("home battery storage in
 * the EU") would ask: short, distinct, ordinary. They are distinct so that no
 * answer can come from DuckDuckGo's own cache.
 */
export const QUERIES = Object.freeze([
  'EU residential battery storage installations 2025',
  'home battery prices Germany per kWh',
  'LFP vs NMC home battery cycle life',
  'heat pump sales Europe 2025',
  'IEA renewables report solar capacity additions',
  'offshore wind capacity factor North Sea',
  'grid scale battery storage costs 2026',
  'vehicle to grid pilot results Europe',
  'sodium ion battery commercial production',
  'solar panel degradation rate per year',
  'how to size a home battery for rooftop solar',
  'balcony solar rules Germany',
  'EU battery regulation carbon footprint declaration',
  'lithium carbonate price trend',
  'perovskite tandem solar cell efficiency record',
  'green hydrogen electrolyser cost per kW',
  'Netherlands net metering phase out',
  'UK smart export guarantee rates',
  'Spain solar self consumption statistics',
  'Italy residential battery incentives',
  'California NEM 3.0 battery attachment rate',
  'Australia home battery rebate',
  'Japan residential energy storage market',
  'household demand response programs Europe',
  'time of use electricity tariffs comparison',
  'home battery fire safety standards',
  'lithium ion battery recycling rate EU',
  'commercial battery peak shaving case study',
  'microgrid resilience during outages study',
  'negative electricity prices solar Europe',
  'virtual power plant households Germany',
  'EV charging impact on distribution grid',
  'hybrid vs AC coupled inverter efficiency',
  'open source home energy management system',
]);

// --- Small pure helpers -----------------------------------------------------

/** A seeded PRNG, so the same SEED draws the same gaps on every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A gap drawn from the tier's range, never outside the plan's floor and ceiling. */
export function jitteredGap(tier, rng, plan = PLAN) {
  const raw = tier.gapMinMs + rng() * (tier.gapMaxMs - tier.gapMinMs);
  return Math.round(Math.min(plan.ceilMs, Math.max(plan.floorMs, raw)));
}

/** Nearest-rank percentile; null for no data. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.min(xs.length, Math.max(1, Math.ceil((p / 100) * xs.length)));
  return xs[rank - 1];
}

const round = (v) => (v === null || v === undefined ? null : Math.round(v));
const seconds = (ms) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// --- Reading a response -----------------------------------------------------

/** The markers search.ts itself looks for (`isDuckDuckGoChallenge`), named. */
const BACKEND_MARKERS = [
  ['anomaly-modal', /anomaly-modal/i],
  ['challenge-form', /challenge-form/i],
  ['bots-use-duckduckgo', /bots use duckduckgo/i],
  ['error-persists', /if this error persists/i],
];
/** Other signs of a block that search.ts does NOT look for. Seen only on a page with no results. */
const EXTRA_MARKERS = [
  ['anomaly-js', /anomaly\.js/i],
  ['captcha', /captcha/i],
  ['unusual-traffic', /unusual traffic/i],
];
/** Statuses that mean "slow down" when the page carries no results. */
const BLOCK_STATUSES = new Set([202, 403, 418, 429]);
/** Statuses a Response cannot be constructed with a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Which DuckDuckGo endpoint a URL is, or null for anything else. */
export function endpointOf(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host === 'html.duckduckgo.com') return 'html';
  if (host === 'lite.duckduckgo.com') return 'lite';
  return null;
}

function hostnames(results) {
  const out = [];
  for (const r of results.slice(0, 3)) {
    try {
      out.push(new URL(r.url).hostname);
    } catch {
      /* not a URL: skip */
    }
  }
  return out;
}

function titleOf(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 80) : null;
}

/**
 * What one response was, read with production's own parsers and challenge
 * detector:
 *  - ok: results;
 *  - empty: a clean page with none;
 *  - blocked: a challenge page, or a "slow down" status with no results;
 *  - http-error: any other non-2xx.
 *
 * `backendSeesBlock` says whether search.ts would notice. It skips a non-2xx
 * or challenge page and tries the next endpoint. A 202 without the markers
 * passes as a clean empty page.
 */
export function classifyResponse({ endpoint, status, body }) {
  const text = body ?? '';
  const backendChallenge = isDuckDuckGoChallenge(text);
  const markers = [...BACKEND_MARKERS, ...EXTRA_MARKERS]
    .filter(([, re]) => re.test(text))
    .map(([id]) => id);
  let parsed = [];
  if (!backendChallenge && text.length > 0) {
    const parse = endpoint === 'lite' ? parseDuckDuckGoLite : parseDuckDuckGoHtml;
    try {
      parsed = parse(text, 20);
    } catch {
      parsed = [];
    }
  }
  const twoXX = status >= 200 && status <= 299;
  let kind;
  if (backendChallenge) kind = 'blocked';
  else if (parsed.length > 0 && twoXX) kind = 'ok';
  else if (BLOCK_STATUSES.has(status) || markers.length > 0) kind = 'blocked';
  else if (!twoXX) kind = 'http-error';
  else kind = 'empty';
  return {
    kind,
    markers,
    backendSeesBlock: backendChallenge || !twoXX,
    results: parsed.length,
    topDomains: hostnames(parsed),
    title: titleOf(text),
  };
}

/**
 * How one search went, from its requests and what the backend returned
 * (`results` is null when the backend threw):
 *  - results: answered by the first page;
 *  - rescued: a request was blocked but the lite fallback answered;
 *  - empty: clean pages with nothing on them;
 *  - failed: blocked, and the backend said so;
 *  - silent-empty: blocked, but the backend returned [] as if nothing matched;
 *  - error: server or transport failures, nothing blocked;
 *  - budget-cut: refused before reaching the network.
 */
export function searchOutcome(reqs, results, budgetCut) {
  const blocked = reqs.some((r) => r.kind === 'blocked');
  if (results && results.length > 0) return blocked ? 'rescued' : 'results';
  if (reqs.length === 0) return 'budget-cut';
  if (blocked) return results ? 'silent-empty' : 'failed';
  if (results === null) return budgetCut ? 'budget-cut' : 'error';
  return 'empty';
}

// --- Clocks, pacing, budget --------------------------------------------------

/** Wall-clock timing for the real run: a monotonic `now` and a real sleep. */
export function realClock() {
  return {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  };
}

/** Virtual time for rehearsals and tests: sleeping only moves the hands. */
export function createFakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
  };
}

/**
 * Holds every request until `gap` has passed since the previous one STARTED.
 * The gap never drops below the floor, whatever a caller asks for. It loops
 * because a timer may wake a hair early.
 */
export function createPacer(clock, floorMs) {
  let last = null;
  let gap = floorMs;
  return {
    setGap(ms) {
      gap = Math.max(floorMs, ms);
    },
    async wait() {
      if (last !== null) {
        let left = last + gap - clock.now();
        while (left > 0) {
          await clock.sleep(left);
          left = last + gap - clock.now();
        }
      }
      const start = clock.now();
      const actualGapMs = last === null ? null : start - last;
      last = start;
      return { start, actualGapMs };
    },
  };
}

export function createBudget(limit) {
  let used = 0;
  return {
    limit,
    take() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    get used() {
      return used;
    },
    get remaining() {
      return limit - used;
    },
  };
}

/**
 * The fetch handed to production's backend. It refuses anything that is not
 * DuckDuckGo's html or lite endpoint. It answers a phase's excluded endpoint
 * with a synthetic "not now" (the backend treats that as a refusal and moves
 * on), and past the budget it does the same. Otherwise it paces, sends,
 * times, reports, and hands back a fresh copy of the response, because the
 * body has already been read.
 */
export function instrumentFetch({
  network,
  clock,
  pacer,
  budget,
  timeoutMs,
  route,
  onRequest,
  onRefused,
  onShape,
}) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const endpoint = endpointOf(url);
    if (endpoint === null) {
      throw new Error(`the spike only talks to DuckDuckGo's html and lite endpoints, not ${url}`);
    }
    if (route(endpoint) === 'skip') {
      return new Response(null, { status: 599, statusText: 'not in this phase' });
    }
    if (!budget.take()) {
      onRefused?.(endpoint);
      return new Response(null, { status: 599, statusText: 'budget spent' });
    }
    const { start, actualGapMs } = await pacer.wait();
    onShape?.(url, init);
    let status = 0;
    let body = '';
    let error = null;
    try {
      const signals = [init.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(
        Boolean,
      );
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const res = await network(url, { ...init, signal });
      status = res.status;
      body = await res.text();
    } catch (err) {
      error = err;
    }
    onRequest({ endpoint, start, end: clock.now(), actualGapMs, status, body, error });
    if (error) throw error;
    return new Response(NULL_BODY_STATUSES.has(status) ? null : body, { status });
  };
}

/** The request as production builds it, with the query blanked. */
function describeShape(url, init) {
  const headers = init.headers ?? {};
  const entries =
    typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  const byName = Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    method: init.method ?? 'GET',
    url,
    headerNames: Object.keys(byName).sort(),
    userAgent: byName['user-agent'] ?? null,
    contentType: byName['content-type'] ?? null,
    body: typeof init.body === 'string' ? init.body.replace(/(^|&)q=[^&]*/, '$1q=<query>') : null,
  };
}

// --- The protocol -----------------------------------------------------------

/**
 * Runs the plan against `network` (the real fetch, or a fake one) and returns
 * the raw record. The load stops at the first sign that DuckDuckGo wants less.
 * That sign is a blocked response, or an empty page for a query that certainly
 * has results (possibly a quiet block). Recovery probes then spend what the
 * budget has left.
 */
export async function runProtocol({
  plan = PLAN,
  network,
  clock,
  seed = 23,
  queries = QUERIES,
  backendFactory = duckDuckGoBackend,
  shouldStop = () => false,
  onEvent = () => {},
}) {
  const rng = mulberry32(seed);
  const pacer = createPacer(clock, plan.floorMs);
  const budget = createBudget(plan.budget);
  const t0 = clock.now();
  const requests = [];
  const starts = [];
  const searches = [];
  const phases = [];
  const bodies = new Map();
  let refused = 0;
  let shape = null;
  let firstBlock = null;
  let stoppedBecause = null;
  let errorsInARow = 0;
  const ctx = { tier: null, search: null, route: () => 'network' };

  const fetchImpl = instrumentFetch({
    network,
    clock,
    pacer,
    budget,
    timeoutMs: plan.requestTimeoutMs,
    route: (endpoint) => ctx.route(endpoint),
    onRefused: () => {
      refused += 1;
      if (ctx.search) ctx.search.budgetCut = true;
    },
    onShape: (url, init) => {
      shape ??= describeShape(url, init);
    },
    onRequest: ({ endpoint, start, end, actualGapMs, status, body, error }) => {
      const trailing60 = 1 + starts.filter((s) => start - s < 60_000).length;
      starts.push(start);
      const cls = error ? null : classifyResponse({ endpoint, status, body });
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const rec = {
        i: requests.length + 1,
        tier: ctx.tier,
        search: ctx.search?.s ?? null,
        endpoint,
        tMs: round(start - t0),
        gapMs: round(actualGapMs),
        latencyMs: round(end - start),
        status,
        kind: error ? (timedOut ? 'timeout' : 'neterr') : cls.kind,
        markers: cls?.markers ?? [],
        backendSeesBlock: cls?.backendSeesBlock ?? null,
        bytes: Buffer.byteLength(body),
        results: cls?.results ?? 0,
        topDomains: cls?.topDomains ?? [],
        trailing60,
        ...(error ? { error: String(error.message ?? error) } : {}),
      };
      requests.push(rec);
      errorsInARow = ['http-error', 'timeout', 'neterr'].includes(rec.kind) ? errorsInARow + 1 : 0;
      const loadRequest = ctx.tier !== 'recovery';
      const wantsLess = rec.kind === 'blocked' || (loadRequest && rec.kind === 'empty');
      if (wantsLess) bodies.set(rec.i, body);
      if (wantsLess && loadRequest && firstBlock === null) {
        let reason = 'empty page (possible quiet block)';
        if (rec.kind === 'blocked') {
          reason = rec.markers.length > 0 ? 'challenged' : 'refused without a challenge page';
        }
        firstBlock = {
          reason,
          request: rec.i,
          search: rec.search,
          tier: rec.tier,
          endpoint,
          status,
          markers: rec.markers,
          backendSeesBlock: rec.backendSeesBlock,
          afterMs: rec.tMs,
          startMs: start,
          requestsBefore: rec.i - 1,
          trailing60,
          bytes: rec.bytes,
          sha256: createHash('sha256').update(body).digest('hex').slice(0, 16),
          title: cls.title,
        };
      }
      onEvent({ type: 'request', request: rec });
    },
  });
  const backend = backendFactory({ fetchImpl });

  let nextQuery = 0;
  async function doSearch(tier, gapMs) {
    const s = {
      s: searches.length + 1,
      tier: tier.id,
      path: tier.path,
      query: queries[nextQuery++ % queries.length],
      gapMs,
      outcome: null,
      results: 0,
      via: null,
      budgetCut: false,
    };
    ctx.tier = tier.id;
    ctx.search = s;
    pacer.setGap(gapMs);
    const before = requests.length;
    let results = null;
    try {
      results = await backend.search(s.query, { count: plan.resultsPerSearch });
    } catch (err) {
      s.error = String(err?.message ?? err);
    }
    const mine = requests.slice(before);
    s.requests = mine.map((r) => r.i);
    s.outcome = searchOutcome(mine, results, s.budgetCut);
    s.results = results?.length ?? 0;
    s.via = s.results > 0 ? (mine.findLast((r) => r.kind === 'ok')?.endpoint ?? null) : null;
    if (!s.budgetCut) delete s.budgetCut;
    searches.push(s);
    onEvent({ type: 'search', search: s });
    return s;
  }

  // Load: slow to fast, until DuckDuckGo wants less.
  for (const tier of plan.tiers) {
    const phase = { id: tier.id, path: tier.path, planned: tier.searches, ran: 0, note: null };
    phases.push(phase);
    if (firstBlock || stoppedBecause) {
      phase.note = firstBlock
        ? 'not run: the load had already stopped'
        : `not run: ${stoppedBecause}`;
      continue;
    }
    ctx.route =
      tier.path === 'lite' ? (ep) => (ep === 'lite' ? 'network' : 'skip') : () => 'network';
    const keep = tier.usesReserve ? 0 : plan.reserve;
    const need = tier.path === 'lite' ? 1 : 2; // a chain search may need html AND lite
    for (let k = 0; k < tier.searches; k++) {
      if (shouldStop()) {
        stoppedBecause = 'interrupted';
        break;
      }
      if (clock.now() - t0 > plan.maxWallMs) {
        stoppedBecause = 'the wall-clock limit';
        break;
      }
      if (budget.remaining < need + keep) {
        phase.note = `stopped after ${phase.ran}: the budget keeps ${keep} for recovery`;
        break;
      }
      await doSearch(tier, jitteredGap(tier, rng, plan));
      phase.ran += 1;
      if (firstBlock) {
        phase.note = `stopped at search ${phase.ran}: ${firstBlock.reason}`;
        break;
      }
      if (errorsInARow >= 3) {
        stoppedBecause = 'three failed requests in a row (network trouble, not DuckDuckGo)';
        break;
      }
    }
  }

  // Recovery: spaced html probes until one comes back clean.
  let recovery = null;
  if (firstBlock && !stoppedBecause) {
    recovery = { endpoint: 'html', probes: [], lastBlockedAfterMs: 0, cleanAfterMs: null };
    ctx.route = (ep) => (ep === 'html' ? 'network' : 'skip');
    const probeTier = { id: 'recovery', path: 'recovery' };
    for (const waitMs of plan.recoveryWaitsMs) {
      if (budget.remaining < 1) {
        recovery.note = 'the budget ran out before a clean answer';
        break;
      }
      if (shouldStop()) {
        stoppedBecause = 'interrupted';
        break;
      }
      await clock.sleep(waitMs);
      const s = await doSearch(probeTier, plan.floorMs);
      const r = requests.find((x) => x.search === s.s);
      if (!r) break;
      const sinceMs = Math.round(t0 + r.tMs - firstBlock.startMs);
      recovery.probes.push({
        waitMs,
        sinceFirstBlockMs: sinceMs,
        kind: r.kind,
        status: r.status,
        results: r.results,
      });
      if (r.kind === 'ok') {
        recovery.cleanAfterMs = sinceMs;
        break;
      }
      // A dropped connection says nothing about DuckDuckGo's mood either way.
      if (r.kind === 'blocked' || r.kind === 'empty') recovery.lastBlockedAfterMs = sinceMs;
    }
    if (recovery.cleanAfterMs === null && !recovery.note && recovery.probes.length > 0) {
      const after = Math.round(recovery.lastBlockedAfterMs / 1000) * 1000;
      recovery.note = `still refused ${seconds(after)} s after the first block`;
    }
  }

  return {
    requests,
    searches,
    phases,
    firstBlock,
    recovery,
    refused,
    shape,
    stoppedBecause,
    bodies,
    budgetUsed: budget.used,
    wallMs: Math.round(clock.now() - t0),
  };
}

// --- Turning the record into a table and defaults ------------------------------

const ERROR_KINDS = ['http-error', 'timeout', 'neterr'];

function endpointCounts(reqs, endpoint) {
  const xs = reqs.filter((r) => r.endpoint === endpoint);
  return {
    requests: xs.length,
    ok: xs.filter((r) => r.kind === 'ok').length,
    empty: xs.filter((r) => r.kind === 'empty').length,
    blocked: xs.filter((r) => r.kind === 'blocked').length,
    errors: xs.filter((r) => ERROR_KINDS.includes(r.kind)).length,
  };
}

/** One row per phase: what was asked, what came back, how fast, how hard. */
export function toleranceTable(run, plan = PLAN) {
  const phases = [...run.phases];
  if (run.recovery) phases.push({ id: 'recovery', path: 'recovery', note: run.recovery.note });
  return phases.map((phase) => {
    const reqs = run.requests.filter((r) => r.tier === phase.id);
    const srch = run.searches.filter((s) => s.tier === phase.id);
    const tier = plan.tiers.find((t) => t.id === phase.id);
    const gaps = reqs.map((r) => r.gapMs).filter((g) => g !== null);
    const latencies = reqs.filter((r) => !ERROR_KINDS.includes(r.kind)).map((r) => r.latencyMs);
    const outcomes = {};
    for (const s of srch) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    const blocked = reqs.filter((r) => r.kind === 'blocked').length;
    const empty = reqs.filter((r) => r.kind === 'empty').length;
    let verdict = 'clean';
    if (reqs.length === 0) verdict = 'not run';
    else if (blocked > 0) verdict = 'challenged';
    else if (empty > 0) verdict = 'empty page';
    if (phase.path === 'recovery' && run.recovery) {
      verdict = run.recovery.cleanAfterMs === null ? 'still refused' : 'recovered';
    }
    return {
      tier: phase.id,
      path: phase.path,
      nominalGapMs: tier ? [tier.gapMinMs, tier.gapMaxMs] : null,
      actualGapMs: gaps.length
        ? { min: Math.min(...gaps), median: percentile(gaps, 50), max: Math.max(...gaps) }
        : null,
      searches: srch.length,
      requests: reqs.length,
      html: endpointCounts(reqs, 'html'),
      lite: endpointCounts(reqs, 'lite'),
      outcomes,
      resultsPerSearchMedian: percentile(
        srch.filter((s) => s.results > 0).map((s) => s.results),
        50,
      ),
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: latencies.length ? Math.max(...latencies) : null,
      },
      peakPerMinute: reqs.length ? Math.max(...reqs.map((r) => r.trailing60)) : 0,
      blocked,
      verdict,
      note: phase.note ?? null,
    };
  });
}

/**
 * The defaults the research runner should start from, derived only from what
 * this run saw. Without a challenge, the fastest clean tier and the peak
 * per-minute rate it reached are the tested envelope. With one, back off to the
 * fastest tier that was clean and slower than the one refused. Stay one
 * request per minute under the rate at which the refusal came, and retry on the
 * schedule that found DuckDuckGo willing again.
 */
export function recommend(run, table, plan = PLAN) {
  const chain = table.filter((r) => r.path === 'chain' && r.requests > 0);
  const clean = chain
    .filter((r) => r.blocked === 0 && r.verdict === 'clean')
    .sort((a, b) => a.nominalGapMs[0] - b.nominalGapMs[0]);
  const load = run.requests.filter((r) => r.tier !== 'recovery');
  const peak = load.length ? Math.max(...load.map((r) => r.trailing60)) : 0;
  const lastLoad = load.at(-1);
  const loadSeconds = lastLoad ? seconds(Math.round(lastLoad.tMs / 100) * 100) : '0';
  const shared = {
    endpointOrder: ['html', 'lite'],
    paceScope:
      'every request, the lite fallback included (pace inside the fetch, not between searches)',
  };
  const fb = run.firstBlock;
  if (!fb) {
    const fastest = clean[0];
    if (!fastest) {
      return {
        ...shared,
        status: 'no-data',
        basis: 'No search completed, so nothing was measured.',
      };
    }
    return {
      ...shared,
      status: 'no-challenge',
      primaryBackend: 'duckduckgo',
      paceMinMs: fastest.nominalGapMs[0],
      paceJitterMs: fastest.nominalGapMs[1] - fastest.nominalGapMs[0],
      maxPerMinute: peak,
      retryDelaysMs: plan.recoveryWaitsMs.slice(0, 2),
      retryMeasured: false,
      giveUpAfterMs: null,
      basis:
        `No challenge in ${plural(load.length, 'request')} over ${loadSeconds} s. The fastest ` +
        `tier (${seconds(fastest.nominalGapMs[0])}–${seconds(fastest.nominalGapMs[1])} s) ran ` +
        `${plural(fastest.searches, 'search')} back to back, and the run peaked at ` +
        `${plural(peak, 'request')} in one 60 s window.`,
      untested:
        `More than ${peak} requests in 60 s, or more than ${load.length} in one run. A Deep run ` +
        '(8 × 4 queries plus gap loops) goes past that, so search per sub-question (bursts of ' +
        '3–4 with reading in between) rather than all at once, and cache every query.',
    };
  }
  const blockedTier = table.find((r) => r.tier === fb.tier);
  const blockedMin = blockedTier?.nominalGapMs?.[0] ?? plan.floorMs;
  const pick = clean.find((r) => r.nominalGapMs[0] > blockedMin);
  const rec = run.recovery;
  const recovered = rec ? rec.cleanAfterMs !== null : false;
  const retryDelaysMs = recovered
    ? rec.probes.map((p) => p.waitMs)
    : plan.recoveryWaitsMs.slice(0, 2);
  const giveUpAfterMs = rec && !recovered ? rec.lastBlockedAfterMs : null;
  const where =
    `${fb.reason} at request ${fb.request} (${fb.endpoint}, HTTP ${fb.status}), ` +
    `${seconds(Math.round(fb.afterMs / 100) * 100)} s in, with ${plural(fb.trailing60, 'request')} ` +
    'in the trailing 60 s';
  let after = 'Recovery was not measured.';
  if (rec && recovered) {
    after = `A clean answer came ${seconds(Math.round(rec.cleanAfterMs / 1000) * 1000)} s after it.`;
  } else if (rec) {
    after =
      `Still refused ${seconds(Math.round(rec.lastBlockedAfterMs / 1000) * 1000)} s after it, ` +
      'so treat DuckDuckGo as unavailable for the rest of that run: fall back to the browser ' +
      'search and say so under Limits.';
  }
  return {
    ...shared,
    status: pick ? 'challenged' : 'challenged-at-slowest',
    // Refused even at the slowest pace: DuckDuckGo cannot lead a fan-out from here.
    primaryBackend: pick ? 'duckduckgo' : 'browser-or-key',
    paceMinMs: pick ? pick.nominalGapMs[0] : plan.ceilMs,
    paceJitterMs: pick ? pick.nominalGapMs[1] - pick.nominalGapMs[0] : 1000,
    // Refused at the slowest pace: no rate was shown to be safe, so none is offered.
    maxPerMinute: pick ? Math.max(1, fb.trailing60 - 1) : null,
    retryDelaysMs,
    retryMeasured: recovered,
    giveUpAfterMs,
    basis: `${where[0].toUpperCase()}${where.slice(1)}. ${after}`,
    untested: pick
      ? `The ${seconds(pick.nominalGapMs[0])}–${seconds(pick.nominalGapMs[1])} s pace was clean for ` +
        `${pick.searches} searches only; the refusal may follow volume as much as pace.`
      : 'Even the slowest tier was refused, so pacing alone will not carry a research run from ' +
        'this network: use the browser search or a Brave/Tavily key.',
  };
}

/** Plain-words notes about anything in the record that the table alone would hide. */
export function notesFor(run, { runtime, environment } = {}) {
  const notes = [];
  const silent = run.searches.filter((s) => s.outcome === 'silent-empty').length;
  if (silent > 0) {
    notes.push(
      `${silent} search(es) came back empty although a request was refused: DuckDuckGo answered ` +
        '2xx without a challenge marker, and search.ts reads that as a clean page with no results.',
    );
  }
  const unseen = run.requests.filter((r) => r.kind === 'blocked' && r.backendSeesBlock === false);
  if (unseen.length > 0) {
    const how = [
      ...new Set(
        unseen.map((r) =>
          r.markers.length > 0
            ? `HTTP ${r.status} with only ${r.markers.join(', ')}`
            : `HTTP ${r.status} with no marker`,
        ),
      ),
    ];
    notes.push(
      `${unseen.length} refused response(s) that isDuckDuckGoChallenge does not recognise: ${how.join('; ')}.`,
    );
  }
  const rescued = run.searches.filter((s) => s.outcome === 'rescued').length;
  if (rescued > 0) notes.push(`The lite fallback rescued ${rescued} refused search(es).`);
  if (run.refused > 0) {
    notes.push(`${run.refused} request(s) were refused by the budget before reaching the network.`);
  }
  if (run.stoppedBecause) notes.push(`The run stopped early: ${run.stoppedBecause}.`);
  if (runtime && !runtime.matchesApp) {
    notes.push(
      "Run under system Node, not the app's Electron runtime, so the TLS/HTTP client differs " +
        'from the one DuckDuckGo sees from Bobble.',
    );
  }
  const others = [environment?.atStart, environment?.atEnd].filter(Boolean);
  const busy = others.some((o) => (o.connections ?? 0) > 0);
  if (busy) {
    const names = [...new Set(others.flatMap((o) => o.processes ?? []))];
    notes.push(
      `Other processes had DuckDuckGo connections open (start ${environment.atStart?.connections ?? '?'}, ` +
        `end ${environment.atEnd?.connections ?? '?'}: ${names.join(', ')}). Their traffic shares this IP's allowance.`,
    );
  }
  return notes;
}

const PATH_LABEL = { chain: 'html → lite', lite: 'lite only', recovery: 'html probe' };

/** The table as markdown, for a person. */
export function renderTable(table) {
  const head =
    '| Tier | Path | Gap s (actual min–max) | Searches | Requests | OK | Refused | Rescued by lite | ' +
    'Results/search | Latency p50/p95 ms | Peak req/60 s | Verdict |';
  const rule = `|${head
    .split('|')
    .slice(1, -1)
    .map(() => '---')
    .join('|')}|`;
  const rows = table.map((r) => {
    const gap = r.actualGapMs ? `${seconds(r.actualGapMs.min)}–${seconds(r.actualGapMs.max)}` : '—';
    const ok = r.html.ok + r.lite.ok;
    const lat = r.latencyMs.p50 === null ? '—' : `${r.latencyMs.p50}/${r.latencyMs.p95}`;
    return (
      `| ${r.tier} | ${PATH_LABEL[r.path] ?? r.path} | ${gap} | ${r.searches} | ${r.requests} | ` +
      `${ok} | ${r.blocked} | ${r.outcomes.rescued ?? 0} | ${r.resultsPerSearchMedian ?? '—'} | ` +
      `${lat} | ${r.peakPerMinute} | ${r.verdict} |`
    );
  });
  return [head, rule, ...rows].join('\n');
}

/** The whole record: what was asked, what came back, what to do about it. */
export function buildReport({
  run,
  plan = PLAN,
  seed,
  dry,
  runtime,
  environment,
  startedAt,
  label = null,
}) {
  const table = toleranceTable(run, plan);
  const recommendation = recommend(run, table, plan);
  const load = run.requests.filter((r) => r.tier !== 'recovery');
  const gaps = run.requests.map((r) => r.gapMs).filter((g) => g !== null);
  const loadGaps = load.map((r) => r.gapMs).filter((g) => g !== null);
  return {
    spike: 'WF-00b workflows-ddg-pacing',
    schema: 1,
    question: 'How much paced fan-out does DuckDuckGo tolerate before it refuses?',
    label,
    startedAt,
    finishedAt: new Date().toISOString(),
    dry: dry ?? false,
    seed,
    runtime: runtime ?? null,
    plan: {
      budget: plan.budget,
      floorMs: plan.floorMs,
      ceilMs: plan.ceilMs,
      reserve: plan.reserve,
      requestTimeoutMs: plan.requestTimeoutMs,
      resultsPerSearch: plan.resultsPerSearch,
      tiers: plan.tiers,
      recoveryWaitsMs: plan.recoveryWaitsMs,
    },
    requestShape: run.shape,
    environment: environment ?? null,
    totals: {
      requests: run.requests.length,
      searches: run.searches.length,
      budgetUsed: run.budgetUsed,
      refusedByBudget: run.refused,
      refusedByDuckDuckGo: run.requests.filter((r) => r.kind === 'blocked').length,
      wallMs: run.wallMs,
      pacing: {
        minGapMs: gaps.length ? Math.min(...gaps) : null,
        loadMaxGapMs: loadGaps.length ? Math.max(...loadGaps) : null,
        floorRespected: gaps.every((g) => g >= plan.floorMs),
        loadGapsOverCeiling: loadGaps.filter((g) => g > plan.ceilMs).length,
      },
    },
    table,
    firstBlock: run.firstBlock ? { ...run.firstBlock, startMs: undefined } : null,
    recovery: run.recovery,
    recommendation: {
      ...recommendation,
      searchDefaults:
        recommendation.status === 'no-data'
          ? null
          : {
              primaryBackend: recommendation.primaryBackend,
              paceMinMs: recommendation.paceMinMs,
              paceJitterMs: recommendation.paceJitterMs,
              maxPerMinute: recommendation.maxPerMinute,
              retryDelaysMs: recommendation.retryDelaysMs,
              giveUpAfterMs: recommendation.giveUpAfterMs,
              endpointOrder: recommendation.endpointOrder,
            },
    },
    notes: notesFor(run, { runtime, environment }),
    requests: run.requests,
    searches: run.searches,
  };
}

// --- A stand-in DuckDuckGo, for rehearsals and tests --------------------------

const FIXTURES = new URL('../../../../packages/web-tools/src/fixtures/', import.meta.url);

/** The captured pages web-tools' own parser tests use. */
export function loadFixtures() {
  const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');
  return {
    html: read('duckduckgo-current.html'),
    lite: read('duckduckgo-lite.html'),
    challenge: read('duckduckgo-challenge.html'),
    empty: read('duckduckgo-empty.html'),
  };
}

/**
 * A DuckDuckGo that answers from fixtures on a fake clock. From request
 * `blockFromRequest` on, html is refused, and lite too when `liteBlocked` is
 * set. That lasts `blockForMs`, or forever when unset. The refusal is the
 * challenge page, or an empty body (`blockBody: 'empty'`, the quiet kind),
 * served with `blockStatus` (default 202). `emptyAt` answers that request
 * number with a clean page of no results. `throwOn` ('html' | 'all') fails
 * the transport the way a dropped connection does.
 */
export function createFakeDdg({ clock, fixtures = loadFixtures(), script = {} }) {
  let n = 0;
  let blockedSince = null;
  const calls = [];
  const fake = async (url) => {
    n += 1;
    const endpoint = endpointOf(url);
    calls.push({ n, endpoint, at: clock.now() });
    await clock.sleep(script.latencyMs ?? 300);
    if (script.throwOn === 'all' || script.throwOn === endpoint)
      throw new TypeError('fetch failed');
    if (script.emptyAt === n) return new Response(fixtures.empty, { status: 200 });
    const t = clock.now();
    if (
      script.blockFromRequest !== undefined &&
      n >= script.blockFromRequest &&
      blockedSince === null
    ) {
      blockedSince = t;
    }
    const active =
      blockedSince !== null &&
      (script.blockForMs === undefined || t - blockedSince < script.blockForMs);
    if (active && (endpoint === 'html' || script.liteBlocked)) {
      const body = script.blockBody === 'empty' ? '' : fixtures.challenge;
      return new Response(body, { status: script.blockStatus ?? 202 });
    }
    return new Response(endpoint === 'lite' ? fixtures.lite : fixtures.html, { status: 200 });
  };
  fake.calls = calls;
  return fake;
}

/** DRY=… rehearsals of the shapes a real run can take. */
export const DRY_SCRIPTS = Object.freeze({
  clean: {},
  block: { blockFromRequest: 20, blockForMs: 90_000 },
  blocked: { blockFromRequest: 1, liteBlocked: true },
  silent: {
    blockFromRequest: 20,
    blockForMs: 60_000,
    blockStatus: 202,
    blockBody: 'empty',
    liteBlocked: true,
  },
});

// --- Running it for real ---------------------------------------------------------

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * Holds the machine's one network fan-out slot (PLAN.md §4.3) until released.
 * A slot whose owner has gone is taken over. One that is still being written
 * (no pid yet) is left alone for that round.
 */
export async function takeNetLock({
  root = process.env.BOBBLE_LOCK_DIR ?? '/tmp/bobble-locks',
  waitMs = Number(process.env.LOCK_WAIT_MS ?? 10 * 60_000),
  pollMs = 2000,
} = {}) {
  const slot = path.join(root, 'net-0');
  mkdirSync(root, { recursive: true });
  const began = Date.now();
  for (;;) {
    try {
      mkdirSync(slot);
      writeFileSync(path.join(slot, 'pid'), String(process.pid));
      writeFileSync(path.join(slot, 'cmd'), `workflows-ddg-pacing (WF-00b)\n${process.cwd()}\n`);
      break;
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(path.join(slot, 'pid'), 'utf8'));
      } catch {
        /* being written: leave it this round */
      }
      if (owner > 0 && !alive(owner)) {
        rmSync(slot, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - began >= waitMs) {
        throw new Error(`another network fan-out holds ${slot} (pid ${owner || '?'})`);
      }
      process.stderr.write(`waiting for ${slot} (held by pid ${owner || '?'})…\n`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rmSync(slot, { recursive: true, force: true });
  };
  process.on('exit', release);
  return release;
}

/**
 * Best effort: established TCP connections from OTHER processes to
 * DuckDuckGo's addresses. They share this IP's allowance, so a refusal while
 * they are busy is not the spike's alone.
 */
export async function otherDdgConnections() {
  try {
    const ips = new Set();
    for (const host of ['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com']) {
      for (const a of await lookup(host, { all: true })) ips.add(a.address);
    }
    let out = '';
    try {
      out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpcn'], {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      out = typeof err.stdout === 'string' ? err.stdout : ''; // exit 1 = nothing listed
    }
    let pid = 0;
    let cmd = '';
    const hits = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('c')) cmd = line.slice(1);
      else if (line.startsWith('n') && line.includes('->')) {
        const remote = line.slice(line.indexOf('->') + 2);
        const host = remote.slice(0, remote.lastIndexOf(':')).replace(/^\[|\]$/g, '');
        if (ips.has(host) && pid !== process.pid) hits.push(cmd);
      }
    }
    return { connections: hits.length, processes: [...new Set(hits)] };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

export function describeRuntime() {
  let appElectron = null;
  try {
    const pkg = new URL('../../node_modules/electron/package.json', import.meta.url);
    appElectron = JSON.parse(readFileSync(pkg, 'utf8')).version;
  } catch {
    /* electron not installed here */
  }
  const electron = process.versions.electron ?? null;
  return {
    node: process.versions.node,
    electron,
    undici: process.versions.undici ?? null,
    tls:
      process.versions.boringssl || process.versions.openssl === '0.0.0'
        ? 'BoringSSL'
        : `OpenSSL ${process.versions.openssl}`,
    appElectron,
    matchesApp: electron !== null && electron === appElectron,
  };
}

function progressLine(ev) {
  if (ev.type !== 'request') return null;
  const r = ev.request;
  const gap = r.gapMs === null ? '  —  ' : `${(r.gapMs / 1000).toFixed(2)}s`;
  return (
    `#${String(r.i).padStart(2, '0')} ${r.tier.padEnd(11)} ${r.endpoint.padEnd(4)} gap ${gap} ` +
    `HTTP ${r.status} ${r.kind.padEnd(7)} ${String(r.results).padStart(2)} results ` +
    `${String(r.latencyMs).padStart(5)} ms  ${r.trailing60}/60s${r.markers.length ? `  [${r.markers.join(',')}]` : ''}`
  );
}

async function main() {
  const dryArg = process.env.DRY;
  const dry = dryArg ? (dryArg === '1' || dryArg === 'true' ? 'clean' : dryArg) : null;
  if (dry && !(dry in DRY_SCRIPTS)) {
    console.error(`DRY must be 1 or one of: ${Object.keys(DRY_SCRIPTS).join(', ')}`);
    process.exit(64);
  }
  let plan;
  try {
    plan = planFromEnv();
  } catch (err) {
    console.error(err.message);
    process.exit(64);
  }
  const OUT = process.env.OUT ?? '/tmp/bobble-spikes/workflows-ddg-pacing';
  mkdirSync(OUT, { recursive: true });
  const seed = Number(process.env.SEED ?? 23);
  const label = process.env.RUN_LABEL || null;
  const runtime = describeRuntime();
  const startedAt = new Date().toISOString();

  let stop = false;
  let release = () => {};
  const onSignal = () => {
    if (stop) {
      release();
      process.exit(130);
    }
    stop = true;
    process.stderr.write('\nstopping after the current search (again to quit now)\n');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let clock;
  let network;
  let environment = null;
  if (dry) {
    clock = createFakeClock();
    network = createFakeDdg({ clock, script: DRY_SCRIPTS[dry] });
  } else {
    release = await takeNetLock();
    clock = realClock();
    network = (url, init) => fetch(url, init);
    environment = { atStart: await otherDdgConnections() };
  }
  process.stderr.write(
    `WF-00b DuckDuckGo pacing ${dry ? `(DRY=${dry}, no network)` : '(live)'} · ` +
      `node ${runtime.node}${runtime.electron ? ` · electron ${runtime.electron}` : ''} · ${runtime.tls}` +
      ` · budget ${plan.budget}${label ? ` · ${label}` : ''}\n`,
  );
  try {
    const run = await runProtocol({
      plan,
      network,
      clock,
      seed,
      shouldStop: () => stop,
      onEvent: (ev) => {
        const line = progressLine(ev);
        if (line) process.stderr.write(`${line}\n`);
      },
    });
    if (!dry) environment.atEnd = await otherDdgConnections();
    const report = buildReport({
      run,
      plan,
      seed,
      dry,
      runtime,
      environment,
      startedAt,
      label,
    });
    const stamp = startedAt.replace(/[:.]/g, '-');
    const base = path.join(OUT, `workflows-ddg-pacing${dry ? `-dry-${dry}` : ''}-${stamp}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    const firstBody = run.firstBlock ? run.bodies.get(run.firstBlock.request) : undefined;
    if (firstBody !== undefined) writeFileSync(`${base}.first-refusal.html`, firstBody);
    const rec = report.recommendation;
    process.stderr.write(
      `\n${renderTable(report.table)}\n\n` +
        `recommendation: ${rec.status}` +
        (rec.paceMinMs === undefined
          ? '\n'
          : ` · pace ${rec.paceMinMs} ms + U(0, ${rec.paceJitterMs}) ms · ` +
            `${rec.maxPerMinute === null ? 'no safe rate shown' : `≤${rec.maxPerMinute}/min`} · ` +
            `retry ${rec.retryDelaysMs.join(', ')} ms${rec.retryMeasured ? ' (measured)' : ' (not measured)'}\n`) +
        `${rec.basis}\n${rec.untested ?? ''}\n` +
        (report.notes.length ? `notes:\n- ${report.notes.join('\n- ')}\n` : '') +
        `written: ${base}.json\n`,
    );
    await new Promise((resolve) =>
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, resolve),
    );
  } finally {
    release();
  }
  process.exit(0);
}

const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
