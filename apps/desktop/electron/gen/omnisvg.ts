/**
 * OMNISVG, RUN — text/image → SVG, one server per job.
 *
 * The model is a GGUF in the ordinary models directory (catalog id
 * `omnisvg-1.1-4b`, `purpose: 'svg'`), so it downloads like any other model and
 * never appears as one to talk to. A job starts the app's own llama-server on
 * that file (5s on this machine — MEASURED), asks it for token ids, decodes
 * them with `decodeOmniSvg`, writes the file, and stops the server.
 *
 * One server per job rather than a second resident model, deliberately: the
 * chat model already owns the machine's single serious slot, and an SVG is
 * seconds of work. The mmproj is loaded only when an image is given — text
 * jobs never pay for a vision tower they will not use.
 *
 * Several candidates are sampled and the best kept, as the authors' pipeline
 * does: a sample can wander (MEASURED: a stray text token among the SVG ids),
 * and the one that decoded to the most paths and stopped on eos is the one a
 * person would have picked.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  buildOmniSvgRequest,
  decodeOmniSvg,
  decodeOmniSvgPartial,
  type Extent,
  idsFromCompletion,
  loopStart,
  MEDIA_MARKER,
  pickScore,
} from '@pi-desktop/gen-service';
import {
  cacheRoot,
  ensureLlamaCpp,
  getCatalogModel,
  libraryRoot,
  modelDir,
} from '@pi-desktop/inference';
import { createLogger } from '@pi-desktop/shared';

const log = createLogger('desktop:omnisvg');

export const OMNISVG_MODEL_ID = 'omnisvg-1.1-4b';

export interface OmniSvgParams {
  readonly prompt?: string;
  /** Reference images (paths). Each becomes its own SVG. */
  readonly images?: readonly string[];
  /** Candidates per input; the best is kept. Default 3. */
  readonly candidates?: number;
  /** Where the numbered files land (Generated/<slug>/01.svg …). */
  readonly outputDir: string;
  /**
   * Stops the drawing: the server is killed, the stream ends, and the call
   * throws. The chat that asked for it was deleted (the user, 2026-09-23).
   */
  readonly signal?: AbortSignal;
  /**
   * The model's own destination — a site's `assets/logo.svg`. Already fenced
   * to the working folder by the tool. One input: this exact file; several:
   * a folder holding 01.svg, 02.svg …. The Generated copy is still written, so
   * the drawing is on the canvas and in the gallery either way.
   */
  readonly outPath?: string;
  /**
   * A reference image as OmniSVG was fine-tuned to see it — on white, square,
   * 448 × 448 (gen-service `omniSvgPicture`) — as base64 PNG. Handed in by the
   * IPC wiring, because the decoder (`nativeImage`) exists only in main; without
   * it the file goes as it is.
   */
  readonly picture?: (file: Buffer) => { readonly base64: string; readonly box: Extent | null };
}

/**
 * The drawing as it is being drawn — the finished shapes plus an outline of the
 * one in progress (decodeOmniSvgPartial), a few times a second while the ids
 * stream in. `candidate` counts the samples: each starts a fresh drawing, and
 * the best of them is what lands on disk.
 */
export interface OmniSvgPartial {
  readonly svg: string;
  readonly paths: number;
  readonly candidate: number;
  readonly candidates: number;
  /** "prompt", or the reference image's file name. */
  readonly source: string;
}

export interface OmniSvgOutput {
  readonly outputPath: string;
  readonly paths: number;
  /** "prompt", or the reference image's file name. */
  readonly source: string;
  readonly stop: string;
  readonly tokPerSec: number | null;
  readonly tokens: number;
}

