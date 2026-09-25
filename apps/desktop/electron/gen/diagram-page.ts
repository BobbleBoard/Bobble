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
 *   - PAGE_HTML / PAGE_SCRIPT are the window's page: the parse and render
 *     calls, and the post-pass that makes the SVG safe to put anywhere —
 *     labels as SVG text (Bobble's svg surface strips <foreignObject>: every
 *     label vanished in the research's pipeline check), every computed style
 *     written onto the element and the <style> block removed (it restyled the
 *     whole app document when injected inline), ids kept unique, and every
 *     label checked against the fill behind it (the contrast guard);
 *   - `runDiagram` is the whole job against an injected page, so it runs the
 *     same in the app's hidden window, in the eval's headless Chromium and in
 *     a unit test.
 */
import type { DiagramTheme } from '@pi-desktop/design-kit';
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
  return { source: text, notes, lineOffset };
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

/** Whether the source dresses itself — then its choices stand. */
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
  cls('pdStart', theme.start.fill, theme.start.fill, theme.start.text, roles.start);
  cls('pdEnd', theme.end.fill, theme.end.fill, theme.end.text, roles.end);
  cls('pdFail', theme.fail.fill, theme.fail.stroke, theme.fail.text, roles.failNodes);
  if (roles.failEdges.length > 0) {
    lines.push(
      `linkStyle ${roles.failEdges.join(',')} stroke:${theme.fail.stroke},color:${theme.fail.text}`,
    );
  }
  return lines;
}

// ── the kit's theme, in Mermaid's words ──────────────────────────────────────

const CURVES: Readonly<Record<DiagramTheme['curve'], string>> = {
  basis: 'basis',
  linear: 'linear',
  step: 'stepAfter',
};

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
export function mermaidConfig(theme: DiagramTheme): Record<string, unknown> {
  const s = theme.series.map(hex6);
  const series = (i: number): string => s[i % Math.max(1, s.length)] ?? theme.ink;
  const scale: Record<string, string> = {};
  for (let i = 0; i < 12; i += 1) {
    scale[`cScale${i}`] = series(i);
    scale[`cScaleLabel${i}`] = theme.mode === 'light' ? '#FFFFFF' : theme.paper;
    scale[`pie${i + 1}`] = series(i);
  }
  for (let i = 0; i < 8; i += 1) {
    scale[`git${i}`] = series(i);
    scale[`gitBranchLabel${i}`] = theme.mode === 'light' ? '#FFFFFF' : theme.paper;
  }
  const noSize = { useMaxWidth: false };
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look: theme.look === 'sketch' ? 'handDrawn' : 'classic',
    handDrawnSeed: 7,
    deterministicIds: true,
    fontFamily: theme.font,
    htmlLabels: false,
    flowchart: {
      ...noSize,
      htmlLabels: false,
      curve: CURVES[theme.curve],
      nodeSpacing: 34,
      rankSpacing: 44,
      padding: 12,
      diagramPadding: 6,
      wrappingWidth: 180,
    },
    sequence: { ...noSize, mirrorActors: false, actorMargin: 48, messageMargin: 32 },
    class: noSize,
    state: noSize,
    er: noSize,
    journey: noSize,
    gantt: noSize,
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
      primaryColor: theme.surface,
      primaryTextColor: theme.ink,
      primaryBorderColor: theme.ink,
      secondaryColor: theme.group,
      secondaryTextColor: theme.ink,
      secondaryBorderColor: theme.groupEdge,
      tertiaryColor: theme.paper,
      tertiaryTextColor: theme.ink,
      tertiaryBorderColor: theme.line,
      mainBkg: theme.surface,
      nodeBorder: theme.ink,
      nodeTextColor: theme.ink,
      textColor: theme.ink,
      titleColor: theme.ink,
      lineColor: theme.line,
      defaultLinkColor: theme.line,
      edgeLabelBackground: theme.paper,
      clusterBkg: theme.group,
      clusterBorder: theme.groupEdge,
      strokeWidth: 1.25,
      // sequence
      actorBkg: theme.surface,
      actorBorder: theme.ink,
      actorTextColor: theme.ink,
      actorLineColor: theme.line,
      signalColor: theme.ink,
      signalTextColor: theme.ink,
      labelBoxBkgColor: theme.surface,
      labelBoxBorderColor: theme.line,
      labelTextColor: theme.ink,
      loopTextColor: theme.ink,
      noteBkgColor: theme.group,
      noteTextColor: theme.ink,
      noteBorderColor: theme.groupEdge,
      activationBkgColor: theme.group,
      activationBorderColor: theme.line,
      sequenceNumberColor: theme.surface,
      // state / class / er
      labelColor: theme.ink,
      altBackground: theme.group,
      attributeBackgroundColorOdd: theme.surface,
      attributeBackgroundColorEven: theme.group,
      // pie
      pieTitleTextColor: theme.ink,
      pieSectionTextColor: theme.mode === 'light' ? '#FFFFFF' : theme.paper,
      pieLegendTextColor: theme.ink,
      pieStrokeColor: theme.paper,
      pieOuterStrokeColor: theme.line,
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
 * The page's two calls, as plain JavaScript (it runs in the window, not in
 * this process — and a string survives any bundler untouched).
 *
 *   __pdParse(source)  → ParseResult
 *   __pdRender(req)    → { svg, width, height }
 *
 * The render's post-pass, in order: the contrast guard (every label against
 * the painted shape under it: ink, paper, white or black, whichever reads
 * best when the one it has falls under 4.5:1); the kit's node corners;
 * failure edges' arrowheads in the edge's own colour; every computed paint and
 * type property written onto its element and every <style> removed; then the
 * drawing is set on the kit's paper under its title.
 */
