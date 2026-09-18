/**
 * The app's typed IPC surface. Main, preload, and renderer all import from
 * this single module, so a contract change breaks the compile on every side.
 * Channel maps must be `type` aliases (not interfaces) to satisfy the
 * IpcInvokeMap / IpcEventMap constraints in @pi-desktop/shared.
 */
import type { CanvasState } from '@pi-desktop/browser-use/protocol';
import type { IpcClient, IpcEventMap, IpcInvokeMap } from '@pi-desktop/shared';
import { AFM_INVOKE_CHANNELS, type AfmInvokeMap } from './afm/afm-contract';
import {
  BROWSER_AGENT_INVOKE_CHANNELS,
  type BrowserAgentEventMap,
  type BrowserAgentInvokeMap,
} from './canvas/browser-agent-contract';
import {
  BROWSER_INVOKE_CHANNELS,
  type BrowserEventMap,
  type BrowserInvokeMap,
} from './canvas/browser-contract';
import {
  CONNECTORS_INVOKE_CHANNELS,
  type ConnectorsInvokeMap,
} from './connectors/connectors-contract';
import { CORP_INVOKE_CHANNELS, type CorpEventMap, type CorpInvokeMap } from './corp/corp-contract';
import {
  GEN_CATALOG_INVOKE_CHANNELS,
  GEN_INVOKE_CHANNELS,
  type GenCatalogInvokeMap,
  type GenEventMap,
  type GenInvokeMap,
} from './gen/gen-ipc-contract';
import {
  DICTATION_INVOKE_CHANNELS,
  type DictationInvokeMap,
  GEN3D_INVOKE_CHANNELS,
  type Gen3dEventMap,
  type Gen3dInvokeMap,
} from './gen3d/gen3d-contract';
import { IMPORT_INVOKE_CHANNELS, type ImportInvokeMap } from './import/import-contract';
import {
  MAC_MONITOR_INVOKE_CHANNELS,
  type MacMonitorEventMap,
  type MacMonitorInvokeMap,
} from './mac/mac-monitor-contract';
import {
  STORE_INVOKE_CHANNELS,
  type StoreEventMap,
  type StoreInvokeMap,
} from './model-store/store-contract';
import {
  OFFICE_INVOKE_CHANNELS,
  type OfficeEventMap,
  type OfficeInvokeMap,
} from './office/office-contract';
import { PI_INVOKE_CHANNELS, type PiEventMap, type PiInvokeMap } from './pi/contract';
import { PROJECT_INVOKE_CHANNELS, type ProjectInvokeMap } from './project/project-contract';
import {
  SCHEDULED_INVOKE_CHANNELS,
  type ScheduledEventMap,
  type ScheduledInvokeMap,
} from './scheduled/scheduled-contract';
import { SETTINGS_INVOKE_CHANNELS, type SettingsInvokeMap } from './settings/settings-contract';
import { SKILLS_INVOKE_CHANNELS, type SkillsInvokeMap } from './skills/skills-contract';
import {
  STORAGE_INVOKE_CHANNELS,
  type StorageEventMap,
  type StorageInvokeMap,
} from './storage/storage-contract';
import {
  STUDIO_INVOKE_CHANNELS,
  type StudioEventMap,
  type StudioInvokeMap,
} from './studio/studio-contract';
import { PTY_INVOKE_CHANNELS, type PtyEventMap, type PtyInvokeMap } from './terminal/pty-contract';

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  /** `process.platform` value, e.g. `darwin`. */
  platform: string;
  /** `process.arch`, e.g. `arm64`. Distinguishes Apple Silicon from an Intel
   * Mac, which decides whether the MLX engines can run at all. */
  arch: string;
  /** Total system memory in bytes, for the model hub's hardware strip. Shown
   * because every download decision is made against it — a hardcoded figure
   * there would be decoration pretending to be information. */
  totalMemoryBytes: number;
  /** Logical CPU count, same strip. */
  cpuCount: number;
}

/** Core app channels, registered exhaustively via registerIpcHandlers in
 * main.ts. pi channels live in ./pi/contract.ts and are registered separately
 * (their handlers need the sender WebContents to route to a per-window
 * bridge); both groups compose into the maps below for preload/renderer. */
export type CoreInvokeMap = {
  'app:get-info': { request: undefined; response: AppInfo };
  /**
   * Tell the user a background chat finished or needs them — an OS notification
   * plus a dock badge.
   *
   * ONLY WHEN THE APP IS NOT LOOKED AT. A notification for something happening
   * on screen is noise, and main is the side that knows whether the window has
   * focus; the renderer's `document.hasFocus()` is true for a window behind
   * another app on some platforms.
   *
   * `sessionFile` comes back through `app:notification-click` so the click
   * lands on the chat it was about rather than just raising the window.
   */
  'app:notify': {
    request: {
      title: string;
      body: string;
      sessionFile: string;
      kind: 'finished' | 'needs-input';
    };
    response: { shown: boolean; reason?: string };
  };
  /** Set the dock badge to a count of unread chats; 0 clears it. */
  'app:set-badge': { request: { count: number }; response: { ok: boolean } };
  /**
   * RELOAD THE DOCUMENT — the hard one, and the only one that works.
   *
   * `window.location.reload()` from the renderer is a renderer-initiated
   * navigation, and main blocks every one of those (`will-navigate` →
   * preventDefault, main.ts). That is right — the app must never navigate — but
   * it also made the crash card's two buttons inert: the user, on the render-error
   * screen, "the reload buttons do not work", and he had to reach for ⌘R.
   *
   * So the reload asks MAIN to do it, where it is a programmatic
   * `webContents.reload()` rather than a navigation to be refused.
   *
   * `fresh: true` reloads from the entry point with no query at all — the
   * "fresh window" the crash card offers, which drops any dev/route params the
   * window was carrying along with every scrap of renderer state.
   */
  'app:reload-window': { request: { fresh?: boolean }; response: { ok: boolean } };
};

// ---------------------------------------------------------------------------
// Filesystem channels (read-only; back the composer picker + session sidebar)
// ---------------------------------------------------------------------------

