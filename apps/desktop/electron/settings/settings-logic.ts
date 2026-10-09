/**
 * Pure settings normalization/merge/seed logic — kept electron-free and
 * IO-free so it is unit-testable in plain Node (settings-main.ts does the fs).
 * Every field is guarded on read so a hand-edited or partially-written
 * settings.json can never brick the app; unknown values fall back to defaults.
 */
import { DEFAULT_CODE_THEME_IDS, isCodeThemeId } from '@pi-desktop/code-themes';
import type { OnboardingChoices } from '../import/import-contract';
import { clampFeatureSettings, DEFAULT_FEATURE_SETTINGS, mergeFeatureSettings } from './features';
import {
  type AdvancedSettings,
  type ChatOrganization,
  type ChatProject,
  type CodeThemeChoice,
  type ComputerUseApp,
  type ComputerUseSettings,
  DEFAULT_ADVANCED,
  type DesktopSettings,
  type DesktopSettingsPatch,
  EFFORT_MODES,
  type EffortLevel,
  ENGINE_PREFERENCES,
  type EngineFlagValue,
  type EngineLaunchSettings,
  type EnginePreference,
  ICON_SCALE_DEFAULT,
  ICON_SCALE_MAX,
  ICON_SCALE_MIN,
  ICON_STROKE_DEFAULT,
  ICON_STROKE_LEGACY_DEFAULT,
  ICON_STROKE_MAX,
  ICON_STROKE_MIN,
  ICON_STROKE_REV,
  MCP_MODES,
  type McpMode,
  MODEL_SELECTION_TIERS,
  type ModelSelection,
  type ModelSelectionTier,
  type ModelSpecChoice,
  type PermissionMode,
  POWER_MODES,
  type QuickMenuSettings,
  type QuickSlotSettings,
  type ThemeFlavor,
  type ThemeModePref,
  TOOL_INTERFACES,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  USER_MODES,
  WORK_MODES,
} from './settings-contract';

const FLAVORS: readonly ThemeFlavor[] = ['claude', 'codex', 'bobble'];
const MODES: readonly ThemeModePref[] = ['light', 'dark', 'system'];
const PERMISSION_MODES: readonly PermissionMode[] = ['bypass', 'reviewer', 'review-all'];
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];
const ENGINE_PREFS: readonly EnginePreference[] = ENGINE_PREFERENCES;

/** Normalize an untrusted model-selection union, falling back on anything invalid. */
/**
 * The user's quick menu, validated rather than trusted.
 *
 * Settings arrive from disk, so every field is untrusted input: a slot with no
 * id would produce a row that cannot be selected, a favourite that is not a
 * string would crash the menu that maps over it. Undefined is a real answer —
 * "never customised" — and stays undefined so the renderer can fall back to the
 * shipped defaults rather than to an empty menu.
 */
function clampQuickMenu(value: unknown): QuickMenuSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const favourites = Array.isArray(v.favourites)
    ? v.favourites.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const slots = Array.isArray(v.slots)
    ? v.slots.flatMap((raw): QuickSlotSettings[] => {
        if (typeof raw !== 'object' || raw === null) return [];
        const slot = raw as Record<string, unknown>;
        if (typeof slot.id !== 'string' || slot.id.length === 0) return [];
        if (typeof slot.label !== 'string' || slot.label.trim() === '') return [];
        const tier =
          typeof slot.tier === 'string' &&
          (MODEL_SELECTION_TIERS as readonly string[]).includes(slot.tier)
            ? (slot.tier as ModelSelectionTier)
            : undefined;
        return [
          {
            id: slot.id,
            label: slot.label,
            modelId:
              typeof slot.modelId === 'string' && slot.modelId.length > 0 ? slot.modelId : null,
            ...(tier === undefined ? {} : { tier }),
          },
        ];
      })
    : [];
  // A config with nothing usable in it is the same as never having one.
  if (favourites.length === 0 && slots.length === 0) return undefined;
  return { favourites, slots };
}