export const PAGE_SCRIPT = String.raw`(() => {
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

    // 1. The kit's corners on plain boxes (a rounded or a stadium node keeps its
    // own), and edge labels on a SOLID patch of paper: Mermaid draws that patch
    // at half opacity, so the line it sits on showed straight through "yes".
    for (const r of root.querySelectorAll('g.node rect.label-container, g.node rect.basic')) {
      if (!r.getAttribute('rx') || r.getAttribute('rx') === '0') { r.setAttribute('rx', String(t.radius)); r.setAttribute('ry', String(t.radius)); }
    }
    for (const r of root.querySelectorAll('g.edgeLabel rect, .labelBkg')) r.style.opacity = '1';

    // 2. The contrast guard: every label against the painted shape under it.
    const shapes = [...root.querySelectorAll('rect, polygon, path, circle, ellipse')].filter((s) => {
      if (s.closest('marker, defs')) return false;
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

    // 3. An edge drawn in its own colour gets an arrowhead in that colour.
    const markers = new Map();
    for (const p of root.querySelectorAll('path[marker-end], path[marker-start]')) {
      const stroke = toHex(getComputedStyle(p).stroke);
      if (!stroke) continue;
      for (const attr of ['marker-end', 'marker-start']) {
        const ref = /url\(#([^)]+)\)/.exec(p.getAttribute(attr) || '');
        if (!ref) continue;
        const m = root.querySelector('marker#' + CSS.escape(ref[1]));
        const tip = m && m.querySelector('path, circle, polygon');
        if (!tip) continue;
        const fill = toHex(getComputedStyle(tip).fill);
        if (!fill || fill.hex === stroke.hex) continue;
        const key = ref[1] + '-' + stroke.hex.slice(1);
        if (!markers.has(key)) {
          const copy = m.cloneNode(true);
          copy.id = key;
          for (const el of [copy, ...copy.querySelectorAll('*')]) { el.style.fill = stroke.hex; el.style.stroke = stroke.hex; }
          m.parentNode.appendChild(copy);
          markers.set(key, copy);
        }
        p.setAttribute(attr, 'url(#' + key + ')');
      }
    }

    // 4. Every computed paint and type property onto its element; no <style>
    // left. A value an element would have anyway — SVG's initial value, or
    // (for a tspan) what it inherits from its <text> — is not written: the
    // file stays a fraction of the size and reads the same everywhere.
    const PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity'];
    const TYPE = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing'];
    const INITIAL = { 'fill-opacity': '1', 'stroke': 'none', 'stroke-width': '1', 'stroke-dasharray': 'none', 'stroke-opacity': '1', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'opacity': '1', 'font-style': 'normal', 'font-weight': '400', 'text-anchor': 'start', 'dominant-baseline': 'auto', 'letter-spacing': 'normal', 'font-family': t.font };
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
      return v;
    };
    const all = [...root.querySelectorAll('*')];
    const computed = new Map(all.map((el) => [el, getComputedStyle(el)]));
    for (const [el, cs] of computed) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'style' || tag === 'title' || tag === 'desc' || tag === 'defs' || tag === 'g' || tag === 'svg' || tag === 'marker') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') { el.setAttribute('data-pd-drop', '1'); continue; }
      const textual = tag === 'text' || tag === 'tspan';
      const parent = tag === 'tspan' ? computed.get(el.parentElement) : null;
      for (const prop of textual ? [...PAINT, ...TYPE] : PAINT) {
        const v = value(cs, prop);
        if (v === '') continue;
        if (parent && value(parent, prop) === v) continue;
        if (!parent && prop !== 'fill' && INITIAL[prop] === v) continue;
        const [paint, alpha] = v.split('/');
        el.setAttribute(prop, paint);
        if (alpha !== undefined) el.setAttribute(prop + '-opacity', alpha);
      }
    }
    for (const el of root.querySelectorAll('[data-pd-drop]')) el.remove();
    for (const s of root.querySelectorAll('style')) s.remove();
    for (const el of [root, ...root.querySelectorAll('[style]')]) el.removeAttribute('style');
    // Mermaid defines twelve arrowheads for every flowchart; keep the ones drawn.
    const used = new Set();
    for (const el of root.querySelectorAll('[marker-end], [marker-start], [marker-mid]')) {
      for (const a of ['marker-end', 'marker-start', 'marker-mid']) {
        const m = /url\(#([^)]+)\)/.exec(el.getAttribute(a) || '');
        if (m) used.add(m[1]);
      }
    }
    for (const m of root.querySelectorAll('marker')) if (!used.has(m.id)) m.remove();
    // Geometry to a hundredth of a pixel (Mermaid writes fifteen digits: a
    // stadium node alone was 32 KB of path), and Mermaid's own bookkeeping out.
    const round = (v) => v.replace(/-?\d*\.\d{3,}(?:e-?\d+)?/g, (n) => String(Math.round(Number(n) * 100) / 100));
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
    const w = Math.ceil(vb.width);
    const h = Math.ceil(vb.height);
    const pad = 28;
    const titleSize = 22;
    const subSize = 15;
    const measure = (text, size, weight, family) => {
      const probe = document.createElementNS('http://www.w3.org/2000/svg', 'text');
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
      head += '<text x="' + pad + '" y="' + y + '" font-family="' + esc(t.titleFont) + '" font-size="' + titleSize + '" font-weight="' + t.titleWeight + '" fill="' + t.ink + '">' + esc(title) + '</text>';
    }
    if (subtitle) {
      y += (title ? 8 : 0) + subSize;
      head += '<text x="' + pad + '" y="' + y + '" font-family="' + esc(t.font) + '" font-size="' + subSize + '" fill="' + t.mute + '">' + esc(subtitle) + '</text>';
    }
    const top = title || subtitle ? y + 20 : pad;
    const H = Math.ceil(top + h + pad);
    const x = Math.round((W - w) / 2);
    // Mermaid's own <svg> becomes the nested drawing. XMLSerializer, not
    // innerHTML: the HTML serializer writes &nbsp; and friends, which no XML
    // reader (an <img>, QuickLook, a document embed) accepts.
    root.setAttribute('x', String(x));
    root.setAttribute('y', String(top));
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    root.setAttribute('viewBox', [vb.x, vb.y, vb.width, vb.height].join(' '));
    root.setAttribute('overflow', 'visible');
    const drawing = new XMLSerializer().serializeToString(root);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title || req.kind || 'diagram') + '" font-family="' + esc(t.font) + '">' +
      '<rect width="' + W + '" height="' + H + '" fill="' + t.paper + '"/>' + head + drawing + '</svg>';
    host.innerHTML = '';
    return { svg, width: W, height: H, labelsFixed: fixed };
  };
})();`;

