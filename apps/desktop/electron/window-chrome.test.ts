/**
 * The alignment arithmetic, pinned.
 *
 * These are the numbers two processes agree on by importing the same module —
 * but the module still encodes one assumption nothing can check at runtime
 * (AppKit's 12pt buttons on a 20pt pitch), and one intent that is easy to break
 * by nudging a constant (the cluster is centred in the top bar). Both are worth
 * a test, because the failure they prevent is a control creeping under the zoom
 * button on someone else's machine.
 */
import { describe, expect, it } from 'vitest';
import {
  CHROME_LEFT,
  TOP_BAR_HEIGHT,
  TRAFFIC_LIGHT_BUTTON,
  TRAFFIC_LIGHT_CENTRE_Y,
  TRAFFIC_LIGHT_CLUSTER_WIDTH,
  TRAFFIC_LIGHT_GUTTER,
  TRAFFIC_LIGHTS,
  TRAFFIC_LIGHTS_RIGHT,
} from './window-chrome';

describe('window chrome geometry', () => {
  it('centres the traffic lights in the top bar', () => {
    // The whole point of the `y`: cluster centre === bar centre.
    expect(TRAFFIC_LIGHT_CENTRE_Y).toBeCloseTo(TOP_BAR_HEIGHT / 2, 0);
  });

  it('spans three buttons on a 20pt pitch', () => {
    expect(TRAFFIC_LIGHT_CLUSTER_WIDTH).toBe(52);
    expect(TRAFFIC_LIGHTS_RIGHT).toBe(TRAFFIC_LIGHTS.x + 52);
  });

  it('leaves the renderer clear of the last light', () => {
    expect(CHROME_LEFT).toBe(TRAFFIC_LIGHTS_RIGHT + TRAFFIC_LIGHT_GUTTER);
    // A 32px control centred on CHROME_LEFT + 16 must not reach back over the
    // zoom button — the overlap the user asked to fix.
    expect(CHROME_LEFT).toBeGreaterThan(TRAFFIC_LIGHTS_RIGHT + TRAFFIC_LIGHT_BUTTON / 2);
  });
});
