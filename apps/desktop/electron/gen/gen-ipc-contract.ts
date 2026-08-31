/**
 * Renderer↔main IPC contract for generation — its OWN file, mirroring
 * canvas/browser-agent-contract.ts. Self-contained so it does NOT edit the
 * round-12 ipc-contract.ts; the app composes these maps into the global
 * AppEventMap / AppInvokeMap with a one-line spread (see gen-manager.ts header
 * for the exact wire-up).
 *
 * Two directions:
 *   - main→renderer EVENTS (`gen:open` / `gen:update`): stream a generation job's
 *     live surface data so the renderer upserts + updates a `gen-image` canvas
 *     tab (candidate grid + progress + footnote).
 *   - renderer→main INVOKE (`gen:register` / `gen:cancel`): the renderer confirms
 *     it mounted the tab, and the user can cancel a running job.
 *
 * The ComfyUI modular-download install manager (see comfy-install.ts) adds a
 * third pair on the SAME maps: a `gen:comfy-install` progress event (forwarded
 * straight from {@link ComfyInstallEvent}) and the consent / install / status
 * invokes the install UI drives.
 */
import type { ComfyInstallEvent, ComfyInstallState, ComfyPackLicense } from './comfy-install';

/** Structural mirror of @pi-desktop/gen-canvas `GenImageSurfaceData` — kept as a
 * plain payload so Electron MAIN never imports the React surface package. The
 * renderer feeds it straight into `genImageContent(payload)`. */
export interface GenSurfacePayload {
  readonly model: { readonly id: string; readonly label: string; readonly license: string };
  readonly prompt?: string;
  readonly candidates: ReadonlyArray<{
    readonly seed?: number;
    readonly previewSrc?: string;
    readonly finalSrc?: string;
    readonly status: 'pending' | 'generating' | 'done' | 'error';
  }>;
  readonly progress?: { readonly candidate: number; readonly step: number; readonly total: number };
  readonly status: 'generating' | 'done' | 'error';
  readonly error?: string;
}

/** main→renderer events. Compose into AppEventMap. */
export type GenEventMap = {
  /** Open (or focus) the gen-image canvas tab for a job with initial data. */
  'gen:open': { tabId: string; payload: GenSurfacePayload };
  /** Push updated surface data (step preview / candidate done / finished). */
  'gen:update': { tabId: string; payload: GenSurfacePayload };
  /** ComfyUI install progress (consent / venv / torch / per-pack download / config). */
  'gen:comfy-install': ComfyInstallEvent;
};

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
};

export const GEN_EVENT_CHANNELS = [
  'gen:open',
  'gen:update',
  'gen:comfy-install',
] as const satisfies readonly (keyof GenEventMap)[];
export const GEN_INVOKE_CHANNELS = [
  'gen:generate',
  'gen:enhance',
  'gen:register',
  'gen:cancel',
  'gen:comfy-consent',
  'gen:comfy-start',
  'gen:comfy-status',
] as const satisfies readonly (keyof GenInvokeMap)[];
