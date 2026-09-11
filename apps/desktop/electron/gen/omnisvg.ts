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
import { buildOmniSvgRequest, decodeOmniSvg, idsFromCompletion } from '@pi-desktop/gen-service';
import { ensureLlamaCpp, getCatalogModel, modelDir } from '@pi-desktop/inference';
import { createLogger } from '@pi-desktop/shared';

const log = createLogger('desktop:omnisvg');

export const OMNISVG_MODEL_ID = 'omnisvg-1.1-4b';

export interface OmniSvgParams {
  readonly prompt?: string;
  /** Reference images (paths). Each becomes its own SVG. */
  readonly images?: readonly string[];
  /** Candidates per input; the best is kept. Default 3. */
  readonly candidates?: number;
  readonly outputDir: string;
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
export function omniSvgFiles(): {
  gguf: string;
  mmproj: string;
  ready: boolean;
  missing: string[];
} {
  const model = getCatalogModel(OMNISVG_MODEL_ID);
  const dir = modelDir(OMNISVG_MODEL_ID);
  const gguf = path.join(dir, model?.files[0]?.name ?? 'OmniSVG1.1_4B-Q8_0.gguf');
  const mmproj = path.join(dir, model?.mmproj?.name ?? 'mmproj-OmniSVG1.1_4B-F16.gguf');
  const missing = [gguf, mmproj].filter((f) => !existsSync(f));
  return { gguf, mmproj, ready: missing.length === 0, missing };
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

export async function generateSvg(params: OmniSvgParams): Promise<{ outputs: OmniSvgOutput[] }> {
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
  const child = spawn(serverPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr: string[] = [];
  child.stderr?.on('data', (d: Buffer) => {
    stderr.push(d.toString());
    if (stderr.length > 40) stderr.shift();
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

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
    const jobs: Array<{ source: string; body: ReturnType<typeof buildOmniSvgRequest> }> = [];
    if (prompt !== '') jobs.push({ source: 'prompt', body: buildOmniSvgRequest({ prompt }) });
    for (const img of images) {
      const imageBase64 = (await readFile(img)).toString('base64');
      jobs.push({ source: path.basename(img), body: buildOmniSvgRequest({ imageBase64 }) });
    }

    let n = 0;
    for (const job of jobs) {
      let best: (OmniSvgOutput & { svg: string }) | null = null;
      for (let k = 0; k < candidates; k++) {
        const res = await fetch(`${base}/completion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(job.body),
        });
        const parsed = idsFromCompletion(
          (await res.json()) as Parameters<typeof idsFromCompletion>[0],
        );
        if ('error' in parsed) throw new Error(parsed.error);
        const decoded = decodeOmniSvg(parsed.ids);
        if (decoded === null) continue;
        const cand = {
          outputPath: '',
          paths: decoded.paths,
          source: job.source,
          stop: parsed.stop,
          tokPerSec: parsed.tokPerSec,
          tokens: parsed.ids.length,
          svg: decoded.svg,
        };
        /* Best = finished on eos first, then the most paths — a shape that ran
           into the token limit is one the model never completed. */
        const better =
          best === null ||
          (cand.stop === 'eos' && best.stop !== 'eos') ||
          (cand.stop === best.stop && cand.paths > best.paths);
        if (better) best = cand;
      }
      if (best === null) {
        log.warn('omnisvg produced nothing decodable', { source: job.source });
        continue;
      }
      n += 1;
      const outputPath = path.join(params.outputDir, `${String(n).padStart(2, '0')}.svg`);
      await writeFile(outputPath, best.svg, 'utf8');
      const { svg: _svg, ...out } = best;
      outputs.push({ ...out, outputPath });
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (outputs.length === 0) throw new Error('OmniSVG produced no valid SVG for this input');
  return { outputs };
}
