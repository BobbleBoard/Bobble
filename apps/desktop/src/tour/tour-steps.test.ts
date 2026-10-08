import { describe, expect, it } from 'vitest';
import { type Box, isShown, placeCard, resolveSteps, screenOf, TOUR_STEPS } from './tour-steps';

const docWith = (...present: string[]) => ({
  querySelector: (sel: string) => (present.some((p) => sel.includes(p)) ? ({} as Element) : null),
});
const VIEW = { width: 1280, height: 800 };

describe('screenOf — the tour is the screen that is showing', () => {
  it('reads each content route off its root, and the chat otherwise', () => {
    expect(screenOf(docWith('tp-root'))).toBe('studio3d');
    expect(screenOf(docWith('models-view'))).toBe('models');
    expect(screenOf(docWith('scheduled-view'))).toBe('scheduled');
    expect(screenOf(docWith('connectors-search'))).toBe('extensions');
    expect(screenOf(docWith())).toBe('chat');
  });
});

describe('resolveSteps — a control that is not on screen is skipped', () => {
  it('keeps only steps with a visible target, with the first selector that lands', () => {
    const boxes: Record<string, Box> = {
      '[data-testid="footer-model-chip"]': { x: 900, y: 700, width: 80, height: 28 },
      '[data-testid="new-chat"]': { x: 16, y: 120, width: 220, height: 30 },
      // zero-sized: present in the DOM, not on screen
      '[data-testid="composer-effort"]': { x: 950, y: 700, width: 0, height: 0 },
    };
    const got = resolveSteps(TOUR_STEPS.chat, (s) => boxes[s] ?? null, VIEW);
    expect(got.map((g) => g.step.id)).toEqual(['model', 'new-chat']);
    // The model step fell through its first selector to the second.
    expect(got[0]?.selector).toBe('[data-testid="footer-model-chip"]');
  });

  it('every screen has steps, every step a target, and the words follow the voice', () => {
    for (const steps of Object.values(TOUR_STEPS)) {
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) {
        expect(s.targets.length).toBeGreaterThan(0);
        expect(s.title).not.toMatch(/!/);
        expect(s.body).not.toMatch(/!/);
        // Sentence case: the title's first letter is upper, the rest of each word not shouted.
        expect(s.title[0]).toBe(s.title[0]?.toUpperCase());
      }
    }
  });
});

describe('isShown', () => {
  it('needs a real size inside the window', () => {
    expect(isShown(null, VIEW)).toBe(false);
    expect(isShown({ x: 10, y: 10, width: 2, height: 40 }, VIEW)).toBe(false);
    expect(isShown({ x: 2000, y: 10, width: 40, height: 40 }, VIEW)).toBe(false);
    expect(isShown({ x: 10, y: 10, width: 40, height: 40 }, VIEW)).toBe(true);
  });
});

describe('placeCard — the side with room, the notch at the target', () => {
  const card = { width: 300, height: 150 };
  it('goes right of a sidebar row, notch at the row', () => {
    const p = placeCard({ x: 10, y: 300, width: 220, height: 32 }, card, VIEW);
    expect(p.side).toBe('right');
    expect(p.x).toBeGreaterThan(230);
    expect(p.y + p.notch).toBeCloseTo(316, 0);
  });
  it('goes above a wide control at the bottom (the composer)', () => {
    const p = placeCard({ x: 300, y: 680, width: 900, height: 100 }, card, VIEW);
    expect(p.side).toBe('above');
    expect(p.y + card.height).toBeLessThanOrEqual(680);
  });
  it('goes below a wide control near the top', () => {
    const p = placeCard({ x: 300, y: 120, width: 800, height: 40 }, card, VIEW);
    expect(p.side).toBe('below');
  });
  it('stays inside the window', () => {
    const p = placeCard({ x: 1100, y: 760, width: 150, height: 30 }, card, VIEW);
    expect(p.x).toBeGreaterThanOrEqual(12);
    expect(p.x + card.width).toBeLessThanOrEqual(VIEW.width - 12);
    expect(p.y).toBeGreaterThanOrEqual(12);
  });
});