function clampModelSelection(value: unknown, fallback: ModelSelection): ModelSelection {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Record<string, unknown>;
  if (
    v.mode === 'tier' &&
    typeof v.tier === 'string' &&
    (MODEL_SELECTION_TIERS as readonly string[]).includes(v.tier)
  ) {
    return { mode: 'tier', tier: v.tier as ModelSelectionTier };
  }
  if (v.mode === 'model' && typeof v.modelId === 'string' && v.modelId.length > 0) {
    return { mode: 'model', modelId: v.modelId };
  }
  if (v.mode === 'auto') return { mode: 'auto' };
  return fallback;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  version: 1,
  theme: { flavor: 'bobble', mode: 'system' },
  codeTheme: { light: DEFAULT_CODE_THEME_IDS.light, dark: DEFAULT_CODE_THEME_IDS.dark },
  codeFont: '',
  permissionMode: 'reviewer',
  effort: 'medium',
  userMode: 'user',
  enginePreference: 'llamacpp',
  modelSelection: { mode: 'auto' },
  effortMode: 'auto',
  search: { brave: '', tavily: '' },
  mcpMode: 'lite',
  toolInterface: 'bash-cli',
  specialistToolInterface: 'bash-cli',
  workMode: 'work', // retired 2026-09-21: the ledge is always open; parsed, unread
  /* 'low' by default — the user, after the freeze that took the trackpad with it:
     "switch default to low power mode". The machine stays usable out of the
     box; a person who wants a run pushed picks 'full' for it. */
  powerMode: 'low',
  showComputerUseStatusPill: true,
  // Training is the one capability off by default: nothing shows it until its
  // view ships (TR-5), and then it is something a person turns on.
  capabilities: { image: true, video: true, audio: true, threeD: true, training: false },
  customInstructions: '',
  iconStroke: ICON_STROKE_DEFAULT,
  iconStrokeRev: ICON_STROKE_REV,
  iconScale: ICON_SCALE_DEFAULT,
  sidebarScale: UI_SCALE_DEFAULT,
  menuScale: UI_SCALE_DEFAULT,
  favoriteModels: [],
  modelEffortDefaults: {},
  hfToken: '',
  experimentalProductionHarness: false,
  // Retired 2026-09-20 (generation is always on); parsed for old files, ignored.
  experimentalGeneration: true,
  loadVision: true,
  advanced: DEFAULT_ADVANCED,
  engineLaunch: {},
  portableKnobs: {},
  modelSpec: {},
  modelsRoot: null,
  chatOrg: { projects: [], assignments: {}, pinned: [], titles: {} },
  hideDeleteChatConfirm: false,
  hideDeleteModelConfirm: false,
  // On, with no pre-approved apps: exactly what the app did before the chooser
  // existed — each app asks once per session — so an installed setup does not
  // change under anyone's feet. Onboarding is where a fresh one decides.
  computerUse: { enabled: true, apps: [] },
  memoryGuard: true,
  moduleConnectors: {},
  harnessId: 'pi-bundled',
  harnessConfigPath: '',
  // memory, training, devices, design, workflows, editor — all off (./features).
  ...DEFAULT_FEATURE_SETTINGS,
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Unique list of non-empty strings (favorite model ids); junk → []. */
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v === 'string' && v.length > 0) seen.add(v);
  }
  return [...seen];
}

/** A record<string,string> keeping only string→string entries. */
function strMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/** Normalize the untrusted chat-organization blob (projects/assignments/pins/renames). */
function clampChatOrg(value: unknown): ChatOrganization {
  const o = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const projects: ChatProject[] = Array.isArray(o.projects)
    ? o.projects
        .filter(
          (p): p is { id: unknown; name: unknown; cwd?: unknown } =>
            typeof p === 'object' && p !== null,
        )
        .map((p) => {
          const cwd = str(p.cwd, '');
          return cwd.length > 0
            ? { id: str(p.id, ''), name: str(p.name, ''), cwd }
            : { id: str(p.id, ''), name: str(p.name, '') };
        })
        .filter((p) => p.id.length > 0 && p.name.length > 0)
    : [];
  return {
    projects,
    assignments: strMap(o.assignments),
    pinned: strArray(o.pinned),
    titles: strMap(o.titles),
  };
}

/** A flag key is `-x` or `--long-name`; nothing else can be a launch argument. */
const FLAG_KEY_RE = /^--?[A-Za-z][\w.-]*$/;

