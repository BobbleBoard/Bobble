/**
 * @pi-desktop/memory — The memory pi extension: recalls what Bobble learned (Hindsight) as a note AFTER the user's message, hands finished turns to main's outbox, and registers the memory tools.
 *
 * Loaded by pi after the harness (electron/pi/extension-dirs.ts, WP-M6). Nothing per
 * turn ever goes into the system prompt: recall is a custom message after the user
 * text, so the frozen canonical prompt and its warm-up are untouched
 * (deliverables/research/hindsight-memory.md §4.3).
 *
 * SKELETON. Created by the W0-A pre-wire so the workspace package, its lockfile
 * entry and its test runner exist before any lane forks (PLAN.md §2.3, R4).
 * Owned by lane MEM; first filled by WP-M6 (W3). Add exports here as the
 * modules land.
 */
export {};
