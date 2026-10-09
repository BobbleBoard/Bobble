/**
 * The round-12 Auto model router (W3).
 *
 * When `modelSelection.mode === 'auto'`, every send classifies the outgoing
 * prompt (the pure `classify` heuristic), maps the task class → a capability
 * tier (fast / balanced / intelligent), resolves that tier → the concrete model
 * this machine runs for it (`recommendation.tierModels`), and — if it differs
 * from the running server model — performs the existing HARD restart (llama
 * dispose + start + pi respawn on the same session) so the turn runs on the
 * routed model.
 *
 * The switching decision is deliberately conservative (see {@link decideRoute}):
 *   - switch only on a real model-id change (two tiers can share one model on a
 *     small machine → that's a no-op, never a restart);
 *   - sticky-up / lazy-down hysteresis — upgrade immediately, but downgrade only
 *     after {@link DOWNGRADE_TURNS} consecutive turns want a lower tier;
 *   - a debounce so rapid consecutive sends don't thrash the (seconds-long)
 *     restart;
 *   - NEVER auto-switch to a model that isn't downloaded — surface the friendly
 *     auto-download prompt instead;
 *   - a live "switching…" banner (in model-selection-store) so the restart
 *     latency is honest.
 *
 * The pure core (`decideRoute`, `tierForPrompt`, `tierForModelId`,
 * `downloadPromptView`) is store-free + node-testable; the impure orchestration
 * below reads the live stores and drives the restart.
 */

// NOTE: imported from the harness SOURCE modules, not the '@pi-desktop/harness'
// barrel. The barrel re-exports the whole extension (subagent scheduler →
// node:os/child_process, repair bridge, and the pi-coding-agent SDK →
// @mistralai/@opentelemetry), which the renderer bundle can't tree-shake and
// which breaks `vite build`. classify.ts + tier.ts are pure, dependency-free,
// and node/browser-safe, so a direct source import keeps the bundle clean. (A
// tidier fix would be a renderer-safe `@pi-desktop/harness/classify` subpath
// export — that's W5's package to touch.)
import {
  asksForTheTeam,
  MODEL_TIERS,
  type ModelTier,
  TIER_LABEL,
} from '../../../../packages/harness/src/model/tier.ts';
import type { LlmTierPick } from '../../electron/ipc-contract';
import type { EffortLevel, ModelSelection } from '../../electron/settings/settings-contract';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { type DowngradeMemory, useModelSelectionStore } from '../state/model-selection-store';
import { agentInFlight } from '../state/pi-connect';
import { setModelSelection, useSettingsStore } from '../state/settings-store';

// --- Tuning knobs ----------------------------------------------------------

/** Lazy-down: consecutive turns that must want a lower tier before we downgrade. */
export const DOWNGRADE_TURNS = 2;
/** Debounce: don't restart the server more than once per this window (ms). */
export const SWITCH_DEBOUNCE_MS = 1500;

/** Tier ordering (fast=0 < balanced=1 < intelligent=2). */
export function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

// --- Pure classification / resolution --------------------------------------

/**
 * AUTO PICKS ONE MODEL AND STAYS THERE.
 *
 * This used to classify every send, map the guessed task class to a tier, and
 * hard-restart llama-server whenever the tier moved — seconds of dead air in the
 * middle of a conversation, plus a full re-prefill, decided by which keywords
 * happened to be in one message. the user: "totally remove task classification, that
 * should have been a deprecated feature so long ago."
 *
 * Auto now means "the best model this machine actually runs": the most capable
 * tier whose model is on disk. It is resolved from the catalog, not the prompt,
 * so it does not change mid-conversation and the cached prefix survives.
 */
export function autoTier(
  tierModels: Record<ModelTier, LlmTierPick> | undefined,
  downloadedModelIds: readonly string[],
): ModelTier | null {
  if (tierModels === undefined) return null;
  // Most capable first — MODEL_TIERS is ordered fast → intelligent.
  for (const tier of [...MODEL_TIERS].reverse()) {
    if (downloadedModelIds.includes(tierModels[tier].modelId)) return tier;
  }
  return null;
}

/** The tier whose resolved model matches `modelId` (the currently-running one),
 * or null when the model isn't one of the tier picks. On a small machine where
 * two tiers share a model id, the first (lowest) matching tier wins — harmless,
 * since the same-model guard in {@link decideRoute} short-circuits first. */
export function tierForModelId(
  tierModels: Record<ModelTier, LlmTierPick> | undefined,
  modelId: string | null,
): ModelTier | null {
  if (tierModels === undefined || modelId === null) return null;
  for (const tier of MODEL_TIERS) {
    if (tierModels[tier].modelId === modelId) return tier;
  }
  return null;
}