/** Normalize the per-engine launch flags: known shapes only, everything else dropped. */
function clampEngineLaunch(raw: unknown): EngineLaunchSettings {
  const out: EngineLaunchSettings = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [engine, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][\w-]*$/.test(engine) || typeof cfg !== 'object' || cfg === null) continue;
    const c = cfg as { flags?: unknown; rawArgs?: unknown };
    const flags: Record<string, EngineFlagValue> = {};
    if (typeof c.flags === 'object' && c.flags !== null) {
      for (const [k, v] of Object.entries(c.flags as Record<string, unknown>)) {
        if (!FLAG_KEY_RE.test(k)) continue;
        if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') flags[k] = v;
      }
    }
    const rawArgs = Array.isArray(c.rawArgs)
      ? c.rawArgs.filter((a): a is string => typeof a === 'string' && a.length > 0).slice(0, 200)
      : [];
    if (Object.keys(flags).length > 0 || rawArgs.length > 0) out[engine] = { flags, rawArgs };
  }
  return out;
}

/** Knob ids are plain words; values are the flag-value primitives. */
function clampPortableKnobs(raw: unknown): Record<string, EngineFlagValue> {
  const out: Record<string, EngineFlagValue> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z][\w]*$/.test(k)) continue;
    if (v === '') continue;
    if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') out[k] = v;
  }
  return out;
}

const SPEC_METHODS: readonly ModelSpecChoice['method'][] = [
  'auto',
  'none',
  'mtp',
  'eagle3',
  'dflash',
  'dspark',
  'ngram',
  'custom',
];

/** Normalize the per-model speculative choice; an `auto` entry is the same as none. */
function clampModelSpec(raw: unknown): Record<string, ModelSpecChoice> {
  const out: Record<string, ModelSpecChoice> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [modelId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const c = v as { method?: unknown; draftPath?: unknown; specType?: unknown };
    const method = oneOf(c.method, SPEC_METHODS, 'auto');
    if (method === 'auto') continue;
    out[modelId] = {
      method,
      ...(typeof c.draftPath === 'string' && c.draftPath.length > 0
        ? { draftPath: c.draftPath }
        : {}),
      ...(typeof c.specType === 'string' && /^[a-z0-9-]+$/.test(c.specType)
        ? { specType: c.specType }
        : {}),
    };
  }
  return out;
}

/** Normalize the untrusted advanced knobs (sampling + reasoning) with bounds. */
function clampAdvanced(value: unknown): AdvancedSettings {
  const o = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const s = (typeof o.sampling === 'object' && o.sampling !== null ? o.sampling : {}) as Record<
    string,
    unknown
  >;
  const r = (typeof o.reasoning === 'object' && o.reasoning !== null ? o.reasoning : {}) as Record<
    string,
    unknown
  >;
  const ds = DEFAULT_ADVANCED.sampling;
  const dr = DEFAULT_ADVANCED.reasoning;
  return {
    sampling: {
      temperature: num(s.temperature, ds.temperature, 0, 2),
      topP: num(s.topP, ds.topP, 0, 1),
      topK: num(s.topK, ds.topK, 0, 500),
      minP: num(s.minP, ds.minP, 0, 1),
      repetitionPenalty: num(s.repetitionPenalty, ds.repetitionPenalty, 0, 2),
      presencePenalty: num(s.presencePenalty, ds.presencePenalty, -2, 2),
      maxTokens: Math.round(num(s.maxTokens, ds.maxTokens, 0, 1_000_000)),
    },
    reasoning: {
      preserve: bool(r.preserve, dr.preserve),
      budget: Math.round(num(r.budget, dr.budget, -1, 1_000_000)),
      // The old default line is a saved copy of a default, not a choice.
      budgetMessage:
        str(r.budgetMessage, dr.budgetMessage) === LEGACY_REASONING_BUDGET_MESSAGE
          ? dr.budgetMessage
          : str(r.budgetMessage, dr.budgetMessage),
    },
  };
}

/** Record<modelId, EffortLevel>, dropping entries with an invalid effort. */
function effortMap(value: unknown): Record<string, EffortLevel> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, EffortLevel> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)) {
      out[key] = v as EffortLevel;
    }
  }
  return out;
}

