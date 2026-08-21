import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R14 Lane C — shell + scroll geometry guards.
 *
 * The visual result of these three fixes is owner-validated FEEL, but each rests
 * on a specific CSS contract that a later refactor could silently undo. These
 * tests pin those contracts against apps/desktop global.css:
 *   C1  the collapsed-rail card chrome (bg + flavor edge) moved OFF the
 *       full-height .pd-sidebar shell onto the inner .pd-rail, so the visible
 *       card top drops below the traffic-light strip (shell stays transparent).
 *   C2  the thread scroll HARD-STOPS at its edges — overscroll-behavior:none and
 *       no `.pd-elastic-content` JS rubber-band wrapper remains.
 *   C3  the rail button centers its 40px hover/active wash on the glyph (no
 *       left-anchored padding-left that pushed the wash off to the left).
 */

const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'global.css');
// Strip block comments so quoted values in prose can never match a rule.
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block for the FIRST rule whose selector text contains the
 *  given literal (which is also the first such rule in source order). */
function block(selectorLiteral: string): string {
  const at = css.indexOf(selectorLiteral);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) return '';
  return css.slice(open + 1, close);
}

describe('R14-C shell + scroll styles', () => {
  describe('C2 — hard-stop scroll', () => {
    it('the thread scroller uses overscroll-behavior:none (no bounce, no chaining)', () => {
      expect(block('.pd-elastic-scroll')).toMatch(/overscroll-behavior:\s*none/);
    });

    it('drops the old elastic containment + JS transform wrapper', () => {
      // SCOPED TO THE THREAD SCROLLER, which is what this guard is about. The
      // assertion used to scan the whole stylesheet for
      // `overscroll-behavior: contain`, and that is too wide a net: a nested
      // scroller inside a popup — the quick menu's model list — needs
      // containment precisely so a flick that reaches its end does not scroll
      // the page underneath. Banning the property everywhere would forbid the
      // correct use in order to catch the incorrect one.
      expect(block('.pd-elastic-scroll')).not.toMatch(/overscroll-behavior:\s*contain/);
      // The JS rubber-band rode on `.pd-elastic-content { will-change: transform }`.
      expect(css).not.toContain('.pd-elastic-content');
    });
  });

  describe('C3 — rail button hover wash centering', () => {
    it('centers the 40px button (its wash) in the rail', () => {
      expect(block('.pd-rail-btn ')).toMatch(/justify-content:\s*center/);
    });

    it('no longer left-anchors the glyph with padding-left', () => {
      // The base .pd-rail-btn rule (first `.pd-rail-btn` occurrence) must not
      // re-introduce the left padding that shoved the wash left of the glyph.
      expect(block('.pd-rail-btn ')).not.toMatch(/padding-left/);
    });
  });

  /*
   * The close the user sent back: "left sidebar does not close cleanly, it's instant
   * dissapear and then slide left rather than the correct slide in like the
   * canvas sidebar does."
   *
   * The panel had been leaving the DOM on the closing frame while the slot's
   * width animated on alone, so what slid was an empty gap. The fix is a pair of
   * curves that have to stay a pair: the slot's width and the panel's transform,
   * same duration token, same easing, both keyed off the SLOT's `data-open` so
   * they start on the same frame. Break either half — retime one, or drop the
   * `@starting-style` that gives a freshly mounted panel something to slide FROM
   * — and the animation degrades quietly, which is exactly how it shipped last
   * time. Hence these.
   */
  describe('sidebar slide — the panel rides the closing edge', () => {
    it('the slot animates its width, and clips while it does', () => {
      expect(block('.pd-sidebar-slot ')).toMatch(
        /transition:\s*width var\(--pd-duration-slow/,
      );
      expect(block('.pd-sidebar-slot[data-open="false"] {')).toMatch(/overflow:\s*hidden/);
      expect(block('.pd-sidebar-slot[data-open="false"] {')).toMatch(/width:\s*0/);
    });

    it('the panel parks off the left edge, driven by the SLOT (same frame)', () => {
      const parked = block('.pd-sidebar-slot[data-open="false"] .pd-sidebar');
      expect(parked).toMatch(/transform:\s*translateX\(-100%\)/);
      expect(parked).toMatch(/pointer-events:\s*none/);
    });

    it('a freshly mounted panel has a from-frame, so OPENING slides too', () => {
      expect(css).toMatch(
        /@starting-style\s*\{[\s\S]*?\.pd-sidebar-slot\[data-open="true"\] \.pd-sidebar\s*\{[\s\S]*?translateX\(-100%\)/,
      );
    });
  });

  describe('C1 — collapsed rail card chrome moved onto .pd-rail', () => {
    it('the full-height shell is transparent + chrome-less when collapsed', () => {
      const shell = block('.pd-sidebar[data-open="false"]');
      expect(shell).toMatch(/background:\s*transparent/);
      expect(shell).toMatch(/box-shadow:\s*none/);
      // The shell still runs the full height (rail-height contract).
      expect(shell).toMatch(/height:\s*100%/);
    });

    it('the .pd-rail carries the visible card background', () => {
      expect(block('.pd-rail ')).toMatch(/background:\s*var\(--pd-bg-sidebar\)/);
    });

    it('claude gives .pd-rail the floating rounded/bordered card chrome', () => {
      const claudeRail = block(':root[data-flavor="claude"] .pd-rail');
      expect(claudeRail).toMatch(/border-radius/);
      expect(claudeRail).toMatch(/box-shadow/);
    });
  });
});
