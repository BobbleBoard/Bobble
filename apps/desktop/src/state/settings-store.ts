/**
 * Renderer settings state: mirrors `~/.pi/desktop/settings.json` (loaded via
 * settings:get), drives the live theme (resolving `system` → light/dark from the
 * OS preference), and on every change persists via settings:set + pushes the
 * side effects the frozen extensions observe:
 *   - theme  → the theme store (data-flavor/data-mode on <html>)
 *   - permission/effort → the harness, via `/harness` slash commands (the only
 *     runtime config path the frozen harness exposes)
 *   - search keys / mcp mode → handled main-side by settings:set
 */
import { create } from 'zustand';
import {
  type AdvancedSettings,
  DEFAULT_ADVANCED,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type EffortLevel,
  type EffortMode,
  type EnginePreference,
  type ModelSelection,
  type ThemeModePref,
  type UserMode,
  type WorkMode,
} from '../../electron/settings/settings-contract';
import { DEFAULT_QUICK_MENU, type QuickMenuConfig } from '../chat/quick-menu';
import { type ThemeFlavor, useThemeStore } from '../store/theme';
import { applyHarnessConfig } from './pi-connect';

const ICON_STROKE_DEFAULT = 1.25;

const DEFAULTS: DesktopSettings = {
  version: 1,
  theme: { flavor: 'bobble', mode: 'system' },
  permissionMode: 'reviewer',
  effort: 'medium',
  userMode: 'user',
  enginePreference: 'llamacpp',
  modelSelection: { mode: 'auto' },
  effortMode: 'auto',
  search: { brave: '', tavily: '' },
  mcpMode: 'lite',
  toolInterface: 'schemas',
  workMode: 'chat',
  powerMode: 'auto',
  showComputerUseStatusPill: true,
  /*
   * ON BY DEFAULT — and they now MEAN something.
   *
   * Found in the round-2 settings stress run: these four were written by the
   * Capabilities panel AND by a whole onboarding step, persisted to disk, and
   * read by precisely nobody. Unticking "Video generation" during onboarding
   * left the Video room in the sidebar, still offering to download models,
   * still generating. Four checkboxes and a setup screen that did nothing.
   *
   * They gate the rooms now (see SessionSidebar). Default true rather than the
   * old false, because the old value was never read: keeping it would take the
   * four studios away from everyone who has not been through onboarding, which
   * is a very loud way to fix a silent bug.
   */
  capabilities: { image: true, video: true, audio: true, threeD: true },
  customInstructions: '',
  iconStroke: ICON_STROKE_DEFAULT,
  sidebarScale: 1.0,
  menuScale: 1.0,
  favoriteModels: [],
  modelEffortDefaults: {},
  hfToken: '',
  experimentalProductionHarness: false,
  experimentalGeneration: false,
  advanced: DEFAULT_ADVANCED,
  chatOrg: { projects: [], assignments: {}, pinned: [], titles: {} },
  hideDeleteChatConfirm: false,
  harnessId: 'pi-bundled',
  harnessConfigPath: '',
};

function prefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function resolveMode(mode: ThemeModePref): 'dark' | 'light' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** Push the settings theme into the live theme store (which only knows light/dark). */
function applyTheme(settings: DesktopSettings): void {
  const theme = useThemeStore.getState();
  theme.setFlavor(settings.theme.flavor);
  theme.setMode(resolveMode(settings.theme.mode));
}

/** Drive the global icon stroke: an inline `--pd-icon-stroke` on the document
 * root wins over the theme token, thinning/thickening every `.pd-icon` glyph. */
function applyIconStroke(value: number): void {
  document.documentElement.style.setProperty('--pd-icon-stroke', String(value));
}

/** Drive the element-size scales: inline `--pd-sidebar-scale` / `--pd-menu-scale`
 * on the document root inherit down and multiply the tokenized `calc()` metrics
 * (sidebar rows + rail; the shared `.pd-menu` option rows). Default 1.0 = no-op.
 * A blanket set is idempotent, so no per-field guard is needed at the call site. */
function applyUiScales(s: DesktopSettings): void {
  const root = document.documentElement.style;
  root.setProperty('--pd-sidebar-scale', String(s.sidebarScale));
  root.setProperty('--pd-menu-scale', String(s.menuScale));
}