/** The end message's wording before 2026-10-09; settings files saved with it
 * carry it as a copy of the default. */
export const LEGACY_REASONING_BUDGET_MESSAGE =
  "I've been thinking too long, let me try to act on something now, before I decide if I should keep thinking.";

/** Normalize an untrusted parsed object into a fully-valid DesktopSettings. */
export function clampSettings(raw: unknown): DesktopSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const theme = (typeof o.theme === 'object' && o.theme !== null ? o.theme : {}) as Record<
    string,
    unknown
  >;
  const search = (typeof o.search === 'object' && o.search !== null ? o.search : {}) as Record<
    string,
    unknown
  >;
  const caps = (
    typeof o.capabilities === 'object' && o.capabilities !== null ? o.capabilities : {}
  ) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    version: 1,
    theme: {
      flavor: oneOf(theme.flavor, FLAVORS, d.theme.flavor),
      mode: oneOf(theme.mode, MODES, d.theme.mode),
    },
    codeTheme: clampCodeTheme(o.codeTheme, d.codeTheme),
    codeFont: codeFontName(o.codeFont),
    permissionMode: oneOf(o.permissionMode, PERMISSION_MODES, d.permissionMode),
    effort: oneOf(o.effort, EFFORT_LEVELS, d.effort),
    userMode: oneOf(o.userMode, USER_MODES, d.userMode),
    enginePreference: oneOf(o.enginePreference, ENGINE_PREFS, d.enginePreference),
    modelSelection: clampModelSelection(o.modelSelection, d.modelSelection),
    modelQuickMenu: clampQuickMenu(o.modelQuickMenu),
    effortMode: oneOf(o.effortMode, EFFORT_MODES, d.effortMode),
    search: { brave: str(search.brave, ''), tavily: str(search.tavily, '') },
    mcpMode: oneOf(o.mcpMode, MCP_MODES, d.mcpMode),
    toolInterface: oneOf(o.toolInterface, TOOL_INTERFACES, d.toolInterface),
    specialistToolInterface: oneOf(
      o.specialistToolInterface,
      TOOL_INTERFACES,
      d.specialistToolInterface,
    ),
    workMode: oneOf(o.workMode, WORK_MODES, d.workMode),
    powerMode: oneOf(o.powerMode, POWER_MODES, d.powerMode),
    showComputerUseStatusPill: bool(o.showComputerUseStatusPill, d.showComputerUseStatusPill),
    // 0 and negatives mean "derive one from the machine", which is what absent
    // means too — so they normalise to the same thing rather than to a promise
    // the app cannot keep.
    ...(typeof o.powerReserveGB === 'number' && o.powerReserveGB > 0
      ? { powerReserveGB: Math.min(64, Math.round(o.powerReserveGB)) }
      : {}),
    capabilities: {
      image: bool(caps.image, d.capabilities.image),
      video: bool(caps.video, d.capabilities.video),
      audio: bool(caps.audio, d.capabilities.audio),
      threeD: bool(caps.threeD, d.capabilities.threeD),
      training: bool(caps.training, d.capabilities.training),
    },
    customInstructions: str(o.customInstructions, d.customInstructions),
    // A file saved before the 1px default carries the old default as if chosen:
    // move it once, then mark the file so a later 1.25 is the person's own.
    iconStroke:
      o.iconStrokeRev !== ICON_STROKE_REV && o.iconStroke === ICON_STROKE_LEGACY_DEFAULT
        ? d.iconStroke
        : num(o.iconStroke, d.iconStroke, ICON_STROKE_MIN, ICON_STROKE_MAX),
    iconStrokeRev: ICON_STROKE_REV,
    iconScale: num(o.iconScale, d.iconScale, ICON_SCALE_MIN, ICON_SCALE_MAX),
    sidebarScale: num(o.sidebarScale, d.sidebarScale, UI_SCALE_MIN, UI_SCALE_MAX),
    menuScale: num(o.menuScale, d.menuScale, UI_SCALE_MIN, UI_SCALE_MAX),
    favoriteModels: strArray(o.favoriteModels),
    modelEffortDefaults: effortMap(o.modelEffortDefaults),
    hfToken: str(o.hfToken, d.hfToken),
    harnessId: str(o.harnessId, d.harnessId),
    harnessConfigPath: str(o.harnessConfigPath, d.harnessConfigPath),
    experimentalProductionHarness: bool(
      o.experimentalProductionHarness,
      d.experimentalProductionHarness,
    ),
    experimentalGeneration: bool(o.experimentalGeneration, d.experimentalGeneration),
    loadVision: bool(o.loadVision, d.loadVision),
    advanced: clampAdvanced(o.advanced),
    engineLaunch: clampEngineLaunch(o.engineLaunch),
    portableKnobs: clampPortableKnobs(o.portableKnobs),
    modelSpec: clampModelSpec(o.modelSpec),
    // An absolute path or nothing; a relative one would resolve to wherever
    // the process happened to start and scatter the library.
    modelsRoot:
      typeof o.modelsRoot === 'string' && o.modelsRoot.startsWith('/') && o.modelsRoot.length > 1
        ? o.modelsRoot.replace(/\/+$/, '')
        : null,
    chatOrg: clampChatOrg(o.chatOrg),
    hideDeleteChatConfirm: bool(o.hideDeleteChatConfirm, d.hideDeleteChatConfirm),
    hideDeleteModelConfirm: bool(o.hideDeleteModelConfirm, d.hideDeleteModelConfirm),
    computerUse: clampComputerUse(o.computerUse, d.computerUse),
    memoryGuard: bool(o.memoryGuard, d.memoryGuard),
    moduleConnectors: clampModuleConnectors(o.moduleConnectors),
    // Each feature group clamps itself (./features); an old file without one
    // reads as that group's defaults.
    ...clampFeatureSettings(o),
  };
}

