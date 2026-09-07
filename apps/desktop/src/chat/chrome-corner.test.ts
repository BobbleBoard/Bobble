import { describe, expect, it, vi } from 'vitest';
import { trackChromeCorner } from './chrome-corner';

const zone = (right: number) => ({ getBoundingClientRect: () => ({ right }) });

describe('trackChromeCorner', () => {
  it('publishes the corner immediately, before anything resizes', () => {
    const set = vi.fn();
    trackChromeCorner(zone(175), set);
    expect(set).toHaveBeenCalledWith(175);
  });

  /*
   * The whole point: a control added to that corner must move the title on its
   * own. This is the case the hardcoded 124px got wrong.
   */
  it('re-publishes when the corner grows', () => {
    const set = vi.fn();
    let right = 124;
    let fire: () => void = () => {};
    trackChromeCorner({ getBoundingClientRect: () => ({ right }) }, set, (cb) => {
      fire = cb;
      return () => undefined;
    });
    expect(set).toHaveBeenLastCalledWith(124);
    right = 175;
    fire();
    expect(set).toHaveBeenLastCalledWith(175);
  });

  it('hands back the observer teardown', () => {
    const stop = vi.fn();
    trackChromeCorner(zone(10), vi.fn(), () => stop)();
    expect(stop).toHaveBeenCalled();
  });
});
