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

/** The modules a person can install. `comfy` serves video AND ComfyUI audio. */
export type GenModuleId = 'image' | 'audio' | 'comfy' | '3d';

export const GEN_MODULE_IDS: readonly GenModuleId[] = ['image', 'audio', 'comfy', '3d'];

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

export const GEN_MODULE_META: Record<
  GenModuleId,
  { label: string; blurb: string; approxGB: number; noun: string }
> = {
  image: {
    label: 'Image module',
    blurb: 'The picture engine (mflux on MLX). Models download on first use.',
    approxGB: 2,
    noun: 'Image generation',
  },
  audio: {
    label: 'Audio module',
    blurb: 'Speech and voices (mlx-audio). Voices download on first use.',
    approxGB: 1.5,
    noun: 'Speech generation',
  },
  comfy: {
    label: 'Video module',
    blurb: 'ComfyUI — video, music and sound effects. Model packs download on first use.',
    approxGB: 6,
    noun: 'Video, music and sound-effect generation',
  },
  '3d': {
    label: '3D module',
    blurb: 'The 3D engine. Stages download as you use them.',
    approxGB: 3,
    noun: '3D generation',
  },
};

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

/** Marker the renderer reads out of a tool result to show the button there. */
export function moduleMarker(id: GenModuleId): string {
  return `[[bobble-module:${id}]]`;
}
export const MODULE_MARKER_RE = /\[\[bobble-module:(image|audio|comfy|3d)\]\]/;

/**
 * The words the MODEL gets when a module is missing and nobody installed it.
 * They say what to do — ask — and what not to do, because MEASURED the model
 * otherwise tries to install Python tooling itself.
 */
export function moduleMissingMessage(id: GenModuleId): string {
  const meta = GEN_MODULE_META[id];
  return (
    `${meta.noun} is not set up on this Mac yet. A "Download ${meta.label.toLowerCase()}" ` +
    'button is showing in the chat and in the studio — ask the user to press it, then try ' +
    'again. Do not install uv, pip, Python or any package yourself; that is not how this works. ' +
    moduleMarker(id)
  );
}

export class GenModuleMissingError extends Error {
  constructor(readonly module: GenModuleId) {
    super(moduleMissingMessage(module));
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
    for (const id of GEN_MODULE_IDS) {
      if (this.#ready.get(id) === true) continue;
      const ready = await this.#ports.ready(id).catch(() => false);
      this.#ready.set(id, ready);
    }
    return this.status();
  }

  /** The state as last known — synchronous, so every emit is a true snapshot. */
  status(): GenModuleState[] {
    return GEN_MODULE_IDS.map((id) => this.#stateOf(id));
  }

  #stateOf(id: GenModuleId): GenModuleState {
    const meta = GEN_MODULE_META[id];
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
          this.#clear(w.timer);
          w.resolve();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#error.set(id, message);
        this.#detail.delete(id);
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
  async ensure(id: GenModuleId): Promise<void> {
    if (this.#ready.get(id) !== true) {
      const ready = await this.#ports.ready(id).catch(() => false);
      this.#ready.set(id, ready);
    }
    if (this.#ready.get(id) === true) return;
    const inFlight = this.#installing.get(id);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const list = this.#waiters.get(id) ?? [];
      const waiter: Waiter = { resolve, reject, timer: null };
      const arm = this.#ports.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
      waiter.timer = arm(() => {
        this.#drop(id, waiter);
        reject(new GenModuleMissingError(id));
      }, MODULE_WAIT_MS);
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
      this.#clear(w.timer);
      w.reject(new GenModuleMissingError(id));
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
    // biome-ignore lint/suspicious/noControlCharactersInRegex: uv colours its output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^(warning|error):\s*/i, '');
  return cleaned.length > 120 ? `${cleaned.slice(0, 119)}…` : cleaned;
}