/** `{ '3d': true }` — only string keys with boolean values; anything else is dropped. */
function clampModuleConnectors(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean' && k !== '') out[k] = v;
  }
  return out;
}

/**
 * A code theme per mode, each validated against the registry FOR THAT MODE:
 * a dark theme in the light slot was never checked on a light ground, and a
 * theme removed in an update should not leave the slot naming nothing.
 */
function clampCodeTheme(value: unknown, fallback: CodeThemeChoice): CodeThemeChoice {
  const o = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    light: isCodeThemeId(o.light, 'light') ? o.light : fallback.light,
    dark: isCodeThemeId(o.dark, 'dark') ? o.dark : fallback.dark,
  };
}

/**
 * A font family NAME, and nothing else: it lands in a CSS `font-family`
 * value, so quotes, semicolons and braces are stripped rather than trusted,
 * and a novel of a value is cut to something a font name could be.
 */
export function codeFontName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/["'`;{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** `{ enabled, apps[] }` with each app an `{ id, name }` pair; junk drops out. */
function clampComputerUse(value: unknown, fallback: ComputerUseSettings): ComputerUseSettings {
  if (typeof value !== 'object' || value === null) return fallback;
  const o = value as Record<string, unknown>;
  const apps: ComputerUseApp[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o.apps)) {
    for (const entry of o.apps) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string' || e.id.trim() === '') continue;
      const id = e.id.trim();
      if (seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      apps.push({ id, name: typeof e.name === 'string' ? e.name : id });
    }
  }
  return { enabled: bool(o.enabled, fallback.enabled), apps };
}

