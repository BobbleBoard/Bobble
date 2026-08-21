/**
 * Renderer state for the inference supervisor: mirrors the utilityProcess's
 * status/TPS stream (llm:status) and download progress, and exposes the invoke
 * wrappers the composer footer + the full Model Manager (W10) call — download
 * with pause/resume/cancel/verify, delete, and start/stop.
 */
import { create } from 'zustand';
import type {
  LlmCatalogEntry,
  LlmHardware,
  LlmRecommendation,
  LlmStatus,
} from '../../electron/ipc-contract';
import { useSettingsStore } from './settings-store';

export interface LlmDownloadState {
  modelId: string;
  quant?: string;
  /** The file currently transferring (e.g. `mmproj-F16.gguf`). */
  file: string;
  received: number;
  total: number | null;
  fraction: number | null;
  /** Rolling transfer rate in bytes/sec, or null before a second sample. */
  bytesPerSec: number | null;
  paused: boolean;
  /** Position of `file` within the download, when the source reports it. */
  fileIndex?: number;
  fileCount?: number;
  /**
   * WHOLE-JOB position — what the bar follows. A per-file fraction reaches 100%
   * and restarts at 0% for each companion, which reads as a failed-and-retried
   * download to anyone who has been watching a 13 GB transfer for seven minutes.
   */
  jobReceived?: number;
  jobTotal?: number | null;
}

/** The fraction the UI should show: whole-job when known, else this file's. */
export function downloadFraction(d: LlmDownloadState): number | null {
  const total = d.jobTotal;
  if (total !== null && total !== undefined && total > 0 && d.jobReceived !== undefined) {
    return Math.max(0, Math.min(1, d.jobReceived / total));
  }
  return d.fraction;
}

/** Seconds remaining at the current rate, or null when it cannot be known. */
export function downloadEtaSeconds(d: LlmDownloadState): number | null {
  if (d.paused || d.bytesPerSec === null || d.bytesPerSec <= 0) return null;
  const total = d.jobTotal ?? d.total;
  const received = d.jobTotal !== null && d.jobTotal !== undefined ? d.jobReceived : d.received;
  if (total === null || total === undefined || received === undefined) return null;
  const remaining = total - received;
  if (remaining <= 0) return null;
  return remaining / d.bytesPerSec;
}

/**
 * "45s left" / "3m 20s left" / "2h 15m left".
 *
 * A percentage alone is not enough information to decide whether to wait. 13 GB
 * over a home connection is somewhere between four minutes and an hour, and the
 * difference is the whole question the user is asking the bar.
 */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds > 24 * 3600) return '> 24h left';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m left` : `${m}m ${s % 60}s left`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h left` : `${h}h ${m % 60}m left`;
}

export interface LlmVerifyResult {
  ok: boolean;
  files: Array<{ file: string; ok: boolean; checked: boolean }>;
  error?: string;
}

interface LlmStoreState {
  status: LlmStatus;
  catalog: LlmCatalogEntry[];
  hardware: LlmHardware | null;
  recommendedModelId: string | null;
  recommendation: LlmRecommendation | null;
  download: LlmDownloadState | null;

  applyStatus: (status: LlmStatus) => void;
  applyDownloadProgress: (p: {
    modelId: string;
    file: string;
    received: number;
    total: number | null;
    fraction: number | null;
    fileIndex?: number;
    fileCount?: number;
    jobReceived?: number;
    jobTotal?: number | null;
  }) => void;
  refreshCatalog: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  /** Start OR resume a download; resolves when it finishes, pauses, or fails. */
  downloadModel: (modelId: string, quant?: string) => Promise<void>;
  pauseDownload: () => Promise<void>;
  resumeDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  verifyModel: (modelId: string, quant?: string) => Promise<LlmVerifyResult>;
  /** Start the server for a model. `launchMode:'multimodal'` requests an
   * on-demand vision launch (fetches the mmproj sibling, drops MTP). */
  startServer: (
    modelId: string,
    quant?: string,
    launchMode?: 'fast-text' | 'multimodal',
  ) => Promise<{ success: boolean; error?: string }>;
  stopServer: () => Promise<void>;
}

const initialStatus: LlmStatus = {
  phase: 'idle',
  serverRunning: false,
  baseUrl: null,
  model: null,
  metrics: null,
  downloadedModelIds: [],
};

/** Speed sampling across progress events (module-level: not render state). */
let lastSample: { modelId: string; received: number; at: number } | null = null;

function sampleSpeed(modelId: string, received: number): number | null {
  const now = Date.now();
  const prev = lastSample;
  lastSample = { modelId, received, at: now };
  if (prev === null || prev.modelId !== modelId) return null;
  const dt = (now - prev.at) / 1000;
  const db = received - prev.received;
  if (dt <= 0 || db < 0) return null;
  return db / dt;
}

