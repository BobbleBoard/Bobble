import { describe, expect, it } from 'vitest';
import {
  bubbleContent,
  comboLabel,
  occludersDiffer,
  overlayShouldShow,
  rectDelta,
  rectsDiffer,
  typingPreview,
} from './overlay-geometry';

describe('rectsDiffer (tracking-loop thrash guard)', () => {
  const base = { x: 100, y: 100, w: 640, h: 480 };
  it('ignores sub-point AX jitter', () => {
    expect(rectsDiffer(base, { x: 100.4, y: 99.7, w: 640.3, h: 480 })).toBe(false);
  });
  it('detects real moves and resizes', () => {
    expect(rectsDiffer(base, { ...base, x: 130 })).toBe(true);
    expect(rectsDiffer(base, { ...base, h: 500 })).toBe(true);
  });
  it('treats null (no window) vs a rect as a change, null vs null as none', () => {
    expect(rectsDiffer(null, base)).toBe(true);
    expect(rectsDiffer(base, null)).toBe(true);
    expect(rectsDiffer(null, null)).toBe(false);
  });
});

describe('rectDelta (the phantom rides a window drag)', () => {
  const win = { x: 200, y: 150, w: 800, h: 600 };
  it('is the origin delta, so the cursor stays glued to what it points at', () => {
    expect(rectDelta(win, { ...win, x: 260, y: 190 })).toEqual({ dx: 60, dy: 40 });
    expect(rectDelta(win, { ...win, x: 140, y: 110 })).toEqual({ dx: -60, dy: -40 });
  });
  it('is zero for a resize that leaves the origin alone — nothing under the cursor moved', () => {
    expect(rectDelta(win, { ...win, w: 1000, h: 700 })).toEqual({ dx: 0, dy: 0 });
  });
  it('rounds to whole screen points (AX reports fractional frames)', () => {
    expect(rectDelta(win, { ...win, x: 200.4, y: 150.6 })).toEqual({ dx: 0, dy: 1 });
  });
});

describe('occludersDiffer (mask-push thrash guard)', () => {
  const first = { x: 0, y: 0, w: 100, h: 100 };
  const second = { x: 300, y: 200, w: 50, h: 50 };
  const a = [first, second];
  it('ignores sub-point jitter in an otherwise identical set', () => {
    expect(occludersDiffer(a, [{ ...first, x: 0.4 }, second])).toBe(false);
  });
  it('detects a moved, added or removed occluder', () => {
    expect(occludersDiffer(a, [{ ...first, x: 40 }, second])).toBe(true);
    expect(occludersDiffer(a, [first])).toBe(true);
    expect(occludersDiffer(a, [...a, { x: 9, y: 9, w: 9, h: 9 }])).toBe(true);
  });
  it('treats an empty set as a real state (the mask must be cleared)', () => {
    expect(occludersDiffer(null, [])).toBe(true);
    expect(occludersDiffer([], [])).toBe(false);
    expect(occludersDiffer(a, [])).toBe(true);
  });
});

describe('overlayShouldShow (app-scoped visibility rule)', () => {
  it('hides when the controlled window is not present, regardless of the rest', () => {
    expect(overlayShouldShow({ controlledFrontmost: true, appVisible: false, driving: true })).toBe(
      false,
    );
  });
  it('shows while the model is actively driving, even in the background', () => {
    expect(overlayShouldShow({ controlledFrontmost: false, appVisible: true, driving: true })).toBe(
      true,
    );
  });
  it('shows when the controlled app is frontmost even if the model is idle', () => {
    expect(overlayShouldShow({ controlledFrontmost: true, appVisible: true, driving: false })).toBe(
      true,
    );
  });
  it('tucks away when backgrounded AND idle (user is working elsewhere)', () => {
    expect(
      overlayShouldShow({ controlledFrontmost: false, appVisible: true, driving: false }),
    ).toBe(false);
  });

  // Occlusion is TRUTH when the helper reports it (CGWindowList z-order).
  it('hides while occluded even mid-drive — never paints over the covering app', () => {
    expect(
      overlayShouldShow({
        controlledFrontmost: false,
        appVisible: true,
        driving: true,
        occluded: true,
      }),
    ).toBe(false);
    expect(
      overlayShouldShow({
        controlledFrontmost: true,
        appVisible: true,
        driving: false,
        occluded: true,
      }),
    ).toBe(false);
  });
  it('shows on a CLEAR window even when idle + backgrounded (cursor lives on the app)', () => {
    expect(
      overlayShouldShow({
        controlledFrontmost: false,
        appVisible: true,
        driving: false,
        occluded: false,
      }),
    ).toBe(true);
  });
  it('unknown occlusion (old helper) falls back to the driving/frontmost proxy', () => {
    expect(
      overlayShouldShow({
        controlledFrontmost: false,
        appVisible: true,
        driving: false,
        occluded: null,
      }),
    ).toBe(false);
    expect(
      overlayShouldShow({
        controlledFrontmost: false,
        appVisible: true,
        driving: true,
        occluded: null,
      }),
    ).toBe(true);
  });
  it('appVisible=false wins over a clear occlusion read', () => {
    expect(
      overlayShouldShow({
        controlledFrontmost: false,
        appVisible: false,
        driving: true,
        occluded: false,
      }),
    ).toBe(false);
  });
});

