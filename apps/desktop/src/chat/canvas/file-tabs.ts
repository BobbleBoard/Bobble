/**
 * Canvas FILE tabs (round-7). Two entry points share one set of helpers:
 *   - `useFileWriteCanvasRouting()` — watches the pi stream for file-writing
 *     tool calls (edit/write/patch + bash `>`/`>>`/`tee`) and opens a LIVE file
 *     tab per path: streaming while the write is in flight, finalized from disk
 *     on completion. Mounted alongside the artifact router in CanvasTabsPanel.
 *   - `openFileInCanvas()` — opens/focuses a file tab on demand (the file-tree
 *     panel's `onFileTreeSelect`), reading the file + its sibling tree from main.
 *
 * File content is read through the bounded `fs:read-file` IPC (size-capped,
 * binary-flagged); the file-tree panel is populated from `fs:list-tree`. Both
 * are best-effort — a failed read leaves whatever content we already showed.
 */
import {
  type Artifact,
  type CanvasController,
  type CanvasTabKind,
  type CanvasTabSpec,
  type EditAnimationPlan,
  type FileTreeNode,
  type OpenWithApp,
  planEditAnimation,
  useCanvasTabs,
} from '@pi-desktop/canvas';
import type { ChatMsg } from '@pi-desktop/engine';
import type { DiffFileData } from '@pi-desktop/ui';
import { useEffect, useReducer, useRef } from 'react';
import { usePiStore } from '../../state/pi-slice';
import { useProjectStore } from '../../state/project-store';
import { editDiffFile } from '../edit-diff';
import { useHarnessStatus } from '../harness-status';
import { pdFileUrl, previewKindForExt } from './file-preview';
import { basename, detectFileWrites, dirname, type EditHunk } from './file-writes';

/**
 * The file-tree root for a file tab: the active project's working folder (round-8
 * #15), else the session cwd, else the file's own directory. The label names the
 * top of the tree (the project / working folder).
 */
function treeRootFor(absPath: string, cwd: string | undefined): { root: string; label: string } {
  const root = useProjectStore.getState().activePath ?? cwd ?? dirname(absPath);
  return { root, label: basename(root) };
}

/** Stable upsert key for a file path → its canvas tab (open-or-focus by path). */
export function fileTabKey(absPath: string): string {
  return `file:${absPath}`;
}

/** Breadcrumb segments for the operation bar: relative to `cwd` when the file is
 * under it (so it reads "project / src / x.ts"), else the whole path. */
export function fileBreadcrumb(absPath: string, cwd: string | undefined): string[] {
  if (cwd && absPath.startsWith(`${cwd.replace(/\/+$/, '')}/`)) {
    const rel = absPath.slice(cwd.replace(/\/+$/, '').length + 1);
    const root = basename(cwd);
    return [root, ...rel.split(/[/\\]/).filter(Boolean)];
  }
  return absPath.split(/[/\\]/).filter(Boolean);
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
const HTML_EXT = new Set(['html', 'htm']);
const SVG_EXT = new Set(['svg']);

/**
 * The artifact content-kind for a file by extension — the RENDERABLE kinds
 * (markdown/html/svg) get their real kind so the canvas can offer a rendered↔raw
 * toggle (the user); everything else is `code` (raw source only). The raw view still
 * works for the renderable kinds — it reads `content.text` with `language` below,
 * so an html file's Raw tab is syntax-highlighted HTML and its Rendered tab is
 * the live frame.
 */
function fileContentKind(ext: string): 'markdown' | 'html' | 'svg' | 'code' {
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (HTML_EXT.has(ext)) return 'html';
  if (SVG_EXT.has(ext)) return 'svg';
  return 'code';
}

/** Extension → CodeMirror language id for the read-only code viewer. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  xml: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  md: 'markdown',
};

function extname(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

type ReadFileResult = {
  text: string | null;
  truncated: boolean;
  tooLarge: boolean;
  binary: boolean;
  bytes: number;
  /** Why `text` is null (fs:read-file): what the notice says. */
  reason?: 'missing' | 'not-allowed' | 'folder' | 'unreadable';
};

/** Build the file surface's Artifact from a bounded read result. Too-large /
 * binary files show a short note instead of the (missing) content. */