interface SettingsStoreState {
  settings: DesktopSettings;
  loaded: boolean;
  load: () => Promise<void>;
  /** Merge a patch, persist, apply theme + harness side effects. */
  update: (patch: DesktopSettingsPatch) => Promise<void>;
  /** Top-bar quick toggle: apply a concrete flavor/mode to the live theme store
   * and persist it, so the flip is instant AND survives a reload. */
  setTheme: (patch: { flavor?: ThemeFlavor; mode?: 'dark' | 'light' }) => Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,

  // Fetch settings into the store WITHOUT applying the theme — connectSettings
  // decides whether to apply it at boot (it deliberately doesn't under E2E, so
  // the base theme probe keeps the index.html default until it toggles).
  load: async () => {
    const settings = await window.piDesktop.invoke('settings:get', undefined);
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    // Optimistic: apply theme immediately so the flip feels instant.
    const optimistic = {
      ...get().settings,
      ...patch,
      theme: { ...get().settings.theme, ...patch.theme },
      search: { ...get().settings.search, ...patch.search },
      capabilities: { ...get().settings.capabilities, ...patch.capabilities },
      advanced: {
        sampling: { ...get().settings.advanced.sampling, ...patch.advanced?.sampling },
        reasoning: { ...get().settings.advanced.reasoning, ...patch.advanced?.reasoning },
      },
    };
    set({ settings: optimistic });
    if (patch.theme !== undefined) applyTheme(optimistic);
    if (patch.iconStroke !== undefined) applyIconStroke(optimistic.iconStroke);
    applyUiScales(optimistic);

    const settings = await window.piDesktop.invoke('settings:set', { patch });
    set({ settings });
    applyTheme(settings);
    applyIconStroke(settings.iconStroke);
    applyUiScales(settings);

    /*
     * Harness picks up permission/effort only via its slash commands — fire the
     * ones that actually changed (best-effort; a no-pi session just no-ops).
     *
     * AWAITED. This was fire-and-forget, which is fine for a settings toggle the
     * user flips between turns but wrong for Adaptive, which resolves the effort
     * for the very message about to be sent: the harness decides the advertised
     * tool set from the effort it holds when the prompt arrives, so a racing push
     * means the turn that asked for a team is the one that can't have one.
     * `applyHarnessConfig` swallows its own errors, so awaiting cannot fail a
     * settings write.
     */
    const harness: Parameters<typeof applyHarnessConfig>[0] = {};
    if (patch.permissionMode !== undefined) harness.permissionMode = settings.permissionMode;
    if (patch.effort !== undefined) harness.effort = settings.effort;
    if (harness.permissionMode !== undefined || harness.effort !== undefined) {
      await applyHarnessConfig(harness);
    }
  },

  setTheme: async (patch) => {
    // A top-bar toggle is an explicit, concrete choice, so — unlike update() —
    // apply it to the live theme store verbatim (no `system` re-resolution, which
    // would fight the toggle) and persist the concrete value so it sticks across
    // a reload. Keep the in-memory settings in sync so the Appearance panel agrees.
    const theme = useThemeStore.getState();
    if (patch.flavor !== undefined) theme.setFlavor(patch.flavor);
    if (patch.mode !== undefined) theme.setMode(patch.mode);
    set({ settings: { ...get().settings, theme: { ...get().settings.theme, ...patch } } });
    const settings = await window.piDesktop.invoke('settings:set', { patch: { theme: patch } });
    set({ settings });
  },
}));

/**
 * userMode API (round-12 #4). The single source of truth for the app's
 * experience level, persisted to settings.json and read by the model-dropdown
 * / model-manager waves (W3/W4) to decide whether to surface friendly tiers
 * (`user`) or real model names (`power`).
 *
 *   - `selectUserMode` — a plain selector for `useSettingsStore(selectUserMode)`
 *     (reactive) or `selectUserMode(useSettingsStore.getState())` (imperative).
 *   - `useUserMode`     — the ready-made reactive hook.
 *   - `setUserMode`     — persist a new mode (via settings:set) + update state.
 */
export const selectUserMode = (state: SettingsStoreState): UserMode => state.settings.userMode;

/** Reactive hook: the current experience level. */
export function useUserMode(): UserMode {
  return useSettingsStore(selectUserMode);
}

/** Persist the experience level (no-op re-write is harmless). */
export async function setUserMode(userMode: UserMode): Promise<void> {
  await useSettingsStore.getState().update({ userMode });
}

