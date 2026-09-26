import { describe, expect, it } from 'vitest';
import { announcedNextStep, announcedStepNudge } from './announced-step.js';

describe('a turn that ends by announcing its next step', () => {
  it('reads the step the 4B promised and never took (visual suite, verbatim)', () => {
    const icons =
      'The svg command seems to have generated something, but I need to check what was actually created and whether it contains the six icons the user requested. Let me present the SVG file to see what was generated.';
    expect(announcedNextStep(icons)).toBe('Let me present the SVG file to see what was generated');
    expect(
      announcedNextStep(
        'The preview showed a blank page. Let me open the file properly in the browser to verify it renders correctly.',
      ),
    ).toBe('Let me open the file properly in the browser to verify it renders correctly');
    expect(announcedNextStep("Now I'll fix the colours.")).toBe("Now I'll fix the colours");
  });

  it('leaves an ending that is not a next step alone', () => {
    expect(
      announcedNextStep('Done — the chart is in the canvas. Let me know if you want changes.'),
    ).toBeNull();
    expect(announcedNextStep('Should I present it now?')).toBeNull();
    expect(
      announcedNextStep('I checked every page and fixed the header. All six icons are in icons/.'),
    ).toBeNull();
    expect(
      announcedNextStep(
        'Let me present it: first I read the file. Then I wrote the page. It is finished.',
      ),
    ).toBeNull();
    expect(announcedNextStep('')).toBeNull();
  });

  it('says what was promised, and to do it', () => {
    expect(announcedStepNudge('Let me present the SVG file')).toContain(
      '"Let me present the SVG file"',
    );
  });
});
