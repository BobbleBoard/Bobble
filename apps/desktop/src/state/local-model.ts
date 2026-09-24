/**
 * Brings a local model online end-to-end and makes pi use it:
 *   download (if needed) → start the engine server (supervisor writes models.json)
 *   → re-point pi at the matching provider.
 *
 * Model-switch strategy (hot-reload vs restart):
 * pi caches models.json at spawn, and the frozen provider-llamacpp extension
 * exposes no runtime "re-register with the new model" command, so a true
 * hot-reload isn't reachable from this workstream. We therefore do a GRACEFUL
 * restart that preserves the conversation: the pi child is respawned on the
 * SAME session file (the renderer keeps the rendered thread, and pi resumes the
 * session it was already writing), so switching models never dead-ends the
 * chat. If provider-llamacpp later gains a runtime re-register command, this is
 * the one seam to swap for a no-restart path.
 *
 * Two launch modes flow through here (round-12):
 *   - 'fast-text'  → the default speed launch (MTP / EAGLE-3 when available).
 *   - 'multimodal' → the on-demand VISION launch: the supervisor fetches the
 *     mmproj sibling and relaunches WITHOUT MTP (mmproj ⊥ MTP). Sticky for the
 *     session — {@link ensureVisionMode} no-ops once the server is multimodal.
 * And two engines: 'llamacpp' (GGUF, the default) and 'mlx' (Apple-Silicon
 * foundation) — the provider pi is re-pointed at is chosen by the model's engine.
 */

import type { LaunchMode } from '@pi-desktop/inference';
import { useLlmStore } from './llm-store';
import { useModelSelectionStore } from './model-selection-store';
import { getModels, getPiState, restartPi, setModel } from './pi-connect';
import { usePiStore } from './pi-slice';
import { applySavedHarnessConfig, useSettingsStore } from './settings-store';

/** The models.json provider key a model's engine binds to. */
function providerForEngine(engine: 'llamacpp' | 'mlx' | undefined): string {
  return engine === 'mlx' ? 'mlx' : 'llamacpp';
}

/** The catalog entry's engine for a model id (defaults to llamacpp when unknown). */
function engineFor(modelId: string): 'llamacpp' | 'mlx' {
  return useLlmStore.getState().catalog.find((e) => e.id === modelId)?.engine ?? 'llamacpp';
}

/**
 * Wait for the conversation to go idle, up to `capMs`.
 *
 * the user: changing model mid-conversation "often totally breaks … a brief flash of
 * 'loading model' then everything completely stops and running halts." That is
 * literal: switching stops the llama-server the current turn is generating
 * against and then disposes the pi child, so the reply dies mid-sentence with no
 * error to show for it.
 *
 * A user-initiated switch therefore lets the turn finish first. The cap is a
 * backstop against a wedged turn holding a switch forever — past it we go ahead,
 * which is the old behaviour and no worse.
 */
function whenTurnIdle(capMs = 5 * 60 * 1000): Promise<void> {
  const busy = () => {
    const st = usePiStore.getState();
    return st.agent.isStreaming || st.promptInFlight;
  };
  if (!busy()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, capMs);
    const unsubscribe = usePiStore.subscribe(() => {
      if (!busy()) finish();
    });
  });
}

/** Options for {@link activateLocalModel}. */
export interface ActivateOptions {
  /**
   * Let a turn that is already running FINISH before swapping the server out.
   * Set by the surfaces a person clicks (the model picker, "Use" in the model
   * hub); NOT set by the in-send paths (vision relaunch, Auto routing), which
   * run inside `sendPrompt` with `promptInFlight` already raised and would
   * deadlock waiting for themselves.
   */
  readonly waitForIdleTurn?: boolean;
}

export async function activateLocalModel(
  modelId: string,
  quant?: string,
  launchMode: LaunchMode = 'fast-text',
  options: ActivateOptions = {},
): Promise<{ success: boolean; error?: string }> {
  /*
   * THE SWITCH IS VISIBLE NOW.
   *
   * the user: "changing models mid conversation shows no sign of working … no
   * 'switching to <model>', no 'processing… n%', no 'loading model'." The banner
   * state existed (model-selection-store's `switching`) but only ONE of the four
   * entry points set it, and the component that rendered it had been consolidated
   * away — so most switches ran completely silently for the ten-to-a-hundred
   * seconds a model takes to load. Setting it here covers every path at once.
   *
   * `owned` keeps a nested call (selectModel already set it) from clearing a
   * banner it did not raise.
   */
  const entry = useLlmStore.getState().catalog.find((e) => e.id === modelId);
  const owned = useModelSelectionStore.getState().switching === null;
  if (owned) {
    useModelSelectionStore.getState().setSwitching({
      toTier: entry?.tier ?? 'balanced',
      toName: entry?.displayName ?? modelId,
    });
  }
  try {
    if (options.waitForIdleTurn === true) await whenTurnIdle();
    return await activate(modelId, quant, launchMode);
  } finally {
    if (owned) useModelSelectionStore.getState().setSwitching(null);
  }
}

