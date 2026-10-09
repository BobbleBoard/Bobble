/**
 * Main-process connectors handlers. Owns `~/.pi/desktop/mcp-connectors.json`
 * through the @pi-desktop/mcp-lite registry helpers (the SAME file the mcp-lite
 * pi extension reads at activation), so an install/enable/disable persists and
 * the next pi session (or a session reload) picks up the change — the
 * ConnectorHost lives inside the pi child and re-reads the registry on spawn.
 *
 * The registry `mode` field is preserved on every mutation; mode changes flow
 * through the settings surface (settings:set → applyMcpMode), keeping the two
 * files coherent. Trusted-sender gated like the other app channels.
 */
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { getCatalogModel, modelDir } from '@pi-desktop/inference';
import {
  ConnectorHost,
  connectorNeedsConfig,
  type DetectAppsEnv,
  defaultRegistryPath,
  detectedSuggestions,
  isBuiltinConnector,
  KNOWN_CONNECTORS,
  KNOWN_CONNECTORS_BY_ID,
  type KnownConnector,
  loadRegistry,
  type McpRegistryConfig,
  type McpServerConfig,
  type McpToolDef,
  nodeDetectAppsEnv,
  nodeRegistryIO,
  oneLineDescription,
  recommendedConnectors,
  removeServer,
  saveRegistry,
  setServerEnabled,
  upsertServer,
} from '@pi-desktop/mcp-lite';
import { createLogger, type IpcHandlers, registerIpcHandlers } from '@pi-desktop/shared';
import type { IpcMain } from 'electron';
import { GEN_MODULE_META, type GenModuleId, type GenModulesManager } from '../gen/gen-modules';
import { model3dReady } from '../gen3d/gen3d-main';
import { deleteCatalogModel, downloadCatalogModel } from '../inference/llm-main';
import { readSettings, writeSettingsPatch } from '../settings/settings-main';
import type {
  ConnectorsInvokeMap,
  ConnectorToolListing,
  ModuleConnectorState,
} from './connectors-contract';

const log = createLogger('desktop:connectors');
const REGISTRY_PATH = defaultRegistryPath(os.homedir());

function read(): McpRegistryConfig {
  return loadRegistry(REGISTRY_PATH, nodeRegistryIO);
}

function write(config: McpRegistryConfig): McpRegistryConfig {
  saveRegistry(REGISTRY_PATH, config, nodeRegistryIO);
  return config;
}

/**
 * The scan surface. Production scans /Applications; under E2E/tests a fixture
 * dir (`PI_CONNECTORS_APPS_DIR`) makes "Recommended for you" deterministic — its
 * process list is emptied so only the fixture's `.app` names drive suggestions.
 */
function scanEnv(): DetectAppsEnv {
  const fixtureDir = process.env.PI_CONNECTORS_APPS_DIR;
  if (fixtureDir !== undefined && fixtureDir !== '') {
    return { ...nodeDetectAppsEnv(fixtureDir), listProcesses: () => [] };
  }
  return nodeDetectAppsEnv();
}

/**
 * What advertising one tool costs the prompt in Native mode: the JSON the model
 * is shown (name, description, schema) at the usual ~4 characters per token.
 * An estimate, and said to be one on screen — but the only number either
 * reference product never shows, and on a local model the one that matters.
 */
export function estimateToolTokens(tool: McpToolDef): number {
  const shown = JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  });
  return Math.max(1, Math.ceil(shown.length / 4));
}

/** The last few stderr lines a server wrote — its own account of why it failed. */
const STDERR_KEEP = 3;

/**
 * Start a server once, list what it has, tear it down. Shared by the
 * registry-backed listing and the dialog's Test, which differ only in where
 * the config came from.
 */
async function listTools(server: McpServerConfig): Promise<ConnectorToolListing> {
  const stderr: string[] = [];
  const host = new ConnectorHost({
    connectTimeoutMs: 15_000,
    onLog: (_id, line) => {
      const text = line.trim();
      if (text === '') return;
      stderr.push(text.length > 240 ? `${text.slice(0, 240)}…` : text);
      if (stderr.length > STDERR_KEEP) stderr.shift();
    },
  });
  // Every tool the server has, whatever the person switched off: the screen
  // draws the switches, so it needs the off ones too. The host filters for the
  // model; this listing is for the person.
  const { disabledTools: _off, ...everything } = server;
  try {
    const result = await host.connect(everything);
    if (!result.ok) return { tools: [], error: result.error ?? 'failed to connect', stderr };
    const tools = host.getServerTools(server.id).map((t) => ({
      name: t.name,
      description: oneLineDescription(t.description),
      tokens: estimateToolTokens(t),
    }));
    return { tools };
  } catch (error) {
    log.warn('connectors: listing failed', { id: server.id, error: String(error) });
    return {
      tools: [],
      error: String(error instanceof Error ? error.message : error),
      stderr,
    };
  } finally {
    host.disposeAll();
  }
}

