/**
 * Desktop settings IPC contract. Composed into the app-wide maps in
 * ../ipc-contract.ts. The renderer Settings view reads/writes `settings:get` /
 * `settings:set`; the main-process handler (./settings-main.ts) owns the single
 * on-disk source of truth (`~/.pi/desktop/settings.json`) and the side effects
 * that make the frozen extensions observe a change (search-key env, mcp-lite
 * registry `mode`). Trusted-sender gated exactly like every other app channel:
 * settings carry API keys + drive an exec-capable agent, so only the main frame
 * of an app-created window may reach them.
 */

export type ThemeFlavor = 'claude' | 'codex' | 'bobble';
/** Settings-level mode adds `system` (resolved to light/dark via the OS pref at
 * apply time; the theme store itself only knows light/dark). */
export type ThemeModePref = 'light' | 'dark' | 'system';
export type PermissionMode = 'bypass' | 'reviewer' | 'review-all';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
/**
 * Experience level for the model-selection UI (round-12 #4). `user` = simple,
 * automatic model selection (the friendly tier names + Auto); `power` = full
 * control (real model names front-and-center). Read by the model-dropdown /
 * model-manager waves via the settings-store `selectUserMode` selector.
 */
export type UserMode = 'user' | 'power';
/** Valid user modes, in UI (segmented) order. */
export const USER_MODES = ['user', 'power'] as const satisfies readonly UserMode[];
/** Connector surfacing mode; mirrors @pi-desktop/mcp-lite's McpMode. `bash-cli`
 * exposes connectors through the real bash tool via a generated `pi-tool`. */
/**
 * HOW TOOLS ARE OFFERED TO THE MODEL.
 *
 * `schemas` is the way it has always worked: each tool is a JSON tool
 * definition in the request, and the harness decides which ones to include this
 * turn. `bash-cli` is the user's experiment — every tool becomes a command on PATH,
 * the advertised surface shrinks to `bash`, and the whole registry is
 * discoverable with `tools`, `tools search` and `--help` at no per-turn cost.
 *
 * Default stays `schemas`. The experiment is measured in
 * `tests/e2e/tool-cli-eval.mjs`, and the short version is that the CLI only
 * matches schemas once the command list is in the system prompt — a model given
 * a bare terminal answers "I only have access to shell commands" and never goes
 * looking.
 */
export type ToolInterface = 'schemas' | 'bash-cli';

/**
 * CHAT or WORK — which half of the app is on screen.
 *
 * `chat` is a chat box and nothing else. `work` adds the ledge under the
 * composer: the project folder, the instruction files in effect, how full the
 * context is, and the effort dial.
 *
 * THE SECOND SEGMENT IS LABELLED "Project", not "Work" — the stored value keeps
 * its name so nobody's settings.json changes under them, but the word on screen
 * does not. The tester, who writes marketing copy for a living: "Chat and Work
 * aren't opposites. When I ask this thing to draft a launch email, that IS my
 * work. Sitting in 'Chat' while doing my job quietly tells me I'm messing
 * about — and it tells the nervous first-time user that the serious mode is the
 * other one." The actual difference between the two is that one has a folder on
 * your Mac attached to the conversation, which is what "Project" says.
 *
 * WHY IT EXISTS. A blind tester's rule, which is the best one anybody has given
 * this project: "if a word on the opening screen needs a sentence of explanation
 * to me, it isn't on the opening screen." "No project" and "Effort · Adaptive"
 * both need one. the user's answer was better than hiding them behind a gear — put
 * them behind a MODE, one click away, with a control that says which of the two
 * things this app is you are currently doing.
 *
 * Default `chat`, because that is what someone opening it for the first time is
 * here for, and because a control you can see is not the same as a control you
 * are made to read.
 */
export type WorkMode = 'chat' | 'work';
export const WORK_MODES = ['chat', 'work'] as const satisfies readonly WorkMode[];

export type McpMode = 'lite' | 'native' | 'bash-cli';
/** Valid MCP modes, in UI order. */
export const MCP_MODES = ['lite', 'native', 'bash-cli'] as const satisfies readonly McpMode[];

export const TOOL_INTERFACES = ['schemas', 'bash-cli'] as const satisfies readonly ToolInterface[];

/**
 * How hard the app may push this machine.
 *
 * the user: "ensuring we leave a certain amount of memory available as a buffer so
 * the user can use computer as normal while generation and such occurs … this
 * could be dynamic even tracking what the current user memory/cpu/gpu usage is."
 *
 *   'auto' — the dynamic one, and the default: watch the machine and ease off
 *            when it is actually struggling, come back when it is not.
 *   'full' — never ease off. For a run you are watching and want finished.
 *   'low'  — always ease off, even on an idle machine.
 *
 * What "ease off" MEANS depends on which wall the machine is nearest — see
 * packages/inference/src/power-policy.ts, which is where that decision lives.
 */
