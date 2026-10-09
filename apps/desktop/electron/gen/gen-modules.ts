/**
 * GENERATION MODULES — what has to be on this Mac before a picture, a clip, a
 * voice or a 3D model can be made, and the one button that puts it there.
 *
 * the user (2026-09-13), on the shipped app: "I just get a bunch of 'uv not
 * installed' errors, we need a popup/prominent button that has something like
 * 'download module' for image/audio/3d/video."
 *
 * WHAT WAS HAPPENING. Two failures wearing the same words. The packaged app is
 * launched by Finder with the bare system PATH, so the generation client's
 * PATH probe never saw the `uv` in ~/.local/bin — "uv is required … Install uv
 * and retry" — and the model then spent four tool calls trying to `pip install
 * uv` on a Mac with no pip (the session is in the memory notes). And even with
 * uv found, the FIRST run of a modality is uv resolving and downloading a
 * multi-gigabyte Python environment inside the job, with nothing on screen but
 * "Starting…" for minutes — which a person reads as broken.
 *
 * WHAT THIS IS. A module is the runtime a modality needs: the `mflux` Python
 * environment for pictures, `mlx-audio` for speech, ComfyUI for video, music
 * and sound effects, the 3D sidecar for models. Each has a READY answer and an
 * INSTALL that streams progress. A job whose module is not ready does not fail
 * and does not silently install: it WAITS (the download-then-continue courtesy
 * the ComfyUI packs already get) while the renderer shows the button — in the
 * chat and in the studio — and continues the SAME job the moment the install
 * lands. A dismissal, or nobody pressing it, ends the job with a sentence the
 * model can repeat to the user rather than act on itself.
 *
 * Pure coordination over injected ports, like comfy-install.ts and
 * asset-gate.ts: no download ever runs in a test.
 */

/**
 * The modules a person can install. `image` is the mflux environment — the
 * default picture model (Qwen-Image 2.1) and the fast ones run on it; `comfy`
 * serves video, ComfyUI audio and 3D.
 *
 * `weights:<catalog id>` is a model's own files — the second thing a job
 * needs after the runtime. the user (2026-09-14): "one click download of any
 * of these modules … video image 3d and audio generation with an m1-m6 mac".
 * A runtime with no weights is not one click; it is one click and then an
 * error naming a file. So the weights are a module with the same button, the
 * same wait, the same card — one per catalog entry that lists what it loads
 * (`ModalityModel.weights`) or MAKES on this Mac (`mflux.prepared`: the bf16
 * release fetched and quantized here, once), known to the manager the first
 * time a job asks.
 */
export type GenRuntimeModuleId = 'image' | 'audio' | 'comfy' | '3d' | 'dictation';
export type GenModuleId = GenRuntimeModuleId | `weights:${string}`;

export const GEN_MODULE_IDS: readonly GenRuntimeModuleId[] = [
  'image',
  'audio',
  'comfy',
  '3d',
  'dictation',
];

/** The weights module of a catalog entry, or nothing when it neither lists
 * files nor prepares any. */
export function weightsModuleFor(model: {
  readonly id: string;
  readonly weights?: readonly unknown[];
  readonly mflux?: { readonly prepared?: unknown };
}): GenModuleId | undefined {
  return (model.weights !== undefined && model.weights.length > 0) ||
    model.mflux?.prepared !== undefined
    ? `weights:${model.id}`
    : undefined;
}

/** The catalog id behind a weights module; null for a runtime module. */
export function weightsModelId(id: GenModuleId): string | null {
  return id.startsWith('weights:') ? id.slice('weights:'.length) : null;
}

/** What a module is called and costs — the runtime ones here, the weights
 * ones from the catalog through the ports (`meta`). */
export interface GenModuleMeta {
  readonly label: string;
  readonly blurb: string;
  readonly approxGB: number;
  readonly noun: string;
}

