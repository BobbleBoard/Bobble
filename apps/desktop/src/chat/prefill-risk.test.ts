import { describe, expect, it } from 'vitest';
import {
  formatSeconds,
  formatTokens,
  RE_PREFILL_WARN_TOKENS,
  riskBadge,
  riskSentence,
  worthWarning,
} from './prefill-risk';

describe('worthWarning', () => {
  it('keeps quiet about a short conversation', () => {
    expect(worthWarning(2_000)).toBe(false);
    expect(worthWarning(RE_PREFILL_WARN_TOKENS - 1)).toBe(false);
  });

  it('speaks up at the threshold the user named', () => {
    expect(worthWarning(RE_PREFILL_WARN_TOKENS)).toBe(true);
    expect(worthWarning(40_000)).toBe(true);
  });
});

describe('formatTokens', () => {
  it('reads at the precision someone can act on', () => {
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(16_000)).toBe('16k');
    expect(formatTokens(24_400)).toBe('24k');
    expect(formatTokens(1_500)).toBe('1.5k');
    expect(formatTokens(2_000)).toBe('2k');
  });
});

describe('formatSeconds', () => {
  /*
   * The whole reason this returns null: an estimate the machine has not earned
   * is worse than no estimate, on a warning whose only job is to be believed.
   */
  it('says nothing when nothing has been measured', () => {
    expect(formatSeconds(null)).toBeNull();
    expect(formatSeconds(0)).toBeNull();
    expect(formatSeconds(Number.NaN)).toBeNull();
  });

  it('reads in seconds, then in minutes', () => {
    expect(formatSeconds(18)).toBe('18s');
    expect(formatSeconds(0.4)).toBe('1s');
    expect(formatSeconds(80)).toBe('1m 20s');
    expect(formatSeconds(120)).toBe('2m');
  });
});

describe('riskBadge', () => {
  it('quotes only the size until the machine has been measured', () => {
    expect(riskBadge({ tokens: 24_000, cause: 'model-switch', seconds: null })).toBe(
      're-reads 24k tokens',
    );
  });

  it('quotes the time once it has been', () => {
    expect(riskBadge({ tokens: 24_000, cause: 'model-switch', seconds: 18 })).toBe(
      're-reads 24k tokens · ~18s',
    );
  });
});

describe('riskSentence', () => {
  it('says what it costs and why', () => {
    const s = riskSentence({ tokens: 24_000, cause: 'model-switch', seconds: 18 });
    expect(s).toContain('24k tokens');
    expect(s).toContain('about 18s');
    expect(s).toContain('different model');
  });

  it('names the other causes too', () => {
    expect(riskSentence({ tokens: 20_000, cause: 'edit', seconds: null })).toContain(
      'editing an earlier message'.replace('e', 'E'),
    );
    expect(riskSentence({ tokens: 20_000, cause: 'compaction', seconds: null })).toContain(
      'rewritten to fit',
    );
  });

  it('never invents a duration', () => {
    expect(riskSentence({ tokens: 20_000, cause: 'model-switch', seconds: null })).not.toMatch(
      /about/,
    );
  });
});
