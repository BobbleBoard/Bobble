/**
 * THE DIAGRAM, DRAWN — the pure half of the `diagram` renderer (VQ-10).
 *
 * There was no diagram path at all (deliverables/research/visual-quality.md
 * §2.2.3, D30): a hand-written flow.svg was refused and sent to OmniSVG, which
 * cannot write words; the deck's `flow` layout kept five steps and drew no
 * branches. REAL, measured before this existed (the diagram-turn probe, the
 * §2.2.3 brief on the 4B): OmniSVG's "52 paths — hit the length limit", then a
 * hand-typed SVG over the top of it, then minutes of `present` retries — 137 s
 * in one run, the 420 s cap in the next two.
 *
 * The fix is the one the chart tool proved: the model writes the STRUCTURE —
 * Mermaid, which a 4B already knows — and the system owns the drawing. Mermaid
 * (MIT, bundled, 11.17.2) lays it out in a hidden Chromium window; this module
 * is everything around that window that can be reasoned about without one:
 *
 *   - `prepareSource` takes the source the way a small model sends it — in a
 *     ``` fence, with `\n` typed as two characters, with no type line, with
 *     `->` arrows — and makes it Mermaid, saying in one line what it changed;
 *   - `quoteNodeLabels` is the one parse repair worth making: a label with ( )
 *     or [ ] in it (`A[Pick (and pack)]`) needs quotes, and nothing is lost by
 *     adding them; it is tried only when the source did not parse;
 *   - `hintFor` turns a parse error into the line and the likely fix — "parse
 *     errors name the line" is the acceptance;
 *   - `flowRoles` / `roleStyling` give a flowchart the kit's semantic colours:
 *     where it starts (deep), where it ends (the accent), a failure path (bad)
 *     — the research prototype's seven hand-written styling lines, now the
 *     theme's job; a source that styles itself is left alone;
 *   - `mermaidConfig` maps a kit's diagram theme onto Mermaid's variables;
 *   - `diagramLook` / `diagramLookCss` are the Bobble look over Mermaid's
 *     stock one: hairline boxes, 1.5 px edges with round ends, small pills
 *     for edge labels, quiet group frames, a type scale — CSS Mermaid lays out
 *     with, so every label is measured at the size it is drawn;
 *   - PAGE_HTML / PAGE_SCRIPT are the window's page: the parse and render
 *     calls, and the post-pass that makes the SVG safe to put anywhere —
 *     labels as SVG text (Bobble's svg surface strips <foreignObject>: every
 *     label vanished in the research's pipeline check), the look's shapes
 *     (arrowheads, rounded boxes, pills — PATH_TOOLS_JS), a stable key on
 *     every part (`data-k`, what a live card matches frames by), every
 *     computed style written onto the element and the <style> block removed
 *     (it restyled the whole app document when injected inline), ids kept
 *     unique, and every label checked against the fill behind it (the
 *     contrast guard);
 *   - `runDiagram` is the whole job against an injected page, so it runs the
 *     same in the app's hidden window, in the eval's headless Chromium and in
 *     a unit test; `runDiagramLive` is one frame of a diagram still being
 *     typed (the live card, diagram-live.ts).
 */
import { type DiagramTheme, over } from '@pi-desktop/design-kit';
import type {
  DiagramDrawing,
  DiagramRenderReply,
  DiagramRenderRequest,
} from '@pi-desktop/harness/tools/present';

export type { DiagramDrawing, DiagramRenderReply, DiagramRenderRequest };

/**
 * The bundled Mermaid, pinned: its version and the sha256 of
 * resources/mermaid/mermaid.min.js (resources/mermaid/README.md). The renderer
 * refuses a file that does not match, and a test holds the file to it.
 */
export const MERMAID_VERSION = '11.17.2';
export const MERMAID_SHA256 = '581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8';

// ── what kind of diagram ─────────────────────────────────────────────────────

/** Mermaid's first word → what a person calls it. */
export const DIAGRAM_TYPES: Readonly<Record<string, string>> = {
  flowchart: 'flowchart',
  graph: 'flowchart',
  sequenceDiagram: 'sequence diagram',
  classDiagram: 'class diagram',
  stateDiagram: 'state diagram',
  'stateDiagram-v2': 'state diagram',
  erDiagram: 'entity-relationship diagram',
  journey: 'user journey',
  gantt: 'Gantt chart',
  pie: 'pie chart',
  mindmap: 'mind map',
  timeline: 'timeline',
  quadrantChart: 'quadrant chart',
  gitGraph: 'git graph',
  'sankey-beta': 'Sankey diagram',
  sankey: 'Sankey diagram',
  requirementDiagram: 'requirement diagram',
  C4Context: 'C4 diagram',
  C4Container: 'C4 diagram',
  C4Component: 'C4 diagram',
  C4Dynamic: 'C4 diagram',
  C4Deployment: 'C4 diagram',
  'block-beta': 'block diagram',
  block: 'block diagram',
  'architecture-beta': 'architecture diagram',
  'xychart-beta': 'XY chart',
  'packet-beta': 'packet diagram',
  kanban: 'kanban board',
  'radar-beta': 'radar chart',
  'treemap-beta': 'treemap',
};

/** The first meaningful line of a source, skipping front matter, directives and comments. */
function firstLine(source: string): { text: string; index: number } | null {
  const lines = source.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    i = end > 0 ? end + 1 : 0;
  }
  for (; i < lines.length; i += 1) {
    const t = (lines[i] ?? '').trim();
    if (t === '' || t.startsWith('%%')) continue;
    return { text: t, index: i };
  }
  return null;
}

/** The diagram's Mermaid keyword and the name for it, or null when the source names none. */
export function diagramTypeOf(source: string): { keyword: string; kind: string } | null {
  const first = firstLine(source);
  if (first === null) return null;
  const word = /^([A-Za-z][\w-]*)/.exec(first.text)?.[1];
  if (word === undefined) return null;
  const kind = DIAGRAM_TYPES[word];
  return kind === undefined ? null : { keyword: word, kind };
}

// ── the source as a small model sends it ─────────────────────────────────────

export interface PreparedSource {
  readonly source: string;
  /** What was changed, one sentence each — said back to the model. */
  readonly notes: readonly string[];
  /**
   * Lines added above the model's own (a type line put in, a fence taken off
   * counts negative), so an error on line N of what Mermaid read is reported
   * on the line the model wrote.
   */
  readonly lineOffset: number;
}

const ARROWISH = /(-->|---|==>|-\.->|-\.-|->|→)/;

/**
 * The source, fixed where a fix assumes nothing:
 *   - a ```mermaid fence around it is taken off;
 *   - `\n` typed as two characters on a single line becomes a line break (a
 *     command line cannot carry a real one inside double quotes);
 *   - no type line, but lines of arrows: a top-down flowchart is what it is;
 *   - in a flowchart, `->` and `→` become `-->` (a model's habit from other
 *     graph languages; Mermaid's flowchart arrow is `-->`).
 */
