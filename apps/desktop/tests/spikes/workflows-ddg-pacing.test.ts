/**
 * WF-00b's spike, rehearsed against a stand-in DuckDuckGo on a fake clock.
 *
 * The live run gets ONE go at the real service (at most 30 requests), so the
 * rules that keep it polite are proven here first:
 *  - the budget;
 *  - the 2 s floor, which holds for the lite fallback too;
 *  - the stop at the first refusal;
 *  - the recovery probes;
 *  - the defaults the table turns into;
 *  - the machine-wide slot that keeps it the only fan-out running.
 * No test here touches the network: the stand-in answers from web-tools' own
 * captured pages.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - the spike is plain ESM run by node or electron, not typed app code.
import * as spike from './workflows-ddg-pacing.mjs';

const fixtures = spike.loadFixtures();

async function rehearse(script: Record<string, unknown>, plan = spike.PLAN) {
  const clock = spike.createFakeClock();
  const network = spike.createFakeDdg({ clock, fixtures, script });
  const run = await spike.runProtocol({ plan, network, clock, seed: 23 });
  return { run, network, table: spike.toleranceTable(run, plan) };
}

const classify = (status: number, body: string, endpoint = 'html') =>
  spike.classifyResponse({ endpoint, status, body });

type Req = { i: number; tier: string; endpoint: string; gapMs: number | null; trailing60: number };

describe('the plan', () => {
  it('caps DuckDuckGo at 30 requests and draws every load gap from 2–5 s, slow tiers first', () => {
    expect(spike.PLAN.budget).toBe(30);
    expect(spike.PLAN.floorMs).toBe(2000);
    expect(spike.PLAN.ceilMs).toBe(5000);
    for (const t of spike.PLAN.tiers) {
      expect(t.gapMinMs).toBeGreaterThanOrEqual(2000);
      expect(t.gapMaxMs).toBeLessThanOrEqual(5000);
    }
    const chain = spike.PLAN.tiers.filter((t: { path: string }) => t.path === 'chain');
    const mins = chain.map((t: { gapMinMs: number }) => t.gapMinMs);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
    // The fastest tier is a whole Standard research run's fan-out (5 × 3 queries).
    expect(chain.at(-1).searches).toBe(15);
  });

  it('asks distinct queries, enough that none repeats within the budget', () => {
    expect(new Set(spike.QUERIES).size).toBe(spike.QUERIES.length);
    expect(spike.QUERIES.length).toBeGreaterThanOrEqual(spike.PLAN.budget);
  });

  it('draws the same gaps for the same seed, always inside the tier', () => {
    const tier = spike.PLAN.tiers.find((t: { id: string }) => t.id === 'gap-2-2.5s');
    const a = spike.mulberry32(7);
    const b = spike.mulberry32(7);
    const xs = Array.from({ length: 500 }, () => spike.jitteredGap(tier, a));
    const ys = Array.from({ length: 500 }, () => spike.jitteredGap(tier, b));
    expect(xs).toEqual(ys);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(2000);
    expect(Math.max(...xs)).toBeLessThanOrEqual(2500);
    expect(new Set(xs).size).toBeGreaterThan(100); // it really jitters
  });

  it('percentile is nearest-rank and ignores missing values', () => {
    expect(spike.percentile([5, 1, 3, null, 2, 4], 50)).toBe(3);
    expect(spike.percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(spike.percentile([], 50)).toBeNull();
  });
});

describe('classifyResponse (production parsers and challenge detector)', () => {
  it('reads the challenge page as refused, and search.ts sees it too, even under a 200', () => {
    const r = classify(200, fixtures.challenge);
    expect(r.kind).toBe('blocked');
    expect(r.backendSeesBlock).toBe(true);
    expect(r.markers).toEqual(
      expect.arrayContaining(['anomaly-modal', 'challenge-form', 'bots-use-duckduckgo']),
    );
  });

  it('reads a bare 202 as refused, and flags that search.ts would take it for a clean page', () => {
    expect(classify(202, '')).toMatchObject({ kind: 'blocked', backendSeesBlock: false });
  });

  it('counts results on both endpoints with production parsers', () => {
    expect(classify(200, fixtures.html)).toMatchObject({
      kind: 'ok',
      results: 3,
      topDomains: ['www.example.com', 'en.wikipedia.org', 'www.iana.org'],
    });
    expect(classify(200, fixtures.lite, 'lite')).toMatchObject({ kind: 'ok', results: 2 });
  });

  it('tells a clean empty page, a server error and a "slow down" status apart', () => {
    expect(classify(200, fixtures.empty).kind).toBe('empty');
    expect(classify(500, 'oops').kind).toBe('http-error');
    expect(classify(403, 'forbidden').kind).toBe('blocked');
    expect(classify(429, '').kind).toBe('blocked');
  });

  it('treats a no-results captcha page as refused, which search.ts would not', () => {
    const page = '<html><body><div class="captcha">Please verify</div></body></html>';
    expect(classify(200, page)).toMatchObject({
      kind: 'blocked',
      backendSeesBlock: false,
      markers: ['captcha'],
    });
  });
});

describe('searchOutcome', () => {
  const r = (kind: string) => ({ kind });
  it('names what the research runner would have experienced', () => {
    expect(spike.searchOutcome([r('ok')], [{}], false)).toBe('results');
    expect(spike.searchOutcome([r('blocked'), r('ok')], [{}], false)).toBe('rescued');
    expect(spike.searchOutcome([r('blocked'), r('blocked')], null, false)).toBe('failed');
    expect(spike.searchOutcome([r('blocked'), r('blocked')], [], false)).toBe('silent-empty');
    expect(spike.searchOutcome([r('empty'), r('empty')], [], false)).toBe('empty');
    expect(spike.searchOutcome([r('neterr'), r('http-error')], null, false)).toBe('error');
    expect(spike.searchOutcome([], null, true)).toBe('budget-cut');
  });
});

describe('the pacer, the budget and the wrapped fetch', () => {
  it('never starts two requests closer than the floor, whatever gap it is asked for', async () => {
    const clock = spike.createFakeClock();
    const pacer = spike.createPacer(clock, 2000);
    pacer.setGap(10);
    const starts: number[] = [];
    for (let i = 0; i < 5; i++) {
      starts.push((await pacer.wait()).start);
      await clock.sleep(150);
    }
    expect(starts.slice(1).map((s, i) => s - starts[i])).toEqual([2000, 2000, 2000, 2000]);
  });

  it('lets a slow answer stretch the gap, never squeeze the next one', async () => {
    const clock = spike.createFakeClock();
    const pacer = spike.createPacer(clock, 2000);
    pacer.setGap(2500);
    await pacer.wait();
    await clock.sleep(4000); // a slow response
    expect((await pacer.wait()).actualGapMs).toBe(4000);
    expect((await pacer.wait()).actualGapMs).toBe(2500);
  });

  it('lets exactly the budget through to the network and answers the rest offline', async () => {
    const clock = spike.createFakeClock();
    const network = spike.createFakeDdg({ clock, fixtures });
    let refused = 0;
    const seen: unknown[] = [];
    const f = spike.instrumentFetch({
      network,
      clock,
      pacer: spike.createPacer(clock, 2000),
      budget: spike.createBudget(30),
      route: () => 'network',
      onRequest: (r: unknown) => seen.push(r),
      onRefused: () => {
        refused += 1;
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await f('https://html.duckduckgo.com/html/', { method: 'POST', body: 'q=x' });
      statuses.push(res.status);
    }
    expect(network.calls).toHaveLength(30);
    expect(seen).toHaveLength(30);
    expect(refused).toBe(10);
    expect(statuses.slice(30)).toEqual(Array(10).fill(599));
  });

  it('refuses anything but the html and lite endpoints, before the network', async () => {
    const clock = spike.createFakeClock();
    const network = spike.createFakeDdg({ clock, fixtures });
    const f = spike.instrumentFetch({
      network,
      clock,
      pacer: spike.createPacer(clock, 2000),
      budget: spike.createBudget(30),
      route: () => 'network',
      onRequest: () => {},
    });
    await expect(f('https://duckduckgo.com/?q=x')).rejects.toThrow(/only talks to DuckDuckGo/);
    await expect(f('https://example.com/')).rejects.toThrow(/only talks to DuckDuckGo/);
    expect(network.calls).toHaveLength(0);
  });
});

describe('runProtocol against the stand-in', () => {
  it('asks exactly what production asks: the real backend is in the loop', async () => {
    const { run } = await rehearse({});
    expect(run.shape).toMatchObject({
      method: 'POST',
      url: 'https://html.duckduckgo.com/html/',
      contentType: 'application/x-www-form-urlencoded',
      body: 'q=<query>&kl=wt-wt',
    });
    expect(run.shape.userAgent).toMatch(/^Mozilla\/5\.0 /);
    expect(run.shape.headerNames).toEqual(
      expect.arrayContaining(['accept', 'accept-language', 'referer', 'user-agent']),
    );
    expect(run.searches[0].query).toBe(spike.QUERIES[0]);
  });

  it('clean: 26 production searches slow to fast, then 4 on lite: exactly 30 requests', async () => {
    const { run, network, table } = await rehearse(spike.DRY_SCRIPTS.clean);
    expect(network.calls).toHaveLength(30);
    expect(run.requests).toHaveLength(30);
    expect(run.firstBlock).toBeNull();
    expect(run.recovery).toBeNull();
    expect(
      table.map((r: { tier: string; searches: number; requests: number; verdict: string }) => [
        r.tier,
        r.searches,
        r.requests,
        r.verdict,
      ]),
    ).toEqual([
      ['gap-4.5-5s', 4, 4, 'clean'],
      ['gap-3.5-4s', 4, 4, 'clean'],
      ['gap-2.5-3s', 3, 3, 'clean'],
      ['gap-2-2.5s', 15, 15, 'clean'],
      ['lite-2-2.5s', 4, 4, 'clean'],
    ]);
    const lite = run.requests.filter((r: Req) => r.tier === 'lite-2-2.5s');
    expect(lite.every((r: Req) => r.endpoint === 'lite')).toBe(true);
    // Every gap sits inside its own tier's range, so all of them sit inside 2–5 s.
    for (const row of table) {
      expect(row.actualGapMs.min).toBeGreaterThanOrEqual(row.nominalGapMs[0]);
      expect(row.actualGapMs.max).toBeLessThanOrEqual(row.nominalGapMs[1]);
    }
    const rec = spike.recommend(run, table);
    expect(rec).toMatchObject({
      status: 'no-challenge',
      primaryBackend: 'duckduckgo',
      paceMinMs: 2000,
      paceJitterMs: 500,
      retryMeasured: false,
    });
    expect(rec.maxPerMinute).toBe(Math.max(...run.requests.map((r: Req) => r.trailing60)));
  });

  it('a refusal mid-burst stops the load; lite rescues that search; the probes time the recovery', async () => {
    const { run, network, table } = await rehearse(spike.DRY_SCRIPTS.block);
    expect(run.firstBlock).toMatchObject({
      request: 20,
      tier: 'gap-2-2.5s',
      endpoint: 'html',
      status: 202,
      reason: 'challenged',
    });
    const refusedSearch = run.searches.find((s: { s: number }) => s.s === run.firstBlock.search);
    expect(refusedSearch).toMatchObject({ outcome: 'rescued', via: 'lite' });
    // The fallback waited out the pace like any other request.
    const fallback = run.requests.find((r: Req) => r.i === 21);
    expect(fallback).toMatchObject({ endpoint: 'lite' });
    expect(fallback.gapMs).toBeGreaterThanOrEqual(2000);
    // After the refusal: only spaced html probes, the first after a 30 s cool-down.
    const after = run.requests.filter((r: Req) => r.i > 21);
    expect(after.every((r: Req) => r.tier === 'recovery' && r.endpoint === 'html')).toBe(true);
    expect(after[0].gapMs).toBeGreaterThanOrEqual(30_000);
    expect(run.recovery.probes.map((p: { kind: string }) => p.kind)).toEqual(['blocked', 'ok']);
    expect(run.recovery.cleanAfterMs).toBeGreaterThan(90_000);
    expect(run.recovery.cleanAfterMs).toBeLessThan(100_000);
    expect(table.find((r: { tier: string }) => r.tier === 'lite-2-2.5s').verdict).toBe('not run');
    expect(network.calls).toHaveLength(23);
    const rec = spike.recommend(run, table);
    expect(rec).toMatchObject({
      status: 'challenged',
      primaryBackend: 'duckduckgo',
      paceMinMs: 2500, // the fastest clean tier slower than the refused one
      paceJitterMs: 500,
      maxPerMinute: run.firstBlock.trailing60 - 1,
      retryDelaysMs: [30_000, 60_000],
      retryMeasured: true,
      giveUpAfterMs: null,
    });
  });

  it('refused from the first request: it never escalates, and gives up after the probes', async () => {
    const { run, table } = await rehearse(spike.DRY_SCRIPTS.blocked);
    expect(run.searches[0]).toMatchObject({ outcome: 'failed', tier: 'gap-4.5-5s' });
    expect(run.requests.filter((r: Req) => r.tier !== 'recovery')).toHaveLength(2); // html, lite
    expect(run.recovery.probes).toHaveLength(4);
    expect(run.recovery.cleanAfterMs).toBeNull();
    expect(run.requests).toHaveLength(6);
    const rec = spike.recommend(run, table);
    expect(rec).toMatchObject({
      status: 'challenged-at-slowest',
      primaryBackend: 'browser-or-key',
      paceMinMs: 5000,
      maxPerMinute: null,
      retryMeasured: false,
    });
    expect(rec.giveUpAfterMs).toBeGreaterThan(390_000);
  });

  it('a quiet refusal (a bare 202) shows up as silent-empty, which search.ts would miss', async () => {
    const { run } = await rehearse(spike.DRY_SCRIPTS.silent);
    const s = run.searches.find((x: { s: number }) => x.s === run.firstBlock.search);
    expect(s.outcome).toBe('silent-empty');
    expect(run.firstBlock).toMatchObject({
      reason: 'refused without a challenge page',
      backendSeesBlock: false,
    });
    const report = spike.buildReport({ run, seed: 23, dry: 'silent', startedAt: 'test' });
    expect(report.notes.join('\n')).toMatch(/empty although a request was refused/);
    expect(report.notes.join('\n')).toMatch(/does not recognise: HTTP 202 with no marker/);
  });

  it('an empty page where results were certain stops the load too: it may be a quiet block', async () => {
    const { run } = await rehearse({ emptyAt: 5 });
    expect(run.firstBlock).toMatchObject({
      request: 5,
      reason: 'empty page (possible quiet block)',
    });
    expect(run.requests.filter((r: Req) => r.tier !== 'recovery').length).toBeLessThanOrEqual(6);
    expect(run.recovery.probes.length).toBeGreaterThan(0);
  });

  it('holds the budget even when every search needs its fallback', async () => {
    // html drops every connection (not a refusal, so the load goes on): two requests per search.
    const { run, network, table } = await rehearse({ throwOn: 'html' });
    expect(network.calls).toHaveLength(30);
    expect(run.requests).toHaveLength(30);
    expect(run.firstBlock).toBeNull();
    const chain = run.searches.filter((s: { path: string }) => s.path === 'chain');
    expect(chain).toHaveLength(13); // 13 × 2 = 26, then the reserve goes to lite
    expect(chain.every((s: { outcome: string }) => s.outcome === 'results')).toBe(true);
    expect(table.find((r: { tier: string }) => r.tier === 'lite-2-2.5s').requests).toBe(4);
  });

  it('stops on three failed requests in a row: network trouble is not a measurement', async () => {
    const { run } = await rehearse({ throwOn: 'all' });
    expect(run.stoppedBecause).toMatch(/three failed requests in a row/);
    expect(run.requests).toHaveLength(4);
    expect(run.recovery).toBeNull();
  });
});

describe('the report', () => {
  it('proves the pacing and carries the defaults WF-01 records', async () => {
    const { run } = await rehearse(spike.DRY_SCRIPTS.clean);
    const report = spike.buildReport({ run, seed: 23, dry: 'clean', startedAt: 'test' });
    expect(report.totals).toMatchObject({
      requests: 30,
      budgetUsed: 30,
      refusedByBudget: 0,
      refusedByDuckDuckGo: 0,
    });
    expect(report.totals.pacing).toMatchObject({ floorRespected: true, loadGapsOverCeiling: 0 });
    expect(report.totals.pacing.minGapMs).toBeGreaterThanOrEqual(2000);
    expect(report.recommendation.searchDefaults).toMatchObject({
      primaryBackend: 'duckduckgo',
      giveUpAfterMs: null,
      paceMinMs: 2000,
      paceJitterMs: 500,
      endpointOrder: ['html', 'lite'],
    });
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({ schema: 1, seed: 23 });
  });

  it('renders every tier as a markdown row', async () => {
    const { table } = await rehearse(spike.DRY_SCRIPTS.block);
    const md = spike.renderTable(table);
    const lines = md.split('\n');
    expect(lines[0]).toMatch(/^\| Tier \| Path \|/);
    expect(lines[1]).toMatch(/^\|---\|/);
    expect(lines).toHaveLength(2 + table.length);
    for (const row of table) expect(md).toContain(`| ${row.tier} |`);
    expect(md).toContain('| recovered |');
  });
});

describe('the network slot (one fan-out on the machine at a time)', () => {
  it('is taken, held against a second taker, released, and taken over from a dead owner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ddg-net-lock-'));
    const slot = path.join(root, 'net-0');
    try {
      const release = await spike.takeNetLock({ root, waitMs: 0, pollMs: 1 });
      expect(readFileSync(path.join(slot, 'pid'), 'utf8')).toBe(String(process.pid));
      await expect(spike.takeNetLock({ root, waitMs: 0, pollMs: 1 })).rejects.toThrow(
        /another network fan-out holds/,
      );
      release();
      expect(existsSync(slot)).toBe(false);
      // A slot left behind by a process that no longer exists is taken over.
      mkdirSync(slot);
      writeFileSync(path.join(slot, 'pid'), '99999999');
      const again = await spike.takeNetLock({ root, waitMs: 0, pollMs: 1 });
      expect(readFileSync(path.join(slot, 'pid'), 'utf8')).toBe(String(process.pid));
      again();
      expect(existsSync(slot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('BUDGET (a repeat run stays inside the package total)', () => {
  it('can only lower the cap, and refuses nonsense', () => {
    expect(spike.planFromEnv({})).toBe(spike.PLAN);
    expect(spike.planFromEnv({ BUDGET: '' })).toBe(spike.PLAN);
    expect(spike.planFromEnv({ BUDGET: '21' }).budget).toBe(21);
    expect(spike.planFromEnv({ BUDGET: '500' }).budget).toBe(30);
    expect(() => spike.planFromEnv({ BUDGET: '0' })).toThrow(/whole number from 1 to 30/);
    expect(() => spike.planFromEnv({ BUDGET: 'lots' })).toThrow(/whole number from 1 to 30/);
    expect(() => spike.planFromEnv({ BUDGET: '2.5' })).toThrow(/whole number from 1 to 30/);
  });

  it('a lowered cap holds end to end, clean or refused', async () => {
    const plan = spike.planFromEnv({ BUDGET: '21' });
    const clean = await rehearse(spike.DRY_SCRIPTS.clean, plan);
    expect(clean.network.calls).toHaveLength(21);
    expect(clean.run.budgetUsed).toBe(21);
    const refused = await rehearse(spike.DRY_SCRIPTS.blocked, plan);
    expect(refused.network.calls.length).toBeLessThanOrEqual(21);
    const report = spike.buildReport({
      run: clean.run,
      plan,
      seed: 23,
      dry: 'clean',
      startedAt: 'test',
      label: 'repeat',
    });
    expect(report).toMatchObject({ label: 'repeat', plan: { budget: 21 } });
  });
});