export const useLlmStore = create<LlmStoreState>((set, get) => ({
  status: initialStatus,
  catalog: [],
  hardware: null,
  recommendedModelId: null,
  recommendation: null,
  download: null,

  // The download lifecycle is owned by the actions (which resolve on
  // finish/pause/cancel), so status transitions must NOT clear the bar — a
  // paused download settles the supervisor to idle while the bar stays up.
  applyStatus: (status) => set({ status }),

  applyDownloadProgress: (p) =>
    set((s) => ({
      download: {
        modelId: p.modelId,
        quant: s.download?.modelId === p.modelId ? s.download.quant : undefined,
        file: p.file,
        received: p.received,
        total: p.total,
        fraction: p.fraction,
        /* Rate is sampled on the JOB counter when there is one. Sampling the
           per-file counter makes the rate go negative at every file boundary
           (received resets), which `sampleSpeed` then discards — so the speed
           and the ETA both blank out exactly when a companion starts. */
        bytesPerSec: sampleSpeed(p.modelId, p.jobReceived ?? p.received),
        paused: false,
        ...(p.fileIndex !== undefined ? { fileIndex: p.fileIndex } : {}),
        ...(p.fileCount !== undefined ? { fileCount: p.fileCount } : {}),
        ...(p.jobReceived !== undefined ? { jobReceived: p.jobReceived } : {}),
        ...(p.jobTotal !== undefined ? { jobTotal: p.jobTotal } : {}),
      },
    })),

  refreshCatalog: async () => {
    const res = await window.piDesktop.invoke('llm:list-catalog', undefined);
    set({
      catalog: res.models,
      hardware: res.hardware,
      recommendedModelId: res.recommendedModelId,
      recommendation: res.recommendation,
    });
  },

  refreshStatus: async () => {
    const status = await window.piDesktop.invoke('llm:get-status', undefined);
    set({ status });
  },

  downloadModel: async (modelId, quant) => {
    lastSample = null;
    set({
      download: {
        modelId,
        quant,
        file: '',
        received: 0,
        total: null,
        fraction: 0,
        bytesPerSec: null,
        paused: false,
      },
    });
    // Gated HF repos need the saved token; public repos ignore it.
    const hfToken = useSettingsStore.getState().settings.hfToken || undefined;
    const res = await window.piDesktop.invoke('llm:download-model', { modelId, quant, hfToken });
    if (res.paused === true) {
      // Keep the bar; flip to the paused affordance (Resume).
      set((s) => (s.download ? { download: { ...s.download, paused: true } } : {}));
    } else {
      set({ download: null });
    }
    await get().refreshCatalog();
  },

  pauseDownload: async () => {
    set((s) => (s.download ? { download: { ...s.download, paused: true } } : {}));
    await window.piDesktop.invoke('llm:pause-download', undefined);
  },

  resumeDownload: async () => {
    const d = get().download;
    if (d === null) return;
    await get().downloadModel(d.modelId, d.quant);
  },

  /*
   * CANCEL IS ACKNOWLEDGED BEFORE IT IS OBEYED. the user: "clicking x cancels
   * (immediate feedback even if download doesn't cancel immediately it shows up
   * that way — progress bar removes and download button restored, partial
   * download auto cleaned and deleted)".
   *
   * The bar used to stay up until the main process answered, which on a slow
   * write is long enough for the click to feel ignored and be pressed again. The
   * supervisor's abort is not in doubt — it discards the `.part` files on the
   * cancel path — so the UI states the outcome first and lets the plumbing catch
   * up. If the abort somehow failed, the next progress event puts the bar back.
   */
  cancelDownload: async () => {
    set({ download: null });
    await window.piDesktop.invoke('llm:cancel-download', undefined);
    await get().refreshCatalog();
  },

  deleteModel: async (modelId) => {
    await window.piDesktop.invoke('llm:delete-model', { modelId });
    await get().refreshStatus();
    await get().refreshCatalog();
  },

  verifyModel: async (modelId, quant) =>
    window.piDesktop.invoke('llm:verify-model', { modelId, quant }),

  startServer: async (modelId, quant, launchMode) => {
    const res = await window.piDesktop.invoke('llm:start-server', {
      modelId,
      quant,
      ...(launchMode !== undefined ? { launchMode } : {}),
    });
    return { success: res.success, error: res.error };
  },

  stopServer: async () => {
    await window.piDesktop.invoke('llm:stop-server', undefined);
  },
}));

let connected = false;

/** Attach the llm event stream to the store (call once at renderer boot). */
export function connectLlm(): void {
  if (connected) return;
  connected = true;
  window.piDesktop.onEvent('llm:status', (status) => useLlmStore.getState().applyStatus(status));

  /*
   * A tool produced an image the text-only server could not read. Main raises this
   * at a TURN BOUNDARY (never mid-turn — going multimodal restarts llama-server and
   * would kill the turn that took the screenshot), and the renderer switches vision
   * on through `ensureVisionMode()`.
   *
   * It has to happen HERE rather than in main: the relaunch moves the server to a
   * NEW PORT, and the pi child holds the old base URL. `ensureVisionMode` owns the
   * whole sequence including respawning the child; a direct supervisor restart from
   * main left the child talking to an address that no longer existed, and the next
   * turn simply never produced a token.
   */
  window.piDesktop.onEvent('llm:vision-wanted', () => {
    void import('./local-model').then(({ ensureVisionMode }) => ensureVisionMode());
  });
  window.piDesktop.onEvent('llm:download-progress', (p) =>
    useLlmStore.getState().applyDownloadProgress({
      modelId: p.modelId,
      file: p.file,
      received: p.received,
      total: p.total,
      fraction: p.fraction,
      fileIndex: p.fileIndex,
      fileCount: p.fileCount,
      jobReceived: p.jobReceived,
      jobTotal: p.jobTotal,
    }),
  );

  // E2E hook (same opt-in as __pi_store): lets the model-manager probe drive
  // download-progress + status deterministically, without a real download.
  if (new URLSearchParams(window.location.search).has('piE2E')) {
    window.__llm_store = () => useLlmStore;
  }
}
