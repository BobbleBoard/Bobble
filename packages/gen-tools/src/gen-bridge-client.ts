/**
 * GenBridgeClient — the pi-child half of the generation bridge.
 *
 * Speaks line-delimited JSON-RPC (see ./gen-contract.ts) to the app's
 * Unix-domain socket over `node:net`, mirroring browser-use's BrowserAgentClient.
 * The one meaningful difference: `generate` blocks on a heavy Python job, so the
 * default request timeout is minutes, not seconds. One lazily-opened,
 * auto-reconnecting connection; each request correlated by an incrementing id.
 */
import net from 'node:net';
import {
  GEN_AGENT_ENV,
  GEN_SOCK_ENV,
  GEN_TOKEN_ENV,
  type GenBridgeMethod,
  type GenBridgeRequest,
  type GenBridgeResponse,
  type GenerateImageParams,
  type GenerateImageResult,
  type GenerateVideoParams,
  type GenerateVideoResult,
  type GenModelSummary,
} from './gen-contract.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Stops listening to the caller's signal once the request is over. */
  off?: () => void;
}

/**
 * Why a request ended when its turn was stopped. The tools put it in front of
 * the model as the result, so it says what happened to the job as well.
 */
export const GEN_REQUEST_STOPPED = 'stopped — the turn was stopped, and the job with it';

export interface GenBridgeClientOptions {
  readonly socketPath: string;
  readonly token: string;
  /** Per-request timeout (ms). Default 15 min — a heavy gen job can be slow. */
  readonly requestTimeoutMs?: number;
  /** Connection attempt timeout (ms). Default 5000. */
  readonly connectTimeoutMs?: number;
  /** Which pi is asking ({@link GEN_AGENT_ENV}); absent = the chat's own pi. */
  readonly agent?: string;
}

const DEFAULT_REQUEST_TIMEOUT = 15 * 60_000;
const DEFAULT_CONNECT_TIMEOUT = 5_000;

