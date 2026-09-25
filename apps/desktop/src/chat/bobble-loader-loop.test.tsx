// @vitest-environment jsdom
/**
 * THE LOADER'S LOOP — when it draws, when it stops, and what is on the canvas
 * at the moment the browser paints.
 *
 * bobble-anim.test.ts pins WHAT each frame looks like; this pins the renderer
 * around it, which the review of the 2026-09-23 wave found four ways to get
 * wrong (deliverables/review/wave-0923-findings.md, renderer-ui):
 *
 *  - a finished sweep that scrolls out of view and back ran a rAF loop forever;
 *  - with Reduce Motion on, the exit never started on a card already on screen,
 *    so a result never finished revealing (the studio never filed the run);
 *  - every ResizeObserver callback reassigned the canvas size — which CLEARS the
 *    bitmap, even to the same value — after the frame was drawn: blank while
 *    the card eased to its aspect, and blank for good under Reduce Motion;
 *  - under Reduce Motion a theme switch re-read the ink but painted nothing.
 *
 * jsdom has no canvas, no layout and no observers, so the browser is played by
 * hand: frames run when a test says so, observers fire when a test says so, and
 * the canvas is a bitmap model that a fill paints and a size assignment clears.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BobbleLoader, type BobbleLoaderProps } from './BobbleLoader';
import { EXIT_MS } from './bobble-anim';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* ── frames, by hand ─────────────────────────────────────────────────────── */

const frames = new Map<number, FrameRequestCallback>();
let frameSeq = 0;
let clock = 1000;
/** Run every callback due this frame, `ms` after the last one. */
function frame(ms = 16): void {
  clock += ms;
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(clock);
}
/** Frames until `until()` holds, at most `max` of them. */
function framesUntil(until: () => boolean, max = 400): number {
  let n = 0;
  while (!until() && n < max) {
    frame();
    n += 1;
  }
  return n;
}

/* ── observers, by hand ──────────────────────────────────────────────────── */

let ioCallbacks: IntersectionObserverCallback[] = [];
let roCallbacks: ResizeObserverCallback[] = [];
function scrolled(visible: boolean): void {
  for (const cb of ioCallbacks)
    cb([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver);
}
function resized(): void {
  for (const cb of roCallbacks) cb([], {} as ResizeObserver);
}

/* ── the canvas: a bitmap a fill paints and a size assignment clears ────── */

let box = { width: 400, height: 400 };
const painted = new WeakMap<HTMLCanvasElement, number>();
const inks = new WeakMap<HTMLCanvasElement, string[]>();
let reduced = false;

beforeEach(() => {
  frames.clear();
  ioCallbacks = [];
  roCallbacks = [];
  box = { width: 400, height: 400 };
  reduced = false;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameSeq += 1;
    frames.set(frameSeq, cb);
    return frameSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: IntersectionObserverCallback) {
        ioCallbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ ...box, x: 0, y: 0, top: 0, left: 0, right: box.width, bottom: box.height }) as DOMRect,
  );
  // The HTML spec: setting a canvas's width or height — to any value, the
  // same one included — resets its bitmap to transparent black.
  for (const dim of ['width', 'height'] as const) {
    const own = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dim);
    Object.defineProperty(HTMLCanvasElement.prototype, dim, {
      configurable: true,
      get(this: HTMLCanvasElement) {
        return own?.get?.call(this);
      },
      set(this: HTMLCanvasElement, v: number) {
        own?.set?.call(this, v);
        painted.set(this, 0);
      },
    });
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const ctx = {
      fillStyle: '',
      globalAlpha: 1,
      setTransform: () => {},
      clearRect: () => painted.set(this, 0),
      beginPath: () => {},
      roundRect: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      fill: () => {
        painted.set(this, (painted.get(this) ?? 0) + 1);
        inks.set(this, [...(inks.get(this) ?? []), String(ctx.fillStyle)]);
      },
    };
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-mode');
  for (const s of document.querySelectorAll('style[data-test]')) s.remove();
});

