import { describe, expect, it } from 'vitest';
import { createOfflineLatch, isNetworkFailure, OFFLINE_TTL_MS } from './offline.js';

describe('isNetworkFailure', () => {
  it('recognises the shapes a dead network actually produces', () => {
    expect(isNetworkFailure('TypeError: fetch failed')).toBe(true);
    expect(isNetworkFailure('getaddrinfo ENOTFOUND duckduckgo.com')).toBe(true);
    expect(isNetworkFailure('connect ECONNREFUSED 1.1.1.1:443')).toBe(true);
  });

  it('does NOT treat a site being down as the network being down', () => {
    // Withdrawing search because one page 404'd would be its own bug.
    expect(isNetworkFailure('HTTP 404 Not Found')).toBe(false);
    expect(isNetworkFailure('the page returned 503')).toBe(false);
    expect(isNetworkFailure('no results for that query')).toBe(false);
  });
});

describe('the offline latch', () => {
  const at = (t: { now: number }) => createOfflineLatch(() => t.now);

  it('starts hopeful', () => {
    expect(at({ now: 0 }).offline()).toBe(false);
  });

  it('trips on the FIRST network failure from a web tool, and says so once', () => {
    const t = { now: 1000 };
    const latch = at(t);
    expect(latch.note('web_search', true, 'fetch failed')).toBe(true);
    expect(latch.offline()).toBe(true);
    // A second failure inside the window is not news — the note is not repeated.
    t.now += 1000;
    expect(latch.note('web_fetch', true, 'ENOTFOUND')).toBe(false);
    expect(latch.offline()).toBe(true);
  });

  it('ignores failures from tools that are not the web ones', () => {
    const latch = at({ now: 0 });
    expect(latch.note('bash', true, 'fetch failed')).toBe(false);
    expect(latch.offline()).toBe(false);
  });

  it('ignores a non-network error from a web tool', () => {
    const latch = at({ now: 0 });
    expect(latch.note('web_fetch', true, 'HTTP 404')).toBe(false);
    expect(latch.offline()).toBe(false);
  });

  it('gives the tools back once the window passes', () => {
    const t = { now: 0 };
    const latch = at(t);
    latch.note('web_search', true, 'fetch failed');
    t.now += OFFLINE_TTL_MS - 1;
    expect(latch.offline()).toBe(true);
    t.now += 2;
    expect(latch.offline()).toBe(false);
  });

  it('gives them back IMMEDIATELY when a web call succeeds', () => {
    const t = { now: 0 };
    const latch = at(t);
    latch.note('web_search', true, 'fetch failed');
    latch.note('web_search', false, 'three results');
    expect(latch.offline()).toBe(false);
  });

  it('reset clears it (a fresh session starts hopeful)', () => {
    const t = { now: 0 };
    const latch = at(t);
    latch.note('web_search', true, 'fetch failed');
    latch.reset();
    expect(latch.offline()).toBe(false);
  });
});
