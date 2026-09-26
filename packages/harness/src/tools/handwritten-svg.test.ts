import { describe, expect, it } from 'vitest';
import {
  countInlineDrawnSvgs,
  handwrittenDiagramRefusal,
  handwrittenInlineSvgRefusal,
  handwrittenMathRefusal,
  handwrittenSvgRefusal,
  handwrittenSvgRoute,
  hasHandwrittenInlineSvg,
  inlineSvgRoute,
  isDiagramShaped,
  isHandwrittenSvg,
} from './handwritten-svg.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M1 1"/></svg>';

describe('isHandwrittenSvg', () => {
  it('lets a drawing through now — the model writes SVG and present shows it back (2026-09-24)', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: svg,
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });

  it('is nothing without the command — there is nothing to point at', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: svg,
        exists: false,
        svgCommandAvailable: false,
      }),
    ).toBe(false);
  });

  it('leaves an existing file alone: rewriting is editing', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: svg,
        exists: true,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });

  it('only fires on markup, and only on a .svg path', () => {
    expect(
      isHandwrittenSvg({
        path: 'notes.svg',
        content: 'todo: draw a heart',
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
    expect(
      isHandwrittenSvg({
        path: 'index.html',
        content: `<div>${svg}</div>`,
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });
});

describe('hasHandwrittenInlineSvg', () => {
  const page = `<!doctype html><header><a class="logo">${svg}</a></header><main>text</main>`;

  it("a page's own inline logo and icons are the page's (2026-09-24)", () => {
    expect(
      hasHandwrittenInlineSvg({ path: 'index.html', content: page, svgCommandAvailable: true }),
    ).toBe(false);
    expect(countInlineDrawnSvgs(`${page}${svg}<svg viewBox="0 0 1 1"><circle r="1"/></svg>`)).toBe(
      3,
    );
  });

  it('ignores an <svg> that draws nothing: a sprite <use>, an empty wrapper', () => {
    const sprite = '<svg class="icon"><use href="#gear"/></svg>';
    expect(
      hasHandwrittenInlineSvg({ path: 'index.html', content: sprite, svgCommandAvailable: true }),
    ).toBe(false);
    expect(
      hasHandwrittenInlineSvg({
        path: 'a.tsx',
        content: '<svg viewBox="0 0 1 1"></svg>',
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });

  it('leaves a page alone when the command is off, and leaves .svg files to the other check', () => {
    expect(
      hasHandwrittenInlineSvg({ path: 'index.html', content: page, svgCommandAvailable: false }),
    ).toBe(false);
    expect(
      hasHandwrittenInlineSvg({ path: 'logo.svg', content: svg, svgCommandAvailable: true }),
    ).toBe(false);
  });

  it('is not fooled by an <img src="x.svg"> — that is the right way', () => {
    expect(
      hasHandwrittenInlineSvg({
        path: 'index.html',
        content: '<img src="assets/logo.svg" alt="logo">',
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });
});

describe('refusals', () => {
  it('name the command, the call shape with --out, and the way through', () => {
    const r = handwrittenSvgRefusal('heart.svg');
    expect(r).toContain('svg "a red heart');
    expect(r).toContain('--out heart.svg');
    expect(r).toContain('UNCHANGED');
    const p = handwrittenInlineSvgRefusal('index.html', 2, false);
    expect(p).toContain('2 SVG graphics drawn by hand');
    expect(p).toContain('--out assets/logo.svg');
    expect(p).toContain('<img src="assets/logo.svg"');
    expect(handwrittenInlineSvgRefusal('index.html', 1, true)).toContain('Not edited');
  });
});

describe('isHandwrittenSvg — when the markup is what was asked for', () => {
  // The exact shape of the user's sample.svg (2026-09-17): a prolog, a comment
  // block that titles itself, then the markup — the file WAS the answer.
  const lesson = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!--',
    '  SVG File Format Examples',
    '  ------------------------',
    '  Common formatting conventions for SVG files.',
    '-->',
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">',
    '  <rect x="10" y="10" width="50" height="50"/>',
    '</svg>',
  ].join('\n');
  const bare = svg;

  it('lets a self-explaining file through, whatever it is called', () => {
    expect(
      isHandwrittenSvg({
        path: 'shapes.svg',
        content: lesson,
        exists: false,
        svgCommandAvailable: true,
      }),
    ).toBe(false);
  });

  it('lets a sample/template/fixture through by its name', () => {
    for (const path of [
      'sample.svg',
      'examples/icon-template.svg',
      'fixtures/tiny.svg',
      'demo.svg',
    ]) {
      expect(
        isHandwrittenSvg({ path, content: bare, exists: false, svgCommandAvailable: true }),
      ).toBe(false);
    }
  });

  it('lets bare markup through when the person asked about SVG as a format', () => {
    for (const request of [
      'show me how svg is generlaly formatted',
      'what does the syntax of an SVG look like?',
      'give me an example svg file',
      'explain svg markup',
    ]) {
      expect(
        isHandwrittenSvg({
          path: 'shapes.svg',
          content: bare,
          exists: false,
          svgCommandAvailable: true,
          request,
        }),
      ).toBe(false);
    }
  });

  it("a hand-drawn picture asked for as a picture is the model's to write now", () => {
    for (const request of [
      'make me an svg icon of a red heart',
      'draw a logo for my coffee shop',
    ]) {
      expect(
        isHandwrittenSvg({
          path: 'heart.svg',
          content: bare,
          exists: false,
          svgCommandAvailable: true,
          request,
        }),
      ).toBe(false);
    }
  });

  it('a one-word comment changes nothing either way', () => {
    expect(
      isHandwrittenSvg({
        path: 'heart.svg',
        content: '<!-- heart --><svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>',
        exists: false,
        svgCommandAvailable: true,
        request: 'make me an svg icon of a red heart',
      }),
    ).toBe(false);
  });
});

/**
 * VQ-10 — A DIAGRAM TYPED AS SVG GOES TO `diagram`, NOT OMNISVG.
 *
 * The fixture is the start of the REAL 4B's own flow.svg (the diagram-turn
 * probe on main, 2026-09-24, the research's §2.2.3 brief): circles and boxes,
 * lines and arrowhead polygons, two-line labels — and a comment on every step,
 * which the old guard read as teaching material and let through.
 */
const REAL_4B_FLOW = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450" font-family="Arial, sans-serif">',
  '  <!-- Background -->',
  '  <rect width="900" height="450" fill="#ffffff"/>',
  '  <!-- Process Flow -->',
  '  <g font-size="14">',
  '    <!-- Step 1: Order Placed -->',
  '    <circle cx="100" cy="150" r="40" fill="#4CAF50"/>',
  '    <text x="100" y="145" text-anchor="middle" fill="white" font-weight="bold">Order</text>',
  '    <text x="100" y="165" text-anchor="middle" fill="white">Placed</text>',
  '    <!-- Arrow to Payment Check -->',
  '    <line x1="140" y1="150" x2="250" y2="150" stroke="#333" stroke-width="2"/>',
  '    <polygon points="250,150 240,140 240,160" fill="#333"/>',
  '    <!-- Step 2: Payment Check -->',
  '    <rect x="260" y="120" width="120" height="60" rx="5" fill="#2196F3"/>',
  '    <text x="320" y="140" text-anchor="middle" fill="white" font-weight="bold">Payment</text>',
  '    <text x="320" y="155" text-anchor="middle" fill="white">Check</text>',
  '  </g>',
  '</svg>',
].join('\n');

describe('a diagram drawn by hand routes to the diagram tool', () => {
  const base = {
    path: 'assets/order-fulfillment-flow.svg',
    content: REAL_4B_FLOW,
    exists: false,
    svgCommandAvailable: true,
    diagramAvailable: true,
    request:
      'Draw a flow diagram of our order fulfilment process: order placed → payment check → pick & pack → ship.',
  };

  it('is diagram-shaped: labels in boxes, joined by lines', () => {
    expect(isDiagramShaped(REAL_4B_FLOW)).toBe(true);
    expect(isDiagramShaped(svg)).toBe(false);
  });

  it('refuses toward `diagram` — its comments do not excuse it, and nor does an existing file', () => {
    expect(handwrittenSvgRoute(base)).toBe('diagram');
    // MEASURED: the model ran `svg` first, then typed its own file over the result.
    expect(handwrittenSvgRoute({ ...base, exists: true })).toBe('diagram');
    // …with OmniSVG absent too: there is still somewhere to send it.
    expect(handwrittenSvgRoute({ ...base, svgCommandAvailable: false })).toBe('diagram');
    expect(isHandwrittenSvg(base)).toBe(true);
  });

  it('still lets a sample through, and a question about SVG as a format', () => {
    expect(handwrittenSvgRoute({ ...base, path: 'examples/flow-sample.svg' })).toBeNull();
    expect(
      handwrittenSvgRoute({ ...base, request: 'show me an example of svg markup for a flow' }),
    ).toBeNull();
  });

  it('markup that moves is not a diagram — Mermaid cannot animate it', () => {
    /* MEASURED (4B, the visual suite): the Pythagorean rearrangement — squares,
       triangles, labels and four <animate>s — was refused toward Mermaid. */
    const proof =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 550">' +
      '<text x="350" y="30">Pythagorean Theorem</text><text x="255" y="240">c²</text>' +
      '<text x="50" y="80">Arrangement 2</text>' +
      '<rect x="50" y="100" width="300" height="300"/><rect x="130" y="180" width="220" height="220"/>' +
      '<polygon points="80,130 130,180 280,130"/><line x1="80" y1="130" x2="480" y2="320"/>' +
      '<animate attributeName="opacity" values="0;1;1" dur="4s" fill="freeze"/></svg>';
    expect(isDiagramShaped(proof.replace(/<animate[^>]*>/, ''))).toBe(true);
    expect(isDiagramShaped(proof)).toBe(false);
    expect(
      handwrittenSvgRoute({ ...base, path: 'animation/02.svg', content: proof, request: '' }),
    ).toBeNull();
    // CSS keyframes are motion too.
    const css = `<style>@keyframes a { to { opacity: 1 } }</style>${REAL_4B_FLOW}`;
    expect(isDiagramShaped(REAL_4B_FLOW)).toBe(true);
    expect(isDiagramShaped(css)).toBe(false);
  });

  it('without the diagram tool nothing is refused', () => {
    const old = { ...base, diagramAvailable: false };
    expect(handwrittenSvgRoute(old)).toBeNull();
    expect(handwrittenSvgRoute({ ...old, content: svg })).toBeNull();
  });

  it('a drawn picture is not a diagram: it passes with the diagram tool on', () => {
    expect(
      handwrittenSvgRoute({ ...base, content: svg, request: 'draw me a heart icon' }),
    ).toBeNull();
  });

  it("a diagram inline in a page routes to diagram; a logo inline is the page's", () => {
    const page = `<!doctype html><main><h1>How it works</h1>${REAL_4B_FLOW}</main>`;
    const on = { svgCommandAvailable: true, diagramAvailable: true };
    expect(inlineSvgRoute({ path: 'index.html', content: page, ...on })).toBe('diagram');
    expect(
      inlineSvgRoute({ path: 'index.html', content: `<header>${svg}</header>`, ...on }),
    ).toBeNull();
    expect(
      inlineSvgRoute({
        path: 'index.html',
        content: `<header>${svg}</header>`,
        svgCommandAvailable: false,
        diagramAvailable: true,
      }),
    ).toBeNull();
    expect(hasHandwrittenInlineSvg({ path: 'index.html', content: page, ...on })).toBe(true);
  });

  it('the refusal gives the Mermaid call, in the interface the model has', () => {
    const cli = handwrittenDiagramRefusal('flow.svg', { cli: true });
    expect(cli).toContain('diagram "Order fulfilment" --out flow.svg --source');
    expect(cli).toContain('B -- no --> C[Email customer]');
    expect(cli).toContain('cannot draw it');
    expect(cli).toContain('UNCHANGED');
    const schemas = handwrittenDiagramRefusal('flow.svg', { cli: false });
    expect(schemas).toContain('Call the diagram tool');
    expect(schemas).toContain('capability "diagram"');
    const inline = handwrittenDiagramRefusal('index.html', { cli: true, inline: true, edit: true });
    expect(inline).toMatch(/^Not edited: index\.html has a diagram drawn by hand inline/);
    expect(inline).toContain('<img src="assets/flow.svg"');
  });
});

describe('a maths or physics figure drawn by hand routes to math', () => {
  /* MEASURED (the STEM suite, 4B): "why d/dx sin x = cos x" hand-written as a
     unit circle; the refusal sent it to Mermaid, and it made the figure with
     image generation next. Its own markup, trimmed. */
  const unitCircle = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 700" font-family="Arial, sans-serif">',
    '  <rect width="800" height="700" fill="#fafafa"/>',
    '  <text x="400" y="40" text-anchor="middle" font-size="28">Why d/dx(sin x) = cos x</text>',
    '  <circle cx="400" cy="350" r="120" fill="none" stroke="#666" stroke-width="2"/>',
    '  <line x1="400" y1="350" x2="400" y2="190" stroke="#333" stroke-width="2"/>',
    '  <text x="370" y="240" font-size="16">r = 1</text>',
    '  <text x="385" y="210" font-size="20">θ</text>',
    '  <line x1="400" y1="350" x2="480" y2="350" stroke="#27ae60" stroke-width="2"/>',
    '  <text x="490" y="365" font-size="16">x = cos θ</text>',
    '  <text x="385" y="255" font-size="16">y = sin θ</text>',
    '</svg>',
  ].join('\n');
  const base = {
    path: 'sin_derivative.svg',
    content: unitCircle,
    exists: false,
    svgCommandAvailable: true,
    diagramAvailable: true,
    mathAvailable: true,
    request: 'Why is the derivative of sin x equal to cos x? Explain it visually.',
  };

  it('is refused toward math, not Mermaid', () => {
    expect(handwrittenSvgRoute(base)).toBe('math');
    const why = handwrittenMathRefusal(base.path);
    expect(why).toMatch(
      /^Not written: sin_derivative\.svg is a maths or physics figure drawn by hand/,
    );
    expect(why).toContain('sin_derivative.math.json — it is drawn the moment it is written');
    expect(why).toContain('write the same file again UNCHANGED');
  });

  it('a flow chart is still a diagram, and a logo with one such word is let through', () => {
    expect(
      handwrittenSvgRoute({ ...base, path: 'flow.svg', content: REAL_4B_FLOW, request: '' }),
    ).toBe('diagram');
    const logo =
      '<svg viewBox="0 0 200 60"><rect width="200" height="60" rx="8" fill="#111"/><text x="20" y="38" fill="#fff">Force Fitness</text></svg>';
    expect(
      handwrittenSvgRoute({ ...base, path: 'logo.svg', content: logo, request: '' }),
    ).toBeNull();
  });

  it('inline in a page too', () => {
    const page = `<html><body><h1>Derivatives</h1>${unitCircle.replace(/^<\?xml[^>]*>\n/, '')}</body></html>`;
    expect(
      inlineSvgRoute({
        path: 'index.html',
        content: page,
        svgCommandAvailable: true,
        mathAvailable: true,
      }),
    ).toBe('math');
  });
});
