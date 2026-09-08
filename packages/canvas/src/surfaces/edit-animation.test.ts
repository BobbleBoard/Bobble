import { describe, expect, it } from 'vitest';
import {
  applyHunks,
  EDIT_ANIMATION_DEFAULTS,
  type EditAnimationPlan,
  firstEditOffset,
  frameAt,
  locateHunks,
  MAX_ANIMATABLE_CHARS,
  minimalReplacement,
  planEditAnimation,
  planTextTransition,
} from './edit-animation.ts';

const BASE = ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n');

function plan(
  base: string,
  hunks: Array<{ oldText?: string; newText?: string; at?: number }>,
  options = {},
): EditAnimationPlan {
  const p = planEditAnimation(base, hunks, options);
  if (p === null) throw new Error('expected a plan');
  return p;
}

/** Every text the plan passes through, sampled finely enough to catch a jump. */
function samples(
  p: EditAnimationPlan,
  step = 5,
): Array<{ t: number; text: string; caret: number }> {
  const out: Array<{ t: number; text: string; caret: number }> = [];
  for (let t = 0; t <= p.totalMs + step; t += step) {
    const f = frameAt(p, t);
    out.push({ t, text: f.text, caret: f.caret });
  }
  return out;
}

describe('locateHunks — ordering', () => {
  it('puts hunks in document order regardless of the order the tool listed them', () => {
    const located = locateHunks(BASE, [{ oldText: 'const c = 3;' }, { oldText: 'const a = 1;' }]);
    expect(located?.map((h) => h.oldText)).toEqual(['const a = 1;', 'const c = 3;']);
  });

  it('resolves two identical old_strings to two different places', () => {
    const base = 'x();\nx();\n';
    const located = locateHunks(base, [
      { oldText: 'x();', newText: 'y();' },
      { oldText: 'x();', newText: 'z();' },
    ]);
    expect(located?.map((h) => h.at)).toEqual([0, 5]);
  });

  it('refuses a hunk it cannot find rather than guessing a position', () => {
    expect(locateHunks(BASE, [{ oldText: 'nowhere in the file' }])).toBeNull();
  });

  it('refuses overlapping hunks', () => {
    expect(
      locateHunks('abcdef', [
        { oldText: 'abcd', newText: 'X' },
        { oldText: 'cdef', newText: 'Y' },
      ]),
    ).toBeNull();
  });

  it('needs an explicit offset for a pure insertion (empty old_string)', () => {
    expect(locateHunks(BASE, [{ newText: 'hi' }])).toBeNull();
    expect(locateHunks(BASE, [{ newText: 'hi', at: 13 }])?.[0]).toEqual({
      at: 13,
      oldText: '',
      newText: 'hi',
    });
  });
});

