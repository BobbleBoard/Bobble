/**
 * Read-only filesystem IPC handlers backing the composer @-mention picker and
 * the session sidebar. Everything here is read-only by design: session
 * mutations always go through the pi RPC bridge so the app never drifts from
 * pi's own on-disk format. Logic (cwd encode/decode double-dash quirk, session
 * summary parsing, fuzzy listFiles) is ported from RemotePi's fs-handlers.ts.
 *
 * Registered in main.ts via registerIpcHandlers with the same trusted-sender
 * gate as the other app channels — these read arbitrary project files, so only
 * the main frame of an app-created window may reach them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dialog } from 'electron';
import type { FsInvokeMap, FsTreeNode, SessionSummary } from './ipc-contract';
import { sandboxBaseDir } from './sandbox';
import { renderSessionMarkdown } from './session-export';

const HOME = os.homedir();

/**
 * `~` EXPANDED BEFORE ANYTHING RESOLVES IT. The fourth door this has come
 * through.
 *
 * The model writes `~/proj/app.py` constantly. `path.resolve('~/proj/app.py')`
 * does NOT expand it — it produces `<cwd>/~/proj/app.py`, a path that cannot
 * exist. Every caller here then treats that as "no such file" and returns its
 * empty answer, which is indistinguishable from an empty file:
 *
 *   - run G: the canvas opened `~/bobble-testbed/buggyapp/app.py` and rendered
 *     a blank editor — line 1, nothing — while the file had 38 lines on disk;
 *   - `present` stat'd a literal `~` and drew a row with no card under it;
 *   - the syntax check ran `py_compile` on a quoted `~` and checked nothing,
 *     silently, for a whole session.
 *
 * Expansion happens BEFORE the sessions-dir and workspace fences, never after,
 * so a fence still judges the real path.
 */
