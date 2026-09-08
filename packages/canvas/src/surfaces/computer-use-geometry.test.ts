import { describe, expect, it } from 'vitest';
import {
  annotationScale,
  bubbleAnchor,
  coverCrop,
  cursorEase,
  fitWindow,
  screenToCanvas,
} from './computer-use-geometry.ts';

describe('fitWindow', () => {
  it('keeps a window that fits at EXACTLY its real point size, centred', () => {
    const drawn = fitWindow({ w: 600, h: 400 }, { w: 1000, h: 800 });
    expect(drawn.scale).toBe(1);
    expect(drawn.w).toBe(600);
    expect(drawn.h).toBe(400);
    expect(drawn.x).toBe(200);
    expect(drawn.y).toBe(200);
  });

  it('never upscales a window smaller than the tab', () => {
    const drawn = fitWindow({ w: 320, h: 200 }, { w: 2000, h: 1600 });
    expect(drawn.scale).toBe(1);
    expect(drawn.w).toBe(320);
  });

  it('scales DOWN to fit, keeping the aspect ratio', () => {
    const drawn = fitWindow({ w: 1440, h: 900 }, { w: 720, h: 900 });
    expect(drawn.scale).toBeCloseTo(0.5, 6);
    expect(drawn.w).toBeCloseTo(720, 6);
    expect(drawn.h).toBeCloseTo(450, 6);
    expect(drawn.w / drawn.h).toBeCloseTo(1440 / 900, 6);
  });

  it('binds on whichever axis is tighter', () => {
    const wide = fitWindow({ w: 1000, h: 1000 }, { w: 400, h: 900 });
    expect(wide.scale).toBeCloseTo(0.4, 6);
    const tall = fitWindow({ w: 1000, h: 1000 }, { w: 900, h: 300 });
    expect(tall.scale).toBeCloseTo(0.3, 6);
  });

  it('honours padding only when the window has to shrink', () => {
    const padded = fitWindow({ w: 1000, h: 1000 }, { w: 500, h: 500 }, 20);
    expect(padded.scale).toBeCloseTo(460 / 1000, 6);
    // Still centred in the FULL viewport, not the padded box.
    expect(padded.x).toBeCloseTo((500 - padded.w) / 2, 6);
    const fits = fitWindow({ w: 100, h: 100 }, { w: 500, h: 500 }, 20);
    expect(fits.scale).toBe(1);
  });

  it('survives a zero-sized viewport without NaN', () => {
    const drawn = fitWindow({ w: 800, h: 600 }, { w: 0, h: 0 });
    expect(Number.isFinite(drawn.scale)).toBe(true);
    expect(Number.isFinite(drawn.x)).toBe(true);
    expect(drawn.scale).toBeGreaterThan(0);
  });
});

describe('screenToCanvas', () => {
  const windowRect = { x: 300, y: 150, w: 800, h: 600 };

  it('maps the window origin to the drawn origin at real size', () => {
    const drawn = fitWindow(windowRect, { w: 1000, h: 800 });
    expect(screenToCanvas({ x: 300, y: 150 }, windowRect, drawn)).toEqual({
      x: drawn.x,
      y: drawn.y,
    });
  });

  it('maps a point inside the window proportionally when scaled down', () => {
    const drawn = fitWindow(windowRect, { w: 400, h: 800 }); // scale 0.5
    expect(drawn.scale).toBeCloseTo(0.5, 6);
    // Centre of the window → centre of the drawn rect.
    const mid = screenToCanvas({ x: 700, y: 450 }, windowRect, drawn);
    expect(mid.x).toBeCloseTo(drawn.x + drawn.w / 2, 6);
    expect(mid.y).toBeCloseTo(drawn.y + drawn.h / 2, 6);
  });

  it('maps a point OUTSIDE the window outside the drawn rect (not clamped)', () => {
    const drawn = fitWindow(windowRect, { w: 1000, h: 800 });
    const out = screenToCanvas({ x: 290, y: 140 }, windowRect, drawn);
    expect(out.x).toBeLessThan(drawn.x);
    expect(out.y).toBeLessThan(drawn.y);
  });

  it('agrees with the real overlay: the same screen point lands on the same pixel of the window', () => {
    // A click at 40% across / 25% down the window must land there in the tab,
    // whatever the tab's size.
    const target = { x: windowRect.x + 0.4 * windowRect.w, y: windowRect.y + 0.25 * windowRect.h };
    for (const viewport of [
      { w: 1600, h: 1200 },
      { w: 500, h: 900 },
      { w: 380, h: 300 },
    ]) {
      const drawn = fitWindow(windowRect, viewport);
      const p = screenToCanvas(target, windowRect, drawn);
      expect((p.x - drawn.x) / drawn.w).toBeCloseTo(0.4, 6);
      expect((p.y - drawn.y) / drawn.h).toBeCloseTo(0.25, 6);
    }
  });
});

