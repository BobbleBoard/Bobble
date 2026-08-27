/**
 * b14: what a screen reader hears while the model works.
 *
 * The whole run was silent to assistive tech. The rule that matters is STAGE
 * TRANSITIONS ONLY: a live region fed by streaming tokens talks over itself
 * continuously, and the first thing anyone does with one is switch it off.
 */
import { describe, expect, it } from 'vitest';
import { announcementFor, stageOf } from './StageAnnouncer';

const base = {
  isCompacting: false,
  isStreaming: false,
  promptInFlight: false,
  hasRunningTool: false,
  isThinking: false,
};

describe('stageOf', () => {
  it('is idle when nothing is happening', () => {
    expect(stageOf(base)).toBe('idle');
  });

  it('names the most specific thing in flight', () => {
    expect(stageOf({ ...base, isStreaming: true })).toBe('working');
    expect(stageOf({ ...base, isStreaming: true, isThinking: true })).toBe('thinking');
    expect(stageOf({ ...base, isStreaming: true, isThinking: true, hasRunningTool: true })).toBe(
      'tool',
    );
  });

  it('puts compaction above everything — it is what the app is doing', () => {
    expect(stageOf({ ...base, isCompacting: true, isStreaming: true, hasRunningTool: true })).toBe(
      'compacting',
    );
  });

  it('counts a dispatched-but-not-yet-streaming turn as working', () => {
    expect(stageOf({ ...base, promptInFlight: true })).toBe('working');
  });
});

describe('announcementFor', () => {
  it('has a sentence for every stage worth naming', () => {
    for (const stage of ['working', 'thinking', 'tool', 'compacting', 'done'] as const) {
      expect(announcementFor(stage)).toBeTruthy();
    }
  });

  it('says nothing for idle — the resting state is not news', () => {
    // Otherwise the end of every turn is two utterances instead of one.
    expect(announcementFor('idle')).toBeNull();
  });

  it('never carries content — that is the whole rule', () => {
    for (const stage of ['working', 'thinking', 'tool', 'compacting', 'done'] as const) {
      const text = announcementFor(stage) ?? '';
      expect(text.length).toBeLessThan(40);
      expect(text).not.toMatch(/[{}<>]/);
    }
  });
});
