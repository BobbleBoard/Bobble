/**
 * Renderer↔main IPC contract for generation — its OWN file, mirroring
 * canvas/browser-agent-contract.ts. Self-contained so it does NOT edit the
 * round-12 ipc-contract.ts; the app composes these maps into the global
 * AppEventMap / AppInvokeMap with a one-line spread (see gen-manager.ts header
 * for the exact wire-up).
 *
 * Two directions:
 *   - main→renderer EVENTS (`gen:open` / `gen:update`): stream a generation job's
 *     live state — step progress, decoded step previews, the worker's own status
 *     line, the outputs as they land — to the card the THREAD renders inline.
 *   - renderer→main INVOKE (`gen:register` / `gen:cancel`): the renderer acks the
 *     stream, and the user can cancel a running job.
 *
 * The ComfyUI modular-download install manager (see comfy-install.ts) adds a
 * third pair on the SAME maps: a `gen:comfy-install` progress event (forwarded
 * straight from {@link ComfyInstallEvent}) and the consent / install / status
 * invokes the install UI drives.
 */
import type { ComfyInstallEvent, ComfyInstallState, ComfyPackLicense } from './comfy-install';
import type { GenModuleId, GenModuleState } from './gen-modules';

/**
 * The live state of one running generation, as the renderer needs to draw it.
 *
 * A plain payload so Electron MAIN never imports a React component: the renderer
 * folds it into the live-generation store (src/chat/gen-stream.ts) and the
 * THREAD renders it, inline, in the box the finished thing will occupy. It used
 * to be a structural mirror of the `gen-image` canvas surface's props; that
 * surface no longer has a caller (the user, round 21: generation "gets shown inline,
 * the large card, same as each studio would show").
 */
export interface GenSurfacePayload {
  /**
   * WHICH KIND OF THING IS BEING MADE.
   *
   * The stream used to be image-shaped by assumption: one surface, candidates
   * rendered as `<img>`, and an audio job that pushed into it drew a broken
   * image labelled "Candidate 1". The job knows what it is making and nothing
   * downstream could work it out at `gen:open` (the candidates are still
   * `pending` with no output), so the job says.
   *
   * Now that generation renders INLINE rather than in a canvas tab, this is what
   * picks the card: a picture resolving, or a waveform.
   */
  readonly modality: 'image' | 'video' | 'audio';
  readonly model: { readonly id: string; readonly label: string; readonly license: string };
  readonly prompt?: string;
  /**
   * The shape of the picture/clip being made, when the job fixed one.
   *
   * The inline card takes this aspect ratio from the FIRST event, so the box the
   * finished image lands in is the box the placeholder occupied — no jump at the
   * swap. Without it the card has to guess square and then resize under the
   * reader's eyes on the first decoded step.
   */
  readonly size?: { readonly width: number; readonly height: number };
  readonly candidates: ReadonlyArray<{
    readonly seed?: number;
    readonly previewSrc?: string;
    readonly finalSrc?: string;
    readonly status: 'pending' | 'generating' | 'done' | 'error';
  }>;
  readonly progress?: { readonly candidate: number; readonly step: number; readonly total: number };
  readonly status: 'generating' | 'done' | 'error';
  readonly error?: string;
  /**
   * The last thing the worker said it was doing.
   *
   * the user: "image studio won't work at all and isn't user-friendly to get working
   * in a few clicks even when something has gone wrong." A cold image run spends
   * most of its life BEFORE the first diffusion step — uv provisioning a Python
   * environment (torch is 121 MB on its own), then mflux loading a 4-bit model —
   * and the room said "Starting…" for all of it. MEASURED on his machine: an
   * output folder from 23:16 with nothing in it and no explanation anywhere.
   *
   * The worker already emits these lines on stderr and the manager was dropping
   * them on the floor. They are advisory: never parsed, only shown.
   */
  readonly note?: string;
}

/** main→renderer events. Compose into AppEventMap. */
export type SvgLiveEvent =
  | {
      readonly status: 'drawing';
      /** The drawing so far, as SVG markup (finished shapes + the pen's outline). */
      readonly svg: string;
      readonly paths: number;
      /** Which sample this is, of how many — each starts a fresh drawing. */
      readonly candidate: number;
      readonly candidates: number;
      readonly prompt?: string;
    }
  | {
      readonly status: 'done';
      readonly outputs: readonly {
        readonly path: string;
        readonly svg: string;
        readonly paths: number;
      }[];
      readonly prompt?: string;
    }
  | { readonly status: 'error'; readonly error: string; readonly prompt?: string };