/** Merge a one-level-deep patch over a valid document, re-clamping the result. */
export function mergeSettingsPatch(
  current: DesktopSettings,
  patch: DesktopSettingsPatch,
): DesktopSettings {
  return clampSettings({
    ...current,
    ...patch,
    theme: { ...current.theme, ...patch.theme },
    codeTheme: { ...current.codeTheme, ...patch.codeTheme },
    search: { ...current.search, ...patch.search },
    capabilities: { ...current.capabilities, ...patch.capabilities },
    // Deep-merge the two advanced groups so a patch touching one sampling field
    // doesn't wipe the rest (the panel read-modify-writes the whole group, but a
    // narrower patch stays safe).
    advanced: {
      sampling: { ...current.advanced.sampling, ...patch.advanced?.sampling },
      reasoning: { ...current.advanced.reasoning, ...patch.advanced?.reasoning },
    },
    // Per-id maps: a patch names the ids it changes and leaves the rest.
    engineLaunch: { ...current.engineLaunch, ...patch.engineLaunch },
    // A knob patched to '' is cleared, so the panel's "use the engine's own
    // default" is a real choice and not an unpatchable key.
    portableKnobs: Object.fromEntries(
      Object.entries({ ...current.portableKnobs, ...patch.portableKnobs }).filter(
        ([, v]) => v !== '',
      ),
    ),
    modelSpec: { ...current.modelSpec, ...patch.modelSpec },
    moduleConnectors: { ...current.moduleConnectors, ...patch.moduleConnectors },
    // The feature groups: one level deep, like the objects above.
    ...mergeFeatureSettings(current, patch),
    ...(patch.modelsRoot === undefined ? {} : { modelsRoot: patch.modelsRoot }),
  });
}

/**
 * The value at a dotted path of a settings document (`memory.enabled`,
 * `capabilities.training`); `''` is the whole document. Undefined when the
 * path runs off the document.
 */
export function settingValueAt(doc: DesktopSettings, path: string): unknown {
  if (path === '') return doc;
  let at: unknown = doc;
  for (const part of path.split('.')) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/**
 * Did a write change anything at or under `prefix`? Compared by value (a
 * re-sent identical object is not a change), which is what `subscribeSettings`
 * listeners are promised.
 */
export function settingsChangedAt(
  prefix: string,
  before: DesktopSettings,
  next: DesktopSettings,
): boolean {
  return (
    JSON.stringify(settingValueAt(before, prefix)) !== JSON.stringify(settingValueAt(next, prefix))
  );
}

/**
 * Build the initial document when no settings.json exists yet, carrying the
 * onboarding choices forward so the two stay coherent (theme, starting
 * permission mode, generation capabilities). `mcpMode` comes from the existing
 * mcp-lite registry when present so an imported connector setup is respected.
 */
export function seedFromOnboarding(
  choices: OnboardingChoices | null,
  mcpMode: McpMode | null,
): DesktopSettings {
  if (choices === null) {
    return mcpMode === null ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, mcpMode };
  }
  return clampSettings({
    ...DEFAULT_SETTINGS,
    theme: { flavor: choices.theme.flavor, mode: choices.theme.mode },
    permissionMode: choices.permissionMode,
    capabilities: choices.capabilities,
    ...(choices.computerUse === undefined ? {} : { computerUse: choices.computerUse }),
    ...(mcpMode === null ? {} : { mcpMode }),
  });
}

/**
 * What the pi child's per-request sidecar carries: the sampling overrides, plus
 * the user's OWN thinking cap and end message when they set one.
 *
 * The chat sends an automatic cap on every reasoning request (sized to what is
 * left of the window — see @pi-desktop/inference/reasoning-budget). A cap the
 * user typed wins over it: `--reasoning-budget` in the llama.cpp engine flags,
 * or the advanced setting when it is 0 or more. `-1` typed as a flag means "no
 * cap" and is carried as such; the advanced setting's -1 is its default and
 * means "automatic", so it is left out. The message is carried only when it is
 * not Bobble's own.
 */
export function samplingSidecar(settings: DesktopSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings.advanced.sampling };
  const flags = settings.engineLaunch.llamacpp?.flags ?? {};
  const flagBudget = Number(flags['--reasoning-budget']);
  if (flags['--reasoning-budget'] !== undefined && Number.isFinite(flagBudget)) {
    out.reasoningBudget = Math.trunc(flagBudget);
  } else if (settings.advanced.reasoning.budget >= 0) {
    out.reasoningBudget = Math.trunc(settings.advanced.reasoning.budget);
  }
  const flagMessage = flags['--reasoning-budget-message'];
  const message =
    typeof flagMessage === 'string' && flagMessage.trim().length > 0
      ? flagMessage
      : settings.advanced.reasoning.budgetMessage;
  if (
    message.trim().length > 0 &&
    message.trim() !== DEFAULT_ADVANCED.reasoning.budgetMessage.trim()
  ) {
    out.reasoningBudgetMessage = message;
  }
  return out;
}