async function activate(
  modelId: string,
  quant: string | undefined,
  launchMode: LaunchMode,
): Promise<{ success: boolean; error?: string }> {
  const store = useLlmStore.getState();
  if (!store.status.downloadedModelIds.includes(modelId)) {
    // MLX models are auto-downloaded by mlx_lm.server on first launch, so they
    // never register in our GGUF download tracking — don't gate them on it.
    if (engineFor(modelId) !== 'mlx') {
      await store.downloadModel(modelId, quant);
      if (!useLlmStore.getState().status.downloadedModelIds.includes(modelId)) {
        return { success: false, error: 'download did not complete' };
      }
    }
  }

  const started = await store.startServer(modelId, quant, launchMode);
  if (!started.success) return started;

  await repointPiAtRunningServer(modelId);
  return { success: true };
}

/**
 * POINT PI AT THE SERVER THAT IS UP NOW.
 *
 * A (re)launch moves the server to a new port and, since calibration, possibly
 * to a different ENGINE — so the models.json block pi should read is the one
 * the supervisor says it registered (`status.provider`: `llamacpp` for
 * llama-server, `mlx` for every OpenAI-compatible engine), not the one the
 * catalogue implies for the model. Respawns pi on the same session so the
 * thread is kept, then re-applies the saved harness config a fresh session
 * drops. Shared by the model switch, the vision relaunch, calibration and a
 * hand-picked engine, so the four cannot drift.
 */
export async function repointPiAtRunningServer(modelId?: string): Promise<void> {
  // Graceful restart preserving the current session so the chat is not
  // dead-ended (see file header). Respawn on the same session file when one
  // exists; the rendered thread in the store stays put.
  const sessionFile = usePiStore.getState().session?.sessionFile;
  await restartPi(sessionFile !== undefined ? { sessionPath: sessionFile } : undefined);

  const status = useLlmStore.getState().status;
  const providerName =
    status.provider ?? providerForEngine(engineFor(modelId ?? status.model?.id ?? ''));
  const models = await getModels();
  const target = models.models.find((m) => m.provider === providerName);
  // eslint-disable-next-line no-console
  console.log(
    `[pi-diag] repoint: want provider=${providerName} (engine ${status.profile?.engine ?? '?'}); pi lists ${models.models.map((m) => `${m.provider}/${m.id}`).join(', ') || 'nothing'}; target=${target === undefined ? 'NONE' : `${target.provider}/${target.id}`}`,
  );
  if (target !== undefined) {
    const ack = await setModel(target.provider, target.id);
    // eslint-disable-next-line no-console
    console.log(`[pi-diag] repoint: set_model → ${JSON.stringify(ack)}`);
    /*
     * MIRROR THE SWITCH. pi 0.68 answers `set_model` without a `model_change`
     * event, so the store's `agent.model` — the footer chip, the engine menu's
     * "pi is on …" — kept naming the model the child STARTED with. MEASURED
     * after a calibration swap to llama.cpp: pi answered on llama.cpp while the
     * store still said `mlx`. Read the state back once and say what is true.
     */
    const state = await getPiState().catch(() => null);
    const m = state?.state?.model;
    if (m != null) {
      usePiStore.setState((s) => ({
        agent: { ...s.agent, model: { id: m.id, name: m.name, provider: m.provider } },
      }));
    }
  }

  // A fresh session drops the harness runtime config — re-apply the saved one.
  applySavedHarnessConfig();
}

// ---------------------------------------------------------------------------
// On-demand vision (round-12 ask #3)
// ---------------------------------------------------------------------------