describe('coverCrop', () => {
  it('crops the sides of a wide image for a narrow viewport', () => {
    const crop = coverCrop({ w: 4000, h: 1000 }, { w: 100, h: 100 });
    expect(crop.h).toBe(1000);
    expect(crop.w).toBe(1000);
    expect(crop.x).toBe(1500);
    expect(crop.y).toBe(0);
  });

  it('crops the top and bottom of a tall image for a wide viewport', () => {
    const crop = coverCrop({ w: 1000, h: 4000 }, { w: 200, h: 100 });
    expect(crop.w).toBe(1000);
    expect(crop.h).toBe(500);
    expect(crop.y).toBe(1750);
  });

  it('is a no-op crop when the ratios match', () => {
    const crop = coverCrop({ w: 1600, h: 900 }, { w: 800, h: 450 });
    expect(crop).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });

  it('never returns NaN for a degenerate source', () => {
    const crop = coverCrop({ w: 0, h: 0 }, { w: 100, h: 100 });
    expect(Number.isFinite(crop.w)).toBe(true);
    expect(Number.isFinite(crop.h)).toBe(true);
  });
});

describe('annotationScale', () => {
  it('tracks the window scale when the window is near real size', () => {
    expect(annotationScale(0.9)).toBeCloseTo(0.9, 6);
  });
  it('never grows past life size', () => {
    expect(annotationScale(1)).toBe(1);
    expect(annotationScale(3)).toBe(1);
  });
  it('stays legible on a heavily shrunk window', () => {
    expect(annotationScale(0.2)).toBe(0.78);
  });
  it('handles a degenerate scale', () => {
    expect(annotationScale(0)).toBe(0.78);
    expect(annotationScale(Number.NaN)).toBe(0.78);
  });
});

describe('bubbleAnchor', () => {
  const viewport = { w: 500, h: 400 };
  const size = { w: 140, h: 34 };

  it('sits down-right of the cursor with room to spare', () => {
    const a = bubbleAnchor({ x: 100, y: 100 }, size, viewport);
    expect(a).toMatchObject({ x: 127, y: 140, flipX: false, flipY: false });
  });

  it('flips left near the right edge and stays inside', () => {
    const a = bubbleAnchor({ x: 470, y: 100 }, size, viewport);
    expect(a.flipX).toBe(true);
    expect(a.x).toBeGreaterThanOrEqual(8);
    expect(a.x + size.w).toBeLessThanOrEqual(viewport.w - 8);
  });

  it('flips up near the bottom edge and stays inside', () => {
    const a = bubbleAnchor({ x: 100, y: 380 }, size, viewport);
    expect(a.flipY).toBe(true);
    expect(a.y).toBeGreaterThanOrEqual(8);
    expect(a.y + size.h).toBeLessThanOrEqual(viewport.h - 8);
  });

  it('flips both in the bottom-right corner', () => {
    const a = bubbleAnchor({ x: 495, y: 395 }, size, viewport);
    expect(a).toMatchObject({ flipX: true, flipY: true });
    expect(a.x).toBeGreaterThanOrEqual(8);
    expect(a.y).toBeGreaterThanOrEqual(8);
  });
});

describe('cursorEase', () => {
  it('is pinned at both ends', () => {
    expect(cursorEase(0)).toBeCloseTo(0, 6);
    expect(cursorEase(1)).toBeCloseTo(1, 6);
  });

  it('clamps outside 0…1', () => {
    expect(cursorEase(-2)).toBeCloseTo(0, 6);
    expect(cursorEase(5)).toBeCloseTo(1, 6);
  });

  it('leads the linear curve (fast out) and overshoots slightly, like the CSS', () => {
    expect(cursorEase(0.25)).toBeGreaterThan(0.25);
    expect(cursorEase(0.5)).toBeGreaterThan(0.5);
    // cubic-bezier(.22,.9,.32,1.1) rises above 1 before settling.
    const peak = Math.max(...Array.from({ length: 40 }, (_, i) => cursorEase(0.6 + i * 0.01)));
    expect(peak).toBeGreaterThan(1);
  });

  it('is monotonic enough to animate without jitter in the first half', () => {
    let prev = -1;
    for (let i = 0; i <= 50; i++) {
      const v = cursorEase(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