export function prepareSource(raw: string): PreparedSource {
  const notes: string[] = [];
  let lineOffset = 0;
  let text = raw.replace(/\r\n?/g, '\n');
  const fence = /^\s*```[ \t]*(?:mermaid|mmd)?[ \t]*\n([\s\S]*?)\n[ \t]*```\s*$/i.exec(text);
  if (fence !== null) {
    text = fence[1] ?? '';
    lineOffset -= 1;
    notes.push(
      'Took the Mermaid out of its ``` fence (pass the diagram itself, not a Markdown block).',
    );
  }
  if (!text.includes('\n') && /\\n/.test(text)) {
    text = text.replace(/\\n/g, '\n').replace(/\\t/g, '  ');
    notes.push('Read the \\n in it as line breaks.');
  }
  // MEASURED, the 4B in schemas mode: `A[\"Order Placed\"]` — a quote escaped
  // once too often in the JSON, arriving as a backslash and a quote. Mermaid
  // has no backslash escapes (a quote inside a label is #quot;), so a \" is
  // always a quote.
  if (text.includes('\\"')) {
    text = text.replace(/\\"/g, '"');
    notes.push('Read each \\" in it as a plain quote (Mermaid has no backslash escapes).');
  }
  // Leading blank lines shift nothing a person counts; trailing spaces are noise.
  const leading = /^(?:[ \t]*\n)+/.exec(text)?.[0] ?? '';
  if (leading !== '') {
    lineOffset -= leading.split('\n').length - 1;
    text = text.slice(leading.length);
  }
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
  let type = diagramTypeOf(text);
  if (type === null && text !== '' && ARROWISH.test(text)) {
    text = `flowchart TD\n${text}`;
    lineOffset += 1;
    type = { keyword: 'flowchart', kind: 'flowchart' };
    notes.push('It had no type line, so it is drawn as a top-down flowchart (flowchart TD).');
  }
  if (type?.kind === 'flowchart') {
    let arrows = 0;
    const fixed = text
      .split('\n')
      .map((line, i) => {
        if (i === 0 || /^\s*%%/.test(line)) return line;
        // Only outside quoted labels: split on quotes, touch the even parts.
        return line
          .split('"')
          .map((part, k) => {
            if (k % 2 === 1) return part;
            return part
              .replace(/(^|[^-=.<>|])->(?!>)/g, (_m, pre: string) => {
                arrows += 1;
                return `${pre}-->`;
              })
              .replace(/\s*→\s*/g, () => {
                arrows += 1;
                return ' --> ';
              });
          })
          .join('"');
      })
      .join('\n');
    if (arrows > 0) {
      text = fixed;
      notes.push(`Wrote its ${arrows === 1 ? 'arrow' : 'arrows'} as --> (a flowchart's arrow).`);
    }
  }
  const unstyled = withoutStyling(text, type?.kind ?? '');
  if (unstyled.dropped > 0) {
    text = unstyled.source;
    notes.push(
      `Took out ${unstyled.dropped === 1 ? 'a style line' : `${unstyled.dropped} style lines`}: the design kit colours a diagram (where it starts and ends, the failure paths) — no colours in the source.`,
    );
  }
  return { source: text, notes, lineOffset };
}

/** The styling lines each kind of diagram can carry — the kit's to decide. */
const STYLE_LINES: Readonly<Record<string, RegExp>> = {
  flowchart: /^\s*(?:style|classDef|class|linkStyle)\s/,
  'state diagram': /^\s*(?:style|classDef|class)\s/,
  'class diagram': /^\s*(?:style|classDef|cssClass)\s/,
};

/**
 * The source with its own colours taken out. MEASURED, the research's flow
 * brief on the 4B with the tool in place: its first call wrote a `style A
 * fill:#e1f5fe` line for all seven steps, unasked and against the guidance —
 * pastels, a lavender and a pink among them (the user: no purple) — and a source
 * that dresses itself keeps its own dress, over the kit's roles. So styling is
 * the kit's: style / classDef / class / linkStyle lines, `%%{init}%%` theme
 * directives and `:::name` tags go. A line becomes a bare `%%` comment rather
 * than going away, so Mermaid's line N is still the model's line N.
 */
export function withoutStyling(source: string, kind: string): { source: string; dropped: number } {
  const styleLine = STYLE_LINES[kind];
  let dropped = 0;
  const lines = source.split('\n').map((line) => {
    if (/^\s*%%\{.*\}%%\s*$/.test(line) || (styleLine?.test(line) ?? false)) {
      dropped += 1;
      return '%%';
    }
    if (kind === 'flowchart' && line.includes(':::')) {
      // Outside quoted labels only, like the arrows above.
      return line
        .split('"')
        .map((part, k) => (k % 2 === 1 ? part : part.replace(/:::[\w-]+/g, '')))
        .join('"');
    }
    return line;
  });
  return { source: lines.join('\n'), dropped };
}

/** The shapes a flowchart node can open with, longest first, and what closes each. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['(((', ')))'],
  ['[[', ']]'],
  ['[(', ')]'],
  ['((', '))'],
  ['([', '])'],
  ['{{', '}}'],
  ['[/', '/]'],
  ['[\\', '\\]'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
  ['>', ']'],
];

/** Where a node's text may end: before an edge, an `&`, a class, a comment — or the line's end. */
const NODE_END = /^\s*(?:$|;|&|:::|%%|-->|---|==>|-\.|--|~~~|<-->|<--|x--|o--|\|)/;

/**
 * Put quotes round node labels that carry ( ) [ ] { } — the characters that
 * end a shape early: `A[Pick (and pack)]` → `A["Pick (and pack)"]`. A label
 * already in quotes is left alone, and a `"` inside a label becomes `#quot;`.
 */
export function quoteNodeLabels(line: string): { line: string; changed: number } {
  let out = '';
  let i = 0;
  let changed = 0;
  while (i < line.length) {
    const id = /^[A-Za-z0-9_][\w-]*/.exec(line.slice(i));
    const prev = i === 0 ? ' ' : (line[i - 1] ?? ' ');
    if (id === null || /[\w"-]/.test(prev)) {
      out += line[i];
      i += 1;
      continue;
    }
    const after = i + id[0].length;
    const shape = SHAPES.find(([open]) => line.startsWith(open, after));
    if (shape === undefined) {
      out += id[0];
      i = after;
      continue;
    }
    const [open, close] = shape;
    const start = after + open.length;
    // The label ends at the LAST closer that is followed by something a node
    // can be followed by — so a closer inside the label is part of it.
    let end = -1;
    for (let k = line.indexOf(close, start); k !== -1; k = line.indexOf(close, k + 1)) {
      if (NODE_END.test(line.slice(k + close.length))) {
        end = k;
        break;
      }
    }
    if (end === -1) {
      out += id[0];
      i = after;
      continue;
    }
    const label = line.slice(start, end);
    const quoted = /^\s*".*"\s*$/.test(label);
    if (!quoted && /[()[\]{}"]/.test(label)) {
      out += `${id[0]}${open}"${label.trim().replace(/"/g, '#quot;')}"${close}`;
      changed += 1;
    } else {
      out += line.slice(i, end + close.length);
    }
    i = end + close.length;
  }
  return { line: out, changed };
}

/** `quoteNodeLabels` over a whole flowchart source (the type line left alone). */
export function quoteAllLabels(source: string): { source: string; changed: number } {
  let changed = 0;
  const lines = source.split('\n').map((line, i) => {
    if (i === 0 || /^\s*(?:%%|classDef|class |style |linkStyle|click )/.test(line)) return line;
    const r = quoteNodeLabels(line);
    changed += r.changed;
    return r.line;
  });
  return { source: lines.join('\n'), changed };
}

// ── parse errors, said plainly ───────────────────────────────────────────────

/** What the page's parse call hands back. */
export interface ParseOk {
  readonly ok: true;
  /** Mermaid's own name for what it parsed: flowchart-v2, sequence, … */
  readonly type: string | null;
  /** A flowchart's nodes and edges (empty for other diagrams). */
  readonly vertices: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly shape: string | null;
    readonly classes: readonly string[];
  }>;
  readonly edges: ReadonlyArray<{
    readonly start: string;
    readonly end: string;
    readonly text: string;
    readonly stroke: string;
  }>;
}

export interface ParseFailed {
  readonly ok: false;
  readonly message: string;
  readonly name: string | null;
  /** 1-based, in the source Mermaid read. */
  readonly line: number | null;
  readonly token: string | null;
  readonly expected: readonly string[];
}

export type ParseResult = ParseOk | ParseFailed;

/**
 * The likely fix for a parse error, in one line — the part of the error a
 * model can act on. Mermaid's own "Expecting 'SQE', 'DOUBLECIRCLEEND', …"
 * names grammar tokens nobody writes.
 */
export function hintFor(err: ParseFailed, lineText: string): string {
  const msg = err.message;
  if (err.name === 'UnknownDiagramError' || /No diagram type detected/i.test(msg)) {
    return 'Start with the diagram type on its own first line: flowchart TD (or LR), sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, pie.';
  }
  if (err.token === 'end' || /^\s*end\s*(?:-->|---|$)/.test(lineText)) {
    return '`end` is a reserved word in a flowchart — name that node something else (Done, Finish).';
  }
  if (
    /[([{][^"\n]*[([{)\]}][^"\n]*[)\]}]/.test(lineText) ||
    err.token === 'PS' ||
    err.token === 'SQS'
  ) {
    return 'A label with ( ) [ ] or { } in it needs double quotes: A["Pick (and pack)"].';
  }
  if (/Expecting 'TXT'/.test(msg)) {
    return 'A message needs a colon and its text: Alice->>Bob: Hello.';
  }
  if (/-{1,2}>\s*$|--\s*$/.test(lineText)) {
    return 'That arrow points at nothing — end the line with the node it goes to.';
  }
  const expected = err.expected
    .map((e) => e.replace(/^'|'$/g, ''))
    .filter((e) => /^[a-z]/i.test(e) && !/^[A-Z_]{3,}$/.test(e))
    .slice(0, 4);
  return expected.length > 0
    ? `Mermaid expected ${expected.join(', ')} there${err.token !== null ? `, not "${err.token}"` : ''}.`
    : 'Check the brackets and arrows on that line against Mermaid syntax.';
}

// ── the kit's semantic colours for a flowchart ───────────────────────────────

/**
 * Edge words that mark a failure path. English words only: this is styling
 * (an orange edge), never content, and an unmatched word just stays ink.
 */
export const FAIL_WORDS =
  /\b(?:no|nope|fail(?:s|ed|ure)?|error|errors|reject(?:s|ed)?|den(?:y|ied)|invalid|retry|retries|timeout|timed out|abort(?:s|ed)?|cancel(?:s|led|ed)?|declin(?:e|ed)|refus(?:e|ed)|miss(?:ing|ed)|broken|bad|false|not ok)\b/i;

export interface FlowRoles {
  readonly start: readonly string[];
  readonly end: readonly string[];
  /** Indexes into the edge list, Mermaid's own order (what `linkStyle` counts). */
  readonly failEdges: readonly number[];
  readonly failNodes: readonly string[];
}

/** Where a flow starts, where it ends, and which paths are failures. */
export function flowRoles(parsed: ParseOk): FlowRoles {
  const ids = parsed.vertices.map((v) => v.id);
  const into = new Map(ids.map((id) => [id, [] as number[]]));
  const out = new Map(ids.map((id) => [id, [] as number[]]));
  parsed.edges.forEach((e, i) => {
    into.get(e.end)?.push(i);
    out.get(e.start)?.push(i);
  });
  const failEdges = parsed.edges
    .map((e, i) => (FAIL_WORDS.test(e.text) ? i : -1))
    .filter((i) => i >= 0);
  const fail = new Set(failEdges);
  const sources = ids.filter(
    (id) => (into.get(id)?.length ?? 0) === 0 && (out.get(id)?.length ?? 0) > 0,
  );
  const sinks = ids.filter(
    (id) => (out.get(id)?.length ?? 0) === 0 && (into.get(id)?.length ?? 0) > 0,
  );
  // One start or two is a flow; a dozen is a web, and colouring all of it is noise.
  const start = sources.length <= 2 ? sources : [];
  const end = sinks.length <= 2 ? sinks.filter((id) => !start.includes(id)) : [];
  const failNodes = ids.filter((id) => {
    if (start.includes(id) || end.includes(id)) return false;
    const incoming = into.get(id) ?? [];
    return incoming.length > 0 && incoming.every((i) => fail.has(i));
  });
  return { start, end, failEdges, failNodes };
}

/**
 * Whether the source still dresses itself. prepareSource takes a flowchart's
 * own styling out (withoutStyling), so this is the guard for whatever it did
 * not recognise: the kit's roles are not layered over colours of the source's.
 */
export function stylesItself(source: string): boolean {
  return /^\s*(?:classDef|class\s|style\s|linkStyle)\b/m.test(source) || source.includes(':::');
}

/** The Mermaid lines that put the roles into the kit's colours, for one mode. */
export function roleStyling(roles: FlowRoles, theme: DiagramTheme): string[] {
  const lines: string[] = [];
  const cls = (
    name: string,
    fill: string,
    stroke: string,
    color: string,
    ids: readonly string[],
  ) => {
    if (ids.length === 0) return;
    lines.push(`classDef ${name} fill:${fill},stroke:${stroke},color:${color}`);
    lines.push(`class ${ids.join(',')} ${name}`);
  };
  if (theme.look === 'sketch') {
    // The sketch look FILLS by hatching (rough.js, 4 px strokes in the fill
    // colour, paper between them): a deep or accent fill became dark stripes
    // under white words, readable on neither. So a sketch marks its first and
    // last steps by their OUTLINE, on the kit's pale tint, in ink.
    cls('pdStart', theme.group, theme.start.fill, theme.ink, roles.start);
    cls('pdEnd', theme.group, theme.end.fill, theme.ink, roles.end);
  } else {
    cls('pdStart', theme.start.fill, theme.start.fill, theme.start.text, roles.start);
    cls('pdEnd', theme.end.fill, theme.end.fill, theme.end.text, roles.end);
  }
  cls('pdFail', theme.fail.fill, theme.fail.stroke, theme.fail.text, roles.failNodes);
  if (roles.failEdges.length > 0) {
    lines.push(
      `linkStyle ${roles.failEdges.join(',')} stroke:${theme.fail.stroke},color:${theme.fail.text}`,
    );
  }
  return lines;
}

// ── the Bobble look ──────────────────────────────────────────────────────────

/**
 * The colours of Bobble's own diagram look, from a kit's diagram theme.
 * the user (2026-09-25): "custom mermaid arrows and box styling". Mermaid's stock
 * look drew every step in a full ink border (a box of black lines on the
 * kit's paper), edge labels as a hard white patch, groups as a flat tinted
 * square with its name centred where an edge came in over it. This is the
 * quieter set the kit's other surfaces already wear: the surface with a
 * hairline, a pill of paper under a label, a group's field a shade off the
 * paper with its frame a shade off that.
 */
export interface DiagramLook {
  /** A step's fill. */
  readonly node: string;
  /** A step's border: solid, most of the way from the surface to the ink
   * (the user, 2026-09-25: "clean solid borders no shininess" — a third of the
   * way, as a hairline, read as a soft white card, not an outlined box). */
  readonly nodeEdge: string;
  /** An edge label's pill, and the hairline round it. */
  readonly pill: string;
  readonly pillEdge: string;
  /** A group (subgraph, composite state, alt block): its field, frame and name. */
  readonly group: string;
  readonly groupEdge: string;
  readonly groupLabel: string;
  /** A sequence diagram's lifelines. */
  readonly lifeline: string;
  /** Every other row of an entity's attributes. */
  readonly zebra: string;
}

export function diagramLook(t: DiagramTheme): DiagramLook {
  const light = t.mode === 'light';
  return {
    node: t.surface,
    nodeEdge: over(t.ink, t.surface, light ? 0.58 : 0.52),
    pill: t.paper,
    pillEdge: over(t.ink, t.paper, light ? 0.14 : 0.2),
    group: over(t.group, t.paper, light ? 0.55 : 0.6),
    groupEdge: over(t.ink, t.paper, light ? 0.13 : 0.17),
    groupLabel: t.mute,
    lifeline: over(t.ink, t.paper, light ? 0.22 : 0.26),
    zebra: over(t.group, t.surface, light ? 0.4 : 0.45),
  };
}

/** The type scale under a step's label: an edge's words, a group's name, a member line. */
export const DIAGRAM_TYPE = { edge: 13, group: 12.5, member: 14, terminal: 12 } as const;

/** A sequence diagram's words, participants and messages alike (see mermaidConfig). */
export const SEQUENCE_FONT_SIZE = 14;

/**
 * The look as CSS for Mermaid's `themeCSS`. Mermaid scopes it to the drawing
 * and — the reason it is CSS and not a post-pass — lays the diagram out WITH
 * it: an edge label set in 13 px is measured in 13 px, so its pill fits it.
 * (A sequence diagram measures its words from its own config instead, so its
 * sizes are in mermaidConfig.) The post-pass then draws what CSS cannot: the
 * arrowheads, the pills, rounded class and entity boxes (PAGE_SCRIPT).
 */
export function diagramLookCss(t: DiagramTheme): string {
  const k = diagramLook(t);
  // The sketch look draws its boxes with rough.js — hatching and a pencil
  // outline, whose widths ARE the look: the box rules are the clean look's.
  const boxes =
    t.look === 'sketch'
      ? []
      : [
          // Steps: the flat surface, a solid 1.5 px border (the edges' weight), round joins.
          `.node rect, .node circle, .node ellipse, .node polygon, .node path { fill: ${k.node}; stroke: ${k.nodeEdge}; stroke-width: 1.5px; stroke-linejoin: round; }`,
          `.row-rect-odd path { fill: ${k.node}; stroke: none; }`,
          `.row-rect-even path { fill: ${k.zebra}; stroke: none; }`,
          `.divider path { stroke: ${k.nodeEdge}; stroke-width: 1px; }`,
        ];
  return [
    ...boxes,
    // Edges: 1.5 px with round ends and joins; dotted is round dots, dashed soft dashes.
    '.edgePaths path, path.flowchart-link, path.transition, path.relation, path.relationshipLine { stroke-width: 1.5px; stroke-linecap: round; stroke-linejoin: round; }',
    '.edgePaths path.edge-thickness-thick { stroke-width: 3px; }',
    '.edgePaths path.edge-pattern-dotted { stroke-dasharray: 0.1 4.6; }',
    '.edgePaths path.edge-pattern-dashed { stroke-dasharray: 6 5; }',
    // An edge's words: a step down from a step's, on a pill the post-pass draws.
    `.edgeLabel text, .edgeLabel tspan { font-size: ${DIAGRAM_TYPE.edge}px; font-weight: 400; }`,
    `.edgeTerminals text, .edgeTerminals tspan { font-size: ${DIAGRAM_TYPE.terminal}px; fill: ${t.mute}; }`,
    // A group: a quiet field, a hairline frame, its name small, in its corner.
    `.cluster rect { fill: ${k.group}; stroke: ${k.groupEdge}; stroke-width: 1px; }`,
    `.cluster-label text, .cluster-label tspan { font-size: ${DIAGRAM_TYPE.group}px; font-weight: 500; fill: ${k.groupLabel}; letter-spacing: 0.01em; }`,
    // State diagrams: the start a solid dot in ink.
    `.state-start { fill: ${t.ink}; stroke: none; }`,
    // Class and entity boxes: the name set bolder than the lines under it.
    '.label-group text, .label-group tspan, .label.name text, .label.name tspan { font-weight: 600; }',
    `.members-group text, .methods-group text, .label.attribute-type text, .label.attribute-name text, .label.attribute-keys text, .label.attribute-comment text { font-size: ${DIAGRAM_TYPE.member}px; }`,
    // Sequence: participants boxed like steps, soft lifelines, messages drawn like edges.
    `.actor { fill: ${k.node}; stroke: ${k.nodeEdge}; stroke-width: 1.5px; }`,
    `text.actor, text.actor > tspan { fill: ${t.ink}; stroke: none; }`,
    `.actor-line { stroke: ${k.lifeline}; stroke-width: 1px; }`,
    `.messageLine0, .messageLine1 { stroke: ${t.line}; stroke-width: 1.5px; stroke-linecap: round; }`,
    '.messageLine1 { stroke-dasharray: 4 5 !important; }',
    `.messageText { fill: ${t.ink}; stroke: none; }`,
    `.loopLine { stroke: ${k.groupEdge}; stroke-width: 1px; stroke-dasharray: none; fill: none; }`,
    `.labelBox { fill: ${k.group}; stroke: ${k.groupEdge}; stroke-width: 1px; }`,
    `.labelText, .labelText > tspan { fill: ${t.ink}; font-weight: 600; }`,
    `.loopText, .loopText > tspan, .sectionTitle { fill: ${t.mute}; }`,
    `.note { fill: ${k.group}; stroke: ${k.groupEdge}; stroke-width: 1px; }`,
    `.noteText, .noteText > tspan { fill: ${t.ink}; stroke: none; }`,
    `.activation0, .activation1, .activation2 { fill: ${k.group}; stroke: ${k.nodeEdge}; stroke-width: 1px; }`,
  ].join('\n');
}

// ── the kit's theme, in Mermaid's words ──────────────────────────────────────

/** Six-digit hex, for Mermaid's colour maths (it cannot read the kit's other spellings). */
function hex6(c: string): string {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#888888';
}

/**
 * Mermaid's initialize() config for one mode of a kit. `base` is Mermaid's
 * only theme meant to be re-coloured; every variable a diagram type reads is
 * set from a kit role, so no default colour (the base theme's cream nodes and
 * lavender edge labels) survives.
 */
export function mermaidConfig(theme: DiagramTheme, kind = ''): Record<string, unknown> {
  const s = theme.series.map(hex6);
  const series = (i: number): string => s[i % Math.max(1, s.length)] ?? theme.ink;
  const scale: Record<string, string> = {};
  for (let i = 0; i < 12; i += 1) {
    scale[`cScale${i}`] = series(i);
    // A timeline underlines each event in cScaleInv — Mermaid's derived one
    // was a pale blue under an orange box.
    scale[`cScaleInv${i}`] = series(i);
    scale[`cScaleLabel${i}`] = theme.mode === 'light' ? '#FFFFFF' : theme.paper;
    scale[`pie${i + 1}`] = series(i);
  }
  for (let i = 0; i < 8; i += 1) {
    scale[`git${i}`] = series(i);
    scale[`gitBranchLabel${i}`] = theme.mode === 'light' ? '#FFFFFF' : theme.paper;
  }
  const noSize = { useMaxWidth: false };
  const k = diagramLook(theme);
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look: theme.look === 'sketch' ? 'handDrawn' : 'classic',
    handDrawnSeed: 7,
    deterministicIds: true,
    fontFamily: theme.font,
    // A sequence diagram sets every word in the config's top-level size — it
    // overrides the per-part sizes (Mermaid 11.17 sequence setConf) — so the
    // step down to a message's size is made here, and the participants stand
    // out by weight (sequence.actorFontWeight) and their box.
    ...(kind === 'sequence diagram' ? { fontSize: SEQUENCE_FONT_SIZE } : {}),
    htmlLabels: false,
    // The Bobble look (diagramLookCss): Mermaid lays out with it.
    themeCSS: diagramLookCss(theme),
    flowchart: {
      ...noSize,
      htmlLabels: false,
      // Laid out straight: every edge is re-drawn as an elbow in the page
      // (2a'), and a label then sits on dagre's own point. The kit's curve
      // is the elbows' corner radius.
      curve: 'linear',
      // A little more room between ranks than Mermaid's own: an edge's pill
      // and its arrowhead both sit in that gap.
      nodeSpacing: 36,
      rankSpacing: 50,
      padding: 12,
      diagramPadding: 6,
      wrappingWidth: 180,
    },
    // A sequence diagram measures its words from its config, not from CSS:
    // participants a step down from Mermaid's 150 × 65 boxes, set in medium.
    sequence: {
      ...noSize,
      mirrorActors: false,
      actorMargin: 48,
      messageMargin: 34,
      width: 116,
      height: 42,
      boxMargin: 10,
      boxTextMargin: 6,
      noteMargin: 10,
      wrapPadding: 12,
      actorFontWeight: 500,
      messageFontWeight: 400,
      noteFontWeight: 400,
    },
    // An empty compartment is noise in a chat card; a class with no members is a name.
    class: { ...noSize, hideEmptyMembersBox: true },
    state: noSize,
    er: { ...noSize, fontSize: DIAGRAM_TYPE.member, entityPadding: 12, minEntityWidth: 96 },
    journey: noSize,
    // Mermaid's gantt sized itself to the page (1,656 px) in 11 px type with
    // full ISO dates on every tick: in a 700 px chat card that was 5 px words.
    // A chat-card width, the kit's type size, short tick dates.
    gantt: {
      ...noSize,
      useWidth: 880,
      fontSize: theme.fontSize,
      sectionFontSize: theme.fontSize,
      barHeight: 26,
      barGap: 6,
      topPadding: 40,
      leftPadding: 88,
      rightPadding: 24,
      gridLineStartPadding: 32,
      axisFormat: '%b %d',
    },
    pie: noSize,
    timeline: noSize,
    mindmap: noSize,
    gitGraph: noSize,
    requirement: noSize,
    quadrantChart: noSize,
    xyChart: noSize,
    sankey: noSize,
    block: noSize,
    themeVariables: {
      darkMode: theme.mode === 'dark',
      fontFamily: theme.font,
      fontSize: `${theme.fontSize}px`,
      background: theme.paper,
      primaryColor: k.node,
      primaryTextColor: theme.ink,
      primaryBorderColor: k.nodeEdge,
      secondaryColor: theme.group,
      secondaryTextColor: theme.ink,
      secondaryBorderColor: theme.groupEdge,
      tertiaryColor: theme.paper,
      tertiaryTextColor: theme.ink,
      tertiaryBorderColor: theme.line,
      mainBkg: k.node,
      nodeBorder: k.nodeEdge,
      nodeTextColor: theme.ink,
      textColor: theme.ink,
      titleColor: theme.ink,
      lineColor: theme.line,
      defaultLinkColor: theme.line,
      edgeLabelBackground: theme.paper,
      clusterBkg: k.group,
      clusterBorder: k.groupEdge,
      strokeWidth: 1,
      // sequence
      actorBkg: k.node,
      actorBorder: k.nodeEdge,
      actorTextColor: theme.ink,
      actorLineColor: k.lifeline,
      signalColor: theme.line,
      signalTextColor: theme.ink,
      labelBoxBkgColor: k.group,
      labelBoxBorderColor: k.groupEdge,
      labelTextColor: theme.ink,
      loopTextColor: theme.mute,
      noteBkgColor: k.group,
      noteTextColor: theme.ink,
      noteBorderColor: k.groupEdge,
      activationBkgColor: k.group,
      activationBorderColor: k.nodeEdge,
      sequenceNumberColor: theme.surface,
      // state / class / er
      labelColor: theme.ink,
      altBackground: k.group,
      attributeBackgroundColorOdd: k.node,
      attributeBackgroundColorEven: k.zebra,
      // pie
      pieTitleTextColor: theme.ink,
      pieSectionTextColor: theme.mode === 'light' ? '#FFFFFF' : theme.paper,
      pieLegendTextColor: theme.ink,
      pieStrokeColor: theme.paper,
      pieOuterStrokeColor: theme.line,
      // Mermaid draws slices at 0.7: washed out beside their own legend.
      pieOpacity: '1',
      pieOuterStrokeWidth: '1px',
      // gantt
      taskBkgColor: series(0),
      taskBorderColor: series(0),
      taskTextColor: theme.mode === 'light' ? '#FFFFFF' : theme.paper,
      taskTextOutsideColor: theme.ink,
      activeTaskBkgColor: series(1),
      activeTaskBorderColor: series(1),
      doneTaskBkgColor: theme.line,
      doneTaskBorderColor: theme.line,
      critBkgColor: theme.fail.stroke,
      critBorderColor: theme.fail.stroke,
      sectionBkgColor: theme.group,
      sectionBkgColor2: theme.paper,
      gridColor: theme.groupEdge,
      todayLineColor: theme.fail.stroke,
      ...scale,
    },
  };
}

// ── the page ─────────────────────────────────────────────────────────────────

/**
 * The window's page. Nothing loads into it but Mermaid and PAGE_SCRIPT (both
 * put in with executeJavaScript), and the source it renders is a MODEL's, so
 * the page asks for nothing: no network, no frames, no images from anywhere
 * but data: (Mermaid's own `securityLevel: 'strict'` escapes the labels on
 * top of that).
 */
export const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>html,body{margin:0;background:#fff}#host{position:absolute;left:0;top:0}</style>
</head><body><div id="host"></div></body></html>`;

/**
 * Geometry to a hundredth of a pixel, as page JavaScript (PAGE_SCRIPT takes it
 * in; the tests run the same text). Mermaid writes fifteen digits — a stadium
 * node alone was 32 KB of path.
 *
 * Compact path data runs numbers together: "M12.258.001l.256.004" is 12.258,
 * .001, .256, .004 — a point starts a new number once the one before already
 * has one. So the numbers are read left to right by the SVG number grammar (a
 * search from any digit read ".01.249" as ".0" + "1.249"), and a rounded one
 * is kept apart on both sides: a space before it when it starts with a digit
 * after a digit or a point (".001" → "0" glued onto "12.26" as "12.260"), and
 * after it when it lost its point before a ".26" (which then read as "0.26").
 * All three broke the clock symbol Mermaid puts in every sequence diagram into
 * a path the browser refused ("Expected number" — the real window's console,
 * 2026-09-25); the test reads the whole symbol back.
 */
export const ROUND_GEOMETRY_JS = String.raw`(v) => v.replace(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, (n, at, s) => {
  if (!/\.\d{3,}/.test(n)) return n;
  let r = String(Math.round(Number(n) * 100) / 100);
  if (/[\d.]/.test(at > 0 ? s[at - 1] : '') && /^\d/.test(r)) r = ' ' + r;
  if (!r.includes('.') && s[at + n.length] === '.') r += ' ';
  return r;
}).replace(/ {2,}/g, ' ')`;

/**
 * The look's geometry, as page JavaScript (PAGE_SCRIPT takes it in; the tests
 * run the same text). Pure: path data in, path data out.
 *
 *   parse / write      absolute and relative M L H V C Q Z (A and the smooth
 *                      curves are refused: a Mermaid edge never has them)
 *   trimEnd/trimStart  an edge pulled back along its own tangent, so a line
 *                      ends inside its arrowhead instead of under its tip
 *   roundCorners       a polyline's elbows as small curves — a `linear` or
 *                      `step` kit keeps its straight runs, not its sharp turns
 *   arrowTip           which way a Mermaid arrowhead points, and where its tip
 *                      is (the vertex on the marker's axis at the far end)
 *   openChevron        Bobble's arrowhead: an open ">" stroked like its edge,
 *                      round-capped and round-joined — never a filled triangle
 *                      (the user, 2026-09-25: "arrows should not be triangles,
 *                      beveled tip/tail clean"); with the short run of line
 *                      from the edge's end to the point when the point is ahead
 *   elbow              an edge re-routed as an elbow ("curved path eg. elbow
 *                      arrows"): out of its box square to the side it leaves
 *                      (a decision from the corner it turns toward), into the
 *                      next square to the side it enters, through its label,
 *                      small jogs pulled straight — the corners are rounded by
 *                      roundCorners afterwards
 *   roundedRect        a box with its corners rounded (class and entity boxes)
 */
export const PATH_TOOLS_JS = String.raw`(() => {
  const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const SIZE = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4 };
  const parse = (d) => {
    if (typeof d !== 'string' || /[AaSsTt]/.test(d)) return null;
    const segs = [];
    const re = /([MLHVCQZmlhvcqz])([^MLHVCQZmlhvcqz]*)/g;
    let m;
    let x = 0;
    let y = 0;
    let x0 = 0;
    let y0 = 0;
    while ((m = re.exec(d)) !== null) {
      const c = m[1];
      const C = c.toUpperCase();
      const rel = c !== C;
      if (C === 'Z') {
        segs.push({ c: 'Z', p: [] });
        x = x0;
        y = y0;
        continue;
      }
      const n = (m[2].match(NUM) || []).map(Number);
      const size = SIZE[C];
      for (let i = 0; i + size <= n.length; i += size) {
        if (C === 'H' || C === 'V') {
          if (C === 'H') x = rel ? x + n[i] : n[i];
          else y = rel ? y + n[i] : n[i];
          segs.push({ c: 'L', p: [[x, y]] });
          continue;
        }
        const pts = [];
        for (let k = 0; k < size; k += 2) pts.push(rel ? [x + n[i + k], y + n[i + k + 1]] : [n[i + k], n[i + k + 1]]);
        // A second pair after an M is a line, by SVG's own rule.
        const cc = C === 'M' && i > 0 ? 'L' : C;
        segs.push({ c: cc, p: pts });
        x = pts[pts.length - 1][0];
        y = pts[pts.length - 1][1];
        if (cc === 'M') {
          x0 = x;
          y0 = y;
        }
      }
    }
    return segs.length > 0 && segs[0].c === 'M' ? segs : null;
  };
  const fmt = (v) => String(Math.round(v * 100) / 100);
  const write = (segs) => segs.map((s) => s.c + s.p.map((q) => fmt(q[0]) + ',' + fmt(q[1])).join(' ')).join('');
  const unit = (from, to) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? null : { x: dx / len, y: dy / len, len };
  };
  const trimEnd = (d, px) => {
    const s = parse(d);
    if (s === null || s.length < 2 || !(px > 0)) return d;
    const last = s[s.length - 1];
    if (last.c === 'Z' || last.c === 'M') return d;
    const end = last.p[last.p.length - 1];
    const before = s[s.length - 2];
    const from = last.p.length > 1 ? last.p[last.p.length - 2] : before.p[before.p.length - 1];
    if (from === undefined) return d;
    const u = unit(from, end);
    if (u === null) return d;
    // A straight end is never pulled back past half of itself.
    const k = last.c === 'L' ? Math.min(px, u.len / 2) : px;
    end[0] -= u.x * k;
    end[1] -= u.y * k;
    if (last.p.length > 1) {
      from[0] -= u.x * k;
      from[1] -= u.y * k;
    }
    return write(s);
  };
  const trimStart = (d, px) => {
    const s = parse(d);
    if (s === null || s.length < 2 || !(px > 0)) return d;
    const start = s[0].p[0];
    const next = s[1];
    if (next.c === 'Z' || next.c === 'M') return d;
    const toward = next.p[0];
    const u = unit(start, toward);
    if (u === null) return d;
    const k = next.c === 'L' ? Math.min(px, u.len / 2) : px;
    start[0] += u.x * k;
    start[1] += u.y * k;
    if (next.p.length > 1) {
      toward[0] += u.x * k;
      toward[1] += u.y * k;
    }
    return write(s);
  };
  const roundCorners = (d, r) => {
    const s = parse(d);
    if (s === null || s.length < 3 || s.slice(1).some((x) => x.c !== 'L')) return d;
    const all = s.map((x) => x.p[0]);
    const P = all.filter((p, i) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 0.01);
    if (P.length < 3) return d;
    let out = 'M' + fmt(P[0][0]) + ',' + fmt(P[0][1]);
    for (let i = 1; i < P.length - 1; i += 1) {
      const a = P[i - 1];
      const b = P[i];
      const c = P[i + 1];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const turn = Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) / (l1 * l2);
      if (turn < 0.02) {
        out += 'L' + fmt(b[0]) + ',' + fmt(b[1]);
        continue;
      }
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const p1 = [b[0] - ((b[0] - a[0]) * rr) / l1, b[1] - ((b[1] - a[1]) * rr) / l1];
      const p2 = [b[0] + ((c[0] - b[0]) * rr) / l2, b[1] + ((c[1] - b[1]) * rr) / l2];
      out += 'L' + fmt(p1[0]) + ',' + fmt(p1[1]) + 'Q' + fmt(b[0]) + ',' + fmt(b[1]) + ' ' + fmt(p2[0]) + ',' + fmt(p2[1]);
    }
    const z = P[P.length - 1];
    return out + 'L' + fmt(z[0]) + ',' + fmt(z[1]);
  };
  const arrowTip = (d, refY) => {
    const s = parse(d);
    if (s === null) return null;
    const pts = [];
    for (const x of s) for (const q of x.p) pts.push(q);
    if (pts.length < 3) return null;
    const xs = pts.map((p) => p[0]);
    const max = Math.max(...xs);
    const min = Math.min(...xs);
    const onAxis = pts.filter((p) => Math.abs(p[1] - refY) < 0.01);
    if (onAxis.some((p) => Math.abs(p[0] - max) < 0.01)) return { dir: 1, tip: max };
    if (onAxis.some((p) => Math.abs(p[0] - min) < 0.01)) return { dir: -1, tip: min };
    return null;
  };
  const openChevron = (dir, apex, len, half, shaftFrom) => {
    const back = apex - dir * len;
    const arms = 'M' + fmt(back) + ',' + fmt(half) + 'L' + fmt(apex) + ',0L' + fmt(back) + ',' + fmt(-half);
    // The point is ahead of where the line stops: the head carries the rest of the line.
    const shaft = shaftFrom !== undefined && dir * (apex - shaftFrom) > 0.01
      ? 'M' + fmt(shaftFrom) + ',0L' + fmt(apex) + ',0'
      : '';
    return shaft + arms;
  };
  // The head for an edge this many px wide: a thick edge gets a bigger one.
  const arrowhead = (width) => {
    const k = Math.max(1, width / 1.5);
    return { len: 5.6 * k, half: 4.4 * k };
  };
  const elbow = (spec) => {
    // Work in a frame where the flow runs down the page (+y): TB as drawn, BT
    // flipped, LR/RL turned. Every box and point goes in; the route comes out.
    const dir = spec.axis === 'BT' || spec.axis === 'LR' || spec.axis === 'RL' ? spec.axis : 'TB';
    const fw = (p) => dir === 'TB' ? [p[0], p[1]] : dir === 'BT' ? [p[0], -p[1]] : dir === 'LR' ? [p[1], p[0]] : [p[1], -p[0]];
    const bw = (p) => dir === 'TB' ? [p[0], p[1]] : dir === 'BT' ? [p[0], -p[1]] : dir === 'LR' ? [p[1], p[0]] : [-p[1], p[0]];
    const fbox = (b) => {
      const a = fw([b.x, b.y]);
      const c = fw([b.x + b.w, b.y + b.h]);
      return { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]), kind: b.kind };
    };
    if (!spec.pts || spec.pts.length < 2) return null;
    const pts = spec.pts.map(fw);
    const S = fbox(spec.from);
    const T = fbox(spec.to);
    const others = (spec.obstacles || []).map(fbox);
    const L = spec.label ? (() => { const b = fbox(spec.label); return { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h }; })() : null;
    const r = spec.r || 0;
    const GAP = 18;
    const cx = (b) => b.x + b.w / 2;
    const cy = (b) => b.y + b.h / 2;
    const bottom = (b) => b.y + b.h;
    const right = (b) => b.x + b.w;
    const inset = (b) => Math.min(b.w / 2, r + 4);
    // The run of a side a line may meet: a box's side less its corners; a
    // decision's point, or near it (a quarter of the way along either edge).
    const span = (b, loose) => b.kind === 'diamond'
      ? (loose ? [cx(b) - b.w / 8, cx(b) + b.w / 8] : [cx(b), cx(b)])
      : [b.x + inset(b), right(b) - inset(b)];
    const pref = (b) => b.kind === 'diamond' ? cx(b) : null;
    // Where a vertical line at x meets the box's top or bottom.
    const topAt = (b, x) => b.kind === 'diamond' ? b.y + Math.abs(x - cx(b)) * (b.h / b.w) : b.y;
    const botAt = (b, x) => b.kind === 'diamond' ? bottom(b) - Math.abs(x - cx(b)) * (b.h / b.w) : bottom(b);
    const sidePort = (b, s) => b.kind === 'diamond'
      ? [s > 0 ? right(b) : b.x, cy(b)]
      : [s > 0 ? right(b) : b.x, cy(b)];
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // Does a run cut a box? Its own ends' boxes count past the point it leaves
    // or enters them; so do the other labels and the edges drawn before it.
    // A run and a box: a decision is its diamond, not the square round it (a
    // line meeting a decision's edge off its point starts inside that square).
    const cut = (x1, y1, x2, y2, b) => {
      if (!(Math.max(x1, x2) > b.x + 1 && Math.min(x1, x2) < right(b) - 1 && Math.max(y1, y2) > b.y + 1 && Math.min(y1, y2) < bottom(b) - 1)) return false;
      if (b.kind !== 'diamond') return true;
      const a = b.w / 2 - 1;
      const e = b.h / 2 - 1;
      if (Math.abs(x1 - x2) < 0.01) {
        const reach = e * (1 - Math.abs(x1 - cx(b)) / a);
        return reach > 0 && Math.max(y1, y2) > cy(b) - reach && Math.min(y1, y2) < cy(b) + reach;
      }
      const reach = a * (1 - Math.abs(y1 - cy(b)) / e);
      return reach > 0 && Math.max(x1, x2) > cx(b) - reach && Math.min(x1, x2) < cx(b) + reach;
    };
    const hits = (q, lab) => {
      const boxes = [S, T, ...others];
      for (let i = 1; i < q.length; i += 1) {
        const [x1, y1] = q[i - 1];
        const [x2, y2] = q[i];
        for (const b of boxes) if (cut(x1, y1, x2, y2, b)) return true;
      }
      if (lab) {
        const lb = { x: lab.x - L.w / 2, y: lab.y - L.h / 2, w: L.w, h: L.h };
        for (const b of [S, T, ...others]) {
          if (lb.x < right(b) && right(lb) > b.x && lb.y < bottom(b) && bottom(lb) > b.y) return true;
        }
      }
      return false;
    };
    const cands = [];
    const forward = T.y >= bottom(S) - 1;
    const backward = bottom(T) <= S.y + 1;
    const room = (a, b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
    const labOn = (x, y0, y1) => L ? { x, y: clamp(L.y, Math.min(y0, y1) + L.h / 2 + 4, Math.max(y0, y1) - L.h / 2 - 4) } : null;
    const straight = (loose) => {
      const [lo, hi] = room(span(S, loose), span(T, loose));
      if (lo > hi + 0.01) return;
      const xs = [pref(S), pref(T), L ? L.x : null, pts[0][0], pts[pts.length - 1][0], (lo + hi) / 2, lo, hi]
        .filter((v) => v !== null && v >= lo - 0.01 && v <= hi + 0.01);
      for (const x of xs) {
        const q = forward ? [[x, botAt(S, x)], [x, topAt(T, x)]] : [[x, topAt(S, x)], [x, botAt(T, x)]];
        cands.push({ q, lab: labOn(x, q[0][1], q[1][1]) });
      }
    };
    if (forward) {
      // 1. Straight down, when the two sides share room — a decision at its point.
      straight(false);
      // 2. A decision's branch: out of the corner it turns toward, across, then down.
      if (S.kind === 'diamond') {
        for (const s of [Math.sign((L ? L.x : cx(T)) - cx(S)) || 1, -(Math.sign((L ? L.x : cx(T)) - cx(S)) || 1)]) {
          const [tl, th] = span(T);
          const xs = [pref(T), L ? L.x : null, pts[pts.length - 1][0], cx(T), tl, th].filter((v) => v !== null && v >= tl - 0.01 && v <= th + 0.01);
          for (const x of xs) {
            const v = sidePort(S, s);
            if (s * (x - v[0]) < GAP / 2) continue;
            const q = [v, [x, v[1]], [x, topAt(T, x)]];
            cands.push({ q, lab: labOn(x, v[1], q[2][1]) });
          }
        }
      }
      // 3. Down, across, down (the across at the label, or halfway).
      {
        const [sl, sh] = span(S);
        const [tl, th] = span(T);
        const xa = pref(S) ?? clamp(L ? L.x : pts[0][0], sl, sh);
        const xb = pref(T) ?? clamp(L ? L.x : pts[pts.length - 1][0], tl, th);
        const y0 = botAt(S, xa);
        const y1 = topAt(T, xb);
        const ym = L ? clamp(L.y, y0 + 8, y1 - 8) : (y0 + y1) / 2;
        const q = [[xa, y0], [xa, ym], [xb, ym], [xb, y1]];
        cands.push({ q, lab: L ? { x: clamp(L.x, Math.min(xa, xb), Math.max(xa, xb)), y: ym } : null });
      }
      // 4. Straight, meeting a decision off its point (two edges that share one).
      straight(true);
    } else if (backward) {
      // 1. Straight up, beside whatever runs down (dagre put the label there).
      const [lo, hi] = room(span(S, true), span(T, true));
      if (lo <= hi + 0.01 && L) {
        const x = clamp(L.x, lo, hi);
        const q = [[x, topAt(S, x)], [x, botAt(T, x)]];
        cands.push({ q, lab: labOn(x, q[0][1], q[1][1]) });
      }
      // 2. Round the side the label is on: out of the side, up past both, back in.
      const mids = pts.slice(1, -1);
      const lean = L ? L.x : mids.length > 0 ? mids.reduce((u, v) => u + v[0], 0) / mids.length : cx(S) + 1;
      for (const s of [Math.sign(lean - (cx(S) + cx(T)) / 2) || 1, -(Math.sign(lean - (cx(S) + cx(T)) / 2) || 1)]) {
        const edge = s > 0 ? Math.max(right(S), right(T)) : Math.min(S.x, T.x);
        // Far enough out for the line, then for its label to clear both boxes.
        const half = L ? L.w / 2 + 6 : 0;
        const xs = [0, 1, 2, 3].map((k) => edge + s * (GAP + k * GAP)).concat([0, 1, 2].map((k) => edge + s * (half + GAP / 2 + k * GAP)));
        if (L && s * (L.x - edge) >= GAP - 0.01) xs.unshift(L.x);
        for (const X of xs) {
          const a = sidePort(S, s);
          const z = sidePort(T, s);
          const q = [a, [X, a[1]], [X, z[1]], z];
          cands.push({ q, lab: labOn(X, a[1], z[1]) });
        }
      }
    } else {
      // Side by side: out of the facing sides, across (a jog at halfway).
      const s = Math.sign(cx(T) - cx(S)) || 1;
      const a = sidePort(S, s);
      const z = sidePort(T, -s);
      const xm = L ? L.x : (a[0] + z[0]) / 2;
      const q = Math.abs(a[1] - z[1]) < 0.01 ? [a, z] : [a, [xm, a[1]], [xm, z[1]], z];
      cands.push({ q, lab: L ? { x: xm, y: Math.abs(a[1] - z[1]) < 0.01 ? a[1] : clamp(L.y, Math.min(a[1], z[1]), Math.max(a[1], z[1])) } : null });
    }
    const chosen = cands.find((c) => !hits(c.q, c.lab));
    if (!chosen) return null;
    // Duplicates and straight-through points out.
    const out = [];
    for (const q of chosen.q) {
      const prev = out[out.length - 1];
      if (prev && Math.hypot(q[0] - prev[0], q[1] - prev[1]) < 0.01) continue;
      out.push(q);
      while (out.length >= 3) {
        const [u, v, w] = out.slice(-3);
        const cross = (v[0] - u[0]) * (w[1] - v[1]) - (v[1] - u[1]) * (w[0] - v[0]);
        const dot = (v[0] - u[0]) * (w[0] - v[0]) + (v[1] - u[1]) * (w[1] - v[1]);
        if (Math.abs(cross) < 0.01 && dot >= 0) out.splice(out.length - 2, 1);
        else break;
      }
    }
    return { pts: out.map(bw), label: chosen.lab ? bw([chosen.lab.x, chosen.lab.y]) : null };
  };
  const roundedRect = (x, y, w, h, r) => {
    const q = Math.max(0, Math.min(r, w / 2, h / 2));
    const a = (tx, ty) => 'A' + fmt(q) + ',' + fmt(q) + ' 0 0 1 ' + fmt(tx) + ',' + fmt(ty);
    return (
      'M' + fmt(x + q) + ',' + fmt(y) + 'H' + fmt(x + w - q) + a(x + w, y + q) +
      'V' + fmt(y + h - q) + a(x + w - q, y + h) + 'H' + fmt(x + q) + a(x, y + h - q) +
      'V' + fmt(y + q) + a(x + q, y) + 'Z'
    );
  };
  return { parse, write, trimEnd, trimStart, roundCorners, arrowTip, openChevron, arrowhead, elbow, roundedRect };
})()`;

/**
 * The page's two calls, as plain JavaScript (it runs in the window, not in
 * this process — and a string survives any bundler untouched).
 *
 *   __pdParse(source)  → ParseResult
 *   __pdRender(req)    → { svg, width, height }
 *
 * The render's post-pass, in order: the sketch's hatching put back; Mermaid's
 * own slips (a timeline's axis, a mind map's root); THE LOOK — empty helper
 * shapes out, rounded boxes (class and entity boxes redrawn as one rounded
 * shape under their rows, one hairline over them), each edge label on a pill,
 * a group's name in its corner and above the edges, the polyline elbows
 * rounded, every arrowhead Bobble's own in its edge's colour (a UML or
 * crow's-foot marker keeps its shape and takes the colour), halos under words
 * that cross lines, and a `data-k` key on every part a live card animates;
 * the contrast guard (every label against the painted shape under it: ink,
 * paper, white or black, whichever reads best when the one it has falls under
 * 4.5:1); every computed paint and type property written onto its element and
 * every <style> removed; then the drawing is set on the kit's paper under its
 * title.
 */
export const PAGE_SCRIPT = String.raw`(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const P = ${PATH_TOOLS_JS};
  const lum = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    if (p.length > 3 && p[3] < 0.5) return null;
    const ch = p.slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const hexLum = (h) => lum('rgb(' + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',') + ')');
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const toHex = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { hex: '#' + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase(), alpha: p.length > 3 ? p[3] : 1 };
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const set = (el, attrs) => { for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(Math.round(Number(v) * 100) / 100)); };

  window.__pdParse = async (source) => {
    try {
      await mermaid.parse(source);
    } catch (e) {
      const hash = e && e.hash;
      const m = /line (\d+)/i.exec(String((e && e.message) || e));
      return {
        ok: false,
        message: String((e && e.message) || e).slice(0, 600),
        name: (e && e.name) || null,
        line: hash && hash.loc ? hash.loc.first_line : m ? Number(m[1]) : null,
        token: hash && hash.token != null ? String(hash.token) : null,
        expected: hash && Array.isArray(hash.expected) ? hash.expected.slice(0, 16).map(String) : [],
      };
    }
    let type = null;
    let vertices = [];
    let edges = [];
    try {
      const d = await mermaid.mermaidAPI.getDiagramFromText(source);
      type = d.type || null;
      if (d.db && typeof d.db.getVertices === 'function' && typeof d.db.getEdges === 'function') {
        const v = d.db.getVertices();
        vertices = (v instanceof Map ? [...v.values()] : Object.values(v)).map((x) => ({
          id: String(x.id), text: String(x.text == null ? x.id : x.text), shape: x.type || null, classes: (x.classes || []).map(String),
        }));
        edges = d.db.getEdges().map((x) => ({ start: String(x.start), end: String(x.end), text: String(x.text || ''), stroke: String(x.stroke || 'normal') }));
      }
    } catch (e) { /* the structure is a bonus; the render does not need it */ }
    return { ok: true, type, vertices, edges };
  };

  window.__pdRender = async (req) => {
    mermaid.initialize(req.config);
    const host = document.getElementById('host');
    host.innerHTML = '';
    const out = await mermaid.render(req.id, req.source);
    host.innerHTML = out.svg;
    const root = host.querySelector('svg');
    if (!root) throw new Error('Mermaid drew nothing');
    const t = req.theme;
    const k = req.look;
    const svgId = root.id;
    const role = root.getAttribute('aria-roledescription') || '';

    // 0. The sketch look's hatching is a path of 4 px strokes whose stroke
    // ATTRIBUTE is the node's fill colour — but a class's colours are a CSS
    // rule with !important that reaches every path of the node, and it
    // repainted the hatching in the BORDER colour: a failure step came out a
    // solid block of dark orange over its own words (a bare-Electron render,
    // 2026-09-25). The hatching is put back in its own colour. (A sketched
    // node is a g.rough-node, not a g.node.)
    const sketch = req.config && req.config.look === 'handDrawn';
    if (sketch) {
      for (const p of root.querySelectorAll('g.rough-node path[stroke-width="4"], g.node path[stroke-width="4"]')) {
        const own = p.getAttribute('stroke');
        if (own && own !== 'none') {
          p.style.setProperty('stroke', own, 'important');
          p.style.setProperty('fill', 'none', 'important');
        }
      }
    }

    // 1. Two of Mermaid's own slips, where they showed (a render of each
    // kind the tool offers, 2026-09-25): a timeline paints its axis and its
    // connectors in the last section's LABEL colour — white on the paper, so
    // the line was gone; a mind map's round root sets its words from its
    // centre rather than about it, so "Launch" ran out of its circle.
    for (const l of root.querySelectorAll('.lineWrapper line')) l.style.setProperty('stroke', t.line, 'important');
    for (const node of root.querySelectorAll('g.mindmap-node')) {
      const label = node.querySelector(':scope > g.label');
      if (!node.querySelector(':scope > circle') || !label) continue;
      const bb = label.getBBox();
      const at = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)\s*\)/.exec(label.getAttribute('transform') || '');
      const dx = -(bb.x + bb.width / 2);
      if (Math.abs(dx - (at ? Number(at[1]) : 0)) > 1) {
        label.setAttribute('transform', 'translate(' + dx + ', ' + (at ? Number(at[2]) : 0) + ')');
      }
    }

    // 2. THE LOOK (diagramLook / diagramLookCss; the user, 2026-09-25: "custom
    // mermaid arrows and box styling").
    // 2a. Mermaid's empty helpers out: a label's zero-size boxes (each one a
    // 1.25 px ink outline waiting for a size), an unlabelled edge's label.
    for (const r of [...root.querySelectorAll('rect')]) {
      if (r.closest('marker, defs, clipPath, pattern, symbol')) continue;
      const w = parseFloat(r.getAttribute('width') || '0');
      const h = parseFloat(r.getAttribute('height') || '0');
      if (!(w > 0) || !(h > 0)) r.remove();
    }
    for (const g of [...root.querySelectorAll('g.edgeLabel')]) {
      if ((g.textContent || '').trim() === '') g.remove();
    }

    // 2a'. ELBOWS (the user, 2026-09-25: "curved path eg. elbow arrows"). A
    // flowchart's edges are laid out by dagre as points; Mermaid joined them
    // with the kit's curve — soft S-bends that wandered through their own
    // labels, or steps that jogged a few pixels at every rank. Each edge is
    // re-drawn from the same points (P.elbow): square out of its box, a
    // decision's branches from the corner they turn toward, through its label,
    // square into the next box, corners rounded. The drawing's layout is
    // untouched, so nothing else moves.
    const routed = new Set();
    // Flowcharts, and state diagrams (the same flow, with states for steps).
    if (role.startsWith('flowchart') || /^statediagram/i.test(role)) {
      const dirM = /^\s*(?:(?:flowchart|graph)\s+|direction\s+)(TB|TD|BT|RL|LR)\b/im.exec(req.source || '');
      const axis = dirM ? (dirM[1].toUpperCase() === 'TD' ? 'TB' : dirM[1].toUpperCase()) : 'TB';
      const radius = t.curve === 'step' ? 7 : t.curve === 'linear' ? 9 : 12;
      const prefix = svgId + '-';
      const nodes = new Map();
      const allNodes = [...root.querySelectorAll('g.node')];
      for (const g of allNodes) {
        const own = (g.id || '').startsWith(prefix) ? g.id.slice(prefix.length) : g.id || '';
        const m = /^flowchart-(.+)-\d+$/.exec(own);
        if (m) nodes.set(m[1], g);
      }
      // A box in the edges' coordinates — a node's SHAPE's, not its group's
      // (the words can overhang a decision by half a pixel, which put a kink
      // over every corner it was entered by); a label's words with the room
      // its pill will take round them (2c).
      const frame = root.querySelector('g.edgePaths');
      const boxOf = (els, pad) => {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const el of els) {
          const b = el.getBBox();
          if (!(b.width > 0 || b.height > 0)) continue;
          const m = frame.getCTM().inverse().multiply(el.getCTM());
          for (const [px, py] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
            const q = new DOMPoint(px, py).matrixTransform(m);
            x0 = Math.min(x0, q.x);
            y0 = Math.min(y0, q.y);
            x1 = Math.max(x1, q.x);
            y1 = Math.max(y1, q.y);
          }
        }
        if (!Number.isFinite(x0)) return null;
        return { x: x0 - pad[0], y: y0 - pad[1], w: x1 - x0 + 2 * pad[0], h: y1 - y0 + 2 * pad[1] };
      };
      const nodeBox = (g) => {
        const shapes = [...g.querySelectorAll('rect, polygon, path, circle, ellipse')].filter(
          (el) => !el.closest('g.label, text, marker, defs, clipPath'),
        );
        const b = boxOf(shapes.length > 0 ? shapes : [g], [0, 0]);
        if (!b) return null;
        const poly = g.querySelector(':scope > polygon, :scope > g > polygon');
        const diamond = !!poly && (poly.getAttribute('points') || '').trim().split(/\s+/).length === 4;
        return { ...b, kind: diamond ? 'diamond' : 'box' };
      };
      const boxes = new Map(allNodes.map((g) => [g, nodeBox(g)]));
      // A label knows its edge (its inner group carries the edge's id).
      const labels = new Map();
      for (const g of root.querySelectorAll('g.edgeLabel')) {
        const inner = g.querySelector('[data-id]');
        const id = inner && inner.getAttribute('data-id');
        const at = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)\s*\)/.exec(g.getAttribute('transform') || '');
        const b = boxOf([g], [8, 5]);
        if (id && at && b) labels.set(id, { g, x: Number(at[1]), y: Number(at[2]), box: b });
      }
      // An edge's two ends: named in a flowchart edge's id (L_<from>_<to>_<n>);
      // otherwise (a state diagram's edge0, edge1…) the boxes its first and
      // last points sit on.
      const nearest = (q) => {
        let best = null;
        let dist = 4;
        for (const [g, b] of boxes) {
          if (!b) continue;
          const dx = Math.max(b.x - q[0], 0, q[0] - (b.x + b.w));
          const dy = Math.max(b.y - q[1], 0, q[1] - (b.y + b.h));
          const d = Math.hypot(dx, dy);
          if (d < dist) {
            dist = d;
            best = g;
          }
        }
        return best;
      };
      const ends = (id, pts) => {
        const m = /^L_(.+)_\d+$/.exec(id || '');
        if (m) {
          const rest = m[1];
          for (let i = rest.indexOf('_'); i > 0; i = rest.indexOf('_', i + 1)) {
            const a = rest.slice(0, i);
            const b = rest.slice(i + 1);
            if (nodes.has(a) && nodes.has(b)) return [nodes.get(a), nodes.get(b)];
          }
        }
        const a = nearest(pts[0]);
        const b = nearest(pts[pts.length - 1]);
        return a && b ? [a, b] : null;
      };
      const along = (b) => (axis === 'LR' ? b.x + b.w / 2 : axis === 'RL' ? -(b.x + b.w / 2) : axis === 'BT' ? -(b.y + b.h / 2) : b.y + b.h / 2);
      const edges = [];
      for (const path of root.querySelectorAll('g.edgePaths > path')) {
        const id = path.getAttribute('data-id');
        let pts;
        try {
          pts = JSON.parse(atob(path.getAttribute('data-points') || '')).map((q) => [q.x, q.y]);
        } catch (e) { continue; }
        if (!Array.isArray(pts) || pts.length < 2 || pts.some((q) => !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) continue;
        const pair = ends(id, pts);
        if (!pair || pair[0] === pair[1]) continue;
        const from = boxes.get(pair[0]);
        const to = boxes.get(pair[1]);
        if (!from || !to) continue;
        edges.push({ path, id, pair, from, to, pts, back: along(to) < along(from) });
      }
      // The edges that run with the flow first: a loop back finds its way round them.
      edges.sort((u, v) => Number(u.back) - Number(v.back));
      const drawn = [];
      // Twice: an edge with no clear way on the first pass tries again once the
      // others are down (a loop that went round the side took its label with it).
      const pending = [...edges, ...edges];
      const done = new Set();
      for (const e of pending) {
        if (done.has(e)) continue;
        const lab = labels.get(e.id) || null;
        // Only the labels already set down are in the way: one not yet routed
        // moves with its own edge (and keeps off the lines drawn before it).
        const obstacles = [
          ...[...boxes.entries()].filter(([g]) => g !== e.pair[0] && g !== e.pair[1]).map(([, b]) => b).filter(Boolean),
          ...[...done].map((d) => labels.get(d.id)).filter(Boolean).map((l) => l.box),
          ...drawn,
        ];
        const route = P.elbow({ pts: e.pts, from: e.from, to: e.to, label: lab ? lab.box : null, obstacles, axis, r: radius });
        if (!route || route.pts.length < 2) continue;
        done.add(e);
        e.path.setAttribute('d', P.roundCorners('M' + route.pts.map((q) => q[0] + ',' + q[1]).join('L'), radius));
        e.path.setAttribute('data-pd-routed', '1');
        routed.add(e.path);
        // Later edges keep off this one (a few pixels either side of each run).
        for (let i = 1; i < route.pts.length; i += 1) {
          const [x1, y1] = route.pts[i - 1];
          const [x2, y2] = route.pts[i];
          drawn.push({ x: Math.min(x1, x2) - 3, y: Math.min(y1, y2) - 3, w: Math.abs(x2 - x1) + 6, h: Math.abs(y2 - y1) + 6, kind: 'box' });
        }
        if (lab && route.label) {
          const [lx, ly] = route.label;
          if (Math.hypot(lx - lab.x, ly - lab.y) > 0.01) {
            lab.box = { ...lab.box, x: lab.box.x + lx - lab.x, y: lab.box.y + ly - lab.y };
            lab.x = lx;
            lab.y = ly;
            lab.g.setAttribute('transform', 'translate(' + lx + ', ' + ly + ')');
          }
        }
      }
      // Anything the router left (no route stayed clear) keeps Mermaid's straight runs, corners rounded.
      for (const path of root.querySelectorAll('g.edgePaths > path')) {
        if (routed.has(path)) continue;
        const d = path.getAttribute('d');
        if (d) path.setAttribute('d', P.roundCorners(d, radius));
        routed.add(path);
        path.setAttribute('data-pd-routed', 'mermaid');
      }
      // A loop round the side, or a label moved onto it, can leave the frame
      // Mermaid measured before any of this: the frame grows to hold them (a
      // "retry" pill was cut in half at the drawing's edge).
      const vbox = root.viewBox && root.viewBox.baseVal;
      if (vbox && vbox.width > 0 && vbox.height > 0) {
        const at = root.getBoundingClientRect();
        const kx = vbox.width / (at.width || vbox.width);
        const ky = vbox.height / (at.height || vbox.height);
        let x0 = vbox.x;
        let y0 = vbox.y;
        let x1 = vbox.x + vbox.width;
        let y1 = vbox.y + vbox.height;
        for (const el of [...routed, ...[...labels.values()].map((l) => l.g)]) {
          if (!el.isConnected) continue;
          const b = el.getBoundingClientRect();
          if (!(b.width > 0 || b.height > 0)) continue;
          x0 = Math.min(x0, vbox.x + (b.left - at.left) * kx - 8);
          y0 = Math.min(y0, vbox.y + (b.top - at.top) * ky - 8);
          x1 = Math.max(x1, vbox.x + (b.right - at.left) * kx + 8);
          y1 = Math.max(y1, vbox.y + (b.bottom - at.top) * ky + 8);
        }
        if (x0 < vbox.x - 0.5 || y0 < vbox.y - 0.5 || x1 > vbox.x + vbox.width + 0.5 || y1 > vbox.y + vbox.height + 0.5) {
          root.setAttribute('viewBox', [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v * 100) / 100).join(' '));
          root.setAttribute('width', String(Math.ceil(x1 - x0)));
          root.setAttribute('height', String(Math.ceil(y1 - y0)));
          root.style.maxWidth = '';
        }
      }
    }

    // 2b. Boxes: the kit's corners on a plain one (a rounded or a stadium
    // node keeps its own; a state takes the kit's over Mermaid's 5 px), and
    // a class or entity box redrawn as ONE rounded shape — Mermaid draws it
    // square, as two rough-edged paths, with each attribute row's own border
    // over the box's. Its rows are clipped to the rounded shape, and one
    // hairline goes over the top of them all.
    const radius = t.radius;
    for (const r of root.querySelectorAll('g.node rect.label-container, g.node rect.basic')) {
      const own = r.getAttribute('rx');
      if (!own || own === '0' || r.closest('.statediagram-state')) set(r, { rx: radius, ry: radius });
    }
    for (const r of root.querySelectorAll('rect.actor, rect.note')) set(r, { rx: Math.max(3, radius - 2), ry: Math.max(3, radius - 2) });
    // A state diagram's start is a solid dot and its end a dot in a ring,
    // both in ink (UML's own marks) — the step styling above reached them.
    for (const c of root.querySelectorAll('circle.state-start')) {
      c.style.fill = t.ink;
      c.style.stroke = 'none';
    }
    if (root.classList.contains('statediagram') && !sketch) {
      for (const n of root.querySelectorAll('g.node')) {
        if (!/_end(?:-\d+)?$/.test(n.id)) continue;
        const [paper, ring, dot, rim] = n.querySelectorAll('path');
        if (!rim) continue;
        paper.style.fill = t.paper;
        paper.style.stroke = 'none';
        ring.style.fill = 'none';
        ring.style.stroke = t.ink;
        ring.style.strokeWidth = '1.5px';
        dot.style.fill = t.ink;
        dot.style.stroke = 'none';
        rim.style.stroke = 'none';
        rim.style.fill = 'none';
      }
    }
    let clips = 0;
    if (!sketch) {
      for (const node of root.querySelectorAll('g.node')) {
        const outer = node.querySelector(':scope > g.outer-path');
        if (!outer || !(root.classList.contains('classDiagram') || root.classList.contains('erDiagram'))) continue;
        const bb = outer.getBBox();
        if (!(bb.width > 0 && bb.height > 0)) continue;
        const d = P.roundedRect(bb.x, bb.y, bb.width, bb.height, radius);
        const base = document.createElementNS(NS, 'path');
        base.setAttribute('d', d);
        base.style.fill = k.node;
        base.style.stroke = 'none';
        outer.replaceChildren(base);
        const edge = document.createElementNS(NS, 'path');
        edge.setAttribute('d', d);
        edge.setAttribute('class', 'pd-box-edge');
        edge.style.fill = 'none';
        edge.style.stroke = k.nodeEdge;
        edge.style.strokeWidth = '1.5px';
        const rows = node.querySelectorAll(':scope > g.row-rect-odd, :scope > g.row-rect-even');
        if (rows.length > 0) {
          const clip = document.createElementNS(NS, 'clipPath');
          clip.id = svgId + '-pdclip-' + (clips += 1);
          const shape = document.createElementNS(NS, 'path');
          shape.setAttribute('d', d);
          clip.appendChild(shape);
          node.insertBefore(clip, node.firstChild);
          for (const row of rows) {
            const ps = row.querySelectorAll('path');
            for (let i = 1; i < ps.length; i += 1) ps[i].remove();
            row.setAttribute('clip-path', 'url(#' + clip.id + ')');
          }
        }
        for (const dv of node.querySelectorAll(':scope > g.divider')) {
          // A divider is a zero-area fill and a rough stroke: the stroke alone.
          const ps = dv.querySelectorAll('path');
          if (ps.length > 1) ps[0].remove();
        }
        node.appendChild(edge);
      }
    }

    // 2c. Each edge label on a pill of paper, a hairline round it; the words
    // are a step down from a step's (diagramLookCss) — Mermaid drew a hard
    // rectangle at half opacity, so the line showed straight through "yes".
    for (const g of root.querySelectorAll('g.edgeLabel')) {
      const text = [...g.querySelectorAll('text')].find((x) => (x.textContent || '').trim() !== '');
      if (!text) continue;
      const holder = text.parentNode;
      let bg = holder.querySelector(':scope > rect');
      if (!bg) bg = document.createElementNS(NS, 'rect');
      holder.insertBefore(bg, text);
      const bb = text.getBBox();
      const h = bb.height + 5;
      set(bg, { x: bb.x - 7, y: bb.y - 2.5, width: bb.width + 14, height: h, rx: Math.min(h / 2, 10), ry: Math.min(h / 2, 10) });
      bg.setAttribute('class', 'pd-pill');
      bg.style.fill = k.pill;
      bg.style.stroke = k.pillEdge;
      bg.style.strokeWidth = '1px';
      bg.style.opacity = '1';
    }
    for (const r of root.querySelectorAll('.labelBkg')) r.style.opacity = '1';

    // 2d. A group's name in its top-left corner — Mermaid centres it on the
    // top edge, where an edge coming into the group ran straight through it
    // ("Wareh|ouse") — and lifted above the edges, on a halo of the group's
    // own field.
    const groupNames = [];
    for (const c of root.querySelectorAll('g.cluster')) {
      const rect = c.querySelector(':scope > rect');
      if (rect) set(rect, { rx: radius + 4, ry: radius + 4 });
      const label = c.querySelector(':scope > g.cluster-label');
      // The sketch look draws the frame as rough paths in a group of its own.
      const frame = rect || [...c.children].find((x) => x !== label);
      if (!frame || !label) continue;
      const rb = frame.getBBox();
      const lb = label.getBBox();
      label.setAttribute('transform', 'translate(' + (rb.x + 10 - lb.x) + ', ' + (rb.y + 7 - lb.y) + ')');
      groupNames.push({ label, cluster: c });
    }
    const edgeLayer = root.querySelector('g.edgePaths');
    if (edgeLayer && groupNames.length > 0) {
      const layer = document.createElementNS(NS, 'g');
      layer.setAttribute('class', 'pd-group-names');
      edgeLayer.parentNode.insertBefore(layer, edgeLayer.nextSibling);
      for (const { label } of groupNames) {
        const m = layer.getCTM().inverse().multiply(label.getCTM());
        label.setAttribute('transform', Math.abs(m.a - 1) < 1e-6 && Math.abs(m.d - 1) < 1e-6 && Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6
          ? 'translate(' + m.e + ', ' + m.f + ')'
          : 'matrix(' + [m.a, m.b, m.c, m.d, m.e, m.f].join(' ') + ')');
        layer.appendChild(label);
      }
    }

    // 2e. Words: no outline on any (Mermaid's participant rule stroked the
    // names in the border colour); a halo of what is behind them on the ones
    // that sit across lines — a group's name, an alt block's condition, a
    // class edge's multiplicity.
    for (const x of root.querySelectorAll('text, tspan')) x.style.stroke = 'none';
    const halo = (text, colour) => {
      for (const x of [text, ...text.querySelectorAll('tspan')]) {
        x.style.stroke = colour;
        x.style.strokeWidth = '4px';
        x.style.strokeLinejoin = 'round';
        x.style.paintOrder = 'stroke';
      }
    };
    for (const { label } of groupNames) for (const x of label.querySelectorAll('text')) halo(x, k.group);
    for (const x of root.querySelectorAll('text.loopText, text.sectionTitle, g.edgeTerminals text')) halo(x, t.paper);

    // 2f. Edges: a polyline's elbows rounded (a linear or step kit), then
    // every arrowhead Bobble's own — a small filled chevron with a softened
    // tip, in the edge's colour, sized to its stroke, its tip exactly where
    // Mermaid's was. A marker that means something else (UML's hollow
    // triangle and diamonds, an ER crow's foot) keeps its shape and takes the
    // edge's colour, at the size Mermaid drew it for a 1 px line.
    if (t.curve !== 'basis') {
      const r = t.curve === 'step' ? 7 : 9;
      for (const p of root.querySelectorAll('g.edgePaths > path')) {
        if (routed.has(p)) continue;
        const d = p.getAttribute('d');
        if (d) p.setAttribute('d', P.roundCorners(d, r));
      }
    }
    // (Mermaid names a coloured edge's own copy "<name>__<hex>", or in the
    // sketch look "<name>_stroke__<hex>".)
    const ARROW = /(?:pointEnd|pointStart|barbEnd|arrowhead|dependencyEnd|dependencyStart|filled-head)(?:-margin)?(?:_\w+)?$/;
    const FILLED = /composition/;
    const defs = document.createElementNS(NS, 'defs');
    root.insertBefore(defs, root.firstChild);
    const made = new Map();
    const lineEnd = (el, which) => which === 'marker-end'
      ? ['x2', 'y2', 'x1', 'y1']
      : ['x1', 'y1', 'x2', 'y2'];
    const pull = (el, which, px) => {
      if (!(px > 0)) return;
      if (el.tagName.toLowerCase() === 'line') {
        const [ax, ay, bx, by] = lineEnd(el, which).map((a) => Number(el.getAttribute(a)));
        const len = Math.hypot(bx - ax, by - ay);
        if (!(len > px * 2)) return;
        const [nx, ny] = lineEnd(el, which);
        el.setAttribute(nx, String(ax + ((bx - ax) * px) / len));
        el.setAttribute(ny, String(ay + ((by - ay) * px) / len));
        return;
      }
      const d = el.getAttribute('d');
      if (d) el.setAttribute('d', which === 'marker-end' ? P.trimEnd(d, px) : P.trimStart(d, px));
    };
    for (const el of root.querySelectorAll('path[marker-end], path[marker-start], line[marker-end], line[marker-start]')) {
      if (el.closest('marker')) continue;
      const cs = getComputedStyle(el);
      const colour = toHex(cs.stroke);
      if (!colour) continue;
      const width = parseFloat(cs.strokeWidth) || 1;
      for (const which of ['marker-end', 'marker-start']) {
        const ref = /url\(#([^)]+)\)/.exec(el.getAttribute(which) || '');
        if (!ref) continue;
        const m = root.querySelector('marker#' + CSS.escape(ref[1]));
        if (!m) continue;
        const orient = m.getAttribute('orient') || 'auto';
        const refX = parseFloat(m.getAttribute('refX') || '0');
        const refY = parseFloat(m.getAttribute('refY') || '0');
        const vb = m.viewBox && m.viewBox.baseVal;
        const mw = parseFloat(m.getAttribute('markerWidth') || '3');
        const mh = parseFloat(m.getAttribute('markerHeight') || '3');
        const s = vb && vb.width > 0 && vb.height > 0 ? Math.min(mw / vb.width, mh / vb.height) : 1;
        const shape = m.querySelector('path');
        const tip = ARROW.test(ref[1]) && shape ? P.arrowTip(shape.getAttribute('d'), refY) : null;
        let id;
        if (tip) {
          // Which way is "out" along the marker's own x: forward at the end;
          // at the start, back — unless the marker turns itself round there.
          const outward = which === 'marker-end' || orient === 'auto-start-reverse' ? 1 : -1;
          // Where the point goes, in the marker's own units: Mermaid's tip,
          // less half the stroke (the round join reaches that far past it).
          // A routed edge (2a') already ends on its box, so it stops half a
          // stroke short and the point sits on its end.
          let apex;
          let shaftFrom;
          if (el.getAttribute('data-pd-routed') === '1') {
            pull(el, which, width / 2);
            apex = 0;
          } else {
            apex = (tip.tip - refX) * s - tip.dir * (width / 2);
            if (tip.dir === outward && apex * outward < -0.01) {
              // The line runs past the point: pulled back to it, so its round
              // cap never shows beyond.
              const by = -apex * outward;
              pull(el, which, by);
              apex += outward * by;
            } else if (tip.dir === outward && apex * outward > 0.01) {
              // The point is ahead of where the line stops: the head carries
              // the last of the line to it.
              shaftFrom = 0;
            }
          }
          const size = P.arrowhead(width);
          const key = ['a', colour.hex.slice(1), Math.round(width * 10), Math.round(apex * 10), shaftFrom === undefined ? 0 : 1, tip.dir, orient].join('_');
          id = made.get(key);
          if (!id) {
            id = svgId + '_pd' + key.replace(/[^\w-]/g, '');
            const mk = document.createElementNS(NS, 'marker');
            mk.id = id;
            mk.setAttribute('viewBox', '-24 -14 48 28');
            mk.setAttribute('markerWidth', '48');
            mk.setAttribute('markerHeight', '28');
            mk.setAttribute('refX', '0');
            mk.setAttribute('refY', '0');
            mk.setAttribute('markerUnits', 'userSpaceOnUse');
            mk.setAttribute('orient', orient);
            // An open ">" in the edge's own stroke — never a filled triangle.
            const head = document.createElementNS(NS, 'path');
            head.setAttribute('d', P.openChevron(tip.dir, apex, size.len, size.half, shaftFrom));
            head.style.fill = 'none';
            head.style.stroke = colour.hex;
            head.style.strokeWidth = width + 'px';
            head.style.strokeLinecap = 'round';
            head.style.strokeLinejoin = 'round';
            mk.appendChild(head);
            defs.appendChild(mk);
            made.set(key, id);
          }
        } else {
          const key = ['k', ref[1], colour.hex.slice(1)].join('_');
          id = made.get(key);
          if (!id) {
            id = svgId + '_pd' + key.replace(/[^\w-]/g, '');
            const copy = m.cloneNode(true);
            copy.id = id;
            // Drawn for Mermaid's own 1 px line: kept at that size when the
            // line is not (a strokeWidth marker grows with its line).
            copy.setAttribute('markerUnits', 'userSpaceOnUse');
            const inner = 1.25 / s;
            for (const part of copy.querySelectorAll('path, circle, polygon, line')) {
              const own = getComputedStyle(part).fill;
              const hollow = own === 'none' || /^rgba\(0, 0, 0, 0\)$/.test(own) || part.getAttribute('fill') === 'none' || part.getAttribute('fill') === 'transparent';
              part.style.stroke = colour.hex;
              part.style.strokeWidth = inner + 'px';
              part.style.strokeLinejoin = 'round';
              part.style.strokeLinecap = 'round';
              part.style.fill = hollow ? 'none' : FILLED.test(ref[1]) ? colour.hex : t.paper;
            }
            defs.appendChild(copy);
            made.set(key, id);
          }
        }
        el.setAttribute(which, 'url(#' + id + ')');
      }
    }

    // 2g. Every part a live card animates gets a key that names it the same
    // way in every frame: a step by its id (Mermaid's render prefix and
    // counter off), an edge and its label by the edge's own id, a group's
    // box and name by the group; a sequence diagram's participants and
    // messages by theirs. A card matches one frame to the next by these.
    const prefix = new RegExp('^' + svgId.replace(/[^\w]/g, '\\$&') + '[-_]');
    const bare = (v) => String(v || '').replace(prefix, '').replace(/-\d+$/, '');
    const seen = new Map();
    const key = (el, name) => {
      const n = seen.get(name) || 0;
      seen.set(name, n + 1);
      el.setAttribute('data-k', n === 0 ? name : name + '#' + n);
    };
    for (const n of root.querySelectorAll('g.node')) if (n.id) key(n, 'n:' + bare(n.id));
    for (const p of root.querySelectorAll('g.edgePaths > path')) key(p, 'e:' + (p.getAttribute('data-id') || bare(p.id)));
    for (const g of root.querySelectorAll('g.edgeLabel')) {
      const inner = g.querySelector('[data-id]');
      key(g, 'l:' + (inner ? inner.getAttribute('data-id') : 'x'));
    }
    [...root.querySelectorAll('g.edgeTerminals')].forEach((g, i) => key(g, 't:' + i));
    for (const { label, cluster } of groupNames) key(label, 'c:' + bare(cluster.id) + ':name');
    for (const c of root.querySelectorAll('g.cluster')) {
      const frame = c.querySelector(':scope > rect') || c.firstElementChild;
      if (frame) key(frame, 'c:' + bare(c.id) + ':box');
    }
    for (const l of root.querySelectorAll('line.actor-line')) key(l, 'al:' + l.getAttribute('data-id'));
    for (const g of root.querySelectorAll('g[data-et="participant"]')) key(g, 'a:' + g.getAttribute('data-id'));
    let said = null;
    for (const el of root.querySelectorAll('text.messageText, .messageLine0, .messageLine1')) {
      if (el.classList.contains('messageText')) {
        said = el;
        continue;
      }
      const id = el.getAttribute('data-id') || 'x';
      key(el, 'm:' + id);
      if (said) key(said, 'mt:' + id);
      said = null;
    }
    for (const g of root.querySelectorAll('g[data-et="note"]')) {
      const id = g.getAttribute('data-id') || 'x';
      for (const part of g.children) key(part, 'no:' + id + ':' + part.tagName.toLowerCase());
    }
    [...root.querySelectorAll('g[data-et="control-structure"]')].forEach((g, i) => {
      [...g.children].forEach((part, j) => key(part, 'lp:' + i + ':' + part.tagName.toLowerCase() + ':' + j));
    });
    [...root.querySelectorAll('rect[class^="activation"]')].forEach((r, i) => key(r, 'act:' + i));

    // 2h. Words Mermaid centres with dominant-baseline get that offset in
    // their geometry instead: the app's sanitiser drops the attribute (as do
    // other SVG readers), and a participant's name sat 5 px high in its box.
    for (const text of root.querySelectorAll('text')) {
      const db = getComputedStyle(text).dominantBaseline;
      if (!db || db === 'auto' || db === 'alphabetic') continue;
      const was = text.getBBox();
      for (const x of [text, ...text.querySelectorAll('tspan')]) {
        x.removeAttribute('dominant-baseline');
        x.removeAttribute('alignment-baseline');
        x.style.dominantBaseline = 'auto';
      }
      const dy = was.y - text.getBBox().y;
      if (Math.abs(dy) > 0.01) {
        const own = text.getAttribute('transform');
        text.setAttribute('transform', 'translate(0, ' + Math.round(dy * 100) / 100 + ')' + (own ? ' ' + own : ''));
      }
    }

    // 3. The contrast guard: every label against the painted shape under it.
    const shapes = [...root.querySelectorAll('rect, polygon, path, circle, ellipse')].filter((s) => {
      if (s.closest('marker, defs, clipPath')) return false;
      const cs = getComputedStyle(s);
      return lum(cs.fill) !== null && cs.fillOpacity !== '0' && cs.visibility !== 'hidden' && cs.display !== 'none';
    }).map((s) => ({ s, r: s.getBoundingClientRect() }));
    const paperLum = hexLum(t.paper);
    const choices = [t.ink, t.paper, '#FFFFFF', '#000000'];
    let fixed = 0;
    for (const text of root.querySelectorAll('text')) {
      const b = text.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      let under = null;
      for (const { s, r } of shapes) {
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
        if (!(s.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (under === null || r.width * r.height < under.r.width * under.r.height) under = { s, r };
      }
      const bg = under ? lum(getComputedStyle(under.s).fill) : paperLum;
      const own = lum(getComputedStyle(text).fill);
      if (bg === null || own === null || ratio(own, bg) >= 4.5) continue;
      let best = choices[0];
      for (const c of choices) if (ratio(hexLum(c), bg) > ratio(hexLum(best), bg)) best = c;
      for (const el of [text, ...text.querySelectorAll('tspan')]) el.style.fill = best;
      fixed += 1;
    }

    // 4. Every computed paint and type property onto its element; no <style>
    // left. A value an element would have anyway — SVG's initial value, or
    // (for a tspan) what it inherits from its <text> — is not written: the
    // file stays a fraction of the size and reads the same everywhere.
    const PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'paint-order'];
    const TYPE = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing'];
    const INITIAL = { 'fill-opacity': '1', 'stroke': 'none', 'stroke-width': '1', 'stroke-dasharray': 'none', 'stroke-opacity': '1', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'opacity': '1', 'paint-order': 'normal', 'font-style': 'normal', 'font-weight': '400', 'text-anchor': 'start', 'dominant-baseline': 'auto', 'letter-spacing': 'normal', 'font-family': t.font };
    const value = (cs, prop) => {
      let v = cs.getPropertyValue(prop);
      if (v === '') return '';
      if (prop === 'fill' || prop === 'stroke') {
        const h = toHex(v);
        if (h) return h.alpha < 1 ? h.hex + '/' + (Math.round(h.alpha * 1000) / 1000) : h.hex;
      }
      if (/-width$|font-size$|letter-spacing$/.test(prop)) v = v.replace(/px$/, '');
      if (prop === 'stroke-dasharray' && v !== 'none') v = v.replace(/px/g, '').replace(/,\s*/g, ' ');
      if (prop === 'font-weight' && v === 'normal') v = '400';
      if (prop === 'paint-order' && v === 'stroke fill markers') v = 'stroke';
      return v;
    };
    const all = [...root.querySelectorAll('*')];
    const computed = new Map(all.map((el) => [el, getComputedStyle(el)]));
    for (const [el, cs] of computed) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'style' || tag === 'title' || tag === 'desc' || tag === 'defs' || tag === 'g' || tag === 'svg' || tag === 'marker' || tag === 'clippath') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') { el.setAttribute('data-pd-drop', '1'); continue; }
      const textual = tag === 'text' || tag === 'tspan';
      const parent = tag === 'tspan' ? computed.get(el.parentElement) : null;
      for (const prop of textual ? [...PAINT, ...TYPE] : PAINT) {
        const v = value(cs, prop);
        if (v === '') continue;
        // An attribute Mermaid wrote that a rule then overrode (a lifeline's
        // stroke-width="0.5px" under the look's 1 px) would win again once the
        // rules are gone: it is always written over.
        const stale = el.hasAttribute(prop);
        if (parent && value(parent, prop) === v && !stale) continue;
        if (!parent && prop !== 'fill' && INITIAL[prop] === v && !stale) continue;
        const [paint, alpha] = v.split('/');
        el.setAttribute(prop, paint);
        if (alpha !== undefined) el.setAttribute(prop + '-opacity', alpha);
      }
    }
    for (const el of root.querySelectorAll('[data-pd-drop]')) el.remove();
    for (const s of root.querySelectorAll('style')) s.remove();
    for (const el of [root, ...root.querySelectorAll('[style]')]) el.removeAttribute('style');
    // Mermaid defines a dozen arrowheads for every flowchart; keep the ones drawn.
    const used = new Set();
    for (const el of root.querySelectorAll('[marker-end], [marker-start], [marker-mid]')) {
      for (const a of ['marker-end', 'marker-start', 'marker-mid']) {
        const m = /url\(#([^)]+)\)/.exec(el.getAttribute(a) || '');
        if (m) used.add(m[1]);
      }
    }
    for (const m of root.querySelectorAll('marker')) if (!used.has(m.id)) m.remove();
    for (const d of root.querySelectorAll('defs')) if (d.children.length === 0) d.remove();
    // Geometry to a hundredth of a pixel (ROUND_GEOMETRY_JS), and Mermaid's
    // own bookkeeping out.
    const round = ${ROUND_GEOMETRY_JS};
    for (const el of root.querySelectorAll('[d], [points], [transform]')) {
      for (const a of ['d', 'points', 'transform']) {
        const v = el.getAttribute(a);
        if (v) el.setAttribute(a, round(v));
      }
    }
    for (const el of root.querySelectorAll('[data-points], [data-look], [data-et], [data-edge]')) {
      for (const a of ['data-points', 'data-look', 'data-et', 'data-edge']) el.removeAttribute(a);
    }

    // 5. Onto the kit's paper, under the title.
    const vb = root.viewBox && root.viewBox.baseVal && root.viewBox.baseVal.width > 0
      ? root.viewBox.baseVal
      : { x: 0, y: 0, width: Number(root.getAttribute('width')) || 400, height: Number(root.getAttribute('height')) || 300 };
    // A diagram with nothing in it yet (a live card's first frame: the type
    // line and no step) is its title alone, not a blank 400 × 300.
    const empty = ![...root.querySelectorAll('g.node, text, path, line, rect, circle, ellipse, polygon')].some(
      (el) => !el.closest('marker, defs, clipPath, symbol'),
    );
    const w = empty ? 0 : Math.ceil(vb.width);
    const h = empty ? 0 : Math.ceil(vb.height);
    // Mermaid draws a sequence diagram's lifelines 2000 px long and lets its
    // own viewport cut them. Nested here the drawing overflows visibly (so an
    // edge label near a side is never clipped), and the lifelines ran on to the
    // bottom of the paper — so they stop at the drawing's foot instead.
    const foot = vb.y + vb.height;
    for (const line of root.querySelectorAll('line')) {
      for (const a of ['y1', 'y2']) {
        const v = Number(line.getAttribute(a));
        if (Number.isFinite(v) && v > foot) line.setAttribute(a, String(Math.floor(foot)));
      }
    }
    const pad = 28;
    const titleSize = 22;
    const subSize = 15;
    const measure = (text, size, weight, family) => {
      const probe = document.createElementNS(NS, 'text');
      probe.setAttribute('font-size', String(size));
      probe.setAttribute('font-weight', String(weight));
      probe.setAttribute('font-family', family);
      probe.textContent = text;
      root.appendChild(probe);
      const width = probe.getComputedTextLength();
      probe.remove();
      return width;
    };
    const title = (req.title || '').trim();
    const subtitle = (req.subtitle || '').trim();
    const titleW = title ? measure(title, titleSize, t.titleWeight, t.titleFont) : 0;
    const subW = subtitle ? measure(subtitle, subSize, 400, t.font) : 0;
    const W = Math.ceil(Math.max(w + pad * 2, titleW + pad * 2, subW + pad * 2));
    let y = pad;
    let head = '';
    if (title) {
      y += titleSize;
      head += '<text data-k="head:title" x="' + pad + '" y="' + y + '" font-family="' + esc(t.titleFont) + '" font-size="' + titleSize + '" font-weight="' + t.titleWeight + '" fill="' + t.ink + '">' + esc(title) + '</text>';
    }
    if (subtitle) {
      y += (title ? 8 : 0) + subSize;
      head += '<text data-k="head:subtitle" x="' + pad + '" y="' + y + '" font-family="' + esc(t.font) + '" font-size="' + subSize + '" fill="' + t.mute + '">' + esc(subtitle) + '</text>';
    }
    const top = title || subtitle ? y + (empty ? 0 : 20) : pad;
    const H = Math.ceil(top + h + pad);
    const x = Math.round((W - w) / 2);
    // Mermaid's own <svg> becomes the nested drawing. XMLSerializer, not
    // innerHTML: the HTML serializer writes &nbsp; and friends, which no XML
    // reader (an <img>, QuickLook, a document embed) accepts.
    root.setAttribute('x', String(x));
    root.setAttribute('y', String(top));
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    root.setAttribute('viewBox', empty ? '0 0 1 1' : [vb.x, vb.y, vb.width, vb.height].join(' '));
    root.setAttribute('overflow', 'visible');
    const drawing = new XMLSerializer().serializeToString(root);
    // class="pd-diagram": the canvas shows a diagram at its own size (and
    // scrolls), where any other SVG is fitted to the pane.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" class="pd-diagram" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title || req.kind || 'diagram') + '" font-family="' + esc(t.font) + '">' +
      '<rect width="' + W + '" height="' + H + '" fill="' + t.paper + '"/>' + head + drawing + '</svg>';
    host.innerHTML = '';
    return { svg, width: W, height: H, labelsFixed: fixed };
  };
})();`;

// ── crossing into the page ──────────────────────────────────────────────────

/**
 * A script for `webContents.executeJavaScript` that answers NOTHING.
 *
 * The value of a script's last statement is sent back to the main process, and
 * it has to survive a structured clone. mermaid.min.js ends by assigning the
 * mermaid object to globalThis — a value full of functions — so the injection
 * itself rejected with "An object could not be cloned." and EVERY diagram in
 * the real app failed as "Mermaid could not read the source"
 * (inline-diagram-probe, 2026-09-25). The eval and the Chromium tests add the
 * library as a <script> tag, which answers nothing, so only the app met it.
 */
export function asStatement(code: string): string {
  return `${code}\n;void 0;`;
}

/**
 * A call into the page whose answer crosses as JSON TEXT: whatever the page
 * builds, nothing in it can fail to clone, and main parses it back.
 */
export function pageCall(fn: '__pdParse' | '__pdRender', arg: unknown): string {
  return `Promise.resolve(window.${fn}(${JSON.stringify(arg)})).then((r) => JSON.stringify(r))`;
}

// ── the whole job, against any page ──────────────────────────────────────────

/** The page, however it is hosted. */
export interface DiagramPage {
  parse(source: string): Promise<ParseResult>;
  render(req: {
    id: string;
    source: string;
    config: Record<string, unknown>;
    theme: DiagramTheme;
    look: DiagramLook;
    title?: string;
    subtitle?: string;
    kind: string;
  }): Promise<DiagramDrawing & { labelsFixed: number }>;
}

/** A short, stable id for a diagram's elements (djb2), so two in one document never share one. */
export function diagramId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) h = (Math.imul(h, 33) ^ seed.charCodeAt(i)) >>> 0;
  return `dg${h.toString(36)}`;
}

function failure(
  err: ParseFailed,
  prepared: PreparedSource,
  rawSource: string,
): DiagramRenderReply {
  const readLine = err.line !== null ? err.line - prepared.lineOffset : null;
  const rawLines = rawSource.replace(/\r\n?/g, '\n').split('\n');
  const drawnLines = prepared.source.split('\n');
  const lineText =
    readLine !== null && readLine >= 1 && readLine <= rawLines.length
      ? (rawLines[readLine - 1] ?? '').trim()
      : err.line !== null
        ? (drawnLines[err.line - 1] ?? '').trim()
        : null;
  return {
    ok: false,
    error: err.message.split('\n')[0] ?? err.message,
    line: readLine !== null && readLine >= 1 ? readLine : err.line,
    lineText,
    hint: hintFor(err, lineText ?? ''),
  };
}

/** The source made Mermaid and read: what both the finished drawing and a live frame start from. */
type ReadSource =
  | {
      readonly ok: true;
      readonly source: string;
      readonly notes: readonly string[];
      readonly parsed: ParseOk;
      readonly kind: string;
      readonly roles: FlowRoles | null;
    }
  | { readonly ok: false; readonly empty: boolean; readonly failed?: ParseFailed };

/** Prepare, parse, and repair labels once if that is what failed. */
async function readSource(
  page: DiagramPage,
  raw: string,
  prepared: PreparedSource,
): Promise<ReadSource> {
  if (prepared.source === '') return { ok: false, empty: true };
  let source = prepared.source;
  const notes = [...prepared.notes];
  let parsed = await page.parse(source);
  if (!parsed.ok && diagramTypeOf(source)?.kind === 'flowchart') {
    const quoted = quoteAllLabels(source);
    if (quoted.changed > 0) {
      const again = await page.parse(quoted.source);
      if (again.ok) {
        source = quoted.source;
        parsed = again;
        notes.push(
          `Put quotes round ${quoted.changed === 1 ? 'a label' : `${quoted.changed} labels`} with brackets in ${quoted.changed === 1 ? 'it' : 'them'} (A["Pick (and pack)"]).`,
        );
      }
    }
  }
  if (!parsed.ok) return { ok: false, empty: raw.trim() === '', failed: parsed };
  const flow = parsed.vertices.length > 0;
  return {
    ok: true,
    source,
    notes,
    parsed,
    kind: diagramTypeOf(source)?.kind ?? 'diagram',
    roles: flow && !stylesItself(source) ? flowRoles(parsed) : null,
  };
}

/** One mode of a read source, drawn: the kit's roles styled in, the look on. */
function drawOne(
  page: DiagramPage,
  read: Extract<ReadSource, { ok: true }>,
  opts: {
    id: string;
    theme: DiagramTheme;
    title?: string | undefined;
    subtitle?: string | undefined;
  },
) {
  const { theme } = opts;
  const styled =
    read.roles !== null ? [read.source, ...roleStyling(read.roles, theme)].join('\n') : read.source;
  return page.render({
    id: opts.id,
    source: styled,
    config: mermaidConfig(theme, read.kind),
    theme,
    look: diagramLook(theme),
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
    kind: read.kind,
  });
}

/**
 * Prepare, parse (repairing labels once if that is what failed), dress in the
 * kit, draw both modes. Everything the harness needs to write the files and
 * tell the model what it drew.
 */
export async function runDiagram(
  page: DiagramPage,
  req: DiagramRenderRequest,
): Promise<DiagramRenderReply> {
  const prepared = prepareSource(req.source);
  const read = await readSource(page, req.source, prepared);
  if (!read.ok) {
    if (read.failed !== undefined) return failure(read.failed, prepared, req.source);
    return {
      ok: false,
      error: 'the diagram source is empty',
      line: null,
      lineText: null,
      hint: 'Pass the Mermaid text with --source: flowchart TD, then one line per connection (A[Order placed] --> B{Paid?}).',
    };
  }
  const { source, parsed, roles, kind } = read;
  const notes = [...read.notes];
  const id = diagramId(`${req.title ?? ''}\n${source}`);
  const draw = (mode: 'light' | 'dark') =>
    drawOne(page, read, {
      id: `${id}${mode === 'light' ? 'l' : 'd'}`,
      theme: req.themes[mode],
      title: req.title,
      subtitle: req.subtitle,
    });
  const light = await draw('light');
  const dark = await draw('dark');
  if (light.labelsFixed > 0) {
    notes.push(
      `Set ${light.labelsFixed === 1 ? 'a label' : `${light.labelsFixed} labels`} in a colour that reads on ${light.labelsFixed === 1 ? 'its' : 'their'} fill.`,
    );
  }
  return {
    ok: true,
    source,
    notes,
    kind,
    nodes: parsed.vertices.map((v) => v.text.trim() || v.id),
    edges: parsed.edges.length,
    labelledEdges: parsed.edges.map((e) => e.text.trim()).filter((t) => t !== ''),
    failEdges:
      roles?.failEdges.length ?? parsed.edges.filter((e) => FAIL_WORDS.test(e.text)).length,
    decisions: parsed.vertices.filter((v) => v.shape === 'diamond').length,
    light: { svg: light.svg, width: light.width, height: light.height },
    dark: { svg: dark.svg, width: dark.width, height: dark.height },
  };
}

// ── one frame of a diagram still being typed ─────────────────────────────────

/** A live card's frame: the complete lines so far, in the chat's mode. */
export interface DiagramLiveRequest {
  /** The same for every frame of one call, so Mermaid's own ids stay put. */
  readonly id: string;
  readonly source: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly theme: DiagramTheme;
  /**
   * More lines are still coming. The flow's END is not known yet — its last
   * step so far is only the newest one — so no step wears the end's colour
   * until the source is whole: otherwise each new last step lit up in the
   * accent and faded out again a line later.
   */
  readonly partial?: boolean;
}

export type DiagramLiveReply =
  | {
      readonly ok: true;
      readonly svg: string;
      readonly width: number;
      readonly height: number;
      readonly kind: string;
      /** The Mermaid as drawn (prepared, repaired). */
      readonly source: string;
    }
  | { readonly ok: false; readonly error: string; readonly line: number | null };

/**
 * One frame of the live card (diagram-live.ts): the same preparing, reading,
 * roles and drawing as the finished card, in one mode — so when the call's
 * last line lands, its frame IS the drawing the tool is about to make. A
 * source Mermaid cannot read yet is not an error to anyone: the card keeps
 * the last frame that could be drawn.
 */
export async function runDiagramLive(
  page: DiagramPage,
  req: DiagramLiveRequest,
): Promise<DiagramLiveReply> {
  const read = await readSource(page, req.source, prepareSource(req.source));
  if (!read.ok) {
    return {
      ok: false,
      error: read.failed?.message.split('\n')[0] ?? 'nothing to draw yet',
      line: read.failed?.line ?? null,
    };
  }
  const roles =
    req.partial === true && read.roles !== null ? { ...read.roles, end: [] } : read.roles;
  const drawn = await drawOne(
    page,
    { ...read, roles },
    { id: req.id, theme: req.theme, title: req.title, subtitle: req.subtitle },
  );
  return {
    ok: true,
    svg: drawn.svg,
    width: drawn.width,
    height: drawn.height,
    kind: read.kind,
    source: read.source,
  };
}