export type PowerMode = 'auto' | 'full' | 'low';
export const POWER_MODES = ['auto', 'full', 'low'] as const satisfies readonly PowerMode[];

/**
 * Preferred local inference engine (round-12 #4 — the Model Manager's "Prefer MLX
 * (experimental)" toggle). `llamacpp` = the default GGUF backend; `mlx` opts into
 * the Apple-Silicon MLX backend (its foundation lands in a later wave — this is
 * the persisted USER PREFERENCE + the engine badge/note only). Mirrors the
 * catalog `Engine` type, inlined so this contract stays dependency-free. */
export type EnginePreference = 'llamacpp' | 'mlx';
/** Valid engine preferences. */
export const ENGINE_PREFERENCES = [
  'llamacpp',
  'mlx',
] as const satisfies readonly EnginePreference[];

/** The model-capability tier a pinned selection targets. Structural mirror of
 * `ModelTier` in @pi-desktop/harness (inlined so this contract stays dependency-free). */
export type ModelSelectionTier = 'fast' | 'balanced' | 'intelligent';
export const MODEL_SELECTION_TIERS = [
  'fast',
  'balanced',
  'intelligent',
] as const satisfies readonly ModelSelectionTier[];

/**
 * How the app chooses the local model (round-12 model-selection UX). Persisted as
 * the user's DEFAULT and re-applied on each fresh pi session:
 *   - `auto`  → the Auto router picks a tier per-turn (from the harness activeTier);
 *   - `tier`  → pinned to a capability tier (router disabled);
 *   - `model` → pinned to a specific catalog/HF model id (router disabled).
 */
/** One configurable row of the quick menu. Mirrors QuickSlot in quick-menu.ts;
 * inlined so this contract stays dependency-free. */
export interface QuickSlotSettings {
  id: string;
  label: string;
  /** The model this slot runs, or null to let the app keep choosing. */
  modelId: string | null;
  tier?: ModelSelectionTier;
}

export interface QuickMenuSettings {
  /** Model ids in the order the user arranged them. */
  favourites: string[];
  slots: QuickSlotSettings[];
}

export type ModelSelection =
  | { mode: 'auto' }
  | { mode: 'tier'; tier: ModelSelectionTier }
  | { mode: 'model'; modelId: string };

/** Effort resolution: `auto` derives the level from the active tier (fast→low,
 * balanced→medium, intelligent→high); `level` pins the explicit {@link EffortLevel}. */
export type EffortMode = 'auto' | 'level';
export const EFFORT_MODES = ['auto', 'level'] as const satisfies readonly EffortMode[];

export interface GenerationCapabilities {
  image: boolean;
  video: boolean;
  audio: boolean;
  threeD: boolean;
}

/**
 * Power-user advanced inference knobs (the "brain/gear" panel). Split by WHERE
 * each applies:
 *   - `sampling`  → per-REQUEST body params (temperature/top_p/…). Take effect on
 *     the NEXT turn, no server relaunch. Defaults mirror the llama-server CLI
 *     defaults in `assembleServerArgs`, so an untouched install is identical.
 *   - `reasoning` → LAUNCH args (`--reasoning-*`). Changing them needs a server
 *     relaunch to take effect.
 * Everything defaults to the current behaviour, so this whole block is inert
 * until a power user touches a control.
 */
export interface AdvancedSamplingSettings {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  /** llama.cpp `repeat_penalty`; 1.0 = disabled (DRY does the anti-loop work). */
  repetitionPenalty: number;
  presencePenalty: number;
  /** Per-request output cap; 0 = unset (omit `max_tokens`, use the server/model default). */
  maxTokens: number;
}
export interface AdvancedReasoningSettings {
  /** `--reasoning-preserve`: keep <think> across the whole history. */
  preserve: boolean;
  /** `--reasoning-budget`: -1 unrestricted, 0 = end immediately, N>0 = token cap. */
  budget: number;
  /** `--reasoning-budget-message`: injected before the end-of-thinking tag. */
  budgetMessage: string;
}
export interface AdvancedSettings {
  sampling: AdvancedSamplingSettings;
  reasoning: AdvancedReasoningSettings;
}

/** The single source of truth for advanced defaults (mirrors the server CLI). */
export const DEFAULT_ADVANCED: AdvancedSettings = {
  sampling: {
    temperature: 0.8,
    topP: 0.9,
    topK: 50,
    minP: 0,
    repetitionPenalty: 1.0,
    presencePenalty: 0,
    maxTokens: 0,
  },
  reasoning: {
    preserve: true,
    budget: -1,
    budgetMessage: 'time limit for reasoning reached',
  },
};