/**
 * advanced-knobs API (power-user brain/gear panel). The panel read-modify-writes
 * whole sampling/reasoning groups; the store + main deep-merge one level so a
 * single-field write is safe. Follows the userMode selector/hook/setter shape.
 */
export const selectAdvanced = (state: SettingsStoreState): AdvancedSettings =>
  state.settings.advanced;

/** Reactive hook: the current advanced inference knobs. */
export function useAdvancedSettings(): AdvancedSettings {
  return useSettingsStore(selectAdvanced);
}

/** Persist a partial advanced patch (sampling and/or reasoning group). */
export async function setAdvanced(patch: DesktopSettingsPatch['advanced']): Promise<void> {
  await useSettingsStore.getState().update({ advanced: patch });
}

/**
 * enginePreference API (round-12 #4 — the Model Manager's "Prefer MLX
 * (experimental)" toggle). Follows the userMode pattern: a plain selector, a
 * ready-made reactive hook, and a persist setter. `mlx` opts into the (later-wave)
 * Apple-Silicon MLX backend; the toggle here persists the preference + drives the
 * engine badge/note, without changing any launch path yet.
 */
export const selectEnginePreference = (state: SettingsStoreState): EnginePreference =>
  state.settings.enginePreference;

/** Reactive hook: the preferred local inference engine. */
export function useEnginePreference(): EnginePreference {
  return useSettingsStore(selectEnginePreference);
}

/** Persist the engine preference (no-op re-write is harmless). */
export async function setEnginePreference(enginePreference: EnginePreference): Promise<void> {
  await useSettingsStore.getState().update({ enginePreference });
}

/**
 * Which pi drives the chat, and the custom config path when the choice is
 * `pi-custom`. Main resolves the actual binary at bridge construction
 * (pi/pi-main.ts harnessBinPath), so persisting IS applying — for the next
 * chat. An in-flight conversation keeps the pi it started with on purpose:
 * swapping the binary underneath a live session would strand its state.
 */
/*
 * TWO selectors, not one returning an object. A selector that builds a fresh
 * object every call never compares equal, so zustand re-renders forever — the
 * same thrash that has bitten this store before. Each of these returns a
 * primitive, which is stable by value.
 */
/**
 * The Hugging Face token. Gated and private repos answer 401 without one, and
 * the hub had nowhere to put it — the user: "no quick place to put a token."
 *
 * Returned as a primitive so the selector stays stable, and never logged: the
 * value is a credential, so it travels between this store and the IPC call and
 * nowhere else.
 */
export function useHfToken(): string {
  return useSettingsStore((s) => s.settings.hfToken);
}

export async function setHfToken(hfToken: string): Promise<void> {
  await useSettingsStore.getState().update({ hfToken });
}

export function useHarnessId(): string {
  return useSettingsStore((s) => s.settings.harnessId);
}

export function useHarnessConfigPath(): string {
  return useSettingsStore((s) => s.settings.harnessConfigPath);
}

export async function setHarnessChoice(id: string, configPath?: string): Promise<void> {
  await useSettingsStore
    .getState()
    .update(
      configPath === undefined
        ? { harnessId: id }
        : { harnessId: id, harnessConfigPath: configPath },
    );
}

/**
 * modelSelection + effortMode API (round-12). Shared by W2 (composer-bar effort
 * slider + tier display) and W3 (footer dropdown + Auto router) — both setters
 * live here so neither wave has to edit this store file.
 */
export const selectModelSelection = (state: SettingsStoreState): ModelSelection =>
  state.settings.modelSelection;
export const selectEffortMode = (state: SettingsStoreState): EffortMode =>
  state.settings.effortMode;

/** Reactive hook: the current model selection (auto / a tier / an explicit model). */
export function useModelSelection(): ModelSelection {
  return useSettingsStore(selectModelSelection);
}

/** Reactive hook: the current effort mode ('auto' or an explicit level). */
/**
 * The user's quick menu, or the defaults when they have never touched it.
 *
 * Settings written before this existed have no `modelQuickMenu` at all, and the
 * right reading of that is "they have not customised it" rather than "they have
 * an empty menu" — so the fallback is the shipped configuration, not `{}`.
 */
export function useQuickMenu(): QuickMenuConfig {
  return useSettingsStore((s) => s.settings.modelQuickMenu) ?? DEFAULT_QUICK_MENU;
}

export function useEffortMode(): EffortMode {
  return useSettingsStore(selectEffortMode);
}