/** One recent pi session, summarised from its JSONL header + first user turn. */
export interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  cwdLabel: string;
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  firstUserText: string | null;
  title: string;
  /**
   * The session file this one CONTINUES, when pi forked it from another.
   *
   * pi does not append on resume: restarting the child with `--session <file>`
   * writes a NEW file carrying the whole history and a `parentSession` pointer
   * back. Every restart therefore used to add another identically-titled row to
   * the sidebar — measured on the user's machine, one conversation about spoofdpi
   * had become NINE rows, three of them created within seven seconds of each
   * other. The pointer is surfaced so the listing can keep only the tip of each
   * chain (see `listAllSessions`).
   */
  parentSession: string | null;
  /**
   * The session files this row stands in for — its own superseded ancestors.
   *
   * The listing keeps only the tip of each resume chain, but the RENDERER may
   * still be pointing at an ancestor (the store's `sessionFile` is whatever pi
   * last announced, and a restart forks a new file underneath it). Without this
   * the sidebar would draw an optimistic row for the old file BESIDE the tip —
   * two rows for one chat, which is the bug the collapsing exists to fix.
   */
  supersedes: readonly string[];
  /**
   * Where the search query appears in the conversation, when one was given and
   * the title did not already contain it.
   *
   * Present only for a content match: sidebar search used to compare against
   * the title alone, which is the first user message truncated to 80
   * characters — so a phrase from message 40 of a long chat was unfindable, and
   * the chat you remembered by what was SAID in it was the one you could not
   * get back to.
   */
  match?: { excerpt: string };
}

/**
 * One node in a bounded directory tree (fs:list-tree). Structural mirror of
 * @pi-desktop/canvas's `FileTreeNode` — kept as a plain contract type so the
 * main bundle never imports the canvas React package; the renderer passes the
 * shape straight through to `CanvasTab.fileTree`.
 */
export interface FsTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FsTreeNode[];
}

export type FsInvokeMap = {
  /** Fuzzy file search from a cwd, for @-mention autocomplete. */
  'fs:list-files': {
    request: { cwd?: string; query: string; limit?: number };
    response: Array<{ path: string; rel: string }>;
  };
  /** Recent sessions, optionally filtered to one cwd (sidebar). */
  'fs:list-sessions': {
    request: { cwd?: string; query?: string } | undefined;
    response: SessionSummary[];
  };
  /** Raw session JSONL text (fenced to the sessions dir) for rehydration. */
  'fs:read-session': { request: { file: string }; response: { text: string | null } };
  /** A bounded directory tree rooted at `root` (the file operation bar's tree
   * panel). Depth/entry-count capped; the usual junk dirs are skipped. */
  'fs:list-tree': {
    request: { root: string; depth?: number };
    response: { root: string; tree: FsTreeNode[] };
  };
  /** UTF-8 contents of a single file, size-capped, for the live canvas file
   * surface. `tooLarge`/`binary` gate streaming huge/binary payloads. */
  'fs:read-file': {
    request: { path: string; maxBytes?: number };
    response: {
      text: string | null;
      truncated: boolean;
      tooLarge: boolean;
      binary: boolean;
      bytes: number;
    };
  };
  /** Write UTF-8 contents back to a single file for live canvas editing.
   * Fenced to allowed roots (cwd/project/session dirs); refuses paths outside
   * them and refuses to create a file where a directory exists. */
  'fs:write-file': {
    request: { path: string; content: string };
    response: { ok: boolean; bytes?: number; error?: string };
  };
  /** Delete a session's JSONL file (the sidebar "Delete chat" action). Fenced to
   * the sessions dir — refuses any path outside it. */
  'fs:delete-session': {
    request: { file: string };
    response: { ok: boolean; error?: string };
  };
  /**
   * A chat as a file someone can keep: Markdown for a person, the raw JSONL
   * verbatim for anything that reads it back.
   *
   * `to:'clipboard'` returns the text instead of writing a file — the renderer
   * owns the clipboard, and round-tripping through a save dialog to copy a
   * paragraph would be absurd. A cancelled save is `ok:false` with no error.
   */
  /**
   * The instruction files loaded for a working directory — the AGENTS.md chain.
   *
   * The model reads these on every turn and the user could not see which ones,
   * so "why did it do that" had an answer nothing in the app would show. pi's
   * RPC state carries no context-file field, so this recomputes with pi's own
   * `loadProjectContextFiles` rather than inventing a second walk that could
   * disagree with the one that actually loaded.
   */
  'fs:project-instructions': {
    request: { cwd: string };
    /** `label` is the path with `~` collapsed — main knows HOME, the renderer does not. */
    response: { files: Array<{ path: string; label: string; bytes: number }> };
  };
  'fs:export-session': {
    request: {
      file: string;
      format: 'markdown' | 'jsonl';
      title: string;
      to: 'file' | 'clipboard';
    };
    response: { ok: boolean; savedTo?: string; text?: string; error?: string };
  };
};

export const FS_INVOKE_CHANNELS = [
  'fs:list-files',
  'fs:list-sessions',
  'fs:read-session',
  'fs:list-tree',
  'fs:read-file',
  'fs:write-file',
  'fs:delete-session',
  'fs:export-session',
  'fs:project-instructions',
] as const satisfies readonly (keyof FsInvokeMap)[];

// ---------------------------------------------------------------------------
// Inference channels (utilityProcess "inference-supervisor"; folds in W4)
// ---------------------------------------------------------------------------

export interface LlmModelInfo {
  id: string;
  displayName: string;
  quant: string;
  contextWindow: number;
}

export type LlmPhase = 'idle' | 'downloading' | 'starting' | 'ready' | 'error';

