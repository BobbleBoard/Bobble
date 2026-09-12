import { describe, expect, it } from 'vitest';
import { createLiveTpsReporter, parseLiveTpsLine } from './live-tps.js';

describe('live tps reporter', () => {
  it('reports at most every 400 ms while tokens land, and a final done line', () => {
    const lines: string[] = [];
    let t = 1000;
    const r = createLiveTpsReporter(
      (l) => lines.push(l),
      () => t,
    );
    for (let i = 0; i < 10; i++) {
      r.tick();
      t += 100;
    }
    r.end();
    // 1000 (first), 1400, 1800 → three interim lines, then the final.
    expect(lines).toHaveLength(4);
    expect(parseLiveTpsLine(lines[0] ?? '')).toEqual({ tokens: 1, ms: 0, done: false });
    expect(parseLiveTpsLine(lines[3] ?? '')).toEqual({ tokens: 10, ms: 1000, done: true });
    expect(parseLiveTpsLine('[pi-kv] context=1')).toBeNull();
  });

  it('says nothing for a stream that produced no tokens', () => {
    const lines: string[] = [];
    const r = createLiveTpsReporter(
      (l) => lines.push(l),
      () => 0,
    );
    r.end();
    r.tick();
    expect(lines).toEqual([]);
  });
});
