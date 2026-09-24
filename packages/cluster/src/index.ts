/**
 * The cluster seam: which machines exist, and what they can do.
 *
 * Deliberately small and platform-neutral. The app's other OS-touching code was
 * written for macOS and is being ported; this one starts where it means to end
 * up, because its whole purpose is reaching machines that are not this one.
 */

export {
  describeHost,
  type HostDescription,
  type ReadTailnetOptions,
  readTailnet,
  type TailscaleExecOptions,
  tailscaleCliEnv,
} from './host.js';
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
