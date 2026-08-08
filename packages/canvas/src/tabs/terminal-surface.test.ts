// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE TERMINAL DRAWS NO RECTANGLE OF ITS OWN.
 *
 * the user, from a screenshot: "the terminal styling there's that akward border".
 *
 * MEASURED in the running app before touching anything: `.pd-terminal` computed
 * to `rgba(255, 255, 255, 0.04)` — `--pd-code-block-bg` is a translucent wash,
 * not a solid — inside `.pd-canvas-tabs` at `rgb(30,30,33)` with an 18px radius.
 * A square-cornered lighter box in a rounded panel, with xterm painting the same
 * token AGAIN on its own canvas. Two hard edges and a doubled wash.
 *
 * The fix is two changes in two packages that only work together: the CSS
 * surface is transparent AND xterm's theme background is transparent. Restore
 * either one alone and the seam is back, which is exactly the kind of pairing
 * that rots silently — hence this guard.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(dir, '..', 'styles.css'), 'utf8');
/* Cross-package on purpose: the invariant spans the two files. */
const surfaces = readFileSync(
  path.resolve(dir, '../../../../apps/desktop/src/chat/canvas/native-surfaces.ts'),
  'utf8',
);

/** The declaration block of the first rule whose selector matches exactly. */
function block(selector: string): string {
  const re = new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm');
  return re.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
}

describe('the terminal surface is transparent, in both halves', () => {
  it('the CSS surface paints no background', () => {
    expect(block('.pd-terminal')).toMatch(/background:\s*transparent/);
  });

  it('never goes back to painting the translucent code-block wash', () => {
    expect(block('.pd-terminal')).not.toMatch(/background:\s*var\(--pd-code-block-bg\)/);
  });

  it('xterm is transparent to match, or the seam returns', () => {
    expect(surfaces).toMatch(/allowTransparency:\s*true/);
    expect(surfaces).toMatch(/const bg = 'rgba\(0, 0, 0, 0\)'/);
  });

  /* The caret is the other half of the same complaint: "the cursor should be a
   * single blinking | instead of the thick terminal like thing". xterm draws a
   * hollow BLOCK when unfocused regardless of cursorStyle, and the pane is
   * unfocused most of the time anyone is looking at it. */
  it('keeps the caret a bar whether or not the pane has focus', () => {
    expect(surfaces).toMatch(/cursorStyle:\s*'bar'/);
    expect(surfaces).toMatch(/cursorInactiveStyle:\s*'bar'/);
  });
});
