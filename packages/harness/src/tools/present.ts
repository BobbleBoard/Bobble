/**
 * `present` — hand the finished thing to the user, and look at it one last time.
 *
 * the user's ask: "I want the model to have a 'present' tool, this is only for the
 * top level/original model, no subagent ever has this, that presents a file to
 * the user, shows a card and the file open or running in canvas, if it's a godot
 * game or whatever, that should show up as well in the canvas as well, able to
 * work. this also will show the model an immediate preview of the file/game/
 * project via returning an image or output whatever applicable, it will
 * essentially force a review and iteration if at this last minute it sees,
 * something is wrong."
 *
 * WHY IT IS A TOOL AND NOT A PROMPT LINE. "Check your work before you finish" is
 * already in the system prompt, and it is obeyed unevenly, because checking is
 * optional and stopping is free. Making the LAST ACT a tool call that returns the
 * artefact's own preview removes the choice: the model cannot hand something over
 * without receiving a picture of it back. A wrong render, an empty file, a page
 * that does not load — all of them arrive in context while there is still a turn
 * left to fix them.
 *
 * TOP-LEVEL ONLY, deliberately. A subagent reports to the model that spawned it,
 * not to the person; letting a child "present" would put artefacts in front of a
 * user nobody had decided to show them to. Registration is gated on subagent
 * depth, the same gate `spawn_subagent` uses.
 *
 * The preview is chosen by what the thing IS — see {@link previewPlanFor}, which
 * is pure and carries the whole policy.
 */

import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { DiagramTheme } from '@pi-desktop/design-kit';
import { Type } from '@sinclair/typebox';
import { HANDMADE_MATH_NOTE, handmadeMathVisual } from './handmade-math.js';
import { fixesToPush } from './math-open-fixes.js';
import { remotePictures, remotePicturesNote, unseenPictures } from './remote-pictures.js';
import { pathForModel } from './workspace-relative.js';

export const PRESENT_TOOL_NAME = 'present';

/** How a given artefact should be previewed back to the model. */
export type PreviewKind =
  /** Read the bytes and return them as an image the model can see. */
  | 'image'
  /** Open it in the built-in browser and screenshot what renders. */
  | 'render'
  /** Run it and return what it printed. */
  | 'run'
  /** Return the text itself (head of it). */
  | 'text'
  /** List what is inside, plus the entry point if there is an obvious one. */
  | 'project'
  /** Open it in the canvas's office editor and capture what it draws. */
  | 'office'
  /** Nothing better available: report type and size honestly. */
  | 'describe';

