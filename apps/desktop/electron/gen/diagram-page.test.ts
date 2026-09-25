import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { diagramTheme, isPurple, KITS, kitOrDefault } from '@pi-desktop/design-kit';
import { describe, expect, it } from 'vitest';
import {
  asStatement,
  DIAGRAM_TYPE,
  type DiagramPage,
  diagramId,
  diagramLook,
  diagramLookCss,
  diagramTypeOf,
  flowRoles,
  hintFor,
  MERMAID_SHA256,
  MERMAID_VERSION,
  mermaidConfig,
  PAGE_SCRIPT,
  PATH_TOOLS_JS,
  type ParseFailed,
  type ParseOk,
  pageCall,
  prepareSource,
  quoteAllLabels,
  quoteNodeLabels,
  ROUND_GEOMETRY_JS,
  roleStyling,
  runDiagram,
  runDiagramLive,
  SEQUENCE_FONT_SIZE,
  stylesItself,
} from './diagram-page';

const kit = kitOrDefault('paper-teal');
const themes = { light: diagramTheme(kit, 'light', 'mac'), dark: diagramTheme(kit, 'dark', 'mac') };

/** The research's §2.2.3 flow, as Mermaid's parser hands it back. */
const FLOW: ParseOk = {
  ok: true,
  type: 'flowchart-v2',
  vertices: [
    { id: 'A', text: 'Order placed', shape: 'stadium', classes: [] },
    { id: 'B', text: 'Payment ok?', shape: 'diamond', classes: [] },
    { id: 'C', text: 'Pick & pack', shape: 'square', classes: [] },
    { id: 'E', text: 'Email customer', shape: 'square', classes: [] },
    { id: 'D', text: 'Quality ok?', shape: 'diamond', classes: [] },
    { id: 'F', text: 'Ship', shape: 'square', classes: [] },
    { id: 'G', text: 'Delivered', shape: 'square', classes: [] },
    { id: 'H', text: 'Review request', shape: 'stadium', classes: [] },
  ],
  edges: [
    { start: 'A', end: 'B', text: '', stroke: 'normal' },
    { start: 'B', end: 'C', text: 'yes', stroke: 'normal' },
    { start: 'B', end: 'E', text: 'no', stroke: 'normal' },
    { start: 'E', end: 'B', text: 'retry', stroke: 'dotted' },
    { start: 'C', end: 'D', text: '', stroke: 'normal' },
    { start: 'D', end: 'C', text: 'no, repack', stroke: 'normal' },
    { start: 'D', end: 'F', text: 'yes', stroke: 'normal' },
    { start: 'F', end: 'G', text: '', stroke: 'normal' },
    { start: 'G', end: 'H', text: '', stroke: 'normal' },
  ],
};

describe('the bundled Mermaid', () => {
  it('is the pinned file, byte for byte (resources/mermaid/README.md)', () => {
    const file = readFileSync(new URL('../../resources/mermaid/mermaid.min.js', import.meta.url));
    expect(createHash('sha256').update(file).digest('hex')).toBe(MERMAID_SHA256);
    const readme = readFileSync(
      new URL('../../resources/mermaid/README.md', import.meta.url),
      'utf8',
    );
    expect(readme).toContain(MERMAID_VERSION);
    expect(readme).toContain(MERMAID_SHA256);
    // MIT, and its licence ships beside it.
    expect(
      readFileSync(new URL('../../resources/mermaid/LICENSE', import.meta.url), 'utf8'),
    ).toContain('The MIT License');
  });
});