export interface LlmStatus {
  phase: LlmPhase;
  serverRunning: boolean;
  baseUrl: string | null;
  model: LlmModelInfo | null;
  metrics: { lastTps?: number; avgTps?: number } | null;
  downloadedModelIds: string[];
  /** The launch mode of the currently-running server, so the app knows whether
   * vision (multimodal) is already on before requesting an on-demand restart. */
  launchMode?: 'fast-text' | 'multimodal';
  /**
   * Whether the RUNNING server can actually read an image.
   *
   * Distinct from `launchMode`, and that distinction is the point. The vision
   * projector is now attached on every launch (measured cost: 0.9%), so a
   * plain `fast-text` server can already see — but the app went on deciding
   * "can it see?" from the launch mode, wrote "no", and relaunched into
   * multimodal on the first image to gain a capability it already had.
   */
  visionReady?: boolean;
  /**
   * Set while an ENGINE is being compiled rather than a model loaded.
   *
   * A model whose architecture the shipped llama.cpp does not have is launched
   * on a variant built from source (llamacpp-variants.ts), and that is a
   * multi-minute compile the first time — MEASURED at 3m41s for K2 Horizon on an
   * M5 Pro. Without this the status is `starting` and the composer says "Loading
   * model…" for four silent minutes, which is indistinguishable from a hang. The
   * note says what is actually happening and that it happens once.
   */
  engineBuild?: { variantId: string; note: string };
  /**
   * The server's process is stopped ON PURPOSE to make room for a generation
   * and comes back on the same URL when it finishes. `serverRunning` stays
   * true and `phase` stays `ready` while parked: nothing that decides on those
   * (the auto-router above all) should start another model into the gap. The
   * text is what to show for it.
   */
  parked?: string;
  /**
   * How the running server was launched: which engine and which speculative
   * method. Absent while nothing is up. `provider` is the models.json key the
   * server was registered under — `llamacpp` for llama-server, `mlx` for every
   * OpenAI-compatible engine (they all bind to the mlx-stream provider) — so
   * the renderer points pi at the right block after a swap.
   */
  profile?: { engine: string; spec: string };
  provider?: 'llamacpp' | 'mlx';
  /**
   * The model id the running server answers to — `<catalog id>@<engine>` on an
   * external engine (`--served-model-name`), or the path it was given (dflash,
   * mlx-dspark, mlx-lm). The utility endpoint (warm-up, titler, reviewer) must
   * send THIS: MEASURED 2026-09-13, rapid-mlx answered 404 to the catalog id and
   * the warm-up silently never primed an MLX engine.
   */
  servedModelId?: string;
  /** A calibration is running: the server is being swapped in and out. */
  calibrating?: boolean;
  /**
   * The command line the running server was launched with — the whole
   * truth, for the panel's "current command" view — and a fingerprint of
   * the user's part of it (flags + speculative choice), so the panel's Apply
   * can light up exactly when the saved settings differ from what is running.
   */
  launchArgs?: string[];
  launchCommand?: string;
  launchConfigFingerprint?: string;
  /** The `--spec-type` values the running llama.cpp build accepts. */
  engineSpecTypes?: string[];
  error?: string;
}

/** One measured (engine, method), as the menu shows it. */
export interface LlmCalibrationRow {
  id: string;
  engine: string;
  spec: string;
  ok: boolean;
  error?: string;
  prefillTps: number;
  decodeTps: number;
  ttftMs: number;
  startupMs: number;
  /** Relative to llama.cpp plain (1.0 = the same). */
  score: number;
}

/** A calibration's verdict, persisted per model on this machine. */
/**
 * One thing the catalogue names beside a model. `present` is whether its
 * download FINISHED (a half-fetched tree never counts).
 */
export interface LlmCompanion {
  /** `mlx` twin, `mlx-mtp` / `mlx-dflash` / `mlx-dspark` heads, `gguf-eagle3|dflash|dspark` drafters, `mtp` sidecar, `mmproj`. */
  kind: string;
  /** What to call it in a sentence: "MLX weights", "DFlash drafter (MLX)". */
  what: string;
  /** The repo (or file) it comes from. */
  source: string;
  present: boolean;
}

export interface LlmCalibrationRecord {
  modelId: string;
  quant: string;
  hardwareKey: string;
  engineBuild: string;
  at: string;
  ranked: LlmCalibrationRow[];
  skips: Array<{ id: string; engine: string; spec: string; reason: string; fix?: string }>;
  chosen: { engine: string; spec: string } | null;
}

export type LlmCalibrationProgress =
  | {
      stage: 'planned';
      candidates: Array<{ id: string; engine: string; spec: string; label: string }>;
      skips: Array<{ id: string; engine: string; spec: string; label: string; reason: string }>;
    }
  | { stage: 'starting'; id: string; index: number; total: number }
  | { stage: 'measuring'; id: string; index: number; total: number }
  | {
      stage: 'result';
      result: Omit<LlmCalibrationRow, 'score' | 'engine' | 'spec'>;
      index: number;
      total: number;
    }
  | { stage: 'switching'; chosen: { engine: string; spec: string } }
  | { stage: 'done'; record: LlmCalibrationRecord }
  | { stage: 'cancelled' }
  | { stage: 'failed'; error: string };

/** A speed variant a model can launch with (MTP / EAGLE3 / DFlash / DSpark),
 * surfaced for the model-manager variant dropdown. */
export interface LlmSpecVariant {
  method: 'mtp' | 'eagle3' | 'dflash' | 'dspark';
  /** HF repo the draft GGUF lives in (EAGLE3/DFlash), when separate. */
  draftRepo?: string;
  /** True when the head is embedded in the main GGUF (no separate draft). */
  embedded?: boolean;
}

export interface LlmCatalogEntry {
  id: string;
  displayName: string;
  quants: Array<{ quant: string; bytes: number }>;
  minRamGB: number;
  contextWindow: number;
  input: Array<'text' | 'image'>;
  license: string;
  /** Multi-token-prediction speedup (embedded head or sibling file). */
  mtp: boolean;
  /** DEFAULT speculative-decoding speed method this entry launches with, if any. */
  spec?: 'mtp' | 'eagle3' | 'dflash' | 'dspark';
  /** All speed variants available (for the [MTP / EAGLE3 / DFlash] dropdown). */
  variants?: LlmSpecVariant[];
  vision: boolean;
  downloaded: boolean;
  /**
   * Bytes this model occupies on disk RIGHT NOW — read from the directory, not
   * derived from `quants`, which describes what could be fetched rather than
   * what is here. The delete confirmation needs the number for the action it is
   * about to take; computing it from the selected quant said "Frees 56 GB" for
   * a directory holding 14.4 GB. 0 when nothing is downloaded.
   */
  downloadedBytes?: number;
  /**
   * WHICH quants are on disk. `downloaded` is per-ENTRY, so a model with one
   * quant fetched reported every quant as downloaded — the card offered
   * "Verify / Delete / Set active" for a 55 GB BF16 nobody has, and Set active
   * would have tried to load a file that is not there.
   *
   * Also what lets the quant list float an already-downloaded quant to the top:
   * re-using what you have beats fetching something marginally better.
   */
  downloadedQuants?: string[];
  recommended: boolean;
  /** HF repo id (e.g. "unsloth/gemma-4-E2B-it-GGUF") — for the Advanced view. */
  hfRepo?: string;
  /** Inference engine (llamacpp default; mlx is a later-wave, Apple-Silicon opt-in). */
  engine?: 'llamacpp' | 'mlx';
  /** HF publisher handle (e.g. "unsloth") + whether it is in the reliable allowlist. */
  publisher?: { handle: string; reliable: boolean };
  /** Coarse tier hint (fast / balanced / intelligent) for grouping/sorting. */
  tier?: 'fast' | 'balanced' | 'intelligent';
  /** True when the quants are multi-shard (shard-join download is a follow-up). */
  sharded?: boolean;
  /** True when the source HF repo is gated (needs an accepted licence / token). */
  gated?: boolean;
  /** Where this entry came from: the hand-curated catalog or a Browse-HF add. */
  source?: 'curated' | 'hf';
  /** True only for HEAD-verified curated repos; false for discovered/reserved adds. */
  verified?: boolean;
  /** Speculative methods whose draft GGUF is on disk beside the weights. */
  draftersOnDisk?: string[];
}

