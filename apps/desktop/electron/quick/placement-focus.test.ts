import { describe, expect, it } from 'vitest';
import { focusReturnDecision, type PreviousApp } from './focus-return';
import { PANEL_SIZES, panelBounds, resizeInPlace } from './placement';

describe('panelBounds', () => {
  const laptop = { x: 0, y: 25, width: 1512, height: 875 };

  it('centres horizontally a fifth of the way down', () => {
    const b = panelBounds(laptop, 'compact');
    expect(b.width).toBe(PANEL_SIZES.compact.width);
    expect(b.x).toBe(Math.round((1512 - b.width) / 2));
    expect(b.y).toBe(Math.round(25 + 875 * 0.2));
  });

  it('lands on a display left of the main one', () => {
    const b = panelBounds({ x: -1920, y: -120, width: 1920, height: 1055 }, 'expanded');
    expect(b.x).toBe(-1920 + Math.round((1920 - 720) / 2));
    expect(b.y).toBe(Math.round(-120 + 1055 * 0.2));
  });

  it('pushes a tall panel up rather than off the bottom, and fits a tiny display', () => {
    const small = { x: 0, y: 0, width: 800, height: 600 };
    const b = panelBounds(small, 'large');
    expect(b.y + b.height).toBeLessThanOrEqual(600 - 16);
    expect(b.width).toBeLessThanOrEqual(800 - 32);
  });
});

describe('resizeInPlace', () => {
  const area = { x: 0, y: 25, width: 1512, height: 875 };

  it('keeps the top and the horizontal centre', () => {
    const compact = panelBounds(area, 'compact');
    const grown = resizeInPlace(compact, 'expanded', area);
    expect(grown.y).toBe(compact.y);
    expect(grown.x + grown.width / 2).toBeCloseTo(compact.x + compact.width / 2, 0);
    expect(grown.height).toBe(PANEL_SIZES.expanded.height);
  });

  it('slides a panel near the bottom up so it stays on screen', () => {
    const low = { x: 400, y: 700, width: 680, height: 212 };
    const grown = resizeInPlace(low, 'large', area);
    expect(grown.y + grown.height).toBeLessThanOrEqual(25 + 875 - 16);
  });
});

describe('focusReturnDecision', () => {
  const textEdit: PreviousApp = { pid: 4242, name: 'TextEdit' };
  const base = { previous: textEdit, ownPids: [100], frontmostPid: 4242, background: false };

  it('does nothing on Esc when the app in front never changed (the panel never activated Bobble)', () => {
    expect(focusReturnDecision({ ...base, reason: 'escape' })).toEqual({ kind: 'none' });
  });

  it('hands the keyboard back on Esc if Bobble became the active app meanwhile', () => {
    expect(focusReturnDecision({ ...base, reason: 'escape', frontmostPid: 100 })).toEqual({
      kind: 'activate-previous',
      pid: 4242,
      name: 'TextEdit',
    });
  });

  it('never fights a click elsewhere', () => {
    expect(focusReturnDecision({ ...base, reason: 'blur', frontmostPid: 100 })).toEqual({
      kind: 'none',
    });
  });

  it('always puts the app in front for a paste', () => {
    expect(focusReturnDecision({ ...base, reason: 'paste' })).toEqual({
      kind: 'activate-previous',
      pid: 4242,
      name: 'TextEdit',
    });
  });

  it('goes to the main window for "Open in Bobble"', () => {
    expect(focusReturnDecision({ ...base, reason: 'open-in-main' })).toEqual({
      kind: 'focus-main',
    });
  });

  it('summoned over Bobble itself, or not knowing what was in front: nothing to give back', () => {
    expect(
      focusReturnDecision({ ...base, reason: 'paste', previous: { pid: 100, name: 'Bobble' } }),
    ).toEqual({ kind: 'none' });
    expect(
      focusReturnDecision({ ...base, reason: 'escape', previous: null, frontmostPid: 100 }),
    ).toEqual({ kind: 'none' });
  });

  it('a test run never moves focus, whatever the reason', () => {
    for (const reason of ['escape', 'blur', 'open-in-main', 'paste', 'capture'] as const) {
      expect(focusReturnDecision({ ...base, reason, background: true })).toEqual({ kind: 'none' });
    }
  });
});
