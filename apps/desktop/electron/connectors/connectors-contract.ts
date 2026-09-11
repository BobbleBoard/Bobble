/**
 * Connectors IPC contract — the Connectors screen reads the catalog + configured
 * registry, runs the /Applications scan for "Recommended for you", mutates the
 * registry (install / upsert / remove / enable), and lists a server's tools by
 * starting it once. The main-process handler (./connectors-main.ts) owns
 * `~/.pi/desktop/mcp-connectors.json` via the @pi-desktop/mcp-lite registry
 * helpers.
 *
 * All payload types come from @pi-desktop/mcp-lite as TYPE-ONLY imports, so the
 * renderer/preload never bundle that package's node-touching modules — only the
 * erased shapes cross the boundary. Composed into ../ipc-contract.ts.
 */
import type {
  ConnectorSuggestion,
  KnownConnector,
  McpRegistryConfig,
  McpServerConfig,
} from '@pi-desktop/mcp-lite';

/** A tool as the screen shows it: name, one line, and what it costs to advertise. */
export interface ConnectorToolListing {
  /**
   * Every tool the server reported — switched-off ones included, since the
   * screen draws their switches. Never a schema; `tokens` is the estimate of
   * what the schema costs the prompt when the tool is advertised in Native
   * mode (≈ JSON length / 4).
   */
  tools: Array<{ name: string; description: string; tokens: number }>;
  /**
   * Set (tools empty) when the id is unknown / builtin / not installed, or
   * the server could not be started or did not complete the handshake — the
   * host's own sentence ("MCP server process exited (code 1)", "spawn uvx
   * ENOENT", "… timed out after 15000ms").
   */
  error?: string;
  /**
   * The last lines the server wrote to stderr before it failed ("GitHub API:
   * 401 Bad credentials") — the reason in the server's own words, which the
   * host's exit code never carries. Empty on success.
   */
  stderr?: string[];
}

export type ConnectorsInvokeMap = {
  /** The configured registry (mode + servers) plus the full catalog of cards. */
  'connectors:list': {
    request: undefined;
    response: {
      registry: McpRegistryConfig;
      catalog: KnownConnector[];
      /**
       * Ids of `kind:'model'` connectors whose model files are on disk. A model
       * connector never enters the registry (it is not a server), so this is its
       * installed state — the files ARE the install.
       */
      installedModels: string[];
    };
  };
  /** Run the /Applications scan → recommended (app-mapped, pinned) + detected. */
  'connectors:scan': {
    request: undefined;
    response: { recommended: ConnectorSuggestion[]; detected: ConnectorSuggestion[] };
  };
  /** Add a catalog connector to the registry by id (disabled if it needs config).
   * `error` is set (registry unchanged) when the id is unknown. */
  'connectors:install': {
    request: { id: string };
    response: { registry: McpRegistryConfig; error?: string };
  };
  /** Insert or replace an arbitrary server config (edited card / manual add). */
  'connectors:upsert': {
    request: { server: McpServerConfig };
    response: { registry: McpRegistryConfig };
  };
  /** Remove a configured server by id. */
  'connectors:remove': {
    request: { id: string };
    response: { registry: McpRegistryConfig };
  };
  /** Toggle a configured server's enabled flag. */
  'connectors:set-enabled': {
    request: { id: string; enabled: boolean };
    response: { registry: McpRegistryConfig };
  };
  /**
   * List an installed + enabled server's tools: start it once via the mcp-lite
   * ConnectorHost, list, tear it down. Only ever for an installed + enabled
   * MCP connector; see {@link ConnectorToolListing} for the failure shape.
   */
  'connectors:tools': {
    request: { id: string };
    response: ConnectorToolListing;
  };
  /**
   * The same listing for a config that is NOT in the registry — the add
   * dialog's Test: start what the person typed, show its tools, write nothing.
   */
  'connectors:probe': {
    request: { server: McpServerConfig };
    response: ConnectorToolListing;
  };
};

export const CONNECTORS_INVOKE_CHANNELS = [
  'connectors:list',
  'connectors:scan',
  'connectors:install',
  'connectors:upsert',
  'connectors:remove',
  'connectors:set-enabled',
  'connectors:tools',
  'connectors:probe',
] as const satisfies readonly (keyof ConnectorsInvokeMap)[];
