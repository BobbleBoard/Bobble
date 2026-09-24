/**
 * Devices — the renderer side's ONE start-up hook.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). Called
 * once, before the app mounts, by src/features.ts — so lane DEV registers
 * everything it adds to shared surfaces HERE, from its own file, and never
 * edits the surface (R1):
 *   - the "Sharing with N devices" pill and the remote wording —
 *     `registerTopBarNotice` (chat/topbar-notices.ts, DEV-7/DEV-8)
 *   - the Settings section is its own file (settings/sections/devices.tsx,
 *     DEV-7)
 *
 * The main-process twin is electron/devices/devices-main.ts. See
 * deliverables/research/devices-tailscale.md §4.13.
 */
export function registerDevicesFeature(): void {
  // Nothing yet.
}
