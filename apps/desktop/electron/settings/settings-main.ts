/**
 * Main-process settings handlers. Owns `~/.pi/desktop/settings.json` (mode 0600
 * — it holds API keys) and the side effects that make the frozen extensions
 * observe a change:
 *   - web search keys → the main process env (`PI_BRAVE_API_KEY` /
 *     `PI_TAVILY_API_KEY`), which a (re)spawned pi child inherits so its
 *     web-tools extension reads them (web-tools reads keys from env only).
 *   - MCP mode → the `mode` field of `~/.pi/desktop/mcp-connectors.json`, the
 *     registry mcp-lite loads (servers preserved).
 *
 * Seeding is pure/read-only: an absent settings.json yields an in-memory
 * document derived from onboarding.json + the mcp registry, and is only written
 * once the user actually changes something (settings:set) — so read-only E2E
 * probes never mutate the profile. The one startup write is the registry's
 * `mode`, and only when it disagrees with the interface (see
 * applySettingsEnvFromDisk). Trusted-sender gated with the shared
 * allowSender, exactly like the import channels.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import type { OnboardingChoices } from '../import/import-contract';
import { macOverlay } from '../mac/overlay-controller';
import type { DesktopSettings, McpMode, SettingsInvokeMap } from './settings-contract';
import {
  clampSettings,
  mergeSettingsPatch,
  samplingSidecar,
  seedFromOnboarding,
  settingsChangedAt,
} from './settings-logic';

const log = createLogger('desktop:settings');

const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.pi', 'desktop', 'settings.json');
const ONBOARDING_PATH = path.join(HOME, '.pi', 'desktop', 'onboarding.json');
const MCP_REGISTRY_PATH = path.join(HOME, '.pi', 'desktop', 'mcp-connectors.json');
/** Dedicated sidecar the pi child reads for live per-request sampling overrides
 * (provider-llamacpp's advanced-params hook). Kept SEPARATE from settings.json so
 * the hot request path parses a tiny file, never the whole (key-bearing) doc. */
const SAMPLING_PATH = path.join(HOME, '.pi', 'desktop', 'advanced-sampling.json');

/** Absolute path to the sampling-override sidecar; handed to the pi child via
 * the `PI_ADV_SAMPLING_FILE` env (see pi-main's buildPiEnv). */
