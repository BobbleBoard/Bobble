/**
 * Renderer state for the inference supervisor: mirrors the utilityProcess's
 * status/TPS stream (llm:status) and download progress, and exposes the invoke
 * wrappers the composer footer + the full Model Manager (W10) call — download
 * with pause/resume/cancel/verify, delete, and start/stop.
 */
import { parseLiveTpsLine } from '@pi-desktop/provider-llamacpp/live-tps';
import { create } from 'zustand';
import type {
  EngineState,
  LlmCalibrationProgress,
  LlmCalibrationRecord,
  LlmCatalogEntry,
  LlmHardware,
  LlmInvokeMap,
  LlmRecommendation,
  LlmStatus,
} from '../../electron/ipc-contract';
import { defaultEngineSet } from '../settings/engine-catalog';
import { hostGpuOf } from '../settings/host-gpu';
import { useDownloadTray } from './download-tray';
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

/**
 * Tokens per second of the reply being generated RIGHT NOW, from the
 * provider's `[pi-tps]` stderr lines (provider-llamacpp/live-tps.ts). `done`
 * flips when the stream ends and the last figure stays up as "last reply".
 */
export interface LiveTps {
  tps: number;
  tokens: number;
  done: boolean;
  at: number;
}

/** The parsed `--help` of one engine, as `llm:engine-flags` returns it. */
export type EngineFlagsView = LlmInvokeMap['llm:engine-flags']['response'];

/** What the engine menu draws while (and after) a calibration runs. */
export interface CalibrationView {
  running: boolean;
  candidates: Array<{ id: string; engine: string; spec: string; label: string }>;
  skips: Array<{ id: string; engine: string; spec: string; label: string; reason: string }>;
  /** Per candidate id: measured, failed, or in progress. */
  rows: Record<
    string,
    | { state: 'starting' | 'measuring' }
    | {
        state: 'done';
        ok: boolean;
        error?: string;
        decodeTps: number;
        prefillTps: number;
        ttftMs: number;
        startupMs: number;
      }
  >;
  index: number;
  total: number;
  chosen: { engine: string; spec: string } | null;
  record: LlmCalibrationRecord | null;
  error: string | null;
}

interface LlmStoreState {
  status: LlmStatus;
  catalog: LlmCatalogEntry[];
  hardware: LlmHardware | null;
  recommendedModelId: string | null;
  recommendation: LlmRecommendation | null;
  download: LlmDownloadState | null;
  /**
   * Why the last download did not start or did not finish — "Not enough
   * space: …", a 401 on a gated repo — kept until the next attempt, so every
   * Download button can say it where it was pressed. the user: "clicking download
   * … does not download them or show any user indication … either that
   * there's not enough disk space or that it is downloading."
   */
  downloadError: { modelId: string; error: string; at: number } | null;
  clearDownloadError: () => void;
  /** The reply streaming now (or the last one), see LiveTps. */
  live: LiveTps | null;
  /** Engines as main reports them (installed / busy / error), by id. */
  engines: Record<string, EngineState>;
  calibration: CalibrationView | null;
  /** The stored verdict for the running model, when one exists. */
  record: LlmCalibrationRecord | null;

  applyStatus: (status: LlmStatus) => void;
  applyLiveTps: (line: string) => void;
  applyCalibration: (p: LlmCalibrationProgress) => void;
  refreshEngines: () => Promise<void>;
  installEngine: (id: string) => Promise<{ success: boolean; error?: string }>;
  refreshRecord: () => Promise<void>;
  /** Measure every engine + method for the running model, then swap to the winner. */
  calibrate: () => Promise<{ ok: boolean; error?: string }>;
  cancelCalibration: () => Promise<void>;
  /** Relaunch the running model on an engine + method picked by hand. */
  switchProfile: (engine: string, spec: string) => Promise<{ success: boolean; error?: string }>;
  /** Every flag an engine accepts (its own `--help`, parsed), cached per engine. */
  engineFlags: Record<string, EngineFlagsView>;
  loadEngineFlags: (engine: string) => Promise<EngineFlagsView>;
  /** Apply: restart the running server with the saved launch flags. */
  relaunch: () => Promise<{ success: boolean; error?: string }>;
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
  /** Take the bar down for a download that finished OUTSIDE `downloadModel` —
   * a model connector's install streams the same progress events but resolves
   * through `connectors:install`, so nothing here saw it end. Scoped to the
   * model so a concurrent download of another model keeps its bar. */
  settleDownload: (modelId: string) => void;
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
  downloadError: null,
  live: null,
  engines: {},
  calibration: null,
  record: null,
  engineFlags: {},

