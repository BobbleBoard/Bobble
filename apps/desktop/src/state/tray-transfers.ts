/**
 * THE TRAY'S DOWNLOADS AND LOADS — what the task tray lists under its
 * "Downloads" and "Loading" headers.
 *
 * The user (2026-09-24): "this top left button to show status on running tasks … I
 * wanted to lean into a bit more and put downloads/model load progress into
 * aswell, eg. headers for 'Downloads' 'Loading' for these you can use a sort of
 * clean thin blue progressbar w/ % or ngb/rgb red X on the side below some white
 * text that says the running operation".
 *
 * So each row is the operation in words, then a thin bar with how far it is —
 * bytes for a download, a percentage for a load — and an X when it can be
 * stopped. Everything here is pure: the stores' state in, rows out, so the rules
 * are tested without a window (tray-transfers.test.ts) and TaskTray only draws.
 *
 * The tray replaces the separate download icon of 2026-09-13 (DownloadTray):
 * two indicators in the same corner for things that are all "still going" was
 * one too many, and its news — finished, could not start — lists here too.
 */
import type { GenModuleState } from '../../electron/gen/gen-modules';
import type { LlmStatus } from '../../electron/ipc-contract';
import type { TrayNotice } from './download-tray';
import {
  downloadEtaSeconds,
  downloadFraction,
  formatEta,
  type LlmDownloadState,
  useLlmStore,
} from './llm-store';

export type TransferSection = 'downloads' | 'loading';

/** What the row's X stops — described, so this module stays pure. */
export type TransferCancel =
  | { readonly kind: 'llm-download' }
  | { readonly kind: 'store-download'; readonly repo: string }
  | { readonly kind: 'llm-load' };

export interface TransferRow {
  readonly key: string;
  readonly section: TransferSection;
  /** The running operation, in words — the row's white line. */
  readonly title: string;
  /** 0..1, or null while nothing can say how far (the bar sweeps instead). */
  readonly fraction: number | null;
  /** Beside the bar: "4.2 / 31 GB", "52%", "14 s". */
  readonly amount: string;
  /**
   * How long is left, when the rate says ("3m left") — on the title's line, in
   * the muted ink. A long pull read from the chat screen has to say when it
   * ends, not only how far it is (the model-download UX probe's rule 5).
   */
  readonly note?: string;
  /** Absent when the operation cannot be stopped (a module install). */
  readonly cancel?: TransferCancel;
  /**
   * A model download can wait and pick up where it left off. The old download
   * icon was the only place Pause lived, so the row that replaces it keeps it.
   */
  readonly pause?: { readonly paused: boolean };
}

/** A download from the store (a Hugging Face repo), as store-models reports it. */
export interface StoreProgress {
  readonly repo: string;
  readonly file: string;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly received: number;
  readonly total: number;
  readonly fraction: number;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * "4.2 / 31 GB" — received over total in ONE unit, the total's, so the two read
 * as a pair. Under a gigabyte both are MB. Without a total, what has arrived.
 */
export function pairBytes(received: number, total: number | null | undefined): string {
  const one = (n: number, unit: number): string => {
    const v = n / unit;
    return v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(v >= 10 ? 0 : 1)));
  };
  if (total === null || total === undefined || total <= 0) {
    return received >= GIB ? `${one(received, GIB)} GB` : `${Math.round(received / MIB)} MB`;
  }
  return total >= GIB
    ? `${one(received, GIB)} / ${one(total, GIB)} GB`
    : `${Math.round(received / MIB)} / ${Math.round(total / MIB)} MB`;
}

/** The integer a bar prints: floored, so it never claims more than it has. */
export function percentText(fraction: number): string {
  return `${Math.floor(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/** "14 s", "2 m 05 s" — how long a load with no estimate has been going. */
export function elapsedText(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs} s`;
  return `${Math.floor(secs / 60)} m ${String(secs % 60).padStart(2, '0')} s`;
}

export function llmDownloadRow(d: LlmDownloadState, name: string): TransferRow {
  const total = d.jobTotal ?? d.total;
  const received =
    d.jobTotal !== null && d.jobTotal !== undefined ? (d.jobReceived ?? 0) : d.received;
  const eta = d.paused ? '' : formatEta(downloadEtaSeconds(d));
  return {
    key: `llm:${d.modelId}`,
    section: 'downloads',
    title: name,
    fraction: downloadFraction(d),
    amount: d.paused ? 'Paused' : pairBytes(received, total),
    ...(eta !== '' ? { note: eta } : {}),
    cancel: { kind: 'llm-download' },
    pause: { paused: d.paused },
  };
}

export function storeDownloadRow(p: StoreProgress): TransferRow {
  return {
    key: `store:${p.repo}`,
    section: 'downloads',
    title: p.repo,
    fraction: p.total > 0 ? Math.max(0, Math.min(1, p.fraction)) : null,
    amount: pairBytes(p.received, p.total > 0 ? p.total : null),
    cancel: { kind: 'store-download', repo: p.repo },
  };
}

/** A module (or a model's weights) being installed: uv and the fetch, no X — there is no stopping it half way. */
export function moduleRow(m: GenModuleState): TransferRow {
  const fraction = m.percent === undefined ? null : Math.max(0, Math.min(1, m.percent));
  return {
    key: `module:${m.id}`,
    section: 'downloads',
    title: m.label,
    fraction,
    amount: fraction === null ? `~${m.approxGB} GB` : percentText(fraction),
  };
}

