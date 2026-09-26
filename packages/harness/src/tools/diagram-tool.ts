/**
 * `diagram` — a flowchart, a sequence, an org chart, a mind map… drawn in the
 * chat from Mermaid — and `diagram_edit`, the same diagram changed (VQ-10).
 *
 * There was no diagram path at all (deliverables/research/visual-quality.md
 * §2.2.3, D30). MEASURED on the 4B before this tool, the research's flow brief
 * ("order placed → payment check (if it fails: email the customer and retry) →
 * …") went to OmniSVG — "52 paths — hit the length limit; may be incomplete",
 * a picture with no words in it — then to a hand-typed SVG over the top, then
 * to a run of `present` retries: 137 s in one run, the 420 s cap in the next
 * two, in both tool modes.
 *
 * The shape is the chart tool's (chart-tool.ts), and for the same reason: the
 * model already HAS the structure, so it hands the structure over — Mermaid,
 * which small models know — and the system owns the drawing. The app lays it
 * out with the bundled Mermaid in a hidden window (apps/desktop/electron/gen/
 * diagram-render.ts), in the project's design kit (@pi-desktop/design-kit: the
 * project's brand.md, else the Design setting's kit, else the house default),
 * with the kit's semantic colours on a flowchart — where it starts, where it
 * ends, a failure path — and both a light and a dark drawing. It writes:
 *
 *   <slug>.svg           the drawing (light) — for a page, a document, a deck
 *   <slug>.diagram.mmd   the source as drawn — what diagram_edit changes
 *   <slug>.diagram.json  the card's sidecar: title, counts, the dark drawing
 *
 * and presents the .svg, which the app shows IN the thread as a diagram card
 * (the light or dark drawing with the chat's theme), Open in canvas for the
 * full size. A source Mermaid cannot read comes back as the line and the fix,
 * never as a picture of something else.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { diagramTheme, type Kit, kitById, loadProjectKit } from '@pi-desktop/design-kit';
import { Type } from '@sinclair/typebox';
import { mathFigureWords } from './handmade-math.js';
import type { DiagramRenderReply, DiagramRenderRequest, PresentBridge } from './present.js';
import { pathForModel } from './workspace-relative.js';

export const DIAGRAM_TOOL = 'diagram';
export const DIAGRAM_EDIT_TOOL = 'diagram_edit';
export const DIAGRAM_TOOL_NAMES = [DIAGRAM_TOOL, DIAGRAM_EDIT_TOOL] as const;
/** The source beside the drawing: `<stem>.svg` + `<stem>.diagram.mmd`. */
export const DIAGRAM_SOURCE_SUFFIX = '.diagram.mmd';
/** The card's sidecar: `<stem>.diagram.json`. */
export const DIAGRAM_SIDECAR_SUFFIX = '.diagram.json';

/** What the diagram tool needs from the app: the renderer, and (top level only) the card. */
export interface DiagramToolDeps {
  /** Draws the diagram (the app's Mermaid window); null outside the app. */
  readonly render: ((req: DiagramRenderRequest) => Promise<DiagramRenderReply>) | null;
  /** Shows the card — the top-level model's alone; a child draws and reports up. */
  readonly bridge: PresentBridge | null;
  /** The workspace root a relative path is resolved against. */
  readonly root: (ctxCwd: string | undefined) => string;
  /** The Design setting's kit, when the setting is on (PI_DESKTOP_DESIGN_KIT). */
  readonly settingsKit?: () => string | undefined;
  /** Injected for tests. */
  readonly writeFileImpl?: (p: string, text: string) => Promise<void>;
  readonly readFileImpl?: (p: string) => Promise<string>;
}