// --- Pure startup-preload pick (a model is ALWAYS loaded) ------------------

/** Inputs to {@link pickPreloadModel} (mirrors the live llm-store fields). */
export interface PreloadInputs {
  /** The 3 tier picks resolved for this machine (undefined before catalog load). */
  tierModels: Record<ModelTier, LlmTierPick> | undefined;
  /** Model ids currently on disk (the supervisor's downloaded set). */
  downloadedModelIds: readonly string[];
  /** Whether an inference server is already up. */
  serverRunning: boolean;
  /** The model id currently resident, or null when none is up. */
  currentModelId: string | null;
}

/**
 * Pure: pick the FASTEST already-downloaded model to preload at startup so a
 * model is always resident with the lowest possible TTFT. Walks the tiers fast →
 * balanced → intelligent and returns the first whose model is on disk (fast is
 * the fastest, so the first downloaded one is the fastest available). Returns
 * null — nothing to preload — when a model is already resident, the catalog
 * hasn't loaded, or nothing is downloaded yet.
 */
export function pickPreloadModel(inp: PreloadInputs): { modelId: string; quant: string } | null {
  // Already resident → nothing to preload.
  if (inp.serverRunning && inp.currentModelId !== null) return null;
  if (inp.tierModels === undefined) return null;
  for (const tier of MODEL_TIERS) {
    const pick = inp.tierModels[tier];
    if (inp.downloadedModelIds.includes(pick.modelId)) {
      return { modelId: pick.modelId, quant: pick.quant };
    }
  }
  return null;
}

/**
 * Which model to bring online at boot for ANY selection mode — the fix for the
 * "fetch failed" first send. Auto preloaded the fastest model, but a PINNED
 * tier/model preloaded nothing ("owns its own load"), so a relaunch left no
 * server up and the first prompt hit a dead endpoint → a bare "fetch failed".
 *
 * Now: a server already resident → null (no-op). A pinned tier/model whose model
 * is on disk → THAT model. Auto, or a pinned pick that isn't downloaded → the
 * fastest downloaded model, so the app ALWAYS comes up with a running server.
 * Pure + injectable (tested), like {@link pickPreloadModel}.
 */
export function resolveBootModel(
  sel: ModelSelection,
  inp: PreloadInputs,
): { modelId: string; quant?: string } | null {
  if (inp.serverRunning && inp.currentModelId !== null) return null;
  const onDisk = (id: string): boolean => inp.downloadedModelIds.includes(id);
  if (sel.mode === 'model' && onDisk(sel.modelId)) return { modelId: sel.modelId };
  if (sel.mode === 'tier' && inp.tierModels !== undefined) {
    const pick = inp.tierModels[sel.tier];
    if (pick !== undefined && onDisk(pick.modelId))
      return { modelId: pick.modelId, quant: pick.quant };
  }
  // Auto, or a pinned pick that isn't on disk → guarantee SOME server is up.
  return pickPreloadModel(inp);
}

// --- Pure routing decision -------------------------------------------------

/** The router's cross-turn memory (mirrors model-selection-store's fields). */
export interface RouterMemory {
  pendingDowngrade: DowngradeMemory | null;
  lastSwitchAt: number;
}

export interface RouteInputs {
  /** Tier of the currently-running server model (derived), or null if unknown. */
  currentTier: ModelTier | null;
  /** Tier the classifier wants for this turn. */
  desiredTier: ModelTier;
  /** The concrete model id `desiredTier` resolves to on this machine. */
  targetModelId: string;
  /** The currently-running server model id, or null when none is up. */
  currentModelId: string | null;
  /** Whether the target tier's model is already on disk. */
  downloaded: boolean;
  /** `Date.now()` at decision time (injected for testability). */
  now: number;
  /**
   * Whether a turn is currently in flight (streaming / a queued follow-up). When
   * true the running model is LOCKED for the task and Auto must NOT hard-restart
   * llama — the switch waits for the next clean idle boundary. Defaults to false
   * (a fresh, idle send). Explicit user model changes never reach here, so they
   * are unaffected by this gate.
   */
  inFlight?: boolean;
}

export type RouteAction = 'none' | 'switch' | 'download-prompt';

export interface RouteDecision {
  action: RouteAction;
  /** Why — for logging / the "switching…" surfaces / tests. */
  reason: string;
  /** The memory to commit after this decision (whether or not we switch). */
  memory: RouterMemory;
}

