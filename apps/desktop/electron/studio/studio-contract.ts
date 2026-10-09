/**
 * THE IMAGE & VIDEO STUDIO — the primitive one, running on ComfyUI.
 *
 * The user: "let's have comfy as a downloadable inference engine and then wire up a
 * primitive for now image/video studio) and have those run through it."
 *
 * PRIMITIVE IS THE SPEC, not an apology. What it does is: pick a model you have
 * downloaded, type a prompt, get a picture or a clip. What it deliberately does
 * NOT do yet is expose the graph, batch, chain, or offer the forty knobs Comfy
 * has — those belong to a studio that has earned them by this one working first.
 *
 * WHY THE JOB SHAPE IS THE GEN-SERVICE ONE. `ComfyClient` already speaks
 * `GenJob`/`GenOutput`, the workflow templates already exist, and the supervisor
 * already knows how to start and health-check ComfyUI. This contract is the thin
 * part that was missing: a way for the renderer to ask for one, and to be told
 * how it is going.
 */
export interface StudioStatus {
  /** ComfyUI is installed on this machine (Settings → Engines installs it). */
  readonly engineInstalled: boolean;
  /** The server is up and answering. */
  readonly engineRunning: boolean;
  /** Non-null when the last start attempt failed, so the panel can say why. */
  readonly error?: string;
}

export interface StudioGenerateRequest {
  readonly kind: 'image' | 'video';
  readonly prompt: string;
  /** Store model id (the slug), which the main side turns into a workflow. */
  readonly modelId: string;
  readonly width?: number;
  readonly height?: number;
  readonly steps?: number;
  /** Video only: how many frames. */
  readonly frames?: number;
  readonly seed?: number;
}

export interface StudioProgress {
  readonly jobId: string;
  readonly phase: 'starting' | 'running' | 'done' | 'error';
  /** 0..1 while running; absent before the first step lands. */
  readonly fraction?: number;
  /** Absolute paths of what it produced, on `done`. */
  readonly outputs?: readonly string[];
  readonly error?: string;
}

export type StudioInvokeMap = {
  'studio:status': { request: undefined; response: StudioStatus };
  'studio:generate': {
    request: StudioGenerateRequest;
    response: { readonly ok: boolean; readonly jobId?: string; readonly error?: string };
  };
  'studio:cancel': { request: { readonly jobId: string }; response: { readonly ok: boolean } };
};

export type StudioEventMap = {
  'studio:progress': StudioProgress;
};

export const STUDIO_INVOKE_CHANNELS = [
  'studio:status',
  'studio:generate',
  'studio:cancel',
] as const;
