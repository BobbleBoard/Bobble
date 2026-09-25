import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { diagramTheme, isPurple, kitOrDefault } from '@pi-desktop/design-kit';
import { describe, expect, it } from 'vitest';
import {
  asStatement,
  type DiagramPage,
  diagramId,
  diagramTypeOf,
  flowRoles,
  hintFor,
  MERMAID_SHA256,
  MERMAID_VERSION,
  mermaidConfig,
  type ParseFailed,
  type ParseOk,
  pageCall,
  prepareSource,
  quoteAllLabels,
  quoteNodeLabels,
  ROUND_GEOMETRY_JS,
  roleStyling,
  runDiagram,
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