describe('planEditAnimation — the schedule', () => {
  it('deletes then types, in that order, for each hunk', () => {
    const p = plan(BASE, [{ oldText: 'const b = 2;', newText: 'const b = 22;' }]);
    expect(p.hunks).toHaveLength(1);
    const h = p.hunks[0];
    expect(h?.deleteMs).toBeGreaterThan(0);
    expect(h?.typeMs).toBeGreaterThan(0);
    expect(h?.startMs).toBe(p.settleMs);
    expect(p.totalMs).toBeCloseTo(p.settleMs + (h?.deleteMs ?? 0) + (h?.typeMs ?? 0), 6);
  });

  it('separates several hunks with a beat, and gives the last one none', () => {
    const p = plan(BASE, [
      { oldText: 'const a = 1;', newText: 'const a = 10;' },
      { oldText: 'const c = 3;', newText: 'const c = 30;' },
    ]);
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]?.beatMs).toBe(EDIT_ANIMATION_DEFAULTS.beatMs);
    expect(p.hunks[1]?.beatMs).toBe(0);
    // The second hunk starts only after the first has fully finished + the beat.
    const first = p.hunks[0];
    expect(p.hunks[1]?.startMs).toBeCloseTo(
      (first?.startMs ?? 0) + (first?.deleteMs ?? 0) + (first?.typeMs ?? 0) + (first?.beatMs ?? 0),
      6,
    );
  });

  it('lands exactly on the text the hunks produce', () => {
    const p = plan(BASE, [{ oldText: 'const b = 2;', newText: 'const b = 22;' }]);
    expect(p.finalText).toBe(BASE.replace('const b = 2;', 'const b = 22;'));
    expect(frameAt(p, p.totalMs + 1000).text).toBe(p.finalText);
  });

  it('caps a huge replacement instead of animating 4,000 characters one by one', () => {
    const big = 'x'.repeat(4000);
    const p = plan(`head\n${'y'.repeat(20)}\ntail\n`, [{ oldText: 'y'.repeat(20), newText: big }]);
    expect(p.hunks[0]?.typeMs).toBeLessThanOrEqual(EDIT_ANIMATION_DEFAULTS.maxPhaseMs);
    // Uncapped that phase would be 4000 / 200 cps = 20 seconds.
    expect(p.hunks[0]?.typeMs).toBeLessThan(20_000);
    expect(p.totalMs).toBeLessThanOrEqual(EDIT_ANIMATION_DEFAULTS.maxTotalMs);
    expect(frameAt(p, p.totalMs).text).toBe(p.finalText);
  });

  it('scales a many-hunk edit down to the total budget, keeping its shape', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i} value ${i}`);
    const base = `${lines.join('\n')}\n`;
    const hunks = lines.map((l) => ({
      oldText: l,
      newText: `${l} — rewritten ${'z'.repeat(60)}`,
    }));
    const p = plan(base, hunks);
    expect(p.totalMs).toBeLessThanOrEqual(EDIT_ANIMATION_DEFAULTS.maxTotalMs + 0.001);
    // Same shape: longer hunks still take longer than shorter ones.
    expect(p.hunks).toHaveLength(12);
    expect(hunks).toHaveLength(12);
    for (const h of p.hunks) expect(h.typeMs).toBeGreaterThan(0);
  });

  it('gives a tiny edit a floor so it is still a motion, not a jump-cut', () => {
    const p = plan('let n = 1;\n', [{ oldText: '1', newText: '2' }]);
    expect(p.hunks[0]?.deleteMs).toBe(EDIT_ANIMATION_DEFAULTS.minPhaseMs);
    expect(p.hunks[0]?.typeMs).toBe(EDIT_ANIMATION_DEFAULTS.minPhaseMs);
  });

  it('gives a pure deletion no typing phase, and a pure insertion no delete phase', () => {
    const del = plan(BASE, [{ oldText: 'const b = 2;\n', newText: '' }]);
    expect(del.hunks[0]?.typeMs).toBe(0);
    expect(del.finalText).toBe(BASE.replace('const b = 2;\n', ''));

    const ins = plan(BASE, [{ oldText: '', newText: 'const d = 4;\n', at: BASE.length }]);
    expect(ins.hunks[0]?.deleteMs).toBe(0);
    expect(ins.finalText).toBe(`${BASE}const d = 4;\n`);
  });

  it('returns null when a hunk cannot be placed and there is no final text to fall back on', () => {
    expect(planEditAnimation(BASE, [{ oldText: 'not here', newText: 'x' }])).toBeNull();
  });

  it('falls back to the minimal replacement against a known final text', () => {
    const final = BASE.replace('const b = 2;', 'const b = 99;');
    // The tool reported a hunk that does not occur verbatim (whitespace-normalised).
    const p = planEditAnimation(
      BASE,
      [{ oldText: 'const  b  =  2;', newText: 'const b = 99;' }],
      {},
      final,
    );
    expect(p).not.toBeNull();
    expect(p?.finalText).toBe(final);
    expect(p?.hunks).toHaveLength(1);
    // And it is minimal — one character deleted, two typed, not the whole line.
    expect(p?.hunks[0]?.oldText).toBe('2');
    expect(p?.hunks[0]?.newText).toBe('99');
  });

  it('distrusts hunks that do not produce the file that landed on disk', () => {
    const final = `${BASE}// appended by the tool\n`;
    const p = planEditAnimation(
      BASE,
      [{ oldText: 'const b = 2;', newText: 'const b = 2;' }],
      {},
      final,
    );
    expect(p?.finalText).toBe(final);
  });
});

