import { describe, expect, it } from 'vitest';
import {
  htmlWidget,
  INLINE_HTML_MAX_BYTES,
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
  kit: 'paper-blue',
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
      kit: 'paper-blue',
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

describe('htmlWidget — an interactive widget in the chat, a site in the canvas', () => {
  const widget = `<!doctype html><html><head><title>Gradient descent</title>
<style>body{margin:0;font:14px system-ui}</style></head><body>
<canvas id="c" width="480" height="240"></canvas><input type="range" id="lr" min="0" max="1" step="0.01">
<script>const c=document.getElementById('c');/* draws the loss curve */</script></body></html>`;

  it('keeps a small, self-contained, interactive page as a widget, titled', () => {
    expect(htmlWidget(widget)).toEqual({ text: widget, title: 'Gradient descent' });
  });

  it('lets a page load from the web (a CDN script) and still be one file', () => {
    const cdn = widget.replace(
      '<script>',
      '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script><script>',
    );
    expect(htmlWidget(cdn)).not.toBeNull();
  });

  it('sends a page with files beside it to the canvas (a stylesheet, an image, a link)', () => {
    expect(
      htmlWidget(widget.replace('<style>', '<link rel="stylesheet" href="styles.css"><style>')),
    ).toBeNull();
    expect(htmlWidget(widget.replace('<canvas', '<img src="assets/hero.jpg"><canvas'))).toBeNull();
    expect(htmlWidget(widget.replace('body{', 'body{background:url(bg.png);'))).toBeNull();
  });

  it('sends a web page to the canvas: navigation, a header and footer, a stack of sections', () => {
    expect(
      htmlWidget(widget.replace('<canvas', '<nav><a href="#a">A</a></nav><canvas')),
    ).toBeNull();
    expect(
      htmlWidget(widget.replace('<canvas', '<header>h</header><footer>f</footer><canvas')),
    ).toBeNull();
    expect(
      htmlWidget(
        widget.replace(
          '<canvas',
          '<section></section><section></section><section></section><canvas',
        ),
      ),
    ).toBeNull();
  });

  it('sends a page with nothing to interact with, or a heavy one, to the canvas', () => {
    expect(htmlWidget('<html><body><p>Just words.</p></body></html>')).toBeNull();
    expect(htmlWidget(widget + ' '.repeat(INLINE_HTML_MAX_BYTES))).toBeNull();
  });

  it('keeps an explanation the math command drew inline — heavy with KaTeX fonts, steps in a nav', () => {
    // The user (2026-10-01): "explanation should be inline".
    const page = `<!doctype html><html><head><title>Why the Area of a Circle is πr²</title><style>${'@font-face{}'.repeat(30_000)}</style></head><body><main class="mv"><figure class="mv-panel" data-mv-panel><svg></svg></figure><nav class="mv-nav"><button>Next</button></nav></main><script>mvMount()</script></body></html>`;
    expect(page.length).toBeGreaterThan(INLINE_HTML_MAX_BYTES);
    const w = htmlWidget(page);
    expect(w?.explanation).toBe(true);
    expect(w?.title).toBe('Why the Area of a Circle is πr²');
  });

  it('carries the explanation’s spec as its raw view, when it sits beside the page', async () => {
    const page = '<figure data-mv-panel><svg></svg></figure><script></script>';
    const files: Record<string, string> = {
      '/w/circle.html': page,
      '/w/circle.math.json': '{"title":"Circle"}',
    };
    const out = await presentInlinePayload('/w/circle.html', async (p) => {
      const f = files[p];
      if (f === undefined) throw new Error('ENOENT');
      return f;
    });
    expect(out.html?.explanation).toBe(true);
    expect(out.html?.spec).toBe('{"title":"Circle"}');
    const alone = await presentInlinePayload('/w/other.html', async (p) => {
      if (p.endsWith('.html')) return page;
      throw new Error('ENOENT');
    });
    expect(alone.html?.explanation).toBe(true);
    expect(alone.html?.spec).toBeUndefined();
  });

  it('comes through presentInlinePayload for a presented .html', async () => {
    const out = await presentInlinePayload('/w/grad.html', async () => widget);
    expect(out.html?.title).toBe('Gradient descent');
    const site = await presentInlinePayload(
      '/w/index.html',
      async () => '<nav></nav><script></script>',
    );
    expect(site.html).toBeUndefined();
  });
});
