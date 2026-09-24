/**
 * @pi-desktop/help-tools — The Bobble help pi extension: the settings assistant's five tools, its bridge client and its frozen prompt.
 *
 * Runs in the scoped help pi (electron/pi/pi-main.ts `createScopedPiBridge`, BH-6).
 * Its prompt is static per app version and platform and frozen for the session; the
 * budget is ≤ 7k chars of system prompt plus ≤ 3k chars of tools
 * (deliverables/research/bobble-help.md §4.9).
 *
 * SKELETON. Created by the W0-A pre-wire so the workspace package, its lockfile
 * entry and its test runner exist before any lane forks (PLAN.md §2.3, R4).
 * Owned by lane HELP; first filled by BH-5 (W1). Add exports here as the
 * modules land.
 */
export {};
