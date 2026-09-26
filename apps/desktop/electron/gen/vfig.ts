/**
 * VFIG, RUN — a figure to SVG code, a description to SVG code, or an SVG
 * edited — one short-lived server per job, as OmniSVG runs (omnisvg.ts).
 *
 * Where OmniSVG draws a picture as coloured paths, VFIG writes the file a
 * person would: `<text>` for every label, `<rect>` and `<line>` and arrows —
 * so a diagram, a chart or a labelled physics figure comes back with its words
 * and can be edited afterwards (gen-service vfig-request.ts has the evidence).
 *
 * NO TOKEN LIMIT (the user: "remove token limit on vfig so it doesn't fail complex
 * tasks outright" — two 48-icon grids ran out of 8,192 tokens mid-file in the
 * bake-off). The reply runs until the model ends the file or the context is
 * full: 32k tokens with the cache at q8_0 (~2.3 GB for this 4B, where f16
 * would be 4.6). A reply that starts repeating itself is cut where the first
 * copy began and closed into a valid file; so is one the context stopped.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  buildVfigRequest,
  svgFromText,
  textLoopStart,
  type VfigInput,
} from '@pi-desktop/gen-service';
import { cacheRoot, ensureLlamaCpp, libraryRoot } from '@pi-desktop/inference';
import { createLogger } from '@pi-desktop/shared';

const log = createLogger('desktop:vfig');

const GGUF = 'VFIG-4B-UD-Q6_K_XL.gguf';
const MMPROJ = 'mmproj-VFIG-4B-F16.gguf';
/** The context a reply may fill — the only bound on its length. */
const VFIG_CONTEXT = 32_768;

export interface VfigParams {
  readonly prompt?: string;
  /** Figures (paths) to turn into SVG. Each becomes its own file. */
  readonly images?: readonly string[];
  /** An SVG to change, and what to change (`prompt` is the instruction). */
  readonly edit?: string;
  readonly outputDir: string;
  /** The model's own destination (fenced to the working folder by the tool). */
  readonly outPath?: string;
  readonly signal?: AbortSignal;
  /**
   * A figure as VFIG should see it — on white, at most 1,600 px (gen-service
   * `figurePicture`) — as base64 PNG. Handed in by the IPC wiring; without it
   * the file goes as it is.
   */
  readonly figure?: (file: Buffer) => string;
}

export interface VfigPartial {
  readonly svg: string;
  /** Elements drawn so far. */
  readonly paths: number;
  readonly candidate: number;
  readonly candidates: number;
  readonly source: string;
}

export interface VfigOutput {
  readonly outputPath: string;
  readonly paths: number;
  readonly source: string;
  /** eos, loop (cut where it began repeating), or length (the context ran out). */
  readonly stop: string;
  readonly complete: boolean;
  readonly tokPerSec: number | null;
  readonly tokens: number;
}

/** The model's files — the models library first, then where the bake-off made them. */
export function vfigFiles(): { gguf: string; mmproj: string; ready: boolean; missing: string[] } {
  const dirs = [
    path.join(libraryRoot(), 'Image', 'Vector', 'VFIG', 'gguf'),
    path.join(cacheRoot(), 'svg-bakeoff'),
  ];
  const states = dirs.map((dir) => {
    const gguf = path.join(dir, GGUF);
    const mmproj = path.join(dir, MMPROJ);
    const missing = [gguf, mmproj].filter((f) => !existsSync(f));
    return { gguf, mmproj, ready: missing.length === 0, missing };
  });
  return states.find((s) => s.ready) ?? (states[0] as (typeof states)[number]);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port')),
      );
    });
  });
}

async function waitHealthy(base: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok && ((await r.json()) as { status?: string }).status === 'ok') return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('VFIG server did not come up in time');
}

/** Elements in an SVG — how much of the drawing there is. */
const countElements = (svg: string): number =>
  (svg.match(/<(path|rect|circle|ellipse|line|polyline|polygon|text|image|use)\b/g) ?? []).length;

const PARTIAL_EVERY_MS = 250;
/** How often (in new characters) the tail is checked for a loop. */
const LOOP_CHECK_CHARS = 1200;

/**
 * One streamed reply: its text, and how it ended. A loop cuts the stream at
 * once (the server is hung up on, which stops it) and keeps what came before.
 */
export async function streamVfig(
  base: string,
  input: VfigInput,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<
  { text: string; stop: string; tokens: number; tokPerSec: number | null } | { error: string }
> {
  const cut = new AbortController();
  const stopAll = () => cut.abort();
  signal?.addEventListener('abort', stopAll, { once: true });
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildVfigRequest(input, true)),
      signal: cut.signal,
    });
  } catch (err) {
    signal?.removeEventListener('abort', stopAll);
    if (signal?.aborted === true) throw new Error('the drawing was stopped');
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok || res.body === null) return { error: `llama-server answered ${res.status}` };
  let text = '';
  let checked = 0;
  let stop = 'unknown';
  let tokens = 0;
  let tokPerSec: number | null = null;
  let looped = -1;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    const json = line.slice(5).trim();
    if (json === '' || json === '[DONE]') return;
    let chunk: {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      timings?: { predicted_per_second?: number; predicted_n?: number };
    };
    try {
      chunk = JSON.parse(json);
    } catch {
      return;
    }
    const c = chunk.choices?.[0];
    if (typeof c?.delta?.content === 'string') {
      text += c.delta.content;
      tokens += 1;
      if (text.length - checked >= LOOP_CHECK_CHARS) {
        checked = text.length;
        const at = textLoopStart(text);
        if (at >= 0) {
          looped = at;
          cut.abort();
          return;
        }
      }
      onText(text);
    }
    if (typeof c?.finish_reason === 'string')
      stop = c.finish_reason === 'stop' ? 'eos' : c.finish_reason;
    if (typeof chunk.timings?.predicted_per_second === 'number')
      tokPerSec = chunk.timings.predicted_per_second;
    if (typeof chunk.timings?.predicted_n === 'number') tokens = chunk.timings.predicted_n;
  };
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (err) {
        if (looped >= 0) break;
        if (signal?.aborted === true) throw new Error('the drawing was stopped');
        throw err;
      }
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1 && looped < 0) {
        take(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      if (looped >= 0) break;
    }
  } finally {
    signal?.removeEventListener('abort', stopAll);
  }
  if (looped >= 0) return { text: text.slice(0, looped), stop: 'loop', tokens, tokPerSec };
  if (buffer.trim() !== '') take(buffer.trim());
  return { text, stop, tokens, tokPerSec };
}

