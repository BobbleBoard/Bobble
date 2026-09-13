/**
 * Message protocol between the main-process host (llm-main.ts) and the
 * "inference-supervisor" utilityProcess (supervisor-entry.ts). Kept in its own
 * electron-free module so both bundles share exactly one set of types.
 */
import type { EngineFlag, LaunchProfile } from '@pi-desktop/inference';
import type {
  HfGgufFileDTO,
  HfModelHitDTO,
  HfSortOption,
  LlmCalibrationProgress,
  LlmCalibrationRecord,
  LlmCatalogEntry,
  LlmHardware,
  LlmRecommendation,
  LlmStatus,
} from '../ipc-contract';
import type { EngineLaunchSettings, ModelSpecChoice } from '../settings/settings-contract';

export type LlmRequestBody =
  | { type: 'get-status' }
  | { type: 'list-catalog' }
  | { type: 'download-model'; modelId: string; quant?: string; hfToken?: string }
  | { type: 'pause-download' }
  | { type: 'cancel-download' }
  | { type: 'delete-model'; modelId: string }
  | { type: 'verify-model'; modelId: string; quant?: string }
  | {
      type: 'start-server';
      modelId: string;
      quant?: string;
      launchMode?: 'fast-text' | 'multimodal';
      /** Fast-text slot count (`--parallel`). The server is launched with
       * `-c = perSlot × parallel` so each slot keeps the full context. Default 1. */
      parallel?: number;
      /**
       * Which engine and speculative method to launch with. Omitted = the
       * calibrated choice for this model on this machine when one is stored,
       * else llama.cpp with the model's declared method.
       */
      profile?: LaunchProfile;
    }
  | { type: 'stop-server' }
  /**
   * CALIBRATE: measure every (engine, method) that can run this model from
   * what is on disk, persist the verdict, and come back up on the winner.
   * Progress streams out as `calibration` messages; the reply carries the
   * record. Defaults to the running model.
   */
  | { type: 'calibrate'; modelId?: string; quant?: string }
  | { type: 'calibrate-cancel' }
  /** The stored verdict for a model, if any. */
  | { type: 'calibration-record'; modelId: string; quant?: string }
  /** Relaunch the running model on a profile the user picked by hand. */
  | { type: 'use-profile'; profile: LaunchProfile }
  /**
   * The user's launch flags per engine and speculative choice per model
   * (Settings → Advanced → Engine). Pushed on change like the power choice;
   * takes effect at the next launch — `relaunch` is how Apply makes that now.
   */
  | {
      type: 'set-engine-launch';
      engineLaunch: EngineLaunchSettings;
      modelSpec: Record<string, ModelSpecChoice>;
    }
  /** Restart the running server with the current flags and profile. */
  | { type: 'relaunch' }
  /** Every flag an engine's CLI prints in its `--help`, parsed (see engine-flags.ts). */
  | { type: 'engine-flags'; engine: string }
  /** Every GGUF under the models directory, with which model it belongs to. */
  | { type: 'list-local-ggufs' }
  /**
   * MAKE ROOM. Stop the running server's process and keep everything needed
   * to bring it back on the same port — for a generation that fits without the
   * chat model and not beside it. Refused when a request is in flight (the
   * server's /slots say so): a turn is never cut. `resume-server` respawns it.
   */
  | { type: 'park-server' }
  | { type: 'resume-server' }
  /**
   * How hard the app may push this machine, and how much memory to hold back.
   *
   * The policy lives in the worker (it is the process that launches servers, so
   * the decision has to be in hand when the args are assembled), but the CHOICE
   * is the user's and lives in settings — this is how it gets across. Applies
   * from the next launch; nothing here touches a running turn.
   */
  | { type: 'set-power'; mode: 'auto' | 'full' | 'low'; reserveGB?: number }
  | {
      type: 'hf-search';
      query: string;
      family?: string;
      task?: string;
      gated?: boolean;
      minLikes?: number;
      sort?: HfSortOption;
      limit?: number;
      hfToken?: string;
      /** One request per author (HF's `author` takes a single handle). */
      authors?: string[];
      ggufOnly?: boolean;
    }
  | { type: 'hf-list-files'; repoId: string; contextWindow?: number; hfToken?: string }
  | {
      type: 'register-hf-model';
      hit: HfModelHitDTO;
      file: HfGgufFileDTO;
      mmproj?: HfGgufFileDTO;
      mtpFile?: HfGgufFileDTO;
      contextWindow?: number;
    };

export type LlmRequest = LlmRequestBody & { id: number };

/** Per-file result of re-hashing a downloaded model against its catalog sha256. */
export interface LlmVerifyFileResult {
  file: string;
  ok: boolean;
  /** Absent when the catalog entry carries no sha256 (nothing to check). */
  checked: boolean;
}

export interface LlmVerifyReply {
  ok: boolean;
  files: LlmVerifyFileResult[];
  error?: string;
}

export interface LlmCatalogReply {
  models: LlmCatalogEntry[];
  hardware: LlmHardware;
  recommendedModelId: string | null;
  recommendation: LlmRecommendation | null;
}

export interface HfSearchReply {
  hits: HfModelHitDTO[];
  error?: string;
  rateLimited?: boolean;
}

export interface HfListFilesReply {
  files: HfGgufFileDTO[];
  gated?: boolean;
  error?: string;
}

export interface HfRegisterReply {
  modelId: string;
  entry: LlmCatalogEntry;
}

export interface EngineFlagsReply {
  engine: string;
  flags: EngineFlag[];
  /** The CLI the help came from, for the panel's title. */
  command: string;
  error?: string;
}

export interface LlmCalibrateReply {
  ok: boolean;
  error?: string;
  record?: LlmCalibrationRecord;
}

export interface LlmDownloadProgress {
  modelId: string;
  file: string;
  received: number;
  total: number | null;
  fraction: number | null;
  /** 0-based index of this file within the download, and how many there are. */
  fileIndex?: number;
  fileCount?: number;
  /** Whole-job position, so the bar never snaps backwards between files. */
  jobReceived?: number;
  jobTotal?: number | null;
}

export type LlmOutbound =
  | { id: number; kind: 'reply'; result: unknown }
  | { id: number; kind: 'error'; error: string }
  | { kind: 'status'; status: LlmStatus }
  | { kind: 'download-progress'; progress: LlmDownloadProgress }
  /** One step of a running calibration, already in the renderer's shape. */
  | { kind: 'calibration'; progress: LlmCalibrationProgress }
  /**
   * The power policy changed its mind about how hard to push this machine.
   *
   * Pushed rather than polled: admission for a heavy generation job happens on a
   * hot path in MAIN, and a round-trip to the worker there would stall the
   * queue. Main caches the last one it heard (`setHeavyJobsAllowed`).
   */
  | {
      kind: 'power';
      level: 'full' | 'easy' | 'gentle';
      /** How gently a heavy generation runs — see PowerDecision.heavyJobPace. */
      heavyJobPace: number;
      heavyJobPreviews: boolean;
      reason: string;
    };

/** Minimal structural view of Electron's `process.parentPort` in the child. */
export interface UtilityParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
