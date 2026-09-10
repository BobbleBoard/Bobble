/**
 * MacHelperClient — the Node half of the long-lived `pi-mac --serve` helper.
 *
 * Electron main spawns ONE helper (so the Accessibility + Screen Recording TCC
 * grants attribute to the signed app bundle, not the pi child) and issues
 * line-delimited JSON-RPC over its stdio: `{ id, method, params }` in,
 * `{ id, ok, result|error }` out. Keeping a single process alive is what lets
 * `click/type` resolve a [index] the previous `snapshot` produced (the helper
 * holds the index→AXUIElement map for its lifetime).
 *
 * Lazily spawned on the first request and respawned after a crash; each request
 * is correlated by an incrementing id and bounded by a timeout so a wedged
 * helper can never hang a tool. Never throws across the boundary in a way that
 * escapes: transport/timeout failures reject, and the bridge turns a rejection
 * into a `{ ok:false, error }` wire response. Injectable spawn for tests.
 *
 * `helperArgs` picks WHICH long-lived mode is spoken to. `--serve` (the default)
 * is the computer-use bridge; `--overlay` is the phantom-cursor panel, a second
 * process because it runs an NSApplication runloop. They share this client
 * because they share the wire format exactly — same request shape, same
 * response shape, same "one process, many correlated requests" lifetime.
 */
import { helperPath } from './helper-path.js';
import { defaultSpawn, type MacChildProcess, type MacSpawnFn } from './spawn.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MacHelperClientOptions {
  /** Explicit helper binary path (packaged app injects the bundle path). */
  readonly helperPath?: string;
  /** Which persistent helper mode to spawn. Default `['--serve']`. */
  readonly helperArgs?: readonly string[];
  /** Injectable spawn for tests. */
  readonly spawnFn?: MacSpawnFn;
  /** Per-request timeout (ms). Default 30000. */
  readonly requestTimeoutMs?: number;
  /** Called for each line the helper writes to stderr. Without it those lines
   * are still drained (a pipe nobody reads eventually blocks the child) but
   * dropped. */
  readonly onStderr?: (line: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT = 30_000;

export class MacHelperClient {
  readonly #bin: string;
  readonly #args: readonly string[];
  readonly #spawnFn: MacSpawnFn;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #child: MacChildProcess | null = null;
  #buffer = '';
  #nextId = 1;
  /** Called with each line the helper writes to stderr — see #ensureChild. */
  readonly #onStderr: ((line: string) => void) | undefined;

  constructor(opts: MacHelperClientOptions = {}) {
    this.#bin = helperPath(opts.helperPath);
    this.#args = opts.helperArgs ?? ['--serve'];
    this.#spawnFn = opts.spawnFn ?? defaultSpawn;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    this.#onStderr = opts.onStderr;
  }

  #ensureChild(): MacChildProcess {
    if (this.#child !== null) return this.#child;
    const child = this.#spawnFn(this.#bin, this.#args);
    this.#child = child;
    this.#buffer = '';
    child.stdout?.on('data', (chunk) => this.#onData(String(chunk)));
    /*
     * READ THE CHILD'S STDERR — nobody did, and it is spawned with a PIPE.
     *
     * Everything the helper wrote there was therefore invisible, including the
     * diagnostics it writes precisely when something is wrong ("Screen
     * Recording is not granted", "no shareable window"). A pipe nobody drains
     * is also a pipe that eventually fills and blocks the child.
     *
     * Handed to the caller rather than logged here, because this package has no
     * logger and should not acquire one.
     */
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t !== '') this.#onStderr?.(t);
      }
    });
    child.on('error', (err) => this.#onExit(err));
    child.on('close', () => this.#onExit(new Error('pi-mac helper exited')));
    return child;
  }

  #onExit(reason: Error): void {
    this.#child = null;
    this.#buffer = '';
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
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
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON noise on stdout
    }
    /*
     * AN EVENT, not an answer. The overlay panel's pill has buttons on it now
     * (stop / pause / hide), and a button press has no request to reply to — it
     * originates in the helper. A line with an `event` and no `id` is that, and
     * anything else without an id is still ignored as noise.
     */
    const evt = (msg as { event?: unknown }).event;
    if (typeof evt === 'string' && msg.id === undefined) {
      for (const fn of this.#eventListeners) {
        try {
          fn(evt, (msg as { data?: Record<string, unknown> }).data ?? {});
        } catch {
          /* a listener that throws must not break the pipe */
        }
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const pending = this.#pending.get(msg.id);
    if (pending === undefined) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok === true) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error ?? 'pi-mac helper error'));
  }

  #eventListeners = new Set<(event: string, data: Record<string, unknown>) => void>();

  /** Listen for helper-originated events (the pill's buttons). Returns an
   * unsubscribe. */
  onEvent(fn: (event: string, data: Record<string, unknown>) => void): () => void {
    this.#eventListeners.add(fn);
    return () => this.#eventListeners.delete(fn);
  }

  /** Issue one RPC. Rejects on transport/timeout/helper error. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    let child: MacChildProcess;
    try {
      child = this.#ensureChild();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`pi-mac "${method}" timed out (${this.#requestTimeoutMs}ms)`));
      }, this.#requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        child.stdin?.write(`${payload}\n`, (err) => {
          if (err != null) {
            const p = this.#pending.get(id);
            if (p !== undefined) {
              this.#pending.delete(id);
              clearTimeout(p.timer);
              reject(err);
            }
          }
        });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    const child = this.#child;
    this.#onExit(new Error('client disposed'));
    try {
      child?.stdin?.end();
      child?.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}
