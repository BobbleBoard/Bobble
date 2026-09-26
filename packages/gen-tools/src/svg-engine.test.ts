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

describe('a picture to trace, named relative to the working folder', () => {
  it('reaches the app as the file in that folder, and a missing one is named', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { registerGenTools } = await import('./tools');
    const root = mkdtempSync(path.join(tmpdir(), 'svg-pic-'));
    writeFileSync(path.join(root, 'fig.png'), 'x');
    const sent: unknown[] = [];
    const tools: Array<{
      name: string;
      execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }>;
    }> = [];
    const prev = process.env.PI_DESKTOP_WORKSPACE_ROOT;
    process.env.PI_DESKTOP_WORKSPACE_ROOT = root;
    try {
      registerGenTools({ registerTool: (d: never) => tools.push(d) } as never, {
        bridge: {
          request: async (_m: string, p: unknown) => {
            sent.push(p);
            return { outputs: [] };
          },
        } as never,
        media: false,
        svgEngines: { omnisvg: true, vfig: true },
      });
      const svg = tools.find((t) => t.name === 'generate_svg');
      await svg?.execute('id', { image: 'fig.png', figure: true });
      expect(sent[0]).toMatchObject({ engine: 'vfig', images: [path.join(root, 'fig.png')] });
      const missing = await svg?.execute('id', { image: 'nope.png' });
      expect(missing?.content[0]?.text).toMatch(/there is no picture at nope\.png/);
    } finally {
      if (prev === undefined) delete process.env.PI_DESKTOP_WORKSPACE_ROOT;
      else process.env.PI_DESKTOP_WORKSPACE_ROOT = prev;
    }
  });
});
