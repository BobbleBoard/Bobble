/**
 * The sidebar's "a background chat finished" rule (bg-run-watch.ts). The case
 * that matters is the one review wave-0923 found (delete #10): a run that ends
 * WITHOUT a finish — its chat was deleted, or it was brought back on screen —
 * must not leave its start time behind for the next background run, whose
 * "It finished while you were away" would then ignore the duration floor.
 */
import { describe, expect, it } from 'vitest';
import { BG_RUN_IDLE, type BgRunWatch, watchBgRun } from './bg-run-watch';

const run = (sessionFile: string, streaming: boolean) => ({ sessionFile, streaming, title: null });
const none = (): boolean => false;
const MIN = 60_000;

function look(
  watch: BgRunWatch,
  bgRun: ReturnType<typeof run> | null,
  now: number,
  deleted: (file: string) => boolean = none,
) {
  return watchBgRun(watch, bgRun, now, deleted);
}

describe('watchBgRun', () => {
  it('a background run that finishes reports how long it ran', () => {
    let w = look(BG_RUN_IDLE, run('/s/A.jsonl', true), 0).watch;
    const end = look(w, run('/s/A.jsonl', false), 5 * MIN);
    expect(end.finished).toEqual({ sessionFile: '/s/A.jsonl', title: null, ranFor: 5 * MIN });
    w = end.watch;
    expect(w.startedAt).toBeNull();
  });

  it('a deleted chat’s run ends without a finish — and takes its start time with it', () => {
    const gone = (f: string): boolean => f === '/s/A.jsonl';
    let w = look(BG_RUN_IDLE, run('/s/A.jsonl', true), 0, gone).watch;
    const end = look(w, run('/s/A.jsonl', false), 10 * MIN, gone);
    expect(end.finished).toBeNull();
    w = end.watch;

    // The next background run is three seconds long.
    w = look(w, run('/s/B.jsonl', true), 30 * MIN).watch;
    const next = look(w, run('/s/B.jsonl', false), 30 * MIN + 3_000);
    expect(next.finished?.ranFor).toBe(3_000);
  });

  it('a run brought back on screen mid-stream takes its start time with it too', () => {
    let w = look(BG_RUN_IDLE, run('/s/A.jsonl', true), 0).watch;
    // Opening A while it streams swaps it back into the view: no background run.
    w = look(w, null, 10 * MIN).watch;

    w = look(w, run('/s/B.jsonl', true), 30 * MIN).watch;
    const next = look(w, run('/s/B.jsonl', false), 30 * MIN + 3_000);
    expect(next.finished?.ranFor).toBe(3_000);
  });
});