export interface LlmHardware {
  totalRamGB: number;
  chip: string | null;
  isAppleSilicon: boolean;
  /*
   * THE FULL PICTURE, added for the engine/model recommender.
   *
   * The three fields above were enough to size a GGUF on a Mac. They cannot
   * answer "which engine" on anything else — an engine ranking that does not
   * know whether there is a CUDA card in the box is a ranking of opinions. See
   * packages/inference/src/accelerator.ts for what each of these decides.
   */
  platform?: 'darwin' | 'win32' | 'linux';
  gpuVendor?: 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown';
  gpuName?: string;
  /** Dedicated VRAM, absent on unified memory — see GpuInfo.vramGB. */
  vramGB?: number;
  cudaMajor?: number;
  unifiedMemory?: boolean;
  npu?: boolean;
  /** What a model actually gets: VRAM on a discrete card, most of RAM otherwise. */
  usableMemoryGB?: number;
}

/** The hardware-detected recommendation (from packages/inference `recommend`),
 * surfaced so the Model Manager can show the pick + its rationale prominently. */
/** One non-power-user pick in the "Recommended for your Mac" simple set. */
export interface LlmSimplePick {
  role: 'speed' | 'vision' | 'utility';
  modelId: string;
  displayName: string;
  quant: string;
  launchMode: 'fast-text' | 'multimodal';
  /** Speed method this pick runs with (fast-text picks only). */
  spec?: 'mtp' | 'eagle3' | 'dflash' | 'dspark';
  vision: boolean;
}

/** One tier resolved for this machine's RAM (from `resolveTierModels`), carried
 * to the renderer so the Auto router + tier dropdown never re-derive it. */
export interface LlmTierPick {
  modelId: string;
  displayName: string;
  quant: string;
  launchMode: 'fast-text' | 'multimodal';
  spec?: 'mtp' | 'eagle3' | 'dflash' | 'dspark';
  vision: boolean;
  /** Download size in bytes (0 = unverified) for the "N GB" auto-download copy. */
  bytes: number;
  /** Whether the pick's main file is already on disk. */
  downloaded: boolean;
}

export interface LlmRecommendation {
  modelId: string;
  quant: string;
  tier: string;
  rationale: string;
  /** 1–3 clearly-labelled picks for non-power-users (speed / vision / helper). */
  simpleSet: LlmSimplePick[];
  /** The 3 tier picks resolved for this Mac (fast / balanced / intelligent). */
  tierModels?: Record<'fast' | 'balanced' | 'intelligent', LlmTierPick>;
}

export type LlmInvokeMap = {
  'llm:get-status': { request: undefined; response: LlmStatus };
  'llm:list-catalog': {
    request: undefined;
    response: {
      models: LlmCatalogEntry[];
      hardware: LlmHardware;
      recommendedModelId: string | null;
      recommendation: LlmRecommendation | null;
    };
  };
  /** Start OR resume a download (resumes from the `.part` sidecar automatically).
   * `hfToken` (from settings) authorizes gated-repo files; public repos ignore it. */
  'llm:download-model': {
    request: { modelId: string; quant?: string; hfToken?: string };
    response: { success: boolean; error?: string; paused?: boolean; cancelled?: boolean };
  };
  /** Abort the in-flight download but KEEP the `.part` file (download-model resumes it). */
  'llm:pause-download': { request: undefined; response: { success: boolean } };
  /** Abort the in-flight download AND discard its `.part` file. */
  'llm:cancel-download': { request: undefined; response: { success: boolean } };
  /** Delete a downloaded model's files (frees disk). */
  'llm:delete-model': {
    request: { modelId: string };
    response: { success: boolean; error?: string };
  };
  /** Re-hash a downloaded model against its catalog sha256. */
  'llm:verify-model': {
    request: { modelId: string; quant?: string };
    response: {
      ok: boolean;
      files: Array<{ file: string; ok: boolean; checked: boolean }>;
      error?: string;
    };
  };
  /** Start the server for a model. `launchMode:'multimodal'` requests an
   * on-demand vision launch (fetches the mmproj sibling, drops MTP); omitted /
   * 'fast-text' is the default speed launch. */
  'llm:start-server': {
    request: { modelId: string; quant?: string; launchMode?: 'fast-text' | 'multimodal' };
    response: { success: boolean; baseUrl?: string; error?: string };
  };
  'llm:stop-server': { request: undefined; response: { success: boolean } };
  /**
   * Measure every engine + speculative method that can run the model from
   * what is on disk, keep the verdict, and come back up on the winner.
   * Progress arrives as `llm:calibration` events; the reply is the record.
   */
  'llm:calibrate': {
    request: { modelId?: string; quant?: string };
    response: { ok: boolean; error?: string; record?: LlmCalibrationRecord };
  };
  'llm:calibrate-cancel': { request: undefined; response: { ok: boolean } };
  'llm:calibration-record': {
    request: { modelId: string; quant?: string };
    response: { record: LlmCalibrationRecord | null };
  };
  /** The companions the catalogue names for a model, and which are on disk. */
  'llm:companions': {
    request: { modelId: string; quant?: string };
    response: { companions: LlmCompanion[] };
  };
  /**
   * What a calibration would measure RIGHT NOW for a model, and what it would
   * skip and why — from the disk as it is, not from a stored record. Each skip
   * says what would fix it (`fetch` a catalogued file, `install` an engine
   * this machine supports, or nothing exists). `installableEngines` is the
   * renderer's knowledge of which engines this host could install.
   */
  'llm:calibration-plan': {
    request: { modelId: string; quant?: string; installableEngines?: string[] };
    response: {
      candidates: Array<{ id: string; engine: string; spec: string; label: string }>;
      skips: Array<{
        id: string;
        engine: string;
        spec: string;
        label: string;
        reason: string;
        fix: 'fetch' | 'install' | 'none';
      }>;
    };
  };
  /** Relaunch the running model on an engine + method the user picked. */
  'llm:use-profile': {
    request: { engine: string; spec: string };
    response: { success: boolean; error?: string };
  };
  /** Restart the running server so saved launch flags take effect (Apply). */
  'llm:relaunch': { request: undefined; response: { success: boolean; error?: string } };
  /** Every GGUF on this machine the app knows about, for the custom-draft picker. */
  'llm:list-local-ggufs': {
    request: undefined;
    response: {
      files: Array<{ path: string; name: string; bytes: number; modelId: string; kind: string }>;
    };
  };
  /** A native file dialog for a draft GGUF; null when cancelled. */
  'llm:pick-gguf': { request: undefined; response: { path: string | null } };
  /** A native file dialog for a flag that takes a path — filtered by what the
   * flag is for; null when cancelled. */
  'llm:pick-path': {
    request: { kind: 'gguf' | 'chat-template' | 'file' | 'directory' };
    response: { path: string | null };
  };
  /** Copy a chat template (a dropped or picked .jinja) into Bobble's own
   * storage, so the launch keeps working when the original moves. */
  'llm:import-chat-template': {
    request: { path: string };
    response: { path: string; error?: string };
  };
  /** Every flag an engine accepts, parsed from its own `--help`. */
  'llm:engine-flags': {
    request: { engine: string };
    response: {
      engine: string;
      command: string;
      flags: Array<{
        key: string;
        aliases: readonly string[];
        placeholder: string | null;
        control:
          | { kind: 'switch' }
          | { kind: 'number' }
          | { kind: 'text' }
          | { kind: 'path' }
          | { kind: 'select'; options: readonly string[] };
        description: string;
        defaultValue?: string;
        env?: string;
        section: string;
        category: string;
      }>;
      error?: string;
    };
  };
};

