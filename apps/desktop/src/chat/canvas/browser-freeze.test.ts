// @vitest-environment jsdom
/**
 * The `+` menu must not blank the page underneath it.
 *
 * the user: "browser tabs go blank when the + button is pressed?" They did — a
 * native WebContentsView paints above every DOM element, so the menu is
 * invisible until the page is taken down, and the page coming down left white.
 *
 * The two things that make it not-white are an ORDER (capture, paint, then
 * lower) and a CLEAR (put it back when the menu closes). Both are tested here
 * rather than in a probe because the pixels themselves cannot be captured from a
 * hidden window — the compositor for a native child view is not running — and a
 * probe that could only ever assert "no still appeared" would be asserting the
 * bug.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freezeFrame } from './freeze-frame';

describe('freezeFrame', () => {
  let el: HTMLElement;
  beforeEach(() => {
    el = document.createElement('div');
  });

  it('paints the still into the slot the view was covering', () => {
    freezeFrame(el, 'data:image/png;base64,AAAA');
    expect(el.getAttribute('data-frozen')).toBe('true');
    expect(el.style.background).toContain('data:image/png;base64,AAAA');
  });

  /* Pinned to the slot's WIDTH: that is the dimension that cannot change while
   * a menu is open, so the still cannot end up stretched. */
  it('pins the still to the slot width', () => {
    freezeFrame(el, 'data:image/png;base64,AAAA');
    expect(el.style.background).toContain('100%');
    expect(el.style.background).toContain('no-repeat');
  });

  it('clears completely when the menu closes', () => {
    freezeFrame(el, 'data:image/png;base64,AAAA');
    freezeFrame(el, null);
    expect(el.hasAttribute('data-frozen')).toBe(false);
    expect(el.style.background).toBe('');
  });

  /*
   * A capture that came back with nothing must leave the slot alone rather than
   * painting `url("")` over it — that is the degrade-to-today's-behaviour path,
   * and it has to be a real no-op.
   */
  it('treats an empty capture as no capture', () => {
    freezeFrame(el, '');
    expect(el.hasAttribute('data-frozen')).toBe(false);
  });

  it('does nothing at all when there is no slot', () => {
    expect(() => freezeFrame(undefined, 'data:image/png;base64,AAAA')).not.toThrow();
  });
});