/** What the renderer shows for one module. */
export interface GenModuleState {
  readonly id: GenModuleId;
  /** "Image module", "ComfyUI · video, music and sound effects". */
  readonly label: string;
  /** One line under the title: what it is, what it costs. */
  readonly blurb: string;
  /** Rough size of the download, GB, for the button copy. */
  readonly approxGB: number;
  readonly ready: boolean;
  readonly installing: boolean;
  /** What the install is doing right now (uv's own lines, tidied). */
  readonly detail?: string;
  /** 0–1 when a phase can say how far along it is. */
  readonly percent?: number;
  /** The last install's failure, until the next attempt. */
  readonly error?: string;
  /** A generation is WAITING on this module (the gate is holding a job). */
  readonly wanted: boolean;
}

export const GEN_MODULE_META: Record<GenRuntimeModuleId, GenModuleMeta> = {
  image: {
    label: 'Image module',
    blurb:
      'The picture engine (mflux on MLX) — Qwen-Image 2.1, FLUX.2 klein, Z-Image. Models download on first use.',
    // Two environments: the pinned mflux release and the Qwen-Image 2.1 build
    // beside it, which share most of their packages in uv's cache.
    approxGB: 2.5,
    noun: 'Image generation',
  },
  audio: {
    label: 'Audio module',
    blurb: 'Speech and voices (mlx-audio). Voices download on first use.',
    approxGB: 1.5,
    noun: 'Speech generation',
  },
  comfy: {
    label: 'ComfyUI module',
    blurb: 'ComfyUI — video, music, sound effects and 3D. Models download on first use.',
    // MEASURED 2026-09-14 on a fresh cache: the checkout plus a venv of 179
    // packages is 1.5 GB on Apple Silicon (the Torch wheel has no CUDA in
    // it), installed in 30 seconds on a fast line. The 6 here was the Linux
    // figure.
    approxGB: 1.5,
    noun: 'Video, music, sound-effect and 3D generation',
  },
  '3d': {
    label: '3D module',
    blurb: 'The 3D engine. Stages download as you use them.',
    approxGB: 3,
    noun: '3D generation',
  },
  /*
   * DICTATION HAD NO WAY IN. Its environment was only ever made as a side
   * effect of the 3D sidecar provisioning the audio stack, and its speech
   * model downloaded on the first dictation — so a fresh Mac answered the mic
   * with "the dictation model is not installed yet" and no button anywhere put
   * it there (the user, 2026-10-08). This is that button: the recogniser's
   * environment and its model, 2.3 GB of it, once.
   */
  dictation: {
    label: 'Dictation',
    blurb: 'Speech to text by NVIDIA Parakeet on MLX, already punctuated.',
    approxGB: 2.5,
    noun: 'Dictation',
  },
};

/**
 * AN INSTALL THAT STOPPED, SAID SO THE PERSON CAN ACT ON IT. The card under a
 * failed install used to print uv's or Python's last line ("error: Failed to
 * fetch: https://…", a traceback's tail). What a person can do about a failed
 * download is short: get back online, make room, or try again — so that is
 * what this says; the raw line goes to the log (`onInstallError`). Pure.
 */
export function plainInstallError(raw: string): string {
  if (/ENOSPC|no space left/i.test(raw)) {
    return 'The disk is full. Free some space (Models › Storage), then Try again.';
  }
  if (
    /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|failed to fetch|connection (refused|reset|error|aborted)|timed? ?out|network|max retries|name ?resolution|connecterror|offline|dns/i.test(
      raw,
    )
  ) {
    return 'Could not reach the download server. Check the internet connection, then Try again.';
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|gated|restricted/i.test(raw)) {
    return 'The download server refused the files (they may need a sign-in). Try again later.';
  }
  if (/EACCES|EPERM|permission denied|read-only file system/i.test(raw)) {
    return 'Bobble could not write its files. Restart Bobble, then Try again.';
  }
  if (/no solution found|could not resolve|resolution|incompatible|requires-python/i.test(raw)) {
    return 'The packages it needs could not be put together for this Mac. Try again after updating Bobble.';
  }
  return 'The download stopped part-way. Try again — it carries on from where it got to.';
}