/**
 * What a tab shows when the file CANNOT be read.
 *
 * There was no such artifact, so an unreadable file opened a tab with nothing in
 * it — the user, on a report a subagent wrote and handed back: "it just shows up
 * blank in the canvas sidebar… it was unable to be read or clicked on or viewed
 * by me." A blank pane is the worst possible answer: it looks like an empty file,
 * so you go looking for a bug in whatever wrote it rather than at the path.
 *
 * Binary and too-large already explained themselves; this is the third case, and
 * it names the path it actually tried, because "not found" is only useful with
 * the string that was looked up.
 */
export function unreadableFileArtifact(
  absPath: string,
  reason: ReadFileResult['reason'] = 'missing',
): Artifact {
  const filename = basename(absPath);
  /*
   * WHAT HAPPENED, AND WHAT IS ALREADY BEING DONE ABOUT IT. The user (2026-10-08):
   * "'this file couldn't be found' (when clicking on a file that should very
   * much be there) … just can't exist anymore." Before this shows, the file
   * was looked for in the chat's folders by name (fs:locate) and opened there
   * if it was found; a missing file is still watched for a minute, and the tab
   * fills the moment it lands (findOrWatch). What is left says which case it
   * is, in words.
   */
  const text =
    reason === 'not-allowed'
      ? `macOS did not let Bobble read this file.\n\n${absPath}\n\n` +
        'Allow Bobble in System Settings › Privacy & Security › Files and Folders, then open it again.'
      : reason === 'folder'
        ? `That is a folder, not a file.\n\n${absPath}\n\nIts files are in the tree beside this.`
        : reason === 'unreadable'
          ? `This file could not be read just now.\n\n${absPath}\n\n` +
            'Another app may be holding it. It opens here as soon as it can be read.'
          : `Not where the chat said it is.\n\n${absPath}\n\n` +
            'Bobble looked through this chat’s folders and found nothing with that name. ' +
            'If it is still being written, it appears here the moment it lands.';
  return {
    id: fileTabKey(absPath),
    title: filename,
    filename,
    /*
     * A NOTICE, NOT A DOCUMENT. As `kind: 'text'` this sentence went into the
     * code editor — line numbers down the left, a Rendered|Raw toggle above —
     * and read as the file's contents. The `notice` kind renders it as what it
     * is: a message about the file, with the path it looked up in mono.
     */
    content: { kind: 'notice', text },
  };
}

/** The folders a chat's files can be in: where its tools ran and its project. */
function chatRoots(cwd: string | undefined): string[] {
  const st = usePiStore.getState();
  let workspace: string | undefined;
  try {
    workspace = (JSON.parse(st.extensionStatus.harness ?? '{}') as { workspaceRoot?: string })
      .workspaceRoot;
  } catch {
    workspace = undefined;
  }
  return [
    cwd,
    workspace,
    st.session?.cwd,
    useProjectStore.getState().activePath ?? undefined,
  ].filter((r): r is string => typeof r === 'string' && r !== '');
}

/** Where the file a turn named actually is (fs:locate), or null. */
export async function locateChatFile(absPath: string, cwd?: string): Promise<string | null> {
  return locateFile(absPath, cwd);
}

async function locateFile(absPath: string, cwd: string | undefined): Promise<string | null> {
  try {
    const res = await window.piDesktop.invoke('fs:locate', {
      path: absPath,
      roots: chatRoots(cwd),
    });
    return typeof res?.found === 'string' && res.found !== '' ? res.found : null;
  } catch {
    return null;
  }
}

/**
 * A FILE THAT DID NOT READ IS LOOKED FOR, THEN WAITED FOR. First by name in the
 * chat's folders (a path that missed by a folder, a `cd` before a redirect);
 * then the path itself, every 1.5 s for a minute — a file still being written
 * lands while the tab is open. `onFound` gets the first readable copy;
 * `stillWanted` lets a closed tab stop the watch.
 */
async function findOrWatch(
  absPath: string,
  cwd: string | undefined,
  onFound: (path: string, read: ReadFileResult) => void,
  stillWanted: () => boolean,
): Promise<void> {
  const found = await locateFile(absPath, cwd);
  if (found !== null && found !== absPath) {
    const read = await readFile(found);
    if (readHasContent(read)) {
      onFound(found, read);
      return;
    }
  }
  for (let i = 0; i < 40 && stillWanted(); i += 1) {
    await delay(1500);
    const read = await readFile(absPath);
    if (readHasContent(read)) {
      onFound(absPath, read);
      return;
    }
  }
}

