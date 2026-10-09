/**
 * The app side of `present`: show the artefact to the user, and hand the model
 * back a picture of what they will see.
 *
 * The user: "presents a file to the user, shows a card and the file open or running
 * in canvas, if it's a godot game or whatever, that should show up as well in the
 * canvas as well, able to work. this also will show the model an immediate
 * preview of the file/game/project via returning an image or output whatever
 * applicable, it will essentially force a review and iteration if at this last
 * minute it sees, something is wrong."
 *
 * The forcing function is the return value, not the card. A model that cannot
 * finish without receiving its own artefact back has no way to hand over an empty
 * file, a blank render or a project that does not open — it sees them, in
 * context, with a turn still available.
 *
 * Transport mirrors the sibling bridges (subagent-bridge.ts, gen3d-bridge.ts):
 * a token-authed unix socket, one JSON line per request.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DiagramRenderReply, DiagramRenderRequest } from '@pi-desktop/harness/tools/present';
import { createIpcEventSender, createLogger } from '@pi-desktop/shared';
import { nativeImage, type WebContents } from 'electron';
import { apngMoments } from '../gen/apng';
import { getInferenceVisionReady } from '../inference/llm-main';
import { wantVision } from '../inference/vision-want';
import type { AppEventMap } from '../ipc-contract';
import { type Cell, composeGrid } from '../office/office-grid';
import { officeLook } from '../office/office-look';
import { captureViewForFile } from '../office/office-manager';
import { presentInlinePayload } from './present-inline';
import type { PageShot } from './render-page';

const log = createLogger('desktop:present');
/*
 * THE ENVELOPE SENDER, NOT `wc.send`.
 *
 * This was `wc.send('present:show', …)` — a RAW channel name. The preload
 * listens on ONE channel (IPC_EVENT_CHANNEL) and dispatches envelopes from it,
 * so a raw send by channel name reaches nobody. Every link either side of it
 * read as correct — main logged the send, `present:show` is declared in the IPC
 * contract, ChatApp subscribes, and the card renders unconditionally on a
 * non-empty store — which is exactly why this took a live store read to find:
 * presenting a file showed no card and opened no canvas tab, silently.
 */
const events = createIpcEventSender<AppEventMap>();
const run = promisify(execFile);

/** Head of a text preview — enough to judge, small enough not to flood context. */
const TEXT_HEAD_CHARS = 2_000;
/** A script that hangs must not hang the turn. */
const RUN_TIMEOUT_MS = 20_000;

let server: net.Server | null = null;
let socketPath = '';
let token = '';
let getWindow: (() => WebContents | null) | null = null;
let renderPage: ((filePath: string) => Promise<PageShot | null>) | null = null;
let renderSvg: ((filePath: string) => Promise<string | null>) | null = null;
let renderSheet:
  | ((files: readonly string[]) => Promise<{ png: string; blank: readonly string[] } | null>)
  | null = null;
let renderDiagram: ((req: DiagramRenderRequest) => Promise<DiagramRenderReply>) | null = null;

interface Request {
  id: number;
  token: string;
  method: string;
  params?: { path?: string; note?: string; kind?: string; width?: number } & Partial<
    Omit<DiagramRenderRequest, 'title'> & { title: string }
  >;
}

/** The most pixels a `pixels` reply carries per side (a palette needs few). */
const PIXELS_MAX_SIDE = 96;

/**
 * A small decoded copy of an image, for the `chart` tool's "style it like this
 * picture": Chromium decodes every format the user could drop in (PNG, JPEG,
 * WebP, GIF, HEIC…), and a 64-px thumbnail is all a palette needs. RGBA, so
 * the reader never has to know the platform's byte order.
 */
