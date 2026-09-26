import { describe, expect, it } from 'vitest';
import { svgEngineFor } from './tools';

const both = { omnisvg: true, vfig: true };

describe('which model draws an svg', () => {
  it('a picture or a description is OmniSVG’s', () => {
    expect(
      svgEngineFor(
        { prompt: 'A red lighthouse on a green cliff, flat colours.', images: [] },
        both,
      ),
    ).toEqual({ engine: 'omnisvg' });
    expect(svgEngineFor({ images: ['cat.png'] }, both)).toEqual({ engine: 'omnisvg' });
  });

  it('a figure — said so, or named in the prompt — is VFIG’s, and so is every edit', () => {
    expect(svgEngineFor({ images: ['fig31.png'], figure: true }, both)).toEqual({ engine: 'vfig' });
    expect(svgEngineFor({ prompt: 'trace this diagram', images: ['gan.png'] }, both)).toEqual({
      engine: 'vfig',
    });
    expect(svgEngineFor({ images: ['sales-chart.png'] }, both)).toEqual({ engine: 'vfig' });
    expect(
      svgEngineFor({ prompt: 'make the flame gold', images: [], edit: 'logo.svg' }, both),
    ).toEqual({ engine: 'vfig' });
    // A description of a picture that mentions "text" is still a description: no picture to convert.
    expect(svgEngineFor({ prompt: 'a scroll with text on it', images: [] }, both)).toEqual({
      engine: 'omnisvg',
    });
  });

  it('says what to do instead when the model a job needs is not installed', () => {
    const r = svgEngineFor({ images: ['fig.png'], figure: true }, { omnisvg: true, vfig: false });
    expect('error' in r && r.error).toMatch(
      /needs VFIG, which is not installed here — for a diagram use the diagram command/,
    );
    const e = svgEngineFor(
      { prompt: 'x', images: [], edit: 'a.svg' },
      { omnisvg: true, vfig: false },
    );
    expect('error' in e && e.error).toMatch(/edit the file yourself/);
    expect(svgEngineFor({ images: ['cat.png'] }, { omnisvg: false, vfig: true })).toEqual({
      engine: 'vfig',
    });
  });
});