/** The side effects, injected. */
export interface GenModulePorts {
  /** Is the module ready right now? (a marker, a venv, a sidecar that is up) */
  readonly ready: (id: GenModuleId) => Promise<boolean>;
  /** Put it there, reporting lines and (when known) a fraction. Throws on failure. */
  readonly install: (
    id: GenModuleId,
    report: (detail: string, percent?: number) => void,
  ) => Promise<void>;
  /** Tell the renderer. */
  readonly emit: (states: readonly GenModuleState[]) => void;
  /** A job of this module succeeded: persist that (a marker), so the next
   * launch does not hold a job on a probe that cannot see a uv cache. */
  readonly remember?: (id: GenModuleId) => void;
  /** An install failed: its raw words, for the log (the card shows plainInstallError). */
  readonly onInstallError?: (id: GenModuleId, raw: string) => void;
  /** What a weights module is called and costs (from the catalog). A module
   * the ports cannot name is one the manager will not hold a job for. */
  readonly meta?: (id: GenModuleId) => GenModuleMeta | undefined;
  /** Injectable clock for the gate's wait (tests). */
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/**
 * How long a waiting job gives the person to press Download. Under the bash
 * tool's own 5-minute clock (harness DEFAULT_BASH_TIMEOUT_S) on purpose: when
 * nobody presses it, the model must get THIS sentence — the button stays on
 * screen for the next turn — and not a timeout it would misread.
 */
export const MODULE_WAIT_MS = 4 * 60 * 1000;

/** Why a job stopped at the gate ended — the queue's own words for a cancel. */
const JOB_STOPPED = 'generation canceled';

/** Marker the renderer reads out of a tool result to show the button there. */
export function moduleMarker(id: GenModuleId): string {
  return `[[bobble-module:${id}]]`;
}
export const MODULE_MARKER_RE = /\[\[bobble-module:(image|audio|comfy|3d|weights:[a-z0-9._-]+)\]\]/;

/**
 * The words the MODEL gets when a module is missing and nobody installed it.
 * They say what to do — ask — and what not to do, because MEASURED the model
 * otherwise tries to install Python tooling itself.
 */
export function moduleMissingMessage(
  id: GenModuleId,
  meta: GenModuleMeta = fallbackMeta(id),
): string {
  return (
    `${meta.noun} is not set up on this Mac yet. A "Download ${meta.label.toLowerCase()}" ` +
    'button is showing in the chat and in the studio — ask the user to press it, then try ' +
    'again. Do not install uv, pip, Python or any package yourself; that is not how this works. ' +
    moduleMarker(id)
  );
}

/** A runtime module's meta, or a plain name for a weights module nobody described. */
function fallbackMeta(id: GenModuleId): GenModuleMeta {
  const runtime = (GEN_MODULE_META as Record<string, GenModuleMeta | undefined>)[id];
  if (runtime !== undefined) return runtime;
  const model = weightsModelId(id) ?? id;
  return {
    label: `${model} weights`,
    blurb: 'The files this model loads.',
    approxGB: 0,
    noun: `${model}`,
  };
}

export class GenModuleMissingError extends Error {
  constructor(
    readonly module: GenModuleId,
    meta?: GenModuleMeta,
  ) {
    super(moduleMissingMessage(module, meta));
    this.name = 'GenModuleMissingError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: unknown;
}

export class GenModulesManager {
  readonly #ports: GenModulePorts;
  #installing = new Map<GenModuleId, Promise<void>>();
  #detail = new Map<GenModuleId, { detail?: string; percent?: number }>();
  #error = new Map<GenModuleId, string>();
  /** Jobs held at the gate, per module. */
  #waiters = new Map<GenModuleId, Waiter[]>();
  /** The last answer the ports gave (or an install / a success set), per module. */
  #ready = new Map<GenModuleId, boolean>();

  constructor(ports: GenModulePorts) {
    this.#ports = ports;
  }