/** The model's files on disk, or what is missing — the connector's install state. */
/**
 * WHERE THE FILES MAY BE. The connector's download lands them in the catalog
 * folder (`modelDir`). The GGUFs converted on this Mac were placed by hand in
 * `<cache>/omnisvg/gguf`, and the library migration shelved that folder as
 * `Image/Vector/OmniSVG/gguf` with a link left behind — and neither is the
 * catalog folder, so `svg` reported "not installed" over 5 GB of weights that
 * were sitting on the shelf named for them. MEASURED 2026-09-15 by the tool
 * surface probe: `generate_svg` absent from the registry, `svg` absent from
 * `tools`. The first folder holding both files wins.
 */
export function omniSvgFiles(): {
  gguf: string;
  mmproj: string;
  ready: boolean;
  missing: string[];
} {
  const model = getCatalogModel(OMNISVG_MODEL_ID);
  const ggufName = model?.files[0]?.name ?? 'OmniSVG1.1_4B-Q8_0.gguf';
  const mmprojName = model?.mmproj?.name ?? 'mmproj-OmniSVG1.1_4B-F16.gguf';
  const dirs = [
    modelDir(OMNISVG_MODEL_ID),
    path.join(libraryRoot(), 'Image', 'Vector', 'OmniSVG', 'gguf'),
    path.join(cacheRoot(), 'omnisvg', 'gguf'),
  ];
  const states = dirs.map((dir) => {
    const gguf = path.join(dir, ggufName);
    const mmproj = path.join(dir, mmprojName);
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
      if (r.ok) {
        const j = (await r.json()) as { status?: string };
        if (j.status === 'ok') return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('OmniSVG server did not come up in time');
}

/** How often, at most, a partial drawing is decoded and handed on. */
const PARTIAL_EVERY_MS = 120;

/**
 * A sample that runs into a loop (loopStart) is cut there and does not count as
 * one of the candidates: another is drawn in its place, up to this many more.
 * MEASURED 2026-09-25: a quarter to a half of the samples looped, each burning
 * the full 1,536 ids (~22 s) on one repeated command of no length; cut at the
 * loop, one costs the few seconds before it.
 */
const LOOP_RETRIES = 3;

/**
 * One `/completion`, STREAMED: the ids as they arrive, so the caller can show
 * the drawing forming. llama-server sends `data: {…}` lines, each with the
 * chunk's `tokens` (return_tokens) and the last with `stop: true` and the
 * timings. Returns the same shape `idsFromCompletion` reads off a non-streamed
 * reply, so the decode below is unchanged — except that a sample caught in a
 * loop is hung up on (llama-server stops a streamed generation whose client has
 * gone) and comes back cut where the loop began, `stop: 'loop'`.
 */
export async function streamCompletion(
  base: string,
  body: ReturnType<typeof buildOmniSvgRequest>,
  onIds: (ids: readonly number[]) => void,
): Promise<{ ids: number[]; stop: string; tokPerSec: number | null } | { error: string }> {
  const cut = new AbortController();
  let looped = -1;
  const res = await fetch(`${base}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal: cut.signal,
  });
  if (!res.ok || res.body === null) {
    return { error: `llama-server answered ${res.status}` };
  }
  const ids: number[] = [];
  let stop = 'unknown';
  let tokPerSec: number | null = null;
  let error: string | undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const json = line.slice(5).trim();
    if (json === '' || json === '[DONE]') return;
    let chunk: {
      tokens?: unknown;
      stop?: unknown;
      stop_type?: unknown;
      timings?: { predicted_per_second?: unknown };
      error?: unknown;
    };
    try {
      chunk = JSON.parse(json);
    } catch {
      return;
    }
    if (chunk.error !== undefined) {
      error = `llama-server: ${JSON.stringify(chunk.error)}`;
      return;
    }
    if (Array.isArray(chunk.tokens) && chunk.tokens.length > 0) {
      for (const t of chunk.tokens) ids.push(Number(t));
      const at = loopStart(ids);
      if (at >= 0) {
        looped = at;
        cut.abort();
        return;
      }
      onIds(ids);
    }
    if (chunk.stop === true) {
      if (typeof chunk.stop_type === 'string') stop = chunk.stop_type;
      const tps = chunk.timings?.predicted_per_second;
      if (typeof tps === 'number') tokPerSec = tps;
    }
  };
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (looped >= 0) break;
      throw err;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1 && looped < 0) {
      take(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
    if (looped >= 0) break;
  }
  if (looped >= 0) return { ids: ids.slice(0, looped), stop: 'loop', tokPerSec };
  if (buffer.trim() !== '') take(buffer.trim());
  if (error !== undefined) return { error };
  return { ids, stop, tokPerSec };
}

export async function generateSvg(
  params: OmniSvgParams,
  onPartial?: (partial: OmniSvgPartial) => void,
): Promise<{ outputs: OmniSvgOutput[] }> {
  const files = omniSvgFiles();
  if (!files.ready) {
    throw new Error(
      `OmniSVG is not downloaded yet (missing ${files.missing.map((f) => path.basename(f)).join(', ')}). ` +
        'Install the OmniSVG connector first.',
    );
  }
  const images = params.images ?? [];
  const prompt = params.prompt?.trim() ?? '';
  if (prompt === '' && images.length === 0)
    throw new Error('give a prompt, a reference image, or both');

  const { serverPath } = await ensureLlamaCpp();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = [
    '-m',
    files.gguf,
    ...(images.length > 0 ? ['--mmproj', files.mmproj] : []),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    '4096',
    '-ngl',
    '99',
    '--parallel',
    '1',
  ];
  log.info('omnisvg server starting', { port, image: images.length > 0 });
  /*
   * THE PICTURE'S MARKER, PINNED. This llama-server makes a random media marker
   * per process (`<__media_<random>__>`, published in /props) unless
   * LLAMA_MEDIA_MARKER pins one, and a raw /completion prompt must carry that
   * exact marker. MEASURED 2026-09-25 (the SVG bake-off): with the picture sent
   * where the server reads it, every image request failed "number of media
   * markers in text (0) does not match number of bitmaps (1)"; pinned to the
   * builder's MEDIA_MARKER, the kinetic-theory figure went in (258 prompt tokens).
   */
  const child = spawn(serverPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, LLAMA_MEDIA_MARKER: MEDIA_MARKER },
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (d: Buffer) => {
    stderr.push(d.toString());
    if (stderr.length > 40) stderr.shift();
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  /* Stopping is killing the server: every fetch against it then fails, the
     race below throws, and `finally` reaps what is left. */
  const onStop = (): void => {
    child.kill('SIGTERM');
  };
  if (params.signal?.aborted === true) onStop();
  else params.signal?.addEventListener('abort', onStop, { once: true });

  await mkdir(params.outputDir, { recursive: true });
  const outputs: OmniSvgOutput[] = [];
  try {
    await Promise.race([
      waitHealthy(base, 90_000),
      exited.then(() => {
        throw new Error(`OmniSVG server exited: ${stderr.slice(-5).join('').trim()}`);
      }),
    ]);

    const candidates = Math.max(1, Math.min(6, params.candidates ?? 3));
    const jobs: Array<{
      source: string;
      body: ReturnType<typeof buildOmniSvgRequest>;
      /** Where the traced picture has ink — what a candidate is measured against. */
      target: Extent | null;
    }> = [];
    if (prompt !== '') {
      jobs.push({ source: 'prompt', body: buildOmniSvgRequest({ prompt }), target: null });
    }
    for (const img of images) {
      const file = await readFile(img);
      const ready = params.picture?.(file) ?? { base64: file.toString('base64'), box: null };
      jobs.push({
        source: path.basename(img),
        body: buildOmniSvgRequest({ imageBase64: ready.base64 }),
        target: ready.box,
      });
    }

    let n = 0;
    for (const job of jobs) {
      let best: (OmniSvgOutput & { svg: string; score: number }) | null = null;
      // `k` counts the samples that ran their course; one cut at a loop is drawn again.
      for (
        let k = 0, attempt = 0;
        k < candidates && attempt < candidates + LOOP_RETRIES;
        attempt++
      ) {
        if (params.signal?.aborted === true) throw new Error('the drawing was stopped');
        /*
         * STREAMED, so the drawing can be watched forming (the user: the thread
         * should show "the model streaming the svg … render live as drawing").
         * Decoding the whole prefix a few times a second is cheap — a file is
         * at most 1,536 ids — and every partial is exactly the shapes the
         * final file will have, plus an outline of the one in progress.
         */
        let lastPartialAt = 0;
        let lastPaths = -1;
        const parsed =
          onPartial === undefined
            ? await (async () => {
                const res = await fetch(`${base}/completion`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(job.body),
                });
                return idsFromCompletion(
                  (await res.json()) as Parameters<typeof idsFromCompletion>[0],
                );
              })()
            : await streamCompletion(base, job.body, (ids) => {
                const now = Date.now();
                if (now - lastPartialAt < PARTIAL_EVERY_MS) return;
                const partial = decodeOmniSvgPartial(ids);
                if (partial === null) return;
                // A tick with nothing new to show is not sent — the in-progress
                // outline changes with every command, so this only skips the
                // ticks between two ids of one command.
                if (partial.paths === lastPaths && !partial.drawing) return;
                lastPartialAt = now;
                lastPaths = partial.paths;
                onPartial({
                  svg: partial.svg,
                  paths: partial.paths,
                  candidate: k + 1,
                  candidates,
                  source: job.source,
                });
              });
        if ('error' in parsed) throw new Error(parsed.error);
        // The non-streamed reply ran its loop to the limit: cut it the same way.
        const at = parsed.stop === 'loop' ? -1 : loopStart(parsed.ids);
        const run = at >= 0 ? { ...parsed, ids: parsed.ids.slice(0, at), stop: 'loop' } : parsed;
        if (run.stop === 'loop') {
          log.info('omnisvg sample looped; cut and drawn again', {
            source: job.source,
            attempt: attempt + 1,
            kept: run.ids.length,
          });
        } else {
          k += 1;
        }
        const decoded = decodeOmniSvg(run.ids);
        if (decoded === null) continue;
        const cand = {
          outputPath: '',
          paths: decoded.paths,
          source: job.source,
          stop: run.stop,
          tokPerSec: run.tokPerSec,
          tokens: run.ids.length,
          svg: decoded.svg,
          score: pickScore({ stop: run.stop, extent: decoded.extent }, job.target),
        };
        /* Best = the one that covers the picture (or the canvas) best, finishing
           on eos breaking near ties; then the most paths (gen-service pickScore). */
        // Scores within 0.02 are the same drawing, told apart by its detail.
        const better =
          best === null ||
          cand.score > best.score + 0.02 ||
          (Math.abs(cand.score - best.score) <= 0.02 && cand.paths > best.paths);
        if (better) best = cand;
      }
      if (best === null) {
        log.warn('omnisvg produced nothing decodable', { source: job.source });
        continue;
      }
      n += 1;
      const numbered = `${String(n).padStart(2, '0')}.svg`;
      const generated = path.join(params.outputDir, numbered);
      await writeFile(generated, best.svg, 'utf8');
      let outputPath = generated;
      if (params.outPath !== undefined) {
        outputPath =
          jobs.length === 1 && /\.svg$/i.test(params.outPath)
            ? params.outPath
            : path.join(params.outPath, numbered);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, best.svg, 'utf8');
      }
      const { svg: _svg, score: _score, ...out } = best;
      outputs.push({ ...out, outputPath });
    }
  } finally {
    params.signal?.removeEventListener('abort', onStop);
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (params.signal?.aborted === true) throw new Error('the drawing was stopped');
  if (outputs.length === 0) throw new Error('OmniSVG produced no valid SVG for this input');
  return { outputs };
}
