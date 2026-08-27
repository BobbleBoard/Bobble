/**
 * b9: a harness warning must reach the user.
 *
 * The event router passed only `error` through, so every warning the harness
 * raises — a model too small for the work it just reached for, a failed verify,
 * a loop-guard steer — was dropped before it could be seen. `info` stays
 * dropped: the app fires `/harness set-mode`, `effort` and `preset`
 * programmatically on every settings change, and routing that would inject
 * plumbing rows into ordinary chats.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPiSink, usePiStore } from './pi-slice';

const sink = () => createPiSink();

describe('notify routing', () => {
  beforeEach(() => {
    usePiStore.setState({ messages: [], notifications: [] });
  });

  it('puts a warning in the transcript, not a toast', () => {
    sink().notify('warning', 'Qwen3.5 4B (~4B) is small for generation work.');
    const msgs = usePiStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'notice', level: 'warning' });
    expect(usePiStore.getState().notifications).toHaveLength(0);
  });

  it('collapses an identical warning repeated on the next turn', () => {
    sink().notify('warning', 'same steer');
    sink().notify('warning', 'same steer');
    expect(usePiStore.getState().messages).toHaveLength(1);
  });

  it('keeps a different warning', () => {
    sink().notify('warning', 'first');
    sink().notify('warning', 'second');
    expect(usePiStore.getState().messages).toHaveLength(2);
  });

  it('ignores an empty warning rather than rendering a blank row', () => {
    sink().notify('warning', '   ');
    expect(usePiStore.getState().messages).toHaveLength(0);
  });

  it('leaves errors as toasts — they are not about one turn', () => {
    sink().notify('error', 'the server died');
    expect(usePiStore.getState().messages).toHaveLength(0);
    expect(usePiStore.getState().notifications).toHaveLength(1);
  });
});
