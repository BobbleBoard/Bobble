/**
 * Chat organization — projects, pins, per-chat renames, and delete (B1/B2).
 *
 * State lives in DesktopSettings.chatOrg (persisted, keyed by session FILE path so
 * nothing touches the read-only session JSONL). Every mutator read-modify-writes
 * the whole `chatOrg` through settings-store.update; the sidebar reads the live
 * value via {@link useChatOrg} and groups the flat session list with {@link groupChats}.
 */
import type { SessionSummary } from '../../electron/ipc-contract';
import type { ChatOrganization, ChatProject } from '../../electron/settings/settings-contract';
import { isSandboxCwd } from '../chat/composer-bar-logic';
import { useSettingsStore } from './settings-store';

const EMPTY: ChatOrganization = { projects: [], assignments: {}, pinned: [], titles: {} };

/** Reactive: the live chat-organization state. */
export function useChatOrg(): ChatOrganization {
  return useSettingsStore((s) => s.settings.chatOrg) ?? EMPTY;
}

function current(): ChatOrganization {
  return useSettingsStore.getState().settings.chatOrg ?? EMPTY;
}

function write(next: ChatOrganization): Promise<void> {
  return useSettingsStore.getState().update({ chatOrg: next });
}

function newId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a project and return its id. */
export async function createProject(name: string): Promise<string> {
  const id = `proj-${newId()}`;
  const c = current();
  await write({
    ...c,
    projects: [...c.projects, { id, name: name.trim() || 'New project' }],
  });
  return id;
}

/** Attach (or clear, with null) a working folder to a project. New chats created
 * in it root there; cleared → the project's shared sandbox (see SessionSidebar
 * newChatInProject + project:project-sandbox). */
export async function setProjectCwd(id: string, cwd: string | null): Promise<void> {
  const c = current();
  await write({
    ...c,
    projects: c.projects.map((p) => {
      if (p.id !== id) return p;
      if (cwd === null || cwd.trim().length === 0) {
        const { cwd: _drop, ...rest } = p;
        return rest;
      }
      return { ...p, cwd: cwd.trim() };
    }),
  });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const c = current();
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  await write({
    ...c,
    projects: c.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
  });
}

/** Delete a project (its chats fall back to ungrouped — the chats themselves stay). */
export async function deleteProject(id: string): Promise<void> {
  const c = current();
  const assignments = { ...c.assignments };
  for (const [file, pid] of Object.entries(assignments)) {
    if (pid === id) delete assignments[file];
  }
  await write({ ...c, projects: c.projects.filter((p) => p.id !== id), assignments });
}

/** Assign a chat to a project, or pass null to un-assign (→ ungrouped). */
export async function assignChat(file: string, projectId: string | null): Promise<void> {
  const c = current();
  const assignments = { ...c.assignments };
  if (projectId === null) delete assignments[file];
  else assignments[file] = projectId;
  await write({ ...c, assignments });
}

/** Toggle a chat's pinned state. */
export async function togglePin(file: string): Promise<void> {
  const c = current();
  const pinned = c.pinned.includes(file) ? c.pinned.filter((f) => f !== file) : [...c.pinned, file];
  await write({ ...c, pinned });
}

/** Rename a chat (empty clears the override → falls back to the derived title). */
export async function renameChat(file: string, title: string): Promise<void> {
  const c = current();
  const titles = { ...c.titles };
  const trimmed = title.trim();
  if (trimmed.length === 0) delete titles[file];
  else titles[file] = trimmed;
  await write({ ...c, titles });
}

/** Forget everything this app tracked about a chat file (called after delete). */
export async function forgetChat(file: string): Promise<void> {
  const c = current();
  const assignments = { ...c.assignments };
  const titles = { ...c.titles };
  delete assignments[file];
  delete titles[file];
  await write({ ...c, assignments, titles, pinned: c.pinned.filter((f) => f !== file) });
}

/**
 * Delete a chat: remove its session file from disk AND forget its org state.
 * Returns the IPC result so the caller can surface a failure.
 */
export async function deleteChat(file: string): Promise<{ ok: boolean; error?: string }> {
  const res = await window.piDesktop.invoke('fs:delete-session', { file });
  if (res.ok) await forgetChat(file);
  return res;
}

/** The user rename for a chat, if any (overrides the derived title). */
export function displayTitle(summary: SessionSummary, org: ChatOrganization): string {
  return org.titles[summary.file] ?? summary.title;
}

/** Prefix marking a DERIVED (per-working-directory) project id, so the UI can tell
 * an auto folder from a user-made one (auto folders skip the rename/delete menu —
 * they re-derive from the folder). The remainder of the id is the raw cwd. */
export const AUTO_PROJECT_PREFIX = 'cwd:';

export interface ProjectGroup {
  project: ChatProject;
  chats: SessionSummary[];
  /** True for a directory-derived folder (not a user-created project). */
  auto: boolean;
}

