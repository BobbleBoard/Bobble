import { describe, expect, it } from 'vitest';
import {
  type ActivityStepData,
  activitySummary,
  formatDuration,
  summarizeActivity,
} from './activity-chain.tsx';

describe('summarizeActivity', () => {
  it('renders a single step in past tense', () => {
    expect(summarizeActivity([{ kind: 'bash', label: 'x' }])).toBe('Ran a command');
  });

  it('joins distinct kinds, lower-casing all but the first', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a' },
      { kind: 'read', label: 'b' },
    ];
    expect(summarizeActivity(steps)).toBe('Ran a command, read a file');
  });

  it('aggregates same-kind steps across the whole chain with a count + plural', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a' },
      { kind: 'bash', label: 'b' },
      { kind: 'read', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Ran 2 commands, read a file');
  });

  it('is order-INDEPENDENT — non-consecutive same-kind steps still coalesce', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a' },
      { kind: 'read', label: 'b' },
      { kind: 'bash', label: 'c' },
    ];
    // Not "ran a command, read a file, ran a command" — the whole chain rolls up.
    expect(summarizeActivity(steps)).toBe('Ran 2 commands, read a file');
  });

  it('emits kinds in a fixed canonical order regardless of input order', () => {
    // TWO kinds, because three or more now collapse (below) and the ordering
    // this test exists to pin would no longer be observable.
    const steps: ActivityStepData[] = [
      { kind: 'read', label: 'a' },
      { kind: 'bash', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Ran a command, read a file');
  });

  it('collapses past TWO distinct actions rather than listing them', () => {
    /*
     * the user: "if the message shown on tool call blocks exceeds 2 distinct
     * actions simply collapse it to say 'worked' for <time> rather than list
     * everything out." Two still reads as a sentence; three is a list.
     */
    const three: ActivityStepData[] = [
      { kind: 'read', label: 'a' },
      { kind: 'thinking', label: 'b' },
      { kind: 'bash', label: 'c' },
    ];
    expect(summarizeActivity(three)).toBe('Worked');
    expect(summarizeActivity([...three, { kind: 'bash', label: 'd', durationMs: 90_000 }])).toBe(
      'Worked for 1m 30s',
    );
  });

  it('never says "Worked" when nothing did', () => {
    // A collapse that swallows a wholly failed turn would be the same false
    // completion this project keeps fixing one layer up.
    const allFailed: ActivityStepData[] = [
      { kind: 'read', label: 'a', failed: true },
      { kind: 'thinking', label: 'b', failed: true },
      { kind: 'bash', label: 'c', failed: true },
    ];
    expect(summarizeActivity(allFailed).startsWith('Worked')).toBe(false);
  });

  it('keeps non-countable verbs singular even when repeated', () => {
    const steps: ActivityStepData[] = [
      { kind: 'search', label: 'a' },
      { kind: 'search', label: 'b' },
    ];
    expect(summarizeActivity(steps)).toBe('Searched the web');
  });

  it('handles thinking and canvas verbs', () => {
    const steps: ActivityStepData[] = [
      { kind: 'thinking', label: 't' },
      { kind: 'canvas-open', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Thought, opened the canvas');
  });

  it('pluralizes edits and images', () => {
    const steps: ActivityStepData[] = [
      { kind: 'edit', label: 'a' },
      { kind: 'edit', label: 'b' },
      { kind: 'edit', label: 'c' },
    ];
    expect(summarizeActivity(steps)).toBe('Edited 3 files');
  });

  it('sums thinking durations into the phrase', () => {
    const steps: ActivityStepData[] = [
      { kind: 'thinking', label: 'a', durationMs: 20 * 60_000 },
      { kind: 'thinking', label: 'b', durationMs: 60 * 60_000 },
    ];
    expect(summarizeActivity(steps)).toBe('Thought for 1h 20m');
  });

  it('matches the full-aggregation reference example', () => {
    const steps: ActivityStepData[] = [
      ...Array.from({ length: 10 }, (_, i): ActivityStepData => ({ kind: 'bash', label: `c${i}` })),
      { kind: 'thinking', label: 't', durationMs: 80 * 60_000 },
      ...Array.from({ length: 3 }, (_, i): ActivityStepData => ({ kind: 'read', label: `r${i}` })),
    ];
    expect(summarizeActivity(steps)).toBe('Worked for 1h 20m');
  });

  it('returns an empty string for no steps', () => {
    expect(summarizeActivity([])).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats hours + minutes', () => {
    expect(formatDuration(80 * 60_000)).toBe('1h 20m');
  });
  it('drops to minutes + seconds under an hour', () => {
    expect(formatDuration(90_000)).toBe('1m 30s');
  });
  it('drops to seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  /* the user: "'worked for ah nm rs' please. no 0s." */
  it('keeps the seconds on a long duration instead of truncating them', () => {
    expect(formatDuration(3600_000 + 20 * 60_000 + 5_000)).toBe('1h 20m 5s');
  });

  it('OMITS any zero component rather than printing it', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_600_000 + 5_000)).toBe('1h 5s');
    expect(formatDuration(120_000)).toBe('2m');
  });

  it('returns an empty string for zero — there is no useful "0s"', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(400)).toBe('');
  });

  it('never leaves a caller with a dangling phrase', () => {
    // The reason the empty string is safe: callers test the FORMATTED value.
    expect(summarizeActivity([{ kind: 'thinking', label: 't', durationMs: 400 }])).toBe('Thought');
    expect(
      summarizeActivity([
        { kind: 'read', label: 'a' },
        { kind: 'thinking', label: 'b' },
        { kind: 'bash', label: 'c' },
      ]),
    ).toBe('Worked');
  });
});

