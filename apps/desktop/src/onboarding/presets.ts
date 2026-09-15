/**
 * ONBOARDING PRESETS — minimal / default / max, as a plan over what this
 * machine can actually hold.
 *
 * the user (2026-09-13, queued; 2026-09-15 "prep onboarding work"): "redo
 * onboarding with 'minimal' / 'default' / 'max' presets — minimal = just base
 * pi; default/max = more connectors and bigger default models/engines."
 *
 * THE POINT OF A PRESET IS THAT THE USER DOES NOT ASSEMBLE IT. Today's wizard
 * walks Setup (engine + the 4B) and then Capabilities (four toggles that
 * install nothing yet), and a person arriving at a local-AI app has no basis to
 * decide either. Three words with a size and a time beside each is a choice
 * anyone can make; everything a preset picks stays changeable later in Models,
 * Engines and Connectors, so the preset only decides what the first run
 * fetches, never what the app can do.
 *
 * PURE ON PURPOSE. This module takes an INVENTORY — the tier picks the
 * recommender already computed for this machine, the generation modules with
 * their sizes, the connectors with theirs, and the machine's memory — and
 * returns a PLAN: what to download, what is skipped and why, and the bytes it
 * will cost. No IPC, no React, no stores, so the rules are unit-tested and the
 * wizard step becomes a renderer of a plan rather than the place the rules
 * hide. The wiring (reading the inventory over IPC, running the plan through
 * the download tray and the module installs) is the next step; see the plan in
 * memory (pi-desktop-onboarding-presets).
 *
 * WHAT EACH PRESET MEANS, in the app's own inventory:
 *   minimal  base pi — the recommended engine for this host, the fast-tier
 *            checkpoint (qwen3.5-4b today), no modules, no connectors.
 *   default  + the balanced tier when it fits, the image and audio modules,
 *            and the connectors that cost no download (the Mac's own calendar,
 *            mail, messages, contacts, reminders are always there).
 *   max      + the intelligent tier when it fits, every wired engine for the
 *            host, every generation module (video/3D on ComfyUI, the 3D engine
 *            where it can build), and every connector, including the ones that
 *            download weights (OmniSVG).
 *
 * FIT IS THE SAME RULE THE APP REFUSES A MODEL WITH — model-fit.ts's 30%
 * reserve — so onboarding can never promise a model the app will then refuse
 * to start (the 27B on a 24GB Mac is the measured case). A model that does not
 * fit is SKIPPED with the reason, never silently dropped, and the plan is still
 * valid without it: a max preset on an 8GB machine is the 4B, the modules and
 * the connectors — which is the right answer for that machine.
 */
import { modelFitsInRam } from '../../electron/inference/model-fit';

export type SetupPreset = 'minimal' | 'default' | 'max';
export const SETUP_PRESETS: readonly SetupPreset[] = ['minimal', 'default', 'max'];

export type Tier = 'fast' | 'balanced' | 'intelligent';

export interface InventoryModel {
  readonly modelId: string;
  readonly displayName: string;
  /** Download size in bytes; 0 = unverified (treated as fitting, like the app does). */
  readonly bytes: number;
  readonly downloaded: boolean;
}

export interface InventoryModule {
  /** `image`, `audio`, `comfy`, `3d`, or a `weights:<catalogId>` module. */
  readonly id: string;
  readonly label: string;
  readonly approxGB: number;
  readonly ready: boolean;
}

export interface InventoryConnector {
  readonly id: string;
  readonly label: string;
  /** Bytes to download to make it work; 0 for one that is already on the Mac. */
  readonly bytes: number;
  readonly installed: boolean;
}

/** Everything a plan is made from. Each part is optional: a machine with no
 * recommendation yet, or a build with no modules, still gets a plan. */
export interface PresetInventory {
  readonly totalMemoryBytes: number;
  readonly tiers: Partial<Record<Tier, InventoryModel>>;
  readonly modules: readonly InventoryModule[];
  readonly connectors: readonly InventoryConnector[];
  /** The engines `defaultEngineSet(host)` names for this host (max fetches all). */
  readonly wiredEngines: readonly string[];
  /** `recommendedEngine(host).id` — what minimal and default install. */
  readonly recommendedEngine: string | null;
}

export interface PresetSkip {
  readonly id: string;
  readonly reason: string;
}

export interface PresetPlan {
  readonly preset: SetupPreset;
  /** Model ids to fetch, in tier order; the ones on disk are listed too (so the
   * plan describes the resulting setup), with `downloadBytes` counting only
   * what is missing. */
  readonly models: readonly InventoryModel[];
  readonly engines: readonly string[];
  readonly modules: readonly InventoryModule[];
  readonly connectors: readonly InventoryConnector[];
  readonly skipped: readonly PresetSkip[];
  /** Bytes the plan will actually fetch (models + modules + connectors not on disk). */
  readonly downloadBytes: number;
}

