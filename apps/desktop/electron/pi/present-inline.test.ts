import { describe, expect, it } from 'vitest';
import {
  INLINE_SVG_MAX_BYTES,
  presentInlinePayload,
  readDiagramCard,
  svgIsInlineSized,
  svgSize,
} from './present-inline';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle r="4"/></svg>';
const POSTER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><rect width="10" height="10"/></svg>';
const CHART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560"></svg>';
const SPEC = '{"type":"bar","title":"Units","labels":["a"],"values":[1]}';

function reader(files: Record<string, string>) {
  return async (p: string): Promise<string> => {
    const text = files[p];
    if (text === undefined) throw new Error(`ENOENT ${p}`);
    return text;
  };
}

describe('svgSize', () => {
  it('reads width/height attributes, else the viewBox', () => {
    expect(svgSize(ICON)).toEqual({ width: 64, height: 64 });
    expect(svgSize(POSTER)).toEqual({ width: 1920, height: 1080 });
    expect(svgSize('<svg viewBox="0 0 100 50" width="200px"><g/></svg>')).toEqual({
      width: 200,
      height: 50,
    });
    expect(svgSize('<div>not svg</div>')).toBeNull();
  });
});

describe('svgIsInlineSized', () => {
  it('icon-sized and light stays inline; a poster or a heavy file goes to the canvas', () => {
    expect(svgIsInlineSized({ width: 64, height: 64, bytes: 500 })).toBe(true);
    expect(svgIsInlineSized({ width: 512, height: 300, bytes: 1000 })).toBe(true);
    expect(svgIsInlineSized({ width: 513, height: 300, bytes: 1000 })).toBe(false);
    expect(svgIsInlineSized({ width: 64, height: 64, bytes: INLINE_SVG_MAX_BYTES + 1 })).toBe(
      false,
    );
  });
});

describe('presentInlinePayload', () => {
  it('a chart SVG carries its spec from the sidecar, never its markup', async () => {
    const files = { '/ws/units.svg': CHART_SVG, '/ws/units.chart.json': SPEC };
    const payload = await presentInlinePayload('/ws/units.svg', reader(files));
    expect(payload.chart).toMatchObject({ type: 'bar', title: 'Units' });
    expect(payload.svg).toMatchObject({ width: 960, height: 560 });
    expect(payload.svg?.text).toBeUndefined();
  });

  it('a presented sidecar itself is the chart', async () => {
    const payload = await presentInlinePayload(
      '/ws/units.chart.json',
      reader({
        '/ws/units.chart.json': SPEC,
      }),
    );
    expect(payload.chart).toMatchObject({ type: 'bar' });
    expect(payload.svg).toBeUndefined();
  });

  it('a small SVG travels with its markup; a poster with its size only', async () => {
    const small = await presentInlinePayload('/ws/icon.svg', reader({ '/ws/icon.svg': ICON }));
    expect(small.svg?.text).toBe(ICON);
    expect(small.chart).toBeUndefined();
    const big = await presentInlinePayload('/ws/poster.svg', reader({ '/ws/poster.svg': POSTER }));
    expect(big.svg).toEqual({ width: 1920, height: 1080, bytes: Buffer.byteLength(POSTER) });
  });

  it('anything else is the plain card', async () => {
    expect(await presentInlinePayload('/ws/deck.pptx', reader({}))).toEqual({});
    expect(await presentInlinePayload('/ws/missing.svg', reader({}))).toEqual({});
  });
});

/** The `diagram` tool's three files (VQ-10): the light drawing, the source, the card's sidecar. */
const DIAGRAM_LIGHT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1332" height="322"><rect fill="#FBFAF7"/></svg>';
const DIAGRAM_SIDE = JSON.stringify({
  schema: 1,
  title: 'Order fulfilment',
  kind: 'flowchart',
  kit: 'paper-teal',
  look: 'clean',
  source: 'flowchart LR\n  A --> B',
  nodes: ['A', 'B'],
  edges: 1,
  light: { width: 1332, height: 322, paper: '#FBFAF7' },
  dark: {
    width: 1332,
    height: 322,
    paper: '#191816',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1332" height="322"><rect fill="#191816"/></svg>',
  },
});

describe('a presented diagram', () => {
  it('carries both drawings, the source and the papers, never the plain-svg payload', async () => {
    const payload = await presentInlinePayload(
      '/ws/order-fulfilment.svg',
      reader({
        '/ws/order-fulfilment.svg': DIAGRAM_LIGHT,
        '/ws/order-fulfilment.diagram.json': DIAGRAM_SIDE,
      }),
    );
    expect(payload.svg).toBeUndefined();
    expect(payload.diagram).toMatchObject({
      title: 'Order fulfilment',
      kind: 'flowchart',
      kit: 'paper-teal',
      source: 'flowchart LR\n  A --> B',
      light: { svg: DIAGRAM_LIGHT, width: 1332, height: 322, paper: '#FBFAF7' },
      dark: { width: 1332, height: 322, paper: '#191816' },
    });
    expect(payload.diagram?.dark.svg).toContain('#191816');
  });

  it('a sidecar it cannot trust is ignored: the drawing is then a plain (poster-sized) SVG', async () => {
    const broken = JSON.stringify({
      title: 'x',
      light: { width: 10 },
      dark: { width: 10, height: 10 },
    });
    const payload = await presentInlinePayload(
      '/ws/x.svg',
      reader({ '/ws/x.svg': DIAGRAM_LIGHT, '/ws/x.diagram.json': broken }),
    );
    expect(payload.diagram).toBeUndefined();
    expect(payload.svg).toMatchObject({ width: 1332, height: 322 });
  });

  it('readDiagramCard reads the same files for a chat reopened later (the renderer’s path)', async () => {
    const card = await readDiagramCard(
      '/ws/order-fulfilment.svg',
      DIAGRAM_LIGHT,
      reader({ '/ws/order-fulfilment.diagram.json': DIAGRAM_SIDE }),
    );
    expect(card?.title).toBe('Order fulfilment');
    expect(await readDiagramCard('/ws/order-fulfilment.svg', 'not svg', reader({}))).toBeNull();
  });
});