export async function generateVfigSvg(
  params: VfigParams,
  onPartial?: (partial: VfigPartial) => void,
): Promise<{ outputs: VfigOutput[] }> {
  const files = vfigFiles();
  if (!files.ready) {
    throw new Error(
      `VFIG is not installed (missing ${files.missing.map((f) => path.basename(f)).join(', ')}).`,
    );
  }
  const images = params.images ?? [];
  const prompt = params.prompt?.trim() ?? '';
  const jobs: Array<{ source: string; input: VfigInput; editOf?: string }> = [];
  if (params.edit !== undefined) {
    if (prompt === '') throw new Error('an edit needs its instruction — what to change');
    jobs.push({
      source: path.basename(params.edit),
      input: { svg: await readFile(params.edit, 'utf8'), instruction: prompt },
      editOf: params.edit,
    });
  } else {
    for (const img of images) {
      const file = await readFile(img);
      jobs.push({
        source: path.basename(img),
        input: { imageBase64: params.figure?.(file) ?? file.toString('base64') },
      });
    }
    if (images.length === 0) {
      if (prompt === '')
        throw new Error('give a description, a figure to convert, or an SVG to edit');
      jobs.push({ source: 'prompt', input: { prompt } });
    }
  }

  const { serverPath } = await ensureLlamaCpp();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = [
    '-m',
    files.gguf,
    '--mmproj',
    files.mmproj,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    String(VFIG_CONTEXT),
    '-ctk',
    'q8_0',
    '-ctv',
    'q8_0',
    '-ngl',
    '99',
    '--parallel',
    '1',
    '--no-warmup',
  ];
  log.info('vfig server starting', { port, jobs: jobs.length });
  const child = spawn(serverPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr: string[] = [];
  child.stderr?.on('data', (d: Buffer) => {
    stderr.push(d.toString());
    if (stderr.length > 40) stderr.shift();
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const onStop = () => child.kill('SIGTERM');
  if (params.signal?.aborted === true) onStop();
  else params.signal?.addEventListener('abort', onStop, { once: true });

  await mkdir(params.outputDir, { recursive: true });
  const outputs: VfigOutput[] = [];
  try {
    await Promise.race([
      waitHealthy(base, 90_000),
      exited.then(() => {
        throw new Error(`VFIG server exited: ${stderr.slice(-5).join('').trim()}`);
      }),
    ]);
    let n = 0;
    for (const job of jobs) {
      if (params.signal?.aborted === true) throw new Error('the drawing was stopped');
      let last = 0;
      const run = await streamVfig(
        base,
        job.input,
        (text) => {
          const now = Date.now();
          if (onPartial === undefined || now - last < PARTIAL_EVERY_MS) return;
          last = now;
          const { svg } = svgFromText(text);
          if (svg !== null)
            onPartial({
              svg,
              paths: countElements(svg),
              candidate: 1,
              candidates: 1,
              source: job.source,
            });
        },
        params.signal,
      );
      if ('error' in run) throw new Error(run.error);
      const { svg, complete } = svgFromText(run.text);
      if (svg === null) {
        log.warn('vfig wrote no svg', { source: job.source, head: run.text.slice(0, 200) });
        continue;
      }
      n += 1;
      const generated = path.join(params.outputDir, `${String(n).padStart(2, '0')}.svg`);
      await writeFile(generated, svg, 'utf8');
      let outputPath = generated;
      if (job.editOf !== undefined) {
        // A finished edit replaces the file; one cut short sits beside it, the original untouched.
        outputPath = complete ? job.editOf : job.editOf.replace(/\.svg$/i, '-edited.svg');
        await writeFile(outputPath, svg, 'utf8');
      } else if (params.outPath !== undefined) {
        outputPath =
          jobs.length === 1
            ? params.outPath
            : path.join(params.outPath, `${String(n).padStart(2, '0')}.svg`);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, svg, 'utf8');
      }
      outputs.push({
        outputPath,
        paths: countElements(svg),
        source: job.source,
        stop: run.stop,
        complete,
        tokPerSec: run.tokPerSec,
        tokens: run.tokens,
      });
      log.info('vfig drew', { source: job.source, stop: run.stop, complete, tokens: run.tokens });
    }
  } finally {
    params.signal?.removeEventListener('abort', onStop);
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  return { outputs };
}