describe('activitySummary', () => {
  it('reads present-tense while a step is still running', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a', status: 'done' },
      { kind: 'edit', label: 'b', status: 'running' },
    ];
    expect(activitySummary(steps)).toBe('Editing a file');
  });

  it('describes the LAST running step when several run', () => {
    const steps: ActivityStepData[] = [
      { kind: 'read', label: 'a', status: 'running' },
      { kind: 'search', label: 'b', status: 'running' },
    ];
    expect(activitySummary(steps)).toBe('Searching the web');
  });

  it('flips to the past-tense roll-up once every step is done', () => {
    const steps: ActivityStepData[] = [
      { kind: 'bash', label: 'a', status: 'done' },
      { kind: 'edit', label: 'b', status: 'done' },
    ];
    expect(activitySummary(steps)).toBe('Ran a command, edited a file');
  });

  it('treats a step with no explicit status as done', () => {
    expect(activitySummary([{ kind: 'bash', label: 'a' }])).toBe('Ran a command');
  });

  it('falls back to "Working…" with no steps', () => {
    expect(activitySummary([])).toBe('Working…');
  });
});

describe('a rejected call is not work done', () => {
  const step = (kind: ActivityStepData['kind'], failed?: boolean): ActivityStepData =>
    ({ kind, label: '', ...(failed === undefined ? {} : { failed }) }) as ActivityStepData;

  /*
   * RUN G, verbatim. Six `edit` calls, every one rejected on an oldText
   * mismatch, the file left byte-identical to the fixture — and the collapsed
   * thread read "Ran a command, thought for 15s, edited 6 files, read 9 files".
   * The count was true; "edited" was the lie.
   */
  it('does not claim edits that were all rejected', () => {
    const summary = summarizeActivity([
      step('bash'),
      ...Array.from({ length: 6 }, () => step('edit', true)),
      ...Array.from({ length: 9 }, () => step('read')),
    ]);
    /*
     * Three distinct kinds now collapse to "Worked for <time>" (the user), so the
     * itemisation is gone — but the property this test exists for holds, and is
     * what is asserted: the summary must never CLAIM the rejected edits. The
     * failures are not hidden, they are red on their own rows with the real
     * error, which is where you can act on one.
     */
    expect(summary).not.toContain('edited 6 files');
    expect(summary).not.toContain('6 files');
    expect(summary.startsWith('Worked')).toBe(true);
  });

  it('reports a partial failure as both, never rounded up', () => {
    // NO "(N failed)" TAIL any more (the user) — but the count still excludes the
    // rejected call, so the line remains true rather than rounded up.
    const summary = summarizeActivity([step('edit'), step('edit'), step('edit', true)]);
    expect(summary).toBe('Edited 2 files');
  });

  it('says "1 edit failed" for a single rejected call', () => {
    expect(summarizeActivity([step('edit', true)])).toBe('1 edit failed');
  });

  /* The verbs are irregular — stemming "Ran"/"Read" produced "ran"/"rea". */
  it('names the attempt for irregular verbs', () => {
    expect(summarizeActivity([step('bash', true), step('bash', true)])).toBe('2 commands failed');
    expect(summarizeActivity([step('read', true)])).toBe('1 read failed');
  });

  it('is unchanged when nothing failed', () => {
    expect(summarizeActivity([step('edit'), step('edit')])).toBe('Edited 2 files');
  });
});