describe('prepareSource — the source as a small model sends it', () => {
  it('leaves good Mermaid alone', () => {
    const src = 'flowchart LR\n  A --> B';
    expect(prepareSource(src)).toEqual({ source: src, notes: [], lineOffset: 0 });
  });

  it('takes the Mermaid out of a ``` fence', () => {
    const r = prepareSource('```mermaid\nflowchart TD\n  A --> B\n```');
    expect(r.source).toBe('flowchart TD\n  A --> B');
    expect(r.lineOffset).toBe(-1);
    expect(r.notes[0]).toMatch(/fence/);
  });

  it('reads \\n typed as two characters on one line as line breaks', () => {
    const r = prepareSource('flowchart TD\\n  A[Start] --> B{Paid?}\\n  B -- no --> C');
    expect(r.source.split('\n')).toHaveLength(3);
    expect(r.notes[0]).toMatch(/line breaks/);
  });

  it('reads a quote escaped once too often as a quote (the 4B in schemas mode)', () => {
    const r = prepareSource('flowchart TD\n  A[\\"Order Placed\\"] --> B{\\"Payment Check\\"}');
    expect(r.source).toBe('flowchart TD\n  A["Order Placed"] --> B{"Payment Check"}');
    expect(r.notes.join(' ')).toMatch(/plain quote/);
    expect(r.lineOffset).toBe(0);
  });

  it('gives lines of arrows with no type line a top-down flowchart, and shifts the line count', () => {
    const r = prepareSource('A --> B\nB --> C');
    expect(r.source).toBe('flowchart TD\nA --> B\nB --> C');
    expect(r.lineOffset).toBe(1);
    expect(r.notes[0]).toMatch(/flowchart TD/);
  });

  it('writes a flowchart’s -> and → as -->, and nothing inside quotes or in another diagram', () => {
    expect(prepareSource('flowchart LR\n  A -> B\n  B → C').source).toBe(
      'flowchart LR\n  A --> B\n  B --> C',
    );
    expect(prepareSource('flowchart LR\n  A["x -> y"] --> B').source).toBe(
      'flowchart LR\n  A["x -> y"] --> B',
    );
    expect(prepareSource('flowchart LR\n  A -.-> B\n  C ==> D').notes).toEqual([]);
    expect(prepareSource('sequenceDiagram\n  A->B: hi').source).toBe('sequenceDiagram\n  A->B: hi');
  });

  it('takes a flowchart’s own colours out — the kit dresses it — and keeps its line numbers', () => {
    // The 4B's first call, verbatim in shape: a style line per step, a lavender among them.
    const src = [
      'flowchart TD',
      '    A[Order Placed] --> B{Payment Check}',
      '    B -->|Failed| D[Email Customer]:::warn',
      '    style A fill:#e1f5fe',
      '    style G fill:#f3e5f5',
      '    classDef warn fill:#fce4ec',
      '    linkStyle 0 stroke:#f00',
    ].join('\n');
    const r = prepareSource(src);
    expect(r.source.split('\n')).toHaveLength(7);
    expect(r.source).not.toMatch(/fill:|stroke:|:::/);
    expect(r.source.split('\n').slice(3)).toEqual(['%%', '%%', '%%', '%%']);
    expect(r.notes.join(' ')).toMatch(/Took out 4 style lines: the design kit colours/);
    expect(stylesItself(r.source)).toBe(false);
    // a label that merely says "style" or ":::" is a label
    expect(prepareSource('flowchart LR\n  A["style: :::bold"] --> B').notes).toEqual([]);
  });

  it('leaves a class diagram’s classes and a sequence diagram alone, but not a theme directive', () => {
    const cls = 'classDiagram\n  class Animal {\n    +name\n  }';
    expect(prepareSource(cls).source).toBe(cls);
    expect(prepareSource('sequenceDiagram\n  A->>B: style me').notes).toEqual([]);
    const init = prepareSource("%%{init: {'theme': 'forest'}}%%\nflowchart TD\n  A --> B");
    expect(init.source).toBe('%%\nflowchart TD\n  A --> B');
    expect(init.notes.join(' ')).toMatch(/Took out a style line/);
  });

  it('names the kind', () => {
    expect(diagramTypeOf('graph TD\n a-->b')?.kind).toBe('flowchart');
    expect(diagramTypeOf('%% a note\nsequenceDiagram')?.kind).toBe('sequence diagram');
    expect(diagramTypeOf('---\ntitle: X\n---\nmindmap\n  root')?.kind).toBe('mind map');
    expect(diagramTypeOf('A --> B')).toBeNull();
  });
});

describe('quoteNodeLabels — the one parse repair', () => {
  it('quotes a label with brackets in it, of any shape', () => {
    expect(quoteNodeLabels('  A[Pick (and pack)] --> B').line).toBe('  A["Pick (and pack)"] --> B');
    expect(quoteNodeLabels('  D{Quality (ok)?}').line).toBe('  D{"Quality (ok)?"}');
    expect(quoteNodeLabels('  S([Start (web)]) --> T').line).toBe('  S(["Start (web)"]) --> T');
  });

  it('leaves plain and already-quoted labels alone, and escapes an inner quote', () => {
    expect(quoteNodeLabels('  A[Order placed] --> B{Paid?}')).toEqual({
      line: '  A[Order placed] --> B{Paid?}',
      changed: 0,
    });
    expect(quoteNodeLabels('  A["Pick (and pack)"]').changed).toBe(0);
    expect(quoteNodeLabels('  A[Say "hi" (twice)]').line).toBe('  A["Say #quot;hi#quot; (twice)"]');
  });

  it('over a whole source, never the type line or the style lines', () => {
    const r = quoteAllLabels('flowchart TD\n  A[x (y)] --> B[z]\n  classDef k fill:#fff');
    expect(r).toEqual({
      source: 'flowchart TD\n  A["x (y)"] --> B[z]\n  classDef k fill:#fff',
      changed: 1,
    });
  });
});