/** Web-search backend keys. Sensitive — persisted to settings.json (mode 0600)
 * and mirrored into the main process env so a (re)spawned pi's web-tools
 * extension reads them (`PI_BRAVE_API_KEY` / `PI_TAVILY_API_KEY`). Empty string
 * means "unset". */
export interface SearchKeys {
  brave: string;
  tavily: string;
}

/** A user-created chat project (Codex-style group of chats). */
export interface ChatProject {
  id: string;
  name: string;
  /** Optional working folder for the project: new chats created in it are rooted
   * here (pi cwd → bash/file tools/canvas tree). When absent the project's chats
   * share a per-project sandbox dir named after the project (see project-main
   * `project:project-sandbox`), so the user only ever sees the project name. */
  cwd?: string;
}

/** Chat organization state: named projects + per-chat assignment/pin/rename.
 * Keyed by session FILE path so it survives without touching the session JSONL
 * (the fs read path stays read-only). */
export interface ChatOrganization {
  /** User-created projects, in display order. */
  projects: ChatProject[];
  /** sessionFile → projectId (manual assignment; absent = ungrouped). */
  assignments: Record<string, string>;
  /** Pinned session files (pinned chats float to the top of their group). */
  pinned: string[];
  /** sessionFile → user rename (overrides the first-message-derived title). */
  titles: Record<string, string>;
}

/** The whole live desktop-settings document. Seeded from onboarding.json on the
 * first read, authoritative thereafter. */
export interface DesktopSettings {
  version: 1;
  theme: { flavor: ThemeFlavor; mode: ThemeModePref };
  permissionMode: PermissionMode;
  effort: EffortLevel;
  /** Experience level driving the model-selection UI (default `user`). */
  userMode: UserMode;
  /** Preferred local inference engine (default `llamacpp`). Set to `mlx` by the
   * Model Manager's "Prefer MLX (experimental)" toggle. */
  enginePreference: EnginePreference;
  /** The model-selection mode (default `{ mode: 'auto' }`). */
  modelSelection: ModelSelection;
  /**
   * The user's quick menu: favourites, and the tier slots they have renamed,
   * rebound or added. Absent on settings written before this existed, which the
   * reader treats as "the defaults" — see quick-menu.ts.
   */
  modelQuickMenu?: QuickMenuSettings;
  /** Effort resolution mode (default `auto`). `effort` stays the explicit level +
   * the last-resolved level for display. */
  effortMode: EffortMode;
  search: SearchKeys;
  mcpMode: McpMode;
  /** How tools are offered to the model (see {@link ToolInterface}). */
  toolInterface: ToolInterface;
  /** Chat box, or chat box plus the working ledge (see {@link WorkMode}). */
  workMode: WorkMode;
  /** How hard the app may push this machine (see {@link PowerMode}). */
  powerMode: PowerMode;
  /**
   * Draw the status pill beside the phantom cursor during computer use.
   *
   * the user: "remove the pill entirely via a setting 'show computer use status
   * pill'". It is the one part of the overlay that sits ON TOP of the user's own
   * windows saying words, so it is the one part somebody might not want.
   */
  showComputerUseStatusPill: boolean;
  /**
   * GB of memory the app promises never to take, so the machine stays usable
   * while it works. `undefined`/0 ⇒ derived from the machine's size (a quarter,
   * floored at 2 GB and capped at 8 — see `defaultReserveGB`). A NUMBER rather
   * than a fraction because that is what people mean by "leave me some room".
   */
  powerReserveGB?: number;
  capabilities: GenerationCapabilities;
  /** User system-instructions prepended to the first prompt of each NEW session
   * (see pi-connect's session-instructions seam). Empty = none. */
  customInstructions: string;
  /** Global SVG icon stroke width; applied to `--pd-icon-stroke` on <html>.
   * Defaults to the token value (1.25). */
  iconStroke: number;
  /** Element-size scale for the sidebar (rows, icons, text, rail); applied to
   * `--pd-sidebar-scale` on <html>. Default 1.0 (no-op). */
  sidebarScale: number;
  /** Element-size scale for the shared dropdown-menu option rows (model dropup +
   * "+" menu); applied to `--pd-menu-scale` on <html>. Default 1.0 (no-op). */
  menuScale: number;
  /** Starred model ids (curated or discovered-HF), surfaced in a Favorites
   * section of the Model Manager. */
  favoriteModels: string[];
  /** Per-model default effort; applied to the effort setting when that model is
   * set active (keyed by model id). */
  modelEffortDefaults: Record<string, EffortLevel>;
  /** Hugging Face access token for gated/private repos (search + gated
   * downloads). Sensitive — persisted to the 0600 settings.json. Empty = unset. */
  hfToken: string;
  /**
   * EXPERIMENTAL (default FALSE): route a submitted prompt through the
   * production coordination harness (the CorpEngine → situation room) instead of
   * the normal solo pi chat turn. Off = the app is byte-for-byte its current
   * self. Also force-enabled for a dev launch via `PI_DESKTOP_CORP=1` (surfaced
   * to the renderer as a `?corp=1` query param). Gates ALL corp wiring.
   */
  experimentalProductionHarness: boolean;
  /**
   * EXPERIMENTAL (default FALSE): wire the on-device GENERATION stack live — the
   * generation socket bridge (`registerGenIpc`), the `generate_image` /
   * `generate_video` pi tools, and the live gen-image canvas surface. Off = the
   * app is byte-for-byte its current self (no gen bridge, no gen tools, no gen
   * surface), so a signed /Applications build stays clean. Also force-enabled for
   * a dev launch via `PI_DESKTOP_GEN=1` (surfaced to the renderer as a `?gen=1`
   * query param). Sibling to {@link experimentalProductionHarness}.
   */
  experimentalGeneration: boolean;
  /** Power-user advanced inference knobs (sampling + reasoning). Defaults to
   * {@link DEFAULT_ADVANCED} — inert until touched. */
  advanced: AdvancedSettings;
  /** Chat organization (projects, assignments, pins, renames). Empty by default. */
  chatOrg: ChatOrganization;
  /** Skip the delete-chat confirmation dialog (set via its "don't ask again"). */
  hideDeleteChatConfirm: boolean;
  /**
   * Which pi drives the chat (Settings -> Harness). `pi-bundled` is the default
   * and means "whatever ships in the app"; `pi-system` resolves the one on PATH;
   * `pi-custom` uses {@link harnessConfigPath}. External agents (Claude Code,
   * Codex, ...) are never stored here — they are not something the app runs, so
   * they cannot be a value for "the harness the app runs".
   */
  harnessId: string;
  /** Absolute path to a custom pi config, used only when harnessId is pi-custom. */
  harnessConfigPath: string;
}