  // The download lifecycle is owned by the actions (which resolve on
  // finish/pause/cancel), so status transitions must NOT clear the bar — a
  // paused download settles the supervisor to idle while the bar stays up.
  applyStatus: (status) => {
    const before = get().status;
    set({ status });
    // A different model (or launch) came up: the stored verdict shown is for
    // the model that is running, so fetch its own.
    if (
      status.model?.id !== before.model?.id ||
      status.model?.quant !== before.model?.quant ||
      (status.phase === 'ready' && before.phase !== 'ready')
    ) {
      void get().refreshRecord();
    }
  },

  applyLiveTps: (line) => {
    const parsed = parseLiveTpsLine(line);
    if (parsed === null) return;
    // The first line arrives with the first token (ms=0): nothing to divide by yet.
    if (parsed.ms < 150 && !parsed.done) return;
    const tps = parsed.ms > 0 ? (parsed.tokens / parsed.ms) * 1000 : 0;
    set({ live: { tps, tokens: parsed.tokens, done: parsed.done, at: Date.now() } });
  },

  applyCalibration: (p) =>
    set((s) => {
      const base: CalibrationView = s.calibration ?? {
        running: true,
        candidates: [],
        skips: [],
        rows: {},
        index: 0,
        total: 0,
        chosen: null,
        record: null,
        error: null,
      };
      switch (p.stage) {
        case 'planned':
          return {
            calibration: {
              ...base,
              running: true,
              candidates: p.candidates,
              skips: p.skips,
              rows: {},
              total: p.candidates.length,
              index: 0,
              chosen: null,
              record: null,
              error: null,
            },
          };
        case 'starting':
        case 'measuring':
          return {
            calibration: {
              ...base,
              running: true,
              index: p.index,
              total: p.total,
              rows: { ...base.rows, [p.id]: { state: p.stage } },
            },
          };
        case 'result':
          return {
            calibration: {
              ...base,
              rows: {
                ...base.rows,
                [p.result.id]: {
                  state: 'done',
                  ok: p.result.ok,
                  ...(p.result.error !== undefined ? { error: p.result.error } : {}),
                  decodeTps: p.result.decodeTps,
                  prefillTps: p.result.prefillTps,
                  ttftMs: p.result.ttftMs,
                  startupMs: p.result.startupMs,
                },
              },
            },
          };
        case 'switching':
          return { calibration: { ...base, chosen: p.chosen } };
        case 'done':
          return {
            calibration: { ...base, running: false, record: p.record, chosen: p.record.chosen },
            record: p.record,
          };
        case 'cancelled':
          return { calibration: { ...base, running: false, error: 'cancelled' } };
        case 'failed':
          return { calibration: { ...base, running: false, error: p.error } };
        default:
          return {};
      }
    }),

  refreshEngines: async () => {
    const res = await window.piDesktop.invoke('engines:list', undefined).catch(() => null);
    if (res === null) return;
    set({ engines: Object.fromEntries(res.engines.map((e) => [e.id, e])) });
  },

  installEngine: async (id) => {
    const res = await window.piDesktop
      .invoke('engines:install', { id })
      .catch((e: unknown) => ({ success: false, error: String(e) }));
    await get().refreshEngines();
    return res;
  },

  refreshRecord: async () => {
    const m = get().status.model;
    if (m === null || m === undefined) {
      set({ record: null });
      return;
    }
    const res = await window.piDesktop
      .invoke('llm:calibration-record', { modelId: m.id, quant: m.quant })
      .catch(() => null);
    set({ record: res?.record ?? null });
  },

