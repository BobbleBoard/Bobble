/**
 * Training IPC contract — training runs: plan, start, pause, stop, export and the run history.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3). It is
 * already composed into the app-wide maps in ../ipc-contract.ts, so the TRAIN
 * lane adds its `train:*` channels HERE and their handlers in
 * ./training-main.ts, and never edits the composition file (PLAN.md R1).
 * First filled by TR-4 (deliverables/research/training.md §4).
 *
 * Add a channel in three places, all in this file: the map, the channel list
 * (a compile error in ipc-contract.ts if one is missing), and — for a push from
 * main — the event map.
 */

/** Renderer → main request/response channels (`train:<action>`). */
export type TrainingInvokeMap = Record<never, never>;

/** Main → renderer pushes. */
export type TrainingEventMap = Record<never, never>;

export const TRAINING_INVOKE_CHANNELS = [] as const satisfies readonly (keyof TrainingInvokeMap)[];

export const TRAINING_EVENT_CHANNELS = [] as const satisfies readonly (keyof TrainingEventMap)[];
