/**
 * The cluster seam: which machines exist, and what they can do.
 *
 * Deliberately small and platform-neutral. The app's other OS-touching code was
 * written for macOS and is being ported; this one starts where it means to end
 * up, because its whole purpose is reaching machines that are not this one.
 */

export { describeHost, type ReadTailnetOptions, readTailnet } from './host.js';
export {
  CLUSTER_HELLO_PATH,
  CLUSTER_PORT,
  type PeerCapabilities,
  parseTailscaleStatus,
  peerUrl,
  probePeer,
  TAILSCALE_PATHS,
  type TailnetPeer,
  type TailnetStatus,
} from './tailscale.js';
