import { describe, expect, it } from 'vitest';
import { composerPill } from './composer-pill';

const base = { readyStage: null, prefillPercent: null, imageOnBlindModel: false } as const;

describe('composerPill', () => {
  it('says nothing when nothing is happening', () => {
    expect(composerPill(base)).toBeNull();
  });

  /*
   * A RING ONLY WHERE A REAL NUMBER EXISTS. llama-server reports no load
   * progress over HTTP, so there is nothing to draw but a spinner — and
   * inventing one is the 99%-bar that made a blind tester decide the app was
   * lying to her.
   */
  it('spins while the model loads, and never invents a percentage', () => {
    const v = composerPill({ ...base, readyStage: 'loading', prefillPercent: 42 });
    expect(v?.text).toBe('Loading model');
    expect(v?.percent).toBeNull();
    expect(v?.tone).toBe('busy');
  });

  it('shows a real percentage while getting ready, when one is reported', () => {
    expect(composerPill({ ...base, readyStage: 'preparing', prefillPercent: 63 })?.percent).toBe(
      63,
    );
  });

  it('spins while getting ready when no percentage is being reported', () => {
    expect(composerPill({ ...base, readyStage: 'preparing' })?.percent).toBeNull();
  });

  it('warns about an image the model cannot read', () => {
    const v = composerPill({ ...base, imageOnBlindModel: true });
    expect(v?.text).toBe('Selected model does not support images');
    expect(v?.tone).toBe('warn');
    expect(v?.kind).toBe('no-vision');
  });

  /*
   * A model that is still loading cannot answer at all, so it outranks a warning
   * about an attachment nobody has asked it about yet.
   */
  it('shows ONE thing, and the wait outranks the warning', () => {
    const v = composerPill({ ...base, readyStage: 'loading', imageOnBlindModel: true });
    expect(v?.kind).toBe('loading');
  });
});
