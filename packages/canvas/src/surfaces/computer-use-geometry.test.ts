import { describe, expect, it } from 'vitest';
import {
  annotationScale,
  blendPlacement,
  coverCrop,
  cursorEase,
  fitWindow,
  followWindow,
  screenToCanvas,
  stagePadding,
  visibleRegion,
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
    // The floor is 0.62, not 0.78: at the docked scale of 0.45 the old floor
    // drew the annotation at 1.7x the window's own scale, which put a bubble
    // over a dialog's Cancel button. The fix for a too-small window is a bigger
    // window (followWindow), not a bigger cursor.
    expect(annotationScale(0.2)).toBe(0.62);
  });
  it('handles a degenerate scale', () => {
    expect(annotationScale(0)).toBe(0.62);
    expect(annotationScale(Number.NaN)).toBe(0.62);
  });
});

describe('followWindow', () => {
  const viewport = { w: 440, h: 780 };
  const rect = { x: 200, y: 120, w: 900, h: 620 };

  it('is exactly fitWindow when the window already fits better than the crop', () => {
    const big = { w: 1600, h: 1000 };
    const follow = followWindow(rect, big, { x: 400, y: 300 });
    expect(follow).toEqual(fitWindow(rect, big));
  });

  it('never magnifies past what fits, however tall the rail is', () => {
    /*
     * Covering a TALL, NARROW rail with a WIDE window is decided entirely by the
     * height, and it crops the width to a sliver. MEASURED on the Chrome runs: a
     * 440pt rail against a 1024pt window covered at 0.85 and the video showed a
     * quarter of the window — a giant cropped "oogle" — for the whole run. the user:
     * "the zoom and following is either not working or way too much, needs at
     * least twice less zoom."
     *
     * Letterboxing was never the thing to avoid; the surface paints the user's
     * own wallpaper behind the window on purpose.
     */
    // This window already fits better than the cap, so following simply fits it —
    // the whole window, no crop at all, which cover would have refused to do.
    const follow = followWindow(rect, viewport, { x: 650, y: 430 });
    expect(follow).toEqual(fitWindow(rect, viewport));

    // A window too big to read when fitted stops at the floor, not at cover.
    const wide = { x: 0, y: 0, w: 2400, h: 900 };
    const cropped = followWindow(wide, viewport, { x: 1200, y: 450 });
    expect(cropped.scale).toBeCloseTo(0.3, 6);
    expect(cropped.scale).toBeLessThan(Math.max(viewport.w / wide.w, viewport.h / wide.h));
  });

  /* The exact trade the cap was making, as the thing the viewer loses: a window
     that FITS at 0.397 must never be shown at 0.45 with its left edge cut off. */
  it('never crops a window that would have fitted whole', () => {
    const chrome = { x: 0, y: 33, w: 1512, h: 867 };
    const rail = { w: 600, h: 1150 };
    const follow = followWindow(chrome, rail, { x: 700, y: 500 });
    expect(follow).toEqual(fitWindow(chrome, rail));
    expect(follow.w).toBeLessThanOrEqual(rail.w);
    expect(follow.x).toBeGreaterThanOrEqual(0);
  });

  it('shows at least twice the width cover would have', () => {
    // Kept as the original regression's own statement of itself.
    // The regression this cap exists for, stated as the thing the viewer sees.
    const covered = Math.max(viewport.w / rect.w, viewport.h / rect.h);
    const follow = followWindow(rect, viewport, { x: 650, y: 430 });
    expect(viewport.w / follow.scale).toBeGreaterThanOrEqual((viewport.w / covered) * 2);
  });

  it('fits a window that still fits, rather than zooming to a target', () => {
    const wide = { x: 0, y: 0, w: 1440, h: 900 };
    const follow = followWindow(wide, viewport, { x: 700, y: 450 });
    expect(follow).toEqual(fitWindow(wide, viewport));
  });

  it('holds the floor for a window far too big to read fitted', () => {
    const huge = { x: 0, y: 0, w: 2560, h: 1600 };
    expect(followWindow(huge, viewport, { x: 1280, y: 800 }).scale).toBeCloseTo(0.3, 6);
  });

  it('holds the floor for a strip too wide to fit legibly', () => {
    const strip = { x: 0, y: 0, w: 4000, h: 400 };
    const follow = followWindow(strip, viewport, { x: 2000, y: 200 });
    expect(follow.scale).toBeCloseTo(0.3, 6);
  });

  it('centres the focus point, and clamps so no gap opens beside the window', () => {
    const mid = followWindow(rect, viewport, { x: 650, y: 430 });
    expect(mid.x + (650 - rect.x) * mid.scale).toBeCloseTo(220, 6);
    // A focus at the left edge: the window's own left edge stops at 0 rather
    // than letting wallpaper through where the window could cover it.
    expect(followWindow(rect, viewport, { x: 205, y: 430 }).x).toBe(0);
    const right = followWindow(rect, viewport, { x: 1095, y: 430 });
    expect(right.x).toBeCloseTo(viewport.w - right.w, 6);
  });

  it('centres an axis that is not cropped, exactly as fit does', () => {
    const follow = followWindow(rect, viewport, { x: 650, y: 430 });
    expect(follow.y).toBeCloseTo((viewport.h - follow.h) / 2, 6);
  });

  it('never upscales, whatever the floor says', () => {
    const tiny = { x: 0, y: 0, w: 200, h: 150 };
    expect(followWindow(tiny, viewport, { x: 100, y: 75 }, 0.85).scale).toBe(1);
  });
});