describe('hintFor — a parse error, as the fix', () => {
  const err = (over: Partial<ParseFailed>): ParseFailed => ({
    ok: false,
    message: 'Parse error on line 2:',
    name: 'Error',
    line: 2,
    token: null,
    expected: [],
    ...over,
  });
  it('knows the four errors a small model makes', () => {
    expect(
      hintFor(err({ name: 'UnknownDiagramError', message: 'No diagram type detected' }), 'A --> B'),
    ).toMatch(/diagram type on its own first line/);
    expect(hintFor(err({ token: 'end' }), 'end --> B')).toMatch(/reserved word/);
    expect(hintFor(err({ token: 'PS' }), 'A[Pick (and pack)] --> B')).toMatch(
      /needs double quotes/,
    );
    expect(
      hintFor(err({ message: "Expecting 'TXT', got 'NEWLINE'" }), 'Bob-->Alice Hello'),
    ).toMatch(/needs a colon/);
  });

  it('otherwise names what Mermaid wanted in words, not grammar tokens', () => {
    expect(
      hintFor(err({ expected: ["'SEMI'", "'subgraph'", "'direction_tb'"] }), 'foo bar'),
    ).toMatch(/expected subgraph, direction_tb/);
  });
});

describe('flowRoles / roleStyling — the kit’s semantic colours', () => {
  it('finds where the flow starts and ends, and its failure paths', () => {
    const roles = flowRoles(FLOW);
    expect(roles.start).toEqual(['A']);
    expect(roles.end).toEqual(['H']);
    // B -no-> E, E -retry-> B, D -no, repack-> C: the research's three failure edges.
    expect(roles.failEdges).toEqual([2, 3, 5]);
    // Email customer is reached only by a failure; Pick & pack also by "yes".
    expect(roles.failNodes).toEqual(['E']);
  });

  it('writes them as Mermaid classes and a linkStyle, in the kit’s colours', () => {
    const lines = roleStyling(flowRoles(FLOW), themes.light);
    expect(lines).toContain(
      `classDef pdStart fill:${themes.light.start.fill},stroke:${themes.light.start.fill},color:${themes.light.start.text}`,
    );
    expect(lines).toContain('class A pdStart');
    expect(lines).toContain('class H pdEnd');
    expect(lines).toContain('class E pdFail');
    expect(lines).toContain(
      `linkStyle 2,3,5 stroke:${themes.light.fail.stroke},color:${themes.light.fail.text}`,
    );
  });

  it('a sketch marks its first and last steps by outline, on the pale tint, in ink', () => {
    // Hatched in a deep fill, white words sat on dark stripes and paper gaps.
    const sketch = { ...themes.light, look: 'sketch' as const };
    const lines = roleStyling(flowRoles(FLOW), sketch);
    expect(lines).toContain(
      `classDef pdStart fill:${sketch.group},stroke:${sketch.start.fill},color:${sketch.ink}`,
    );
    expect(lines).toContain(
      `classDef pdEnd fill:${sketch.group},stroke:${sketch.end.fill},color:${sketch.ink}`,
    );
    // the failure step is pale already, and stays as it is
    expect(lines).toContain(
      `classDef pdFail fill:${sketch.fail.fill},stroke:${sketch.fail.stroke},color:${sketch.fail.text}`,
    );
  });

  it('a web of many starts or ends is not coloured, and a source that styles itself is left alone', () => {
    const web: ParseOk = {
      ...FLOW,
      vertices: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id, shape: 'square', classes: [] })),
      edges: [
        { start: 'a', end: 'd', text: '', stroke: 'normal' },
        { start: 'b', end: 'd', text: '', stroke: 'normal' },
        { start: 'c', end: 'd', text: '', stroke: 'normal' },
      ],
    };
    expect(flowRoles(web).start).toEqual([]);
    expect(stylesItself('flowchart TD\n A-->B\n classDef x fill:#fff')).toBe(true);
    expect(stylesItself('flowchart TD\n A:::hot-->B')).toBe(true);
    expect(stylesItself('flowchart TD\n A-->B')).toBe(false);
  });
});

