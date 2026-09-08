import { describe, expect, it } from 'vitest';
import {
  CARD_AFTER_MS,
  DEFAULT_ESTIMATES,
  estimateFor,
  estimateText,
  jobKindForTool,
  jobView,
  shouldShowCard,
  timerText,
} from './long-job';

describe('when a card appears', () => {
  it('is there from the first frame for anything that produces a result', () => {
    // Every generated modality, including the quick ones: the card is the box
    // the result lands in, so it has to exist before the result does.
    for (const kind of ['image', 'video', 'music', 'speech', 'sfx', 'model3d'] as const) {
      expect(shouldShowCard(kind, 0)).toBe(true);
    }
  });

  it('waits out a job that might be over before you notice it', () => {
    expect(shouldShowCard('other', 0)).toBe(false);
    expect(shouldShowCard('other', CARD_AFTER_MS - 1)).toBe(false);
    expect(shouldShowCard('other', CARD_AFTER_MS)).toBe(true);
  });
});

describe('estimateFor — the range narrows to THIS Mac', () => {
  it('quotes the shipped guess until the machine has done it twice', () => {
    expect(estimateFor('image', [])).toEqual({
      lowSec: DEFAULT_ESTIMATES.image[0],
      highSec: DEFAULT_ESTIMATES.image[1],
      measured: false,
    });
    expect(estimateFor('image', [42]).measured).toBe(false);
  });

  it('switches to what actually happened here', () => {
    const est = estimateFor('image', [200, 210, 220, 230, 240, 250]);
    expect(est.measured).toBe(true);
    expect(est.lowSec).toBeGreaterThanOrEqual(200);
    expect(est.highSec).toBeLessThanOrEqual(250);
  });

  /*
   * A range that collapses to a point stops being an estimate and becomes a
   * promise — and it is a promise about a local model on a machine doing other
   * things, so it will be broken.
   */
  it('never quotes a single number as though it were certain', () => {
    const est = estimateFor('image', [120, 120, 120, 120]);
    expect(est.highSec).toBeGreaterThan(est.lowSec);
  });

  it('ignores nonsense samples rather than being poisoned by them', () => {
    expect(estimateFor('image', [Number.NaN, -5, 0]).measured).toBe(false);
  });
});

describe('estimateText', () => {
  /*
   * A six-fold range reads as "we have no idea", which — on run one — is true.
   * The tester: "say that instead, and it becomes charming rather than evasive."
   * It also explains why run two will be better, which makes the learning
   * visible instead of silent.
   */
  it('admits it does not know yet, rather than inventing a range', () => {
    expect(estimateText({ lowSec: 30, highSec: 180, measured: false })).toBe(
      "I haven't done this on your Mac yet, so I'm timing it",
    );
  });

  it('quotes ONE number once the machine has actually done it', () => {
    expect(estimateText({ lowSec: 120, highSec: 300, measured: true })).toBe(
      'about 4 minutes on your Mac',
    );
  });

  it('says seconds when seconds is the honest unit', () => {
    expect(estimateText({ lowSec: 30, highSec: 50, measured: true })).toBe(
      'about 40 seconds on your Mac',
    );
  });
});

describe('timerText', () => {
  it('is mm:ss so its width never jumps under the eye', () => {
    expect(timerText(0)).toBe('0:00');
    expect(timerText(9_000)).toBe('0:09');
    expect(timerText(154_000)).toBe('2:34');
    expect(timerText(-1)).toBe('0:00');
  });
});

describe('jobView', () => {
  const est = { lowSec: 120, highSec: 300, measured: true };

  it('names the work in the first person, with no tool in it', () => {
    const v = jobView('image', 5_000, est);
    expect(v.title).toBe('Making your image');
    expect(v.title).not.toMatch(/generate|tool|_/);
    expect(v.estimate).toBe('about 4 minutes on your Mac');
    expect(v.timer).toBe('0:05');
    expect(v.overrun).toBe(false);
    expect(v.overrunText).toBeNull();
  });

  /*
   * A quoted estimate that silently expires is worse than no estimate: the user
   * now has a number they have watched the app break.
   */
  it('admits it when the estimate is blown, and says it is not stuck', () => {
    const v = jobView('image', 301_000, est);
    expect(v.overrun).toBe(true);
    expect(v.overrunText).toBe(
      'Longer than I expected. Still working — nothing has gone wrong. 5:01 so far.',
    );
    // The Cancel button is right there; the sentence should not narrate it.
    expect(v.overrunText).not.toMatch(/stop|cancel/i);
  });

  it('does not cry overrun one tick early', () => {
    expect(jobView('image', 300_000, est).overrun).toBe(false);
  });
});

describe('jobKindForTool', () => {
  it('recognises the generation family whatever it is called', () => {
    expect(jobKindForTool('generate_image')).toBe('image');
    expect(jobKindForTool('edit_image')).toBe('image');
    expect(jobKindForTool('generate_video')).toBe('video');
    expect(jobKindForTool('generate_music')).toBe('music');
    expect(jobKindForTool('generate_speech')).toBe('speech');
    expect(jobKindForTool('generate_sfx')).toBe('sfx');
    expect(jobKindForTool('generate_3d')).toBe('model3d');
  });

  it('says nothing for ordinary tools, which do not get a card', () => {
    expect(jobKindForTool('read_file')).toBeNull();
    expect(jobKindForTool('bash')).toBeNull();
    expect(jobKindForTool(undefined)).toBeNull();
    expect(jobKindForTool('')).toBeNull();
  });
});
