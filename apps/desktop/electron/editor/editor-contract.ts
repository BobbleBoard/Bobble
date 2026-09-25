/**
 * Editor IPC contract — the studios as editors: documents, the version tree and editor ops.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). It is
 * already composed into the app-wide maps in ../ipc-contract.ts, so the EDIT
 * lane adds its `editor:*` channels HERE and their handlers in
 * ./editor-main.ts, and never edits the composition file (PLAN.md R1).
 * First filled by ED-01 (deliverables/research/studios-editors.md §4).
 *
 * Add a channel in three places, all in this file: the map, the channel list
 * (a compile error in ipc-contract.ts if one is missing), and — for a push from
 * main — the event map.
 */

/** Renderer → main request/response channels (`editor:<action>`). */
export type EditorInvokeMap = Record<never, never>;

/** Main → renderer pushes. */
export type EditorEventMap = Record<never, never>;

export const EDITOR_INVOKE_CHANNELS = [] as const satisfies readonly (keyof EditorInvokeMap)[];

export const EDITOR_EVENT_CHANNELS = [] as const satisfies readonly (keyof EditorEventMap)[];
