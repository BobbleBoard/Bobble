import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepLiveFrame, liveFrameFor } from './diagram-handover';

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
