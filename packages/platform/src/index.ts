/**
 * @pi-desktop/platform — The portability layer: local IPC endpoints (Unix sockets / named pipes), spawnTracked with windowsHide, process list/tree/kill/suspend, venv and exe paths, zip/tar, links and junctions, support dirs, a bash for pi. Electron-free.
 *
 * Every new bridge or long-lived process uses this from W2 on (PLAN.md R9):
 * `localEndpoint`, `spawnTracked`, `venvPython`, `killTree`. Sweep A (XP-02b) moves the
 * old call sites here, and a grep test keeps raw `.sock`, `'bin','python'` and
 * `symlinkSync(` out of every other package.
 *
 * SKELETON. Created by the W0-A pre-wire so the workspace package, its lockfile
 * entry and its test runner exist before any lane forks (PLAN.md §2.3, R4).
 * Owned by lane PLAT (plat-b); first filled by XP-02a (W1), XP-02b (Sweep A). Add exports here as the
 * modules land.
 */
export {};