function mount(props: BobbleLoaderProps): HTMLCanvasElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<BobbleLoader fill bare {...props} />));
  const canvas = container.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas');
  return canvas;
}
function rerender(props: BobbleLoaderProps): void {
  act(() => root?.render(<BobbleLoader fill bare {...props} />));
}

describe('a finished sweep', () => {
  it('stays finished when the card scrolls out of view and back', () => {
    const done = vi.fn();
    mount({ onExitDone: done });
    frame();
    rerender({ exit: true, onExitDone: done });
    framesUntil(() => done.mock.calls.length > 0);
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);

    scrolled(false);
    scrolled(true);
    // Whatever the observer restarts must stop again by itself: a finished
    // board has nothing left to draw.
    frame();
    frame();
    frame();
    expect(frames.size).toBe(0);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('with Reduce Motion on', () => {
  it('the result still hands over — the exit reaches a loader that has stopped drawing', () => {
    reduced = true;
    const done = vi.fn();
    mount({ onExitDone: done });
    frame();
    // The resting frame, drawn once: nothing is scheduled after it.
    expect(frames.size).toBe(0);
    rerender({ exit: true, onExitDone: done });
    framesUntil(() => done.mock.calls.length > 0, 10);
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('the resting frame survives the observer’s first notification', () => {
    reduced = true;
    const canvas = mount({});
    frame();
    expect(painted.get(canvas) ?? 0).toBeGreaterThan(0);
    resized();
    expect(painted.get(canvas) ?? 0).toBeGreaterThan(0);
  });

  it('a theme switch paints the resting frame in the new ink', async () => {
    reduced = true;
    const style = document.createElement('style');
    style.dataset.test = 'ink';
    style.textContent =
      ':root[data-mode="light"] .pd-bobble-loader-host { --pd-bobble-ink: #222222; }';
    document.head.appendChild(style);
    document.documentElement.setAttribute('data-mode', 'dark');
    const canvas = mount({});
    frame();
    expect(inks.get(canvas)?.at(-1)).toBe('#ffffff');
    document.documentElement.setAttribute('data-mode', 'light');
    await act(async () => {
      await Promise.resolve();
    });
    frame();
    expect(inks.get(canvas)?.at(-1)).toBe('#222222');
  });
});

describe('a resize', () => {
  it('that changes nothing leaves the frame on the canvas', () => {
    const canvas = mount({});
    frame();
    expect(painted.get(canvas) ?? 0).toBeGreaterThan(0);
    resized();
    expect(painted.get(canvas) ?? 0).toBeGreaterThan(0);
  });

  it('to a new shape redraws before the browser paints — never a blank card mid-ease', () => {
    const canvas = mount({});
    frame();
    // The frame easing from square to 16:9: layout moves, the observer fires
    // AFTER this frame's draw and BEFORE the paint.
    box = { width: 640, height: 360 };
    resized();
    expect(canvas.width).toBe(640);
    expect(painted.get(canvas) ?? 0).toBeGreaterThan(0);
  });

  it('a running loader keeps its ink after a theme switch (read again, not once)', async () => {
    const style = document.createElement('style');
    style.dataset.test = 'ink';
    style.textContent =
      ':root[data-mode="light"] .pd-bobble-loader-host { --pd-bobble-ink: #222222; }';
    document.head.appendChild(style);
    document.documentElement.setAttribute('data-mode', 'dark');
    const canvas = mount({});
    frame();
    expect(inks.get(canvas)?.at(-1)).toBe('#ffffff');
    document.documentElement.setAttribute('data-mode', 'light');
    await act(async () => {
      await Promise.resolve();
    });
    frame();
    expect(inks.get(canvas)?.at(-1)).toBe('#222222');
  });
});

// The sweep's own length, so a reader can see the frame budgets above are
// generous: ~72 frames at 16ms.
it('EXIT_MS is the sweep the budgets above are sized for', () => {
  expect(EXIT_MS).toBeLessThan(400 * 16);
});