/** The narrow surface the tools depend on — lets tests inject a fake bridge. */
export interface GenBridge {
  /**
   * `signal` is the tool call's: when it fires the request rejects AT ONCE with
   * {@link GEN_REQUEST_STOPPED}, and the app is told to let the job go.
   */
  request<T = unknown>(
    method: GenBridgeMethod,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export class GenBridgeClient implements GenBridge {
  readonly #socketPath: string;
  readonly #token: string;
  readonly #requestTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #agent: string | undefined;
  readonly #pending = new Map<number, Pending>();
  #socket: net.Socket | null = null;
  #connecting: Promise<net.Socket> | null = null;
  #buffer = '';
  #nextId = 1;

  constructor(opts: GenBridgeClientOptions) {
    this.#socketPath = opts.socketPath;
    this.#token = opts.token;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    this.#agent = opts.agent;
  }

  /** Build a client from the env the app injects, or `null` when unavailable
   * (extension loaded outside Pi Desktop → tools report a clear error). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): GenBridgeClient | null {
    const socketPath = env[GEN_SOCK_ENV];
    const token = env[GEN_TOKEN_ENV];
    if (socketPath === undefined || socketPath === '' || token === undefined) return null;
    const agent = env[GEN_AGENT_ENV];
    return new GenBridgeClient({
      socketPath,
      token,
      ...(agent !== undefined && agent !== '' ? { agent } : {}),
    });
  }

  #connect(): Promise<net.Socket> {
    if (this.#socket !== null && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    if (this.#connecting !== null) return this.#connecting;
    this.#connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(this.#socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`gen bridge connect timed out (${this.#connectTimeoutMs}ms)`));
      }, this.#connectTimeoutMs);
      timer.unref?.();
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setEncoding('utf8');
        this.#socket = socket;
        this.#connecting = null;
        socket.on('data', (chunk: string) => this.#onData(chunk));
        socket.on('close', () => this.#onClose(new Error('gen bridge connection closed')));
        socket.on('error', () => {
          /* surfaced via 'close'; a bare 'error' must not crash the child */
        });
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        this.#connecting = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    return this.#connecting;
  }

  #onClose(reason: Error): void {
    this.#socket = null;
    this.#buffer = '';
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.off?.();
      p.reject(reason);
    }
    this.#pending.clear();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl = this.#buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line.trim() !== '') this.#handleLine(line);
      nl = this.#buffer.indexOf('\n');
    }
  }

  #handleLine(line: string): void {
    let msg: GenBridgeResponse;
    try {
      msg = JSON.parse(line) as GenBridgeResponse;
    } catch {
      return; // ignore non-JSON noise
    }
    if (typeof msg.id !== 'number') return;
    const pending = this.#pending.get(msg.id);
    if (pending === undefined) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    pending.off?.();
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error ?? 'gen bridge error'));
  }

  /** Issue one RPC. Rejects on transport/timeout/app error, or at once on `signal`. */
  async request<T = unknown>(
    method: GenBridgeMethod,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    // A function, so the check after the await is not narrowed away.
    const stopped = (): boolean => signal?.aborted === true;
    if (stopped()) throw new Error(GEN_REQUEST_STOPPED);
    const socket = await this.#connect();
    if (stopped()) throw new Error(GEN_REQUEST_STOPPED);
    const id = this.#nextId++;
    const payload: GenBridgeRequest = {
      id,
      token: this.#token,
      method,
      params,
      ...(this.#agent !== undefined ? { agent: this.#agent } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.get(id)?.off?.();
        this.#pending.delete(id);
        reject(new Error(`gen bridge "${method}" timed out (${this.#requestTimeoutMs}ms)`));
      }, this.#requestTimeoutMs);
      timer.unref?.();
      /*
       * THE TURN WAS STOPPED. pi ends a turn only once its tool call returns, so
       * waiting here for the job held the Stop for as long as the job took. Give
       * up now — and tell the app, which cancels the job: nobody is left to
       * receive it. A fire-and-forget line with no reply expected; an app that
       * does not know the method answers an id nobody is waiting for.
       */
      const onAbort = (): void => {
        const p = this.#pending.get(id);
        if (p === undefined) return;
        this.#pending.delete(id);
        clearTimeout(p.timer);
        reject(new Error(GEN_REQUEST_STOPPED));
        this.#send({
          id: this.#nextId++,
          token: this.#token,
          method: 'abandon',
          params: { requestId: id },
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        ...(signal !== undefined
          ? { off: () => signal.removeEventListener('abort', onAbort) }
          : {}),
      });
      try {
        socket.write(`${JSON.stringify(payload)}\n`, (err) => {
          if (err != null) {
            const p = this.#pending.get(id);
            if (p !== undefined) {
              this.#pending.delete(id);
              clearTimeout(p.timer);
              p.off?.();
              reject(err);
            }
          }
        });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Write one line with no reply expected. Best effort: a dead socket loses it,
   * and a dead socket is one the app has already let go of. */
  #send(payload: GenBridgeRequest): void {
    try {
      this.#socket?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* the connection is gone; so is the app's side of the request */
    }
  }

  /** Enqueue an image generation and await its outputs. */
  generate(params: GenerateImageParams): Promise<GenerateImageResult> {
    return this.request<GenerateImageResult>('generate', { ...params });
  }

  /**
   * Enqueue a video generation and await its outputs + a poster frame. Distinct
   * from {@link generate} (image): the app-side bridge dispatches this to
   * ComfyUI (LTX/Wan) or the Node HyperFrames runner, never the uv worker.
   */
  generateVideo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
    return this.request<GenerateVideoResult>('generateVideo', { ...params });
  }

  /** Cancel a running/queued job by id. */
  cancel(jobId: string): Promise<{ canceled: boolean }> {
    return this.request<{ canceled: boolean }>('cancel', { jobId });
  }

  /** Enumerate the modality catalog (for surfacing available models). */
  listModels(): Promise<GenModelSummary[]> {
    return this.request<GenModelSummary[]>('listModels');
  }

  dispose(): void {
    this.#onClose(new Error('client disposed'));
    this.#socket?.destroy();
    this.#socket = null;
  }
}
