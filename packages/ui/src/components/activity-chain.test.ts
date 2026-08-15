import { describe, expect, it } from 'vitest';
import {
  type ActivityStepData,
  activitySummary,
  chainIsDone,
  formatDuration,
  hasInlineContent,
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

describe('a prefilling turn is not a settled one', () => {
  /*
   * the user, watching a run sit silent: "we can't see what the model is doing right
   * now at this moment… we need to have an idea of what's going on at all times."
   *
   * The chain's "Done" is inferred from quiet, and a long prompt ingest is quiet:
   * no step running, no tokens. So the marker appeared over a working model. The
   * prefill row both explains the gap AND blocks the false completion — these are
   * the same bug seen from two sides, which is why one prop does both.
   */
  it('keeps the collapse summary honest while nothing has run yet', () => {
    // No steps + no work done: the summary must not claim any.
    expect(summarizeActivity([])).toBe('');
  });

  it('still reports real work once steps exist', () => {
    expect(summarizeActivity([{ kind: 'bash', label: 'x' }])).toBe('Ran a command');
  });
});

/**
 * EVERY TOOL ROW OPENS TO SOMETHING.
 *
 * the user: "find out all tool calls that are not able to be clicked on for an
 * expansion." Two separate ways a row went dead, and both are pinned here:
 *
 *   1. kinds that fell through to `default: return false` — browser
 *      navigate/click/type, and the media kinds with no canvas destination;
 *   2. kinds that COULD expand but only when an optional field happened to be
 *      present, so they were silently unexpandable in practice: a read whose
 *      tool returned nothing, an edit reporting counts before any diff exists,
 *      a search that came back empty carrying the note explaining why.
 *
 * The negative cases matter as much: a row with NOTHING to say must stay
 * unclickable rather than open onto an empty box.
 */
describe('hasInlineContent — no tool row is a dead end', () => {
  describe('kinds that used to fall through to default: false', () => {
    it('opens a navigate row on its URL', () => {
      expect(
        hasInlineContent({ kind: 'browser-navigate', label: 'Visited', url: 'https://a.dev' }),
      ).toBe(true);
      // The mapping fills `detail` from the same value; either alone suffices.
      expect(
        hasInlineContent({ kind: 'browser-navigate', label: 'Visited', detail: 'https://a.dev' }),
      ).toBe(true);
    });

    it('opens a click row on its target', () => {
      expect(hasInlineContent({ kind: 'browser-click', label: 'Clicked', target: '#submit' })).toBe(
        true,
      );
    });

    it('opens a type row on the text that was typed', () => {
      expect(hasInlineContent({ kind: 'browser-type', label: 'Typed', typed: 'hello' })).toBe(true);
    });

    it('opens a title/status-only navigate row', () => {
      expect(hasInlineContent({ kind: 'browser-navigate', label: 'Visited', title: 'Home' })).toBe(
        true,
      );
      expect(
        hasInlineContent({ kind: 'browser-navigate', label: 'Visited', pageStatus: '404' }),
      ).toBe(true);
    });

    it('leaves a browser row with nothing at all unclickable', () => {
      expect(hasInlineContent({ kind: 'browser-click', label: 'Clicked' })).toBe(false);
    });

    for (const kind of ['image', 'pdf', 'canvas-open'] as const) {
      it(`names a ${kind} that has no canvas destination`, () => {
        expect(hasInlineContent({ kind, label: 'x', src: '/out/a.png' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x', filename: 'a.png' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x', detail: '/out/a.png' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x' })).toBe(false);
      });

      it(`still routes a ${kind} to the canvas when it has one`, () => {
        // opensInCanvas outranks everything: that row is a canvas button, not a
        // disclosure, and giving it both would be two answers to one click.
        expect(hasInlineContent({ kind, label: 'x', src: '/out/a.png', opensInCanvas: true })).toBe(
          false,
        );
      });
    }
  });

  describe('kinds that expanded only when an optional field turned up', () => {
    for (const kind of ['read', 'file', 'skill', 'folder'] as const) {
      it(`opens a ${kind} with a path but no preview`, () => {
        expect(hasInlineContent({ kind, label: 'x', detail: '/w/app.ts' })).toBe(true);
      });

      it(`leaves a ${kind} with neither path nor preview unclickable`, () => {
        expect(hasInlineContent({ kind, label: 'x' })).toBe(false);
      });
    }

    it('opens a read on its preview alone, as it always did', () => {
      expect(hasInlineContent({ kind: 'read', label: 'x', preview: 'body' })).toBe(true);
    });

    it('opens an edit that has counts but no diff yet', () => {
      // The streaming case: `added` is derived from partial JSON long before any
      // diff exists, so the row showed a ±stat it could not explain.
      expect(hasInlineContent({ kind: 'edit', label: 'x', added: 12, deleted: 0 })).toBe(true);
      expect(hasInlineContent({ kind: 'edit', label: 'x', detail: '/w/app.ts' })).toBe(true);
      // An EMPTY diff array is not content — that was the old bug's other half.
      expect(hasInlineContent({ kind: 'edit', label: 'x', diff: [] })).toBe(false);
      expect(hasInlineContent({ kind: 'edit', label: 'x' })).toBe(false);
    });

    it('opens a search that returned nothing but explained why', () => {
      expect(hasInlineContent({ kind: 'search', label: 'x', note: 'rate limited' })).toBe(true);
      expect(hasInlineContent({ kind: 'search', label: 'x', query: 'tokyo' })).toBe(true);
      expect(hasInlineContent({ kind: 'search', label: 'x', results: [] })).toBe(true);
      expect(hasInlineContent({ kind: 'search', label: 'x' })).toBe(false);
    });

    it('opens a browser-read on its URL when the page text is missing', () => {
      expect(hasInlineContent({ kind: 'browser-read', label: 'x', detail: 'https://a.dev' })).toBe(
        true,
      );
    });
  });

  /*
   * The fallbacks all assert an ABSENCE ("returned no content", "no diff was
   * captured", "no canvas target"). Every one of those is false while the call
   * is still in flight, so they wait for the step to settle — real content still
   * opens a running row, and so do the browser rows, whose values are arguments
   * rather than results.
   */
  describe('an in-flight step has not returned nothing — it has not returned yet', () => {
    it('withholds the empty-read reveal until the read finishes', () => {
      const running: ActivityStepData = {
        kind: 'read',
        label: 'Reading a file',
        detail: '/w/app.ts',
        status: 'running',
      };
      expect(hasInlineContent(running)).toBe(false);
      expect(hasInlineContent({ ...running, status: 'done' })).toBe(true);
      // Real content still opens a running row — only the absence-note waits.
      expect(hasInlineContent({ ...running, preview: 'body' })).toBe(true);
    });

    it('withholds the diffless-edit reveal while the write is still streaming', () => {
      expect(hasInlineContent({ kind: 'edit', label: 'x', added: 4, status: 'running' })).toBe(
        false,
      );
      expect(hasInlineContent({ kind: 'edit', label: 'x', added: 4, status: 'done' })).toBe(true);
    });

    it('withholds the no-canvas-target reveal while the media is still generating', () => {
      expect(
        hasInlineContent({ kind: 'image', label: 'x', src: '/a.png', status: 'running' }),
      ).toBe(false);
    });

    it('still opens a running browser row — its args are known at call time', () => {
      expect(
        hasInlineContent({ kind: 'browser-type', label: 'x', typed: 'hi', status: 'running' }),
      ).toBe(true);
    });
  });

  describe('kinds that already behaved — unchanged', () => {
    it('thinking opens on its thought', () => {
      expect(hasInlineContent({ kind: 'thinking', label: 'x', thought: 'hm' })).toBe(true);
      expect(hasInlineContent({ kind: 'thinking', label: 'x' })).toBe(false);
    });

    for (const kind of ['bash', 'python'] as const) {
      it(`${kind} opens on its command or output`, () => {
        expect(hasInlineContent({ kind, label: 'x', command: 'ls' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x', output: 'ok' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x' })).toBe(false);
      });
    }

    for (const kind of ['tool', 'tool-search', 'connector'] as const) {
      it(`${kind} still opens on its RESULT only, never raw args`, () => {
        // the user's earlier call: no schema-noise reveal for generic tool rows.
        // Left deliberately untouched — args alone must not open an empty box.
        expect(hasInlineContent({ kind, label: 'x', output: 'done' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x', argsText: '{"a":1}' })).toBe(false);
      });
    }

    for (const kind of [
      'talk',
      'manager',
      'commission',
      'delegate',
      'toolkit',
      'submit',
    ] as const) {
      it(`${kind} opens on the brief or the reply`, () => {
        expect(hasInlineContent({ kind, label: 'x', argsText: '{"message":"go"}' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x', output: 'ok' })).toBe(true);
        expect(hasInlineContent({ kind, label: 'x' })).toBe(false);
      });
    }
  });
});

/*
 * THE PREMATURE-DONE RULE, finally locked down.
 *
 * the user reported this three times — "why is there green here… premature done",
 * "the premature done just needs to be fixed now though… it doesn't say done
 * until it's truly totally done", "done is a final thing. This tool chain is
 * DONE." Each fix was a one-line change to an expression inside a 200-line
 * component, with nothing asserting the rule afterwards, so the next change to
 * the surrounding code could quietly undo it. This is the debt paid.
 */
describe('chainIsDone — when a tool chain may say Done', () => {
  it('does NOT print Done in the gap between two tool calls', () => {
    // The failing case: nothing running this instant, but the TURN is not over.
    // `!running && !active` goes true in every gap, which is what made Done flap.
    expect(chainIsDone({ complete: false, quiet: true, settledGuess: true })).toBe(false);
  });

  it('prints Done only when the turn OWNER says the turn is complete', () => {
    expect(chainIsDone({ complete: true, quiet: true, settledGuess: false })).toBe(true);
  });

  it('does not print Done while rows are still rendering, even once complete', () => {
    expect(chainIsDone({ complete: true, quiet: false, settledGuess: true })).toBe(false);
  });

  it('falls back to the quiet guess for a historical chain with no owner', () => {
    // Static renders and replayed transcripts are already over; there is nobody
    // left to answer `complete`, so quiet is the best available signal.
    expect(chainIsDone({ quiet: true, settledGuess: true })).toBe(true);
    expect(chainIsDone({ quiet: true, settledGuess: false })).toBe(false);
  });

  it('lets `complete` OVERRIDE the guess in both directions', () => {
    // The guess must never be able to promote a live turn to Done…
    expect(chainIsDone({ complete: false, quiet: true, settledGuess: true })).toBe(false);
    // …nor hold back a turn its owner has declared finished.
    expect(chainIsDone({ complete: true, quiet: true, settledGuess: false })).toBe(true);
  });
});