/**
 * Decide whether Auto should switch the running model this turn. Pure — all I/O
 * is the caller's job. Encodes the sticky-up / lazy-down hysteresis, the
 * same-model no-op guard, the not-downloaded → prompt rule, and the debounce.
 */
export function decideRoute(mem: RouterMemory, inp: RouteInputs): RouteDecision {
  // 0. A turn is IN FLIGHT → the model is locked for the task. Never hard-restart
  //    llama mid-stream/mid-task; hold the current model and leave the cross-turn
  //    memory UNTOUCHED (a queued follow-up is not a fresh routing decision, so it
  //    must not advance the debounce clock or the lazy-down counter). Auto still
  //    routes at the next clean IDLE boundary; an explicit user model change never
  //    calls decideRoute, so it bypasses this gate entirely.
  if (inp.inFlight === true) {
    return { action: 'none', reason: 'in-flight', memory: mem };
  }

  // 1. The target model is already running → never restart. Covers two tiers
  //    resolving to the SAME model id on a small machine (a "switch" that is a
  //    real no-op). Clears any half-counted downgrade.
  if (inp.currentModelId !== null && inp.currentModelId === inp.targetModelId) {
    return {
      action: 'none',
      reason: 'same-model',
      memory: { pendingDowngrade: null, lastSwitchAt: mem.lastSwitchAt },
    };
  }

  const cur = inp.currentTier;
  const des = inp.desiredTier;

  // Initial routing and upgrades act immediately (sticky-up); a same-tier /
  // different-model id reconciles; a downgrade is lazy. All three fall through
  // to the switch below except a downgrade still counting up.
  if (cur !== null && tierRank(des) < tierRank(cur)) {
    // DOWNGRADE → lazy: require DOWNGRADE_TURNS consecutive turns wanting it.
    const count =
      mem.pendingDowngrade !== null && mem.pendingDowngrade.tier === des
        ? mem.pendingDowngrade.count + 1
        : 1;
    if (count < DOWNGRADE_TURNS) {
      return {
        action: 'none',
        reason: 'lazy-down-waiting',
        memory: { pendingDowngrade: { tier: des, count }, lastSwitchAt: mem.lastSwitchAt },
      };
    }
  }

  // A move is warranted. Never auto-switch to a model that isn't on disk.
  if (!inp.downloaded) {
    return {
      action: 'download-prompt',
      reason: 'not-downloaded',
      memory: { pendingDowngrade: null, lastSwitchAt: mem.lastSwitchAt },
    };
  }

  // Debounce heavy restarts across rapid consecutive sends.
  if (inp.now - mem.lastSwitchAt < SWITCH_DEBOUNCE_MS) {
    return {
      action: 'none',
      reason: 'debounced',
      memory: { pendingDowngrade: null, lastSwitchAt: mem.lastSwitchAt },
    };
  }

  return {
    action: 'switch',
    reason: cur === null ? 'initial' : 'tier-change',
    memory: { pendingDowngrade: null, lastSwitchAt: inp.now },
  };
}

// --- Explicit (user-driven) tier pick (pure) -------------------------------

export type ExplicitSwitchAction = 'download-prompt' | 'none' | 'switch';

/**
 * The decision for an EXPLICIT user tier pick (footer dropdown / model menu).
 * Deliberately un-gated: unlike the Auto router this has NO hysteresis, NO
 * debounce, and NO in-flight lock — an explicit user model change is honored
 * immediately (the user asked for it), even mid-stream. A tier whose model isn't
 * on disk opens the friendly download flow instead of switching; the
 * already-running model is a no-op. This is the counterpart to
 * {@link decideRoute}'s in-flight gate: the gate stops IMPLICIT mid-task
 * switches, this stays open so a user can always take manual control.
 */
export function explicitSwitchAction(inp: {
  downloaded: boolean;
  targetModelId: string;
  currentModelId: string | null;
}): ExplicitSwitchAction {
  if (!inp.downloaded) return 'download-prompt';
  if (inp.currentModelId !== null && inp.currentModelId === inp.targetModelId) return 'none';
  return 'switch';
}

// --- Auto-download prompt view (pure) --------------------------------------

/** Bytes → a friendly "N GB" / "N MB" (empty when unknown, so copy can omit it). */
export function formatTierBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export interface DownloadPromptView {
  /** e.g. "Download intelligent model" — no jargon, no manager reference. */
  title: string;
  /** Grey secondary, e.g. "qwen3.6 27b · 16 GB". */
  detail: string;
  modelId: string;
  quant: string;
}

