import { describe, expect, it } from 'vitest';
import { menuPlacement } from './menu-placement.ts';

/*
 * The case that broke: a presentation card at the foot of the thread, the
 * thread's scroller ending at the composer's top edge. MEASURED in the running
 * app (open-buttons-probe, 1440×867 window): the card's control at y 615–643,
 * the scroller's visible band 48–702, a three-app "Open with" menu ~150px tall
 * — 55px below the control for it, 563px above.
 */
const THREAD = { top: 48, bottom: 702 };
const CARD_CONTROL = { top: 615, bottom: 643 };

describe('menuPlacement — a dropdown opens where it can be seen', () => {
  it('opens UPWARD from a card at the foot of the thread', () => {
    expect(menuPlacement({ control: CARD_CONTROL, menuHeight: 150, clip: THREAD, gap: 4 })).toEqual(
      { side: 'top' },
    );
  });

  it('keeps opening downward whenever it fits there (every other menu’s habit)', () => {
    expect(
      menuPlacement({
        control: { top: 45, bottom: 71 },
        menuHeight: 150,
        clip: { top: 0, bottom: 867 },
        gap: 4,
      }),
    ).toEqual({ side: 'bottom' });
  });

  it('when neither side holds it whole, takes the roomier side and scrolls within it', () => {
    expect(
      menuPlacement({
        control: { top: 150, bottom: 178 },
        menuHeight: 400,
        clip: { top: 0, bottom: 300 },
        gap: 4,
      }),
    ).toEqual({ side: 'top', maxHeight: 146 });
    expect(
      menuPlacement({
        control: { top: 100, bottom: 128 },
        menuHeight: 400,
        clip: { top: 0, bottom: 300 },
        gap: 4,
      }),
    ).toEqual({ side: 'bottom', maxHeight: 168 });
  });

  it('never squeezes a menu to nothing', () => {
    const p = menuPlacement({
      control: { top: 20, bottom: 48 },
      menuHeight: 400,
      clip: { top: 0, bottom: 60 },
      gap: 4,
    });
    expect(p.maxHeight).toBeGreaterThanOrEqual(96);
  });
});