describe('mermaidConfig — the kit, in Mermaid’s words', () => {
  it('draws labels as SVG text, strictly, with every colour from the kit and none purple', () => {
    for (const mode of ['light', 'dark'] as const) {
      const c = mermaidConfig(themes[mode]);
      expect(c.htmlLabels).toBe(false);
      expect((c.flowchart as { htmlLabels: boolean }).htmlLabels).toBe(false);
      expect(c.securityLevel).toBe('strict');
      expect(c.theme).toBe('base');
      const vars = c.themeVariables as Record<string, unknown>;
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v !== 'string' || !v.startsWith('#')) continue;
        expect(isPurple(v), `${mode} ${k} ${v}`).toBe(false);
      }
      expect(vars.edgeLabelBackground).toBe(themes[mode].paper);
    }
  });

  it('lays out with the Bobble look, and sizes a sequence diagram’s words itself', () => {
    const c = mermaidConfig(themes.light);
    expect(c.themeCSS).toBe(diagramLookCss(themes.light));
    const seq = c.sequence as Record<string, number | boolean>;
    // A sequence diagram's words come from the top-level size (Mermaid's
    // sequence setConf lets it override the per-part ones): set for that kind
    // only, a step down from the 16 px of a step's label.
    expect(mermaidConfig(themes.light, 'sequence diagram').fontSize).toBe(SEQUENCE_FONT_SIZE);
    expect(SEQUENCE_FONT_SIZE).toBeLessThan(themes.light.fontSize);
    expect(c.fontSize).toBeUndefined();
    expect(seq.actorFontWeight).toBe(500);
    expect(seq.width).toBeLessThan(150);
    expect((c.class as { hideEmptyMembersBox: boolean }).hideEmptyMembersBox).toBe(true);
    const vars = c.themeVariables as Record<string, unknown>;
    // A step's border is the hairline, not the ink.
    expect(vars.nodeBorder).toBe(diagramLook(themes.light).nodeEdge);
    expect(vars.nodeBorder).not.toBe(themes.light.ink);
  });
});