export function fileArtifact(absPath: string, read: ReadFileResult): Artifact {
  const filename = basename(absPath);
  const ext = extname(filename);
  if (read.binary) {
    return {
      id: fileTabKey(absPath),
      title: filename,
      filename,
      content: { kind: 'text', text: `Binary file (${read.bytes} bytes). No preview.` },
    };
  }
  if (read.tooLarge) {
    return {
      id: fileTabKey(absPath),
      title: filename,
      filename,
      content: {
        kind: 'text',
        text: `File is ${read.bytes} bytes. Too large to preview live.\nOpen it with an external editor from the Open ▾ menu.`,
      },
    };
  }
  return {
    id: fileTabKey(absPath),
    title: filename,
    filename,
    content: {
      kind: fileContentKind(ext),
      text: read.text ?? '',
      language: LANGUAGE_BY_EXT[ext] ?? 'text',
    },
  };
}

/** A file artifact built from in-memory text (a whole-file write's args, or the
 * buffer a user just saved) — no disk round-trip. */
export function fileArtifactFromText(absPath: string, text: string): Artifact {
  return fileArtifact(absPath, {
    text,
    truncated: false,
    tooLarge: false,
    binary: false,
    bytes: text.length,
  });
}

/** An in-flight file artifact from content we already have (a whole-file write's
 * args), before the authoritative disk read lands. */
function hintArtifact(absPath: string, text: string): Artifact {
  return fileArtifactFromText(absPath, text);
}

/**
 * A single-file {@link DiffFileData} from a str_replace edit's old/new strings,
 * through the SAME {@link editDiffFile} the chain row uses so the canvas diff
 * and the chain-step diff can never disagree.
 *
 * It used to lay every line of `old_string` in as a deletion and every line of
 * `new_string` in as an addition, which made a one-word change look like a
 * wholesale destruction — see edit-diff.ts for why that read as a failure.
 * Absent sides still contribute nothing, so a hunk mid-stream (old known, new
 * still arriving) draws just the deletions and then grows the additions — the
 * live-follow. The header shows the filename (the operation-bar breadcrumb
 * already carries the full path).
 */
function buildEditDiff(absPath: string, edit: EditHunk, baseText?: string): DiffFileData[] {
  return [editDiffFile(basename(absPath), edit.oldText, edit.newText, { baseText })];
}

/** How a tab should show an edit: as the motion, or as the fallback diff. */
export type EditPresentation =
  | { kind: 'animate'; plan: EditAnimationPlan }
  | { kind: 'diff'; diff: DiffFileData[] };

/**
 * DECIDE HOW TO SHOW AN EDIT — the animation whenever it can be played, the old
 * diff only when it cannot.
 *
 * It can be played when we know two things: the file as it stood before the tool
 * ran, and where in it each hunk goes. The first comes from disk, read the
 * moment the call appears in the stream — which is while its arguments are still
 * arriving, so the bytes on disk are still the pre-edit ones. The second is
 * `planEditAnimation`, which refuses rather than guesses.
 *
 * Kept pure and exported so the fallback is a decision with a test, not a
 * side-effect buried in an effect.
 */
export function presentEdit(
  absPath: string,
  baseText: string | undefined,
  hunks: EditHunk[] | undefined,
  fallback: EditHunk,
): EditPresentation {
  if (baseText !== undefined && hunks !== undefined && hunks.length > 0) {
    const plan = planEditAnimation(
      baseText,
      hunks.map((h) => ({ oldText: h.oldText, newText: h.newText })),
    );
    if (plan !== null) return { kind: 'animate', plan };
  }
  return { kind: 'diff', diff: buildEditDiff(absPath, fallback, baseText) };
}

async function readFile(absPath: string): Promise<ReadFileResult | null> {
  try {
    return await window.piDesktop.invoke('fs:read-file', { path: absPath });
  } catch {
    return null;
  }
}

/**
 * True when a read carries something DISPLAYABLE: real text (an empty file reads
 * as `''`, which counts), or a binary / too-large NOTICE. A bare `{ text: null }`
 * means the file couldn't be read (missing / vanished / raced), which carries
 * nothing — callers must NOT overwrite already-shown content with it (round-
 * blindtest #10: a failed read was blanking the file surface).
 */