export interface GroupedChats {
  projects: ProjectGroup[];
  /** Chats in no folder: sandbox / unknown-cwd chats (unless manually assigned). */
  ungrouped: SessionSummary[];
}

/** Pinned chats float to the top of their container; order is otherwise preserved. */
function pinnedFirst(chats: SessionSummary[], pinned: Set<string>): SessionSummary[] {
  if (pinned.size === 0) return chats;
  const pin: SessionSummary[] = [];
  const rest: SessionSummary[] = [];
  for (const c of chats) (pinned.has(c.file) ? pin : rest).push(c);
  return [...pin, ...rest];
}

/**
 * Folder name for a directory-derived project — the cwd's last path segment.
 *
 * A folder Bobble made for a projectless chat (`~/Bobble/<slug>`) is shown with
 * SPACES, because the slug is a filesystem detail and the name is the chat's.
 * the user: "the dropdown should still show spaces rather than dashes or whatever
 * you're using as replacement." Scoped to ~/Bobble so a user's own hyphenated
 * directory elsewhere keeps the name they gave it.
 */
function folderName(s: SessionSummary): string {
  const label = (s.cwdLabel || s.cwd || '').replace(/\/+$/, '');
  const base = label.split('/').pop() ?? label;
  const name = base.length > 0 ? base : label;
  return /\/Bobble\/[^/]+$/.test(label) ? name.replace(/-/g, ' ') : name;
}

/**
 * Partition the flat session list into folders + ungrouped:
 *   - a MANUAL assignment wins (chat sits in that user-made project);
 *   - else a chat in a real working directory is AUTO-grouped into a folder for
 *     that directory (created on the fly, named by the folder's last segment);
 *   - else (sandbox / unknown cwd) it stays ungrouped.
 * Manual projects render first (their saved order); auto folders follow, sorted
 * by most-recent activity. Pinned chats float to the top of every container.
 */
export function groupChats(sessions: SessionSummary[], org: ChatOrganization): GroupedChats {
  const pinned = new Set(org.pinned);
  const known = new Set(org.projects.map((p) => p.id));
  const byManual = new Map<string, SessionSummary[]>();
  const byCwd = new Map<string, { name: string; chats: SessionSummary[]; recent: string }>();
  const ungrouped: SessionSummary[] = [];

  for (const s of sessions) {
    const pid = org.assignments[s.file];
    if (pid !== undefined && known.has(pid)) {
      const arr = byManual.get(pid);
      if (arr === undefined) byManual.set(pid, [s]);
      else arr.push(s);
    } else {
      /*
       * A WORKING FOLDER IS NOT A PROJECT. the user: "not every working directory
       * folder becomes a project… projects can now only be created when
       * explicitly done so."
       *
       * Every cwd used to sprout its own folder, so the sidebar filled with
       * run5/run6/run7/corp-probe2… — one folder per experiment, none of them
       * asked for. A project is a thing the user decides to make; unassigned
       * chats simply sit in the list. `byCwd` survives only to COUNT chats per
       * folder, which is what offers the prompt at the third one.
       */
      const key = s.cwd;
      const g = byCwd.get(key);
      if (g === undefined) {
        byCwd.set(key, { name: folderName(s), chats: [s], recent: s.modifiedAt });
      } else {
        g.chats.push(s);
        if (s.modifiedAt > g.recent) g.recent = s.modifiedAt;
      }
      ungrouped.push(s);
    }
  }

  const manual: ProjectGroup[] = org.projects.map((project) => ({
    project,
    chats: pinnedFirst(byManual.get(project.id) ?? [], pinned),
    auto: false,
  }));
  return { projects: manual, ungrouped: pinnedFirst(ungrouped, pinned) };
}

/** Chats in one working folder before we OFFER to make it a project. */
export const PROJECT_PROMPT_AT = 3;

/**
 * Should we offer to make this working folder a project, right now?
 *
 * the user: "the user gets a popup to 'create project' when they make their third
 * chat in the same working directory (excluding no project). not after or
 * before the third time." So this is true on EXACTLY the third — asking at one
 * is noise, and asking at every one after three is nagging.
 *
 * Never for the sandbox (no folder was chosen), and never once the folder
 * already has a project the chats are assigned to.
 */
export function shouldOfferProject(
  sessions: readonly SessionSummary[],
  cwd: string,
  org: ChatOrganization,
): boolean {
  if (isSandboxCwd(cwd)) return false;
  const inFolder = sessions.filter((s) => s.cwd === cwd);
  if (inFolder.length !== PROJECT_PROMPT_AT) return false;
  const known = new Set(org.projects.map((p) => p.id));
  return !inFolder.some((s) => {
    const pid = org.assignments[s.file];
    return pid !== undefined && known.has(pid);
  });
}