/** WCAG contrast of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const ch = [1, 3, 5].map((i) => {
      const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

describe('diagramLook / diagramLookCss — the Bobble look', () => {
  it('holds in every kit, both modes: hairlines lighter than ink, a group’s name readable, no purple', () => {
    for (const k of KITS) {
      for (const mode of ['light', 'dark'] as const) {
        const t = diagramTheme(k, mode, 'mac');
        const look = diagramLook(t);
        for (const [role, hex] of Object.entries(look)) {
          expect(hex, `${k.id} ${mode} ${role}`).toMatch(/^#[0-9A-F]{6}$/i);
          expect(isPurple(hex), `${k.id} ${mode} ${role} ${hex}`).toBe(false);
        }
        // A hairline: it shows on the paper, and it is quieter than the ink.
        expect(contrast(look.nodeEdge, t.paper)).toBeGreaterThan(1.3);
        expect(contrast(look.nodeEdge, t.paper)).toBeLessThan(contrast(t.ink, t.paper));
        // A group's name and an edge's words are read on their grounds.
        expect(contrast(look.groupLabel, look.group), `${k.id} ${mode}`).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrast(t.ink, look.pill)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.fail.text, look.pill)).toBeGreaterThanOrEqual(4.5);
        const css = diagramLookCss(t);
        for (const hex of css.match(/#[0-9A-F]{6}/gi) ?? []) expect(isPurple(hex)).toBe(false);
      }
    }
  });

  it('draws edges at 1.5 px with round ends, labels a step down, groups’ names small', () => {
    const css = diagramLookCss(themes.light);
    expect(css).toMatch(
      /\.edgePaths path[^{]*\{[^}]*stroke-width: 1\.5px; stroke-linecap: round; stroke-linejoin: round;/,
    );
    expect(css).toContain(`.edgeLabel text, .edgeLabel tspan { font-size: ${DIAGRAM_TYPE.edge}px;`);
    expect(css).toContain(`font-size: ${DIAGRAM_TYPE.group}px`);
    expect(DIAGRAM_TYPE.edge).toBeLessThan(themes.light.fontSize);
    // A step: the kit's flat surface and a solid border at the edges' weight
    // (the user, 2026-09-25: "clean solid borders") — never the full ink.
    expect(css).toContain(
      `.node path { fill: ${themes.light.surface}; stroke: ${diagramLook(themes.light).nodeEdge}; stroke-width: 1.5px;`,
    );
    expect(diagramLook(themes.light).nodeEdge).not.toBe(themes.light.ink);
  });

  it('leaves the sketch look’s boxes to rough.js (their hatching widths are the look)', () => {
    const sketch = diagramLookCss({ ...themes.light, look: 'sketch' });
    expect(sketch).not.toContain('.node rect');
    expect(sketch).not.toContain('.row-rect-odd');
    // …but its edges, labels and groups are Bobble's.
    expect(sketch).toContain('.edgeLabel text');
    expect(sketch).toContain('.cluster rect');
  });

  it('is part of the page script, with its geometry', () => {
    expect(PAGE_SCRIPT).toContain('const P = (() => {');
    expect(PAGE_SCRIPT).toContain('data-k');
    expect(PAGE_SCRIPT).not.toContain('${');
  });
});

type Box = { x: number; y: number; w: number; h: number; kind?: string };
const box = (x: number, y: number, w: number, h: number, kind = 'box'): Box => ({
  x,
  y,
  w,
  h,
  kind,
});

describe('PATH_TOOLS_JS — the look’s geometry, run as the page runs it', () => {
  const P = vm.runInNewContext(PATH_TOOLS_JS) as {
    parse: (d: string) => Array<{ c: string; p: number[][] }> | null;
    trimEnd: (d: string, px: number) => string;
    trimStart: (d: string, px: number) => string;
    roundCorners: (d: string, r: number) => string;
    arrowTip: (d: string, refY: number) => { dir: number; tip: number } | null;
    openChevron: (
      dir: number,
      apex: number,
      len: number,
      half: number,
      shaftFrom?: number,
    ) => string;
    arrowhead: (width: number) => { len: number; half: number };
    elbow: (spec: {
      pts: number[][];
      from: Box;
      to: Box;
      label?: Box | null;
      obstacles?: Box[];
      axis?: string;
      r?: number;
    }) => { pts: number[][]; label: number[] | null } | null;
    roundedRect: (x: number, y: number, w: number, h: number, r: number) => string;
  };
  const pts = (d: string) => (P.parse(d) ?? []).flatMap((s) => s.p);

  it('reads absolute and relative path data, H and V as lines, and refuses arcs', () => {
    expect(pts('M10,20L30,20H50V60')).toEqual([
      [10, 20],
      [30, 20],
      [50, 20],
      [50, 60],
    ]);
    expect(pts('m10 20 l5 0 c1 1 2 2 3 3')).toEqual([
      [10, 20],
      [15, 20],
      [16, 21],
      [17, 22],
      [18, 23],
    ]);
    expect(P.parse('M0 0 A5 5 0 0 1 10 10')).toBeNull();
    expect(P.parse('L0 0')).toBeNull();
  });

  it('pulls a line back along its own direction, never past half of a short one', () => {
    expect(pts(P.trimEnd('M0,0L0,100', 3))).toEqual([
      [0, 0],
      [0, 97],
    ]);
    expect(pts(P.trimStart('M0,0L100,0', 4))).toEqual([
      [4, 0],
      [100, 0],
    ]);
    expect(pts(P.trimEnd('M0,0L0,4', 3))).toEqual([
      [0, 0],
      [0, 2],
    ]);
  });

  it('pulls a curve’s end back with its last control point, so its tangent holds', () => {
    // A cubic arriving straight down: end and handle both move up 3.
    expect(pts(P.trimEnd('M0,0C0,50,0,80,0,100', 3))).toEqual([
      [0, 0],
      [0, 50],
      [0, 77],
      [0, 97],
    ]);
  });

  it('rounds a polyline’s elbows, clamped to half of each run, and leaves straight runs and curves', () => {
    const d = P.roundCorners('M0,0L0,50L40,50L40,100', 7);
    expect(d).toBe('M0,0L0,43Q0,50 7,50L33,50Q40,50 40,57L40,100');
    // Two short runs: the radius is half the shorter.
    expect(P.roundCorners('M0,0L0,6L10,6', 7)).toBe('M0,0L0,3Q0,6 3,6L10,6');
    // Straight on: no curve at all.
    expect(P.roundCorners('M0,0L0,50L0,100', 7)).toBe('M0,0L0,50L0,100');
    // A curve is already smooth.
    expect(P.roundCorners('M0,0C1,1,2,2,3,3', 7)).toBe('M0,0C1,1,2,2,3,3');
  });

  it('finds which way Mermaid’s arrowheads point and where their tips are', () => {
    // flowchart pointEnd / pointStart, the state barb, a class dependency's start,
    // the sequence arrowhead (its back at -1)
    expect(P.arrowTip('M 0 0 L 10 5 L 0 10 z', 5)).toEqual({ dir: 1, tip: 10 });
    expect(P.arrowTip('M 0 5 L 10 10 L 10 0 z', 5)).toEqual({ dir: -1, tip: 0 });
    expect(P.arrowTip('M 19,7 L9,13 L14,7 L9,1 Z', 7)).toEqual({ dir: 1, tip: 19 });
    expect(P.arrowTip('M 5,7 L9,13 L1,7 L9,1 Z', 7)).toEqual({ dir: -1, tip: 1 });
    expect(P.arrowTip('M -1 0 L 10 5 L 0 10 z', 5)).toEqual({ dir: 1, tip: 10 });
    // A diamond (UML composition) has a vertex on the axis at both ends: that is
    // not an arrowhead's shape, but it is refused by name before it gets here.
    expect(P.arrowTip('M 0 0 L 10 0', 5)).toBeNull();
  });

  it('draws an open ">" with its point where it is asked — never a closed triangle', () => {
    // the user (2026-09-25): "arrows should not be triangles".
    expect(P.openChevron(1, 0, 6, 4)).toBe('M-6,4L0,0L-6,-4');
    expect(P.openChevron(-1, 0, 6, 4)).toBe('M6,4L0,0L6,-4');
    expect(P.openChevron(1, 0, 6, 4)).not.toMatch(/Z/i);
    // A point ahead of where the line stops carries the rest of the line to it.
    expect(P.openChevron(1, 3, 6, 4, 0)).toBe('M0,0L3,0M-3,4L3,0L-3,-4');
    // …and a point behind it does not (the page pulls the line back instead).
    expect(P.openChevron(1, -1, 6, 4, 0)).toBe('M-7,4L-1,0L-7,-4');
    // Sized to the stroke: the same head up to 1.5 px, bigger past it.
    expect(P.arrowhead(1)).toEqual(P.arrowhead(1.5));
    expect(P.arrowhead(3).len).toBeCloseTo(P.arrowhead(1.5).len * 2);
  });

  describe('elbow — an edge re-drawn square, through its label', () => {
    // Every run is level or plumb: an elbow, not a slant.
    const square = (q: number[][]) =>
      q
        .slice(1)
        .every(
          (p, i) =>
            Math.abs((p[0] ?? 0) - (q[i]?.[0] ?? 0)) < 0.01 ||
            Math.abs((p[1] ?? 0) - (q[i]?.[1] ?? 0)) < 0.01,
        );

    it('runs straight down between two boxes that share room', () => {
      const out = P.elbow({
        pts: [
          [100, 40],
          [100, 80],
        ],
        from: box(50, 0, 100, 40),
        to: box(60, 80, 80, 40),
        axis: 'TB',
        r: 8,
      });
      expect(out?.pts).toEqual([
        [100, 40],
        [100, 80],
      ]);
    });

    it('takes a decision’s branch from the corner it turns toward, across and down through its label', () => {
      const out = P.elbow({
        pts: [
          [130, 70],
          [200, 130],
          [200, 160],
        ],
        from: box(60, 0, 100, 100, 'diamond'),
        to: box(160, 160, 80, 40),
        label: box(186, 120, 28, 20),
        axis: 'TB',
        r: 8,
      });
      expect(out?.pts).toEqual([
        [160, 50],
        [200, 50],
        [200, 160],
      ]);
      expect(out?.label).toEqual([200, 130]);
    });

    it('takes a loop back round the side, clear of the edge that runs down, its label on the upright', () => {
      const out = P.elbow({
        pts: [
          [120, 170],
          [140, 130],
          [120, 100],
        ],
        from: box(50, 150, 100, 100, 'diamond'),
        to: box(40, 60, 120, 40),
        label: box(120, 120, 40, 20),
        obstacles: [box(97, 100, 6, 50)],
        axis: 'TB',
        r: 8,
      });
      expect(out).not.toBeNull();
      expect(square(out?.pts ?? [])).toBe(true);
      // Out of the decision's right point, back into the box's right side.
      expect(out?.pts[0]).toEqual([150, 200]);
      expect(out?.pts.at(-1)).toEqual([160, 80]);
      const x = out?.pts[1]?.[0] ?? 0;
      expect(x).toBeGreaterThan(160);
      expect(out?.label?.[0]).toBe(x);
    });

    it('meets a decision at its point, not a hair off it', () => {
      const out = P.elbow({
        pts: [
          [100.5, 40],
          [100, 80],
        ],
        from: box(50, 0, 101, 40),
        to: box(50, 80, 100, 100, 'diamond'),
        axis: 'TB',
        r: 8,
      });
      expect(out?.pts).toEqual([
        [100, 40],
        [100, 80],
      ]);
    });

    it('turns with the flow: left to right leaves the side facing the next box', () => {
      const out = P.elbow({
        pts: [
          [100, 20],
          [160, 20],
        ],
        from: box(0, 0, 100, 40),
        to: box(160, 0, 100, 40),
        axis: 'LR',
        r: 8,
      });
      expect(out?.pts).toEqual([
        [100, 20],
        [160, 20],
      ]);
      const up = P.elbow({
        pts: [
          [100, 60],
          [160, 20],
        ],
        from: box(0, 40, 100, 40),
        to: box(160, 0, 100, 40),
        axis: 'LR',
        r: 8,
      });
      expect(square(up?.pts ?? [])).toBe(true);
      expect(up?.pts[0]?.[0]).toBe(100);
      expect(up?.pts.at(-1)?.[0]).toBe(160);
    });

    it('gives up (null) rather than draw through a box', () => {
      const out = P.elbow({
        pts: [
          [100, 40],
          [100, 200],
        ],
        from: box(50, 0, 100, 40),
        to: box(50, 200, 100, 40),
        obstacles: [box(0, 100, 400, 40)],
        axis: 'TB',
        r: 8,
      });
      expect(out).toBeNull();
    });
  });

  it('rounds a box’s corners, never past half its side', () => {
    const d = P.roundedRect(0, 0, 100, 40, 8);
    expect(d.startsWith('M8,0H92A8,8 0 0 1 100,8V32')).toBe(true);
    expect(d.match(/A/g)).toHaveLength(4);
    expect(P.roundedRect(0, 0, 10, 10, 8)).toContain('A5,5');
  });
});

describe('runDiagram — the whole job against a page', () => {
  /** A page that parses what it is given by the rules in `fails`, and records renders. */
  function page(fails: (s: string) => ParseFailed | null) {
    const renders: Array<{ source: string; id: string; theme: { mode: string } }> = [];
    const p: DiagramPage = {
      parse: async (source) => fails(source) ?? FLOW,
      render: async (req) => {
        renders.push({ source: req.source, id: req.id, theme: req.theme });
        return {
          svg: `<svg>${req.theme.mode}</svg>`,
          width: 100,
          height: 50,
          labelsFixed: req.theme.mode === 'light' ? 1 : 0,
        };
      },
    };
    return { p, renders };
  }
  const bad = (line: number, token: string): ParseFailed => ({
    ok: false,
    message: `Parse error on line ${line}:\n...`,
    name: 'Error',
    line,
    token,
    expected: [],
  });

  it('draws both modes in the kit, with the roles styled in, and reports what it drew', async () => {
    const { p, renders } = page(() => null);
    const r = await runDiagram(p, { source: 'flowchart LR\n  A --> B', title: 'T', themes });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renders.map((x) => x.theme.mode)).toEqual(['light', 'dark']);
    expect(renders[0]?.source).toContain('class A pdStart');
    expect(renders[0]?.id).not.toBe(renders[1]?.id);
    expect(r.nodes).toHaveLength(8);
    expect(r.edges).toBe(9);
    expect(r.decisions).toBe(2);
    expect(r.failEdges).toBe(3);
    expect(r.labelledEdges).toEqual(['yes', 'no', 'retry', 'no, repack', 'yes']);
    expect(r.notes.join(' ')).toMatch(/a label in a colour that reads/);
  });

  it('repairs a label with brackets once, and says so', async () => {
    const { p } = page((s) => (s.includes('[Pick (and pack)]') ? bad(2, 'PS') : null));
    const r = await runDiagram(p, { source: 'flowchart LR\n  A[Pick (and pack)] --> B', themes });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toContain('A["Pick (and pack)"]');
    expect(r.notes.join(' ')).toMatch(/Put quotes round a label/);
  });

  it('a line it cannot read comes back as the MODEL’s line number, its text and the fix', async () => {
    // The model's source had no type line; Mermaid read it with one added, so
    // its "line 3" is the model's line 2.
    const { p } = page(() => bad(3, 'end'));
    const r = await runDiagram(p, { source: 'A --> B\nend --> C', themes });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.line).toBe(2);
    expect(r.lineText).toBe('end --> C');
    expect(r.hint).toMatch(/reserved word/);
  });

  it('an empty source is said, not drawn', async () => {
    const { p, renders } = page(() => null);
    const r = await runDiagram(p, { source: '  \n ', themes });
    expect(r.ok).toBe(false);
    expect(renders).toHaveLength(0);
  });

  it('a live frame is the same job in one mode, under the id it is given', async () => {
    const { p, renders } = page(() => null);
    const r = await runDiagramLive(p, {
      id: 'dglive1d',
      source: 'flowchart LR\n  A --> B',
      title: 'T',
      theme: themes.dark,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renders).toHaveLength(1);
    expect(renders[0]?.id).toBe('dglive1d');
    expect(renders[0]?.theme.mode).toBe('dark');
    // The same roles the finished drawing gets, so the last frame IS it.
    expect(renders[0]?.source).toContain('class A pdStart');
    expect(r.kind).toBe('flowchart');
    expect(r.svg).toBe('<svg>dark</svg>');
  });

  it('a partial frame has no END yet: its newest step is not the flow’s last', async () => {
    const { p, renders } = page(() => null);
    await runDiagramLive(p, {
      id: 'x',
      source: 'flowchart LR\n  A --> B',
      theme: themes.light,
      partial: true,
    });
    await runDiagramLive(p, { id: 'x', source: 'flowchart LR\n  A --> B', theme: themes.light });
    // FLOW's roles: A starts, H ends. The partial frame keeps the start.
    expect(renders[0]?.source).toContain('class A pdStart');
    expect(renders[0]?.source).not.toContain('pdEnd');
    expect(renders[1]?.source).toContain('class H pdEnd');
  });

  it('a live frame Mermaid cannot read yet is a miss, not an error to anyone', async () => {
    const { p, renders } = page(() => bad(2, 'PS'));
    const r = await runDiagramLive(p, {
      id: 'x',
      source: 'flowchart TD\n  A[',
      theme: themes.light,
    });
    expect(r).toMatchObject({ ok: false, line: 2 });
    expect(renders).toHaveLength(0);
    const empty = await runDiagramLive(p, { id: 'x', source: ' ', theme: themes.light });
    expect(empty.ok).toBe(false);
  });

  it('ids are stable for the same diagram and differ between two', () => {
    expect(diagramId('a')).toBe(diagramId('a'));
    expect(diagramId('a')).not.toBe(diagramId('b'));
    expect(diagramId('a')).toMatch(/^dg[0-9a-z]+$/);
  });
});