/** A partial patch merged over the current document (one level deep on the
 * nested `theme` / `search` / `capabilities` objects). */
export interface DesktopSettingsPatch {
  theme?: Partial<DesktopSettings['theme']>;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  userMode?: UserMode;
  enginePreference?: EnginePreference;
  /** Full replacement of the selection union (no deep-merge). */
  modelSelection?: ModelSelection;
  modelQuickMenu?: QuickMenuSettings;
  effortMode?: EffortMode;
  search?: Partial<SearchKeys>;
  mcpMode?: McpMode;
  toolInterface?: ToolInterface;
  workMode?: WorkMode;
  powerMode?: PowerMode;
  showComputerUseStatusPill?: boolean;
  powerReserveGB?: number;
  capabilities?: Partial<GenerationCapabilities>;
  customInstructions?: string;
  iconStroke?: number;
  sidebarScale?: number;
  menuScale?: number;
  /** Full replacement list (renderer read-modify-writes the whole array). */
  favoriteModels?: string[];
  /** Full replacement map (renderer read-modify-writes the whole record). */
  modelEffortDefaults?: Record<string, EffortLevel>;
  hfToken?: string;
  /** Experimental production-harness toggle (default FALSE). */
  experimentalProductionHarness?: boolean;
  /** Experimental generation-stack toggle (default FALSE). */
  experimentalGeneration?: boolean;
  /** Full replacement of the advanced knobs (renderer read-modify-writes the
   * whole object; deep-merged one level over the two nested groups in the store). */
  advanced?: Partial<AdvancedSettings>;
  /** Full replacement of chat organization (renderer read-modify-writes it whole). */
  chatOrg?: ChatOrganization;
  harnessId?: string;
  harnessConfigPath?: string;
  /** Skip the delete-chat confirmation dialog. */
  hideDeleteChatConfirm?: boolean;
}

/** Icon-stroke bounds — mirrors the IconStrokeControl slider range. */
export const ICON_STROKE_MIN = 1;
export const ICON_STROKE_MAX = 2.5;
export const ICON_STROKE_DEFAULT = 1.25;

/** Element-size scale bounds — shared by the sidebar + menu scale sliders.
 * Both default to 1.0 so an untouched install is byte-identical to today. */
export const UI_SCALE_MIN = 0.8; // FEEL — owner may retune
export const UI_SCALE_MAX = 1.5; // FEEL
export const UI_SCALE_DEFAULT = 1.0;

export type SettingsInvokeMap = {
  /** Current settings, seeded from onboarding.json + the mcp registry on first read. */
  'settings:get': { request: undefined; response: DesktopSettings };
  /** Merge a patch, persist, apply side effects (env + mcp registry mode); returns
   * the full new document. */
  'settings:set': { request: { patch: DesktopSettingsPatch }; response: DesktopSettings };
};

export const SETTINGS_INVOKE_CHANNELS = [
  'settings:get',
  'settings:set',
] as const satisfies readonly (keyof SettingsInvokeMap)[];