function readHasContent(read: ReadFileResult | null): read is ReadFileResult {
  return read !== null && (read.text !== null || read.binary || read.tooLarge);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read a file, retrying a few times while it momentarily reads as MISSING. A
 * just-written file can lag its tool result by a beat (buffered write / atomic
 * rename), and a single read that lands in that gap otherwise leaves the tab
 * blank forever (round-blindtest #10). Returns the first usable read, else the
 * last attempt (so callers can still clear `streaming`).
 */
async function readFileSettled(absPath: string, attempts = 3): Promise<ReadFileResult | null> {
  let last: ReadFileResult | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await readFile(absPath);
    if (readHasContent(last)) return last;
    if (attempt < attempts - 1) await delay(120 * (attempt + 1));
  }
  return last;
}

async function readTree(rootDir: string): Promise<FileTreeNode[]> {
  try {
    const res = await window.piDesktop.invoke('fs:list-tree', { root: rootDir });
    // FsTreeNode is a structural mirror of FileTreeNode.
    return res.tree as unknown as FileTreeNode[];
  } catch {
    return [];
  }
}

/** Base spec (kind/key/title/path/breadcrumb) for a file tab. Breadcrumb + tree
 * root follow the active project's working folder when set (round-8 #15/#6). */
function fileTabSpec(absPath: string, cwd: string | undefined): CanvasTabSpec {
  const { label } = treeRootFor(absPath, cwd);
  const base = useProjectStore.getState().activePath ?? cwd;
  return {
    kind: 'file',
    key: fileTabKey(absPath),
    title: basename(absPath),
    filePath: absPath,
    breadcrumb: fileBreadcrumb(absPath, base),
    fileTreeRootLabel: label,
  };
}

/** Spec for a binary MODALITY preview tab (image/video/audio/pdf/model/doc): a
 * media-style tab whose surface streams the file over `pd-file://`. It keeps the
 * same key/breadcrumb/tree-root as a file tab (so re-open focuses, and the
 * operation bar can still Open/Reveal the real file) and carries `filePath` for
 * that Open/Reveal targeting. `mediaType` picks the concrete renderer. */
function previewTabSpec(
  absPath: string,
  cwd: string | undefined,
  preview: { kind: CanvasTabKind; mediaType: string },
): CanvasTabSpec {
  const { label } = treeRootFor(absPath, cwd);
  const base = useProjectStore.getState().activePath ?? cwd;
  return {
    kind: preview.kind,
    key: fileTabKey(absPath),
    title: basename(absPath),
    filePath: absPath,
    breadcrumb: fileBreadcrumb(absPath, base),
    fileTreeRootLabel: label,
    mediaSrc: pdFileUrl(absPath),
    mediaType: preview.mediaType,
  };
}

/**
 * Fetch the system apps that can open this file (round-8 #14) and set the tab's
 * `defaultApp` + `openApps` so the "Open" split button shows the default's icon
 * and lists the rest. Lazy + best-effort.
 *
 * It runs under E2E too. It used to be skipped there ("slow + machine-specific
 * — probes inject apps directly"), which meant no probe ever clicked an app the
 * real list had put in the ▾; main caches the list per extension, and the card
 * beside the canvas was already asking for the same list under E2E.
 */
async function hydrateOpenApps(
  controller: CanvasController,
  key: string,
  absPath: string,
): Promise<void> {
  try {
    const res = await window.piDesktop.invoke('canvas:list-open-apps', { path: absPath });
    const tab = controller.getState().tabs.find((t) => t.key === key);
    if (tab === undefined) return;
    const apps = res.apps as OpenWithApp[];
    const defaultApp =
      res.defaultAppId !== null ? apps.find((a) => a.id === res.defaultAppId) : undefined;
    controller.updateTab(tab.id, { openApps: apps, ...(defaultApp ? { defaultApp } : {}) });
  } catch {
    // best-effort — the "Open" button still opens the OS default.
  }
}

/** Stable upsert key for the single full-canvas file-tree surface. */
const FILE_TREE_TAB_KEY = 'pi:files';

/**
 * Open (or focus) the full-canvas project FILE TREE surface (round-10 #4) — the
 * `+ › Files` entry point. Rooted at the active project's working folder (else
 * the session cwd); the tree is read from `fs:list-tree` and picking a file
 * routes through the tree's onSelect → `openFileInCanvas`. A stable key means
 * re-opening focuses the same surface instead of piling up (NOT a blank
 * "untitled" file, which was the bug).
 */
export async function openProjectFileTree(
  controller: CanvasController,
  cwd?: string,
): Promise<void> {
  const root = useProjectStore.getState().activePath ?? cwd ?? null;
  const label = root ? basename(root) : 'Files';
  controller.upsertTab(FILE_TREE_TAB_KEY, {
    kind: 'filetree',
    key: FILE_TREE_TAB_KEY,
    title: 'Files',
    fileTreeRootLabel: label,
  });
  if (root === null) return;
  const tree = await readTree(root);
  const tab = controller.getState().tabs.find((t) => t.key === FILE_TREE_TAB_KEY);
  if (tab) controller.updateTab(tab.id, { fileTree: tree });
}

/**
 * Open (or focus) a file tab and fill it from disk. Used by the file-tree
 * panel's select handler. Focuses the tab and un-collapses the canvas.
 */
export async function openFileInCanvas(
  controller: CanvasController,
  absPath: string,
  cwd?: string,
): Promise<void> {
  // A preview streams its bytes straight from disk, so a path that missed by a
  // folder would only ever say "failed to load": find it first.
  if (previewKindForExt(extname(basename(absPath))) !== null) {
    const found = await locateFile(absPath, cwd);
    if (found !== null) absPath = found;
  }
  const key = fileTabKey(absPath);
  const preview = previewKindForExt(extname(basename(absPath)));
  const existing = controller.getState().tabs.find((t) => t.key === key);
  if (existing) controller.focusTab(existing.id);
  else if (preview !== null) controller.upsertTab(key, previewTabSpec(absPath, cwd, preview));
  else controller.upsertTab(key, { ...fileTabSpec(absPath, cwd), streaming: false });

  const { root } = treeRootFor(absPath, cwd);
  if (preview !== null) {
    // A binary modality (image/video/audio/pdf/3D/doc): the surface streams the
    // bytes over `pd-file://` — there is NOTHING to read as text. Still populate
    // the file tree + the "Open with" app list in the background.
    const tree = await readTree(root);
    const tab = controller.getState().tabs.find((t) => t.key === key);
    if (tab !== undefined) controller.updateTab(tab.id, { fileTree: tree });
    void hydrateOpenApps(controller, key, absPath);
    return;
  }

  const [read, tree] = await Promise.all([readFileSettled(absPath), readTree(root)]);
  // Read before the content guard narrows `read` away.
  const failedWhy = (read as ReadFileResult | null)?.reason;
  const tab = controller.getState().tabs.find((t) => t.key === key);
  if (tab === undefined) return;
  controller.updateTab(tab.id, {
    streaming: false,
    fileTree: tree,
    // Opening a file explicitly shows its CONTENT — drop any live edit a
    // mid-stream call left on this tab (motion or fallback diff) so the user
    // sees the file on disk, not a hunk mid-flight.
    diff: undefined,
    editAnim: undefined,
    /*
     * Only replace content with a read that actually loaded — a missing/raced
     * read must never blank the surface (round-blindtest #10).
     *
     * …but a tab that has NOTHING yet and a read that failed is the blank pane:
     * the guard was protecting already-shown content and, in the empty case,
     * protecting nothing while showing nothing. Say why instead. A tab that
     * already has content keeps it, exactly as before.
     */
    ...(readHasContent(read)
      ? { artifact: fileArtifact(absPath, read) }
      : tab.artifact === undefined
        ? { artifact: unreadableFileArtifact(absPath, failedWhy) }
        : {}),
  });
  void hydrateOpenApps(controller, key, absPath);
  if (!readHasContent(read) && failedWhy !== 'folder') {
    const tabId = tab.id;
    void findOrWatch(
      absPath,
      cwd,
      (path, found) => {
        const now = controller.getState().tabs.find((t) => t.id === tabId);
        if (now === undefined) return;
        if (path === absPath) {
          controller.updateTab(tabId, { artifact: fileArtifact(absPath, found) });
          return;
        }
        // Found under another folder: open it there, in this tab's place —
        // the new tab first, so the canvas never reaches zero tabs and folds
        // away (SEEN: the found file opened into a closed canvas).
        void openFileInCanvas(controller, path, cwd).then(() => controller.closeTab(tabId));
      },
      () => controller.getState().tabs.some((t) => t.id === tabId),
    );
  }
}

/**
 * Watch the stream for file writes and mirror each into a live canvas file tab.
 * A path is opened once (a user-closed tab is not nagged back open); subsequent
 * writes to it refresh quietly. While a write runs, we show any whole-file
 * content hint from the tool args; on completion we read the authoritative bytes
 * from disk and drop `streaming`.
 */
export function useFileWriteCanvasRouting(): void {
  const { controller } = useCanvasTabs();
  const messages = usePiStore((s) => s.messages) as ChatMsg[];
  // The folder the TOOLS resolve a relative path against — the chat's working
  // folder, published by the harness — not pi's cwd, which can be its parent.
  const piCwd = usePiStore((s) => s.session?.cwd ?? undefined);
  const workspaceRoot = useHarnessStatus()?.workspaceRoot ?? null;
  const cwd = workspaceRoot ?? piCwd;

  const opened = useRef<Set<string>>(new Set());
  const finalized = useRef<Set<string>>(new Set());
  /*
   * PER-EDIT-CALL BOOKKEEPING for the edit animation.
   *
   * `base` is the file as it stood BEFORE the call ran, read from disk the first
   * time the call is seen — which is while its arguments are still streaming, so
   * the tool has not touched the file yet. That read is the whole reason the
   * animation can exist: without the prior text there is no file to delete out
   * of. `reading` marks it in flight so a failed read falls back to the diff
   * instead of hanging on a base that will never come; `staged` marks the
   * motion handed to the tab, so it is planned once and not re-planned (and
   * therefore not restarted) on every stream tick.
   */
  const editBase = useRef<Map<string, string>>(new Map());
  const editReading = useRef<Set<string>>(new Set());
  /*
   * ASKED ALREADY — separate from "still asking", and the difference matters.
   *
   * With only the in-flight set, a file that CANNOT be read span forever: the
   * read fails, clears the in-flight mark, nudges this pass, and the pass — not
   * having a base either — starts the read again. The tab never fell back to the
   * diff because the "is the base settled?" test was never true for one tick.
   */
  const editTried = useRef<Set<string>>(new Set());
  const editStaged = useRef<Set<string>>(new Set());
  // A base read can land after the LAST stream tick (a call whose result is
  // already in), and nothing else would re-run this effect to use it.
  const [baseTick, rerun] = useReducer((n: number) => n + 1, 0);

  // It carries no value; it exists purely to re-run this pass when a pre-edit
  // disk read lands after the last stream tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: baseTick is a nudge.
  useEffect(() => {
    for (const ev of detectFileWrites(messages, cwd)) {
      const key = fileTabKey(ev.path);

      // ── str_replace-style EDIT → THE FILE, then the edit played into it ─────
      // The user: "Editing a file shouldn't show the diff being written in real time
      // it should show that file and then the text as the negative part of the
      // diff is written being deleted … and then of course the replace part
      // writing animation."
      //
      // So: open the tab on the FILE while the arguments stream (nothing moves
      // yet — a half-arrived `old_string` would animate a delete of the wrong
      // text), and the moment the arguments are complete hand the tab a motion
      // to play. On completion it settles from disk, the same finalize the write
      // path does, so the tab stays a normal editable file view afterward.
      if (ev.edit !== undefined) {
        const existing = controller.getState().tabs.find((t) => t.key === key);

        if (existing === undefined) {
          if (!opened.current.has(key)) {
            opened.current.add(key);
            controller.upsertTab(key, { ...fileTabSpec(ev.path, cwd), streaming: ev.running });
            const { root } = treeRootFor(ev.path, cwd);
            void readTree(root).then((tree) => {
              const tab = controller.getState().tabs.find((t) => t.key === key);
              if (tab) controller.updateTab(tab.id, { fileTree: tree });
            });
            void hydrateOpenApps(controller, key, ev.path);
          }
          // else: the user closed this tab — don't nag it back open.
        }

        // Capture the pre-edit text once. A tab that already shows this file
        // settled has it in hand; otherwise go to disk (still pre-edit).
        if (!editBase.current.has(ev.callId) && !editTried.current.has(ev.callId)) {
          editTried.current.add(ev.callId);
          const shown = existing?.streaming === true ? undefined : existing?.artifact?.content.text;
          if (shown !== undefined) {
            editBase.current.set(ev.callId, shown);
          } else {
            editReading.current.add(ev.callId);
            void readFileSettled(ev.path).then((read) => {
              if (readHasContent(read) && read.text !== null) {
                editBase.current.set(ev.callId, read.text);
              }
              editReading.current.delete(ev.callId);
              rerun();
            });
          }
        }

        const base = editBase.current.get(ev.callId);
        const tab = controller.getState().tabs.find((t) => t.key === key);
        // Show the file itself while the arguments are still arriving.
        if (tab !== undefined && base !== undefined && tab.artifact === undefined) {
          controller.updateTab(tab.id, { artifact: fileArtifactFromText(ev.path, base) });
        }

        // `hunks` is set only once the call's arguments have finished arriving —
        // which is exactly when the motion can be planned honestly.
        const ready = ev.hunks !== undefined && !editReading.current.has(ev.callId);
        if (tab !== undefined && ready && !editStaged.current.has(ev.callId)) {
          editStaged.current.add(ev.callId);
          const shown = presentEdit(ev.path, base, ev.hunks, ev.edit);
          controller.updateTab(
            tab.id,
            shown.kind === 'animate'
              ? {
                  // The buffer starts as the file BEFORE the edit; the motion
                  // takes it from there to after.
                  artifact: fileArtifactFromText(ev.path, shown.plan.baseText),
                  editAnim: { id: ev.callId, plan: shown.plan, startedAt: Date.now() },
                  diff: undefined,
                  streaming: ev.running,
                }
              : { diff: shown.diff, editAnim: undefined, streaming: ev.running },
          );
        }

        // Finalize once from disk when the edit completes: the authoritative
        // on-disk bytes and no `streaming` (retried, since a fresh edit can lag
        // its result a beat — round-blindtest #10). `editAnim` is deliberately
        // LEFT in place: it carries its own start clock, so it settles rather
        // than replays, and clearing it mid-motion would cut the animation off.
        if (!ev.running && !finalized.current.has(ev.callId)) {
          finalized.current.add(ev.callId);
          void readFileSettled(ev.path).then((read) => {
            const settled = controller.getState().tabs.find((t) => t.key === key);
            if (settled === undefined) return;
            controller.updateTab(settled.id, {
              streaming: false,
              diff: undefined,
              ...(readHasContent(read) ? { artifact: fileArtifact(ev.path, read) } : {}),
            });
          });
        }
        continue;
      }

      const preview = previewKindForExt(extname(basename(ev.path)));
      const existing = controller.getState().tabs.find((t) => t.key === key);

      /*
       * THE WRITE WAS REFUSED: THERE IS NO FILE. The tab opened above while the
       * content streamed in, and left alone it outlives the refusal — first as
       * a frozen "streaming" view, then (once anything re-reads the path) as
       * "Could not read this file" set in a code editor with line numbers, as
       * if that sentence were the file's content (the user, 2026-09-17: "absolute
       * nonsense"). The thread's row keeps the content and says why it was
       * refused; the canvas closes the tab that was only ever a promise.
       */
      if (ev.failed === true) {
        if (
          existing !== undefined &&
          opened.current.has(key) &&
          !finalized.current.has(ev.callId)
        ) {
          finalized.current.add(ev.callId);
          controller.closeTab(existing.id);
        }
        continue;
      }

      if (preview !== null) {
        // A binary modality write (image/pdf/3D/doc): there's no partial text to
        // stream and fetching a half-written file would flash an error, so open
        // the preview tab only when the write COMPLETES. A user-closed tab is not
        // reopened; a later write to an already-open tab reloads the bytes via a
        // cache-busting `?v=` (the pathname is unchanged, so the fence still hits).
        if (existing === undefined && !ev.running && !opened.current.has(key)) {
          opened.current.add(key);
          controller.upsertTab(key, previewTabSpec(ev.path, cwd, preview));
          const { root } = treeRootFor(ev.path, cwd);
          void readTree(root).then((tree) => {
            const tab = controller.getState().tabs.find((t) => t.key === key);
            if (tab) controller.updateTab(tab.id, { fileTree: tree });
          });
          void hydrateOpenApps(controller, key, ev.path);
        } else if (existing !== undefined && !ev.running && !finalized.current.has(ev.callId)) {
          finalized.current.add(ev.callId);
          controller.updateTab(existing.id, {
            streaming: false,
            mediaSrc: `${pdFileUrl(ev.path)}?v=${encodeURIComponent(ev.callId)}`,
          });
        }
        continue;
      }

      if (existing === undefined) {
        // Open once per path; a tab the user closed is not reopened.
        if (opened.current.has(key)) continue;
        opened.current.add(key);
        controller.upsertTab(key, {
          ...fileTabSpec(ev.path, cwd),
          streaming: ev.running,
          ...(ev.contentHint !== undefined
            ? { artifact: hintArtifact(ev.path, ev.contentHint) }
            : {}),
        });
        // Populate the file-tree panel (rooted at the working folder) + the
        // "Open with" app list in the background.
        const { root } = treeRootFor(ev.path, cwd);
        void readTree(root).then((tree) => {
          const tab = controller.getState().tabs.find((t) => t.key === key);
          if (tab) controller.updateTab(tab.id, { fileTree: tree });
        });
        void hydrateOpenApps(controller, key, ev.path);
      } else {
        // Live refresh: reflect the running flag + any newer content hint.
        const patch: Record<string, unknown> = {};
        if (existing.streaming !== ev.running) patch.streaming = ev.running;
        if (
          ev.contentHint !== undefined &&
          existing.artifact?.content.text !== ev.contentHint &&
          ev.running
        ) {
          patch.artifact = hintArtifact(ev.path, ev.contentHint);
        }
        if (Object.keys(patch).length > 0) controller.updateTab(existing.id, patch);
      }

      // Finalize once from disk when the write completes. Always drop the
      // `streaming` flag; only REPLACE the shown content with a read that
      // actually loaded (retried, since a fresh write can lag a beat) so a
      // missing/raced read never blanks the tab (round-blindtest #10).
      if (!ev.running && !finalized.current.has(ev.callId)) {
        finalized.current.add(ev.callId);
        void readFileSettled(ev.path).then((read) => {
          const tab = controller.getState().tabs.find((t) => t.key === key);
          if (tab === undefined) return;
          controller.updateTab(tab.id, {
            streaming: false,
            // A whole-file write shows CONTENT — clear anything a prior edit to
            // this path left behind (its motion or its fallback diff), so the
            // written bytes are never masked.
            diff: undefined,
            editAnim: undefined,
            ...(readHasContent(read) ? { artifact: fileArtifact(ev.path, read) } : {}),
          });
        });
      }
    }
    // `baseTick` is the pre-edit read landing: it carries no data of its own,
    // it just re-runs this pass so the base that has now arrived is used.
  }, [messages, cwd, controller, baseTick]);
}

/**
 * Recover a file tab that became active while showing NOTHING — its first read
 * raced the write, or the file wasn't there yet — by re-reading from disk when
 * it gains focus and filling it once real content lands (round-blindtest #10:
 * "opened file → only line 1, no text"). Also picks up out-of-band changes when
 * the user revisits an empty tab.
 *
 * Deliberately scoped to EMPTY tabs (no artifact, or empty text) and never fires
 * while `streaming`, so it can NEVER clobber a populated tab's unsaved in-editor
 * edits — a populated tab is left exactly as the user last saw it.
 */
export function useFileTabRefresh(): void {
  const { controller, activeTabId, tabs } = useCanvasTabs();
  const active = tabs.find((t) => t.id === activeTabId);
  const filePath = active?.kind === 'file' ? active.filePath : undefined;
  const needsLoad =
    active?.kind === 'file' &&
    active.streaming !== true &&
    (active.artifact === undefined || active.artifact.content.text === '');

  useEffect(() => {
    if (filePath === undefined || !needsLoad) return;
    let cancelled = false;
    void readFileSettled(filePath).then((read) => {
      // Only fill when there's REAL text to show — an empty read leaves the
      // (already empty) tab untouched, and a still-missing read never blanks it.
      if (cancelled || !readHasContent(read) || read.text === null || read.text === '') return;
      const tab = controller.getState().tabs.find((t) => t.key === fileTabKey(filePath));
      if (tab !== undefined && tab.streaming !== true) {
        controller.updateTab(tab.id, { artifact: fileArtifact(filePath, read) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, needsLoad, controller]);
}