describe('ROUND_GEOMETRY_JS — the page’s rounding, run as the page runs it', () => {
  const round = vm.runInNewContext(ROUND_GEOMETRY_JS) as (v: string) => string;

  it('keeps compact path numbers apart (Mermaid’s clock symbol, in every sequence diagram)', () => {
    // 12.258 .001 .256 .004 — the ".001" rounded to "0" once glued on as "12.260"
    expect(round('M12.258.001l.256.004.255.005')).toBe('M12.26 0l0.26 0 0.26 0.01');
    // .251 .01 .249 — a search from the digit once read ".01.249" as ".0" + "1.249"
    expect(round('l.251.01.249.012')).toBe('l0.25.01 0.25 0.01');
    // .001 .26 — the ".001" lost its point, and ".26" then read as "0.26"
    expect(round('l.259.001.26-.001.257')).toBe('l0.26 0 .26 0 0.26');
    // The whole symbol, read back by the SVG number grammar: the same numbers,
    // a hundredth apart at most.
    const NUM = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
    const bundle = readFileSync(
      new URL('../../resources/mermaid/mermaid.min.js', import.meta.url),
      'utf8',
    );
    const paths = [...bundle.matchAll(/["'](M[-0-9.][^"']{20,})["']/g)].map((m) => m[1] ?? '');
    expect(paths.some((d) => d.startsWith('M12.258.001'))).toBe(true);
    for (const d of paths) {
      const a = (d.match(NUM) ?? []).map(Number);
      const b = (round(d).match(NUM) ?? []).map(Number);
      expect(b).toHaveLength(a.length);
      expect(b.every((v, i) => Math.abs(v - (a[i] ?? Number.NaN)) <= 0.0051)).toBe(true);
    }
  });

  it('rounds long numbers to a hundredth and leaves short ones alone', () => {
    expect(round('M1.23456,7.891 L3.5,4.25')).toBe('M1.23,7.89 L3.5,4.25');
    expect(round('translate(10.12345 -3.00001)')).toBe('translate(10.12 -3)');
    expect(round('M0.5.5l1.25.75')).toBe('M0.5.5l1.25.75');
  });
});

