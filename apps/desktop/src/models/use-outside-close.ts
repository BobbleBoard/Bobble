/**
 * CLOSE ON AN OUTSIDE CLICK — WITHOUT A FULL-SCREEN OVERLAY.
 *
 * Every menu in the hub used the same trick: render an invisible
 * `fixed inset-0` <button> behind the panel so a click anywhere else closes it.
 * It works for clicks and quietly breaks everything else, because that element
 * is under the pointer for the whole screen:
 *
 *   The user: "needs to be able to scroll down the model card if the mouse is not
 *   over the dropdown while it's open… I hover over something, that's the thing
 *   I want to be scrolling, that's your guiding light no matter what."
 *
 * With the overlay there, the wheel lands on the overlay and nothing scrolls.
 * A document-level `pointerdown` listener closes on the same gesture and leaves
 * every other event alone, so the page under the menu still scrolls, still
 * hovers, and still shows its own cursors.
 *
 * `pointerdown` rather than `click`: a menu should close as the press begins,
 * which is what makes dismissing feel immediate rather than deferred to mouseup.
 * Capture phase, so a handler that stops propagation cannot strand the menu open.
 */
import { type RefObject, useEffect } from 'react';

export function useOutsideClose(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const root = ref.current;
      if (root === null) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      close();
    };
    // Escape closes too, and stops there — a menu inside a dialog should not
    // also dismiss the dialog with one press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}
