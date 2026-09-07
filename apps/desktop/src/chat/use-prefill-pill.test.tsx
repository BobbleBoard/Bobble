// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePillStore } from './pill-store';
import { PREFILL_PILL_DELAY_MS, usePrefillPill } from './use-prefill-pill';

/**
 * the user's rule for the whole latency effort is "when I don't see anything I get
 * an instant response". These pin the two halves of the only window that was
 * silent: it stays silent while a prime is quick (the common case, on every
 * window return), and it speaks once the prime is long enough that pressing
 * enter into it would cost you something.
 */
function Harness({ inFlight }: { inFlight: boolean }) {
  usePrefillPill(inFlight);
  return null;
}

const pills = () => usePillStore.getState().pills.map((p) => p.id);

describe('usePrefillPill', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    usePillStore.setState({ pills: [] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const render = (inFlight: boolean) =>
    act(() => {
      root.render(<Harness inFlight={inFlight} />);
    });

  it('says nothing about a prime that finishes quickly', () => {
    render(true);
    act(() => {
      vi.advanceTimersByTime(PREFILL_PILL_DELAY_MS - 50);
    });
    expect(pills()).toEqual([]);
    render(false);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(pills()).toEqual([]);
  });

  it('speaks up once the wait is long enough to feel', () => {
    render(true);
    act(() => {
      vi.advanceTimersByTime(PREFILL_PILL_DELAY_MS + 10);
    });
    expect(pills()).toEqual(['prefill-in-flight']);
  });

  it('takes it back the moment the prime lands', () => {
    render(true);
    act(() => {
      vi.advanceTimersByTime(PREFILL_PILL_DELAY_MS + 10);
    });
    expect(pills()).toEqual(['prefill-in-flight']);
    render(false);
    expect(pills()).toEqual([]);
  });

  it('leaves nothing behind when it unmounts mid-prime', () => {
    render(true);
    act(() => {
      vi.advanceTimersByTime(PREFILL_PILL_DELAY_MS + 10);
    });
    act(() => root.unmount());
    expect(pills()).toEqual([]);
    root = createRoot(host);
  });
});
