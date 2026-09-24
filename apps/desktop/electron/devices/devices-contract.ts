/**
 * Devices IPC contract — the tailnet, pairing, trusted devices and "Serve from".
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). It is
 * already composed into the app-wide maps in ../ipc-contract.ts, so the DEV
 * lane adds its `devices:*` channels HERE and their handlers in
 * ./devices-main.ts, and never edits the composition file (PLAN.md R1).
 * First filled by DEV-6 (deliverables/research/devices-tailscale.md §4).
 *
 * Add a channel in three places, all in this file: the map, the channel list
 * (a compile error in ipc-contract.ts if one is missing), and — for a push from
 * main — the event map.
 */

/** Renderer → main request/response channels (`devices:<action>`). */
export type DevicesInvokeMap = Record<never, never>;

/** Main → renderer pushes. */
export type DevicesEventMap = Record<never, never>;

export const DEVICES_INVOKE_CHANNELS = [] as const satisfies readonly (keyof DevicesInvokeMap)[];

export const DEVICES_EVENT_CHANNELS = [] as const satisfies readonly (keyof DevicesEventMap)[];