/** The sidecar the card reads. */
export interface DiagramSidecar {
  readonly schema: 1;
  readonly title: string;
  readonly subtitle?: string;
  readonly kind: string;
  readonly kit: string;
  readonly look: 'clean' | 'sketch';
  readonly source: string;
  readonly nodes: readonly string[];
  readonly edges: number;
  /** Each drawing's size and paper (the card wears the paper round the drawing). */
  readonly light: { readonly width: number; readonly height: number; readonly paper: string };
  readonly dark: {
    readonly width: number;
    readonly height: number;
    readonly paper: string;
    readonly svg: string;
  };
}

type Content = Array<{ type: 'text'; text: string }>;

function errorResult(text: string): { content: Content; isError: true; details: undefined } {
  return { content: [{ type: 'text', text }], isError: true, details: undefined };
}

/** A file name from the title: "Order fulfilment" → order-fulfilment. */
export function diagramSlug(title: string, kind: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug !== '' ? slug : kind.replace(/[^a-z]+/gi, '-').toLowerCase() || 'diagram';
}

function resolveAgainst(root: string, p: string): string {
  const trimmed = p.trim();
  const home = process.env.HOME;
  const expanded =
    trimmed.startsWith('~/') && home !== undefined ? path.join(home, trimmed.slice(2)) : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
}

/** Any path the model gives for a diagram — the .svg, the .mmd, the .json, or none — → the .svg. */
export function svgPathFor(root: string, out: string | undefined, slug: string): string {
  if (out === undefined || out.trim() === '') return path.join(root, `${slug}.svg`);
  const abs = resolveAgainst(root, out);
  for (const suffix of [DIAGRAM_SOURCE_SUFFIX, DIAGRAM_SIDECAR_SUFFIX]) {
    if (abs.endsWith(suffix)) return `${abs.slice(0, -suffix.length)}.svg`;
  }
  if (/\.(?:mmd|mermaid|json|png|md)$/i.test(abs)) return abs.replace(/\.[^.]+$/, '.svg');
  if (/\.svg$/i.test(abs)) return abs;
  return `${abs}.svg`;
}

/**
 * The Mermaid a call carries. `source` is the text — or, when it is a single
 * line naming a .mmd / .mermaid / .md file that exists, that file (a model
 * that wrote the source with `write` first); a Markdown file gives its first
 * ```mermaid block.
 */
async function sourceFrom(
  raw: string,
  root: string,
  read: (p: string) => Promise<string>,
): Promise<string> {
  const t = raw.trim();
  if (!t.includes('\n') && /\.(?:mmd|mermaid|md)$/i.test(t)) {
    try {
      const text = await read(resolveAgainst(root, t));
      if (/\.md$/i.test(t)) {
        const block = /```[ \t]*mermaid[ \t]*\n([\s\S]*?)\n[ \t]*```/i.exec(text);
        if (block !== null) return block[1] ?? '';
      }
      return text;
    } catch {
      return raw; // not a file after all — Mermaid will say what it makes of it
    }
  }
  return raw;
}

/** "flowchart LR" → "flowchart TD", when a diagram is asked to run the other way. */
export function withDirection(source: string, direction: string): string {
  const d = direction.trim().toUpperCase().replace('TOP-DOWN', 'TD').replace('LEFT-RIGHT', 'LR');
  if (!/^(?:TD|TB|LR|RL|BT)$/.test(d))
    throw new Error(`--direction "${direction}" is not TD, LR, BT or RL`);
  const lines = source.split('\n');
  const i = lines.findIndex((l) => /^\s*(?:flowchart|graph)\b/.test(l));
  if (i === -1)
    throw new Error('--direction is for a flowchart (its first line is flowchart TD or LR)');
  lines[i] = (lines[i] ?? '').replace(
    /^(\s*(?:flowchart|graph))(?:\s+(?:TD|TB|LR|RL|BT))?/,
    `$1 ${d}`,
  );
  return lines.join('\n');
}