/*
 * THE LOAD HAS NO COUNTER. Neither llama-server nor the MLX engines say how far a
 * model load is — the status reads `starting` until it reads `ready`. The one
 * honest basis is how long THIS model took to load on THIS Mac last time; with
 * none (a first load, an engine being compiled) the bar sweeps and the side says
 * how long it has been going. With one, the bar walks at that pace, bends before
 * the expected end and creeps toward 95% without reaching it — a load that runs
 * long slows the number rather than parking it on 99 — and the row leaves when
 * the model is ready.
 */
/** The share of the bar a load may walk straight, and where its creep tops out. */
const LOAD_KNEE = 0.7;
const LOAD_CEILING = 0.95;

export function loadFraction(elapsedMs: number, expectedMs: number | undefined): number | null {
  if (expectedMs === undefined || !(expectedMs > 0)) return null;
  const x = Math.max(0, elapsedMs) / expectedMs;
  if (x <= LOAD_KNEE) return x;
  const room = LOAD_CEILING - LOAD_KNEE;
  // Same slope as the straight part where they meet, so the bar never lurches.
  return LOAD_KNEE + room * (1 - Math.exp(-(x - LOAD_KNEE) / room));
}

export function loadRow(
  status: LlmStatus,
  now: number,
  expectedMs: number | undefined,
): TransferRow | null {
  const loading = status.loading;
  if (status.phase !== 'starting' || loading === undefined) return null;
  const building = status.engineBuild !== undefined;
  const elapsed = now - loading.since;
  // An engine compile is minutes, once — nothing from a normal load predicts it.
  const fraction = building ? null : loadFraction(elapsed, expectedMs);
  return {
    key: `load:${loading.modelId}`,
    section: 'loading',
    title: building
      ? `Building the engine for ${loading.displayName}`
      : `Loading ${loading.displayName}`,
    fraction,
    amount: fraction === null ? elapsedText(elapsed) : percentText(fraction),
    cancel: { kind: 'llm-load' },
  };
}

/** Everything the two sections list, in the order they are drawn. */
export function transferRows(input: {
  readonly llmDownload: LlmDownloadState | null;
  readonly llmName: string;
  readonly store: readonly StoreProgress[];
  readonly modules: readonly GenModuleState[];
  readonly status: LlmStatus | null;
  readonly now: number;
  readonly expectedLoadMs: number | undefined;
}): TransferRow[] {
  const rows: TransferRow[] = [];
  if (input.llmDownload !== null) rows.push(llmDownloadRow(input.llmDownload, input.llmName));
  for (const p of input.store) rows.push(storeDownloadRow(p));
  for (const m of input.modules) if (m.installing) rows.push(moduleRow(m));
  if (input.status !== null) {
    const load = loadRow(input.status, input.now, input.expectedLoadMs);
    if (load !== null) rows.push(load);
  }
  return rows;
}

/** The finished / could-not-start news, listed under Downloads until dismissed. */
export function noticeTitle(n: TrayNotice): string {
  return `${n.kind === 'finished' ? 'Downloaded' : 'Not downloaded'} · ${n.name}`;
}

/* ── how long a load took, remembered per model ─────────────────────────── */

const LOAD_KEY = (modelId: string): string => `pd-load-ms:${modelId}`;

export function expectedLoadMs(modelId: string): number | undefined {
  try {
    const v = Number(localStorage.getItem(LOAD_KEY(modelId)));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold one measured load into what the next one expects: half the old, half the
 * new — a cold disk and a warm one differ, and neither alone is the truth.
 */
export function nextExpectedMs(previous: number | undefined, measured: number): number {
  return previous === undefined ? measured : Math.round(previous * 0.5 + measured * 0.5);
}

/** A load worth learning from: an ordinary one, finished, not a compile or a calibration swap. */
export function learnableLoad(
  before: LlmStatus,
  after: LlmStatus,
  sawEngineBuild: boolean,
  now: number,
): { modelId: string; ms: number } | null {
  if (before.phase !== 'starting' || after.phase !== 'ready') return null;
  if (sawEngineBuild || before.calibrating === true || after.calibrating === true) return null;
  const loading = before.loading;
  if (loading === undefined) return null;
  const ms = now - loading.since;
  // A load over ten minutes was waiting on something else (a download, a stall).
  return ms > 0 && ms < 10 * 60_000 ? { modelId: loading.modelId, ms } : null;
}

export function rememberLoad(modelId: string, ms: number): void {
  try {
    localStorage.setItem(LOAD_KEY(modelId), String(nextExpectedMs(expectedLoadMs(modelId), ms)));
  } catch {
    // no storage (a sandboxed preview): the next load just sweeps
  }
}

/**
 * Watch the server's status and remember how long each ordinary load took, for
 * the next load's bar. Returns the unsubscribe.
 */
export function connectLoadTimer(): () => void {
  let sawEngineBuild = false;
  return useLlmStore.subscribe((state, prev) => {
    const after = state.status;
    const before = prev.status;
    if (after === before) return;
    if (after.phase === 'starting' && before.phase !== 'starting') sawEngineBuild = false;
    if (after.engineBuild !== undefined) sawEngineBuild = true;
    const learned = learnableLoad(before, after, sawEngineBuild, Date.now());
    if (learned !== null) rememberLoad(learned.modelId, learned.ms);
  });
}
