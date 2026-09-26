/**
 * `math` — a maths or physics visual from a spec: a plot with sliders, a
 * labelled figure, or both, with the explanation's steps tied to it, as one
 * standard page in Bobble's kit (@pi-desktop/mathviz) — checked before it is
 * shown, and the checks handed back so the next call can fix the spec.
 *
 * the user (2026-09-25), on a 4B's hand-written Fourier page: "really low quality
 * and generally bad feeling, instead of it remaking these math things from
 * scratch every time, let's give it a standard style and control such that we
 * can deterministically have it iterate when things look off in a number of
 * ways, eg. overlapping text, low contrast text … likely ideal to make a
 * specialized extension for math stuffs like we have for dataviz". MEASURED
 * the same night (the STEM visual suite, qwen3.5-4b): the kinetic-theory cube
 * drawn as a flat rectangle with "u" on top of "molecule"; simple harmonic
 * motion as three dark-blue cards around an empty graph; "why d/dx sin x =
 * cos x" as an SVG of eight overlapping text blocks. Each was hand-made from
 * nothing, and nothing looked at it.
 *
 * So the model writes WHAT to show — curves as expressions, shapes, sliders,
 * steps that point at the parts — and the look, the typesetting, the layout
 * and the checking are the package's. The spec is a file beside the page
 * (`<name>.math.json`): the model fixes what the checks report in it and runs
 * `math <name>.math.json` again.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { type Kit, loadProjectKit } from '@pi-desktop/design-kit';
import {
  ExprError,
  lenientJson,
  type MathResult,
  renderMath,
  SpecError,
} from '@pi-desktop/mathviz';
import { serverCanSeeImages } from '@pi-desktop/provider-llamacpp';
import { Type } from '@sinclair/typebox';
import type { PresentBridge } from './present.js';
import { pathForModel } from './workspace-relative.js';

export const MATH_TOOL = 'math';
/** The spec written beside the page: `<name>.html` + `<name>.math.json`. */
export const MATH_SPEC_SUFFIX = '.math.json';

export interface MathToolDeps {
  readonly bridge: PresentBridge | null;
  /** The workspace root a relative path is resolved against. */
  readonly root: (ctxCwd: string | undefined) => string;
  /** The design kit in force for this project, or null for Bobble's own. */
  readonly kit?: (root: string) => Promise<Kit | null>;
  /** Whether the model can be sent the capture (a text-only server cannot). Injected for tests. */
  readonly canSeeImages?: () => boolean;
}

/**
 * The kit a math page wears when a project names one (its `.bobble/brand.md`,
 * or the Design setting's kit); otherwise Bobble's own. The whole kit — the
 * page needs its dark colours and its type, not only a chart's series.
 */
export async function projectMathKit(root: string): Promise<Kit | null> {
  const project = await loadProjectKit({
    root,
    kitName: process.env.PI_DESKTOP_DESIGN_KIT,
    readFile: (p) => readFile(p, 'utf8'),
  });
  return project.source === 'default' ? null : project.kit;
}

type Content = Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>;

function errorResult(text: string): { content: Content; isError: true; details: undefined } {
  return { content: [{ type: 'text', text }], isError: true, details: undefined };
}

/** "Building a Square Wave" → building-a-square-wave. */
export function mathSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/\$[^$]*\$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug !== '' ? slug : 'math-visual';
}

function resolveAgainst(root: string, p: string): string {
  const trimmed = p.trim();
  const home = process.env.HOME;
  const expanded =
    trimmed.startsWith('~/') && home !== undefined ? path.join(home, trimmed.slice(2)) : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
}

/** JSON as a model pastes it: inside a ``` fence, or with a trailing comma. */
export function looseJson(text: string): unknown {
  // Fenced or not; TeX with one backslash is TeX; comments, single quotes,
  // bare keys and trailing commas read (mathviz lenientJson).
  return lenientJson(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, ''),
  );
}

/** The spec's parts passed as flags (`--title … --plot '{…}' --steps '[…]'`), put together. */
function fromFlags(p: Record<string, unknown>): Record<string, unknown> | null {
  const keys = ['title', 'caption', 'params', 'plot', 'figure', 'steps', 'play'] as const;
  if (!keys.some((k) => p[k] !== undefined)) return null;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = p[k];
    if (v === undefined) continue;
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      try {
        out[k] = looseJson(v);
        continue;
      } catch {
        // Not JSON after all: kept as the words it is.
      }
    }
    out[k] = v;
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isFile() === true;
}