  /** Ask the ports again for every module the last answer said was not ready. */
  async refresh(): Promise<GenModuleState[]> {
    for (const id of this.#known()) {
      if (this.#ready.get(id) === true) continue;
      const ready = await this.#ports.ready(id).catch(() => false);
      this.#ready.set(id, ready);
    }
    return this.status();
  }

  /** The state as last known — synchronous, so every emit is a true snapshot. */
  status(): GenModuleState[] {
    return this.#known().map((id) => this.#stateOf(id));
  }

  /**
   * The four runtimes always; a weights module once anything has touched it —
   * a job at its gate, a press of its button, an answer from its probe. Those
   * are the ones a card can be showing for.
   */
  #known(): GenModuleId[] {
    const ids = new Set<GenModuleId>(GEN_MODULE_IDS);
    for (const id of this.#ready.keys()) ids.add(id);
    for (const id of this.#installing.keys()) ids.add(id);
    for (const id of this.#waiters.keys()) ids.add(id);
    for (const id of this.#error.keys()) ids.add(id);
    return [...ids];
  }

  #meta(id: GenModuleId): GenModuleMeta {
    return this.#ports.meta?.(id) ?? fallbackMeta(id);
  }

  #stateOf(id: GenModuleId): GenModuleState {
    const meta = this.#meta(id);
    const live = this.#detail.get(id);
    const error = this.#error.get(id);
    return {
      id,
      label: meta.label,
      blurb: meta.blurb,
      approxGB: meta.approxGB,
      ready: this.#ready.get(id) === true,
      installing: this.#installing.has(id),
      ...(live?.detail !== undefined ? { detail: live.detail } : {}),
      ...(live?.percent !== undefined ? { percent: live.percent } : {}),
      ...(error !== undefined ? { error } : {}),
      wanted: (this.#waiters.get(id)?.length ?? 0) > 0,
    };
  }

  #broadcast(): void {
    this.#ports.emit(this.status());
  }

  #clear(handle: unknown): void {
    if (this.#ports.clearTimeout !== undefined) this.#ports.clearTimeout(handle);
    else clearTimeout(handle as NodeJS.Timeout);
  }

  /**
   * Install a module (the button). One flight per module; a second press
   * joins the first. On success every job waiting at the gate continues.
   */
  install(id: GenModuleId): Promise<void> {
    const inFlight = this.#installing.get(id);
    if (inFlight !== undefined) return inFlight;
    this.#error.delete(id);
    this.#detail.set(id, { detail: 'Starting…' });
    /*
     * THE PRESS STOPS THE CLOCK. A waiter's timer is the answer to "nobody
     * pressed it"; once someone has, the job waits on the install itself,
     * however long it takes — a 7 GB set of weights on a slow line is many
     * times MODULE_WAIT_MS, and ending the job at four minutes with "ask the
     * user to press it" while the bar is moving would be exactly wrong. A
     * failed install arms the clock again below, so an unretried failure
     * still ends the job with the sentence.
     */
    for (const w of this.#waiters.get(id) ?? []) {
      if (w.timer !== null) this.#clear(w.timer);
      w.timer = null;
    }
    const run = (async () => {
      try {
        await this.#ports.install(id, (detail, percent) => {
          this.#detail.set(id, {
            detail,
            ...(percent !== undefined ? { percent } : {}),
          });
          this.#broadcast();
        });
        this.#ready.set(id, true);
        this.#detail.delete(id);
        const waiting = this.#waiters.get(id) ?? [];
        this.#waiters.delete(id);
        for (const w of waiting) {
          if (w.timer !== null) this.#clear(w.timer);
          w.resolve();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#ports.onInstallError?.(id, message);
        this.#error.set(id, plainInstallError(message));
        this.#detail.delete(id);
        const arm = this.#ports.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
        for (const w of this.#waiters.get(id) ?? []) {
          if (w.timer === null) {
            w.timer = arm(() => {
              this.#drop(id, w);
              w.reject(new GenModuleMissingError(id, this.#meta(id)));
            }, MODULE_WAIT_MS);
          }
        }
        throw err;
      } finally {
        this.#installing.delete(id);
        this.#broadcast();
      }
    })();
    this.#installing.set(id, run);
    this.#broadcast();
    // The caller of install() sees the rejection; the gate's waiters keep waiting
    // (they can still be served by a retry) until dismissed or timed out.
    run.catch(() => undefined);
    return run;
  }

  /**
   * The gate: resolve when the module is ready — now, or once an install the
   * person started lands. Rejects with {@link GenModuleMissingError} when they
   * dismiss it or the wait runs out. A held job is what makes the button
   * appear in the chat (`wanted`).
   */
  async ensure(id: GenModuleId, signal?: AbortSignal): Promise<void> {
    /*
     * `signal` is the job's: a job stopped while it waits (its turn stopped,
     * its chat deleted) is no longer waiting. Its waiter stayed registered, so
     * the card went on saying a generation was waiting on this module until
     * the four-minute clock ran out.
     */
    const stopped = (): boolean => signal?.aborted === true;
    if (stopped()) throw new Error(JOB_STOPPED);
    if (this.#ready.get(id) !== true) {
      const ready = await this.#ports.ready(id).catch(() => false);
      this.#ready.set(id, ready);
    }
    if (this.#ready.get(id) === true) return;
    if (stopped()) throw new Error(JOB_STOPPED);
    const inFlight = this.#installing.get(id);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const list = this.#waiters.get(id) ?? [];
      const onStop = (): void => {
        if (waiter.timer !== null) this.#clear(waiter.timer);
        this.#drop(id, waiter);
        reject(new Error(JOB_STOPPED));
      };
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onStop);
          resolve();
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onStop);
          reject(err);
        },
        timer: null,
      };
      const arm = this.#ports.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
      waiter.timer = arm(() => {
        this.#drop(id, waiter);
        waiter.reject(new GenModuleMissingError(id, this.#meta(id)));
      }, MODULE_WAIT_MS);
      signal?.addEventListener('abort', onStop, { once: true });
      list.push(waiter);
      this.#waiters.set(id, list);
      this.#broadcast();
    });
  }