/** Build the friendly auto-download card copy for a pending tier, or null. */
export function downloadPromptView(
  pending: { tier: ModelTier; pick: LlmTierPick } | null,
): DownloadPromptView | null {
  if (pending === null) return null;
  const { tier, pick } = pending;
  const size = formatTierBytes(pick.bytes);
  return {
    title: `Download ${TIER_LABEL[tier].toLowerCase()} model`,
    detail: size.length > 0 ? `${pick.displayName} · ${size}` : pick.displayName,
    modelId: pick.modelId,
    quant: pick.quant,
  };
}

/**
 * The tier's coarse response-speed word for the download Dialog's speedometer
 * caption. Bigger/smarter models decode slower, so the capability tier maps
 * inversely to felt speed: fast → "fast", balanced → "balanced", intelligent →
 * "slow". Pure — driven off the authoritative `pendingDownload.tier`.
 */
export function tierSpeed(tier: ModelTier): 'fast' | 'balanced' | 'slow' {
  switch (tier) {
    case 'fast':
      return 'fast';
    case 'balanced':
      return 'balanced';
    default:
      return 'slow';
  }
}

// --- Impure orchestration (reads the live stores, drives the restart) -------

/** The tier picks resolved for this machine (undefined before catalog load). */
function tierModels(): Record<ModelTier, LlmTierPick> | undefined {
  return useLlmStore.getState().recommendation?.tierModels;
}

/** The last effort level auto-pushed to the harness — so `effort:'auto'` only
 * fires a `/harness effort` when the tier (hence the level) actually changes,
 * not on every send. */
let lastAutoEffort: EffortLevel | null = null;

/**
 * When effort is in 'auto' mode, the effort level FOLLOWS the active tier
 * (fast→low, balanced→medium, intelligent→high — max is explicit-drag only).
 * Push it to the harness only on a real change. No-op when effort is pinned.
 *
 * Callers must gate this behind the in-flight check: it is only invoked at a clean
 * IDLE boundary (see {@link maybeRouteAuto}), so effort never silently re-derives
 * mid-task/mid-stream. Combined with the harness-continuity tier resolution, the
 * level only moves when the TASK's tier actually changes at a boundary.
 */
async function pushAutoEffort(level: EffortLevel): Promise<void> {
  if (useSettingsStore.getState().settings.effortMode !== 'auto') return;
  if (level === lastAutoEffort) return;
  lastAutoEffort = level;
  /*
   * AWAITED, not fire-and-forget. The level has to reach the harness BEFORE the
   * prompt does, because the harness decides the advertised tool set from the
   * effort it holds at that moment — dispatching first means the turn that asked
   * for a team is the one turn that can't have one. `maybeRouteAuto` is already
   * awaited by the sender, so awaiting here puts the effort ahead of the send.
   *
   * Through the store rather than straight at the harness: this level IS the
   * resolved effort now, so the slider, the corp gate and `/harness effort` all
   * read one value. `update` persists it and forwards the slash command itself.
   */
  await useSettingsStore.getState().update({ effort: level });
}

/**
 * Perform the hard-restart switch to a tier's model. Surfaces the live
 * "switching…" banner for the (seconds-long) llama-server restart, then reuses
 * the proven {@link activateLocalModel} path (start server → respawn pi on the
 * same session → re-point the model). Best-effort: a failed switch is swallowed
 * and self-corrects next turn (the current model id is re-read live).
 */
async function performSwitch(tier: ModelTier, pick: LlmTierPick): Promise<void> {
  const store = useModelSelectionStore.getState();
  store.setSwitching({ toTier: tier, toName: pick.displayName });
  try {
    await activateLocalModel(pick.modelId, pick.quant);
  } catch {
    // Leave the current model in place; the next turn re-derives from live state.
  } finally {
    useModelSelectionStore.getState().setSwitching(null);
  }
}

/**
 * Auto-router entry — called by `sendPrompt` BEFORE the prompt is dispatched.
 * No-op unless the selection is Auto. Awaited by the sender so the turn runs on
 * the routed model; the download-prompt path returns immediately (a slow
 * download must never block a send). Never throws.
 *
 * The model is chosen ONCE at a clean IDLE boundary (a fresh task's first send)
 * and then HELD for the task:
 *   - a turn in flight (streaming / a queued follow-up) is a hard NO-OP here — the
 *     running model is locked, so a second/queued send can't hard-restart llama
 *     mid-stream (the in-flight guard in {@link decideRoute}). An explicit user
 *     model change is the only thing that switches mid-task, and it doesn't route.
 *   - the tier is reconciled with the harness: our own tier-1 uses the harness's
 *     published `activeClass` as its continuity prior, and the hysteresis anchors
 *     on the harness's (possibly tier-2-corrected) `activeTier` — so the app router
 *     and the harness agree on the model for the task.
 *   - Auto-effort is pushed only here, at the same idle boundary, so it never
 *     silently re-derives mid-task.
 */
