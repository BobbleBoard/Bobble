/**
 * Help IPC contract — Bobble help: the help bridge, the help threads and the inline settings cards.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). It is
 * already composed into the app-wide maps in ../ipc-contract.ts, so the HELP
 * lane adds its `help:*` channels HERE and their handlers in
 * ./help-main.ts, and never edits the composition file (PLAN.md R1).
 * First filled by BH-4 (deliverables/research/bobble-help.md §4).
 *
 * Add a channel in three places, all in this file: the map, the channel list
 * (a compile error in ipc-contract.ts if one is missing), and — for a push from
 * main — the event map.
 */

/** Renderer → main request/response channels (`help:<action>`). */
export type HelpInvokeMap = Record<never, never>;

/** Main → renderer pushes. */
export type HelpEventMap = Record<never, never>;

export const HELP_INVOKE_CHANNELS = [] as const satisfies readonly (keyof HelpInvokeMap)[];

export const HELP_EVENT_CHANNELS = [] as const satisfies readonly (keyof HelpEventMap)[];
