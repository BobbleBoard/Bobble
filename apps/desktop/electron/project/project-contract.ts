/**
 * Project (working-folder) IPC contract. A "project" is just a named working
 * folder the app can scope pi's session cwd + the canvas file-tree root to. The
 * list + active id persist to `~/.pi/desktop/projects.json`. Composed into the
 * app-wide maps in ../ipc-contract.ts.
 */

/** One persisted project — a working folder with a stable id + display name. */
export interface ProjectEntry {
  /** Stable id (derived from the absolute path). */
  id: string;
  /** Display label (the folder's basename). */
  name: string;
  /** Absolute path of the working folder. */
  path: string;
  /**
   * FULL ACCESS — this project's model runs with no sandboxing at all.
   *
   * the user: "in projects, add a 'full access' mode — red, with an ! in a circle —
   * that gives the model full reign and full access: e.g. if it types in the
   * terminal it has access to have anything happen as if the user is typing in the
   * terminal, all homebrew packages, manipulate system stuff etc. No sandboxing."
   *
   * So it is exactly that: the write fence is not installed for a spawn in this
   * project, and the app's own write channel accepts any path. Off unless
   * deliberately switched on, per project, and the composer says so in red for
   * as long as it is on — this is not a setting anyone should be able to leave
   * on by accident.
   */
  fullAccess?: boolean;
}

export type ProjectInvokeMap = {
  /** Every known project + the active id (null = working outside a project).
   * `activeMissing` is true when an active project IS selected but its folder no
   * longer exists on disk. `usingSandbox` is true whenever there is NO valid
   * active project (none selected OR the selected one is gone) — pi then roots the
   * conversation at its per-conversation sandbox (electron/sandbox.ts), so the
   * composer folder chip reads "Sandbox"/"No project" (blind-test round-2 #2).
   *
   * STALE-CLEAR (round-2 #3): a persisted active project whose folder no longer
   * exists is cleared to none here (activeId → null) so a dead folder name is
   * never surfaced; the files panel then defaults to "No project selected". */
  'project:list': {
    request: undefined;
    response: {
      projects: ProjectEntry[];
      activeId: string | null;
      activeMissing: boolean;
      usingSandbox: boolean;
    };
  };
  /** Activate a project by id (or by adding/reusing a path). Returns the active
   * project (null when the id/path could not be resolved). `activeMissing` flags
   * that the active folder is gone from disk; `usingSandbox` flags no valid
   * active project (see `project:list`). */
  'project:set': {
    request: { id?: string; path?: string };
    response: {
      project: ProjectEntry | null;
      projects: ProjectEntry[];
      activeMissing: boolean;
      usingSandbox: boolean;
    };
  };
  /** Pick a folder (native dialog) → add + activate it. `project` is null when
   * the user cancelled the folder picker. */
  'project:new': {
    request: { path?: string } | undefined;
    response: {
      project: ProjectEntry | null;
      projects: ProjectEntry[];
      activeMissing: boolean;
      usingSandbox: boolean;
    };
  };
  /** Clear the active project ("Don't work in a project"). `usingSandbox` is then
   * always true (no project → sandbox). */
  'project:clear': {
    request: undefined;
    response: { projects: ProjectEntry[]; usingSandbox: boolean };
  };
  /** Turn FULL ACCESS on or off for a project (see `ProjectEntry.fullAccess`).
   * Takes effect on the next pi spawn, which is why the renderer restarts the
   * child after flipping it. */
  'project:set-full-access': {
    request: { id: string; fullAccess: boolean };
    response: { projects: ProjectEntry[]; project: ProjectEntry | null };
  };
  /** Native directory picker that ONLY returns the chosen path — it does NOT touch
   * projects.json (unlike `project:new`). Used to attach a working folder to a
   * sidebar chat-org project. `path` is null when the user cancelled. */
  'project:pick-folder': {
    request: undefined;
    response: { path: string | null };
  };
  /** Ensure (mkdir -p) and return a STABLE shared sandbox directory for a sidebar
   * chat-org project that has no working folder — `~/.pi/desktop/sandbox/project-<id>`.
   * All of that project's projectless chats root here, so they share files while the
   * user only ever sees the project name. */
  'project:project-sandbox': {
    request: { id: string };
    response: { path: string };
  };
  /**
   * THE workspace for a chat, resolved and created. `selected` is the composer
   * dropdown verbatim (absent = "No project" → ~/Bobble/<name>); `conversationId`
   * keeps two chats with the same generated title from sharing a folder.
   * `sessionFile` names the chat itself, so a chat reopened after a restart
   * (a new window, a new conversationId) gets its own folder back rather than a
   * `-2`; `resumed` says it already has a reply (it is reopened, not new).
   */
  'project:resolve-workspace': {
    request: {
      selected?: string;
      conversationName: string;
      conversationId?: string;
      sessionFile?: string;
      resumed?: boolean;
    };
    response: { path: string };
  };
};

export const PROJECT_INVOKE_CHANNELS = [
  'project:list',
  'project:set',
  'project:new',
  'project:clear',
  'project:set-full-access',
  'project:pick-folder',
  'project:project-sandbox',
  'project:resolve-workspace',
] as const satisfies readonly (keyof ProjectInvokeMap)[];
