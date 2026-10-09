import { describe, expect, it } from 'vitest';
import {
  capturePixelSize,
  clampRect,
  cropInImage,
  type DisplayGeometry,
  displayForPoint,
  displayForRect,
  isClickNotDrag,
  localToGlobal,
  normalizeDrag,
  type ScreenWindow,
  selectionLabel,
  windowAtPoint,
} from './region-math';

/*
 * A real-shaped desk: a Retina laptop as the main display, a 1x external
 * monitor to its LEFT (negative x) and slightly higher (negative y), and a
 * scaled 4K above-right.
 */
const laptop: DisplayGeometry = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  scaleFactor: 2,
};
const left: DisplayGeometry = {
  id: 2,
  bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
  scaleFactor: 1,
};
const above: DisplayGeometry = {
  id: 3,
  bounds: { x: 600, y: -1440, width: 2560, height: 1440 },
  scaleFactor: 1.5,
};
const desk = [laptop, left, above];

describe('drag rects', () => {
  it('normalises a drag in any direction', () => {
    expect(normalizeDrag({ x: 300, y: 200 }, { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150,
    });
    expect(normalizeDrag({ x: 10, y: 90 }, { x: 40, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 70,
    });
  });

  it('a tiny drag is a click', () => {
    expect(isClickNotDrag({ x: 0, y: 0, width: 3, height: 200 })).toBe(true);
    expect(isClickNotDrag({ x: 0, y: 0, width: 40, height: 40 })).toBe(false);
  });

  it('clamps to a display', () => {
    expect(clampRect({ x: -50, y: 900, width: 200, height: 200 }, laptop.bounds)).toEqual({
      x: 0,
      y: 900,
      width: 150,
      height: 82,
    });
    expect(clampRect({ x: 5000, y: 0, width: 10, height: 10 }, laptop.bounds).width).toBe(0);
  });
});

describe('overlay-local to global', () => {
  it('offsets by the display origin, negative origins included', () => {
    expect(localToGlobal({ x: 100, y: 40, width: 300, height: 200 }, left)).toEqual({
      x: -1820,
      y: -80,
      width: 300,
      height: 200,
    });
    expect(localToGlobal({ x: 10, y: 10, width: 5, height: 5 }, above)).toEqual({
      x: 610,
      y: -1430,
      width: 5,
      height: 5,
    });
  });
});

describe('which display', () => {
  it('finds the display under a point, and the nearest across a gap', () => {
    expect(displayForPoint({ x: 700, y: 400 }, desk)?.id).toBe(1);
    expect(displayForPoint({ x: -5, y: 0 }, desk)?.id).toBe(2);
    expect(displayForPoint({ x: 1000, y: -1 }, desk)?.id).toBe(3);
    // Off every display, below the laptop: the laptop is nearest.
    expect(displayForPoint({ x: 700, y: 2000 }, desk)?.id).toBe(1);
  });

  it('a window straddling two displays belongs to the bigger share', () => {
    expect(displayForRect({ x: -300, y: 100, width: 1000, height: 600 }, desk)?.id).toBe(1);
    expect(displayForRect({ x: -900, y: 100, width: 1000, height: 600 }, desk)?.id).toBe(2);
  });
});

describe('crop in the captured picture', () => {
  it('doubles on a Retina display', () => {
    const img = capturePixelSize(laptop);
    expect(img).toEqual({ width: 3024, height: 1964 });
    expect(cropInImage({ x: 100, y: 50, width: 200, height: 100 }, laptop, img)).toEqual({
      x: 200,
      y: 100,
      width: 400,
      height: 200,
    });
  });

  it('works on a 1x display left of the main one', () => {
    const img = capturePixelSize(left);
    const global = localToGlobal({ x: 100, y: 40, width: 300, height: 200 }, left);
    expect(cropInImage(global, left, img)).toEqual({ x: 100, y: 40, width: 300, height: 200 });
  });

  it('rounds fractional scales outward, never shaving the selection', () => {
    const img = capturePixelSize(above); // 3840 × 2160
    const crop = cropInImage({ x: 601, y: -1439, width: 101, height: 33 }, above, img);
    // x: 1 × 1.5 = 1.5 → floor 1; (1 + 101) × 1.5 = 153 → ceil 153 → 152 wide.
    // y: 1 × 1.5 → floor 1; (1 + 33) × 1.5 = 51 → 50 tall.
    expect(crop).toEqual({ x: 1, y: 1, width: 152, height: 50 });
  });

  it('reads the scale from the picture, not the display', () => {
    // The capture came back at half size: the crop must follow the picture.
    const crop = cropInImage({ x: 100, y: 100, width: 100, height: 100 }, laptop, {
      width: 1512,
      height: 982,
    });
    expect(crop).toEqual({ x: 100, y: 100, width: 100, height: 100 });
  });

  it('clips a selection hanging off the display edge, and refuses one that misses it', () => {
    const img = capturePixelSize(laptop);
    expect(cropInImage({ x: 1400, y: 900, width: 400, height: 400 }, laptop, img)).toEqual({
      x: 2800,
      y: 1800,
      width: 224,
      height: 164,
    });
    expect(cropInImage({ x: -500, y: 0, width: 100, height: 100 }, laptop, img)).toBeNull();
  });
});

describe('picking a window', () => {
  const windows: ScreenWindow[] = [
    {
      windowId: 9,
      pid: 100,
      app: 'Bobble',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      layer: 0,
    },
    {
      windowId: 7,
      pid: 200,
      app: 'Menu',
      bounds: { x: 0, y: 0, width: 300, height: 30 },
      layer: 24,
    },
    {
      windowId: 5,
      pid: 300,
      app: 'TextEdit',
      bounds: { x: 50, y: 50, width: 600, height: 500 },
      layer: 0,
    },
    {
      windowId: 3,
      pid: 400,
      app: 'Safari',
      bounds: { x: 0, y: 0, width: 1500, height: 900 },
      layer: 0,
    },
  ];

  it('skips Bobble and non-document layers, taking the frontmost under the point', () => {
    expect(windowAtPoint({ x: 100, y: 60 }, windows, [100])?.app).toBe('TextEdit');
    // Above TextEdit's top edge the point is on Safari.
    expect(windowAtPoint({ x: 100, y: 20 }, windows, [100])?.app).toBe('Safari');
    expect(windowAtPoint({ x: 1000, y: 800 }, windows, [100])?.app).toBe('Safari');
    expect(windowAtPoint({ x: 3000, y: 3000 }, windows, [100])).toBeNull();
  });

  it('labels a selection in points', () => {
    expect(selectionLabel({ x: 0, y: 0, width: 640.4, height: 479.6 })).toBe('640 × 480');
  });
});
