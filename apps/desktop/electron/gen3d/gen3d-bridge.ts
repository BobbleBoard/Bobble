/**
 * gen3d bridge — the trusted seam that lets the harness's `generate_image` /
 * `edit_image` tools (running inside the main pi child) reach the generation
 * ENGINE, which the Electron main process owns.
 *
 * They cannot call it directly: the engine is a uv/Python sidecar supervised by
 * gen3d-main, while the tools live in a separate pi process. So the tools ask
 * the app, and the app runs the job through the SAME `sidecarPost('/generate',
 * … imageOnly)` path the 3D studio's Image panel uses — one engine, one model
 * manager, one heavy job at a time on a 24 GB machine.
 *
 * Transport mirrors subagent-bridge.ts exactly: a line-delimited JSON-RPC server
 * on a Unix socket, its path + a random token published on the env BEFORE the
 * first pi spawn so the child's harness reads them (GEN3D_SOCK_ENV / _TOKEN_ENV).
 * Absent that env — a plain CLI pi — the harness simply doesn't register the
 * tools, so nothing can hang waiting on a bridge that was never there.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '@pi-desktop/shared';
import type { ImageJobResult } from './image-jobs';

const log = createLogger('desktop:gen3d-bridge');

/** Runs one image job. Injected (gen3d-main's `runImageJob` in the app) so this
 * module stays electron-free and testable over a real socket. */
export type RunImageJob = (req: {
  prompt: string;
  editFrom?: string;
  /** The asking pi — a subagent's id; absent for the chat's own pi. */
  agent?: string;
  /** Aborted when the tool that asked hangs up before the reply (see handleLine). */
  signal?: AbortSignal;
}) => Promise<ImageJobResult>;
/** The 3D side (gen3d-main run3dJob / runStage3dJob), wired beside the image runner. */
export interface ModelRunners {
  readonly generate: (req: {
    prompt?: string;
    imagePath?: string;
    finish?: 'grey' | 'color' | 'pbr';
    resolution?: 'low' | 'medium' | 'high';
    agent?: string;
    signal?: AbortSignal;
  }) => Promise<ImageJobResult>;
  readonly stage: (req: {
    op: 'texture' | 'segment' | 'rig' | 'retopo';
    modelPath: string;
    prompt?: string;
    agent?: string;
    signal?: AbortSignal;
  }) => Promise<ImageJobResult>;
}

let runJob: RunImageJob | null = null;
let runModel: ModelRunners | null = null;

/** Env keys the harness's bridge client reads (keep in sync with
 * packages/harness src/tools/image-bridge-client.ts). */
const SOCK_ENV = 'PI_DESKTOP_GEN3D_SOCK';
const TOKEN_ENV = 'PI_DESKTOP_GEN3D_TOKEN';

let token = '';
let server: net.Server | null = null;

interface BridgeRequest {
  id: number;
  token: string;
  method: string;
  /** Which pi is asking (PI_DESKTOP_AGENT_ID); absent = the chat's own pi. */
  agent?: string;
  params?: {
    prompt?: string;
    imagePath?: string;
    instruction?: string;
    finish?: string;
    resolution?: string;
    op?: string;
    modelPath?: string;
  };
}

function fail(error: string): ImageJobResult {
  return { ok: false, error };
}

/**
 * A SMALL LOOK AT A FINISHED PICTURE, for the model that asked for it.
 *
 * The user (2026-09-24): images are "mainly observe + improve loop". The tools
 * carried only a URL and a path — deliberately, so a 1024² picture never sat in
 * a small model's context or its saved chat as base64 — which left the model
 * blind to what it had made. A ~384 px JPEG (tens of KB) is the middle: enough
 * to judge the result against the ask, not enough to weigh the chat down.
 * Injected by main (pi-main: Electron's nativeImage), absent in tests.
 */
export type ImagePreviewer = (path: string) => Promise<{ data: string; mimeType: string } | null>;

let previewImage: ImagePreviewer | null = null;

async function withPreview(
  result: ImageJobResult,
  preview: ImagePreviewer | null,
): Promise<ImageJobResult> {
  if (!result.ok || preview === null) return result;
  try {
    const look = await preview(result.path);
    return look === null ? result : { ...result, preview: look };
  } catch {
    return result;
  }
}