/** Are a model connector's files on disk? The whole of its installed state. */
function modelFilesPresent(c: KnownConnector): boolean {
  const model = c.modelId === undefined ? undefined : getCatalogModel(c.modelId);
  if (model === undefined) return false;
  const dir = modelDir(model.id);
  const wanted = [model.files[0]?.name, model.mmproj?.name].filter(
    (n): n is string => n !== undefined,
  );
  return wanted.length > 0 && wanted.every((n) => existsSync(path.join(dir, n)));
}

/**
 * A MODULE CONNECTOR — the 3D studio's engine as chat tools (Bobble 3D).
 *
 * Its state has two halves: the engine on disk (the gen module the studio
 * installs) and the person's switch (settings `moduleConnectors`). The tools
 * register at pi's spawn only when both hold (pi-main PI_BOBBLE_3D_READY), so
 * the card says "on" on exactly the same condition. The user (2026-09-17): "3d
 * should be a connector that gets recommended for install upon installing
 * the 3d studio module".
 */
interface ConnectorsDeps {
  /** The gen modules manager, once main has one — the engine install runs through it. */
  readonly modules?: () => GenModulesManager | null;
}
let deps: ConnectorsDeps = {};

/** Is the engine behind a module connector on this Mac? No boot, files only. */
function moduleReady(id: GenModuleId | string): boolean {
  if (id === '3d') return model3dReady();
  return false;
}

function moduleConnectorState(c: KnownConnector): ModuleConnectorState {
  const id = c.moduleId ?? '';
  const meta = (GEN_MODULE_META as Record<string, { approxGB: number } | undefined>)[id];
  return {
    ready: moduleReady(id),
    on: readSettings().moduleConnectors[id] === true,
    approxGB: meta?.approxGB ?? 0,
  };
}

function moduleConnectorStates(): Record<string, ModuleConnectorState> {
  return Object.fromEntries(
    KNOWN_CONNECTORS.filter((c) => c.kind === 'module').map((c) => [c.id, moduleConnectorState(c)]),
  );
}

