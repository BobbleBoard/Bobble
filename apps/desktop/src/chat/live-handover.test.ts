import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARRIVAL_MS,
  firstArrival,
  hadLiveChart,
  keepLiveFrame,
  liveFrameFor,
  markLiveChart,
} from './live-handover';

afterEach(() => vi.useRealTimers());

describe('the live frame, handed to the finished card', () => {
  it('gives the finished card its call’s last frame, in its mode, as often as it asks', () => {
    keepLiveFrame('call_1', '<svg>one</svg>', 'light');
    keepLiveFrame('call_1', '<svg>two</svg>', 'light');
    expect(liveFrameFor('call_1', 'light')).toBe('<svg>two</svg>');
    // A second mount (React's double render, a chat switched back to) gets it too.
    expect(liveFrameFor('call_1', 'light')).toBe('<svg>two</svg>');
    // Another theme's drawing is not a frame to move on from.
    expect(liveFrameFor('call_1', 'dark')).toBeNull();
    expect(liveFrameFor('other', 'light')).toBeNull();
    expect(liveFrameFor(null, 'light')).toBeNull();
  });

  it('forgets a frame after a minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
    keepLiveFrame('call_2', '<svg/>', 'dark');
    vi.setSystemTime(new Date('2026-09-25T10:01:01Z'));
    expect(liveFrameFor('call_2', 'dark')).toBeNull();
  });
});

describe('a card arriving builds itself in, once', () => {
  it('only when it was handed over moments ago, and only the first time it mounts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T11:00:00Z'));
    const now = Date.now();
    expect(firstArrival('card-a', now - 500)).toBe(true);
    // The same mount asking again straight away (React's double render) still is.
    expect(firstArrival('card-a', now - 500)).toBe(true);
    vi.setSystemTime(new Date('2026-09-25T11:00:01Z'));
    // Mounted again later (a chat switched back to): simply there.
    expect(firstArrival('card-a', now - 500)).toBe(false);
    // Too long ago, or brought back from a transcript (no time): no build.
    expect(firstArrival('card-b', Date.now() - ARRIVAL_MS - 1)).toBe(false);
    expect(firstArrival('card-c', undefined)).toBe(false);
  });
});

describe('the live chart, handed to the finished card', () => {
  it('says a call’s chart was already drawn live, for a minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
    expect(hadLiveChart('chart_1')).toBe(false);
    markLiveChart('chart_1');
    expect(hadLiveChart('chart_1')).toBe(true);
    expect(hadLiveChart(null)).toBe(false);
    vi.setSystemTime(new Date('2026-09-25T10:01:01Z'));
    expect(hadLiveChart('chart_1')).toBe(false);
  });
});
