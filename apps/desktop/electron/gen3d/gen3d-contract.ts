/**
 * gen3d — the 3D-generation engine IPC contract (Bobble 3D studio backend).
 *
 * The studio's stages are backed by REAL local models (all offline after
 * download, run by a uv/Python sidecar on Metal/MPS):
 *   geometry  → microsoft/TRELLIS.2-4B (image → 3D structured latents)
 *   image     → microsoft/Mage-Flow-Turbo (text → image, the text→3D first hop)
 *   texture   → TRELLIS.2 re-bakes from the colour volume it already made
 *   segment   → Roblox/cubepart
 *   retopo    → AutoRemesher (huxingyi, MIT — compiled CLI, no download weight)
 *
 * This file is the SEAM between the renderer UI and the engine: the UI is
 * written against these types only; gen3d-main.ts implements them (stubbed as
 * "not installed" until the sidecar lands). Everything long-running reports
 * through `gen3d:*` events — per-stage progress percents, live stage messages,
 * and ARTIFACTS as soon as they exist (the untextured mesh lands in the viewer
 * the moment geometry finishes, while texturing keeps running).
 */

/** Engine model ids (stable — used in settings, downloads, and the catalog). */
export type Gen3dModelId =
  | 'trellis2'
  | 'mageflow'
  | 'mageflow-edit'
  | 'cubepart'
  | 'autoremesher'
  | 'skintokens'
  | 'humanoid-rig'
  | 'qwen3-tts'
  | 'parakeet-asr'
  | 'dasheng-sfx'
  | 'fluid-1-cleanup'
  | 'ardy-motion';

/** Which studio stage a model backs. */
export type Gen3dRole =
  | 'geometry'
  | 'image'
  | 'texture'
  | 'segment'
  | 'retopo'
  | 'rig'
  /** Text -> an animation clip. Not a studio stage that advances a mesh: it
   * produces a MOTION for a skeleton the rig stage already made, which is why
   * it sits alongside the pipeline rather than inside it. */
  | 'motion'
  /** Text -> speech, text -> sound, speech -> text. Not a studio stage either:
   * these produce audio (or a transcript) rather than advancing a mesh. Mirrors
   * the union in packages/gen3d-engine/src/catalog.ts — a value added to one and
   * not the other is exactly the break that made `pnpm typecheck` red when
   * `skintokens` was added (commit d5f1c85). */
  | 'audio';

/**
 * The 3D module's state, judged from DISK ONLY — no sidecar boot.
 *
 * The sidebar shows whether the studio is installed (and how big it is) on every
 * render; answering that through `gen3d:catalog` would spawn the uv/Python
 * sidecar for someone who may never open the studio. This reads install stamps
 * and nothing else.
 */
export interface Gen3dModuleInfo {
  /** Every core model is on disk. */
  readonly installed: boolean;
  /** Bytes still to fetch for the core set (0 when installed). */
  readonly remainingBytes: number;
}

export interface Gen3dModelInfo {
  readonly id: Gen3dModelId;
  readonly label: string;
  readonly role: Gen3dRole;
  /** Total download size in bytes (0 for compiled tools like AutoRemesher). */
  readonly sizeBytes: number;
  /** Fully downloaded + ready to run. */
  readonly installed: boolean;
  /** A download is currently in flight. */
  readonly downloading: boolean;
  /** Short capability note for the download dialog. */
  readonly note: string;
}

/** The ComfyUI-native 3D path's state — see `gen3d:catalog`. */
export interface Comfy3dInfo {
  /** The ComfyUI module is installed. */
  readonly runtimeReady: boolean;
  /** Every file the default model's graph loads is on its shelf. */
  readonly weightsReady: boolean;
  /** Both — a picture can become a model right now. */
  readonly ready: boolean;
  /** Catalog id of the model the path runs (`trellis2-comfy`). */
  readonly modelId: string;
  /** Rough size of what is still to fetch, GB (runtime + weights). */
  readonly approxGB: number;
}

/** TRELLIS structure resolution presets (verified against the repo by the
 * engine; the UI treats them as low/medium/high). */
export type Gen3dResolution = 'low' | 'medium' | 'high';

/** A generation/stage job's live update. `overallPercent` spans the whole
 * pipeline; `stagePercent` is within the current stage. */