export async function maybeRouteAuto(
  prompt: string,
  _opts: { hasImages?: boolean } = {},
): Promise<void> {
  try {
    // The model is LOCKED once a turn is in flight — Auto only (re)picks a model
    // and re-derives effort at a clean idle boundary. A restart already in flight
    // (a live "switching…" banner) is treated the same, so overlapping sends never
    // stack two llama restarts.
    const inFlight = agentInFlight() || useModelSelectionStore.getState().switching !== null;

    /*
     * EFFORT IS A SETTING, NOT A GUESS.
     *
     * It used to be derived from the guessed task class on every send — a topic
     * classifier answering a question about SIZE, which is how "ask the manager
     * to set up a Godot demo" got told there was no tool for contacting a
     * manager (talk_to_manager is gated on high/max; the class said medium).
     * With classification gone the user's own effort setting stands, and only
     * one thing still overrides it: saying so in plain words.
     */
    if (!inFlight && asksForTheTeam(prompt)) await pushAutoEffort('max');

    if (useSettingsStore.getState().settings.modelSelection.mode !== 'auto') return;
    const models = tierModels();
    if (models === undefined) return; // catalog not loaded → nothing to route to

    const currentModelId = useLlmStore.getState().status.model?.id ?? null;
    /*
     * The SAME tier every send — the best one this machine has on disk. Auto
     * used to re-decide per prompt and restart the server whenever the answer
     * moved, which is seconds of dead air and a full re-prefill mid-conversation.
     */
    const desiredTier = autoTier(models, useLlmStore.getState().status.downloadedModelIds ?? []);
    if (desiredTier === null) return;
    const currentTier = tierForModelId(models, currentModelId);

    const pick = models[desiredTier];

    const sel = useModelSelectionStore.getState();
    const decision = decideRoute(
      { pendingDowngrade: sel.pendingDowngrade, lastSwitchAt: sel.lastSwitchAt },
      {
        currentTier,
        desiredTier,
        targetModelId: pick.modelId,
        currentModelId,
        downloaded: pick.downloaded,
        now: Date.now(),
        inFlight,
      },
    );

    // Commit the cross-turn memory regardless of the action. (In flight,
    // decideRoute returns the memory unchanged.)
    useModelSelectionStore.setState({
      pendingDowngrade: decision.memory.pendingDowngrade,
      lastSwitchAt: decision.memory.lastSwitchAt,
    });

    if (decision.action === 'download-prompt') {
      useModelSelectionStore.getState().setPendingDownload({ tier: desiredTier, pick });
      return;
    }
    if (decision.action === 'switch') {
      useModelSelectionStore.getState().setPendingDownload(null);
      await performSwitch(desiredTier, pick);
    }
  } catch {
    // Routing must never take a send down with it.
  }
}

// --- Startup auto-preload (a model is ALWAYS loaded) -----------------------

/**
 * Startup auto-preload (round-A #4): keep a model ALWAYS loaded. On app startup /
 * first chat, immediately bring the FASTEST already-downloaded model online so
 * quick requests have the lowest possible TTFT — no waiting on a large model to
 * load. The Auto router then keeps using this fast model for the fast tier and
 * only hard-restarts to a bigger model when the classifier routes up (existing
 * hysteresis/debounce), so the footer chip's "Auto · <loaded model>" reflects
 * whatever is currently resident.
 *
 * No-op unless the selection is Auto (a pinned tier/model owns its own load), when
 * a model is already resident, or when nothing is downloaded yet. Refreshes the
 * catalog + status first so the tier picks + downloaded set are current.
 * Best-effort — never throws (a failed preload just means the first send loads a
 * model on demand).
 */
/** Coalesces concurrent server-ensures onto one activation (boot preload + a
 * racing first send share it). Nulled when the ensure settles. */
let ensureServerPromise: Promise<void> | null = null;

/**
 * Guarantee a model server is up + healthy before a send, coalescing concurrent
 * callers onto ONE activation. Fast path (a server is already resident) resolves
 * synchronously with no IPC. Otherwise it resolves the boot model for the current
 * selection ({@link resolveBootModel}) and activates it — awaiting llama's health
 * poll — so the caller can dispatch safely afterwards.
 *
 * BOTH the boot preload and every send funnel through here, which closes the
 * "fetch failed" race: a "hi" typed while the boot model is still loading AWAITS
 * that same load instead of racing a dead endpoint (or kicking a duplicate
 * activation). No-op under `?piE2E` (probes must not launch a real llama-server).
 * Best-effort — a failed ensure is no worse than before.
 */