// ---------------------------------------------------------------------------
// Inference-engine management (Settings → Engines). Separate from `llm:` on
// purpose: those channels drive the RUNNING server, these install and remove the
// engines it can run. The renderer never learns install paths — it asks for
// state and gets back what it needs to draw a row.
// ---------------------------------------------------------------------------

export interface EngineState {
  readonly id: string;
  readonly installed: boolean;
  /** Bytes actually on disk once installed; undefined when not installed. */
  readonly bytes?: number;
  /** Set while an install/uninstall is running, so the row can show progress. */
  readonly busy?: 'installing' | 'removing';
  /** Populated when the last install/uninstall failed, for the row to surface. */
  readonly error?: string;
}

export type EngineInvokeMap = {
  'engines:list': { request: undefined; response: { engines: EngineState[] } };
  'engines:install': { request: { id: string }; response: { success: boolean; error?: string } };
  'engines:uninstall': { request: { id: string }; response: { success: boolean; error?: string } };
  /**
   * Install whichever of these are missing, one after another. The renderer
   * decides the set (engine-catalog `defaultEngineSet`, per platform); main
   * does the installing and reports what landed and what did not.
   */
  'engines:ensure': {
    request: { ids: string[] };
    response: { installed: string[]; failed: Array<{ id: string; error: string }> };
  };
};

export const ENGINE_INVOKE_CHANNELS = [
  'engines:list',
  'engines:install',
  'engines:uninstall',
  'engines:ensure',
] as const satisfies readonly (keyof EngineInvokeMap)[];

/** What we found on this machine for one coding harness. */
export interface HarnessDetected {
  readonly id: string;
  readonly installed: boolean;
  readonly path?: string;
  readonly version?: string;
}

export type HarnessInvokeMap = {
  /**
   * Probe PATH for each harness binary. The renderer sends the ids and the bin
   * names from its catalog, so adding a harness stays a one-file data edit.
   */
  'harness:detect': {
    request: { probes: Array<{ id: string; bin: string }> };
    response: { found: HarnessDetected[] };
  };
};

export const HARNESS_INVOKE_CHANNELS = [
  'harness:detect',
] as const satisfies readonly (keyof HarnessInvokeMap)[];

/**
 * The model card (a repo's README) for the hub's detail pane.
 *
 * Its own channel rather than an `hf:` one because those proxy through the
 * inference supervisor for its model registry, and fetching a public markdown
 * file needs none of that. The renderer cannot fetch it directly — the CSP is
 * `connect-src 'self' blob: pd-file:`.
 */
export type ModelCardInvokeMap = {
  'modelcard:fetch': {
    /** `kind` picks the repo namespace: a dataset's card lives under
     *  huggingface.co/datasets/<id>, and asking the model path 401s. */
    request: { repoId: string; kind?: 'model' | 'dataset' };
    response: { markdown?: string; error?: string };
  };
};

export const MODELCARD_INVOKE_CHANNELS = [
  'modelcard:fetch',
] as const satisfies readonly (keyof ModelCardInvokeMap)[];

/**
 * A Hugging Face org/user avatar, cached to disk and returned as a `pd-file://`
 * URL. Main does the fetching because the renderer's CSP is
 * `img-src 'self' data: blob: pd-file:` — pointing an <img> at huggingface.co
 * is silently blocked. `verified` is HF's own flag, so the blue check can be
 * shown truthfully instead of assumed.
 */
export type OrgAvatarInvokeMap = {
  'orgavatar:fetch': {
    request: { org: string };
    response: { path?: string; verified?: boolean; error?: string };
  };
  /**
   * Cache any remote image and return a `pd-file://` URL. Model cards embed
   * badge rows and screenshots from github/hf, all of which the renderer's
   * `img-src 'self' data: blob: pd-file:` blocks outright.
   */
  'image:cache': {
    request: { url: string };
    response: { path?: string; error?: string };
  };
};

export const ORGAVATAR_INVOKE_CHANNELS = [
  'orgavatar:fetch',
  'image:cache',
] as const satisfies readonly (keyof OrgAvatarInvokeMap)[];

/** One dataset hit (the hub's Datasets page). */
export interface DatasetHitDTO {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  tags: string[];
  updatedAt?: string;
  createdAt?: string;
  gated: boolean;
  /** Total dataset bytes (HF `mainSize`), when known. Unlike a model repo, a
   * dataset's storage IS the thing you download, so bytes is the right axis. */
  bytes?: number;
}

export type DatasetInvokeMap = {
  'datasets:search': {
    request: { query: string; sort?: string; limit?: number };
    response: { hits: DatasetHitDTO[]; error?: string; rateLimited?: boolean };
  };
};

export const DATASET_INVOKE_CHANNELS = [
  'datasets:search',
] as const satisfies readonly (keyof DatasetInvokeMap)[];

export const LLM_INVOKE_CHANNELS = [
  'llm:get-status',
  'llm:list-catalog',
  'llm:download-model',
  'llm:pause-download',
  'llm:cancel-download',
  'llm:delete-model',
  'llm:verify-model',
  'llm:start-server',
  'llm:stop-server',
  'llm:calibrate',
  'llm:calibrate-cancel',
  'llm:calibration-record',
  'llm:companions',
  'llm:calibration-plan',
  'llm:use-profile',
  'llm:relaunch',
  'llm:engine-flags',
  'llm:list-local-ggufs',
  'llm:pick-gguf',
  'llm:pick-path',
  'llm:import-chat-template',
] as const satisfies readonly (keyof LlmInvokeMap)[];