export interface Gen3dJobUpdate {
  readonly jobId: string;
  /** Pipeline position, e.g. 'image' | 'geometry' | 'texture' | 'segment' | 'retopo'. */
  readonly stage: Gen3dRole;
  /** Human stage line, e.g. "Geometry done — texturing (step 12/30)…". */
  readonly message: string;
  readonly stagePercent: number;
  readonly overallPercent: number;
  /** A produced artifact, pushed AS SOON as it exists (geometry-first). */
  readonly artifact?: {
    /** 'model-obj' is a side artifact (the retopo quad mesh — glTF stores only
     * triangles, so the quad topology also ships as OBJ). */
    readonly kind: 'image' | 'model-glb' | 'model-obj';
    /** Absolute path on disk (renderer loads via the pd-file scheme / fs read). */
    readonly path: string;
    /** Label, e.g. "Untextured geometry" / "Textured model" / "Input image". */
    readonly label: string;
    /** A viewer-sized copy to DISPLAY when the real mesh is too heavy for the
     * renderer (TRELLIS geometry has measured 14.2M triangles). `path` stays
     * the full-resolution mesh that downstream stages consume. */
    readonly previewPath?: string;
  };
  /** Rig stage only: what the shape probe measured. */
  readonly humanoid?: Gen3dHumanoidProbe;
  /** Image stage only: a live look at the denoise, mid-flight. */
  readonly preview?: Gen3dJobPreview;
  readonly done: boolean;
  readonly error?: string;
}

/**
 * One intermediate denoising frame from a RUNNING image job — what makes the
 * chat's placeholder show the picture actually resolving rather than a spinner
 * standing in for it.
 *
 * UI-ONLY, and the shape enforces it: an inline data URI with no path, so there
 * is nothing on disk for the asset registry, a canvas tab, a tool result or the
 * session transcript to pick up. Only the finished `artifact` is a real image.
 */
export interface Gen3dJobPreview {
  /** `data:image/jpeg;base64,…` — a downscaled frame, MEASURED at 12-17 KB. */
  readonly dataUri: string;
  /** Sampler step; 0 is the initial pure-noise latent, before any denoising. */
  readonly step: number;
  readonly totalSteps: number;
  /** FULL-resolution dimensions of the image being made — the placeholder
   * grows to THIS aspect ratio, not the thumbnail's. */
  readonly width: number;
  readonly height: number;
}

/** Humanoid measurements behind the rig stage's "humanoid?" question. */
export interface Gen3dHumanoidProbe {
  readonly isHumanoid: boolean;
  readonly confidence: number;
  readonly height: number;
  readonly width: number;
  readonly depth: number;
  readonly armSpanRatio: number;
  readonly reasons: readonly string[];
}

export interface Gen3dDownloadUpdate {
  readonly id: Gen3dModelId;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly done: boolean;
  readonly error?: string;
}

