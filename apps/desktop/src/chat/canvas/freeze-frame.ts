/**
 * A LOWERED NATIVE VIEW LEAVES A HOLE — so leave the last frame in it.
 *
 * The user: "browser tabs go blank when the + button is pressed?" They did, and for
 * a real reason: a native WebContentsView paints above every DOM element in the
 * window, so the `+` menu is invisible under the page unless the page is taken
 * down first. The page coming down is correct; the page coming down and leaving
 * white is what makes it look like the tab crashed.
 *
 * Its own module, with no imports, so the rule can be tested in plain Node —
 * native-surfaces drags xterm in with it, and the pixels themselves cannot be
 * captured from a hidden window anyway (a native child view's compositor is not
 * running), so this IS where the behaviour gets checked.
 */

/**
 * Paint a still of a native view into the DOM slot it was covering, or clear it.
 *
 * The slot exists precisely to be that view's stand-in for layout, so it is also
 * the honest place to stand in for it visually while the view is down.
 * `background-size: 100% auto` pins the still to the slot's WIDTH, the one
 * dimension that cannot change while a menu is open.
 *
 * An empty capture is treated as no capture: better to fall back to today's
 * blank than to paint `url("")` over the slot.
 */
export function freezeFrame(el: HTMLElement | undefined, dataUrl: string | null): void {
  if (el === undefined) return;
  if (dataUrl === null || dataUrl === '') {
    el.style.background = '';
    el.removeAttribute('data-frozen');
    return;
  }
  el.style.background = `top left / 100% auto no-repeat url("${dataUrl}")`;
  el.setAttribute('data-frozen', 'true');
}