const selectWorkMode = (s: SettingsStoreState): WorkMode => s.settings.workMode;
/** Chat box, or chat box plus the working ledge. See {@link WorkMode}. */
export function useWorkMode(): WorkMode {
  return useSettingsStore(selectWorkMode);
}

/** Persist the chat/work choice. */
export async function setWorkMode(workMode: WorkMode): Promise<void> {
  await useSettingsStore.getState().update({ workMode });
}

/** Persist the model selection. */
export async function setModelSelection(modelSelection: ModelSelection): Promise<void> {
  await useSettingsStore.getState().update({ modelSelection });
}

/** Persist the effort mode. */
export async function setEffortMode(effortMode: EffortMode): Promise<void> {
  await useSettingsStore.getState().update({ effortMode });
}

/**
 * Re-push the saved permission-mode / effort into a freshly (re)started pi
 * session. Only the values that DIFFER from the harness's own defaults
 * (`reviewer` / `medium`) are sent, so a default profile issues no commands —
 * which keeps a fresh session's thread clean (each command is a real pi turn).
 */
export function applySavedHarnessConfig(): void {
  const { permissionMode, effort } = useSettingsStore.getState().settings;
  const patch: Parameters<typeof applyHarnessConfig>[0] = {};
  if (permissionMode !== 'reviewer') patch.permissionMode = permissionMode;
  if (effort !== 'medium') patch.effort = effort;
  if (patch.permissionMode !== undefined || patch.effort !== undefined) {
    void applyHarnessConfig(patch);
  }
}

/**
 * Experimental production-harness flag (default FALSE). The single gate for ALL
 * corp wiring: when this returns false the app is byte-for-byte its current self
 * (normal solo pi chat). Follows the userMode API pattern — a plain selector, a
 * reactive hook, and a persist setter.
 */
export const selectExperimentalProductionHarness = (state: SettingsStoreState): boolean =>
  state.settings.experimentalProductionHarness;

/** Reactive hook: the persisted experimental production-harness setting. */
export function useExperimentalProductionHarness(): boolean {
  return useSettingsStore(selectExperimentalProductionHarness);
}

/** Persist the experimental production-harness flag. */
export async function setExperimentalProductionHarness(enabled: boolean): Promise<void> {
  await useSettingsStore.getState().update({ experimentalProductionHarness: enabled });
}

/**
 * The DEV env override (`PI_DESKTOP_CORP=1`), surfaced by main.ts as a `?corp=1`
 * query param on the main window. Resolved lazily + cached (a launch-time flag),
 * and guarded so importing this module in a non-DOM (test) context is safe.
 */
let corpEnvOverride: boolean | undefined;
function corpEnvOverrideEnabled(): boolean {
  if (corpEnvOverride === undefined) {
    corpEnvOverride =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('corp');
  }
  return corpEnvOverride;
}

/**
 * The EFFECTIVE production-harness state: the persisted setting OR the dev env
 * override. This is the value the chat trigger consults to decide whether a
 * submitted prompt drives the CorpEngine instead of the normal pi turn. Imperative
 * (reads the current store state) so a submit handler can call it inline.
 */
/**
 * TESTING ONLY — force the first message of a chat into a corporation.
 *
 * The corp is normally something the MODEL asks for (`create_production_hierarchy`
 * at high/max effort); a probe that wants to exercise a corp run end to end cannot
 * depend on a small local model choosing to promote. This flag exists for that,
 * and for nothing else: it is never set in a normal launch.
 */
export function corpForceEnabled(): boolean {
  return (
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('corpForce')
  );
}

/**
 * The coordination harness is no longer a user setting — it is reached through
 * the top effort levels, and its old toggle only mattered when `?corpForce` was
 * also set. Kept as a function because the dev/env override still uses it; it
 * simply no longer consults a switch nobody can see.
 */
export function productionHarnessEnabled(): boolean {
  return corpEnvOverrideEnabled();
}

/**
 * Experimental generation-stack flag (default FALSE) — the sibling of
 * {@link selectExperimentalProductionHarness} that gates ALL live generation
 * wiring (gen bridge / gen tools / gen-image surface). When false the app is
 * byte-for-byte its current self. Follows the same selector/hook/setter shape.
 */
export const selectExperimentalGeneration = (state: SettingsStoreState): boolean =>
  state.settings.experimentalGeneration;