export type GenEventMap = {
  /** A job has started: its first surface state. `tabId` is the stream's id. */
  'gen:open': { tabId: string; payload: GenSurfacePayload };
  /**
   * THE DRAWING, AS IT IS DRAWN. (This replaced `gen:open-file`, which opened
   * a finished SVG as a canvas file tab: the drawing lives in the thread now.) OmniSVG's ids stream in and every few
   * hundred milliseconds the shapes finished so far — plus an outline of the
   * one in progress — go to the thread's card, so the model is seen drawing
   * rather than the card saying "drawing" (the user, 2026-09-21). `done` carries
   * the files that landed, with their markup, for the finished card.
   */
  'gen:svg-live': SvgLiveEvent;
  /** Push updated surface data (step preview / candidate done / finished). */
  'gen:update': { tabId: string; payload: GenSurfacePayload };
  /** ComfyUI install progress (consent / venv / torch / per-pack download / config). */
  'gen:comfy-install': ComfyInstallEvent;
  /**
   * The generation MODULES (gen-modules.ts): every one's readiness, the
   * install in flight with its progress, and which ones a waiting job wants —
   * the card's whole state, pushed on every change.
   */
  'gen:module': readonly GenModuleState[];
  /**
   * The machine's own state, as the guardian judges it (gen/guardian-main.ts).
   *
   * `calm` / `hold` on every change, and `shed` when a running heavy job was
   * just cancelled to keep the computer responsive — with the ids it stopped and
   * the reason, which is what the person who pressed Generate is owed.
   */
  'gen:guardian': GuardianEvent;
};

export interface GuardianEvent {
  /** `pause`: the running heavy work is stopped in place until the machine
   * breathes (see gen/pausables.ts); it resumes on the next calm verdict. */
  readonly verdict: 'calm' | 'hold' | 'pause' | 'shed';
  readonly reason: string;
  /** The OS's own free fraction at the reading, 0..1, when it said. */
  readonly memoryFree?: number;
  /** Job ids cancelled by this verdict (shed only). */
  readonly shed?: readonly string[];
  /** What is stopped in place (pause), or was let run again (the verdict after). */
  readonly paused?: readonly string[];
  readonly resumed?: readonly string[];
  /** Jobs waiting at the time — a hold with none waiting is not worth a banner. */
  readonly queued?: number;
}

/**
 * A plain, JSON-serializable mirror of one `@pi-desktop/gen-service`
 * `ModalityModel` row — the model-browser DTO. Kept structural (NOT a package
 * import) so the RENDERER never value-imports the gen-service barrel; the
 * main-process gen-manager maps `MODALITY_CATALOG` onto this shape and answers
 * `gen:modality-catalog`, and the renderer's `useGenStore` consumes it. Mirrors
 * how `LlmCatalogEntry` surfaces the inference catalog. The union fields
 * (`modality`/`backend`/`license`) are widened here — the browser only groups +
 * labels them, it never re-derives backend behaviour.
 */
export interface ModalityCatalogEntry {
  readonly id: string;
  /** = gen-service `Modality`. Drives the category tab (image/audio/video/3d). */
  readonly modality: 'image' | 'audio' | 'video' | '3d';
  readonly label: string;
  /** = gen-service `Backend` (widened). Splits Audio (TTS) from Music (comfyui). */
  readonly backend: string;
  /** = gen-service `License` (widened). */
  readonly license: string;
  /** False → the row needs a commercial/EULA gate (renders the gated lock pill). */
  readonly commercialUse: boolean;
  readonly approxSizeGB: number;
  readonly minUnifiedMemoryGB?: number;
  readonly runsLocally: boolean;
  readonly heavy: boolean;
  /** Enumerated + gated now, backend lands in a later phase. */
  readonly reserved: boolean;
  /** Vetted first-class pick — renders the green recommended sparkle + heads its grid. */
  readonly recommended: boolean;
  /** HF repo id (provenance / Advanced view). */
  readonly repo?: string;
  readonly notes?: string;
}

/**
 * The modality-catalog surfacing channel — its OWN map (composed into the app
 * contract on its own) so the model browser can read the vetted generation
 * catalog WITHOUT standing up the full generation socket bridge
 * ({@link GenInvokeMap}, which the gen-as-tools phase wires). Answered by the
 * gen-manager's `registerGenCatalogIpc`.
 */
export type GenCatalogInvokeMap = {
  'gen:modality-catalog': { request: undefined; response: { models: ModalityCatalogEntry[] } };
};

export const GEN_CATALOG_INVOKE_CHANNELS = [
  'gen:modality-catalog',
] as const satisfies readonly (keyof GenCatalogInvokeMap)[];