/** The live state the vision decision reads (subset of LlmStatus + catalog). */
export interface VisionState {
  /** The launch mode of the running server (multimodal ⇒ vision already on). */
  readonly launchMode?: 'fast-text' | 'multimodal';
  /**
   * Whether the RUNNING server already has a vision projector attached — the
   * question `launchMode` was standing in for, and got wrong. The projector is
   * attached on every llama.cpp launch now (0.9% measured), so an ordinary
   * fast-text server can see, and relaunching it buys nothing while costing a
   * ~105s reload and the session's speculative decoding.
   */
  readonly visionReady?: boolean;
  /** The running model, or null when none is up. */
  readonly model?: { readonly id: string; readonly quant?: string } | null;
  /** Catalog entries (only `id` + `vision` are read). */
  readonly catalog: ReadonlyArray<{ readonly id: string; readonly vision?: boolean }>;
  /**
   * The model the user PINNED by name, when they pinned one (null under Auto or
   * a tier). Its presence disables the switch-to-another-model fallback below —
   * see {@link resolveVisionTarget}.
   */
  readonly pinnedModelId?: string | null;
  /**
   * The user switched vision OFF (engine menu → Vision; `loadVision: false`).
   * Then nothing relaunches to see — see {@link resolveVisionTarget}.
   */
  readonly visionOff?: boolean;
  /** Resolved tier picks (for the text-only-model fallback), when loaded. */
  readonly tierModels?: Record<
    'fast' | 'balanced' | 'intelligent',
    {
      readonly modelId: string;
      readonly quant: string;
      readonly vision: boolean;
      readonly downloaded: boolean;
    }
  >;
}

export type VisionDecision =
  | { readonly action: 'already-on' }
  | { readonly action: 'relaunch'; readonly modelId: string; readonly quant?: string }
  | { readonly action: 'none'; readonly reason: string }
  /** The user switched vision off: send as it is, the image described as unseen. */
  | { readonly action: 'off' };

/**
 * Pure: decide how to get the running setup into a vision-capable state.
 *   - the running server can already see → nothing to do,
 *   - current model supports vision → relaunch IT in multimodal,
 *   - the user PINNED a text-only model → do nothing, and say why,
 *   - else → the best downloaded vision-capable tier pick (intelligent → balanced
 *     → fast) so an image on a text-only model is still seen,
 *   - else → nothing available.
 *
 * A PIN IS AN INSTRUCTION, NOT A PREFERENCE.
 *
 * MEASURED, and it cost two ten-task benchmark runs before the log gave it up:
 * with Ling 3.0 (text-only) explicitly pinned, a tool screenshotted a page, main
 * raised `llm:vision-wanted`, and this function answered "relaunch
 * qwen3.5-9b-mtp" — a model the user had not chosen, on a 105-second load, which
 * took the running turn with it. The turn produced zero characters and sat until
 * the cap. Nothing on screen said the model had changed.
 *
 * Falling back to another model is right when the app is choosing the model
 * anyway (Auto, or a tier). When the user has named one, silently running a
 * different one is worse than not seeing the image — the image is one turn, and
 * the swap is the rest of the session.
 */
/**
 * A reactive hook for {@link imagesUnsupported}, reading the live stores.
 *
 * Subscribes to the four fields the decision actually depends on rather than
 * whole stores, so an unrelated status push does not re-render the composer.
 */
export function useImagesUnsupported(): boolean {
  return useImageBlindness() !== null;
}

/** The live {@link imageBlindness}: 'off' when the user switched vision off. */
export function useImageBlindness(): 'off' | 'unsupported' | null {
  const launchMode = useLlmStore((s) => s.status.launchMode);
  const visionReady = useLlmStore((s) => s.status.visionReady);
  const model = useLlmStore((s) => s.status.model);
  const catalog = useLlmStore((s) => s.catalog);
  const tierModels = useLlmStore((s) => s.recommendation?.tierModels);
  const selection = useSettingsStore((s) => s.settings.modelSelection);
  const visionOff = useSettingsStore((s) => s.settings.loadVision === false);
  // Nothing resident yet ⇒ nothing to warn about; the model is still coming up
  // and the pill is already saying so.
  if (model === null) return null;
  return imageBlindness({
    launchMode,
    visionReady,
    model,
    catalog,
    pinnedModelId: selection?.mode === 'model' ? selection.modelId : null,
    tierModels,
    visionOff,
  });
}