const handlers: IpcHandlers<ConnectorsInvokeMap> = {
  'connectors:list': () => ({
    registry: read(),
    catalog: KNOWN_CONNECTORS,
    installedModels: KNOWN_CONNECTORS.filter((c) => c.kind === 'model' && modelFilesPresent(c)).map(
      (c) => c.id,
    ),
    moduleConnectors: moduleConnectorStates(),
  }),

  'connectors:scan': () => {
    const env = scanEnv();
    /*
     * "RECOMMENDED FOR YOU" also reads what THIS APP has installed, not only
     * /Applications: the 3D studio's engine on disk with its chat connector
     * still off is exactly the moment to offer it — the person has shown they
     * make 3D models, and the connector is one click and no download.
     */
    const modules = KNOWN_CONNECTORS.filter((c) => c.kind === 'module')
      .map((c) => ({ c, state: moduleConnectorState(c) }))
      .filter(({ state }) => state.ready && !state.on)
      .map(({ c }) => ({ ...c, detected: true, reason: '3D studio is installed' }));
    return {
      recommended: [...modules, ...recommendedConnectors(env)],
      detected: detectedSuggestions(env),
    };
  },

  'connectors:install': async (req) => {
    const connector = KNOWN_CONNECTORS_BY_ID[req.id];
    if (connector === undefined) {
      return { registry: read(), error: `Unknown connector "${req.id}"` };
    }
    /*
     * A MODEL CONNECTOR INSTALLS BY DOWNLOADING ITS MODEL, and nothing else.
     *
     * It never enters the registry: the registry is what `connectAll` spawns at
     * startup, and a "server" with an empty command would be a phantom error on
     * every launch. The files on disk are the install — `connectors:list`
     * reports them as `installedModels` — so this awaits the fetch and returns
     * only when the card can honestly turn on. Progress streams to the renderer
     * as `llm:download-progress`, the same event the model screen draws.
     */
    /*
     * A MODULE CONNECTOR INSTALLS ITS ENGINE IF IT HAS TO, THEN TURNS ON.
     *
     * With the engine already there (the 3D studio has been used) this is a
     * flag in settings and a pi respawn — instant. Without it, the same
     * install the studio's Download card runs, awaited here so the card can
     * honestly turn on when it resolves; its progress reaches the window as
     * `gen:module`, the event the studio's card already draws.
     */
    if (connector.kind === 'module') {
      const moduleId = connector.moduleId ?? '';
      if (moduleId === '') return { registry: read(), error: `"${req.id}" names no module` };
      if (!moduleReady(moduleId)) {
        const modules = deps.modules?.() ?? null;
        if (modules === null) {
          return {
            registry: read(),
            error: 'the 3D engine is not installed — install it from the 3D studio first',
          };
        }
        try {
          await modules.install(moduleId as GenModuleId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn('module connector engine install failed', { id: req.id, error: message });
          return { registry: read(), error: message };
        }
        if (!moduleReady(moduleId)) {
          return { registry: read(), error: 'the 3D engine did not install — see the 3D studio' };
        }
      }
      writeSettingsPatch({ moduleConnectors: { [moduleId]: true } });
      log.info('module connector turned on', { id: req.id, moduleId });
      return { registry: read() };
    }
    if (connector.kind === 'model') {
      const modelId = connector.modelId ?? '';
      if (modelId === '') return { registry: read(), error: `"${req.id}" names no model` };
      const r = await downloadCatalogModel(modelId);
      if (!r.success) {
        log.warn('model connector download failed', { id: req.id, error: r.error });
        return {
          registry: read(),
          error: r.error ?? (r.cancelled ? 'download cancelled' : 'download failed'),
        };
      }
      log.info('model connector installed', { id: req.id, modelId });
      return { registry: read() };
    }
    // Builtins (HyperFrames, Video editing) are always on — never a server in
    // the registry. Installing one is a no-op so the gallery's "Preinstalled"
    // affordance can't accidentally seed a phantom empty-command server.
    if (isBuiltinConnector(req.id)) {
      return { registry: read(), error: `"${req.id}" is preinstalled` };
    }
    // Never preload-enable anything needing secrets/auth or a <placeholder> arg;
    // it lands disabled until the user configures it.
    const enabled = !connectorNeedsConfig(connector);
    const server: McpServerConfig = { ...connector.template, enabled };
    const next = write(upsertServer(read(), server));
    log.info('connector installed', { id: req.id, enabled });
    return { registry: next };
  },

  'connectors:upsert': (req) => ({ registry: write(upsertServer(read(), req.server)) }),

  'connectors:remove': async (req) => {
    // Builtins can't be removed — guard so a stray remove is inert.
    if (isBuiltinConnector(req.id)) return { registry: read() };
    // A model connector's uninstall is deleting its model files.
    const model = KNOWN_CONNECTORS_BY_ID[req.id];
    if (model?.kind === 'model' && model.modelId !== undefined) {
      await deleteCatalogModel(model.modelId);
      return { registry: read() };
    }
    // A module connector's removal turns its tools off. The engine is the
    // studio's and stays; Manage Storage is where an engine is deleted.
    if (model?.kind === 'module' && model.moduleId !== undefined) {
      writeSettingsPatch({ moduleConnectors: { [model.moduleId]: false } });
      log.info('module connector turned off', { id: req.id, moduleId: model.moduleId });
      return { registry: read() };
    }
    return { registry: write(removeServer(read(), req.id)) };
  },

  'connectors:set-enabled': (req) => {
    // Builtins are always on; toggling them is a no-op. So is a model connector:
    // it is on exactly when its files exist, and off is "remove".
    const kind = KNOWN_CONNECTORS_BY_ID[req.id]?.kind;
    if (isBuiltinConnector(req.id) || kind === 'model' || kind === 'module') {
      return { registry: read() };
    }
    return { registry: write(setServerEnabled(read(), req.id, req.enabled)) };
  },

  'connectors:tools': async (req) => {
    // Only for an installed + enabled MCP server — never a builtin (no server)
    // or an uninstalled card (don't spawn something the user hasn't added).
    if (isBuiltinConnector(req.id)) {
      return { tools: [], error: `"${req.id}" is a built-in (no live server)` };
    }
    if (KNOWN_CONNECTORS_BY_ID[req.id]?.kind === 'model') {
      return { tools: [], error: `"${req.id}" is a model (no live server)` };
    }
    if (KNOWN_CONNECTORS_BY_ID[req.id]?.kind === 'module') {
      return { tools: [], error: `"${req.id}" is an engine (no live server)` };
    }
    const server = read().servers.find((s) => s.id === req.id);
    if (server === undefined) return { tools: [], error: `"${req.id}" is not installed` };
    if (server.enabled === false) return { tools: [], error: `"${req.id}" is disabled` };
    return listTools(server);
  },

  // The dialog's Test. Starts exactly what was typed and writes nothing: the
  // registry is untouched whether it worked or not.
  'connectors:probe': (req) => listTools(req.server),
};

export function registerConnectorsIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  options: ConnectorsDeps = {},
): void {
  deps = options;
  registerIpcHandlers<ConnectorsInvokeMap>(ipcMain, handlers, { allowSender });
}
