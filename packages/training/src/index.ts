/**
 * @pi-desktop/training — Training, pure core: protocol, config, model defaults, capabilities, fit, metrics, dataset format, runs and export plan. The bobble_train Python worker lives under python/.
 *
 * Pure TypeScript (vitest); the process side is electron/training/* (TR-4). The
 * Python worker, the shared Qwen3.5 renderer (LR-08) and the export scripts live in
 * `python/` — one uv project whose pins both TRAIN and LORA use
 * (deliverables/research/training.md §4).
 *
 * SKELETON. Created by the W0-A pre-wire so the workspace package, its lockfile
 * entry and its test runner exist before any lane forks (PLAN.md §2.3, R4).
 * Owned by lane TRAIN; first filled by TR-1 (W1); python/ by TR-2 and LR-08. Add exports here as the
 * modules land.
 */
export {};