  calibrate: async () => {
    const m = get().status.model;
    if (m === null || m === undefined) return { ok: false, error: 'no model is running' };
    set({
      calibration: {
        running: true,
        candidates: [],
        skips: [],
        rows: {},
        index: 0,
        total: 0,
        chosen: null,
        record: null,
        error: null,
      },
    });
    const res = await window.piDesktop
      .invoke('llm:calibrate', { modelId: m.id, quant: m.quant })
      .catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res.ok) {
      set((s) => ({
        calibration: s.calibration
          ? { ...s.calibration, running: false, error: res.error ?? 'failed' }
          : null,
      }));
      return { ok: false, error: res.error };
    }
    // The server was swapped underneath pi; point it at the winner.
    const { repointPiAtRunningServer } = await import('./local-model');
    await repointPiAtRunningServer(m.id);
    await get().refreshRecord();
    return { ok: true };
  },

  cancelCalibration: async () => {
    await window.piDesktop.invoke('llm:calibrate-cancel', undefined).catch(() => undefined);
  },

  loadEngineFlags: async (engine) => {
    const cached = get().engineFlags[engine];
    if (cached !== undefined && cached.flags.length > 0) return cached;
    const res = await window.piDesktop
      .invoke('llm:engine-flags', { engine })
      .catch((e: unknown) => ({ engine, command: '', flags: [], error: String(e) }));
    set((s) => ({ engineFlags: { ...s.engineFlags, [engine]: res } }));
    return res;
  },

  relaunch: async () => {
    const res = await window.piDesktop
      .invoke('llm:relaunch', undefined)
      .catch((e: unknown) => ({ success: false, error: String(e) }));
    if (res.success) {
      // The server moved to a new port; point pi at it.
      const { repointPiAtRunningServer } = await import('./local-model');
      await repointPiAtRunningServer();
    }
    return res;
  },

  switchProfile: async (engine, spec) => {
    const res = await window.piDesktop
      .invoke('llm:use-profile', { engine, spec })
      .catch((e: unknown) => ({ success: false, error: String(e) }));
    if (res.success) {
      const { repointPiAtRunningServer } = await import('./local-model');
      await repointPiAtRunningServer();
    }
    return res;
  },

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

  clearDownloadError: () => set({ downloadError: null }),

  downloadModel: async (modelId, quant) => {
    lastSample = null;
    set({
      downloadError: null,
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
    const name = get().catalog.find((c) => c.id === modelId)?.displayName ?? modelId;
    if (res.paused === true) {
      // Keep the bar; flip to the paused affordance (Resume).
      set((s) => (s.download ? { download: { ...s.download, paused: true } } : {}));
    } else {
      set({ download: null });
      // A refusal (no room, a gated repo) or a failure is the user's to see —
      // the bar that flashed and vanished used to be the whole message.
      if (res.success !== true && res.cancelled !== true) {
        const error = res.error ?? 'the download did not finish';
        set({ downloadError: { modelId, error, at: Date.now() } });
        useDownloadTray
          .getState()
          .note({ key: `llm:${modelId}`, name, kind: 'failed', detail: error });
      } else if (res.success === true) {
        useDownloadTray.getState().note({ key: `llm:${modelId}`, name, kind: 'finished' });
      }
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
  settleDownload: (modelId) =>
    set((s) => (s.download?.modelId === modelId ? { download: null } : {})),

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
  window.piDesktop.onEvent('llm:calibration', (p) => useLlmStore.getState().applyCalibration(p));
  /*
   * The live tok/s readout rides on pi's stderr: the provider prints a
   * `[pi-tps]` line a few times a second while a reply streams (see
   * provider-llamacpp/live-tps.ts), and pi's stderr already reaches the
   * renderer as `_stderr` events. No new event type, no polling.
   */
  window.piDesktop.onEvent('pi:event', (event) => {
    const e = event as { type?: string; text?: string };
    if (e.type === '_stderr' && typeof e.text === 'string' && e.text.includes('[pi-tps]')) {
      for (const line of e.text.split('\n')) {
        if (line.includes('[pi-tps]')) useLlmStore.getState().applyLiveTps(line);
      }
    }
  });

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

/**
 * THE FIRST-RUN ENGINE SET, fetched in the background once the app is up.
 *
 * the user: "download a few generally good engines at the start of downloading the
 * app". Which ones is the catalogue's per-platform answer (`defaultEngineSet`);
 * main installs whatever of them is missing, one after another, and the
 * engine menu's rows fill in as they land. Skipped offline (there is nothing
 * to fetch from) and under the e2e flag (a probe must not write a venv into
 * the real cache). Never throws: a machine that cannot install stays as it is
 * and Settings → Engines says so per row.
 */
export async function ensureDefaultEngines(): Promise<void> {
  try {
    if (!navigator.onLine) return;
    if (new URLSearchParams(window.location.search).has('piE2E')) return;
    const info = await window.piDesktop.invoke('app:get-info', undefined);
    // The card matters for the set (NInfer is fetched for the card it was built
    // for): make sure the hardware probe has answered before deciding.
    if (useLlmStore.getState().hardware === null) await useLlmStore.getState().refreshCatalog();
    const ids = defaultEngineSet({
      platform: info.platform === 'darwin' || info.platform === 'win32' ? info.platform : 'linux',
      appleSilicon: info.platform === 'darwin' && info.arch === 'arm64',
      gpu: hostGpuOf(useLlmStore.getState().hardware),
    });
    if (ids.length === 0) return;
    const listed = await window.piDesktop.invoke('engines:list', undefined);
    const missing = ids.filter((id) => listed.engines.find((e) => e.id === id)?.installed !== true);
    if (missing.length === 0) return;
    await window.piDesktop.invoke('engines:ensure', { ids: missing });
    await useLlmStore.getState().refreshEngines();
  } catch {
    // Best effort by design.
  }
}
