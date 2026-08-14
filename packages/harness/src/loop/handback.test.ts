import { describe, expect, it } from 'vitest';
import { HANDBACK_NUDGE, isChoiceHandback } from './handback.js';

/* Run 3's actual ending, verbatim — the case this exists for. */
const RUN3 = `## Status Summary: LocalConvert Build Progress

### Not Yet Built
1. Batch Processing
2. Installer/App Bundle

Would you like me to proceed with:

- **A)** Build the batch processing module now
- **B)** Build the app installer and bundle directly
- **C)** Build both in sequence

Which would you prefer?`;

describe('isChoiceHandback', () => {
  it('catches the run that produced it', () => {
    expect(isChoiceHandback(RUN3)).toBe(true);
  });

  it('catches a numbered menu just the same', () => {
    expect(
      isChoiceHandback('Two ways forward:\n1. Fix the tests\n2. Ship as is\n\nShall I pick one?'),
    ).toBe(true);
  });

  /*
   * NARROW ON PURPOSE. Each of these ends a turn perfectly legitimately, and a
   * nudge would be an interruption — the failure mode of a guard that fires too
   * eagerly is worse than the one it prevents.
   */
  it('leaves a finished report alone', () => {
    expect(isChoiceHandback('Done. The app builds and converts a PNG to JPG.')).toBe(false);
  });

  it('leaves a question with no options alone — that is a real question', () => {
    expect(isChoiceHandback('I cannot find the signing key. Do you want me to skip signing?')).toBe(
      false,
    );
  });

  it('leaves a list with no closing question alone', () => {
    expect(
      isChoiceHandback('Remaining:\n- A) batch mode\n- B) installer\n\nStarting on A now.'),
    ).toBe(false);
  });

  it('leaves a question that is not asking the reader to choose alone', () => {
    expect(isChoiceHandback('- A) x\n- B) y\n\nWhy did the build fail?')).toBe(false);
  });

  it('ignores a menu buried far above the ending', () => {
    const buried = `- A) one\n- B) two\n${'\nprose'.repeat(20)}\n\nAll three formats convert.`;
    expect(isChoiceHandback(buried)).toBe(false);
  });

  it('handles an empty or whitespace reply without throwing', () => {
    expect(isChoiceHandback('')).toBe(false);
    expect(isChoiceHandback('   \n\n ')).toBe(false);
  });
});

describe('HANDBACK_NUDGE', () => {
  it('tells it to choose, say which, and continue', () => {
    expect(HANDBACK_NUDGE).toMatch(/Pick the option/);
    expect(HANDBACK_NUDGE).toMatch(/say .*which you picked/);
    expect(HANDBACK_NUDGE).toMatch(/carry on/);
  });

  /*
   * THE ESCAPE HATCH HAS TO BE NAMED. Without it this reads as "never ask", which
   * would push a genuinely blocked model into guessing. `ask_user` is the
   * mechanism that exists for the real case — the distinction this whole module
   * draws is tool versus prose, not question versus no question.
   */
  it('points a genuinely blocked model at ask_user', () => {
    expect(HANDBACK_NUDGE).toContain('ask_user');
    expect(HANDBACK_NUDGE).toMatch(/genuinely blocked/);
  });

  /* Short enough that a 4B reads all of it. */
  it('stays brief', () => {
    expect(HANDBACK_NUDGE.split(/\s+/).length).toBeLessThan(70);
  });
});