export function advancedSamplingFilePath(): string {
  return SAMPLING_PATH;
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readOnboardingChoices(): OnboardingChoices | null {
  // Mirror import-main's E2E gate: with PI_E2E set (and not the onboarding
  // probe), treat the profile as fresh so seeding never pulls the real user's
  // onboarding.json into a probe run (which would skew the base theme probe).
  if (process.env.PI_E2E === '1' && process.env.PI_ONBOARDING !== '1') return null;
  const raw = safeRead(ONBOARDING_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { choices?: OnboardingChoices };
    return parsed.choices ?? null;
  } catch {
    return null;
  }
}

function readMcpMode(): McpMode | null {
  const raw = safeRead(MCP_REGISTRY_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === 'native' || parsed.mode === 'lite' || parsed.mode === 'bash-cli'
      ? parsed.mode
      : null;
  } catch {
    return null;
  }
}

/** Current document: the persisted file when present, else a pure seed (no
 * write) from onboarding + the mcp registry. */
/** What a fenced run (see settingsWriteIsFenced) has set, in memory only. */
let fencedOverlay: DesktopSettings | null = null;

export function readSettings(): DesktopSettings {
  if (fencedOverlay !== null) return fencedOverlay;
  const raw = safeRead(SETTINGS_PATH);
  if (raw === null) return seedFromOnboarding(readOnboardingChoices(), readMcpMode());
  try {
    return clampSettings(JSON.parse(raw));
  } catch {
    // Corrupt file → re-seed rather than brick the settings surface.
    return seedFromOnboarding(readOnboardingChoices(), readMcpMode());
  }
}

/** Mirror the search keys into the main process env so the NEXT pi child (a
 * fresh window or a `pi:restart`) hands them to web-tools. Empty = unset. */
function applySearchEnv(settings: DesktopSettings): void {
  if (settings.search.brave) process.env.PI_BRAVE_API_KEY = settings.search.brave;
  else delete process.env.PI_BRAVE_API_KEY;
  if (settings.search.tavily) process.env.PI_TAVILY_API_KEY = settings.search.tavily;
  else delete process.env.PI_TAVILY_API_KEY;
}

/** Flip the `mode` field of the mcp-lite registry, preserving `servers`. */
/**
 * The connector mode the registry should actually run in.
 *
 * `mcpMode` and `toolInterface` were independent, so turning on the bash-CLI
 * interface left connectors on the JSON `mcp_call` proxy — the model was told
 * "these commands are your abilities", handed a shim per capability, and then
 * given MCP as a structured tool call. The user: "all capabilities / mcp when in
 * bash mode should be translated."
 *
 * mcp-lite already has the translation — `pi-tool gmail search --query foo`,
 * with `--help` generated live from each tool's own inputSchema, so it cannot
 * drift from the server. It just was not being switched on. A mixed state is
 * the contradiction that costs the most: a model that can see one JSON tool
 * reaches for it and never learns the commands.
 *
 * `native` is left alone — that is a deliberate choice to register every
 * connector tool individually, and it is not what this is about.
 */
export function effectiveMcpMode(mcpMode: McpMode, toolInterface: string): McpMode {
  return toolInterface === 'bash-cli' && mcpMode === 'lite' ? 'bash-cli' : mcpMode;
}

function applyMcpMode(mode: McpMode): void {
  let doc: Record<string, unknown> = { version: 1, mode, servers: [] };
  const raw = safeRead(MCP_REGISTRY_PATH);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.servers)) doc = { ...parsed, version: 1, mode };
    } catch {
      // fall through to a fresh registry with just the mode set.
    }
  }
  try {
    fs.mkdirSync(path.dirname(MCP_REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(MCP_REGISTRY_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.warn('mcp mode write failed', { error: String(error) });
  }
}

/**
 * Mirror the per-request sampling overrides into the sidecar the pi child reads
 * (camelCase mirror of {@link AdvancedSamplingSettings} == the provider's
 * SamplingOverride shape, plus the user's own thinking cap — samplingSidecar). Rewritten on every change so a slider takes effect on
 * the child's NEXT request (it mtime-caches the file), no relaunch. Best-effort:
 * a write failure just leaves the server CLI defaults in force.
 */
function writeSamplingSidecar(settings: DesktopSettings): void {
  try {
    fs.mkdirSync(path.dirname(SAMPLING_PATH), { recursive: true });
    fs.writeFileSync(SAMPLING_PATH, `${JSON.stringify(samplingSidecar(settings))}\n`, 'utf8');
  } catch (error) {
    log.warn('sampling sidecar write failed', { error: String(error) });
  }
}

/**
 * A PROBE MUST NEVER WRITE THE PERSON'S SETTINGS.
 *
 * `~/.pi/desktop/settings.json` is shared with the real app. Twice now a
 * headless probe launched without a throwaway HOME has set what it needed for
 * its run — `powerMode: 'full'` before the freeze of 2026-09-11, and
 * `toolInterface: 'schemas'` + `powerMode: 'full'` (gen-chat-capture) — and
 * left it there, so the user's Bobble came up in a mode the user never chose: "cli should
 * be default mode, so why is it not in the shipped applications build?" It was;
 * their file said otherwise.
 *
 * So under PI_E2E the document is kept in memory only when HOME is the
 * account's real home — `os.userInfo().homedir` reads the passwd entry, which a
 * probe's `HOME=` override does not touch — and the refusal is logged where the
 * probe's author will see it. A probe with its own HOME writes as before.
 */
export function settingsWriteIsFenced(
  env: NodeJS.ProcessEnv = process.env,
  realHome: () => string = () => os.userInfo().homedir,
  home: string = HOME,
): boolean {
  if (env.PI_E2E !== '1') return false;
  try {
    return path.resolve(realHome()) === path.resolve(home);
  } catch {
    return false;
  }
}

function writeSettings(settings: DesktopSettings): void {
  if (settingsWriteIsFenced()) {
    log.warn(
      'settings write REFUSED: PI_E2E run aimed at the real home — give the probe its own HOME',
      {
        path: SETTINGS_PATH,
      },
    );
    // The run still gets what it asked for — for as long as it runs.
    fencedOverlay = settings;
    applySearchEnv(settings);
    applyMcpMode(effectiveMcpMode(settings.mcpMode, settings.toolInterface));
    return;
  }
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  // 0600: the document carries web-search API keys.
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  applySearchEnv(settings);
  applyMcpMode(effectiveMcpMode(settings.mcpMode, settings.toolInterface));
  writeSamplingSidecar(settings);
}

/**
 * Called once at main startup (before the first pi spawn) so a persisted set of
 * search keys is already on the env for the initial session. Read-only unless a
 * settings.json exists; never seeds/writes.
 */
export function applySettingsEnvFromDisk(): void {
  const settings = readSettings();
  /*
   * THE REGISTRY'S MODE IS DERIVED, SO DERIVE IT BEFORE THE FIRST SPAWN.
   *
   * `effectiveMcpMode` only ran inside writeSettings — on the first settings
   * change. Until then a fresh install had the CLI interface (the default) with
   * connectors still in `lite`, which is exactly the mixed state the coupling
   * exists to prevent, and the Connectors page said "Lite" while the model was
   * being handed commands. Seeding settings.json stays read-only; the registry's
   * mode is a different file and a derived value, and it is only touched when it
   * actually differs — so a probe against an already-consistent profile still
   * writes nothing.
   */
  const wanted = effectiveMcpMode(settings.mcpMode, settings.toolInterface);
  if (readMcpMode() !== wanted) applyMcpMode(wanted);
  if (safeRead(SETTINGS_PATH) === null) return;
  applySearchEnv(settings);
  // Seed the sampling sidecar so the FIRST pi child already sees a persisted
  // custom sampling profile (mtime-cached in the provider). A no-op-equivalent
  // write for a default profile.
  writeSamplingSidecar(settings);
}

/**
 * Whether the generation stack is on: ALWAYS. It was an experiment behind a
 * Settings toggle (`experimentalGeneration`) and the `PI_DESKTOP_GEN=1` env
 * override; the user (2026-09-20): "remove from experimental the 'on device
 * generation' button, that's just a bit silly, the whole app is that". The
 * persisted flag is still parsed so an old settings file reads cleanly, and
 * ignored. pi-main reads this for PI_DESKTOP_GEN_MEDIA (which gen tools
 * register).
 */
export function generationExperimentEnabled(): boolean {
  return true;
}

/**
 * SIDE EFFECTS SUBSCRIBE; THEY ARE NOT WIRED IN HERE.
 *
 * The three reactions above this line (power, engine launch, the pill) were
 * each a callback threaded through `registerSettingsIpc`, which is fine for
 * three and a merge conflict for the push's six features (memory starts its
 * service, devices its gateway, training re-reads its power policy…). A
 * feature subscribes to the part of the document it cares about instead,
 * from its own file (deliverables/research/PLAN.md R6):
 *
 *   subscribeSettings('memory.enabled', (next, before) => …)
 *
 * `prefix` is a dotted path (`memory`, `memory.enabled`,
 * `capabilities.training`); `''` hears every change. A listener runs after the
 * document is written, only when the value at its path actually changed, and
 * for EVERY write — the renderer's `settings:set` and main's own
 * `writeSettingsPatch` alike, because a reaction that holds only for one of
 * the two is a reaction that drifts. A listener that throws is logged and
 * does not stop the others or the write. Returns the unsubscribe.
 */
export type SettingsListener = (next: DesktopSettings, before: DesktopSettings) => void;

const subscribers = new Set<{ prefix: string; listener: SettingsListener }>();

export function subscribeSettings(prefix: string, listener: SettingsListener): () => void {
  const entry = { prefix, listener };
  subscribers.add(entry);
  return () => {
    subscribers.delete(entry);
  };
}

function notifySubscribers(before: DesktopSettings, next: DesktopSettings): void {
  for (const { prefix, listener } of [...subscribers]) {
    if (!settingsChangedAt(prefix, before, next)) continue;
    try {
      listener(next, before);
    } catch (error) {
      log.warn('settings subscriber failed', { prefix, error: String(error) });
    }
  }
}

/**
 * A main-side write of one patch, for a setting main itself decides — the
 * library root after a move (storage-main). None of the renderer-edit hooks
 * below (power, engine launch, the pill) run for it; `subscribeSettings`
 * listeners do.
 */
export function writeSettingsPatch(
  patch: SettingsInvokeMap['settings:set']['request']['patch'],
): DesktopSettings {
  const before = readSettings();
  const next = mergeSettingsPatch(before, patch);
  writeSettings(next);
  notifySubscribers(before, next);
  return next;
}

const handlers: IpcHandlers<SettingsInvokeMap> = {
  'settings:get': () => readSettings(),
  'settings:set': (req) => {
    const before = readSettings();
    const next = mergeSettingsPatch(before, req.patch);
    writeSettings(next);
    /*
     * The power choice lives here but ACTS in the inference worker (it is the
     * process that launches servers, so the decision must be in hand when the
     * args are assembled). Pushed on change rather than read on demand, so the
     * worker never has to reach back across the process boundary mid-launch.
     */
    if (next.powerMode !== before.powerMode || next.powerReserveGB !== before.powerReserveGB) {
      onPowerSettingsChanged?.();
    }
    if (
      JSON.stringify(next.engineLaunch) !== JSON.stringify(before.engineLaunch) ||
      JSON.stringify(next.portableKnobs) !== JSON.stringify(before.portableKnobs) ||
      JSON.stringify(next.modelSpec) !== JSON.stringify(before.modelSpec) ||
      next.loadVision !== before.loadVision
    ) {
      onEngineLaunchChanged?.();
    }
    /* The pill is drawn by the Swift panel, which has no idea a setting exists —
       so the change has to be pushed at it, and it has to take effect on a pill
       that is ALREADY on screen, not just the next one. */
    if (next.showComputerUseStatusPill !== before.showComputerUseStatusPill) {
      void macOverlay.setPillEnabled(next.showComputerUseStatusPill);
    }
    // Every feature's own reaction (see subscribeSettings).
    notifySubscribers(before, next);
    log.info('settings updated', {
      keys: Object.keys(req.patch),
      mcpMode: next.mcpMode,
      permissionMode: next.permissionMode,
      effort: next.effort,
    });
    return next;
  },
};

/**
 * Told when the power choice changes, so main can forward it to the inference
 * worker. A callback rather than a direct import because settings must not
 * depend on inference — the dependency already runs the other way.
 */
let onPowerSettingsChanged: (() => void) | undefined;
/** Same seam for the launch flags + speculative choices (Settings → Advanced → Engine). */
let onEngineLaunchChanged: (() => void) | undefined;

export function registerSettingsIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  opts: { onPowerChanged?: () => void; onEngineLaunchChanged?: () => void } = {},
): void {
  onPowerSettingsChanged = opts.onPowerChanged;
  onEngineLaunchChanged = opts.onEngineLaunchChanged;
  registerIpcHandlers<SettingsInvokeMap>(ipcMain, handlers, { allowSender });
}
