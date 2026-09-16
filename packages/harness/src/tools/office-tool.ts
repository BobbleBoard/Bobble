/**
 * `office` — a real .pptx / .docx / .xlsx / .pdf, made and edited by the
 * document pipeline rather than by hand.
 *
 * the user: "model should not be using python-pptx, there is a dedicated subagent
 * for each pptx/docx/xlsx creation and editing right?" There was one — the
 * corp mesh's document specialist — and it was reachable from a corp run only;
 * a plain chat asked for a deck had bash and a habit, and the canvas assessment
 * watched it loop through `from pptx import Presentation` in a heredoc. The
 * pipeline behind that specialist (tools/office-gen) is now ONE command,
 * `office.py`, and this is the tool that calls it, in every chat.
 *
 * Three tools, one group, so the CLI mode reads as a person would type it:
 *
 *   office make pptx --brief "…" --out deck.pptx     office_make
 *   office edit deck.pptx --instruction "…"           office_edit
 *   office inspect deck.pptx                          office_inspect
 *
 * The division of labour is the pipeline's: the model here writes the BRIEF —
 * the words, the numbers, what goes where — and the local model behind the
 * pipeline turns it into a spec that deterministic renderers draw. Nothing in
 * this file touches a file format.
 *
 * What comes back is what the pipeline reports: the path, the slide-by-slide
 * summary, and — through the present bridge — the file open in the canvas with
 * a capture of it, so the model looks at what the user is looking at.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { serverCanSeeImages } from '@pi-desktop/provider-llamacpp';
import { Type } from '@sinclair/typebox';
import { utilityEndpointFromEnv } from '../model-call/call-model.js';
import type { PresentBridge } from './present.js';

export const OFFICE_MAKE_TOOL = 'office_make';
export const OFFICE_EDIT_TOOL = 'office_edit';
export const OFFICE_INSPECT_TOOL = 'office_inspect';
export const OFFICE_TOOL_NAMES = [OFFICE_MAKE_TOOL, OFFICE_EDIT_TOOL, OFFICE_INSPECT_TOOL] as const;

/** Where the scripts are — the app publishes it; a dev checkout is found by walking up. */
export const OFFICE_GEN_DIR_ENV = 'PI_OFFICE_GEN_DIR';
/** The interpreter that has python-pptx & co. — the app resolves it; default `python3`. */
export const OFFICE_GEN_PYTHON_ENV = 'PI_OFFICE_GEN_PYTHON';
/** Where the pipeline may write its scratch (raw model output, photo cache). */
export const OFFICE_GEN_SCRATCH_ENV = 'PI_OFFICE_GEN_SCRATCH';
/** The model server, as the scripts read it. Derived from the utility endpoint. */
export const OFFICE_GEN_SERVER_ENV = 'PI_OFFICE_GEN_SERVER';

const KINDS = ['pptx', 'docx', 'xlsx', 'pdf', 'chart'] as const;
export type OfficeKind = (typeof KINDS)[number];

/** A 24-slide deck on a 9B is minutes, not seconds. */
const RUN_TIMEOUT_MS = 15 * 60_000;

/** The pipeline's JSON reply, as `office.py` prints it. */
export interface OfficeResult {
  ok: boolean;
  error?: string;
  kind?: string;
  path?: string;
  bytes?: number;
  items?: number;
  theme?: string;
  /** kind chart: bar | hbar | line | donut. */
  chart?: string;
  palette?: { primary?: string; accent?: string };
  seconds?: number;
  warnings?: string[];
  summary?: string;
  outline?: string;
  ops?: number;
  applied?: string[];
  missed?: string[];
}

/** Find the scripts: the app's env, else the repo's tools/office-gen above this file. */
export function officeGenDir(env: Record<string, string | undefined> = process.env): string | null {
  const fromEnv = env[OFFICE_GEN_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return existsSync(fromEnv) ? fromEnv : null;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'tools', 'office-gen', 'office.py');
    if (existsSync(candidate)) return path.dirname(candidate);
    dir = path.dirname(dir);
  }
  return null;
}