export async function decodePixels(
  target: string,
  width = 64,
): Promise<{ width: number; height: number; rgba: string } | { error: string }> {
  const image = nativeImage.createFromPath(target);
  if (image.isEmpty()) return { error: `${target} could not be decoded as an image` };
  const side = Math.max(8, Math.min(PIXELS_MAX_SIDE, Math.round(width)));
  const size = image.getSize();
  const scale = side / Math.max(size.width, size.height, 1);
  const small = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: 'good',
  });
  const { width: w, height: h } = small.getSize();
  // toBitmap is BGRA on every platform Electron ships; swap to RGBA here.
  const bgra = small.toBitmap();
  const rgba = Buffer.alloc(bgra.length);
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2] as number;
    rgba[i + 1] = bgra[i + 1] as number;
    rgba[i + 2] = bgra[i] as number;
    rgba[i + 3] = bgra[i + 3] as number;
  }
  return { width: w, height: h, rgba: rgba.toString('base64') };
}

/**
 * Entry point → the command that OPENS it, and what to say when that command is
 * missing.
 *
 * The user, on a presented Godot project: "I can't as the user go and see the run
 * even primitively following its instructions going to the folder and the file
 * and pressing f5, won't do anything. it hasn't installed godot or looked for an
 * installation or run any visual tests."
 *
 * A project the user cannot open is not finished, and "the files exist" is not
 * evidence that they can. So presenting a folder now REPORTS whether the thing
 * that runs it is actually on this machine. `null` means the entry point needs
 * nothing installed (a browser opens an HTML file).
 */
const ENTRY_POINTS: ReadonlyArray<{ file: string; runtime: string | null; what: string }> = [
  { file: 'project.godot', runtime: 'godot', what: 'Godot' },
  { file: 'index.html', runtime: null, what: 'a browser' },
  { file: 'package.json', runtime: 'node', what: 'Node' },
  { file: 'Cargo.toml', runtime: 'cargo', what: 'Rust/Cargo' },
  { file: 'main.py', runtime: 'python3', what: 'Python' },
  { file: 'README.md', runtime: null, what: 'nothing (it is a document)' },
];

