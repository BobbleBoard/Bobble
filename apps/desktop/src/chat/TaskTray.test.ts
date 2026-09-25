/**
 * What a task-tray row SAYS after its state word — one thing, and the useful
 * one: how long it has been going, why it failed, or when it ended.
 */
import { describe, expect, it } from 'vitest';
import type { TrayTask } from '../state/task-tray';
import { agoText, detailText } from './TaskTray';

const task = (over: Partial<TrayTask>): TrayTask => ({
  key: 'studio:image',
  place: { kind: 'studio', modality: 'image' },
  title: 'A red fox',
  state: 'running',
  startedAt: 0,
  ...over,
});

describe('a row’s detail', () => {
  it('is the running time while it runs, without a zero unit', () => {
    expect(detailText(task({ startedAt: 0 }), 88_000)).toBe('1m 28s');
    expect(detailText(task({ startedAt: 0 }), 120_000)).toBe('2m');
  });

  it('is WHY for a failure — the part you can act on — and when, without a reason', () => {
    expect(
      detailText(task({ state: 'failed', endedAt: 0, error: 'Not enough free memory' }), 5_000),
    ).toBe('Not enough free memory');
    expect(detailText(task({ state: 'failed', endedAt: 0 }), 5 * 60_000)).toBe('5m ago');
  });

  it('is when it ended for a finished task, and nothing for a question', () => {
    expect(detailText(task({ state: 'done', endedAt: 0 }), 10_000)).toBe('just now');
    expect(detailText(task({ state: 'needs-input' }), 10_000)).toBe('');
  });
});

describe('agoText', () => {
  it('reads like a person would say it', () => {
    expect(agoText(20_000)).toBe('just now');
    expect(agoText(60_000)).toBe('1m ago');
    expect(agoText(59 * 60_000)).toBe('59m ago');
    expect(agoText(3 * 3_600_000)).toBe('3h ago');
    expect(agoText(2 * 86_400_000)).toBe('2d ago');
  });
});