export type Gen3dInvokeMap = {
  /** Is the 3D module on disk, and how much is left to fetch? Disk-only: never
   *  boots the sidecar, so the sidebar can ask on every render. */
  'gen3d:module': { request: undefined; response: Gen3dModuleInfo };
  /** The engine catalog: every model with real sizes + installed state, plus
   * whether the sidecar runtime itself is ready. */
  'gen3d:catalog': {
    request: undefined;
    response: {
      readonly engineReady: boolean;
      /**
       * The runtime is STILL STARTING — a uv/Python boot is in flight. Distinct
       * from `engineReady:false` with no boot, which means it is genuinely not
       * available. Without this the studio drew "the 3D engine runtime is not
       * available" on every launch, because the first catalog call always finds
       * the sidecar down and kicks the boot off behind itself.
       */
      readonly engineBooting: boolean;
      readonly models: readonly Gen3dModelInfo[];
      /** Engine-verified resolution presets, e.g. {low:768, medium:1024, high:1536}. */
      readonly resolutions: Readonly<Record<Gen3dResolution, number>>;
      /**
       * Image → 3D on ComfyUI's own nodes (TRELLIS.2, repackaged by Comfy-Org):
       * the path with nothing to build on this Mac — no git, no Xcode. Ready
       * when the ComfyUI module and the model's weights are both on disk; a
       * generation from a picture runs on it whenever the engine above is not
       * installed, and the gate offers it as the download.
       */
      readonly comfy: Comfy3dInfo;
    };
  };
  /** Start downloading the given models (progress via gen3d:download events). */
  'gen3d:download': {
    request: { readonly ids: readonly Gen3dModelId[] };
    response: { readonly ok: boolean; readonly error?: string };
  };
  'gen3d:cancel-download': {
    request: { readonly id: Gen3dModelId };
    response: { readonly ok: boolean };
  };
  /** Generate a model. kind 'text' runs text→image→3D (Mage-Flow → TRELLIS);
   * kind 'image' starts from one or more input images (TRELLIS-2 does arbitrary
   * unlabeled multi-image conditioning — more images improve accuracy).
   * `texture` chains the native texture bake; `imageOnly` stops after the
   * text→image hop (Image panel). */
  'gen3d:generate': {
    request: {
      readonly kind: 'text' | 'image';
      readonly prompt?: string;
      readonly imagePaths?: readonly string[];
      readonly resolution: Gen3dResolution;
      readonly texture: boolean;
      readonly imageOnly?: boolean;
      /** TRELLIS bake resolution in texels (1024/2048/4096). */
      readonly textureSize?: number;
      /**
       * Cap on the triangles the textures are painted onto. Omit or 0 for
       * Adaptive, which lets the worker pick (it targets the same 300k the
       * reference pipeline defaults to). This was missing, so the UI's Face
       * limit control never reached generation and every model came back at
       * the worker's built-in budget.
       */
      readonly faceBudget?: number;
      /**
       * EDIT this image instead of generating a new one (Mage-Flow-Edit).
       * `prompt` becomes the instruction — "make the dinosaur bright blue" —
       * and the result lands beside the source rather than replacing it, so a
       * user can step back through what they tried before committing to 3D.
       * Only meaningful with `imageOnly`.
       */
      readonly editFrom?: string;
      /**
       * Which engine makes the model. Absent: the Bobble 3D engine when it is
       * installed, ComfyUI otherwise. `comfy` runs the ComfyUI path outright
       * (image input only — it has no text→image hop of its own).
       */
      readonly engine?: 'engine' | 'comfy';
    };
    response: { readonly ok: boolean; readonly jobId?: string; readonly error?: string };
  };
  /** Run a single downstream stage on an existing model file. */
  'gen3d:stage': {
    request: {
      readonly op: 'segment' | 'retopo' | 'texture' | 'rig' | 'motion';
      readonly modelPath: string;
      /** Optional image/prompt context for texturing. */
      readonly prompt?: string;
      /**
       * Texture: the asset's ROOT version on disk.
       *
       * Texturing re-bakes from the colour volume the GENERATION saved, so a
       * mesh that has since been retopologised lives in a different job dir
       * than its colours. This points the engine back at them.
       */
      readonly sourcePath?: string;
      /** Retopo tuning (AutoRemesher target density / curvature adaptivity). */
      readonly targetQuads?: number;
      readonly adaptivity?: number;
      /**
       * Retopo: `quick` is a triangle low-poly by decimation (seconds — MEASURED
       * 7.6 s on a 186k-face jet against 81 s for the quad remesh, and 200 s+
       * for it at low power); `quads` (default) is the QuadriFlow remesh.
       */
      readonly method?: 'quads' | 'quick';
      /** Rig: measure the shape and STOP — the UI asks "humanoid?" from this. */
      readonly probeOnly?: boolean;
      /** Rig: refuse to fit a humanoid skeleton to a non-humanoid mesh. */
      readonly requireHumanoid?: boolean;
      /**
       * Rig: the answered "is this humanoid?" question, which CHOOSES THE
       * RIGGER.
       *
       * true  -> the geometric cskel27 fitter, whose skeleton is ARDY's exact
       *          27-joint hierarchy, so the motion stage can drive it.
       * false -> the medial-axis rigger, which derives the skeleton from the
       *          mesh's own interior and so fits any body plan.
       *
       * Undefined leaves the engine to pick, which is what a probe run does.
       */
      readonly humanoid?: boolean;
      /**
       * Rig: ask for a specific rigger, overriding what `humanoid` implies.
       *
       * The only one the user picks by hand is 'skintokens' — the learned rig,
       * offered AFTER the medial-axis one has run and been looked at, because
       * it costs a 2.5 GB download and predicts a skeleton rather than
       * measuring one (MEASURED: 15 joints for a humanoid mesh).
       */
      readonly rigger?: 'template' | 'medial' | 'skintokens';
      /**
       * Motion: how long a clip to generate, in seconds.
       *
       * Cost is linear — ARDY is autoregressive — so this is a real dial, not a
       * quality setting. `prompt` carries the movement description and is
       * REQUIRED for this op; every other stage acts on the mesh alone.
       */
      readonly seconds?: number;
      /** Motion: pin the root so the clip performs on the spot instead of
       * travelling. What a preset wants — a performance, not a journey. */
      readonly inPlace?: boolean;
      /**
       * Texture: PAINT this image onto the mesh instead of re-baking colours.
       *
       * The engine reaches for it only when the mesh has no colour volume to
       * re-bake from — an imported model, or one generated before texturing
       * existed. That run is the full TRELLIS.2 texturing pipeline rather than
       * an atlas bake, which is why it costs minutes rather than seconds.
       */
      readonly imagePath?: string;
      /** Texture: the voxel resolution the paint pass runs at. */
      readonly resolution?: 'low' | 'medium' | 'high';
      /** Texture: the atlas edge, in texels. */
      readonly textureSize?: 1024 | 2048 | 4096;
    };
    response: { readonly ok: boolean; readonly jobId?: string; readonly error?: string };
  };
  'gen3d:cancel': {
    request: { readonly jobId: string };
    response: { readonly ok: boolean };
  };
};

