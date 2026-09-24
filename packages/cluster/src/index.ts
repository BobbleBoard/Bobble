/**
 * The cluster seam: which machines exist, and what they can do.
 *
 * Deliberately small and platform-neutral. The app's other OS-touching code was
 * written for macOS and is being ported; this one starts where it means to end
 * up, because its whole purpose is reaching machines that are not this one.
 */

export {
  type CliBackendOptions,
  CliMissingError,
  type CliRunner,
  type CliRunResult,
  createCliBackend,
  type LocateCliDeps,
  locateCli,
  runCli,
} from './cli-backend.js';
export {
  describeHost,
  type HostDescription,
  type ReadTailnetOptions,
  readTailnet,
  type TailscaleExecOptions,
  tailscaleCliEnv,
} from './host.js';
export {
  createLocalApiClient,
  describeTarget,
  LOCALAPI_HOST,
  type LocalApiCallOptions,
  type LocalApiClient,
  type LocalApiResponse,
  type LocalApiTarget,
  type LocateLocalApiDeps,
  locateLocalApi,
  parseLsofSameUserProof,
  TAILSCALE_CAP_VERSION,
  WATCH_MASK,
} from './localapi.js';
export {
  describePing,
  type PingPath,
  type PingResult,
  parseGoDurationMs,
  parsePingJson,
  parsePingOutput,
  stripGoLogPrefix,
} from './ping-parse.js';
export {
  type BackendCallOptions,
  type BackendChoice,
  type ChooseBackendDeps,
  chooseBackend,
  createLocalApiBackend,
  createTailnetAdapter,
  LocalApiGoneError,
  NOT_INSTALLED_REASON,
  type TailnetAdapter,
  type TailnetAdapterDeps,
  type TailnetBackend,
  type WatchOptions,
} from './tailnet-backend.js';
export {
  buildHello,
  CLUSTER_HELLO_PATH,
  CLUSTER_INFO_PATH,
  CLUSTER_PORT,
  type GenModality,
  idString,
  NODE_PROTOCOL,
  type NodeHello,
  type NodeInfo,
  type NodeScopes,
  type PairingMode,
  type PeerProbe,
  type ProtocolCompat,
  parseHello,
  parseInfo,
  parseTailscaleJson,
  parseTailscaleStatus,
  peerUrl,
  probePeer,
  protocolCompat,
  sameUserPeers,
  TAILSCALE_PATHS,
  type TailnetPeer,
  type TailnetState,
  type TailnetStatus,
  type TailnetUser,
  timeField,
} from './tailscale.js';
export {
  type LineStreamConnect,
  notifyNeedsRefresh,
  type ReconnectOptions,
  runWithReconnect,
  sleep,
  statusDigest,
} from './watch.js';
export {
  createWhoisCache,
  parseWhois,
  type WhoisCache,
  type WhoisResult,
  whoisFailure,
  whoisKey,
} from './whois.js';