/** Reactive hook: the persisted experimental generation setting. */
export function useExperimentalGeneration(): boolean {
  return useSettingsStore(selectExperimentalGeneration);
}

/** Persist the experimental generation flag. */
export async function setExperimentalGeneration(enabled: boolean): Promise<void> {
  await useSettingsStore.getState().update({ experimentalGeneration: enabled });
}

/**
 * The DEV env override (`PI_DESKTOP_GEN=1`), surfaced by main.ts as a `?gen=1`
 * query param on the main window. Resolved lazily + cached (a launch-time flag),
 * guarded so importing this module in a non-DOM (test) context is safe. Mirrors
 * {@link corpEnvOverrideEnabled}.
 */
let genEnvOverride: boolean | undefined;
function genEnvOverrideEnabled(): boolean {
  if (genEnvOverride === undefined) {
    genEnvOverride =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('gen');
  }
  return genEnvOverride;
}

/**
 * The EFFECTIVE generation-stack state: the persisted setting OR the dev env
 * override. It is what decides whether the gen-tools extension is loaded into
 * pi at all, so with it off the generate tools do not exist and nothing
 * downstream — the bridge, the JobQueue, the thread's card — is ever reached.
 */
export function generationEnabled(): boolean {
  return genEnvOverrideEnabled() || useSettingsStore.getState().settings.experimentalGeneration;
}

/** Star / unstar a model id, persisting the whole favorites list. */
export async function toggleFavoriteModel(modelId: string): Promise<void> {
  const current = useSettingsStore.getState().settings.favoriteModels;
  const favoriteModels = current.includes(modelId)
    ? current.filter((id) => id !== modelId)
    : [...current, modelId];
  await useSettingsStore.getState().update({ favoriteModels });
}

/**
 * Set (or clear, when `effort` is undefined) a model's default effort, persisting
 * the whole map. Applies immediately only when the model is already active — the
 * usual path is {@link applyModelEffortDefault} at set-active time.
 */
export async function setModelEffortDefault(
  modelId: string,
  effort: EffortLevel | undefined,
): Promise<void> {
  const current = { ...useSettingsStore.getState().settings.modelEffortDefaults };
  if (effort === undefined) delete current[modelId];
  else current[modelId] = effort;
  await useSettingsStore.getState().update({ modelEffortDefaults: current });
}

/**
 * When a model with a stored effort default becomes active, push that effort
 * into the settings (which drives the harness `/harness effort` command). A
 * no-op when the model has no default or already matches the current effort.
 */
export async function applyModelEffortDefault(modelId: string): Promise<void> {
  const { modelEffortDefaults, effort } = useSettingsStore.getState().settings;
  const target = modelEffortDefaults[modelId];
  if (target !== undefined && target !== effort) {
    await useSettingsStore.getState().update({ effort: target });
  }
}

let connected = false;

/** Load settings + keep the theme following the OS when mode is `system`. */
export function connectSettings(): void {
  if (connected) return;
  connected = true;

  // Under E2E the base theme probe asserts the exact index.html default
  // (claude/dark) and drives the flavor/mode toggles itself, so we must not
  // apply a persisted/seeded theme at boot. Live changes via update() still
  // apply — only this boot-time application is suppressed.
  const isE2E = new URLSearchParams(window.location.search).has('piE2E');

  void useSettingsStore
    .getState()
    .load()
    .then(() => {
      const { settings } = useSettingsStore.getState();
      if (!isE2E) applyTheme(settings);
      // Icon stroke is orthogonal to the theme probes (a unitless override that
      // matches the token at its default), so it is safe to apply at boot even
      // under E2E — this is what makes a persisted thickness survive a reload.
      applyIconStroke(settings.iconStroke);
      // Element-size scales are unitless multipliers on tokenized calc()s
      // (default 1.0 = no-op), orthogonal to the theme probes for the same
      // reason — apply at boot so persisted scales survive a reload.
      applyUiScales(settings);
    });

  if (typeof window.matchMedia === 'function') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', () => {
      const { settings } = useSettingsStore.getState();
      if (!isE2E && settings.theme.mode === 'system') applyTheme(settings);
    });
  }

  // E2E: expose a read handle behind the same opt-in as __pi_store (main appends
  // ?piE2E=1 under PI_E2E). Same-context code can reach the store anyway; gating
  // just keeps production from shipping a stable settings handle on window.
  if (isE2E) {
    window.__settings_store = () => useSettingsStore;
  }
}