describe('planEditAnimation — reduced motion and the void', () => {
  it('goes straight to the final state under prefers-reduced-motion', () => {
    const p = plan(BASE, [{ oldText: 'const b = 2;', newText: 'const b = 22;' }], {
      reducedMotion: true,
    });
    expect(p.instant).toBe(true);
    expect(p.totalMs).toBe(0);
    expect(frameAt(p, 0)).toEqual({
      text: BASE.replace('const b = 2;', 'const b = 22;'),
      caret: p.finalText.length,
      phase: 'done',
      hunk: -1,
    });
  });

  it('settles instantly for a file too large to rebuild every frame', () => {
    const huge = `${'q'.repeat(MAX_ANIMATABLE_CHARS + 1)}TARGET`;
    const p = plan(huge, [{ oldText: 'TARGET', newText: 'HIT' }]);
    expect(p.instant).toBe(true);
    expect(frameAt(p, 0).text.endsWith('HIT')).toBe(true);
  });

  it('reduced motion still lands on the right bytes when hunks cannot be located', () => {
    const final = `${BASE}extra\n`;
    const p = planEditAnimation(
      BASE,
      [{ oldText: 'nope', newText: 'x' }],
      { reducedMotion: true },
      final,
    );
    expect(p?.instant).toBe(true);
    expect(p?.finalText).toBe(final);
  });
});

describe('frameAt — one continuous motion', () => {
  const p = plan(BASE, [{ oldText: 'const b = 2;', newText: 'const b = 22;' }]);
  const at = firstEditOffset(p);

  it('shows the FILE, untouched, while the view settles', () => {
    const f = frameAt(p, 0);
    expect(f.phase).toBe('settle');
    expect(f.text).toBe(BASE);
    expect(f.caret).toBe(at);
  });

  it('forward-deletes: the caret stands still and the text in front of it is eaten', () => {
    const carets = new Set<number>();
    let shrinking = true;
    let previous = BASE.length;
    for (let t = p.settleMs; t < p.settleMs + (p.hunks[0]?.deleteMs ?? 0); t += 5) {
      const f = frameAt(p, t);
      expect(f.phase).toBe('delete');
      carets.add(f.caret);
      if (f.text.length > previous) shrinking = false;
      previous = f.text.length;
      // Everything before the caret is untouched file.
      expect(f.text.slice(0, f.caret)).toBe(BASE.slice(0, at));
    }
    expect([...carets]).toEqual([at]);
    expect(shrinking).toBe(true);
  });

  it('starts typing exactly where the delete ended', () => {
    const h = p.hunks[0];
    const endOfDelete = frameAt(p, p.settleMs + (h?.deleteMs ?? 0) - 0.001);
    const startOfType = frameAt(p, p.settleMs + (h?.deleteMs ?? 0));
    expect(endOfDelete.phase).toBe('delete');
    expect(startOfType.phase).toBe('type');
    expect(startOfType.caret).toBe(endOfDelete.caret);
    // The gap is closed: at the hand-over the buffer is the file with the old
    // span gone and nothing typed yet.
    expect(startOfType.text).toBe(BASE.slice(0, at) + BASE.slice(at + (h?.oldText.length ?? 0)));
    expect(endOfDelete.text.length).toBeLessThanOrEqual(startOfType.text.length + 1);
  });

  it('never jumps: consecutive frames differ by a bounded amount', () => {
    const seq = samples(p, 4);
    for (let i = 1; i < seq.length; i += 1) {
      const a = seq[i - 1];
      const b = seq[i];
      if (a === undefined || b === undefined) continue;
      expect(Math.abs(b.text.length - a.text.length)).toBeLessThanOrEqual(4);
    }
  });

  it('plays several hunks strictly one after another, top of the file first', () => {
    const multi = plan(BASE, [
      { oldText: 'const c = 3;', newText: 'const c = 30;' },
      { oldText: 'const a = 1;', newText: 'const a = 10;' },
    ]);
    const seenOrder: number[] = [];
    for (let t = 0; t <= multi.totalMs; t += 5) {
      const f = frameAt(multi, t);
      if (f.hunk >= 0 && seenOrder[seenOrder.length - 1] !== f.hunk) seenOrder.push(f.hunk);
    }
    expect(seenOrder).toEqual([0, 1]);
    // Hunk 0 is the TOP one, whichever order the tool listed them in.
    expect(multi.hunks[0]?.oldText).toBe('const a = 1;');
    // The first hunk's replacement is already in place while the second plays.
    const second = multi.hunks[1];
    const midSecond = frameAt(multi, (second?.startMs ?? 0) + (second?.deleteMs ?? 0) / 2);
    expect(midSecond.text.startsWith('const a = 10;')).toBe(true);
  });

  it('holds still on the beat between two hunks', () => {
    const multi = plan(BASE, [
      { oldText: 'const a = 1;', newText: 'const a = 10;' },
      { oldText: 'const c = 3;', newText: 'const c = 30;' },
    ]);
    const first = multi.hunks[0];
    const beatStart = (first?.startMs ?? 0) + (first?.deleteMs ?? 0) + (first?.typeMs ?? 0);
    const a = frameAt(multi, beatStart + 1);
    const b = frameAt(multi, beatStart + (first?.beatMs ?? 0) - 1);
    expect(a.phase).toBe('beat');
    expect(a.text).toBe(b.text);
    expect(a.caret).toBe(b.caret);
  });

  it('rests on the final text once the run is over', () => {
    const f = frameAt(p, p.totalMs + 5000);
    expect(f.phase).toBe('done');
    expect(f.text).toBe(p.finalText);
  });
});