/** Where the spec comes from: a file, JSON text, or flags — or why none. */
async function readSpec(
  root: string,
  p: Record<string, unknown>,
): Promise<{ raw: unknown; file?: string } | { error: string }> {
  const s = typeof p.spec === 'string' ? p.spec.trim() : '';
  if (s.startsWith('{') || s.startsWith('```')) {
    try {
      return { raw: looseJson(s) };
    } catch (e) {
      return {
        error: `math: the spec is not valid JSON (${e instanceof Error ? e.message : String(e)}). For anything long, write it to a file (write lesson.math.json) and run \`math lesson.math.json\`.`,
      };
    }
  }
  if (s !== '') {
    // curl's `@file` habit; and a path from the parent that repeats the folder's own name.
    const bare = s.replace(/^@/, '');
    const own = path.basename(root);
    const fromParent = bare.startsWith(`${own}/`) ? bare.slice(own.length + 1) : undefined;
    const candidates = [
      bare,
      `${bare}.json`,
      `${bare}${MATH_SPEC_SUFFIX}`,
      ...(fromParent !== undefined ? [fromParent] : []),
    ].map((c) => resolveAgainst(root, c));
    for (const c of candidates) {
      if (!(await exists(c))) continue;
      if (/\.html?$/i.test(c)) {
        const beside = c.replace(/\.html?$/i, MATH_SPEC_SUFFIX);
        if (await exists(beside)) return readSpec(root, { spec: beside });
        return {
          error: `math: ${path.basename(c)} is a page, not a spec — run math on its .math.json.`,
        };
      }
      try {
        return { raw: looseJson(await readFile(c, 'utf8')), file: c };
      } catch (e) {
        return {
          error: `math: ${path.basename(c)} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — fix it and run math on it again.`,
        };
      }
    }
    // `math "Simple harmonic motion" --plot '{…}' --steps '[…]'`: the words are its title.
    const parts = fromFlags(p);
    if (parts !== null && parts.title === undefined) return { raw: { title: s, ...parts } };
    if (/\s/.test(s) && !/[\\/]|\.json$/i.test(s)) {
      return {
        error: `math: "${s}" reads as a title, not a spec — pass the spec as JSON with it as its "title", or write it to a .math.json file and pass that. \`math --help\` shows a whole one.`,
      };
    }
    return {
      error: `math: there is no file at ${s}. Write the spec there first (write ${/\.json$/i.test(s) ? s : `${s}${MATH_SPEC_SUFFIX}`}), then run math on it — or pass the JSON itself.`,
    };
  }
  const flags = fromFlags(p);
  if (flags !== null) return { raw: flags };
  return {
    error:
      'math needs its spec: the JSON {"title", "params", "plot" or "figure", "steps"}, or the path of a .math.json file holding it. `math --help` shows a whole one.',
  };
}

/** The same spec twice in a row for one file is said, not redrawn. */
const lastDrawn = new Map<string, { hash: string; text: string }>();

function describe(r: MathResult): string {
  const bits: string[] = [];
  if (r.spec.figure !== undefined)
    bits.push(
      `a figure of ${r.spec.figure.shapes.length} part${r.spec.figure.shapes.length === 1 ? '' : 's'}`,
    );
  if (r.spec.plot !== undefined)
    bits.push(
      `a plot of ${r.spec.plot.curves.length} curve${r.spec.plot.curves.length === 1 ? '' : 's'}`,
    );
  const sliders = r.spec.params.filter((p) => p.hidden !== true);
  if (sliders.length > 0)
    bits.push(`slider${sliders.length === 1 ? '' : 's'} ${sliders.map((p) => p.name).join(', ')}`);
  bits.push(`${r.spec.steps.length} step${r.spec.steps.length === 1 ? '' : 's'}`);
  return bits.join(', ');
}