  /** The person closed the card: every job waiting on this module stops. */
  dismiss(id: GenModuleId): void {
    const waiting = this.#waiters.get(id) ?? [];
    this.#waiters.delete(id);
    for (const w of waiting) {
      if (w.timer !== null) this.#clear(w.timer);
      w.reject(new GenModuleMissingError(id, this.#meta(id)));
    }
    this.#broadcast();
  }

  /** A job of this module just succeeded: it is ready, whatever the probe says. */
  markReady(id: GenModuleId): void {
    if (this.#ready.get(id) === true) return;
    this.#ready.set(id, true);
    try {
      this.#ports.remember?.(id);
    } catch {
      // a marker that cannot be written costs one probe next launch, nothing more
    }
    this.#broadcast();
  }

  #drop(id: GenModuleId, waiter: Waiter): void {
    const list = (this.#waiters.get(id) ?? []).filter((w) => w !== waiter);
    if (list.length === 0) this.#waiters.delete(id);
    else this.#waiters.set(id, list);
    this.#broadcast();
  }
}

/**
 * Which module a job needs, from its backend. `hyperframes` (a Node renderer)
 * and anything unknown need nothing here; 3D jobs run through the gen3d bridge
 * and gate themselves.
 */
export function moduleForBackend(backend: string): GenModuleId | undefined {
  switch (backend) {
    case 'mflux':
      return 'image';
    case 'mlx-audio':
    case 'torch-tts':
      return 'audio';
    case 'comfyui':
      return 'comfy';
    case 'trellis':
    case 'triposr':
      return '3d';
    default:
      return undefined;
  }
}

/**
 * uv's own progress lines, tidied for a status line. uv writes "Resolved 96
 * packages in 1.20s", "Downloading torch (215.3MiB)", "Installed 96 packages
 * in 4s", plus a progress bar with carriage returns; the last segment is what
 * is happening now.
 */
export function uvLineToDetail(chunk: string): string | undefined {
  const last = chunk
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (last === undefined) return undefined;
  const cleaned = last
    // biome-ignore lint/suspicious/noControlCharactersInRegex: uv colours its output; tqdm moves the cursor
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^(warning|error):\s*/i, '');
  return cleaned.length > 120 ? `${cleaned.slice(0, 119)}…` : cleaned;
}