describe('crossing into the page — nothing that cannot be cloned comes back', () => {
  it('an injected script answers undefined, even one whose last statement is an object', () => {
    // The shape mermaid.min.js ends in: globalThis["mermaid"] = <an object of functions>.
    const lib = 'globalThis["mermaid"] = { initialize() {}, render() {} };';
    expect(typeof vm.runInNewContext(lib)).toBe('object');
    expect(vm.runInNewContext(asStatement(lib))).toBeUndefined();
    // a trailing line comment (a source map) does not swallow it
    expect(vm.runInNewContext(asStatement(`${lib}\n//# sourceMappingURL=x.map`))).toBeUndefined();
    // …and the real bundle does end that way
    const tail = readFileSync(
      new URL('../../resources/mermaid/mermaid.min.js', import.meta.url),
      'utf8',
    ).slice(-200);
    expect(tail).toMatch(/globalThis\["mermaid"\]\s*=/);
  });

  it('a page call answers JSON text, whatever the page built', async () => {
    const window = {
      __pdParse: async (s: string) => ({ ok: true, source: s, fn: () => 1, nested: { at: 2 } }),
    };
    const text = await vm.runInNewContext(pageCall('__pdParse', 'flowchart TD\n  A --> B'), {
      window,
      Promise,
      JSON,
    });
    expect(typeof text).toBe('string');
    expect(JSON.parse(text)).toEqual({
      ok: true,
      source: 'flowchart TD\n  A --> B',
      nested: { at: 2 },
    });
  });
});