describe('visibleRegion', () => {
  const rect = { x: 200, y: 120, w: 900, h: 620 };
  const viewport = { w: 440, h: 780 };

  it('is the whole window when nothing is cropped', () => {
    const drawn = fitWindow(rect, { w: 1600, h: 1000 });
    const seen = visibleRegion(rect, { w: 1600, h: 1000 }, drawn);
    expect(seen.w).toBeCloseTo(900, 6);
    expect(seen.h).toBeCloseTo(620, 6);
    expect(seen.x).toBeCloseTo(200, 6);
  });

  it('is the slice under the viewport when the window is cropped', () => {
    const drawn = followWindow(rect, viewport, { x: 650, y: 430 });
    const seen = visibleRegion(rect, viewport, drawn);
    expect(seen.w).toBeCloseTo(440 / drawn.scale, 6);
    expect(seen.x + seen.w / 2).toBeCloseTo(650, 6);
    // Nothing outside the window is ever reported as visible.
    expect(seen.x).toBeGreaterThanOrEqual(rect.x);
    expect(seen.x + seen.w).toBeLessThanOrEqual(rect.x + rect.w + 1e-6);
  });
});

describe('stagePadding — a margin that reads as one (the user 2026-09-23)', () => {
  it('is 44 on a stage with room to spare', () => {
    expect(stagePadding({ w: 1600, h: 1000 })).toBe(44);
  });
  it('is 31 in the docked rail — the window never meets its edges', () => {
    expect(stagePadding({ w: 440, h: 960 })).toBe(31);
  });
  it('never drops below 16', () => {
    expect(stagePadding({ w: 60, h: 60 })).toBe(16);
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

describe('blendPlacement', () => {
  const a = { x: 0, y: 0, w: 100, h: 100, scale: 0.4 };
  const b = { x: 20, y: 40, w: 300, h: 300, scale: 1 };

  it('is the ends at the ends', () => {
    expect(blendPlacement(a, b, 0)).toEqual(a);
    expect(blendPlacement(a, b, 1)).toEqual(b);
  });

  it('keeps the scale consistent with the rect it is interpolated with', () => {
    // The scale is what every annotation is sized by, so a blend that moved the
    // rect without moving the scale would draw a cursor and a bubble at the
    // wrong size for exactly the frames the eye is following.
    const mid = blendPlacement(a, b, 0.5);
    expect(mid.w).toBe(200);
    expect(mid.scale).toBeCloseTo(0.7, 5);
  });

  it('clamps rather than overshooting', () => {
    expect(blendPlacement(a, b, -1)).toEqual(a);
    expect(blendPlacement(a, b, 4)).toEqual(b);
  });
});