// ---------------------------------------------------------------------------
// Hugging Face model-search channels (Browse-HF view; proxied to the inference
// supervisor, which owns @pi-desktop/inference's hf-search + the dynamic
// registry of discovered models). Structural DTO mirrors of the package's
// HfModelHit / HfGgufFile keep this contract free of a package import.
// ---------------------------------------------------------------------------

/** One HF search hit (mirror of @pi-desktop/inference `HfModelHit`). */
export interface HfModelHitDTO {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  tags: string[];
  gated: boolean;
  pipelineTag?: string;
  updatedAt?: string;
  /** Repo creation time, so "Newest" differs from "Recently updated". */
  createdAt?: string;
  likesRecent?: number;
  /** Exact parameter count from HF's GGUF header (`gguf.total`), when known.
   * Not bytes — a GGUF repo holds every quant it publishes. */
  paramsTotal?: number;
}

/** One GGUF file in a repo (mirror of `HfGgufFile`) + a RAM estimate the
 * supervisor computes so the quant picker can badge fit without the package. */
export interface HfGgufFileDTO {
  path: string;
  sizeBytes?: number;
  quant?: string;
  sha256?: string;
  mmproj?: boolean;
  mtp?: boolean;
  /** Estimated minimum system RAM (GB), via `estimateRamGB`; undefined if unsized. */
  minRamGB?: number;
}

/** Sort orders exposed in the Browse-HF UI (mapped to HF's raw sort keys).
 * `trending` (HF `trendingScore`) is the default used to surface a populated
 * "trending on HF" list the moment the Browse view opens (Round-10 #20b). */
export type HfSortOption = 'trending' | 'downloads' | 'likes' | 'recent';

export type HfInvokeMap = {
  /** Text + filter search over HF GGUF repos (rate-limit aware; errors are
   * returned, not thrown, so the UI can show a message instead of crashing). */
  'hf:search': {
    request: {
      query: string;
      family?: string;
      task?: string;
      gated?: boolean;
      minLikes?: number;
      sort?: HfSortOption;
      limit?: number;
      hfToken?: string;
      /** Restrict to these HF authors, server-side (one request each — HF's
       *  `author` param takes a single handle). Powers the hub's Recommended
       *  scope, which cannot work as a client-side filter over a page the API
       *  already chose. */
      authors?: string[];
      /** Add the server-side `filter=gguf` (default true). False when browsing a
       *  non-gguf modality (image/video/audio), where gguf returns nothing. */
      ggufOnly?: boolean;
    };
    response: { hits: HfModelHitDTO[]; error?: string; rateLimited?: boolean };
  };
  /** List a repo's `.gguf` files (quant/size/sha/mmproj/mtp + RAM estimate). */
  'hf:list-files': {
    request: { repoId: string; contextWindow?: number; hfToken?: string };
    response: { files: HfGgufFileDTO[]; gated?: boolean; error?: string };
  };
  /** Adapt an HF hit + chosen file into a catalog entry and register it with the
   * supervisor (persisted), so the existing llm:download-model/start-server/… act
   * on it by id exactly like a curated model. */
  'hf:register': {
    request: {
      hit: HfModelHitDTO;
      file: HfGgufFileDTO;
      mmproj?: HfGgufFileDTO;
      mtpFile?: HfGgufFileDTO;
      contextWindow?: number;
    };
    response: { modelId: string; entry: LlmCatalogEntry };
  };
};

export const HF_INVOKE_CHANNELS = [
  'hf:search',
  'hf:list-files',
  'hf:register',
] as const satisfies readonly (keyof HfInvokeMap)[];

// ---------------------------------------------------------------------------
// Canvas channels (artifact pop-out into a separate app window)
// ---------------------------------------------------------------------------

/** JSON-serializable mirror of @pi-desktop/canvas's `Artifact`. Kept structural
 * (not an import) so the electron contract stays free of the canvas React
 * package; the renderer maps its real Artifact onto this shape at the boundary. */
export interface CanvasArtifactPayload {
  id: string;
  title?: string;
  filename?: string;
  content: {
    kind: string;
    text: string;
    language?: string;
    mimeType?: string;
  };
}

/** Identifier of an app in the file "Open with" list. Round-8: widened to a
 * free-form string — the desktop supplies real system apps (bundle id or `.app`
 * path). `'default'` still routes to the OS default handler; the legacy named
 * ids (`vscode-insiders` / `terminal` / `xcode`) stay valid for back-compat. */
export type CanvasOpenWithAppId = string;

/** One app the canvas "Open with" split button can shell out to (round-8 #14).
 * Mirrors @pi-desktop/canvas's `OpenWithApp` (kept inline so the electron
 * contract stays free of the canvas React package). The `iconDataUrl` is the
 * app's system icon extracted to a PNG data URL by the main process. */
export interface CanvasOpenApp {
  id: CanvasOpenWithAppId;
  name: string;
  iconDataUrl?: string;
}