export async function handleMethod(
  method: string,
  params: BridgeRequest['params'],
  run: RunImageJob | null = runJob,
  models: ModelRunners | null = runModel,
  agent?: string,
  preview: ImagePreviewer | null = previewImage,
  signal?: AbortSignal,
): Promise<ImageJobResult> {
  /* Who asked travels with the job, so the chat that owns it can stop it —
     and so does whether they are still there to receive it. */
  const who = {
    ...(agent !== undefined && agent !== '' ? { agent } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
  /* THE 3D METHODS — the connector's tools (harness model-tools.ts). */
  if (method === 'generate_3d') {
    if (models === null) return fail('the 3D engine is not available');
    const prompt = typeof params?.prompt === 'string' ? params.prompt : '';
    const imagePath = typeof params?.imagePath === 'string' ? params.imagePath.trim() : '';
    const finish = params?.finish;
    const resolution = params?.resolution;
    return models.generate({
      ...(prompt !== '' ? { prompt } : {}),
      ...(imagePath !== '' ? { imagePath } : {}),
      ...(finish === 'grey' || finish === 'color' || finish === 'pbr' ? { finish } : {}),
      ...(resolution === 'low' || resolution === 'medium' || resolution === 'high'
        ? { resolution }
        : {}),
      ...who,
    });
  }
  if (method === 'refine_3d') {
    if (models === null) return fail('the 3D engine is not available');
    const op = params?.op;
    const modelPath = typeof params?.modelPath === 'string' ? params.modelPath.trim() : '';
    if (op !== 'texture' && op !== 'segment' && op !== 'rig' && op !== 'retopo') {
      return fail(`unknown 3D refinement "${String(op)}" — texture, segment, rig or retopo`);
    }
    if (modelPath === '') return fail('model_path is required');
    const prompt = typeof params?.prompt === 'string' ? params.prompt : undefined;
    return models.stage({ op, modelPath, ...(prompt !== undefined ? { prompt } : {}), ...who });
  }
  if (run === null) return fail('the image engine is not available');
  if (method === 'generate_image') {
    const prompt = typeof params?.prompt === 'string' ? params.prompt : '';
    return withPreview(await run({ prompt, ...who }), preview);
  }
  if (method === 'edit_image') {
    const imagePath = typeof params?.imagePath === 'string' ? params.imagePath.trim() : '';
    const instruction = typeof params?.instruction === 'string' ? params.instruction : '';
    if (imagePath === '') return fail('image_path is required');
    return withPreview(await run({ prompt: instruction, editFrom: imagePath, ...who }), preview);
  }
  return fail(`unknown method: ${method}`);
}

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-gen3d-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
}

function handleConnection(socket: net.Socket): void {
  let buffer = '';
  /*
   * The requests this connection is still waiting on. The harness's client
   * opens one connection per request and CLOSES it when its turn is aborted —
   * "cancelled" is already the tool's answer by then — so a close with a
   * request unanswered means nobody is left to receive the result.
   */
  const unanswered = new Set<AbortController>();
  socket.setEncoding('utf8');
  socket.on('error', () => {
    /* a peer reset must never crash main */
  });
  socket.on('close', () => {
    for (const asker of unanswered) asker.abort();
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== '') void handleLine(socket, line, unanswered);
      nl = buffer.indexOf('\n');
    }
  });
}

async function handleLine(
  socket: net.Socket,
  line: string,
  unanswered: Set<AbortController>,
): Promise<void> {
  let req: BridgeRequest;
  try {
    req = JSON.parse(line) as BridgeRequest;
  } catch {
    return;
  }
  if (typeof req.id !== 'number') return;
  const respond = (patch: Record<string, unknown>): void => {
    try {
      socket.write(`${JSON.stringify({ id: req.id, ...patch })}\n`);
    } catch {
      /* peer gone */
    }
  };
  if (req.token !== token) {
    respond({ ok: false, error: 'unauthorized' });
    return;
  }
  const asker = new AbortController();
  unanswered.add(asker);
  try {
    const res = await handleMethod(
      req.method,
      req.params,
      runJob,
      runModel,
      req.agent,
      previewImage,
      asker.signal,
    );
    unanswered.delete(asker);
    respond(res);
  } catch (err) {
    unanswered.delete(asker);
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Stand up the bridge socket and publish its env for the pi child spawned later.
 * Called from pi-main's registerPiIpc, beside {@link registerSubagentBridge} and
 * for the same reason: the env must exist BEFORE the first pi spawn reads it.
 */
export function registerGen3dBridge(
  run: RunImageJob,
  models: ModelRunners | null = null,
  preview: ImagePreviewer | null = null,
): void {
  runJob = run;
  runModel = models;
  previewImage = preview;
  if (server !== null) return;
  const socketPath = process.env[SOCK_ENV] ?? defaultSocketPath();
  token = process.env[TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket; listen() surfaces a real problem */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('gen3d bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('gen3d bridge listening', { socketPath }));
  process.env[SOCK_ENV] = socketPath;
  process.env[TOKEN_ENV] = token;
}

/** Test/lifecycle hook: close the socket server. */
export function disposeGen3dBridge(): void {
  server?.close();
  server = null;
  runJob = null;
  runModel = null;
  previewImage = null;
}

/** Test hook: the env a child would read (undefined before the bridge starts). */
export function gen3dBridgeEnv(): { sock?: string; token?: string } {
  return { sock: process.env[SOCK_ENV], token: process.env[TOKEN_ENV] };
}