/** Broadcast events (renderer subscribes via window.piDesktop.onEvent). */
export type Gen3dEventMap = {
  'gen3d:job': Gen3dJobUpdate;
  'gen3d:download': Gen3dDownloadUpdate;
  /** Catalog changed (a download finished / the sidecar came up). */
  'gen3d:catalog-changed': { readonly at: number };
  /**
   * A live dictation session: the transcript so far, growing as you speak.
   *
   * An EVENT rather than the reply to a chunk because the recogniser does not
   * answer per chunk — it emits when it has decided something, which may be
   * after several chunks or in the middle of one.
   */
  'audio:dictation': {
    readonly sessionId: string;
    /** Transcript so far. Provisional: later audio can revise earlier words. */
    readonly partial: string;
  };
};

/**
 * Dictation: recorded microphone bytes in, transcript out.
 *
 * Lives on the gen3d contract because it runs the same audio worker as the
 * other audio ops, but it is NOT a job — no jobId, no progress events, no
 * cancel. One call, one string back. The renderer sends the encoded clip as
 * base64 because Electron's structured clone would otherwise copy a Buffer
 * across the boundary on every keystroke-length recording.
 */
export type DictationInvokeMap = {
  'audio:transcribe': {
    request: {
      /** Base64 of the recorded clip exactly as the browser encoded it. */
      readonly audioBase64: string;
      /** File extension for that encoding, e.g. 'webm' — ffmpeg reads it. */
      readonly extension: string;
    };
    response: { readonly ok: boolean; readonly text?: string; readonly error?: string };
  };
  /**
   * Open a streaming session. Resolves once the recogniser is LOADED, so the
   * renderer can show "listening" only when audio will actually be heard —
   * ~0.9s warm, and the process is kept alive between sessions so the second
   * one is instant.
   */
  'audio:dictation-start': {
    request: Record<string, never>;
    response: { readonly ok: boolean; readonly sessionId?: string; readonly error?: string };
  };
  /** Feed one buffer of float32 mono 16 kHz samples (base64, little-endian). */
  'audio:dictation-chunk': {
    request: { readonly sessionId: string; readonly pcmBase64: string };
    response: { readonly ok: boolean };
  };
  /** End the session and get the FINAL transcript (a full-context re-pass). */
  'audio:dictation-stop': {
    request: { readonly sessionId: string };
    response: { readonly ok: boolean; readonly text?: string; readonly error?: string };
  };
  /** Abandon the session; no transcript, no final pass. */
  'audio:dictation-cancel': {
    request: { readonly sessionId: string };
    response: { readonly ok: boolean };
  };
};

export const DICTATION_INVOKE_CHANNELS = [
  'audio:transcribe',
  'audio:dictation-start',
  'audio:dictation-chunk',
  'audio:dictation-stop',
  'audio:dictation-cancel',
] as const satisfies readonly (keyof DictationInvokeMap)[];

export const GEN3D_INVOKE_CHANNELS = [
  'gen3d:module',
  'gen3d:catalog',
  'gen3d:download',
  'gen3d:cancel-download',
  'gen3d:generate',
  'gen3d:stage',
  'gen3d:cancel',
] as const satisfies readonly (keyof Gen3dInvokeMap)[];