export type CanvasInvokeMap = {
  /** Hand the current artifact to main and open/focus the pop-out window. */
  'canvas:popout': { request: { artifact: CanvasArtifactPayload }; response: { ok: boolean } };
  /** The pop-out window fetches the artifact main is holding for it. */
  'canvas:get-popout': { request: undefined; response: { artifact: CanvasArtifactPayload | null } };
  /** Browser operation bar "open in external browser" → shell.openExternal. */
  'canvas:open-external': { request: { url: string }; response: { ok: boolean } };
  /** The apps that can open a given file (LaunchServices + a pragmatic set), each
   * with a system-icon data URL, plus the detected default app id (round-8 #14).
   * Icons are extracted + cached lazily in main. */
  'canvas:list-open-apps': {
    request: { path: string };
    response: { apps: CanvasOpenApp[]; defaultAppId: string | null };
  };
  /** File operation bar "Open ▾" → shell out to open the file in the chosen app. */
  'canvas:open-with': {
    request: { path: string; appId: CanvasOpenWithAppId };
    response: { ok: boolean; error?: string };
  };
  /** Open with the OS default handler — LaunchServices directly, no `duti` and
   * no Apple Events, so it works on a machine with neither. */
  'canvas:open-default': { request: { path: string }; response: { ok: boolean; error?: string } };
  /** File operation bar "Open in folder" → shell.showItemInFolder. */
  'canvas:reveal': { request: { path: string }; response: { ok: boolean } };
  /**
   * Put a generated file on the clipboard: a picture as its pixels (so it
   * pastes into anything that takes an image) AND as a file, anything else as
   * a file (+ its path as text). the user (2026-09-17): the media card's top-right
   * "take to a new chat" button "should just be replaced with a copy button
   * that instantly copies it to clipboard."
   */
  'canvas:copy-file': {
    request: { path: string };
    response: { ok: boolean; how?: 'image' | 'file'; error?: string };
  };
  /**
   * Start an OS drag carrying a real file, so it can be dropped into Finder,
   * Mail, Slack — anywhere that accepts a file.
   *
   * The thing a local app can do that a browser tab cannot. Everything the model
   * produces is already a real file at a real path; this is the one API call
   * between that and the gesture people expect from it.
   */
  'canvas:start-drag': { request: { path: string }; response: { ok: boolean } };
  /**
   * Save a copy of a file somewhere the user picks. `ok:false` with no error is
   * a cancelled dialog, which is not a failure and must not be reported as one.
   */
  'canvas:save-as': {
    request: { path: string; suggestedName?: string };
    response: { ok: boolean; savedTo?: string; error?: string };
  };
  /**
   * Save BYTES the renderer made — a mesh the 3D viewer just exported — through
   * the same save panel. An `<a download>` click in Electron lands in
   * ~/Downloads with no panel and no word, which is why the studio's Export
   * looked like it did nothing (the user, 2026-09-14: "send to and export buttons
   * should be functional and work"). Base64 because IPC carries strings well
   * and a 20 MB GLB is fine that way.
   */
  'canvas:save-bytes': {
    request: { base64: string; suggestedName: string };
    response: { ok: boolean; savedTo?: string; error?: string };
  };
  /**
   * Hand a file the renderer made to another app: written under the
   * generated-media root, then `open -a <app>`. The 3D studio's Send To.
   */
  'canvas:send-bytes-to': {
    request: { base64: string; fileName: string; app: string };
    response: { ok: boolean; savedTo?: string; error?: string };
  };
  /** Renderer → main: report a compact snapshot of what's on the canvas right now
   * (canvas-awareness). Main caches it and serves it to the pi child's `context`
   * hook (browser url/title re-enriched from the live view). Debounced by the
   * renderer; pushed on surface / active-tab changes. */
  'canvas:report-state': { request: { state: CanvasState }; response: { ok: boolean } };
  /** A site's own icon as a `data:` URI, for the web-search results card. Fetched
   * in MAIN (first-party only, cached by host) so the renderer's CSP keeps
   * forbidding remote images and no aggregator learns what was searched.
   * `dataUri` is null when the site has none we can use — the card then draws
   * the letter chip it already falls back to. */
  'canvas:site-icon': { request: { site: string }; response: { dataUri: string | null } };
};

export const CANVAS_INVOKE_CHANNELS = [
  'canvas:popout',
  'canvas:get-popout',
  'canvas:open-external',
  'canvas:list-open-apps',
  'canvas:open-with',
  'canvas:open-default',
  'canvas:reveal',
  'canvas:copy-file',
  'canvas:start-drag',
  'canvas:save-as',
  'canvas:save-bytes',
  'canvas:send-bytes-to',
  'canvas:report-state',
  'canvas:site-icon',
] as const satisfies readonly (keyof CanvasInvokeMap)[];

// ---------------------------------------------------------------------------
// Mac computer-use channels (E2E-only debug/introspection)
// ---------------------------------------------------------------------------

export type MacInvokeMap = {
  /** PI_E2E-gated probe seam for Mac computer-use: helper passthrough ops
   * (check/frontmost/bounds/snapshot/screenshot — the TCC reality check + the
   * no-focus-steal assertions) and overlay-* ops (drive the cursor overlay
   * deterministically for screenshot probes). The handler is ONLY registered
   * when PI_E2E=1 (see mac/mac-agent.ts registerE2eDebugChannel); in normal
   * runs the channel exists in the contract but has no handler. */
  'mac:debug': {
    request: { op: string; params?: Record<string, unknown> };
    response: { ok: boolean; result?: unknown; error?: string };
  };
  /**
   * The apps installed on this Mac with their real icons (128 px PNGs the
   * `pi-mac` helper drew, cached under the support root, handed over as data
   * URLs) — the computer-use chooser's grid, in onboarding and Settings →
   * Computer use. Denylisted apps (Bobble, Keychain Access, System Settings)
   * are not offered.
   */
  'mac:list-apps': {
    request: { refresh?: boolean } | undefined;
    response: {
      apps: { id: string; name: string; path: string; icon: string | null }[];
    };
  };
};

export const MAC_INVOKE_CHANNELS = [
  'mac:debug',
  'mac:list-apps',
] as const satisfies readonly (keyof MacInvokeMap)[];

// The computer-use monitor's own channels live in mac/mac-monitor-contract.ts
// (they are a real product surface, not an E2E seam like `mac:debug`).

export type AppInvokeMap = CoreInvokeMap &
  FsInvokeMap &
  LlmInvokeMap &
  EngineInvokeMap &
  HarnessInvokeMap &
  ModelCardInvokeMap &
  OrgAvatarInvokeMap &
  DatasetInvokeMap &
  ScheduledInvokeMap &
  HfInvokeMap &
  AfmInvokeMap &
  SettingsInvokeMap &
  CanvasInvokeMap &
  ProjectInvokeMap &
  ConnectorsInvokeMap &
  SkillsInvokeMap &
  ImportInvokeMap &
  GenCatalogInvokeMap &
  GenInvokeMap &
  Gen3dInvokeMap &
  StoreInvokeMap &
  StorageInvokeMap &
  StudioInvokeMap &
  DictationInvokeMap &
  BrowserInvokeMap &
  BrowserAgentInvokeMap &
  OfficeInvokeMap &
  PtyInvokeMap &
  CorpInvokeMap &
  MacInvokeMap &
  MacMonitorInvokeMap &
  PiInvokeMap;

/** Runtime allowlist for the preload's invoke passthrough: only channels in
 * the contract ever reach ipcMain (see preload.ts). `satisfies` checks
 * membership; MissingChannels checks exhaustiveness, so adding a channel to
 * the map without listing it here is a compile error. */