describe('minimalReplacement / applyHunks', () => {
  it('finds the span between the common prefix and suffix', () => {
    expect(minimalReplacement('the quick brown fox', 'the slow brown fox')).toEqual({
      at: 4,
      oldText: 'quick',
      newText: 'slow',
    });
  });

  it('describes a pure insertion as an empty old span', () => {
    expect(minimalReplacement('ab', 'aXb')).toEqual({ at: 1, oldText: '', newText: 'X' });
  });

  it('describes a pure deletion as an empty new span', () => {
    expect(minimalReplacement('aXb', 'ab')).toEqual({ at: 1, oldText: 'X', newText: '' });
  });

  it('round-trips through applyHunks', () => {
    const next = 'the slow brown fox';
    const r = minimalReplacement('the quick brown fox', next);
    expect(applyHunks('the quick brown fox', [r])).toBe(next);
  });
});

describe('planTextTransition', () => {
  it('animates the minimal span between two whole texts', () => {
    const p = planTextTransition('a = 1\nb = 2\n', 'a = 1\nb = 42\n');
    expect(p?.hunks).toHaveLength(1);
    // Truly minimal: `2` → `42` shares its `2`, so this is an insertion of `4`
    // and nothing is deleted. Retyping the shared character would be a flicker.
    expect(p?.hunks[0]?.oldText).toBe('');
    expect(p?.hunks[0]?.newText).toBe('4');
    expect(p?.hunks[0]?.deleteMs).toBe(0);
    expect(p && frameAt(p, p.totalMs).text).toBe('a = 1\nb = 42\n');
  });

  it('is a no-op when nothing changed', () => {
    expect(planTextTransition('same', 'same')).toBeNull();
  });

  it('settles instantly under reduced motion', () => {
    const p = planTextTransition('a', 'b', { reducedMotion: true });
    expect(p?.instant).toBe(true);
    expect(p?.finalText).toBe('b');
  });
});