const GB = 1024 ** 3;

/** Which tiers a preset reaches for, in order. */
export const PRESET_TIERS: Readonly<Record<SetupPreset, readonly Tier[]>> = {
  minimal: ['fast'],
  default: ['fast', 'balanced'],
  max: ['fast', 'balanced', 'intelligent'],
};

/** Which generation modules a preset installs. `weights:*` modules ride with
 * `comfy` (a ComfyUI with no weights makes nothing) and only in max. */
export const PRESET_MODULES: Readonly<Record<SetupPreset, readonly string[]>> = {
  minimal: [],
  default: ['image', 'audio'],
  max: ['image', 'audio', 'comfy', '3d'],
};

/** Copy for the chooser — one line each, sizes filled in by the caller. */
export const PRESET_COPY: Readonly<Record<SetupPreset, { title: string; blurb: string }>> = {
  minimal: {
    title: 'Minimal',
    blurb: 'Just Bobble and a fast model. Everything else can be added later.',
  },
  default: {
    title: 'Default',
    blurb:
      'A stronger model when this Mac can hold one, pictures and voices, and your Mac’s own apps.',
  },
  max: {
    title: 'Max',
    blurb: 'The biggest model that fits, every engine, video and 3D, and every connector.',
  },
};

/**
 * The plan for a preset on this machine. Deterministic; never throws; a
 * missing part of the inventory just contributes nothing.
 */
export function planPreset(preset: SetupPreset, inv: PresetInventory): PresetPlan {
  const skipped: PresetSkip[] = [];
  const models: InventoryModel[] = [];
  for (const tier of PRESET_TIERS[preset]) {
    const pick = inv.tiers[tier];
    if (pick === undefined) {
      skipped.push({ id: tier, reason: `no ${tier} model is recommended for this machine` });
      continue;
    }
    // Two tiers can resolve to the same checkpoint on a small machine.
    if (models.some((m) => m.modelId === pick.modelId)) continue;
    const fit = modelFitsInRam(pick.bytes, inv.totalMemoryBytes);
    if (!fit.ok) {
      skipped.push({ id: pick.modelId, reason: fit.reason });
      continue;
    }
    models.push(pick);
  }

  const engines =
    preset === 'max'
      ? [
          ...new Set([
            ...(inv.recommendedEngine ? [inv.recommendedEngine] : []),
            ...inv.wiredEngines,
          ]),
        ]
      : inv.recommendedEngine
        ? [inv.recommendedEngine]
        : [];

  const wanted = new Set(PRESET_MODULES[preset]);
  const modules = inv.modules.filter(
    (m) =>
      wanted.has(m.id) || (preset === 'max' && m.id.startsWith('weights:') && wanted.has('comfy')),
  );
  for (const id of PRESET_MODULES[preset]) {
    if (!inv.modules.some((m) => m.id === id)) {
      skipped.push({ id, reason: `the ${id} module is not offered by this build` });
    }
  }

  const connectors =
    preset === 'minimal'
      ? []
      : preset === 'default'
        ? inv.connectors.filter((c) => c.bytes === 0)
        : [...inv.connectors];

  const downloadBytes =
    models.filter((m) => !m.downloaded).reduce((n, m) => n + m.bytes, 0) +
    modules.filter((m) => !m.ready).reduce((n, m) => n + m.approxGB * GB, 0) +
    connectors.filter((c) => !c.installed).reduce((n, c) => n + c.bytes, 0);

  return { preset, models, engines, modules, connectors, skipped, downloadBytes };
}

/** "about 4 GB", "about 18 GB", "nothing to download". */
export function formatDownload(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'nothing to download';
  const gb = bytes / GB;
  if (gb < 0.95) return `about ${Math.max(1, Math.round(gb * 10)) * 100} MB`;
  return `about ${Math.round(gb)} GB`;
}

/**
 * A rough wall-clock for the download at a line speed — the number beside the
 * size is what makes "Max" an informed choice rather than a dare. Line speed in
 * bytes/second; the default is a modest home line (50 Mb/s), so the estimate
 * errs long, the way the stage estimates do.
 */
export function formatDownloadTime(bytes: number, bytesPerSecond = 6.25e6): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const seconds = bytes / bytesPerSecond;
  if (seconds < 90) return 'about a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = seconds / 3600;
  return `about ${hours < 3 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)} h`;
}

/**
 * The preset to preselect for a machine: max needs room for more than the fast
 * tier to be worth its download, and a small machine is best served by exactly
 * what fits it.
 */
export function suggestedPreset(inv: PresetInventory): SetupPreset {
  const balanced = inv.tiers.balanced;
  const fast = inv.tiers.fast;
  const balancedFits =
    balanced !== undefined &&
    balanced.modelId !== fast?.modelId &&
    modelFitsInRam(balanced.bytes, inv.totalMemoryBytes).ok;
  return balancedFits ? 'default' : 'minimal';
}