describe('comboLabel (status-bubble key labels)', () => {
  it('renders modifier glyphs + uppercased key', () => {
    expect(comboLabel('cmd+s')).toBe('⌘S');
    expect(comboLabel('cmd+shift+z')).toBe('⌘⇧Z');
    expect(comboLabel('ctrl+alt+delete')).toBe('⌃⌥⌫');
  });
  it('renders named keys as their mac glyphs', () => {
    expect(comboLabel('return')).toBe('↩');
    expect(comboLabel('escape')).toBe('Esc');
    expect(comboLabel('down')).toBe('↓');
  });
  it('never returns an empty label', () => {
    expect(comboLabel('')).toBe('');
    expect(comboLabel('weirdkey')).toBe('Weirdkey');
  });
});

describe('typingPreview', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(typingPreview('hello   world')).toBe('hello world');
    const long = 'a'.repeat(80);
    const out = typingPreview(long);
    expect(out.length).toBe(44);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('bubbleContent — the words the canvas monitor and overlay.html share', () => {
  it('mirrors every state the overlay STATUS map paints', () => {
    expect(bubbleContent('thinking')).toEqual({ label: 'Thinking', detail: '', dots: true });
    expect(bubbleContent('clicking')).toEqual({ label: 'Clicking', detail: '', dots: false });
    expect(bubbleContent('scrolling')).toEqual({ label: 'Scrolling', detail: '', dots: true });
    expect(bubbleContent('reading')).toEqual({
      label: 'Reading the screen',
      detail: '',
      dots: true,
    });
  });

  it('carries the typed preview as the monospace tail, not in the label', () => {
    expect(bubbleContent('typing', 'hello world')).toEqual({
      label: 'Typing',
      detail: 'hello world',
      dots: true,
    });
  });

  it('puts the key combo in the label, as the overlay does', () => {
    expect(bubbleContent('pressing', comboLabel('cmd+shift+s')).label).toBe('Pressing ⌘⇧S');
  });

  it('never leaves a dangling word when the payload is empty', () => {
    expect(bubbleContent('pressing').label).toBe('Pressing');
    expect(bubbleContent('opening').label).toBe('Opening');
  });

  it('idle is no bubble at all', () => {
    expect(bubbleContent('idle')).toEqual({ label: '', detail: '', dots: false });
  });
});

describe('the phantom hides for the point it is on, not the window it is in', () => {
  /*
   * the user, watching a live run: "the fake cursor is an always on top invisible
   * window, so i'm seeing the fake cursor even when maps correctly open in the
   * background."
   *
   * The whole-window rule asks "is the controlled app buried", which is the
   * wrong question here — the overlay floats above EVERY window, so a cursor on
   * an uncovered part of a background window still paints over whatever is
   * stacked between them. These pin the rule that replaced it; the per-point
   * check itself lives on the overlay (see #cursorIsCovered) because it needs
   * the live cursor position.
   */
  const clear = { controlledFrontmost: false, appVisible: true, driving: true };

  it('still shows on a clear background window — that is the whole feature', () => {
    expect(overlayShouldShow({ ...clear, occluded: false })).toBe(true);
  });

  it('hides when the controlled window is meaningfully buried', () => {
    expect(overlayShouldShow({ ...clear, occluded: true })).toBe(false);
  });

  it('hides when the window left the space, whatever else is true', () => {
    expect(overlayShouldShow({ ...clear, appVisible: false, occluded: false })).toBe(false);
  });
});