/**
 * WHY THE LAST WAIT FOR A SERVER ENDED WITHOUT ONE. `ensureChatServerReady`
 * used to give up in silence — a launch that failed, nothing downloaded, a load
 * that never finished — and the send went on to a server that was not there:
 * the "fetch failed" under a reply (the user, 2026-10-08). It now records the
 * reason here, and the send holds the message and shows it (HeldSendCard)
 * instead. Null when the last wait found a ready server, or did not run.
 */
export interface ServerProblem {
  readonly kind: 'no-model' | 'failed' | 'timeout';
  /** The model it tried to start, by its display name. */
  readonly modelName?: string;
  /** The supervisor's or the launch's own words, for Details. */
  readonly detail?: string;
}
let serverProblem: ServerProblem | null = null;
export function lastServerProblem(): ServerProblem | null {
  return serverProblem;
}
/** For tests: forget the last outcome. */
export function resetServerProblem(): void {
  serverProblem = null;
}

function displayNameOf(modelId: string | undefined): string | undefined {
  if (modelId === undefined) return undefined;
  return useLlmStore.getState().catalog.find((c) => c.id === modelId)?.displayName ?? modelId;
}

/** The chat server is up, loaded and not mid-switch. */
export function chatServerReady(): boolean {
  return serverIsReady() && !switchInProgress();
}

function serverIsReady(): boolean {
  const s = useLlmStore.getState().status;
  // llama `/health` returns 503 while the model loads, so the supervisor only
  // reaches phase 'ready' once inference will actually succeed (no 503).
  return s.phase === 'ready' && s.serverRunning && s.model?.id != null;
}

/**
 * A relaunch the RENDERER has decided on but the supervisor has not yet
 * reflected. `activateLocalModel` raises the "switching…" banner the instant
 * it starts (every path: a pick, the vision relaunch, calibration), and the
 * server's phase only turns 'starting' an IPC round-trip later — so a send in
 * that gap saw a ready server, dispatched, and pi's request landed on a port
 * that was being torn down. MEASURED 2026-09-15: "present it" typed right
 * after a picture on a text-only engine (the on-demand vision relaunch) — a
 * red "fetch failed" on the reply, then the turn carried on after the repoint.
 */
function switchInProgress(): boolean {
  return useModelSelectionStore.getState().switching !== null;
}

// `[pi-diag]` lines are mirrored to the terminal in dev (see main.ts) so the
// server-start decision is visible instead of a silent no-op.
const diag = (msg: string): void => {
  if (typeof console !== 'undefined') console.log(`[pi-diag] ${msg}`);
};