export interface PreviewPlan {
  readonly kind: PreviewKind;
  /** Why this preview was chosen — shown to the model so a fallback is not silent. */
  readonly because: string;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
/* The formats the canvas opens in a real editor: the preview is a capture of
   that editor, which is exactly what the user sees. `read` on any of these
   returns zip bytes, which is what the assessment watched a model do. */
const OFFICE_EXT = new Set(['.pptx', '.docx', '.xlsx', '.pdf']);
const RENDER_EXT = new Set(['.html', '.htm']);
const RUN_EXT = new Set(['.py', '.sh', '.mjs', '.js', '.ts']);
const TEXT_EXT = new Set([
  '.md',
  '.txt',
  '.json',
  '.csv',
  '.yml',
  '.yaml',
  '.toml',
  '.css',
  '.rs',
  '.go',
  '.c',
  '.h',
  '.cpp',
  '.java',
  '.rb',
  '.gd',
  '.tscn',
  '.godot',
]);

/** Lowercased extension including the dot, or '' for none. */
export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Decide how to preview something.
 *
 * A DIRECTORY is a project: a Godot game, a web app, a folder of renders. Those
 * are the cases where "it exists" is most likely to be mistaken for "it works",
 * so they get listed and their entry point named rather than described.
 */
export function previewPlanFor(target: { path: string; isDirectory: boolean }): PreviewPlan {
  if (target.isDirectory) {
    return { kind: 'project', because: 'a folder — listing it and naming its entry point' };
  }
  const ext = extensionOf(target.path);
  if (IMAGE_EXT.has(ext)) return { kind: 'image', because: `an image (${ext})` };
  if (RENDER_EXT.has(ext)) {
    return { kind: 'render', because: 'a page — opening it and capturing what renders' };
  }
  if (RUN_EXT.has(ext)) return { kind: 'run', because: `a script (${ext}) — running it` };
  if (OFFICE_EXT.has(ext)) {
    return {
      kind: 'office',
      because: `a document (${ext}) — opening it in the canvas and capturing it`,
    };
  }
  if (TEXT_EXT.has(ext) || ext === '') {
    return {
      kind: 'text',
      because: ext === '' ? 'no extension — reading it as text' : `text (${ext})`,
    };
  }
  return { kind: 'describe', because: `nothing can render ${ext} here` };
}

/** Entry points worth naming when presenting a folder, most telling first. */
export const PROJECT_ENTRY_POINTS = [
  'project.godot',
  'index.html',
  'package.json',
  'main.py',
  'README.md',
  'Cargo.toml',
] as const;

/** The first recognised entry point in a listing, if any. */
export function entryPointIn(names: readonly string[]): string | undefined {
  return PROJECT_ENTRY_POINTS.find((e) => names.includes(e));
}

/**
 * The line that turns a preview into a decision.
 *
 * Every branch ends here, because the point of the tool is not the card in the
 * UI — it is that the model has to LOOK before it is allowed to be finished.
 */
export function reviewInstruction(): string {
  return (
    'This is what the user will receive. Look at it now, as them: is it actually what ' +
    'they asked for? If anything is wrong, missing, empty or broken, FIX IT and present ' +
    'again — you still have the turn. Only say you are done once this preview is right.'
  );
}

/**
 * The `diagram` call over the bridge (diagram-tool.ts → the app's Mermaid
 * window, apps/desktop/electron/gen/diagram-page.ts): the model's Mermaid and
 * the kit's two themes in; both drawings, or the line Mermaid could not read,
 * out. Defined here, beside the bridge it travels on, so both sides read one
 * contract.
 */
export interface DiagramRenderRequest {
  readonly source: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly themes: { readonly light: DiagramTheme; readonly dark: DiagramTheme };
}

export interface DiagramDrawing {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

export type DiagramRenderReply =
  | {
      readonly ok: true;
      /** The source as drawn — after any correction the notes describe. */
      readonly source: string;
      readonly notes: readonly string[];
      /** What it is, in words: "flowchart", "sequence diagram". */
      readonly kind: string;
      /** A flowchart's step labels, in the order declared (empty for other kinds). */
      readonly nodes: readonly string[];
      readonly edges: number;
      readonly labelledEdges: readonly string[];
      readonly failEdges: number;
      readonly decisions: number;
      readonly light: DiagramDrawing;
      readonly dark: DiagramDrawing;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /** 1-based, in the source as the model sent it. */
      readonly line: number | null;
      readonly lineText: string | null;
      /** The likely fix, in one line. */
      readonly hint: string;
      /**
       * 'app' when the drawing failed in the app itself (the hidden window,
       * the bridge), not in the source. MEASURED: a failure of the app's own
       * reported as "Mermaid could not read the source … simplify it" sent the
       * 4B rewriting a source that was fine, then back to hand-typed SVG.
       */
      readonly cause?: 'app';
    };

export interface PresentBridge {
  /** Show the card + open the artefact in the canvas. */
  show(req: { path: string; note?: string }): Promise<{ ok: boolean; error?: string }>;
  /** Produce the preview the model sees. */
  preview(req: {
    path: string;
    kind: PreviewKind;
  }): Promise<{ imageBase64?: string; mimeType?: string; text?: string; error?: string }>;
  /**
   * A small decoded copy of an image (RGBA, base64), for reading colours off
   * it — the app decodes every format Chromium does. Optional: a bridge
   * without it means "styling from an image" is not available here.
   */
  pixels?(req: {
    path: string;
    width?: number;
  }): Promise<{ width?: number; height?: number; rgba?: string; error?: string }>;
  /**
   * Draw a diagram with the app's bundled Mermaid. Optional: a bridge without
   * it (an older app) means the diagram tool is not available here.
   */
  diagram?(req: DiagramRenderRequest): Promise<DiagramRenderReply>;
}

export interface PresentToolDeps {
  readonly bridge: PresentBridge | null;
  readonly stat: (p: string) => Promise<{ isDirectory: boolean } | null>;
  /**
   * Where a RELATIVE path is rooted — the working folder the file tools use.
   * MEASURED 2026-09-15: `coordinate present probe-note.md` right after `file
   * write probe-note.md` said "Presented probe-note.md" and then "The preview
   * could not be produced: ENOENT" — the tool's stat ran in pi's own cwd, the
   * app's did not, and the card opened nothing. The model's relative path is
   * the same relative path it just wrote, and it means the same folder.
   */
  readonly resolvePath?: (p: string) => string;
  /** A file's text, for what a page loads (see remote-pictures.ts). */
  readonly readText?: (p: string) => Promise<string | null>;
  /** Everything the chat has said to the model — its messages and tool results. */
  readonly chatText?: () => string;
  /** The names in a folder, for a path given without its extension. */
  readonly listDir?: (dir: string) => Promise<readonly string[]>;
}

/**
 * THE NAME WITHOUT ITS EXTENSION. MEASURED (STEM visual suite, 4B): it wrote
 * completing_the_square_practice.html and .md, then ran `present
 * completing_the_square_practice` six times — "There is nothing at …" each
 * time, and `ls` showing both files in between did not help. The files that
 * are that name plus an extension: one is the file it meant; several are
 * named back so the next call can pick.
 */
export async function sameNameFiles(
  resolved: string,
  listDir: (dir: string) => Promise<readonly string[]>,
): Promise<string[]> {
  const base = basename(resolved);
  if (base === '' || /\.[A-Za-z0-9]{1,5}$/.test(base)) return [];
  const names = await listDir(dirname(resolved)).catch(() => [] as readonly string[]);
  return names
    .filter((n) => n.startsWith(`${base}.`) && !n.slice(base.length + 1).includes('/'))
    .sort()
    .map((n) => join(dirname(resolved), n));
}

/**
 * Register `present`. Callers gate on subagent depth — a child never gets it.
 */
export function registerPresentTool(pi: ExtensionAPI, deps: PresentToolDeps): void {
  pi.registerTool({
    name: PRESENT_TOOL_NAME,
    label: 'Present',
    description:
      'Show the user a finished file, folder or project — it appears as a card and opens (or ' +
      'runs) in the canvas beside the chat. Use this as your LAST action when you have made ' +
      'something: a page, an image, a script, a game, a document. It hands you back a preview ' +
      'of what the user will actually see, so you can check it before you say you are done. ' +
      'Present the finished artefact, not an intermediate file.',
    promptSnippet: 'present: show the user the finished artefact and see it yourself first',
    promptGuidelines: [
      'Make this your last action whenever the task produced a file, folder or project.',
      'Read the preview it returns. If the artefact is wrong or empty, fix it and present again.',
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path to the finished file, folder or project to show the user — absolute, or ' +
          'relative to the working folder.',
      }),
      note: Type.Optional(
        Type.String({ description: 'One line for the card — what this is. Optional.' }),
      ),
    }),
    async execute(_id, params) {
      const p =
        typeof (params as { path?: unknown })?.path === 'string'
          ? (params as { path: string }).path.trim()
          : '';
      if (p === '') {
        return {
          content: [{ type: 'text', text: 'present needs the "path" of what to show.' }],
          isError: true,
          details: undefined,
        };
      }
      if (deps.bridge === null) {
        return {
          content: [{ type: 'text', text: 'present is unavailable outside the desktop app.' }],
          isError: true,
          details: undefined,
        };
      }
      /*
       * EXPAND ~ FIRST. A model writes `~/proj/app.py` constantly, and nothing
       * downstream expands it: `stat` fails, present returns "There is nothing
       * at ~/proj/app.py", no `present:show` is emitted, and the thread shows a
       * present ROW from the tool call with no card under it — the user: "I see a
       * present file/folder tool call that didn't present anything."
       *
       * Same root as the syntax check running py_compile on a quoted tilde. A
       * leading ~/ is a home reference; a tilde anywhere else is a filename
       * character and is left alone.
       */
      const expanded = p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p;
      let resolved =
        !isAbsolute(expanded) && deps.resolvePath !== undefined
          ? deps.resolvePath(expanded)
          : expanded;
      let info = await deps.stat(resolved);
      /*
       * THE FOLDER'S OWN NAME, REPEATED. A tool result names the file by its
       * absolute path, `…/Bobble/draw-a-simple-bicycle-as/bicycle.svg`; the
       * model is told its working folder is Bobble and so writes
       * `draw-a-simple-bicycle-as/bicycle.svg` — which a resolver rooted at the
       * chat's own folder turns into the folder inside itself. MEASURED on a
       * 4B, twice (a cp and a present, one turn apart). The path it wrote is
       * a path FROM THE PARENT; when nothing is at the first reading and the
       * relative path's first segment is the workspace's own name, the second
       * reading is the one it meant.
       */
      if (info === null && !isAbsolute(expanded) && deps.resolvePath !== undefined) {
        const root = deps.resolvePath('.');
        const first = expanded.split('/')[0];
        if (first !== undefined && first === root.split('/').filter(Boolean).at(-1)) {
          const again = join(dirname(root), expanded);
          const info2 = await deps.stat(again);
          if (info2 !== null) {
            resolved = again;
            info = info2;
          }
        }
      }
      let noExtension = '';
      if (info === null && deps.listDir !== undefined) {
        const same = await sameNameFiles(resolved, deps.listDir);
        if (same.length === 1 && same[0] !== undefined) {
          const info3 = await deps.stat(same[0]);
          if (info3 !== null) {
            resolved = same[0];
            info = info3;
            noExtension = ` (${p} has no extension; the file is ${basename(same[0])})`;
          }
        } else if (same.length > 1) {
          const names = same.map((f) => basename(f));
          return {
            content: [
              {
                type: 'text',
                text: `There is nothing at ${p} — but there are ${names.slice(0, -1).join(', ')} and ${names.at(-1)}. Present the one you mean, with its extension.`,
              },
            ],
            isError: true,
            details: undefined,
          };
        }
      }
      if (info === null) {
        return {
          content: [
            {
              type: 'text',
              text:
                `There is nothing at ${p}. Presenting is the last step — make the artefact ` +
                'first, then present the real path.',
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      const plan = previewPlanFor({ path: resolved, isDirectory: info.isDirectory });
      const note = (params as { note?: string }).note;
      // The RESOLVED path — the renderer opens this, and it cannot open a tilde.
      const shown = await deps.bridge.show({
        path: resolved,
        ...(note !== undefined ? { note } : {}),
      });
      /*
       * A DIAGRAM IS ALREADY IN FRONT OF THE USER. MEASURED, the research's flow
       * brief on the 4B with the diagram tool in place: it drew the diagram in
       * one call, then presented the .svg anyway (both tool modes, against the
       * tool's own "do not present it again") — and the preview handed back
       * the drawing's markup, 1,112 tokens of paths the model cannot read, into
       * a request that had nothing else to do. Its sidecar (diagram-tool.ts's
       * .diagram.json) marks one; the card is re-shown, and the answer is short.
       */
      if (!info.isDirectory && /\.svg$/i.test(resolved)) {
        const sidecar = await deps.stat(resolved.replace(/\.svg$/i, '.diagram.json'));
        if (sidecar !== null && !sidecar.isDirectory) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${pathForModel(resolved, deps.resolvePath?.('.'))} is a diagram the diagram tool drew — its card is already in the chat, so there was nothing more to present. ` +
                  'Reply in one sentence saying what it shows; a change is diagram_edit on this file.',
              },
            ],
            details: undefined,
          } as never;
        }
      }
      /*
       * A MATH PAGE IS ALREADY OPEN, TOO — the math command opened it when it
       * drew, with its capture and its checks. MEASURED (the 4B, Pythagoras):
       * it presented its page fifteen times running, each answer ending "FIX
       * IT and present again", and the repeat notes did not stop it. The
       * answer is short and ends the loop.
       */
      if (!info.isDirectory && /\.html?$/i.test(resolved) && deps.readText !== undefined) {
        const page = await deps.readText(resolved).catch(() => null);
        if (page !== null && /\bdata-mv-panel\b/.test(page)) {
          const open = fixesToPush(resolved);
          if (open !== null) {
            const n = open.fixes.length;
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `${pathForModel(resolved, deps.resolvePath?.('.'))} is open beside the chat, but it was drawn with ${n === 1 ? 'a problem' : `${n} problems`} the user will see:`,
                    ...open.fixes.slice(0, 5).map((f) => `- ${f}`),
                    ...(n > 5 ? [`- (and ${n - 5} more)`] : []),
                    `Fix ${n === 1 ? 'it' : 'them'} in ${open.spec} and run \`math ${open.spec}\` again, then answer. (To leave the page as it is, present it again.)`,
                  ].join('\n'),
                },
              ],
              details: undefined,
            } as never;
          }
          return {
            content: [
              {
                type: 'text',
                text:
                  `${pathForModel(resolved, deps.resolvePath?.('.'))} is the page the math command drew — it is already open beside the chat, playing its steps, so there was nothing more to present. ` +
                  'Reply in a sentence or two saying what it shows and how to use it; a change is made in its .math.json, which redraws it.',
              },
            ],
            details: undefined,
          } as never;
        }
      }
      const preview = await deps.bridge.preview({ path: resolved, kind: plan.kind });