export interface OfficeRunOptions {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (line: string) => void;
  /** Injected for tests. */
  readonly spawnImpl?: typeof spawn;
}

/**
 * Run `office.py <args>` and return its JSON reply.
 *
 * Every failure shape reaches the caller as `{ ok: false, error }`: the script
 * missing, the interpreter missing its libraries, the server down, a crash —
 * because the model reads this, and "exit code 1" is the message that sends a
 * model back to hand-writing the format.
 */
export async function runOffice(
  args: readonly string[],
  opts: OfficeRunOptions,
): Promise<OfficeResult> {
  const env = opts.env ?? process.env;
  const dir = officeGenDir(env);
  if (dir === null) {
    return { ok: false, error: 'the document pipeline (tools/office-gen) is not installed here' };
  }
  const python = env[OFFICE_GEN_PYTHON_ENV] ?? 'python3';
  const endpoint = utilityEndpointFromEnv(env);
  const server = env[OFFICE_GEN_SERVER_ENV] ?? endpoint?.baseUrl;
  if (server === undefined) {
    return {
      ok: false,
      error:
        'no local model server is running yet — the pipeline needs the chat model. Wait for it to load, then run this again.',
    };
  }
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') childEnv[k] = v;
  childEnv[OFFICE_GEN_SERVER_ENV] = server;
  // Never inherit a proxy into the pipeline: the server is on this machine.
  childEnv.no_proxy = '*';
  childEnv.NO_PROXY = '*';

  const spawnImpl = opts.spawnImpl ?? spawn;
  return new Promise<OfficeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: OfficeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(python, [path.join(dir, 'office.py'), ...args], {
        cwd: opts.cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      done({
        ok: false,
        error: `could not start ${python}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({
        ok: false,
        error: `the pipeline did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes`,
      });
    }, RUN_TIMEOUT_MS);
    timer.unref?.();
    opts.signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
      done({ ok: false, error: 'cancelled' });
    });
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    let partial = '';
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim().length > 0) opts.onProgress?.(line.trim());
    });
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      done({
        ok: false,
        error: missing
          ? `${python} is not installed on this Mac, and the pipeline runs on Python.`
          : err.message,
      });
    });
    child.on('exit', (code) => {
      const line = stdout
        .trim()
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('{'));
      if (line !== undefined) {
        try {
          done(JSON.parse(line) as OfficeResult);
          return;
        } catch {
          /* fall through to the raw report */
        }
      }
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      const noLib = /No module named '(pptx|docx|openpyxl|reportlab|PIL)'/.exec(stderr);
      done({
        ok: false,
        error:
          noLib !== null
            ? `${python} is missing the library "${noLib[1]}" the pipeline needs (python-pptx, python-docx, openpyxl, reportlab, pillow). Nothing else can make this file.`
            : `the pipeline exited with code ${code ?? '?'}${tail.length > 0 ? `:\n${tail}` : ''}`,
      });
    });
  });
}

// ── the tools ────────────────────────────────────────────────────────────────

export interface OfficeToolDeps {
  readonly bridge: PresentBridge | null;
  /** The workspace root a relative path is resolved against. */
  readonly root: (ctxCwd: string | undefined) => string;
  readonly env?: Record<string, string | undefined>;
  /** Injected for tests. */
  readonly spawnImpl?: typeof spawn;
}

/** Kilobytes, as a person reads them. */
function kb(n: number | undefined): string {
  return n === undefined ? '' : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function resolveAgainst(root: string, p: string | undefined): string | undefined {
  if (p === undefined || p.trim().length === 0) return undefined;
  const trimmed = p.trim();
  const home = process.env.HOME;
  const expanded =
    trimmed.startsWith('~/') && home !== undefined ? path.join(home, trimmed.slice(2)) : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
}

/*
 * THE CHECK IS AGAINST THE USER'S ASK, NOT AGAINST THE DRAFT. MEASURED on a
 * 4B asked for a 4-slide deck: its `write deck.pptx` (slide text as content)
 * made a good four-slide deck on the first call — and then, reading "wording
 * wrong?" here, it spent twelve minutes and twenty-eight more calls editing
 * the deck's outline to match the JSON it had drafted, never replied, and
 * never showed the user anything. The pipeline's wording and structure ARE
 * the deliverable; a difference from the model's own draft is the design
 * doing its job. So the line names what to compare with (the request) and
 * says that the draft is not it.
 */
const CHECK_LINE =
  "Check the summary against what the USER asked for — the facts, the numbers, the names, the order (and the capture, when one is attached). The layout, headings and phrasing are the pipeline's design and will differ from your draft; that is not an error and is not to be edited back. If the ask is met, you are done: tell the user where the file is (it is already open for them). Only something the user asked for and is missing or wrong needs `office edit` (one precise change) or a fuller brief.";

/**
 * Show the file in the canvas and fetch its capture, when the app is there.
 *
 * THE CAPTURE ONLY WHEN THE MODEL CAN SEE IT. On a text-only server the
 * provider swaps every image for a note telling the model to say it cannot
 * see images — the right note for a screenshot it was counting on, and the
 * wrong one here: MEASURED, three deep tasks in a row opened their reply to
 * the user with "I cannot see images since I'm in text-only mode" about a
 * file the user was already looking at. The capture is a courtesy check; a
 * blind model is simply not sent one, and the check line stops asking it to
 * look.
 */
async function presentFile(
  bridge: PresentBridge | null,
  filePath: string,
  note: string,
): Promise<{ shown: string; image?: { data: string; mimeType: string } }> {
  if (bridge === null) return { shown: '' };
  const shown = await bridge.show({ path: filePath, note });
  const shownText = shown.ok
    ? ' It is open in the canvas beside the chat.'
    : ` (the canvas could not open it: ${shown.error ?? 'unknown'})`;
  if (!serverCanSeeImages()) return { shown: shownText };
  const preview = await bridge.preview({ path: filePath, kind: 'office' });
  return {
    shown: shownText,
    ...(preview.imageBase64 !== undefined
      ? { image: { data: preview.imageBase64, mimeType: preview.mimeType ?? 'image/png' } }
      : {}),
  };
}

type Content = Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>;

/**
 * THE SAME BRIEF TWICE MAKES THE SAME FILE — so it is not made twice.
 *
 * MEASURED: given 8 slides for a brief that enumerated 6, the 4B re-sent the
 * identical brief nine times in a row, each a ~28 s pipeline run and a new
 * file over the old one, and the turn ran out of its budget. A repeat of the
 * exact brief for the exact path is answered from the memo with a line saying
 * what to change instead; a changed brief runs. Per process, so a new pi
 * session starts clean.
 */
const lastMade = new Map<string, { brief: string; text: string }>();

/** The words of a brief, for telling a retyped brief from a changed one. */
function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}$%]+/gu, ' ')
      .split(' ')
      .filter((w) => w.length > 0),
  );
}

/**
 * The same brief, or one retyped with a dash moved: MEASURED, the 4B re-sent
 * its brief eight times with "-" → "—", a word appended, a line reflowed, and
 * each variant was a fresh 25 s pipeline run over the file it had just made.
 * Nine tenths of the same words is the same brief.
 */
export function sameBrief(a: string, b: string): boolean {
  if (a === b) return true;
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.max(wa.size, wb.size) >= 0.9;
}

function repeatOf(path: string, brief: string): string | null {
  const prev = lastMade.get(path);
  if (prev === undefined || !sameBrief(prev.brief, brief)) return null;
  return `${prev.text}\n\n(That is the same brief as last time for ${path}, give or take a word, so nothing was re-made — the file above is already it. To get a different result, change what the brief SAYS; for a wording change, use office_edit.)`;
}

/**
 * A title is not a brief. MEASURED: `write docs/q3-review.pptx` with the
 * content "Q3 2026 Review - Marlow's Bakery" — 32 characters — and the
 * pipeline spent 25 s making a deck about nothing, three times. A deck, a
 * report, a workbook needs the CONTENT; below this there is none to use.
 */
export const BRIEF_MIN_CHARS = 80;

export function briefTooThin(brief: string): string | null {
  const t = brief.trim();
  if (t.length >= BRIEF_MIN_CHARS && (t.includes('\n') || t.split(/\s+/).length >= 15)) {
    return null;
  }
  return (
    `That is a title, not the content — ${t.length} characters. A document is made from what it should SAY: ` +
    'the facts, the numbers, the names, each section or slide in order. Put all of that in, then make it once.'
  );
}

function errorResult(text: string): { content: Content; isError: true; details: undefined } {
  return { content: [{ type: 'text', text }], isError: true, details: undefined };
}

/**
 * The kind an `out` extension or the brief's own words name. MEASURED on a
 * 4B: `office make --brief="One-page memo … as a Word document (docx) …"` —
 * refused for a missing kind it had already written twice. The first format
 * word wins, so a deck "with a bar chart" is a deck; a lone chart word is a
 * chart. Mirrors infer_kind in tools/office-gen/office.py.
 */
const KIND_WORDS: readonly (readonly [OfficeKind, RegExp])[] = [
  ['pptx', /\b(pptx|powerpoint|slides?|slide deck|deck|presentation|keynote)\b/],
  ['docx', /\b(docx|word document|word doc|word file|memo|letter|report|document)\b/],
  ['xlsx', /\b(xlsx|excel|spreadsheet|workbook|sheet)\b/],
  ['pdf', /\bpdf\b/],
  ['chart', /\b(bar|line|pie|donut)\s*(chart|graph)|\bchart\b|\bgraph of\b/],
];

export function inferOfficeKind(brief: string, out: string | undefined): OfficeKind | null {
  if (out !== undefined) {
    const ext = path.extname(out).toLowerCase().replace(/^\./, '');
    if (ext === 'svg') return 'chart';
    if ((KINDS as readonly string[]).includes(ext)) return ext as OfficeKind;
  }
  const low = brief.toLowerCase();
  for (const [kind, re] of KIND_WORDS) if (re.test(low)) return kind;
  return null;
}

export function registerOfficeTools(pi: ExtensionAPI, deps: OfficeToolDeps): void {
  const env = deps.env ?? process.env;

  pi.registerTool({
    name: OFFICE_MAKE_TOOL,
    label: 'Office: make',
    description:
      'Make a real .pptx slide deck, .docx document, .xlsx workbook, .pdf — or a standalone chart ' +
      '(.svg) of DATA — from a brief: designed layouts, fitted type, charts drawn from their ' +
      'numbers, through the on-device document pipeline. Every request for a deck, a presentation, ' +
      'a report, a memo, a spreadsheet, a PDF, or a bar/line/pie chart of some numbers goes here; ' +
      'never write these with python-pptx, python-docx, openpyxl, reportlab, matplotlib or by ' +
      'assembling the XML, and never ask image generation for a chart (a painted picture cannot ' +
      'put a value on an axis). The brief is the whole content: put in it every fact, number, ' +
      'name and section the file should contain, in order — the pipeline writes only what the ' +
      'brief gives it and invents nothing. It returns a slide-by-slide (or block-by-block) summary ' +
      'and opens the file in the canvas. For changes to a file that exists, use office_edit.',
    promptSnippet:
      'office_make: a deck, document, workbook, PDF or data chart from a brief (on-device)',
    promptGuidelines: [
      'Decks, reports, memos, spreadsheets and PDFs are made with office_make from a brief that carries all the content — never with python-pptx, python-docx, openpyxl or hand-written XML.',
      'A chart of data (bars, a line, a pie) is office_make with kind chart and the numbers in the brief — it is drawn from them; never a generated image, never matplotlib.',
    ],
    parameters: Type.Object({
      kind: Type.Union(
        KINDS.map((k) => Type.Literal(k)),
        {
          description:
            'pptx (slides), docx (document), xlsx (workbook), pdf, or chart (one bar/hbar/line/donut chart of data, as .svg).',
        },
      ),
      brief: Type.String({
        description:
          'What the file is and EVERYTHING it should say: audience, purpose, every fact and number, the sections or slides in order. Long is good.',
      }),
      out: Type.Optional(
        Type.String({
          description:
            'Where to write it, e.g. docs/q3-review.pptx. Relative paths land in the project. Default: named from the brief, in the project.',
        }),
      ),
      slides: Type.Optional(
        Type.Number({ description: 'pptx only: how many slides (3–24). Default 8.' }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const p = params as { kind?: unknown; brief?: unknown; out?: unknown; slides?: unknown };
      const brief = typeof p.brief === 'string' ? p.brief.trim() : '';
      const given = typeof p.kind === 'string' ? p.kind.toLowerCase().replace(/^\./, '') : '';
      const kind = (KINDS as readonly string[]).includes(given)
        ? given
        : inferOfficeKind(brief, typeof p.out === 'string' ? p.out : undefined);
      if (kind === null) {
        return errorResult(
          `office_make needs a kind: one of ${KINDS.join(', ')} — or name it in the brief ("a Word document") or in out (report.docx).`,
        );
      }
      const thin = briefTooThin(brief);
      if (thin !== null) return errorResult(`office_make needs a brief. ${thin}`);
      const root = deps.root(ctx?.cwd);
      const out = resolveAgainst(root, typeof p.out === 'string' ? p.out : undefined);
      const args = ['make', kind, '--brief', brief];
      if (out !== undefined) args.push('--out', out);
      if (typeof p.slides === 'number' && Number.isFinite(p.slides)) {
        args.push('--slides', String(Math.round(p.slides)));
      }
      const memoKey = `${out ?? `${root}/*.${kind}`}|${p.slides ?? ''}`;
      const repeat = repeatOf(memoKey, brief);
      if (repeat !== null) return { content: [{ type: 'text', text: repeat }], details: undefined };
      const progress: string[] = [];
      const r = await runOffice(args, {
        cwd: root,
        env,
        signal,
        spawnImpl: deps.spawnImpl,
        onProgress: (line) => {
          progress.push(line);
          onUpdate?.({
            content: [{ type: 'text', text: progress.slice(-4).join('\n') }],
            details: undefined,
          } as never);
        },
      });
      if (!r.ok || r.path === undefined) {
        return errorResult(`office_make could not make the ${kind}: ${r.error ?? 'unknown error'}`);
      }
      const what =
        kind === 'pptx'
          ? `a ${r.items ?? '?'}-slide deck${r.theme !== undefined ? ` (${r.theme})` : ''}`
          : kind === 'xlsx'
            ? 'a workbook'
            : kind === 'pdf'
              ? `a PDF (${r.items ?? '?'} blocks)`
              : kind === 'chart'
                ? `a ${r.chart ?? ''} chart (${r.items ?? '?'} points)`
                : `a document (${r.items ?? '?'} blocks)`;
      const shown = await presentFile(deps.bridge, r.path, `${what} — made from your brief`);
      const warn =
        r.warnings !== undefined && r.warnings.length > 0
          ? `\nWarnings: ${r.warnings.join('; ')}`
          : '';
      const text = `Made ${what}: ${r.path} (${kb(r.bytes)}, ${r.seconds ?? '?'}s).${shown.shown}${warn}\n\n${r.summary ?? ''}\n\n${CHECK_LINE}`;
      lastMade.set(memoKey, { brief, text });
      const content: Content = [{ type: 'text', text }];
      if (shown.image !== undefined) {
        content.push({ type: 'image', data: shown.image.data, mimeType: shown.image.mimeType });
      }
      return { content, details: undefined };
    },
  });

  pi.registerTool({
    name: OFFICE_EDIT_TOOL,
    label: 'Office: edit',
    description:
      'Change an existing .pptx, .docx, .xlsx (or a chart .svg made here) in place through the document pipeline: reword ' +
      'text, restyle it (size, bold, colour), move or resize a shape, delete one, delete, duplicate ' +
      'or reorder slides, set cells and formats. Say WHICH slide, paragraph or cell and WHAT it ' +
      'should become — office_inspect shows the ids. It cannot add new slides or paragraphs of ' +
      'new content; for that, make the file again with a fuller brief. Never edit these files ' +
      'with python-pptx/docx/openpyxl or by touching the XML.',
    promptSnippet:
      'office_edit: change wording, style, layout or slide order in an existing office file',
    parameters: Type.Object({
      file: Type.String({ description: 'The .pptx/.docx/.xlsx (or chart .svg) to change.' }),
      instruction: Type.String({
        description:
          'The change, precisely: which slide/paragraph/cell, and the new text or style.',
      }),
      out: Type.Optional(
        Type.String({ description: 'Write the changed copy here instead of editing in place.' }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const p = params as { file?: unknown; instruction?: unknown; out?: unknown };
      const root = deps.root(ctx?.cwd);
      const file = resolveAgainst(root, typeof p.file === 'string' ? p.file : undefined);
      const instruction = typeof p.instruction === 'string' ? p.instruction.trim() : '';
      if (file === undefined || instruction.length === 0) {
        return errorResult('office_edit needs the file and an instruction.');
      }
      if (!existsSync(file)) return errorResult(`There is no file at ${file}.`);
      const out = resolveAgainst(root, typeof p.out === 'string' ? p.out : undefined);
      const args = ['edit', file, '--instruction', instruction];
      if (out !== undefined) args.push('--out', out);
      const r = await runOffice(args, {
        cwd: root,
        env,
        signal,
        spawnImpl: deps.spawnImpl,
        onProgress: (line) =>
          onUpdate?.({ content: [{ type: 'text', text: line }], details: undefined } as never),
      });
      if (!r.ok || r.path === undefined) {
        return errorResult(`office_edit could not apply that: ${r.error ?? 'unknown error'}`);
      }
      const shown = await presentFile(deps.bridge, r.path, 'edited');
      const missed =
        r.missed !== undefined && r.missed.length > 0
          ? `\nNOT applied: ${r.missed.join('; ')} — those ids were wrong; check office_inspect.`
          : '';
      const content: Content = [
        {
          type: 'text',
          text:
            r.kind === 'chart'
              ? `Redrew the chart at ${r.path} with that change.${shown.shown}\n\nWhat is in it now:\n${r.summary ?? ''}\n\n${CHECK_LINE}`
              : `Applied ${r.ops ?? 0} change(s) to ${r.path}: ${(r.applied ?? []).join('; ')}.${shown.shown}${missed}\n\nWhat is in it now:\n${r.outline ?? ''}\n\n${CHECK_LINE}`,
        },
      ];
      if (shown.image !== undefined) {
        content.push({ type: 'image', data: shown.image.data, mimeType: shown.image.mimeType });
      }
      return { content, details: undefined };
    },
  });

  pi.registerTool({
    name: OFFICE_INSPECT_TOOL,
    label: 'Office: inspect',
    description:
      'Outline an existing .pptx, .docx, .xlsx or chart .svg made here: every slide, shape, paragraph or cell with its id, ' +
      'text, size and colour. This is how to READ an office file — never `read` it (that returns ' +
      'zip bytes) and never unzip it. The ids are what office_edit takes.',
    promptSnippet: 'office_inspect: read an office file as an outline with ids',
    parameters: Type.Object({
      file: Type.String({ description: 'The .pptx/.docx/.xlsx to outline.' }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const p = params as { file?: unknown };
      const root = deps.root(ctx?.cwd);
      const file = resolveAgainst(root, typeof p.file === 'string' ? p.file : undefined);
      if (file === undefined) return errorResult('office_inspect needs the file.');
      if (!existsSync(file)) return errorResult(`There is no file at ${file}.`);
      const r = await runOffice(['inspect', file], {
        cwd: root,
        env,
        signal,
        spawnImpl: deps.spawnImpl,
      });
      if (!r.ok)
        return errorResult(`office_inspect could not read it: ${r.error ?? 'unknown error'}`);
      return {
        content: [{ type: 'text', text: `${file} (${r.kind}):\n${r.outline ?? '(empty)'}` }],
        details: undefined,
      };
    },
  });
}

// ── the file tools, office-aware ─────────────────────────────────────────────

/** The formats that are zips. */
const OFFICE_PATH = /\.(pptx|docx|xlsx)$/i;

/** Which office kind a path names, or null. */
export function officeKindOfPath(p: string): OfficeKind | null {
  const m = OFFICE_PATH.exec(p.trim());
  if (m === null) return null;
  return (m[1] as string).toLowerCase() as OfficeKind;
}

/** `edit`'s replacements, said as an instruction the pipeline's editor takes. */
export function editsAsInstruction(
  edits: ReadonlyArray<{ oldText?: unknown; newText?: unknown }>,
): string {
  const one = (v: unknown): string => (typeof v === 'string' ? v : '').trim().slice(0, 400);
  return edits
    .map((e) => {
      const from = one(e.oldText);
      const to = one(e.newText);
      if (from.length === 0 && to.length > 0) return `Add the text: "${to}".`;
      if (to.length === 0) return `Remove the text "${from}".`;
      return `Change the text "${from}" to "${to}", keeping its styling.`;
    })
    .join(' ');
}

interface FileToolLike {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
  [k: string]: unknown;
}

/**
 * THE NATURAL CALL DOES THE RIGHT THING.
 *
 * MEASURED, twice in one run: asked for a deck, the 4B's first act was
 * `write docs/q3-review.pptx` with the slide text as content; asked to retitle
 * a slide, it called `edit docs/q3-review.pptx` TWELVE times, each answered
 * with a refusal that spelled out `office edit …`, and then told the user it
 * was done. A model that knows `write` and `edit` reaches for them whatever
 * the extension, and a refusal — however well it points — is a wall it walks
 * into again. So the file tools learn the formats instead:
 *
 *   write deck.pptx  <text>            → the pipeline MAKES the deck from that text
 *   edit  deck.pptx  old → new         → the pipeline EDITS the deck ("change X to Y")
 *   read  deck.pptx                    → the outline, not the zip's bytes
 *
 * Everything else — every other path — is the fenced tool underneath,
 * untouched. The office tools remain the better call (a brief written FOR the
 * pipeline beats slide text written for a text file), and their results say so.
 */
export function withOfficeFormats(
  tool: FileToolLike,
  deps: OfficeToolDeps & { available?: () => boolean },
): FileToolLike {
  if (tool.name !== 'write' && tool.name !== 'edit' && tool.name !== 'read') return tool;
  const env = deps.env ?? process.env;
  const base = tool.execute;
  return {
    ...tool,
    async execute(...args: unknown[]) {
      const [, params, signal, onUpdate, ctx] = args as [
        string,
        { path?: unknown; content?: unknown; edits?: unknown },
        AbortSignal | undefined,
        ((u: unknown) => void) | undefined,
        { cwd?: string } | undefined,
      ];
      const raw = typeof params?.path === 'string' ? params.path : '';
      const kind = officeKindOfPath(raw);
      if (kind === null || (deps.available !== undefined && !deps.available())) {
        return base.apply(tool, args);
      }
      const root = deps.root(ctx?.cwd);
      const file = resolveAgainst(root, raw) ?? raw;
      const progress = (line: string): void =>
        onUpdate?.({ content: [{ type: 'text', text: line }], details: undefined });
      const run = (a: string[]): Promise<OfficeResult> =>
        runOffice(a, { cwd: root, env, signal, spawnImpl: deps.spawnImpl, onProgress: progress });

      if (tool.name === 'read') {
        if (!existsSync(file)) return base.apply(tool, args);
        const r = await run(['inspect', file]);
        if (!r.ok)
          return errorResult(
            `${file} is ${NOUN[kind]}, and its outline could not be read: ${r.error ?? 'unknown error'}`,
          );
        return {
          content: [
            {
              type: 'text',
              text: `${file} (${kind}) — its outline, with the ids office_edit takes:\n${r.outline ?? '(empty)'}`,
            },
          ],
          details: undefined,
        };
      }
      if (tool.name === 'write') {
        const content = typeof params.content === 'string' ? params.content.trim() : '';
        const thin = briefTooThin(content);
        if (thin !== null) {
          return errorResult(
            `Not written: ${raw} is ${NOUN[kind]} — a zip archive the document pipeline makes from content, not a text file. ${thin}`,
          );
        }
        const repeat = repeatOf(file, content);
        if (repeat !== null) {
          return { content: [{ type: 'text', text: repeat }], details: undefined };
        }
        const r = await run(['make', kind, '--brief', content, '--out', file]);
        if (!r.ok || r.path === undefined) {
          return errorResult(
            `${raw} is ${NOUN[kind]}; the pipeline could not make it from that text: ${r.error ?? 'unknown error'}`,
          );
        }
        const shown = await presentFile(
          deps.bridge,
          r.path,
          `${NOUN[kind]} — made from what you wrote`,
        );
        const text = `${raw} is ${NOUN[kind]}, so the text you wrote became the BRIEF and the document pipeline made the file: ${r.path} (${kb(r.bytes)}, ${r.items ?? '?'} ${kind === 'pptx' ? 'slides' : 'blocks'}, ${r.seconds ?? '?'}s).${shown.shown}\n\n${r.summary ?? ''}\n\n${CHECK_LINE} The file EXISTS and is finished — do not write it again, and do not edit it to resemble the text you wrote: that text was the brief, and this designed file is what it became.`;
        lastMade.set(file, { brief: content, text });
        const content2: Content = [{ type: 'text', text }];
        if (shown.image !== undefined) content2.push({ type: 'image', ...shown.image });
        return { content: content2, details: undefined };
      }
      // edit
      if (!existsSync(file)) {
        return errorResult(
          `There is no ${kind} at ${file} to edit. Make it first (office_make, or write it with the content).`,
        );
      }
      const edits = Array.isArray(params.edits)
        ? (params.edits as Array<{ oldText?: unknown; newText?: unknown }>)
        : [];
      const instruction = editsAsInstruction(edits);
      if (instruction.length === 0) return errorResult('edit needs at least one replacement.');
      const r = await run(['edit', file, '--instruction', instruction]);
      if (!r.ok || r.path === undefined) {
        return errorResult(
          `${raw} is ${NOUN[kind]}; the pipeline could not apply that edit: ${r.error ?? 'unknown error'}. Say which slide/paragraph/cell and what it should become (read the file for its outline).`,
        );
      }
      const shown = await presentFile(deps.bridge, r.path, 'edited');
      const missed =
        r.missed !== undefined && r.missed.length > 0
          ? `\nNOT applied: ${r.missed.join('; ')}.`
          : '';
      const content3: Content = [
        {
          type: 'text',
          text: `${raw} is ${NOUN[kind]}, so the document pipeline applied your edit as: ${instruction}\nApplied ${r.ops ?? 0} change(s): ${(r.applied ?? []).join('; ')}.${shown.shown}${missed}\n\nWhat is in it now:\n${r.outline ?? ''}\n\n${CHECK_LINE}`,
        },
      ];
      if (shown.image !== undefined) content3.push({ type: 'image', ...shown.image });
      return { content: content3, details: undefined };
    },
  };
}

const NOUN: Record<OfficeKind, string> = {
  pptx: 'a slide deck',
  docx: 'a document',
  xlsx: 'a workbook',
  pdf: 'a PDF',
  chart: 'a chart',
};