/** The kit this diagram wears: a named one, else the project's (brand.md → the setting → the default). */
async function kitFor(
  deps: DiagramToolDeps,
  root: string,
  named: string | undefined,
): Promise<{ kit: Kit; said: string; notes: readonly string[] }> {
  const read = deps.readFileImpl ?? ((f: string) => readFile(f, 'utf8'));
  if (named !== undefined && named.trim() !== '') {
    const kit = kitById(named);
    if (kit !== undefined) return { kit, said: kit.name, notes: [] };
  }
  const project = await loadProjectKit({
    root,
    kitName: deps.settingsKit?.(),
    readFile: read,
  });
  const notes =
    named !== undefined && named.trim() !== ''
      ? [`There is no kit called "${named}"; it wears ${project.kit.name}.`, ...project.notes]
      : project.notes;
  const said =
    project.source === 'brand'
      ? `${project.kit.name} (the project's brand.md)`
      : project.source === 'default'
        ? `${project.kit.name} (the house default)`
        : project.kit.name;
  return { kit: project.kit, said, notes };
}

/**
 * THE REPLY IS ONE SENTENCE — the chart tool's measured lesson (a 4B told "do
 * not repeat the numbers" listed every value): the card is in front of the
 * user, so what they want under it is the reading, not the steps again. And
 * "do not present it again", said plainly: the flailing before this tool was a
 * `present` loop.
 */
const REPLY_LINE =
  'Check the steps and connections above against what the user asked for; if one is missing or wrong, fix it with diagram_edit on the file (--source with the corrected Mermaid). Otherwise you are done: reply in ONE sentence saying what the diagram shows (the path through it, where it can loop back or fail). Do not list the steps or describe the drawing — the card in front of the user has it — and do not present it again. Any later change (a step, a label, the direction, the kit) is diagram_edit on the same file.';

function describe(reply: Extract<DiagramRenderReply, { ok: true }>): string {
  const bits: string[] = [];
  if (reply.nodes.length > 0) {
    bits.push(
      `${reply.nodes.length} step${reply.nodes.length === 1 ? '' : 's'}${reply.decisions > 0 ? ` (${reply.decisions} decision${reply.decisions === 1 ? '' : 's'})` : ''}`,
    );
    bits.push(`${reply.edges} connection${reply.edges === 1 ? '' : 's'}`);
    if (reply.labelledEdges.length > 0) {
      bits.push(`${reply.labelledEdges.length} labelled: ${reply.labelledEdges.join(', ')}`);
    }
  }
  return bits.join(', ');
}

interface Drawn {
  readonly svgPath: string;
  readonly sourcePath: string;
  readonly sidecarPath: string;
}