/**
 * Can an image be seen AT ALL in the current setup — now, or after a relaunch?
 *
 * the user: "for images on non visual model, show a yellow circle + ! on images both
 * in chat input and when sent and then show a quick pill bar … that just simply
 * says 'selected model does not support images'."
 *
 * This is the same question {@link resolveVisionTarget} already answers on the
 * send path; asking it in the composer just moves the answer to before the
 * mistake instead of after it. `none` is the honest signal — it covers both a
 * pinned text-only model (a pin is an instruction, so we will not swap) and a
 * machine with no vision-capable model downloaded.
 */
export function imagesUnsupported(s: VisionState): boolean {
  return imageBlindness(s) !== null;
}

/** Why an attached image will go unseen — the switch, or the setup — or null. */
export function imageBlindness(s: VisionState): 'off' | 'unsupported' | null {
  const action = resolveVisionTarget(s).action;
  return action === 'off' ? 'off' : action === 'none' ? 'unsupported' : null;
}

export function resolveVisionTarget(s: VisionState): VisionDecision {
  // Already able to see: either a projector is attached (the normal case now)
  // or this server was explicitly launched multimodal.
  if (s.visionReady === true || s.launchMode === 'multimodal') return { action: 'already-on' };
  /*
   * OFF MEANS OFF. the user (2026-09-23): vision is on "unless the user says to turn
   * it off". MEASURED before this line: with the switch off, attaching a picture
   * relaunched the server multimodal behind the user's back — five minutes of
   * reload, the model then read the picture, and the switch said Off the whole
   * time. The image goes as it is; the provider tells the model, in the note,
   * that vision is switched off and where to turn it on.
   */
  if (s.visionOff === true) return { action: 'off' };

  const currentId = s.model?.id ?? null;
  const currentVision =
    currentId !== null && s.catalog.find((e) => e.id === currentId)?.vision === true;
  if (currentVision && currentId !== null) {
    return { action: 'relaunch', modelId: currentId, quant: s.model?.quant };
  }

  if (s.pinnedModelId !== undefined && s.pinnedModelId !== null) {
    return {
      action: 'none',
      reason: `${s.pinnedModelId} is pinned and cannot see images; not switching models`,
    };
  }

  const tiers = s.tierModels;
  const pick =
    tiers !== undefined
      ? [tiers.intelligent, tiers.balanced, tiers.fast].find((p) => p.vision && p.downloaded)
      : undefined;
  if (pick !== undefined) return { action: 'relaunch', modelId: pick.modelId, quant: pick.quant };

  return { action: 'none', reason: 'no vision-capable model available' };
}

/**
 * Ensure the running model can see images — the on-demand VISION trigger.
 *
 * Delegates the choice to {@link resolveVisionTarget} (pure), then acts:
 * a no-op when already multimodal (vision is sticky), otherwise a multimodal
 * RELAUNCH of the current vision model (or a vision-capable fallback pick).
 *
 * Restart-based + honest about the cost: a vision relaunch drops MTP/spec-decode
 * for the session (mmproj ⊥ MTP), so text generation is a bit slower afterwards.
 *
 * Exposed so the vision-input paths call it before dispatch:
 *   - image upload → wired in `pi-connect.sendPrompt`,
 *   - browser / computer-use screenshots → those paths can call this too (their
 *     full wiring is a follow-up).
 *
 * Never throws; returns whether vision mode is (now) active and whether a relaunch
 * happened.
 */
export async function ensureVisionMode(): Promise<{
  ok: boolean;
  changed: boolean;
  reason?: string;
}> {
  const llm = useLlmStore.getState();
  const settings = useSettingsStore.getState().settings;
  const selection = settings.modelSelection;
  const decision = resolveVisionTarget({
    launchMode: llm.status.launchMode,
    visionReady: llm.status.visionReady,
    model: llm.status.model,
    catalog: llm.catalog,
    pinnedModelId: selection?.mode === 'model' ? selection.modelId : null,
    tierModels: llm.recommendation?.tierModels,
    visionOff: settings.loadVision === false,
  });

  // Switched off: send as it is — the provider's note tells the model why it
  // cannot see, and the composer already told the user.
  if (decision.action === 'already-on' || decision.action === 'off') {
    return { ok: true, changed: false };
  }
  if (decision.action === 'none') return { ok: false, changed: false, reason: decision.reason };

  // Never over a running turn: the relaunch is a hard restart of the server pi
  // is talking to (the vision-wanted handler already waited for quiet; a send
  // that slipped in since is let finish).
  const res = await activateLocalModel(decision.modelId, decision.quant, 'multimodal', {
    waitForIdleTurn: true,
  });
  return { ok: res.success, changed: res.success, reason: res.error };
}
