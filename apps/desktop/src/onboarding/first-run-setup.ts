/**
 * GETTING THIS MAC RUNNING — the engine and the model a first run starts with.
 *
 * The user: "at onboarding / initial setup we need to get 1. an optimal engine
 * initially, download the qwen3.5 4b checkpoint". The person does not choose:
 * the engine is `recommendedEngine` (the same function the Engines panel marks
 * "Recommended" with) and the model is the 4B.
 *
 * ONE STORE, TWO PLACES. Onboarding's last page starts it ("Download and
 * finish") and closes at once, and the empty chat shows how far it has got
 * and offers the same one click to someone who chose "Skip for now". Both read
 * this store, so a download started on one is the one shown on the other.
 *
 * NOBODY WAITS ON IT. Before 2026-10-09 the last page had its own "Set up now"
 * that held the page until gigabytes arrived, beside a "Finish setup" that
 * started nothing. Now the engines install and the model downloads in this
 * renderer's background; the model's own progress, pause and failure live in
 * the llm store and the download tray, as for any other model.
 */
import { create } from 'zustand';
import type { HarnessDetected } from '../../electron/ipc-contract';
import {
  type EngineSpec,
  type HostCapabilities,
  installPrerequisites,
  recommendedEngine,
} from '../settings/engine-catalog';
import { HARNESSES } from '../settings/harness-catalog';
import { useLlmStore } from '../state/llm-store';
import { setupPlan } from './onboarding-logic';

export { type SetupPlan, setupPlan } from './onboarding-logic';

/** The checkpoint every fresh install lands with. */
export const START_MODEL_ID = 'qwen3.5-4b-mtp';
/** Its name as a person reads it (the catalog's says "(MTP)"). */
export const START_MODEL_NAME = 'Qwen3.5 4B';

export type SetupPhase = 'idle' | 'working' | 'done' | 'failed';

interface FirstRunSetupState {
  /** The machine, the engines and the model have been looked at once. */
  readonly checked: boolean;
  readonly host: HostCapabilities | null;
  readonly engine: EngineSpec | null;
  readonly installedEngineIds: ReadonlySet<string>;
  /** Other coding agents found on this Mac (Claude Code, Codex, …). */
  readonly harnesses: readonly HarnessDetected[];
  readonly enginePhase: SetupPhase;
  readonly engineError: string | null;
  /** Look at the machine, the installed engines and the models on disk. */
  check: () => Promise<void>;
  /** Install the engines this Mac needs, then start the model's download. Never awaits the download. */
  start: () => Promise<void>;
}

let checking: Promise<void> | null = null;

export const useFirstRunSetup = create<FirstRunSetupState>((set, get) => ({
  checked: false,
  host: null,
  engine: null,
  installedEngineIds: new Set(),
  harnesses: [],
  enginePhase: 'idle',
  engineError: null,

  check: () => {
    if (checking !== null) return checking;
    checking = (async () => {
      const llm = useLlmStore.getState();
      const probes = HARNESSES.filter((h) => h.bin !== undefined).map((h) => ({
        id: h.id,
        bin: h.bin as string,
      }));
      const [host, engines, harnesses] = await Promise.all([
        window.piDesktop
          .invoke('app:get-info', undefined)
          .then(
            (info): HostCapabilities => ({
              platform:
                info.platform === 'darwin' || info.platform === 'win32' ? info.platform : 'linux',
              appleSilicon: info.platform === 'darwin' && info.arch === 'arm64',
            }),
          )
          .catch((): HostCapabilities => ({ platform: 'linux', appleSilicon: false })),
        window.piDesktop.invoke('engines:list', undefined).catch(() => ({ engines: [] })),
        window.piDesktop
          .invoke('harness:detect', { probes })
          .then((r) => r.found.filter((f) => f.installed))
          .catch(() => [] as HarnessDetected[]),
        llm.refreshStatus().catch(() => undefined),
        llm.refreshCatalog().catch(() => undefined),
      ]);
      set({
        checked: true,
        host,
        engine: recommendedEngine(host),
        installedEngineIds: new Set(engines.engines.filter((e) => e.installed).map((e) => e.id)),
        harnesses,
      });
    })().finally(() => {
      checking = null;
    });
    return checking;
  },

  start: async () => {
    if (get().enginePhase === 'working') return;
    if (!get().checked) await get().check();
    const { engine, installedEngineIds } = get();
    const llm = useLlmStore.getState();
    if (engine !== null) {
      const plan = setupPlan({
        engine,
        prerequisites: installPrerequisites(engine.id),
        installedEngineIds,
        modelBytes: 0,
        modelPresent: true,
      });
      if (plan.engines.length > 0) {
        set({ enginePhase: 'working', engineError: null });
        for (const dep of plan.engines) {
          const res = await window.piDesktop
            .invoke('engines:install', { id: dep.id })
            .catch(() => ({ success: false, error: 'the request failed' }));
          if (!res.success) {
            set({
              enginePhase: 'failed',
              engineError: res.error ?? `${dep.name} did not install`,
            });
            break;
          }
          set((s) => ({ installedEngineIds: new Set([...s.installedEngineIds, dep.id]) }));
        }
        if (get().enginePhase === 'working') set({ enginePhase: 'done' });
      } else {
        set({ enginePhase: 'done' });
      }
    }
    // The model comes regardless: it runs on llama.cpp, which arrives with it,
    // so a faster engine that failed to install never leaves the Mac without
    // a model to answer with.
    if (!modelOnDisk() && useLlmStore.getState().download?.modelId !== START_MODEL_ID) {
      void llm.downloadModel(START_MODEL_ID);
    }
  },
}));

/** The start model's catalog entry, once the catalog has been read. */
export function startModelEntry() {
  return useLlmStore.getState().catalog.find((m) => m.id === START_MODEL_ID) ?? null;
}

function modelOnDisk(): boolean {
  const llm = useLlmStore.getState();
  return (
    llm.status.downloadedModelIds.includes(START_MODEL_ID) || startModelEntry()?.downloaded === true
  );
}

/** Bytes the start model downloads (the catalog's first file, as llm:download-model picks). */
export function startModelBytes(): number {
  return startModelEntry()?.quants[0]?.bytes ?? 0;
}

/**
 * Whether this Mac has no chat model at all — the empty chat's card and the
 * first-run tips both ask. False until the models on disk have been read, so
 * nothing flashes on a Mac that has models.
 */
export function useNoModelYet(): boolean {
  const checked = useFirstRunSetup((s) => s.checked);
  const ids = useLlmStore((s) => s.status.downloadedModelIds);
  const anyInCatalog = useLlmStore((s) => s.catalog.some((m) => m.downloaded));
  return checked && ids.length === 0 && !anyInCatalog;
}