/**
 * What the reader can do on the page, said as fact — MEASURED (the STEM
 * suite, 4B): a page of one curve and no sliders came back, and the reply
 * told the user to "use the Play/Step buttons to animate the mass on the
 * spring" and "adjust the amplitude and period sliders". The old reply line
 * suggested exactly those words ("drag a slider, press play").
 */
function controls(r: MathResult): string {
  const n = r.spec.steps.length;
  const sliders = r.spec.params.filter((p) => p.hidden !== true);
  const bits: string[] = [];
  if (n > 1 && r.spec.tell)
    bits.push(
      `it plays its ${n} steps on its own when it opens${sliders.length > 0 ? " (each step's words appear as the figure moves)" : ''}, then Back, Next and Play again`,
    );
  else if (n > 1) bits.push(`Back and Next through its ${n} steps`);
  if (sliders.length > 0)
    bits.push(
      `${sliders.length === 1 ? 'a slider' : 'sliders'} for ${sliders.map((p) => p.name).join(', ')}, with Play`,
    );
  const still = sliders.length === 0 ? ' Nothing on it moves — it has no sliders.' : '';
  return `On the page: ${bits.length > 0 ? bits.join('; ') : 'the visual alone'}.${still}`;
}

const REPLY =
  'Then tell the user in a sentence or two what the visual shows and how to use it — with the controls it has, above, and no others. The steps are on the page — do not repeat them in the chat.';

const DESCRIPTION = [
  "Draw a maths or physics explanation as a page beside the chat: a figure, a graph, or both, with 2 to 6 steps beside it. The page PLAYS the steps like a teacher at a whiteboard — each step's words appear while the figure moves to that step's slider values, an arrow showing which way each part moved — then gives the reader the sliders. Every function plot, geometry or physics diagram and every animation in an explanation goes here — never hand-written HTML or SVG, never the chart command (that is for data), never image generation.",
  '',
  'Write the spec to name.math.json — it is drawn the moment it is written, and its checks come back — or pass the JSON itself:',
  '{"title": "A ball thrown straight up",',
  ' "params": ["t = 0 in 0..1.5"],',
  ' "figure": {"view": {"x": "-2..2", "y": "0..3.6"},',
  '   "shapes": [{"id": "ground", "kind": "segment", "from": [-2, 0], "to": [2, 0]},',
  '              {"id": "ball", "kind": "circle", "center": [0, "8*t - 4.9*t^2"], "r": 0.15, "fill": "main", "label": "ball"},',
  '              {"id": "v", "kind": "vector", "from": [0.4, "8*t - 4.9*t^2"], "to": [0.4, "8*t - 4.9*t^2 + 0.12*(8 - 9.8*t)"], "label": "v"}]},',
  ' "plot": {"var": "t", "x": {"range": "0..1.5", "label": "time t (s)"}, "y": {"label": "height (m)"},',
  '          "curves": [{"id": "h", "expr": "8*t - 4.9*t^2", "label": "height"}],',
  '          "points": [{"id": "now", "x": "t", "on": "h"}]},',
  ' "steps": [{"text": "Thrown up at 8 m/s, the {ball} leaves the ground fast: its speed {v} is long.", "highlight": ["ball", "v"], "set": {"t": 0}},',
  '           {"text": "Gravity takes 9.8 m/s off its speed every second, so {v} shrinks as it rises.", "highlight": ["ball", "v", "now"], "set": {"t": 0.5}},',
  '           {"text": "At the top it stops for an instant: the peak of the {h} curve.", "highlight": ["ball", "h", "now"], "set": {"t": 0.82}, "nudge": {"t": 0.12}}]}',
  '',
  'params — sliders, "name = value in min..max". Any number anywhere may be an expression of them ("2*A", "A*cos(pi*t)").',
  'moving — a step\'s "set" slides its sliders there, eased. lerp(a, b, u) goes from a to b as u goes 0 to 1; one slider runs moves in turn with ease(between(t, 0, 1)) for the first and ease(between(t, 1, 2)) for the next. "opacity": "1 - t" on a part fades it as t grows.',
  'nudge — "nudge": {"A": 0.5} on a step wiggles A up and down after the step\'s move, so the reader sees what A changes: cause and effect.',
  'plot — "x" range (write π as pi), optional "y" range, "label"s for the axes; "curves" (expr in x — or in "var"; or "x" and "y" in t with a "t" range, for a parametric curve), "points" {x, y — or "on": a curve id — label}, "areas" {under, from, to, label}, "tangents" {to, at — "{m}" in its label is the slope}, "riemann" {under, from, to, n}.',
  'figure — "view" {"x": "0..10", "y": "0..8"} (y up) and "shapes", each {id, kind, …, label}: point {at}, segment and vector {from, to}, polygon {points}, polyline {points — an open path, a trajectory}, rect {at, w, h}, circle {center, r, fill}, angle {at, from, to}, dimension {from, to, label}, label {at, text}, box3d {at, size, depth, shade: right|top|front, edge: "L"}, spring {from, to, coils}.',
  'fill — main, second, third: solid, for an object (a mass, a triangle that moves); main-light, second-light: pale, for an area (a², the region under a curve); tint, shade, none. role (a line\'s colour) — main, second, third, reference (grey, dashed), highlight — never a hex. "step": 3 on any part shows it from step 3 on.',
  'steps — 2 to 6, each ONE short paragraph saying what moves and why; "highlight" the ids it talks about; "{id}" in its text names a part, with its colour key; $…$ is typeset. No bullet lists, no emoji.',
  'The page is checked — labels on labels, a part outside the view, a curve with no values, a slider that moves nothing, steps that point at nothing — and what it reports comes back to you: fix it in the spec and run math again.',
].join('\n');