/** Is `cmd` on PATH? Cheap, and the answer decides whether a project is openable. */
async function hasRuntime(cmd: string): Promise<boolean> {
  try {
    await run('sh', ['-lc', `command -v ${cmd}`], { timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Describe a folder the way somebody deciding "does this work?" would want:
 * what is in it, and the file that makes it a project rather than a pile.
 */
export async function describeProject(
  dir: string,
  probe: (cmd: string) => Promise<boolean> = hasRuntime,
): Promise<string> {
  const names = await readdir(dir);
  const entry = ENTRY_POINTS.find((e) => names.includes(e.file));
  const listed = names.slice(0, 40).sort();
  const more = names.length > listed.length ? ` (+${names.length - listed.length} more)` : '';
  const head = [`${dir} contains ${names.length} entries${more}:`, listed.join(', ')];
  if (entry === undefined) {
    head.push(
      'No recognisable entry point (no project.godot / index.html / package.json / main.py). ' +
        'A folder of files is not yet a project a user can open.',
    );
    return head.join('\n');
  }
  head.push(`Entry point: ${entry.file} — opened with ${entry.what}.`);
  if (entry.runtime !== null && !(await probe(entry.runtime))) {
    head.push(
      `BUT ${entry.what} IS NOT INSTALLED on this machine (\`${entry.runtime}\` is not on PATH), ` +
        'so the user cannot open this and neither can you. You have not verified that any of it ' +
        'works. Either install it, or say plainly in your reply that the project is written but ' +
        'unopenable here and what they need — do NOT describe it as finished and working.',
    );
  }
  return head.join('\n');
}

/**
 * Render a Godot project and return a PNG of what it actually draws, or null.
 *
 * NOT a screen capture. `screencapture` needs Screen Recording permission this
 * process does not have ("could not create image from display"), and a live
 * Godot window is the hang that wedged two runs. Instead Godot renders the game
 * itself: `--write-movie` with `--quit-after` runs a fixed number of frames,
 * writes them, and EXITS on its own — no permission, no window to leak, no
 * timeout needed. ffmpeg then lifts one late frame, late enough that the first
 * frame's half-initialised state is not what gets judged.
 *
 * Verified end to end on a known-good project before being trusted here.
 */
async function captureGodotFrame(dir: string): Promise<string | null> {
  const { existsSync } = await import('node:fs');
  const { unlink } = await import('node:fs/promises');
  if (!existsSync(path.join(dir, 'project.godot'))) return null;
  const stem = path.join(tmpdir(), `pd-game-${randomBytes(4).toString('hex')}`);
  const movie = `${stem}.avi`;
  const frame = `${stem}.png`;
  try {
    await run(
      'godot',
      ['--path', dir, '--write-movie', movie, '--fixed-fps', '30', '--quit-after', '40'],
      { timeout: 90_000 },
    );
    await run(
      'ffmpeg',
      ['-loglevel', 'error', '-y', '-i', movie, '-vf', 'select=eq(n\\,35)', '-vframes', '1', frame],
      { timeout: 60_000 },
    );
    return (await readFile(frame)).toString('base64');
  } catch {
    return null;
  } finally {
    await unlink(movie).catch(() => {});
    await unlink(frame).catch(() => {});
  }
}

/** An animated PNG as six moments on one strip, with when each is — or null for a still. */
export function animationStrip(
  png: Buffer,
): { imageBase64: string; mimeType: string; text: string } | null {
  let m: ReturnType<typeof apngMoments>;
  try {
    m = apngMoments(png, 6);
  } catch {
    return null;
  }
  if (m === undefined) return null;
  const cells: Cell[] = [];
  for (const frame of m.frames) {
    const img = nativeImage.createFromBuffer(frame);
    if (img.isEmpty()) return null;
    const fit = img.getSize().width > 420 ? img.resize({ width: 420, quality: 'good' }) : img;
    const { width, height } = fit.getSize();
    cells.push({ data: fit.toBitmap(), width, height });
  }
  const sheet = composeGrid(cells, { cols: 3, gap: 8, background: [40, 40, 44] });
  const strip = nativeImage.createFromBitmap(sheet.data, {
    width: sheet.width,
    height: sheet.height,
  });
  const when = m.at.map((t) => `${t.toFixed(1)} s`).join(', ');
  return {
    imageBase64: strip.toPNG().toString('base64'),
    mimeType: 'image/png',
    text:
      `An animation: ${m.total} frames, ${m.seconds.toFixed(1)} s. The capture shows ` +
      `${m.frames.length} moments of it — left to right, then down: ${when}.`,
  };
}

/** Produce the preview for one artefact. Pure-ish; the renderer is injected. */
/** How much of an SVG's source rides beside its picture. */
const SVG_SOURCE_HEAD = 900;

/*
 * A FOLDER OF PICTURES IS SHOWN AS ITS PICTURES. MEASURED (4B, the visual
 * suite's icon set): the model wrote six SVG icons into assets/icons and
 * presented the folder — and was handed a listing, "contains 6 entries:
 * difficulty.svg, favourite.svg, …". It could not see one of the icons it was
 * asked to make match. A folder that is mostly pictures now comes back as one
 * sheet of them, each captioned with its name, in name order.
 */
const PICTURE_EXT = /\.(?:svg|png|jpe?g|webp|gif)$/i;
/** The most pictures one sheet shows; the text says when there are more. */
export const MAX_SHEET_PICTURES = 12;

/** The pictures a folder is made of, in name order — or null when it is not a folder of pictures. */
export async function picturesOf(dir: string): Promise<string[] | null> {
  const names = (await readdir(dir)).filter((n) => !n.startsWith('.')).sort();
  const pictures = names.filter((n) => PICTURE_EXT.test(n));
  if (pictures.length < 2 || pictures.length * 2 < names.length) return null;
  return pictures.map((n) => path.join(dir, n));
}

/** The sheet as a page: each picture in a cell, its file name beneath it. */
export function pictureSheetHtml(items: readonly { name: string; src: string }[]): {
  html: string;
  width: number;
  height: number;
  /** Where each picture is drawn, in page pixels, in the order given. */
  boxes: { x: number; y: number; width: number; height: number }[];
} {
  const cols = items.length <= 4 ? items.length : items.length <= 9 ? 3 : 4;
  const rows = Math.ceil(items.length / cols);
  const cell = 264;
  const gap = 20;
  const caption = 22;
  const width = cols * cell + (cols + 1) * gap;
  const height = rows * (cell + caption) + (rows + 1) * gap;
  const esc = (t: string): string =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const cells = items
    .map(
      (it) =>
        `<figure><div><img src="${it.src}"></div><figcaption>${esc(it.name)}</figcaption></figure>`,
    )
    .join('');
  const side = Math.round(cell * 0.72);
  const boxes = items.map((_, i) => ({
    x: gap + (i % cols) * (cell + gap) + Math.round((cell - side) / 2),
    y: gap + Math.floor(i / cols) * (cell + caption + gap) + Math.round((cell - side) / 2),
    width: side,
    height: side,
  }));
  const html = `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;background:#f2f2f4;font:13px -apple-system,Helvetica,sans-serif;color:#3a3a3c"><style>
  main { display: grid; grid-template-columns: repeat(${cols}, ${cell}px); gap: ${gap}px; padding: ${gap}px; }
  figure { margin: 0; }
  figure div { width: ${cell}px; height: ${cell}px; background: #fff; border-radius: 10px; display: grid; place-items: center; box-shadow: 0 0 0 1px #0000001a; }
  img { width: ${side}px; height: ${side}px; object-fit: contain; }
  figcaption { height: ${caption}px; line-height: ${caption}px; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style><main>${cells}</main></body></html>`;
  return { html, width, height, boxes };
}

export async function buildPreview(
  target: string,
  kind: string,
  deps: {
    renderPage?: ((p: string) => Promise<PageShot | null>) | null;
    /** Draw an SVG file to a PNG (base64) — how the model sees what it drew. */
    renderSvg?: ((p: string) => Promise<string | null>) | null;
    /** Injected for tests; default is the live office-manager capture. */
    captureOffice?: (p: string) => Promise<string | null>;
    /** Draw a folder's pictures as one captioned sheet: the PNG (base64), and which drew nothing. */
    renderSheet?:
      | ((files: readonly string[]) => Promise<{ png: string; blank: readonly string[] } | null>)
      | null;
  } = {},
): Promise<{ imageBase64?: string; mimeType?: string; text?: string; error?: string }> {
  try {
    switch (kind) {
      case 'image': {
        const buf = await readFile(target);
        const ext = path.extname(target).toLowerCase();
        const mime =
          ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.svg'
              ? 'image/svg+xml'
              : 'image/png';
        /*
         * AN SVG IS SHOWN AS WHAT IT DRAWS. It used to go back as its source
         * text ("an SVG is text to a vision model") — so a model that presented
         * its icon set, or OmniSVG's lighthouse, never saw a single drawing and
         * could not tell a lens from a heart. The user (2026-09-24): "I feel like
         * there's something wrong with omnisvg or maybe just how it's used".
         * Rendered on a neutral ground, with the head of the source beside it so
         * a fix can name the element it means.
         */
        if (ext === '.svg') {
          const source = buf.toString('utf8').slice(0, SVG_SOURCE_HEAD);
          const drawn = await deps.renderSvg?.(target);
          return drawn === null || drawn === undefined
            ? { text: buf.toString('utf8').slice(0, TEXT_HEAD_CHARS) }
            : {
                imageBase64: drawn,
                mimeType: 'image/png',
                text: `The drawing above, on a light grey ground. Its source begins:\n${source}`,
              };
        }
        /*
         * AN ANIMATION IS SHOWN AS ITS MOMENTS. A decoder shows an APNG's frame
         * 0 — MEASURED (the suite's channel intro): an empty card before the
         * title bounced in, sent whole (14 MB), and described by the model as
         * "the title bouncing playfully". Six moments across it, in one strip.
         */
        const moments = ext === '.png' ? animationStrip(buf) : null;
        if (moments !== null) return moments;
        return { imageBase64: buf.toString('base64'), mimeType: mime };
      }
      case 'render': {
        const shot = await deps.renderPage?.(target);
        if (shot === null || shot === undefined) {
          return { error: 'the page could not be rendered here' };
        }
        // What the picture cannot show: a script that threw, a file that 404'd.
        return {
          imageBase64: shot.png,
          mimeType: 'image/png',
          ...(shot.problems.length > 0
            ? {
                text:
                  'While it loaded, the page reported:\n' +
                  shot.problems.map((p) => `- ${p}`).join('\n'),
              }
            : {}),
        };
      }
      case 'run': {
        const ext = path.extname(target).toLowerCase();
        const cmd =
          ext === '.py' ? 'python3' : ext === '.sh' ? 'bash' : ext === '.ts' ? 'npx' : 'node';
        const args = ext === '.ts' ? ['tsx', target] : [target];
        const { stdout, stderr } = await run(cmd, args, { timeout: RUN_TIMEOUT_MS });
        const out = `${stdout}${stderr}`.trim();
        return {
          text:
            out.length > 0
              ? `Running it printed:\n${out.slice(0, TEXT_HEAD_CHARS)}`
              : 'Running it printed nothing at all.',
        };
      }
      case 'project': {
        /*
         * A GAME IS SHOWN, NOT DESCRIBED.
         *
         * The user's standard for "verified": "did it attempt to get a screenshot or
         * compile and run the project at all? if it did that and got and read a
         * screenshot, then i'm willing to concede a model failure, short of
         * that, I disagree." Listing files never met it — a folder listing
         * cannot tell you the player is off-screen or the level is empty.
         *
         * So a runnable project is RUN and photographed, and the model gets the
         * frame back. Falls through to the description when there is nothing to
         * run or the run produced no picture.
         */
        const described = await describeProject(target);
        const frame = await captureGodotFrame(target);
        if (frame !== null) {
          return { imageBase64: frame, mimeType: 'image/png', text: described };
        }
        const pictures = await picturesOf(target).catch(() => null);
        if (pictures !== null && deps.renderSheet !== undefined && deps.renderSheet !== null) {
          const shown = pictures.slice(0, MAX_SHEET_PICTURES);
          const sheet = await deps.renderSheet(shown).catch(() => null);
          if (sheet !== null) {
            const more =
              pictures.length > shown.length
                ? ` (the first ${shown.length} of ${pictures.length})`
                : '';
            /* A picture that draws nothing, named — MEASURED: the suite's six
               icons nested their shapes inside a <path>, which draws none of
               them, and were handed over as "six matching line icons". */
            const blank =
              sheet.blank.length === 0
                ? ''
                : `\nDRAWN EMPTY — nothing shows in its cell: ${sheet.blank.join(', ')}. Open the file and see why before you hand it over.`;
            return {
              imageBase64: sheet.png,
              mimeType: 'image/png',
              text: `${described}\nThe capture shows its pictures${more}, each named beneath it, in name order — left to right, then down.${blank}`,
            };
          }
        }
        return { text: described };
      }
      case 'office': {
        /*
         * A DOCUMENT IS SHOWN, NOT DESCRIBED — the same standard as a game.
         * `show` has just asked the renderer to open the file in the canvas's
         * office editor; this waits for that editor to draw and hands back its
         * capture, which is exactly what the user is looking at. Without it a
         * deck was "104 KB, .pptx" to the model that made it.
         */
        /*
         * …AND ALL OF IT, WIDE. The canvas photograph is only what a narrow
         * pane shows — MEASURED, slide 1 of 8 at 29% zoom, a workbook's first
         * three columns — so the look is taken on an editor of its own at a
         * landscape size: every slide of a deck on one sheet, a workbook or
         * document opened wide (office-look.ts). The canvas photograph is the
         * fallback when that editor will not draw.
         */
        const look =
          deps.captureOffice === undefined ? await officeLook(target).catch(() => null) : null;
        const capture = deps.captureOffice ?? captureViewForFile;
        const dataUrl = look?.dataUrl ?? (await capture(target));
        const st = await stat(target);
        const size = `${target} — ${Math.max(1, Math.round(st.size / 1024))} KB.`;
        if (dataUrl === null) {
          return { text: `${size} It is open in the canvas, but no capture could be taken yet.` };
        }
        const comma = dataUrl.indexOf(',');
        return {
          imageBase64: dataUrl.slice(comma + 1),
          mimeType: 'image/png',
          text: `${size} ${look?.note ?? 'The capture is the first page/slide as the canvas shows it.'}`,
        };
      }
      case 'text': {
        const body = await readFile(target, 'utf8');
        return {
          text:
            body.trim().length === 0
              ? 'The file is EMPTY.'
              : `It contains:\n${body.slice(0, TEXT_HEAD_CHARS)}`,
        };
      }
      default: {
        const st = await stat(target);
        return { text: `${target} — ${st.size} bytes. Nothing here can open this format.` };
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** A diagram request as it arrived over the socket — checked, never trusted. */
function diagramRequest(params: Request['params']): DiagramRenderRequest | null {
  const p = params ?? {};
  if (typeof p.source !== 'string' || p.themes === undefined) return null;
  const { light, dark } = p.themes as { light?: unknown; dark?: unknown };
  if (typeof light !== 'object' || light === null || typeof dark !== 'object' || dark === null) {
    return null;
  }
  return {
    source: p.source,
    ...(typeof p.title === 'string' ? { title: p.title } : {}),
    ...(typeof p.subtitle === 'string' ? { subtitle: p.subtitle } : {}),
    themes: p.themes,
  };
}

async function handle(req: Request): Promise<Record<string, unknown>> {
  /*
   * A DIAGRAM IS DRAWN HERE because only the app has a browser: the harness
   * sends the model's Mermaid and the kit's themes, gen/diagram-render.ts lays
   * it out in a hidden window and hands both drawings back (VQ-10). It has no
   * file yet, so it comes before the path check the other methods share.
   */
  if (req.method === 'diagram') {
    const request = diagramRequest(req.params);
    if (request === null) return { ok: false, error: 'a diagram needs its source and themes' };
    if (renderDiagram === null) return { ok: false, error: 'the diagram renderer is not running' };
    return { ...(await renderDiagram(request)) };
  }
  const target = typeof req.params?.path === 'string' ? req.params.path : '';
  if (target === '') return { error: 'no path' };

  if (req.method === 'show') {
    const wc = getWindow?.() ?? null;
    if (wc === null || wc.isDestroyed()) return { ok: false, error: 'no Bobble window' };
    // The renderer renders the card — and for a chart or a small SVG, the
    // thing itself, inline (present-inline.ts); the rest opens in the canvas.
    const inline = await presentInlinePayload(target);
    events.send(wc, 'present:show', { path: target, note: req.params?.note, ...inline });
    log.info('presented', {
      path: target,
      chart: inline.chart !== undefined,
      diagram: inline.diagram !== undefined,
      svg: inline.svg !== undefined ? `${inline.svg.width}x${inline.svg.height}` : undefined,
      html: inline.html !== undefined ? inline.html.text.length : undefined,
    });
    return { ok: true };
  }
  if (req.method === 'pixels') {
    return await decodePixels(target, req.params?.width);
  }
  if (req.method === 'preview') {
    const preview = await buildPreview(target, req.params?.kind ?? 'describe', {
      renderPage,
      renderSvg,
      renderSheet,
    });
    /*
     * A PREVIEW THE MODEL CANNOT SEE IS WORSE THAN NO PREVIEW.
     *
     * Presented an HTML file on a text-only server, the model answered: "I'm in
     * text-only mode right now so I cannot view or analyze the image preview
     * that was attached. To see the actual visual content of the rendered page,
     * you'll need to have vision enabled." It said that TO THE USER, about a
     * capability this app owns and can turn on.
     *
     * The mechanism already existed and `present` was simply not attached to it:
     * an image produced while the server cannot see records a want, and the
     * turn boundary spends it (see inference/vision-want.ts — going multimodal
     * is a hard restart, so firing it here would kill the turn that just
     * rendered). Same call the browser agent makes for a screenshot, for exactly
     * the same reason.
     */
    if (preview.imageBase64 !== undefined && !getInferenceVisionReady()) {
      wantVision();
    }
    diagSavePreview(target, preview);
    return preview;
  }
  return { error: `unknown method: ${req.method}` };
}

/**
 * PD_DIAG_PRESENT_DIR=<dir>: every look `present` hands the model is also
 * written there, so a probe can show what the MODEL saw — not what the canvas
 * shows the person. (The blank-page capture was invisible from both ends.)
 */
function diagSavePreview(
  target: string,
  preview: { imageBase64?: string; mimeType?: string },
): void {
  const dir = process.env.PD_DIAG_PRESENT_DIR;
  if (dir === undefined || dir === '' || preview.imageBase64 === undefined) return;
  const ext = preview.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const name = `${Date.now()}-${path.basename(target).replace(/[^\w.-]/g, '_')}.${ext}`;
  void mkdir(dir, { recursive: true })
    .then(() => writeFile(path.join(dir, name), Buffer.from(preview.imageBase64 ?? '', 'base64')))
    .catch(() => {});
}

function onConnection(socket: net.Socket): void {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const nl = buffer.indexOf('\n');
    if (nl === -1) return;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      socket.write(`${JSON.stringify({ error: 'bad request' })}\n`);
      return;
    }
    if (req.token !== token) {
      socket.write(`${JSON.stringify({ error: 'unauthorized' })}\n`);
      return;
    }
    void handle(req)
      .then((res) => socket.write(`${JSON.stringify(res)}\n`))
      .catch((err) =>
        socket.write(
          `${JSON.stringify({ error: String(err instanceof Error ? err.message : err) })}\n`,
        ),
      );
  });
  socket.on('error', () => socket.destroy());
}

/** Start the bridge. `render` captures an HTML file and returns base64 PNG. */
export function registerPresentBridge(deps: {
  getWindow: () => WebContents | null;
  renderPage?: (filePath: string) => Promise<PageShot | null>;
  /** Draw an SVG file to a base64 PNG, for the model's look at a drawing. */
  renderSvg?: (filePath: string) => Promise<string | null>;
  /** A folder's pictures on one captioned sheet (base64 PNG), and which drew nothing. */
  renderSheet?: (
    files: readonly string[],
  ) => Promise<{ png: string; blank: readonly string[] } | null>;
  renderDiagram?: (req: DiagramRenderRequest) => Promise<DiagramRenderReply>;
}): void {
  getWindow = deps.getWindow;
  renderPage = deps.renderPage ?? null;
  renderSvg = deps.renderSvg ?? null;
  renderSheet = deps.renderSheet ?? null;
  renderDiagram = deps.renderDiagram ?? null;
  token = randomBytes(16).toString('hex');
  socketPath = path.join(
    tmpdir(),
    `pi-present-${process.pid}-${randomBytes(4).toString('hex')}.sock`,
  );
  server = net.createServer(onConnection);
  // Published on the MAIN process env so every pi child inherits it through
  // buildPiEnv — same mechanism as the subagent and gen3d bridges, and it must
  // happen BEFORE the first spawn or the harness sees no bridge.
  process.env.PI_DESKTOP_PRESENT_SOCK = socketPath;
  process.env.PI_DESKTOP_PRESENT_TOKEN = token;
  server.listen(socketPath, () => log.info('present bridge live', { socketPath }));
}

export function disposePresentBridge(): void {
  server?.close();
  server = null;
}

/** Env published to every pi child so `present` can find the bridge. */
export function presentBridgeEnv(): { sock?: string; token?: string } {
  if (server === null) return {};
  return { sock: socketPath, token };
}
