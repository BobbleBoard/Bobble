/**
 * Renderer connectors state for the Connectors screen. Mirrors the
 * main-process `~/.pi/desktop/mcp-connectors.json` registry (via the connectors:*
 * IPC), the full connector catalog, and the /Applications scan that powers
 * "Recommended for you". Mutations (install / enable / disable / remove) round-
 * trip through IPC and adopt the returned registry so the screen stays in sync.
 *
 * The MCP mode (lite / native / bash-cli) is NOT owned here — it lives in the
 * settings store (settings.json + the registry `mode`), so the screen's mode
 * control reuses that path and this store stays purely about servers.
 */
import type {
  ConnectorSuggestion,
  KnownConnector,
  McpRegistryConfig,
  McpServerConfig,
} from '@pi-desktop/mcp-lite';
import { create } from 'zustand';
import type { ConnectorToolListing } from '../../electron/connectors/connectors-contract';

interface ConnectorsStoreState {
  registry: McpRegistryConfig;
  catalog: KnownConnector[];
  /** Ids of model connectors whose files are on disk — their installed state. */
  installedModels: string[];
  recommended: ConnectorSuggestion[];
  detected: ConnectorSuggestion[];
  loaded: boolean;
  busyId: string | null;
  /** Load catalog + registry + run the /Applications scan. */
  load: () => Promise<void>;
  /** Re-run only the /Applications scan (recommended/detected). */
  rescan: () => Promise<void>;
  /** Add a catalog connector by id (disabled if it needs config). */
  install: (id: string) => Promise<void>;
  /** Remove a configured server by id. */
  remove: (id: string) => Promise<void>;
  /** Enable/disable a configured server by id. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Insert or replace an arbitrary server config. */
  upsert: (server: McpServerConfig) => Promise<void>;
  /**
   * The same write without the busy state: a per-tool switch is a one-word
   * change to a server that stays on, and the spinner that replaces the
   * server's own switch for the write would read as the server restarting.
   */
  upsertQuiet: (server: McpServerConfig) => Promise<void>;
  /** Start an installed + enabled server once and list what it has. */
  fetchTools: (id: string) => Promise<ConnectorToolListing>;
  /** The same for a config that is not (yet) in the registry — the dialog's Test. */
  probeServer: (server: McpServerConfig) => Promise<ConnectorToolListing>;
}

/** A tool as shown on the screen (name + one line + prompt cost, no schema). */
export type ConnectorTool = ConnectorToolListing['tools'][number];

const EMPTY_REGISTRY: McpRegistryConfig = { version: 1, mode: 'lite', servers: [] };

export const useConnectorsStore = create<ConnectorsStoreState>((set, get) => ({
  registry: EMPTY_REGISTRY,
  catalog: [],
  installedModels: [],
  recommended: [],
  detected: [],
  loaded: false,
  busyId: null,

  load: async () => {
    const [list, scan] = await Promise.all([
      window.piDesktop.invoke('connectors:list', undefined),
      window.piDesktop.invoke('connectors:scan', undefined),
    ]);
    set({
      registry: list.registry,
      catalog: list.catalog,
      installedModels: list.installedModels ?? [],
      recommended: scan.recommended,
      detected: scan.detected,
      loaded: true,
    });
  },

  rescan: async () => {
    const scan = await window.piDesktop.invoke('connectors:scan', undefined);
    set({ recommended: scan.recommended, detected: scan.detected });
  },

  install: async (id) => {
    set({ busyId: id });
    try {
      const { registry, error } = await window.piDesktop.invoke('connectors:install', { id });
      /* The download's progress bar in the top bar is the llm store's, fed by the
         same events the model screen uses — but that screen's own action is what
         takes the bar down when its invoke resolves, and this one resolves here.
         MEASURED: the bar sat at 100% with its X for the rest of the session. */
      const modelId = get().catalog.find((c) => c.id === id)?.modelId;
      if (modelId !== undefined) {
        const { useLlmStore } = await import('./llm-store');
        useLlmStore.getState().settleDownload(modelId);
      }
      /* A model connector's install is a download; its state is the files, which
         only a fresh list reports. Re-list rather than guess. */
      const list = await window.piDesktop.invoke('connectors:list', undefined);
      set({ registry, installedModels: list.installedModels ?? [] });
      if (error !== undefined && error !== '') throw new Error(error);
      /* A model connector's tool is registered at pi's spawn (PI_OMNISVG_READY),
         so the download has to be followed by a respawn for `svg` to exist in
         the running session — same reason the search panel restarts pi after
         a key changes the env. the user: "download the connector and then have it
         used in a new chat" — this is what makes the new chat have it. */
      if (isModelConnector(get(), id)) await restartForModelChange();
    } finally {
      set({ busyId: null });
    }
  },

  remove: async (id) => {
    set({ busyId: id });
    try {
      const { registry } = await window.piDesktop.invoke('connectors:remove', { id });
      const list = await window.piDesktop.invoke('connectors:list', undefined);
      set({ registry, installedModels: list.installedModels ?? [] });
      if (isModelConnector(get(), id)) await restartForModelChange();
    } finally {
      set({ busyId: null });
    }
  },

  setEnabled: async (id, enabled) => {
    set({ busyId: id });
    try {
      const { registry } = await window.piDesktop.invoke('connectors:set-enabled', { id, enabled });
      set({ registry });
    } finally {
      set({ busyId: null });
    }
  },

  upsert: async (server) => {
    set({ busyId: server.id });
    try {
      const { registry } = await window.piDesktop.invoke('connectors:upsert', { server });
      set({ registry });
    } finally {
      set({ busyId: null });
    }
  },

  upsertQuiet: async (server) => {
    const { registry } = await window.piDesktop.invoke('connectors:upsert', { server });
    set({ registry });
  },

  // Read-only probes — no busy/registry mutation. The screen's tool cache owns
  // the in-flight state and remembers the answer (connectors/model.ts).
  fetchTools: (id) => window.piDesktop.invoke('connectors:tools', { id }),
  probeServer: (server) => window.piDesktop.invoke('connectors:probe', { server }),
}));

/** The configured server for a catalog id, if it has been installed. */
export function installedServer(
  registry: McpRegistryConfig,
  id: string,
): McpServerConfig | undefined {
  return registry.servers.find((s) => s.id === id);
}

/** Whether a connector id is installed AND enabled (default true). */
export function isEnabled(registry: McpRegistryConfig, id: string): boolean {
  const server = installedServer(registry, id);
  return server !== undefined && server.enabled !== false;
}

/** Is this catalog id a model connector (one whose tool is gated at pi's spawn)? */
function isModelConnector(state: { catalog: KnownConnector[] }, id: string): boolean {
  return state.catalog.find((c) => c.id === id)?.kind === 'model';
}

/** Respawn pi so a tool gated on the model's presence appears (or disappears). */
async function restartForModelChange(): Promise<void> {
  try {
    const { restartPi } = await import('./pi-connect');
    await restartPi();
  } catch {
    /* A failed respawn is reported by the pi slice itself; the install already succeeded. */
  }
}