// ── the whole job, against any page ──────────────────────────────────────────

/** The page, however it is hosted. */
export interface DiagramPage {
  parse(source: string): Promise<ParseResult>;
  render(req: {
    id: string;
    source: string;
    config: Record<string, unknown>;
    theme: DiagramTheme;
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
  if (prepared.source === '') {
    return {
      ok: false,
      error: 'the diagram source is empty',
      line: null,
      lineText: null,
      hint: 'Pass the Mermaid text with --source: flowchart TD, then one line per connection (A[Order placed] --> B{Paid?}).',
    };
  }
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
  if (!parsed.ok) return failure(parsed, prepared, req.source);
  const kind = diagramTypeOf(source)?.kind ?? 'diagram';
  const flow = parsed.vertices.length > 0;
  const roles = flow && !stylesItself(source) ? flowRoles(parsed) : null;
  const id = diagramId(`${req.title ?? ''}\n${source}`);
  const draw = async (mode: 'light' | 'dark') => {
    const theme = req.themes[mode];
    const styled = roles !== null ? [source, ...roleStyling(roles, theme)].join('\n') : source;
    return page.render({
      id: `${id}${mode === 'light' ? 'l' : 'd'}`,
      source: styled,
      config: mermaidConfig(theme),
      theme,
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.subtitle !== undefined ? { subtitle: req.subtitle } : {}),
      kind,
    });
  };
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
