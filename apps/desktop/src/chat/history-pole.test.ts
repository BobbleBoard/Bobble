import { describe, expect, it } from 'vitest';
import {
  easeInOutCubic,
  POLE_MAX_DOTS,
  poleDots,
  poleIsUseful,
  poleLabel,
  scrollTargetFor,
} from './history-pole';

const geo = (scrollHeight: number, clientHeight = 800) => ({ scrollHeight, clientHeight });
const turns = (n: number, span = 8000) =>
  Array.from({ length: n }, (_, i) => ({
    id: `u${i}`,
    offsetTop: Math.round((span * i) / Math.max(1, n - 1)),
    text: `question number ${i}`,
  }));

describe('poleIsUseful', () => {
  it('stays away from a thread you can nearly see', () => {
    expect(poleIsUseful(geo(1600), 10)).toBe(false);
    expect(poleIsUseful(geo(3000), 10)).toBe(false);
  });

  it('appears once the scrollbar thumb has become a nub', () => {
    expect(poleIsUseful(geo(3200), 10)).toBe(true);
  });

  /*
   * Both conditions matter: a long scroll with nowhere to jump to is a pole with
   * nothing on it, and a busy thread that fits on two screens needs no jumping.
   */
  it('needs somewhere to jump to as well as a long way to scroll', () => {
    expect(poleIsUseful(geo(20000), 2)).toBe(false);
    expect(poleIsUseful(geo(20000), 4)).toBe(true);
  });

  it('says no rather than dividing by zero on an unmeasured pane', () => {
    expect(poleIsUseful(geo(20000, 0), 40)).toBe(false);
  });
});

describe('poleDots', () => {
  it('draws nothing when the pole is not useful', () => {
    expect(poleDots(geo(1000), turns(10))).toEqual([]);
  });

  it('never draws more than four', () => {
    expect(poleDots(geo(40000), turns(60, 39000)).length).toBe(POLE_MAX_DOTS);
  });

  it('keeps them in reading order, top to bottom', () => {
    const dots = poleDots(geo(40000), turns(60, 39000));
    expect(dots.map((d) => d.offsetTop)).toEqual(
      [...dots.map((d) => d.offsetTop)].sort((a, b) => a - b),
    );
  });

  /*
   * The reason for choosing by POSITION and not by turn index: one enormous
   * answer in the middle must not leave three dots stacked at the top.
   */
  it('spreads across the scroll even when the turns are lopsided', () => {
    const lopsided = [
      { id: 'a', offsetTop: 0, text: 'first' },
      { id: 'b', offsetTop: 40, text: 'second' },
      { id: 'c', offsetTop: 80, text: 'third' },
      { id: 'd', offsetTop: 12_000, text: 'after the huge answer' },
      { id: 'e', offsetTop: 24_000, text: 'later still' },
      { id: 'f', offsetTop: 36_000, text: 'last' },
    ];
    const dots = poleDots(geo(40000), lopsided);
    const gaps = dots.slice(1).map((d, i) => d.fraction - (dots[i]?.fraction ?? 0));
    expect(Math.max(...gaps)).toBeLessThan(0.5);
  });

  it('never stacks two dots on the same turn', () => {
    const dots = poleDots(geo(40000), turns(4, 39000));
    expect(new Set(dots.map((d) => d.id)).size).toBe(dots.length);
  });

  it('carries the preview text and where you are in the thread', () => {
    const [first] = poleDots(geo(40000), turns(20, 39000));
    expect(first?.label).toMatch(/^question number \d+$/);
    expect(first?.total).toBe(20);
    expect(first?.ordinal).toBeGreaterThan(0);
  });

  it('keeps every fraction on the pole', () => {
    for (const d of poleDots(geo(40000), turns(30, 39000))) {
      expect(d.fraction).toBeGreaterThanOrEqual(0);
      expect(d.fraction).toBeLessThanOrEqual(1);
    }
  });
});

describe('poleLabel', () => {
  it('flattens the whitespace a pasted message brings with it', () => {
    expect(poleLabel('why   is\n\nthis  slow')).toBe('why is this slow');
  });

  it('cuts at a word, not mid-token', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima';
    const cut = poleLabel(long, 30);
    expect(cut.endsWith('…')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut).not.toMatch(/ …$/);
  });

  it('leaves a short message alone', () => {
    expect(poleLabel('hi')).toBe('hi');
  });
});

describe('scrollTargetFor', () => {
  it('maps the ends of the pole to the ends of the thread', () => {
    expect(scrollTargetFor(geo(4000), 0)).toBe(0);
    expect(scrollTargetFor(geo(4000), 1)).toBe(3200);
  });

  it('clamps a click that lands off the end', () => {
    expect(scrollTargetFor(geo(4000), -0.4)).toBe(0);
    expect(scrollTargetFor(geo(4000), 1.4)).toBe(3200);
  });

  it('cannot scroll a pane that does not overflow', () => {
    expect(scrollTargetFor(geo(500), 1)).toBe(0);
  });
});

describe('easeInOutCubic', () => {
  it('starts still, ends still, and passes through the middle', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5);
  });

  it('is slower at the ends than in the middle', () => {
    const early = easeInOutCubic(0.1) - easeInOutCubic(0);
    const middle = easeInOutCubic(0.55) - easeInOutCubic(0.45);
    expect(middle).toBeGreaterThan(early);
  });
});