async function writeDiagram(
  deps: DiagramToolDeps,
  svgPath: string,
  reply: Extract<DiagramRenderReply, { ok: true }>,
  meta: { title: string; subtitle?: string; kit: Kit; look: 'clean' | 'sketch' },
): Promise<Drawn | { error: string }> {
  const stem = svgPath.slice(0, -4);
  const sourcePath = `${stem}${DIAGRAM_SOURCE_SUFFIX}`;
  const sidecarPath = `${stem}${DIAGRAM_SIDECAR_SUFFIX}`;
  const sidecar: DiagramSidecar = {
    schema: 1,
    title: meta.title,
    ...(meta.subtitle !== undefined ? { subtitle: meta.subtitle } : {}),
    kind: reply.kind,
    kit: meta.kit.id,
    look: meta.look,
    source: reply.source,
    nodes: reply.nodes,
    edges: reply.edges,
    light: { width: reply.light.width, height: reply.light.height, paper: meta.kit.light.paper },
    dark: {
      width: reply.dark.width,
      height: reply.dark.height,
      paper: meta.kit.dark.paper,
      svg: reply.dark.svg,
    },
  };
  const write = deps.writeFileImpl ?? ((f: string, text: string) => writeFile(f, text, 'utf8'));
  try {
    await mkdir(path.dirname(svgPath), { recursive: true });
    // The sidecar first: the app reads it when the .svg is presented.
    await write(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    await write(sourcePath, `${reply.source}\n`);
    await write(svgPath, reply.light.svg);
  } catch (err) {
    return {
      error: `could not write ${svgPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { svgPath, sourcePath, sidecarPath };
}

/** A file this tool did not write is never overwritten; another diagram's name gets a -2. */
async function placeDiagram(
  target: string,
  source: string,
  read: (p: string) => Promise<string>,
): Promise<string> {
  const stem = target.slice(0, -4);
  for (let n = 1; n < 200; n += 1) {
    const candidate = n === 1 ? target : `${stem}-${n}.svg`;
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
    try {
      const had = await read(`${candidate.slice(0, -4)}${DIAGRAM_SOURCE_SUFFIX}`);
      if (had.trim() === source.trim()) return candidate; // the same diagram, drawn again
    } catch {
      /* a file the diagram tool did not write: keep looking */
    }
  }
  return `${stem}-${Date.now()}.svg`;
}

function sourceParam() {
  return Type.String({
    description:
      'The diagram as Mermaid text, one statement per line. A flowchart: "flowchart TD" then lines like A([Order placed]) --> B{Payment ok?}, B -- no --> C[Email customer], C -. retry .-> B. Also sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, pie. Quote a label with brackets in it: A["Pick (and pack)"]. No colours or style lines: the kit colours it (start, end, failure paths). TD (top-down) fits the chat; LR only for a few steps. Or a path to a .mmd file.',
    // The tool reads Mermaid that arrived in the title's place (below), so the
    // CLI leaves a missing --source to it rather than refusing at the door.
    cliOptional: true,
  });
}

/** The words a Mermaid source can open with (after any %% comment lines). */
const MERMAID_OPENING =
  /^\s*(?:```\s*(?:mermaid|mmd)?\s*\n\s*)?(?:%%[^\n]*\n\s*)*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|gitGraph|sankey(?:-beta)?|requirementDiagram|C4\w+|block(?:-beta)?|architecture-beta|xychart-beta|packet-beta|kanban|radar-beta|treemap-beta)\b/;

/**
 * Whether text given as a TITLE is really the diagram. MEASURED, the 4B's
 * first call in CLI mode: `diagram "flowchart TD\n  A[Order Placed] --> …"` —
 * one positional, which the command reads as the title, so it came back
 * "missing --source" with the whole usage (806 tokens) and cost a second call.
 * A diagram runs over lines (or a typed \n) and has arrows or a type line; a
 * title does neither — "graph of sales" is a title.
 */
export function looksLikeMermaid(text: string): boolean {
  const lines = /\n|\\n/.test(text.trim());
  return lines && (MERMAID_OPENING.test(text) || /-->|->>|-\.->|==>/.test(text));
}

export function registerDiagramTool(pi: ExtensionAPI, deps: DiagramToolDeps): void {
  const read = deps.readFileImpl ?? ((f: string) => readFile(f, 'utf8'));
  const unavailable = (): ReturnType<typeof errorResult> =>
    errorResult(
      'diagram needs the app: it draws with the Mermaid bundled in Bobble, which is not reachable here.',
    );

  pi.registerTool({
    name: DIAGRAM_TOOL,
    label: 'Diagram',
    description:
      'Draw a diagram — a flowchart or process, a decision tree, a sequence of messages, an org chart, a state machine, an entity-relationship or class diagram, a mind map, a timeline — from Mermaid text, straight into the chat as a card in the project’s design kit. Every request to diagram, map out, or draw a flow, process, pipeline, architecture, hierarchy or relationships goes here: never hand-written SVG, never the svg command (it draws pictures, not words), never an image model, never a slide. Give each step a short label; branches are labelled edges (B -- no --> C). Mermaid lays it out, so every step and branch you write is drawn. It writes a .svg (and the source beside it) into the project, so the same diagram can go into a page or a document. To change a diagram afterwards, use diagram_edit.',
    promptSnippet:
      'diagram: a flowchart / sequence / org chart / mind map in the chat, from Mermaid',
    /* No promptGuidelines. MEASURED in the real request (CLI mode, where every
       tool's guidelines ride the system prompt): the two lines the chart tool's
       pattern gave this one were 290 of the 480 characters VQ-10 added to
       EVERY opening prompt, and both said again what is already said where it
       counts — the routing in the capability line beside the command, the
       one-line reply in the tool's own result (REPLY_LINE), read at the moment
       it applies. Prefix is paid on every turn; a result only when drawn. */
    parameters: Type.Object({
      // Required so `diagram "Title" '<mermaid>'` fills it first — but
      // `cliOptional`: an untitled diagram is still a diagram (the chart tool's
      // measured lesson: "missing --title" cost a 4B a second call).
      title: Type.String({
        description: 'The diagram’s title, e.g. "Order fulfilment".',
        cliOptional: true,
      }),
      source: sourceParam(),
      subtitle: Type.Optional(
        Type.String({ description: 'A line under the title: what the colours mean, the scope.' }),
      ),
      look: Type.Optional(
        Type.Union([Type.Literal('clean'), Type.Literal('sketch')], {
          description: 'clean (drawn lines, the default) or sketch (hand-drawn).',
        }),
      ),
      kit: Type.Optional(
        Type.String({
          description:
            'A design kit to wear instead of the project’s: paper-blue, fog, bone-oxblood, slate-cobalt, sage-moss, graphite-amber. Usually leave it out.',
        }),
      ),
      out: Type.Optional(
        Type.String({
          description:
            'Where to write the .svg, e.g. diagrams/flow.svg. Relative paths land in the project. Default: named from the title.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (deps.render === null) return unavailable();
      const p = params as Record<string, unknown>;
      const root = deps.root(ctx?.cwd);
      let rawSource = typeof p.source === 'string' ? p.source : '';
      let title = typeof p.title === 'string' ? p.title.trim() : '';
      const sourceNotes: string[] = [];
      if (rawSource.trim() === '' && looksLikeMermaid(title)) {
        rawSource = title;
        title = '';
        sourceNotes.push(
          'Read the Mermaid given in the title’s place as the source, so it has no title (diagram_edit --title adds one).',
        );
      }
      if (rawSource.trim() === '') {
        /* A maths or physics figure is not a flowchart — MEASURED (the 4B,
           "explain with a diagram why a small weight far from the pivot can
           balance a heavy one"): it passed its whole explanation to diagram,
           was told to write Mermaid, and answered in Markdown with no figure. */
        const figure = mathFigureWords(`${title} ${String(p.subtitle ?? '')}`)
          ? ' But a maths or physics figure — a lever and its weights, forces, a graph — is not a flowchart: the math command draws it, with steps that move it. Write the spec to name.math.json (`math --help` shows one).'
          : '';
        return errorResult(
          `diagram needs its Mermaid source: --source "flowchart TD\\n  A[Start] --> B{Paid?}\\n  B -- no --> C[Email]" (one statement per line).${figure}`,
        );
      }
      const subtitle =
        typeof p.subtitle === 'string' && p.subtitle.trim() !== '' ? p.subtitle.trim() : undefined;
      const source = await sourceFrom(rawSource, root, read);
      const {
        kit,
        said,
        notes: kitNotes,
      } = await kitFor(deps, root, typeof p.kit === 'string' ? p.kit : undefined);
      const look = p.look === 'sketch' ? 'sketch' : p.look === 'clean' ? 'clean' : kit.diagram.look;
      const themes = {
        light: { ...diagramTheme(kit, 'light'), look },
        dark: { ...diagramTheme(kit, 'dark'), look },
      };
      const reply = await deps.render({
        source,
        ...(title !== '' ? { title } : {}),
        ...(subtitle !== undefined ? { subtitle } : {}),
        themes,
      });
      if (!reply.ok) return errorResult(renderFailure(reply));
      const target = svgPathFor(
        root,
        typeof p.out === 'string' ? p.out : undefined,
        diagramSlug(title, reply.kind),
      );
      const svgPath = await placeDiagram(target, reply.source, read);
      const notes = [...sourceNotes, ...reply.notes, ...kitNotes];
      if (svgPath !== target) {
        notes.push(
          `${path.basename(target)} already holds a different diagram, so this one is ${path.basename(svgPath)}.`,
        );
      }
      const written = await writeDiagram(deps, svgPath, reply, {
        title,
        ...(subtitle !== undefined ? { subtitle } : {}),
        kit,
        look,
      });
      if ('error' in written) return errorResult(`diagram ${written.error}`);
      const shown = await present(
        deps.bridge,
        written.svgPath,
        `${reply.kind}${title !== '' ? ` "${title}"` : ''}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: drawnText('Drew', reply, title, written, root, shown, notes, said),
          },
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: DIAGRAM_EDIT_TOOL,
    label: 'Diagram: edit',
    description:
      'Change a diagram that exists (its .svg or .diagram.mmd): a new --source (the whole corrected Mermaid — add a step, fix a label, a new branch), --title, --subtitle, --direction TD|LR, --look clean|sketch, or --kit. It is redrawn in place and shown again. Every request to change a diagram is one call here.',
    promptSnippet:
      'diagram_edit: change an existing diagram — its source, title, direction or look',
    parameters: Type.Object({
      file: Type.String({
        description:
          'The diagram to change: its .svg (or .diagram.mmd) path, as the diagram tool reported it.',
      }),
      source: Type.Optional(sourceParam()),
      title: Type.Optional(Type.String()),
      subtitle: Type.Optional(Type.String()),
      direction: Type.Optional(
        Type.String({
          description: 'A flowchart’s direction: TD (top-down) or LR (left-right), BT, RL.',
        }),
      ),
      look: Type.Optional(Type.Union([Type.Literal('clean'), Type.Literal('sketch')])),
      kit: Type.Optional(Type.String({ description: 'Another design kit, by name.' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (deps.render === null) return unavailable();
      const p = params as Record<string, unknown>;
      const root = deps.root(ctx?.cwd);
      const fileRaw = typeof p.file === 'string' ? p.file.trim() : '';
      if (fileRaw === '')
        return errorResult('diagram_edit needs the diagram file (its .svg path).');
      const svgPath = svgPathFor(root, fileRaw, 'diagram');
      const stem = svgPath.slice(0, -4);
      let sidecar: DiagramSidecar;
      try {
        sidecar = JSON.parse(await read(`${stem}${DIAGRAM_SIDECAR_SUFFIX}`)) as DiagramSidecar;
      } catch (err) {
        return errorResult(
          `diagram_edit: ${path.basename(svgPath)} is not a diagram made here (no readable ${path.basename(stem)}${DIAGRAM_SIDECAR_SUFFIX} beside it: ${err instanceof Error ? err.message : String(err)}). Make it with diagram, then edit that.`,
        );
      }
      const changed: string[] = [];
      let source = sidecar.source;
      if (typeof p.source === 'string' && p.source.trim() !== '') {
        source = await sourceFrom(p.source, root, read);
        changed.push('the source');
      }
      if (typeof p.direction === 'string' && p.direction.trim() !== '') {
        try {
          source = withDirection(source, p.direction);
        } catch (err) {
          return errorResult(`diagram_edit: ${err instanceof Error ? err.message : String(err)}`);
        }
        changed.push(`the direction (${p.direction.trim().toUpperCase()})`);
      }
      const title = typeof p.title === 'string' ? p.title.trim() : sidecar.title;
      if (title !== sidecar.title) changed.push('the title');
      const subtitle =
        typeof p.subtitle === 'string' ? p.subtitle.trim() || undefined : sidecar.subtitle;
      if (subtitle !== sidecar.subtitle) changed.push('the subtitle');
      const kitName = typeof p.kit === 'string' && p.kit.trim() !== '' ? p.kit : sidecar.kit;
      const { kit, said, notes: kitNotes } = await kitFor(deps, root, kitName);
      if (kit.id !== sidecar.kit) changed.push(`the kit (${kit.name})`);
      const look = p.look === 'sketch' || p.look === 'clean' ? p.look : sidecar.look;
      if (look !== sidecar.look) changed.push(`the look (${look})`);
      if (changed.length === 0) {
        return errorResult(
          'diagram_edit changed nothing — say what to change: --source with the corrected Mermaid, --title, --subtitle, --direction TD|LR, --look, --kit.',
        );
      }
      const reply = await deps.render({
        source,
        ...(title !== '' ? { title } : {}),
        ...(subtitle !== undefined ? { subtitle } : {}),
        themes: {
          light: { ...diagramTheme(kit, 'light'), look },
          dark: { ...diagramTheme(kit, 'dark'), look },
        },
      });
      if (!reply.ok) return errorResult(renderFailure(reply));
      const written = await writeDiagram(deps, svgPath, reply, {
        title,
        ...(subtitle !== undefined ? { subtitle } : {}),
        kit,
        look,
      });
      if ('error' in written) return errorResult(`diagram_edit ${written.error}`);
      const shown = await present(
        deps.bridge,
        written.svgPath,
        `${reply.kind} — ${changed.join(', ')}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: drawnText(
              `Changed ${changed.join(', ')} →`,
              reply,
              title,
              written,
              root,
              shown,
              [...reply.notes, ...kitNotes],
              said,
            ),
          },
        ],
        details: undefined,
      };
    },
  });
}

/** A parse error, as the line and the fix — "parse errors name the line" (VQ-10's acceptance). */
export function renderFailure(reply: Extract<DiagramRenderReply, { ok: false }>): string {
  if (reply.cause === 'app') {
    // Not the source's fault, so not "fix your source": MEASURED, that sent the
    // 4B rewriting a good flowchart three times, then typing SVG by hand.
    return [
      `diagram: the app could not draw it — the source is not the problem (it said: ${reply.error}).`,
      'Nothing was drawn. Try the same call once more; if it fails again, tell the user the diagram could not be drawn and give them the Mermaid source in a ```mermaid block.',
    ].join('\n');
  }
  const where =
    reply.line !== null
      ? `line ${reply.line}${reply.lineText ? `: ${reply.lineText}` : ''}`
      : 'the source';
  return [
    `diagram: Mermaid could not read ${where}`,
    `Fix: ${reply.hint}`,
    `(Mermaid said: ${reply.error})`,
    'Nothing was drawn. Send the corrected source in the same call shape.',
  ].join('\n');
}

async function present(
  bridge: PresentBridge | null,
  svgPath: string,
  note: string,
): Promise<string> {
  if (bridge === null) return '';
  const r = await bridge.show({ path: svgPath, note });
  return r.ok
    ? ' It is in the chat as a diagram card (Open in canvas shows it full size).'
    : ` (it could not be shown in the chat: ${r.error ?? 'unknown'})`;
}

function drawnText(
  verb: string,
  reply: Extract<DiagramRenderReply, { ok: true }>,
  title: string,
  written: Drawn,
  root: string,
  shown: string,
  notes: readonly string[],
  kitSaid: string,
): string {
  const what = `${/^[aeiou]/i.test(reply.kind) ? 'an' : 'a'} ${reply.kind}${title !== '' ? ` "${title}"` : ''}`;
  const counts = describe(reply);
  const lines = [
    `${verb} ${what}${counts !== '' ? ` — ${counts}` : ''}: ${pathForModel(written.svgPath, root)} (the source beside it: ${path.basename(written.sourcePath)}).${shown}`,
    ...notes,
  ];
  if (reply.nodes.length > 0) lines.push(`Steps: ${reply.nodes.join(' · ')}`);
  lines.push(`Kit: ${kitSaid}.`, '', REPLY_LINE);
  return lines.join('\n');
}

export type { DiagramRenderReply, DiagramRenderRequest };