export const APP_INVOKE_CHANNELS = [
  'app:get-info',
  'app:notify',
  'app:set-badge',
  'app:reload-window',
  ...FS_INVOKE_CHANNELS,
  ...LLM_INVOKE_CHANNELS,
  ...HF_INVOKE_CHANNELS,
  ...AFM_INVOKE_CHANNELS,
  ...SETTINGS_INVOKE_CHANNELS,
  ...CANVAS_INVOKE_CHANNELS,
  ...PROJECT_INVOKE_CHANNELS,
  ...CONNECTORS_INVOKE_CHANNELS,
  ...SKILLS_INVOKE_CHANNELS,
  ...IMPORT_INVOKE_CHANNELS,
  ...GEN_CATALOG_INVOKE_CHANNELS,
  ...GEN_INVOKE_CHANNELS,
  ...GEN3D_INVOKE_CHANNELS,
  ...STORE_INVOKE_CHANNELS,
  ...STORAGE_INVOKE_CHANNELS,
  ...STUDIO_INVOKE_CHANNELS,
  ...DICTATION_INVOKE_CHANNELS,
  ...BROWSER_INVOKE_CHANNELS,
  ...BROWSER_AGENT_INVOKE_CHANNELS,
  ...OFFICE_INVOKE_CHANNELS,
  ...PTY_INVOKE_CHANNELS,
  ...CORP_INVOKE_CHANNELS,
  ...MAC_INVOKE_CHANNELS,
  ...MAC_MONITOR_INVOKE_CHANNELS,
  ...PI_INVOKE_CHANNELS,
  ...ENGINE_INVOKE_CHANNELS,
  ...HARNESS_INVOKE_CHANNELS,
  ...MODELCARD_INVOKE_CHANNELS,
  ...ORGAVATAR_INVOKE_CHANNELS,
  ...DATASET_INVOKE_CHANNELS,
  ...SCHEDULED_INVOKE_CHANNELS,
] as const satisfies readonly (keyof AppInvokeMap)[];

type MissingChannels = Exclude<keyof AppInvokeMap, (typeof APP_INVOKE_CHANNELS)[number]>;
const _assertAllChannelsListed: MissingChannels extends never ? true : MissingChannels = true;
void _assertAllChannelsListed;

export type AppEventMap = {
  /** Pushed by main on did-finish-load — typically before React mounts, which
   * exercises the pre-mount event buffer end to end. */
  'app:boot': { sentAt: number };
  /**
   * A menu accelerator that the RENDERER must action (main has no view state).
   *
   * `close-tab` (⌘W) closes the active canvas tab / current chat — NOT the window
   * (⌘⇧W / the red button close the window).
   *
   * `soft-reload` (⌘R) RE-MOUNTS the React tree and puts back what the user was
   * looking at. Electron's stock `reload` role reloads the DOCUMENT, which
   * throws away the thread, the canvas tabs and the scroll position — the user:
   * "⌘R clears really everything". Almost none of that is the document's to
   * lose: the chat lives in the pi child and on disk, and the stores are module
   * state that a remount keeps. So ⌘R now rebuilds the view and restores the
   * canvas + scroll, and ⌘⇧R stays the real, everything-goes reload.
   *
   * See main.ts installAppMenu and src/app-reload.ts.
   */
  'app:accelerator': { action: 'close-tab' | 'soft-reload' };
  /** The user clicked an OS notification — open the chat it was about. */
  'app:notification-click': { sessionFile: string };
  /** Inference supervisor state (server/model/TPS) for the composer footer. */
  'llm:status': LlmStatus;
  /**
   * One step of a running calibration, for the engine menu: the plan, each
   * candidate starting / measuring / measured, the switch, the verdict.
   */
  'llm:calibration': LlmCalibrationProgress;
  /**
   * A tool produced an image the running (text-only) server cannot read, so the
   * renderer should switch vision on.
   *
   * Main deliberately does NOT do this itself. Going multimodal is a llama-server
   * RESTART onto a NEW PORT, and the pi child holds the old base URL — restarting
   * from main leaves the child talking to an address that no longer exists, which
   * is exactly the hang this replaced. The renderer's `ensureVisionMode()` already
   * does the whole sequence, respawn included, so it owns this.
   */
  'llm:vision-wanted': Record<string, never>;
  /**
   * pi crashed at startup and was respawned with NO extensions, so this session
   * has no tools at all. Carries what pi printed, because otherwise a total loss
   * of capability is indistinguishable from a model that is simply refusing.
   */
  'pi:extensions-disabled': { reason: string };
  /**
   * The model called `present`: show this artefact to the user — a card in the
   * thread and the thing itself open (or running) in the canvas.
   */
  'present:show': {
    path: string;
    note?: string;
    /**
     * A chart's spec (the `<stem>.chart.json` beside a presented .svg): the
     * thread renders it as an interactive card instead of a file row, and the
     * canvas only on request. See electron/pi/present-inline.ts.
     */
    chart?: Record<string, unknown>;
    /** A presented SVG's size and, when icon-sized and light, its markup. */
    svg?: { width: number; height: number; bytes: number; text?: string };
  };
  /**
   * Download progress. `received`/`total`/`fraction` are THIS FILE's; the
   * `job*` fields are the whole download's and are what the bar should follow —
   * a model plus its projector is two files, and a per-file bar hits 100% and
   * then restarts at 0%, which reads as the download having failed and retried.
   * Optional because a caller that fetches exactly one file need not compute them.
   */
  'llm:download-progress': {
    modelId: string;
    file: string;
    received: number;
    total: number | null;
    fraction: number | null;
    fileIndex?: number;
    fileCount?: number;
    jobReceived?: number;
    jobTotal?: number | null;
  };
  /** Pushed to the pop-out window when a fresh artifact is popped out while it
   * is already open, so the standalone canvas re-renders without a reload. */
  'canvas:popout-artifact': CanvasArtifactPayload;
} & BrowserEventMap &
  OfficeEventMap &
  BrowserAgentEventMap &
  MacMonitorEventMap &
  PtyEventMap &
  CorpEventMap &
  GenEventMap &
  Gen3dEventMap &
  StoreEventMap &
  StorageEventMap &
  StudioEventMap &
  ScheduledEventMap &
  PiEventMap;

/** Shape of `window.piDesktop` as exposed by the preload script. */
export interface PiDesktopBridge {
  invoke: IpcClient<AppInvokeMap>['invoke'];
  onEvent<K extends keyof AppEventMap & string>(
    channel: K,
    listener: (payload: AppEventMap[K]) => void,
  ): () => void;
  /** The on-disk absolute path of a dropped/picked File (webUtils.getPathForFile;
   * '' when the File has no backing path). The 3D studio uses it to hand real
   * file paths to the gen3d engine. */
  pathForFile(file: File): string;
}

// Static assertions: keep the maps assignable to the shared constraints.
const _assertInvokeMap: IpcInvokeMap = {} as AppInvokeMap;
const _assertEventMap: IpcEventMap = {} as AppEventMap;
void _assertInvokeMap;
void _assertEventMap;
