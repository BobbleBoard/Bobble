/**
 * Memory IPC contract — the Memory tab, the "Remembered N things" chip, Forget and the service state.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). It is
 * already composed into the app-wide maps in ../ipc-contract.ts, so the MEM
 * lane adds its `memory:*` channels HERE and their handlers in
 * ./memory-main.ts, and never edits the composition file (PLAN.md R1).
 * First filled by WP-M3b and WP-M7 (deliverables/research/hindsight-memory.md §4).
 *
 * Add a channel in three places, all in this file: the map, the channel list
 * (a compile error in ipc-contract.ts if one is missing), and — for a push from
 * main — the event map.
 */

/** Renderer → main request/response channels (`memory:<action>`). */
export type MemoryInvokeMap = Record<never, never>;

/** Main → renderer pushes. */
export type MemoryEventMap = Record<never, never>;

export const MEMORY_INVOKE_CHANNELS = [] as const satisfies readonly (keyof MemoryInvokeMap)[];

export const MEMORY_EVENT_CHANNELS = [] as const satisfies readonly (keyof MemoryEventMap)[];