export function registerMathTool(pi: ExtensionAPI, deps: MathToolDeps): void {
  pi.registerTool({
    name: MATH_TOOL,
    label: 'Math',
    description: DESCRIPTION,
    promptSnippet:
      'math: a maths/physics visual — function plots with sliders, labelled figures, steps tied to them',
    promptGuidelines: [
      'A graph of a function, a geometry or physics figure, or an animation for an explanation is the math tool with a spec — never hand-written HTML, SVG or canvas code, and never the chart tool (that is data).',
      'What math reports back (labels on labels, a part off the view, a step tied to nothing) is fixed in the .math.json and drawn again with math — the user sees the page as it is.',
    ],
    parameters: Type.Object({
      spec: Type.String({
        description:
          'The visual as JSON {"title", "params", "plot" and/or "figure", "steps"} — or the path of a .math.json file holding it.',
        cliOptional: true,
      }),
      out: Type.Optional(
        Type.String({
          description:
            'Where to write the page, e.g. lessons/fourier.html. Default: beside the spec, named from the title.',
        }),
      ),
      title: Type.Optional(Type.String({ description: 'Instead of --spec: the title…' })),
      caption: Type.Optional(Type.String({ description: '…a line under it…' })),
      params: Type.Optional(
        Type.String({ description: '…the sliders as JSON ["n = 1 in 1..25"]…' }),
      ),
      plot: Type.Optional(Type.String({ description: '…the plot as JSON…' })),
      figure: Type.Optional(Type.String({ description: '…the figure as JSON…' })),
      steps: Type.Optional(Type.String({ description: '…and the steps as JSON.' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return drawMath(params as Record<string, unknown>, deps.root(ctx?.cwd), deps);
    },
  });
}

type MathToolResult = { content: Content; isError?: true; details: undefined };

/**
 * A .math.json just written or edited IS the page asked for, so it is drawn
 * there and then: the write's result carries the page, its capture and its
 * checks. MEASURED (the STEM suite, 4B, two runs): it wrote lesson.math.json
 * three times and never ran math; then, with a note after every write naming
 * the command, four times more, presented the JSON as text, and made the
 * figure with image generation (a "sos(x)" axis). The spec was fine — it
 * drew, with two things to fix.
 */
export async function drawWrittenSpec(
  file: string,
  root: string,
  deps: MathToolDeps,
): Promise<MathToolResult> {
  return drawMath({ spec: file }, root, deps);
}

export async function drawMath(
  p: Record<string, unknown>,
  root: string,
  deps: MathToolDeps,
): Promise<MathToolResult> {
  const got = await readSpec(root, p);
  if ('error' in got) return errorResult(got.error);
  const kit = deps.kit !== undefined ? await deps.kit(root) : null;
  let r: MathResult;
  try {
    r = renderMath(got.raw, kit !== null ? { kit } : {});
  } catch (e) {
    if (e instanceof SpecError || e instanceof ExprError) {
      return errorResult(
        `math: ${e.message}.${got.file !== undefined ? ` Fix it in ${pathForModel(got.file, root)} and run math on it again.` : ''} (\`math --help\` shows a whole spec.)`,
      );
    }
    throw e;
  }

  // The files: the spec (as the model wrote it) and the page, side by side.
  const specFile = got.file ?? path.join(root, `${mathSlug(r.spec.title)}${MATH_SPEC_SUFFIX}`);
  const stem = specFile.endsWith(MATH_SPEC_SUFFIX)
    ? specFile.slice(0, -MATH_SPEC_SUFFIX.length)
    : specFile.replace(/\.json$/i, '');
  const out =
    typeof p.out === 'string' && p.out.trim() !== '' ? resolveAgainst(root, p.out) : undefined;
  const page = out === undefined ? `${stem}.html` : /\.html?$/i.test(out) ? out : `${out}.html`;
  try {
    await mkdir(path.dirname(page), { recursive: true });
    if (got.file === undefined)
      await writeFile(specFile, `${JSON.stringify(got.raw, null, 2)}\n`, 'utf8');
    await writeFile(page, r.html, 'utf8');
  } catch (e) {
    return errorResult(
      `math could not write ${pathForModel(page, root)}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const fixes = r.problems.filter((x) => x.level === 'fix');
  const warns = r.problems.filter((x) => x.level === 'warn');
  const notes = r.problems.filter((x) => x.level === 'note');
  const specRel = pathForModel(specFile, root);
  const lines = [
    `Drew "${r.spec.title}": ${pathForModel(page, root)} — ${describe(r)}. The spec is ${specRel}.`,
    controls(r),
  ];

  // A spec redrawn unchanged after problems were reported: say it, rather than redraw.
  const hash = createHash('sha1').update(JSON.stringify(got.raw)).digest('hex');
  const prev = lastDrawn.get(page);
  if (prev !== undefined && prev.hash === hash && fixes.length > 0) {
    return {
      content: [
        {
          type: 'text',
          text: `${prev.text}\n\n(That is the same spec as last time, so nothing changed — the problems above still stand. Change the spec where they say, then run math again.)`,
        },
      ],
      details: undefined,
    };
  }

  let image: { data: string; mimeType: string } | undefined;
  if (deps.bridge !== null) {
    const shown = await deps.bridge.show({ path: page, note: r.spec.title });
    lines[0] += shown.ok
      ? ' It is open in the canvas beside the chat.'
      : ` (the canvas could not open it: ${shown.error ?? 'unknown'})`;
    if ((deps.canSeeImages ?? serverCanSeeImages)()) {
      const preview = await deps.bridge.preview({ path: page, kind: 'render' });
      if (preview.imageBase64 !== undefined) {
        image = { data: preview.imageBase64, mimeType: preview.mimeType ?? 'image/png' };
        lines.push('The capture below is what the user sees.');
      }
    }
  }
  if (fixes.length > 0) {
    lines.push(`Checks — ${fixes.length} to fix:`, ...fixes.map((x) => `- ${x.text}`));
    if (warns.length > 0) lines.push('Also:', ...warns.map((x) => `- ${x.text}`));
    lines.push(
      `Fix ${fixes.length === 1 ? 'it' : 'them'} in ${specRel} and run \`math ${specRel}\` again.`,
    );
  } else if (warns.length > 0) {
    lines.push(
      'Checks — nothing overlaps or leaves the view. To improve:',
      ...warns.map((x) => `- ${x.text}`),
    );
    lines.push(`(Change ${specRel} and run \`math ${specRel}\` again, or leave it.)`, REPLY);
  } else {
    lines.push(
      'Checks — clear: no labels on labels, every part in view, every curve drawn, every step points at the figure.',
      REPLY,
    );
  }
  if (notes.length > 0) lines.push(...notes.map((x) => `(${x.text})`));
  const text = lines.join('\n');
  lastDrawn.set(page, { hash, text });
  const content: Content = [{ type: 'text', text }];
  if (image !== undefined) content.push({ type: 'image', ...image });
  return { content, details: undefined };
}