/** renderer→main invoke channels. Compose into AppInvokeMap. */
export type GenInvokeMap = {
  /**
   * START A GENERATION FROM THE RENDERER.
   *
   * Until this existed the ONLY way to generate anything was the agent: the gen
   * bridge is an RPC from the tool server, and `dispatch()` was reachable from
   * nowhere else. Every image the app has ever made came from a model deciding
   * to make one. A studio needs to ask directly, and it must ask through the
   * SAME path — one JobQueue, one cancel, one heavy gate, one asset prompt —
   * rather than growing a second pipeline beside it.
   */
  'gen:generate': {
    request: {
      kind: 'image' | 'video' | 'audio';
      prompt: string;
      model?: string;
      /** image */
      size?: string;
      n?: number;
      negativePrompt?: string;
      /** video */
      seconds?: number;
      fps?: number;
      /** audio */
      audioKind?: 'speech' | 'music' | 'sfx';
      voice?: string;
      speed?: number;
      lang?: string;
      refAudio?: string;
      refText?: string;
      /** shared */
      steps?: number;
      seed?: number;
      /**
       * Classifier-free guidance — how hard the model is pushed to obey the
       * prompt. The worker has always accepted it (`worker.py` builds
       * `--guidance`) and the ComfyUI param map has always mapped it; nothing
       * in the app ever SET it, so the knob that most changes an image after
       * step count was reachable only by editing a workflow by hand.
       */
      guidance?: number;
      /**
       * IMAGE ONLY — an existing picture to work from, and how far to travel
       * from it. `strength` is 0..1 in the ordinary direction: 0 leaves the
       * picture alone, 1 redraws it. (mflux's own `--image-strength` flag runs
       * the OTHER way; worker.py inverts, and is the only place that knows.)
       * Present ⇒ an edit rather than a fresh generation. The engine has always
       * been able to do this; the app never asked.
       */
      inputImage?: string;
      strength?: number;
    };
    response: {
      jobId: string;
      outputs: readonly { path: string; seed?: number; model?: string }[];
      error?: string;
    };
  };
  /**
   * REWRITE ONE PROMPT FOR THE MODEL THAT IS ABOUT TO SEE IT.
   *
   * Lives here rather than in the renderer because the small model's endpoint is
   * a main-process fact (the running local server, or a dedicated enhancer
   * pointed at by env) and because the guidelines are shared with the agent-side
   * generate tools. Never rejects: `prompt` comes back unchanged if there is
   * nothing to ask, so the studio can send the answer straight to `gen:generate`.
   */
  'gen:enhance': {
    request: {
      kind: 'image' | 'video' | 'music' | 'sfx' | 'speech';
      prompt: string;
      model?: string;
    };
    response: { prompt: string; changed: boolean };
  };
  'gen:register': { request: { tabId: string }; response: { ok: boolean } };
  'gen:cancel': { request: { jobId: string }; response: { canceled: boolean } };
  /** Record the one-time GPL-3.0 consent (the disclosure modal's Accept). */
  'gen:comfy-consent': { request: Record<string, never>; response: { ok: boolean } };
  /** Start (or resume) the modular download for the requested packs. */
  'gen:comfy-start': {
    request: { packIds: readonly string[]; acceptedLicenses: readonly ComfyPackLicense[] };
    response: { state: ComfyInstallState };
  };
  /** Current derived install state (runtime + per-pack installed/gate status). */
  'gen:comfy-status': {
    request: { acceptedLicenses?: readonly ComfyPackLicense[] };
    response: { state: ComfyInstallState };
  };
  /** Every module's state, probed fresh. */
  'gen:module-status': { request: Record<string, never>; response: { modules: GenModuleState[] } };
  /** The Download button: start the install (progress arrives on `gen:module`). */
  'gen:module-install': { request: { id: GenModuleId }; response: { modules: GenModuleState[] } };
  /** The card's close: every job waiting on the module stops, with its sentence. */
  'gen:module-dismiss': { request: { id: GenModuleId }; response: { modules: GenModuleState[] } };
};

export const GEN_EVENT_CHANNELS = [
  'gen:open',
  'gen:svg-live',
  'gen:update',
  'gen:comfy-install',
  'gen:module',
] as const satisfies readonly (keyof GenEventMap)[];
export const GEN_INVOKE_CHANNELS = [
  'gen:generate',
  'gen:enhance',
  'gen:register',
  'gen:cancel',
  'gen:comfy-consent',
  'gen:comfy-start',
  'gen:comfy-status',
  'gen:module-status',
  'gen:module-install',
  'gen:module-dismiss',
] as const satisfies readonly (keyof GenInvokeMap)[];