export function ensureChatServerReady(): Promise<void> {
  /*
   * THIS USED TO SKIP ON `?piE2E` — the SAME flag that unlocks `window.__pi_store`
   * for probes. So the moment a probe made the app observable, it also stopped it
   * ever starting a model: every turn answered "fetch failed", and every live
   * probe in this repo has been driving a deliberately server-less app. the user,
   * after I reported it as a possible inference bug: "the fetch failed thing has
   * always been something with your probes."
   *
   * Observing the app and disabling it are different intentions and now have
   * different flags. `?piNoServer` skips the boot — which is what a mock-pi
   * fixture run wants, since there is no model to talk to anyway — while a
   * REAL=1 probe boots a server exactly like the shipped app.
   */
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('piNoServer')
  )
    return Promise.resolve();
  /*
   * PARKED IS NOT READY. The status reports a parked server as running (its
   * port is kept), so this read "ready" and the send went to a stopped
   * process — MEASURED (Qwen 3.8 27B): "fetch failed", twice, with the model
   * parked by the memory guardian and 79% of memory free. Wake it first.
   */
  if (useLlmStore.getState().status.parked !== undefined) {
    diag('ensureChatServerReady: the model is parked — resuming it before the send');
    return window.piDesktop
      .invoke('llm:resume-server', undefined)
      .then(() => useLlmStore.getState().refreshStatus())
      .then(() => undefined)
      .catch(() => undefined);
  }
  if (serverIsReady() && !switchInProgress()) {
    diag('ensureChatServerReady: server already ready — no-op');
    serverProblem = null;
    return Promise.resolve();
  }
  if (ensureServerPromise !== null) return ensureServerPromise;
  ensureServerPromise = (async () => {
    try {
      const llm = useLlmStore.getState();
      await Promise.all([llm.refreshCatalog(), llm.refreshStatus()]);
      const fresh = useLlmStore.getState();
      const phase = fresh.status.phase;
      const sel = useSettingsStore.getState().settings.modelSelection;
      // CRITICAL: if a server is already coming up (model loading) or a model is
      // downloading, WAIT — do NOT re-activate. startServer disposes the current
      // server and restarts it, so a re-activation mid-load throws away the
      // in-progress load, the model never finishes, and pi respawns each time
      // (the bobbing "exec" + an endless 503 "Loading model"). Only start a server
      // when nothing is coming up (idle / error / no server).
      if (
        phase !== 'starting' &&
        phase !== 'downloading' &&
        !serverIsReady() &&
        !switchInProgress()
      ) {
        let target = resolveBootModel(sel, {
          tierModels: fresh.recommendation?.tierModels,
          downloadedModelIds: fresh.status.downloadedModelIds,
          serverRunning: fresh.status.serverRunning,
          currentModelId: fresh.status.model?.id ?? null,
        });
        // Never silently give up with a model on disk: if the selection can't be
        // resolved (e.g. the recommendation/tier picks haven't loaded, or don't
        // match what's downloaded), just start the FIRST downloaded model so a
        // server always comes up.
        if (target === null && fresh.status.downloadedModelIds.length > 0) {
          target = { modelId: fresh.status.downloadedModelIds[0] as string };
        }
        diag(
          `ensureChatServerReady: phase=${phase} selection=${JSON.stringify(sel)} ` +
            `downloaded=[${fresh.status.downloadedModelIds.join(',')}] ` +
            `recommendation=${fresh.recommendation ? 'loaded' : 'MISSING'} ` +
            `→ target=${JSON.stringify(target)}`,
        );
        if (target !== null) {
          const started = await activateLocalModel(target.modelId, target.quant);
          if (!started.success) {
            serverProblem = {
              kind: 'failed',
              ...(displayNameOf(target.modelId) !== undefined
                ? { modelName: displayNameOf(target.modelId) as string }
                : {}),
              detail: started.error ?? useLlmStore.getState().status.error ?? '',
            };
            diag(`ensureChatServerReady: the launch failed — ${serverProblem.detail}`);
            return;
          }
        } else {
          diag('ensureChatServerReady: NO model to start — nothing downloaded');
          serverProblem = { kind: 'no-model' };
          return;
        }
      } else {
        diag(`ensureChatServerReady: phase=${phase} (coming up/ready) — waiting, not restarting`);
      }
      // Poll the live (pushed) status until the model is READY (loaded) — so the
      // send waits out a slow load instead of racing a 503. Bounded generously for
      // a large model; a terminal 'error'/'idle' releases it (the send then shows
      // whatever the model returns rather than hanging forever).
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        if (serverIsReady() && !switchInProgress()) {
          diag('ensureChatServerReady: server READY');
          serverProblem = null;
          return;
        }
        const st = useLlmStore.getState().status;
        const p = st.phase;
        if ((p === 'error' || p === 'idle') && !switchInProgress()) {
          diag(`ensureChatServerReady: giving up — phase=${p}`);
          const name = displayNameOf(st.model?.id);
          serverProblem =
            st.downloadedModelIds.length === 0
              ? { kind: 'no-model' }
              : {
                  kind: 'failed',
                  ...(name !== undefined ? { modelName: name } : {}),
                  detail: st.error ?? '',
                };
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      diag('ensureChatServerReady: timed out waiting for ready');
      const name = displayNameOf(useLlmStore.getState().status.model?.id);
      serverProblem = { kind: 'timeout', ...(name !== undefined ? { modelName: name } : {}) };
    } catch (e) {
      diag(`ensureChatServerReady ERROR: ${e instanceof Error ? e.message : String(e)}`);
      serverProblem = { kind: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
  })().finally(() => {
    ensureServerPromise = null;
  });
  return ensureServerPromise;
}

/** Startup auto-preload — bring a server online at boot so the first send never
 * races a dead endpoint. Delegates to the coalesced {@link ensureChatServerReady}. */
export async function preloadFastestModel(): Promise<void> {
  await ensureChatServerReady();
}

// --- Explicit footer selections (bypass hysteresis) ------------------------

/**
 * Footer dropdown "Auto" — persist the auto selection and clear any pending
 * download card. The next send routes per the classifier.
 */
export async function selectAuto(): Promise<void> {
  useModelSelectionStore.getState().setPendingDownload(null);
  await setModelSelection({ mode: 'auto' });
}

/**
 * Footer dropdown tier pick — persist the pinned tier AND apply it now. Unlike
 * the Auto router this is an explicit choice, so there's no hysteresis: switch
 * immediately when the model is downloaded.
 *
 * the user #4: a tier whose model ISN'T on disk can't become the active selection —
 * picking it opens the friendly download flow WITHOUT pinning a model that isn't
 * present (so the chip never claims a non-downloaded tier is active, and the
 * checkmark never lies). The tier only becomes active after the download lands.
 */
/**
 * Pin a SPECIFIC model — a favourite, or a row from the full list.
 *
 * The tier path exists because a tier is a capability the app resolves to a
 * model; this is the user naming the model themselves, so there is no tier to
 * resolve and no download prompt to run: the list this is called from only
 * offers models that are already on disk.
 */
/**
 * Pin a SPECIFIC model — and actually load it.
 *
 * THE BUG THIS FIXES. This used to persist the pin and stop there. Its sibling
 * `selectTier` ends in `performSwitch`, which starts the server, respawns pi on
 * the same session and re-points the provider; picking a model by name did none
 * of that. So the choice was recorded, the picker drew its checkmark against
 * it, and the inference server carried on holding whatever was already resident
 * — which is why the user's composer chip kept saying "Qwen3.5 4B (MTP)" after he
 * picked LFM (it was reporting the truth), and why the very next turn answered
 * "fetch failed": pi had been re-pointed at a provider model nobody had loaded.
 *
 * Two surfaces disagreeing was the visible symptom; this is the cause, and the
 * chip's own fix (naming the pinned model) is only honest once the pin is real.
 *
 * NO-OP WHEN IT IS ALREADY RESIDENT, so re-picking the current model from the
 * menu does not pay for a multi-second llama restart to arrive where it is.
 */
export async function selectModel(modelId: string): Promise<void> {
  useModelSelectionStore.getState().setPendingDownload(null);
  await setModelSelection({ mode: 'model', modelId });

  if (useLlmStore.getState().status.model?.id === modelId) return;

  const entry = useLlmStore.getState().catalog.find((e) => e.id === modelId);
  const store = useModelSelectionStore.getState();
  store.setSwitching({ toTier: entry?.tier ?? 'balanced', toName: entry?.displayName ?? modelId });
  try {
    // A person picked this from the model menu: let a reply that is already
    // running finish rather than killing it mid-sentence (the user).
    await activateLocalModel(modelId, undefined, 'fast-text', { waitForIdleTurn: true });
  } catch {
    // Leave the current model in place; the next turn re-derives from live state
    // — the same contract as performSwitch.
  } finally {
    useModelSelectionStore.getState().setSwitching(null);
  }
}

export async function selectTier(tier: ModelTier): Promise<void> {
  const models = tierModels();
  const pick = models?.[tier];
  const currentModelId = useLlmStore.getState().status.model?.id ?? null;
  // Explicit user pick: no hysteresis, no debounce, and — deliberately — no
  // in-flight gate. {@link explicitSwitchAction} is the pure decision.
  const action =
    pick !== undefined
      ? explicitSwitchAction({
          downloaded: pick.downloaded,
          targetModelId: pick.modelId,
          currentModelId,
        })
      : null;

  // Not downloaded → open the download prompt; do NOT pin it as active (#4).
  if (action === 'download-prompt' && pick !== undefined) {
    useModelSelectionStore.getState().setPendingDownload({ tier, pick });
    return;
  }

  await setModelSelection({ mode: 'tier', tier });
  /*
   * Pinning a MODEL must not pin the THINKING. This used to push the tier's
   * effort, which is how choosing "Fast" quietly capped every later task at
   * `low`. Adaptive effort now comes from the next message's classification, so
   * a small model asked to build something still thinks hard — and still has a
   * team.
   */
  if (pick === undefined) return; // catalog not loaded — pin persisted, nothing to launch

  useModelSelectionStore.getState().setPendingDownload(null);
  useModelSelectionStore.getState().markSwitched(Date.now());
  if (action !== 'switch') return; // already on it — no restart
  await performSwitch(tier, pick);
}

/**
 * AutoDownloadPrompt "Download" — download the pending tier's model, then (on a
 * confirmed download) switch to it. Clears the card either way.
 */
export async function downloadPendingTier(): Promise<void> {
  const pending = useModelSelectionStore.getState().pendingDownload;
  if (pending === null) return;
  const { tier, pick } = pending;
  await useLlmStore.getState().downloadModel(pick.modelId, pick.quant);
  // refreshCatalog (inside downloadModel) refreshes the tier picks' downloaded flag.
  const fresh = useLlmStore.getState().recommendation?.tierModels?.[tier] ?? pick;
  useModelSelectionStore.getState().setPendingDownload(null);
  if (fresh.downloaded) await performSwitch(tier, fresh);
}
