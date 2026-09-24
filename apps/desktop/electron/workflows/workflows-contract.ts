/**
 * Workflows IPC contract — saved workflows, their runs and the run cards.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). It is
 * already composed into the app-wide maps in ../ipc-contract.ts, so the WF
 * lane adds its `workflows:*` channels HERE and their handlers in
 * ./workflows-main.ts, and never edits the composition file (PLAN.md R1).
 * First filled by WF-02 (deliverables/research/workflows.md §4).
 *
 * Add a channel in three places, all in this file: the map, the channel list
 * (a compile error in ipc-contract.ts if one is missing), and — for a push from
 * main — the event map.
 */

/** Renderer → main request/response channels (`workflows:<action>`). */
export type WorkflowsInvokeMap = Record<never, never>;

/** Main → renderer pushes. */
export type WorkflowsEventMap = Record<never, never>;

export const WORKFLOWS_INVOKE_CHANNELS =
  [] as const satisfies readonly (keyof WorkflowsInvokeMap)[];

export const WORKFLOWS_EVENT_CHANNELS = [] as const satisfies readonly (keyof WorkflowsEventMap)[];
