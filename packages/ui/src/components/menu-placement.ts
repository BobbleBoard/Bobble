/**
 * WHICH WAY A DROPDOWN OPENS — below its control when it fits, above when it
 * does not.
 *
 * SEEN 2026-09-23 (open-buttons-probe): a presentation card is the model's last
 * act, so it sits at the foot of the thread, right above the composer — and its
 * "Open with" menu opened DOWNWARD, past the bottom of the thread's scroller.
 * The rows below that edge were clipped away, and a click where they should
 * have been landed in the composer: "even with selection of specific
 * applications to open with" nothing opened. The menu has to open where it can
 * be seen.
 *
 * Pure, so the rule is unit-tested; {@link clipBounds} reads the one thing it
 * needs from the DOM.
 */

/** The vertical band a menu can be seen in (client coordinates). */
export interface VerticalBounds {
  readonly top: number;
  readonly bottom: number;
}

export interface MenuPlacementInput {
  /** The control the menu hangs from. */
  readonly control: VerticalBounds;
  /** The menu's full height, unconstrained. */
  readonly menuHeight: number;
  /** Where it can be seen: the nearest clipping ancestors ∩ the window. */
  readonly clip: VerticalBounds;
  /** Space between the control and the menu. */
  readonly gap: number;
}

export interface MenuPlacement {
  readonly side: 'bottom' | 'top';
  /** Set only when the menu cannot fit whole on either side — it scrolls then. */
  readonly maxHeight?: number;
}

/** Never squeeze a menu below this — two rows and a heading. */
const MIN_MENU_HEIGHT = 96;

/**
 * Below when it fits (the default every menu has always had), above when only
 * that fits, and when neither does, the roomier side with the menu scrolling
 * inside it — every row reachable either way.
 */
export function menuPlacement({
  control,
  menuHeight,
  clip,
  gap,
}: MenuPlacementInput): MenuPlacement {
  const below = clip.bottom - control.bottom - gap;
  const above = control.top - clip.top - gap;
  if (menuHeight <= below) return { side: 'bottom' };
  if (menuHeight <= above) return { side: 'top' };
  return above > below
    ? { side: 'top', maxHeight: Math.max(MIN_MENU_HEIGHT, Math.floor(above)) }
    : { side: 'bottom', maxHeight: Math.max(MIN_MENU_HEIGHT, Math.floor(below)) };
}

/**
 * The band an element's popover can be seen in: the window, narrowed by every
 * ancestor that clips its overflow (a scroller, an `overflow: hidden` rail).
 */
export function clipBounds(el: Element): VerticalBounds {
  let top = 0;
  let bottom = el.ownerDocument.defaultView?.innerHeight ?? Number.POSITIVE_INFINITY;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    const overflow = `${style?.overflowY ?? ''} ${style?.overflow ?? ''}`;
    if (!/(auto|scroll|hidden|clip)/.test(overflow)) continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}