      const content: Array<Record<string, unknown>> = [];
      const head = [
        `Presented ${pathForModel(resolved, deps.resolvePath?.('.'))} to the user${noExtension}${shown.ok ? '' : ` (the canvas could not open it: ${shown.error ?? 'unknown'})`}.`,
        `Preview: ${plan.because}.`,
      ].join(' ');
      content.push({ type: 'text', text: head });
      if (preview.imageBase64 !== undefined) {
        content.push({
          type: 'image',
          data: preview.imageBase64,
          mimeType: preview.mimeType ?? 'image/png',
        });
      }
      if (preview.text !== undefined && preview.text.length > 0) {
        content.push({ type: 'text', text: preview.text });
      }
      if (preview.error !== undefined) {
        content.push({
          type: 'text',
          text:
            `The preview could not be produced: ${preview.error}. That is itself worth ` +
            'checking — if the artefact cannot be opened or run here, the user may hit the ' +
            'same thing.',
        });
      }
      /* A page's pictures from addresses nothing gave the model — said beside
         the preview that shows them (remote-pictures.ts). */
      if (
        /\.html?$/i.test(resolved) &&
        deps.readText !== undefined &&
        deps.chatText !== undefined
      ) {
        const html = await deps.readText(resolved).catch(() => null);
        const note =
          html === null
            ? ''
            : remotePicturesNote(unseenPictures(remotePictures(html), deps.chatText()));
        if (note !== '') content.push({ type: 'text', text: note.trim() });
      }
      /* A maths or physics visual made by hand: the moment it is looked at is
         the moment to name the command that makes it (handmade-math.ts). */
      if (/\.(html?|svg)$/i.test(resolved) && deps.readText !== undefined) {
        const text = await deps.readText(resolved).catch(() => null);
        if (text !== null && handmadeMathVisual(text, /\.svg$/i.test(resolved) ? 'svg' : 'html')) {
          content.push({ type: 'text', text: HANDMADE_MATH_NOTE });
        }
      }
      content.push({ type: 'text', text: reviewInstruction() });
      return { content, details: undefined } as never;
    },
  });
}