function resolveUserPath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return HOME;
  if (trimmed.startsWith('~/') || trimmed.startsWith(`~${path.sep}`)) {
    return path.resolve(path.join(HOME, trimmed.slice(2)));
  }
  return path.resolve(trimmed);
}
const AGENT_DIR = path.join(HOME, '.pi', 'agent');
const SESSIONS_DIR = path.join(AGENT_DIR, 'sessions');
const PROJECTS_PATH = path.join(HOME, '.pi', 'desktop', 'projects.json');

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Inverse of pi's cwd→folder encoding; strips the trailing slash so it matches
 * the cwd recorded inside session JSONL (RemotePi's double-dash quirk). */
function decodeCwd(folder: string): string {
  if (!folder.startsWith('-') || !folder.endsWith('-')) return folder;
  let s = folder.slice(1, -1).replace(/-/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function normalizeCwd(p: string): string {
  if (!p) return p;
  let s = p.trim();
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * SEARCH THE WORDS, NOT JUST THE TITLE.
 *
 * The sidebar filtered on `displayTitle`, which is the first user message cut
 * to 80 characters — so the chat you remember by what was SAID in it was
 * exactly the one you could not find. This loop already reads every byte of
 * every session and keeps two fields; it now also collects the message text so
 * a query can be matched against it. No index, no second pass over the disk.
 *
 * CACHED BY (path, mtime), because without it every keystroke re-reads every
 * session file on a synchronous main-process handler. An entry is invalidated
 * the moment the file is written, which is what an append does.
 */
interface SessionCacheEntry {
  readonly mtimeMs: number;
  readonly summary: SessionSummary;
  /** Lowercased message text, for matching. Capped — see SEARCH_TEXT_CAP. */
  readonly haystack: string;
}

/**
 * How much of a conversation is searchable.
 *
 * A long corp run can be megabytes, and holding all of it for every session
 * would trade a disk read for a memory leak. 256 KB is far past any hand-typed
 * conversation and bounds the cache at a few tens of MB across a large history.
 */
const SEARCH_TEXT_CAP = 256 * 1024;

/** Sessions kept in the cache. Oldest-inserted is dropped past this. */
const SESSION_CACHE_MAX = 400;

const sessionCache = new Map<string, SessionCacheEntry>();

function cacheSession(file: string, entry: SessionCacheEntry): void {
  sessionCache.delete(file);
  sessionCache.set(file, entry);
  if (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next();
    if (!oldest.done) sessionCache.delete(oldest.value);
  }
}

/** A ±80-character window around the first hit, with the edges marked. */
export function excerptAround(haystack: string, original: string, needle: string): string | null {
  const at = haystack.indexOf(needle);
  if (at === -1) return null;
  const start = Math.max(0, at - 80);
  const end = Math.min(original.length, at + needle.length + 80);
  const body = original.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < original.length ? '…' : ''}`;
}

function readSessionSummary(file: string): SessionSummary | null {
  const st = statSafe(file);
  if (st === null) return null;
  const cached = sessionCache.get(file);
  if (cached !== undefined && cached.mtimeMs === st.mtimeMs) return { ...cached.summary };
  const txt = safeRead(file);
  if (txt === null) return null;

  let id = '';
  let cwd = '';
  let startedAt = '';
  let messageCount = 0;
  let firstUserText: string | null = null;
  const searchable: string[] = [];
  let searchableLength = 0;
  const collect = (value: unknown): void => {
    if (typeof value !== 'string' || value === '' || searchableLength >= SEARCH_TEXT_CAP) return;
    searchable.push(value);
    searchableLength += value.length + 1;
  };

  for (const line of txt.split('\n')) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === 'session') {
      id = typeof obj.id === 'string' ? obj.id : '';
      cwd = typeof obj.cwd === 'string' ? obj.cwd : '';
      startedAt = typeof obj.timestamp === 'string' ? obj.timestamp : '';
      continue;
    }
    // Newer sessions wrap messages: { type: 'message', message: { role, content } }.
    const msg = (obj.type === 'message' && obj.message !== undefined ? obj.message : obj) as Record<
      string,
      unknown
    >;
    const role = (msg.role ?? obj.role) as string | undefined;
    if (role !== 'user' && role !== 'assistant') continue;
    messageCount++;
    const content = msg.content ?? obj.content;
    // Both sides are searchable — half the value is finding a chat by something
    // the ASSISTANT said, which no title could ever carry.
    if (typeof content === 'string') collect(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if ((part as { type?: string })?.type === 'text') collect((part as { text?: string }).text);
      }
    }
    if (role === 'user' && firstUserText === null) {
      if (typeof content === 'string') firstUserText = content;
      else if (Array.isArray(content)) {
        const first = content.find((x) => (x as { type?: string })?.type === 'text') as
          | { text?: string }
          | undefined;
        if (typeof first?.text === 'string') firstUserText = first.text;
      }
    }
  }

  const title = firstUserText
    ? firstUserText.slice(0, 80).replace(/\s+/g, ' ').trim()
    : 'Untitled session';

  const summary: SessionSummary = {
    file,
    id,
    cwd,
    cwdLabel: cwd.replace(HOME, '~'),
    startedAt: startedAt || st.birthtime.toISOString(),
    modifiedAt: st.mtime.toISOString(),
    messageCount,
    firstUserText,
    title,
  };
  cacheSession(file, {
    mtimeMs: st.mtimeMs,
    summary,
    haystack: searchable.join('\n'),
  });
  return { ...summary };
}

/** The searchable body for a session, reading (and caching) it if needed. */
function sessionHaystack(file: string): string {
  const cached = sessionCache.get(file);
  if (cached !== undefined) return cached.haystack;
  readSessionSummary(file);
  return sessionCache.get(file)?.haystack ?? '';
}

function listAllSessions(filterCwd?: string, query?: string): SessionSummary[] {
  const needle = (query ?? '').trim().toLowerCase();
  const wantCwd = filterCwd ? normalizeCwd(filterCwd) : undefined;
  const out: SessionSummary[] = [];
  for (const p of listDir(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, p);
    if (statSafe(dir)?.isDirectory() !== true) continue;
    for (const f of listDir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const summary = readSessionSummary(path.join(dir, f));
      if (summary === null) continue;
      if (!summary.cwd) summary.cwd = decodeCwd(p);
      summary.cwd = normalizeCwd(summary.cwd);
      if (!summary.cwdLabel) summary.cwdLabel = summary.cwd.replace(HOME, '~');
      if (wantCwd !== undefined && summary.cwd !== wantCwd) continue;
      if (needle !== '') {
        // The title is matched in the RENDERER (it knows about renames, which
        // main does not), so a title hit is not decided here — only whether the
        // body contains it, and if so, where.
        const haystack = sessionHaystack(summary.file);
        const excerpt = excerptAround(haystack.toLowerCase(), haystack, needle);
        if (excerpt !== null) summary.match = { excerpt };
      }
      out.push(summary);
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  const base = haystack.split('/').pop() ?? haystack;
  if (base.startsWith(needle)) return 100;
  if (base.includes(needle)) return 80;
  if (haystack.includes(needle)) return 60;
  let i = 0;
  for (const c of haystack) {
    if (c === needle[i]) i++;
    if (i === needle.length) break;
  }
  return i === needle.length ? 30 + (needle.length / haystack.length) * 20 : 0;
}

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'out',
  '.next',
  '.turbo',
  '.vscode',
  '.idea',
  'build',
  '.pi',
  'Library',
  '.cache',
  '.npm',
]);

/** Fuzzy file listing for the composer @-mention autocomplete. Hard depth/count
 * caps keep this from ever recursing into node_modules et al. */
/** How deep the `@` picker looks, and how many files it will consider. */
const LIST_MAX_DEPTH = 3;
const LIST_MAX_ENTRIES = 600;

/**
 * Files for the composer's `@` picker.
 *
 * BREADTH-FIRST, and that is the fix rather than a preference. The walk was
 * depth-first under a 600-entry budget, so the first big subtree spent it and
 * everything after was simply invisible. MEASURED on this repo at the shipped
 * settings: an empty `@` collected 618 entries and `scripts/` and `tools/` did
 * not appear at all — not ranked low, absent. Level by level, every top-level
 * directory is represented before any one of them goes deep.
 *
 * Synchronous on the main process, so the budget is a real cost bound, not a
 * formality; the renderer debounces on top of it.
 */
function listFiles(cwd: string, query: string, limit = 30): Array<{ path: string; rel: string }> {
  const expanded = cwd ? resolveUserPath(cwd) : '';
  const root = expanded && statSafe(expanded)?.isDirectory() === true ? expanded : HOME;
  const out: Array<{ path: string; rel: string; score: number }> = [];
  const q = query.toLowerCase();

  let frontier: string[] = [root];
  for (let depth = 0; depth <= LIST_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (out.length >= LIST_MAX_ENTRIES) break;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          next.push(full);
          continue;
        }
        if (!e.isFile() || out.length >= LIST_MAX_ENTRIES) continue;
        const rel = path.relative(root, full);
        const score = fuzzyScore(rel.toLowerCase(), q);
        if (q === '' || score > 0) out.push({ path: full, rel, score });
      }
    }
    frontier = next;
  }
  out.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  return out.slice(0, limit).map(({ path: p, rel }) => ({ path: p, rel }));
}

/** Reads a session JSONL, but only within the pi sessions dir — the renderer is
 * trusted, yet this is the one channel that returns raw file contents by path,
 * so it is fenced to where sessions actually live. */
function readSession(file: string): string | null {
  const resolved = resolveUserPath(file);
  if (resolved !== SESSIONS_DIR && !resolved.startsWith(SESSIONS_DIR + path.sep)) return null;
  return safeRead(resolved);
}

/** Delete a session JSONL, fenced to the sessions dir (the sidebar "Delete chat"
 * action). Only `.jsonl` files under SESSIONS_DIR are eligible. */
function deleteSession(file: string): { ok: boolean; error?: string } {
  const resolved = resolveUserPath(file);
  if (!resolved.startsWith(SESSIONS_DIR + path.sep) || !resolved.endsWith('.jsonl')) {
    return { ok: false, error: 'refused: not a session file' };
  }
  try {
    fs.rmSync(resolved, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Which instruction files this working directory actually loads.
 *
 * Uses pi's OWN `loadProjectContextFiles` rather than walking for AGENTS.md
 * here: a second implementation could disagree with the one that really loaded,
 * and a list that is subtly wrong about what the model was told is worse than
 * no list.
 *
 * Sizes, not contents — the point is "these are in effect, here is where they
 * live", and the app can already open a path.
 */
async function projectInstructions(cwd: string): Promise<{
  files: Array<{ path: string; label: string; bytes: number }>;
}> {
  const resolved = cwd ? resolveUserPath(cwd) : '';
  if (resolved === '' || statSafe(resolved)?.isDirectory() !== true) return { files: [] };
  try {
    /*
     * DYNAMIC IMPORT, not a static one. `@mariozechner/pi-coding-agent` is
     * ESM-only and this bundle is CJS, so a static value import compiles to
     * `require()` and kills main at boot — no window, no error the user can
     * see. The same trap role-agent.ts documents on `loadPi`; this handler is
     * the one place in fs-handlers that needs the SDK, so it loads it here.
     */
    const { loadProjectContextFiles } = await import('@mariozechner/pi-coding-agent');
    return {
      files: loadProjectContextFiles({ cwd: resolved, agentDir: AGENT_DIR }).map((f) => ({
        path: f.path,
        label: f.path.replace(HOME, '~'),
        bytes: Buffer.byteLength(f.content, 'utf8'),
      })),
    };
  } catch {
    return { files: [] };
  }
}

/**
 * Export a chat to disk, or hand its text back for the clipboard.
 *
 * Fenced exactly like `deleteSession` — the source must be a session JSONL —
 * because the request carries a path from the renderer and "read any file the
 * user names and save it wherever" is not what this is for.
 *
 * A CANCELLED DIALOG IS NOT A FAILURE. It returns `ok:false` with no `error`,
 * so a caller that shows every failure as a toast does not tell someone who
 * changed their mind that the export broke.
 */
function exportSession(req: {
  file: string;
  format: 'markdown' | 'jsonl';
  title: string;
  to: 'file' | 'clipboard';
}): { ok: boolean; savedTo?: string; text?: string; error?: string } {
  const resolved = resolveUserPath(req.file);
  if (!resolved.startsWith(SESSIONS_DIR + path.sep) || !resolved.endsWith('.jsonl')) {
    return { ok: false, error: 'refused: not a session file' };
  }
  const jsonl = safeRead(resolved);
  if (jsonl === null) return { ok: false, error: 'that chat could not be read' };
  const text = req.format === 'jsonl' ? jsonl : renderSessionMarkdown(jsonl, req.title);
  if (req.to === 'clipboard') return { ok: true, text };

  const safeTitle =
    req.title
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'chat';
  /* Sync, like every other handler in this file. A save dialog is modal to the
     user anyway, so there is nothing to keep responsive behind it, and the
     alternative makes every caller of this map await. */
  const filePath = dialog.showSaveDialogSync({
    defaultPath: `${safeTitle}.${req.format === 'jsonl' ? 'jsonl' : 'md'}`,
  });
  if (filePath === undefined) return { ok: false };
  try {
    fs.writeFileSync(filePath, text, 'utf8');
    return { ok: true, savedTo: filePath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Bounded directory tree for the canvas file operation bar's file-tree panel.
 * Same hard caps + skip-list as `listFiles` so it never recurses into
 * node_modules et al: depth ≤ `maxDepth` (default 3), ≤ TREE_MAX_ENTRIES nodes,
 * directories first then files, each level alphabetized. Dotfiles are skipped.
 */
const TREE_MAX_ENTRIES = 2000;
const TREE_MAX_DEPTH = 4;

function listTree(root: string, maxDepth: number): FsTreeNode[] {
  /* Expand first: an unexpanded `~` fails the stat and falls through to
   * `path.dirname('~')` === '.', which lists the PROCESS working directory —
   * the wrong files rather than none, which is harder to notice. */
  const resolved = resolveUserPath(root);
  const base = statSafe(resolved)?.isDirectory() === true ? resolved : path.dirname(resolved);
  let count = 0;

  function walk(dir: string, depth: number): FsTreeNode[] {
    if (depth > maxDepth || count > TREE_MAX_ENTRIES) return [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: FsTreeNode[] = [];
    const files: FsTreeNode[] = [];
    for (const e of entries) {
      if (count > TREE_MAX_ENTRIES) break;
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      count++;
      if (e.isDirectory()) {
        dirs.push({ name: e.name, path: full, kind: 'dir', children: walk(full, depth + 1) });
      } else if (e.isFile()) {
        files.push({ name: e.name, path: full, kind: 'file' });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  if (statSafe(base)?.isDirectory() !== true) return [];
  return walk(base, 0);
}

/**
 * UTF-8 contents of a single file for the live canvas file surface. Size-capped
 * (default 512 KiB) so a runaway write never streams a huge payload into the
 * renderer, and flagged `binary` when a NUL byte appears in the head (so the app
 * shows a note instead of mojibake). No path fence: the renderer is trusted and
 * the model writes files anywhere in the project.
 */
const READ_FILE_DEFAULT_MAX = 512 * 1024;

function readFileBounded(
  file: string,
  maxBytes: number,
): { text: string | null; truncated: boolean; tooLarge: boolean; binary: boolean; bytes: number } {
  const resolved = resolveUserPath(file);
  const st = statSafe(resolved);
  if (st === null || !st.isFile()) {
    return { text: null, truncated: false, tooLarge: false, binary: false, bytes: 0 };
  }
  const cap = Math.max(0, maxBytes);
  const tooLarge = st.size > cap;
  let fd: number | null = null;
  try {
    fd = fs.openSync(resolved, 'r');
    const length = Math.min(st.size, cap);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    const head = buffer.subarray(0, Math.min(read, 8192));
    const binary = head.includes(0);
    return {
      text: binary ? null : buffer.subarray(0, read).toString('utf8'),
      truncated: tooLarge,
      tooLarge,
      binary,
      bytes: st.size,
    };
  } catch {
    return { text: null, truncated: false, tooLarge: false, binary: false, bytes: st.size };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * WRITE fence (round-9 live canvas editing). Unlike the read channels — where the
 * renderer is trusted and reads anywhere — writing is fenced to the roots the app
 * actually works in: the registered project folders, every cwd pi has a session
 * for, and pi's own agent/session data dir. A path outside all of them is refused
 * (belt-and-braces against a traversal/typo clobbering a system file). Payloads
 * are size-capped and a path that already resolves to a directory is refused.
 */
const WRITE_FILE_MAX = 5 * 1024 * 1024;

function normalizeRoot(p: string): string {
  const abs = resolveUserPath(p);
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

/** Absolute paths of the registered project working folders (projects.json). */
function projectRoots(): string[] {
  const raw = safeRead(PROJECTS_PATH);
  if (raw === null) return [];
  try {
    const doc = JSON.parse(raw) as { projects?: Array<{ path?: unknown }> };
    return (doc.projects ?? [])
      .map((p) => p?.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/** Every cwd pi has a session directory for (decoded from the folder name). */
function sessionCwdRoots(): string[] {
  const out: string[] = [];
  for (const p of listDir(SESSIONS_DIR)) {
    if (statSafe(path.join(SESSIONS_DIR, p))?.isDirectory() !== true) continue;
    const cwd = decodeCwd(p);
    if (cwd && cwd !== '/') out.push(cwd);
  }
  return out;
}

/** The union of allowed write roots, normalized + de-duplicated. */
function allowedWriteRoots(): string[] {
  const roots = new Set<string>();
  for (const p of projectRoots()) roots.add(normalizeRoot(p));
  for (const p of sessionCwdRoots()) roots.add(normalizeRoot(p));
  roots.add(normalizeRoot(AGENT_DIR));
  // Per-conversation sandbox base (Wave D): pi is spawned rooted at
  // `~/.pi/desktop/sandbox/<conversationId>/` when no project is selected, so
  // the canvas live-editor must be able to save there too — even before pi has
  // recorded a session for that cwd (which is when it would show up via
  // sessionCwdRoots). Allowing the base covers every conversation's sandbox;
  // the realpath/O_NOFOLLOW checks below still fence out any symlink escape.
  roots.add(normalizeRoot(sandboxBaseDir()));
  // Scheduled runs write their deliverables under ~/.pi/desktop/scheduled-runs;
  // the past-runs view serves them back through pd-file://, which fences to these
  // roots. Read AND write, since main writes the run's output here.
  roots.add(normalizeRoot(path.join(HOME, '.pi', 'desktop', 'scheduled-runs')));
  /*
   * Per-turn file checkpoints (harness verify/checkpoints.ts): a copy of every
   * file a turn is about to change, so the user can put one back. Written by
   * the pi child through the fenced tools, which is why it has to be a root —
   * without it the safety net is refused by the safety net.
   */
  roots.add(normalizeRoot(path.join(HOME, '.pi', 'desktop', 'checkpoints')));
  /*
   * WHERE GENERATED MEDIA LANDS. `~/Bobble/generated` is the app's OWN output
   * directory — every image, video and audio file a generation writes — and it
   * was not a served root, so the thread's player and file card fetched their
   * own output and got 404. The card displayed the failure as the file's size:
   * "audio · 9 B", nine bytes being the length of "not found". MEASURED twice,
   * from two different directions, before the shared cause was obvious.
   */
  roots.add(normalizeRoot(path.join(HOME, 'Bobble')));
  return [...roots];
}

export { allowedWriteRoots };

/** True when `target` is `root` itself or nested under it. */
function isUnderRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve `p` to a real (symlink-free) absolute path WITHOUT following a symlink
 * on the final component and WITHOUT requiring the target to exist yet.
 *
 * `path.resolve` is purely lexical, so a symlink that sits lexically under a
 * root but points outside would pass {@link isUnderRoot} while `writeFileSync`
 * silently follows it — an arbitrary-file-write escape. We instead realpath the
 * NEAREST EXISTING ANCESTOR directory (the file, and possibly some parent dirs,
 * may not exist yet) so every symlink in the existing portion of the path is
 * collapsed, then re-append the not-yet-existing trailing segments. Returns
 * `null` only when nothing on the path resolves (should never happen — `/`
 * always does).
 */
function realResolve(p: string): string | null {
  const abs = resolveUserPath(p);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null; // reached the filesystem root; unresolvable
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

function writeFileFenced(
  file: string,
  content: string,
  roots: string[] = allowedWriteRoots(),
): { ok: boolean; bytes?: number; error?: string } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > WRITE_FILE_MAX) return { ok: false, error: 'File exceeds the write size limit' };

  // Collapse symlinks in the existing portion of the path BEFORE fencing, so a
  // symlink lexically under a root but pointing outside can't defeat the fence.
  const resolved = realResolve(file);
  if (resolved === null) return { ok: false, error: 'Path could not be resolved' };
  // Compare in realpath space on BOTH sides. `resolved` collapses symlinks, so the
  // allowed roots must too — otherwise a project/session dir that lives under a
  // symlinked path (macOS /tmp -> /private/tmp, /var/folders temp dirs, or a
  // symlinked working folder) would wrongly reject legit in-root writes. A symlink
  // ESCAPE still fails: the target's realpath lands outside every root's realpath.
  const realRoots = roots.map((root) => realResolve(root) ?? normalizeRoot(root));
  if (!realRoots.some((root) => isUnderRoot(root, resolved))) {
    return { ok: false, error: 'Path is outside an allowed project or session folder' };
  }

  // Defense in depth: refuse a final component that already exists as a symlink
  // (points elsewhere) or a directory (overwriting a dir is never a file write).
  const lst = lstatSafe(resolved);
  if (lst?.isSymbolicLink() === true) return { ok: false, error: 'Path is a symlink' };
  if (lst?.isDirectory() === true) return { ok: false, error: 'Path is a directory' };

  const parent = path.dirname(resolved);
  let fd: number | null = null;
  try {
    fs.mkdirSync(parent, { recursive: true });
    // Re-realpath the parent now that it exists: mkdirSync(recursive) will happily
    // descend THROUGH a symlinked intermediate dir, so re-check the real parent
    // stays inside the fence (catches a symlinked dir swapped in mid-flight).
    const realParent = fs.realpathSync(parent);
    if (!realRoots.some((root) => isUnderRoot(root, realParent))) {
      return { ok: false, error: 'Path is outside an allowed project or session folder' };
    }
    const finalPath = path.join(realParent, path.basename(resolved));
    // O_NOFOLLOW makes the open FAIL (ELOOP) rather than follow a symlink at the
    // final component. Open WITHOUT O_TRUNC so a target we go on to refuse (a
    // hardlink, below) is never truncated before the check.
    fd = fs.openSync(
      finalPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o644,
    );
    // O_NOFOLLOW stops symlinks but NOT hardlinks (a hardlink's realpath is
    // itself). Refuse a multiply-linked file so a hardlink planted inside a root
    // can't write through to an out-of-root inode; and confirm the opened fd is
    // still the inode we fenced (residual-TOCTOU belt-and-braces).
    const opened = fs.fstatSync(fd);
    if (opened.nlink > 1) return { ok: false, error: 'Path is a hard link' };
    const named = lstatSafe(finalPath);
    if (named !== null && (named.dev !== opened.dev || named.ino !== opened.ino)) {
      return { ok: false, error: 'Path changed during write' };
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf8');
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, error: (error as { message?: string })?.message ?? String(error) };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

export { writeFileFenced };

/** The fs channel implementations, spread into main.ts's registerIpcHandlers. */
/**
 * ONE handler is async, and only one.
 *
 * `fs:project-instructions` must load the ESM-only pi SDK through a dynamic
 * import — a static one compiles to `require()` in this CJS bundle and kills
 * main at boot, with no window and no error the user can see. Typing the whole
 * map as possibly-async to accommodate it would make every caller await a
 * synchronous read, so that one key is singled out instead.
 */
type AsyncFsChannel = 'fs:project-instructions';

export const fsHandlers: {
  [K in Exclude<keyof FsInvokeMap, AsyncFsChannel>]: (
    req: FsInvokeMap[K]['request'],
  ) => FsInvokeMap[K]['response'];
} & {
  [K in AsyncFsChannel]: (req: FsInvokeMap[K]['request']) => Promise<FsInvokeMap[K]['response']>;
} = {
  'fs:list-files': (req) => listFiles(req.cwd ?? '', req.query ?? '', req.limit ?? 30),
  'fs:list-sessions': (req) => listAllSessions(req?.cwd, req?.query),
  'fs:read-session': (req) => ({ text: readSession(req.file) }),
  'fs:list-tree': (req) => ({
    root: req.root,
    tree: listTree(req.root, Math.min(req.depth ?? 3, TREE_MAX_DEPTH)),
  }),
  'fs:read-file': (req) => readFileBounded(req.path, req.maxBytes ?? READ_FILE_DEFAULT_MAX),
  'fs:write-file': (req) => writeFileFenced(req.path, req.content),
  'fs:delete-session': (req) => deleteSession(req.file),
  'fs:export-session': (req) => exportSession(req),
  'fs:project-instructions': (req) => projectInstructions(req.cwd),
};
