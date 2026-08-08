import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconCheckCircle, IconCpu, IconDownload, IconShield, IconWarning } from './icons';

/**
 * THE APP-LOCAL ICONS ARE PART OF THE SHARED SET, OR THEY ARE NOT.
 *
 * This module's own docstring promises these glyphs "compose identically" with
 * @pi-desktop/ui's frozen set — and for a long time they did not, because the
 * wrapper omitted the `.pd-icon` class the shared one applies. Two consequences,
 * both invisible until one of these sat beside a shared glyph:
 *
 *   - they never picked up `--pd-icon-stroke`, so they drew at a fixed 1.5
 *     while the rest of the app followed the flavor token;
 *   - no `.pd-icon` sizing rule could reach them. MEASURED in the collapsed
 *     rail: five icons moved to 18px and Model-management stayed at 16px,
 *     because it is the one icon on that rail from this file.
 *
 * A promise in a comment is not a mechanism. This is the mechanism.
 */
describe('app-local settings icons carry .pd-icon', () => {
  const icons = { IconCpu, IconDownload, IconWarning, IconShield, IconCheckCircle };

  for (const [name, Icon] of Object.entries(icons)) {
    it(`${name} is a .pd-icon like every shared glyph`, () => {
      expect(renderToStaticMarkup(<Icon />)).toContain('pd-icon');
    });
  }

  it('keeps a caller-supplied className alongside it, never instead of it', () => {
    const html = renderToStaticMarkup(<IconCpu className="text-red" />);
    expect(html).toContain('pd-icon');
    expect(html).toContain('text-red');
  });

  /* The `size` prop still works for callers outside a `.pd-icon` sizing rule. */
  it('still honours an explicit size', () => {
    expect(renderToStaticMarkup(<IconCpu size={13} />)).toContain('width="13"');
  });
});
