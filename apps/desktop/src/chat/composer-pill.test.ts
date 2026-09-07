import { describe, expect, it } from 'vitest';
import { composerPill, pickPill } from './composer-pill';

const base = {
  readyStage: null,
  imageOnBlindModel: false,
  elapsedMs: null,
  typicalSec: null,
} as const;

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
  it('spins while the model starts, and never invents a percentage', () => {
    const v = composerPill({ ...base, readyStage: 'loading' });
    expect(v?.text).toBe('Starting up');
    expect(v?.percent).toBeNull();
    expect(v?.tone).toBe('busy');
  });

  /*
   * THE CLOCK IS WHAT MAKES THE SPINNER HONEST. The tester had to say it twice:
   * "the spinner isn't what reassures me. The changing digits are." A bare
   * spinner starts reading as stuck at about four seconds.
   */
  it('counts up, in both waits', () => {
    expect(composerPill({ ...base, readyStage: 'loading', elapsedMs: 7_000 })?.text).toBe(
      'Starting up · 0:07',
    );
    expect(composerPill({ ...base, readyStage: 'preparing', elapsedMs: 74_000 })?.text).toBe(
      'Getting ready · 1:14',
    );
  });

  it('says nothing for the first second, because a parked 0:00 reads as stopped', () => {
    expect(composerPill({ ...base, readyStage: 'preparing', elapsedMs: 400 })?.text).toBe(
      'Getting ready',
    );
  });

  /*
   * THE ESTIMATE — the half of "name, timer, estimate, cancel" the pill was
   * missing. Not a guess: once this machine has done the wait twice, how long it
   * took is a ground truth the app can check.
   */
  it('quotes what this Mac usually takes, once it knows', () => {
    expect(
      composerPill({ ...base, readyStage: 'preparing', elapsedMs: 3_000, typicalSec: 8 })?.text,
    ).toBe('Getting ready — usually about 8s on this Mac · 0:03');
  });

  it('says nothing about typical before it has happened twice', () => {
    expect(composerPill({ ...base, readyStage: 'preparing', elapsedMs: 3_000 })?.text).toBe(
      'Getting ready · 0:03',
    );
  });

  /*
   * THREE WAITS, THREE PHRASES. Two of them said the same words and only one
   * could ever carry a number: "the moment I see both, the one without the
   * number becomes a bug — because you've proved to me the app can count."
   */
  it('gives the two boot waits different words', () => {
    expect(composerPill({ ...base, readyStage: 'loading' })?.text).not.toBe(
      composerPill({ ...base, readyStage: 'preparing' })?.text,
    );
  });

  it('never carries a percentage at all — the turn prefill lives in the thread', () => {
    for (const stage of ['loading', 'preparing'] as const) {
      expect(composerPill({ ...base, readyStage: stage, elapsedMs: 5_000 })?.percent).toBeNull();
    }
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

  it('never carries a percentage at all — the turn prefill lives in the thread', () => {
    for (const stage of ['loading', 'preparing'] as const) {
      expect(composerPill({ ...base, readyStage: stage, elapsedMs: 5_000 })?.percent).toBeNull();
    }
  });
});

describe('pickPill — one slot, most urgent wins', () => {
  it('is null with nothing to say', () => {
    expect(pickPill([])).toBeNull();
  });

  it('prefers the higher priority', () => {
    const picked = pickPill([
      { text: 'ad hoc', tone: 'busy' as const, priority: 50 },
      { text: 'the model is not up', tone: 'busy' as const, priority: 100 },
    ]);
    expect(picked?.text).toBe('the model is not up');
  });

  /*
   * A tie goes to the LATEST. A source that keeps publishing (a countdown, a
   * retry) should replace its own stale sentence rather than lose to it.
   */
  it('breaks a tie in favour of the newest', () => {
    expect(
      pickPill([
        { text: 'first', tone: 'warn' as const },
        { text: 'second', tone: 'warn' as const },
      ])?.text,
    ).toBe('second');
  });

  it('treats a missing priority as the middle, not as zero', () => {
    expect(
      pickPill([
        { text: 'default', tone: 'busy' as const },
        { text: 'explicitly low', tone: 'busy' as const, priority: 10 },
      ])?.text,
    ).toBe('default');
  });
});
