/**
 * Pure detection of file-WRITING tool calls off the pi message stream, for the
 * "file writes → canvas" feature (round-7). An edit/write/patch tool call, or a
 * bash command that redirects into a file (`>`, `>>`, `tee`), becomes a
 * {@link FileWriteEvent} the routing hook turns into a live canvas file tab.
 *
 * No React / IPC here so the classification (which tools count, redirect
 * parsing, relative→absolute path resolution) is unit-testable in isolation.
 */
import type { ChatMsg, ContentBlock } from '@pi-desktop/engine';
import { toolStepKind } from '../activity-mapping';
import {
  CONTENT_KEYS,
  NEW_STRING_KEYS,
  OLD_STRING_KEYS,
  PATH_KEYS,
  partialJsonString,
} from '../partial-json';
import { reportedWritePath } from '../reported-path';

type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>;

/**
 * The old/new strings of a str_replace-style EDIT, either parsed whole (finalized
 * args) or partial (streaming argsText). Both are optional so the diff can DRAW as
 * the args arrive: first the deletions (old_string) as they stream, then the
 * additions (new_string) growing after.
 */
export interface EditHunk {
  /** Replaced text (the `−` lines). Absent until `old_string` starts streaming. */
  oldText?: string;
  /** Replacement text (the `+` lines). Absent until `new_string` starts streaming. */
  newText?: string;
}

/** One detected file write: the tab is keyed by its absolute path. */
export interface FileWriteEvent {
  /** The tool-call id (dedup key for "finalize once on completion"). */
  callId: string;
  /** Absolute path of the written file. */
  path: string;
  /** Display filename (last path segment). */
  filename: string;
  /** No matching tool result yet → the write is still in flight. */
  running: boolean;
  /** Full new content from the tool args, when the tool carries it (whole-file
   * writes). Absent for str_replace-style edits + bash writes (read from disk). */
  contentHint?: string;
  /** A str_replace-style edit's replaced/replacement text — present ONLY for
   * hunk edits (not whole-file writes). The FIRST hunk, which is all there is
   * for the ordinary one-hunk edit tool and all the streaming (still-arriving)
   * case can know. See {@link hunks} for the whole set. */
  edit?: EditHunk;
  /**
   * EVERY hunk this edit applies, in the order the tool listed them — one for a
   * plain `str_replace`, several for a multi-edit tool that carries an `edits`
   * array. The canvas plays them as one motion, top of the file down; without
   * this a three-hunk edit would animate only the first.
   */
  hunks?: EditHunk[];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickPath(args: Record<string, unknown>): string | undefined {
  return (
    str(args.path) ??
    str(args.file_path) ??
    str(args.filename) ??
    str(args.file) ??
    str(args.target_file)
  );
}

/** Whole-file content from a write/create tool's args (NOT a str_replace patch). */
function wholeFileContent(args: Record<string, unknown>): string | undefined {
  return str(args.content) ?? str(args.file_text) ?? str(args.contents);
}

/**
 * A str_replace-style edit's old/new strings from parsed args, or undefined when
 * the tool carries neither (a whole-file write). Mirrors the alias order used by
 * activity-mapping's `editDiff` (minus the whole-file content keys, which mark a
 * write, not an edit). An empty old_string (a pure insertion) reads as undefined
 * here — the diff then shows additions only.
 */
function editStrings(args: Record<string, unknown>): EditHunk | undefined {
  const oldText = str(args.old_string) ?? str(args.oldText) ?? str(args.old) ?? str(args.oldStr);
  const newText = str(args.new_string) ?? str(args.newText) ?? str(args.new) ?? str(args.newStr);
  if (oldText === undefined && newText === undefined) return undefined;
  return { oldText, newText };
}

/**
 * EVERY hunk in a parsed edit call: the top-level old/new pair, or the entries
 * of a multi-edit tool's `edits` array (each read through the same aliases).
 * Order is the tool's; the canvas re-orders them by position in the file, which
 * is the order they are watched in.
 */
function editHunks(args: Record<string, unknown>): EditHunk[] | undefined {
  const list = args.edits ?? args.replacements ?? args.changes;
  if (Array.isArray(list)) {
    const hunks: EditHunk[] = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      const hunk = editStrings(entry as Record<string, unknown>);
      if (hunk !== undefined) hunks.push(hunk);
    }
    if (hunks.length > 0) return hunks;
  }
  const single = editStrings(args);
  return single === undefined ? undefined : [single];
}

/** True when `p` is already absolute (posix `/…` or Windows `C:\…`). */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Last path segment (display filename). */
export function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Directory portion of a path (everything before the last segment). */
export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx <= 0 ? (idx === 0 ? '/' : '') : p.slice(0, idx);
}

/**
 * Resolve `p` against `cwd`, collapsing `.`/`..` segments. A minimal, posix-ish
 * join (the renderer has no node:path); good enough for display + IPC targeting
 * (main re-resolves with node:path.resolve before touching disk).
 */
export function resolvePath(cwd: string | undefined, p: string): string {
  const raw = isAbsolutePath(p) || !cwd ? p : `${cwd.replace(/\/+$/, '')}/${p}`;
  const win = /^[a-zA-Z]:[\\/]/.test(raw);
  const normalizedSlashes = raw.replace(/\\/g, '/');
  const leading = normalizedSlashes.startsWith('/') || win;
  const out: string[] = [];
  for (const seg of normalizedSlashes.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!leading) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return (leading && !win ? '/' : '') + out.join('/');
}

/**
 * The file a bash command writes to, or undefined. Scans for redirect targets
 * (`> file`, `>> file`) and `tee [-a] file`, returning the LAST such target
 * (the effective output file). Ignores `/dev/null`, fd dups (`>&2`, `2>&1`), and
 * numeric fds.
 */
export function bashRedirectTarget(command: string): string | undefined {
  /*
   * ONLY OUTSIDE QUOTES, AND NOT INSIDE A HEREDOC.
   *
   * SEEN in the canvas assessment: `python3 -c "print(len([u for u in d if
   * u['age'] > 60]))"` opened a file tab called `60])}` ("Could not read this
   * file") — a comparison operator inside the quoted program, lifted as a
   * redirect target, while the file the person asked about never opened. The
   * shell never saw a redirect there, and neither should this: what is quoted
   * is an argument, and what follows `<<` is a document.
   */
  const unquoted = shellUnquotedSpans(command);
  let last: string | undefined;
  // `>`/`>>` not preceded by `&`/digit (fd dup), capturing an optional-quoted path.
  const redirect = /(?<![&\d])>>?\s*(['"]?)([^\s'"|&;<>]+)\1/g;
  for (const m of unquoted.matchAll(redirect)) {
    const target = m[2];
    if (target && target !== '/dev/null' && !/^&?\d+$/.test(target) && looksLikePath(target)) {
      last = target;
    }
  }
  const tee = /\btee\b\s+(?:-a\s+)?(['"]?)([^\s'"|&;<>]+)\1/g;
  for (const m of unquoted.matchAll(tee)) {
    const target = m[2];
    if (target && target !== '/dev/null' && looksLikePath(target)) last = target;
  }
  return last;
}

/** A redirect target a shell would create a file for — not a fragment of code. */
function looksLikePath(target: string): boolean {
  return !/[()[\]{}]/.test(target);
}

/**
 * The command with everything inside quotes blanked (same length, so match
 * offsets stay meaningful) and everything from a heredoc's body onward dropped.
 * A light scan, not a shell parser: single quotes, double quotes with backslash
 * escapes, and `<<` followed by the rest of the line as the last thing read.
 */
export function shellUnquotedSpans(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  let heredoc = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote !== null) {
      if (quote === '"' && ch === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ' ';
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') heredoc = true;
    if (ch === '\n' && heredoc) break;
    out += ch;
  }
  return out;
}

/** Whether this tool call writes a file, and (path, contentHint | edit) if so. */
function classifyWrite(
  block: ToolCallBlock,
): { path: string; contentHint?: string; edit?: EditHunk; hunks?: EditHunk[] } | undefined {
  const args = block.arguments ?? {};
  const kind = toolStepKind(block.name);
  const finalized = Object.keys(args).length > 0;
  if (kind === 'edit') {
    if (finalized) {
      const path = pickPath(args);
      if (path === undefined) return undefined;
      // A str_replace-style edit (has old/new strings) → the edit ANIMATION;
      // otherwise a whole-file write → streamed content. Mutually exclusive.
      const hunks = editHunks(args);
      if (hunks !== undefined) return { path, edit: hunks[0], hunks };
      return { path, contentHint: wholeFileContent(args) };
    }
    // Still streaming (args haven't parsed yet): read the growing content out of
    // the raw argsText so a whole-file write DRAWS as it streams. Wait for the
    // path field to CLOSE before opening a tab (a half-typed path would target
    // the wrong file); then feed whatever has arrived so far.
    const buf = block.argsText;
    if (buf === undefined || buf.length === 0) return undefined;
    const pathField = partialJsonString(buf, PATH_KEYS);
    if (pathField === undefined || !pathField.complete) return undefined;
    // Prefer the edit hunk: once EITHER old_string or new_string appears, this is a
    // str_replace edit and the deletions/additions stream into a live diff. Only a
    // tool with no old/new (a whole-file write) falls through to streamed content.
    const oldField = partialJsonString(buf, OLD_STRING_KEYS);
    const newField = partialJsonString(buf, NEW_STRING_KEYS);
    if (oldField !== undefined || newField !== undefined) {
      return {
        path: pathField.value,
        edit: { oldText: oldField?.value, newText: newField?.value },
      };
    }
    const content = partialJsonString(buf, CONTENT_KEYS);
    return { path: pathField.value, contentHint: content?.value };
  }
  if (kind === 'bash') {
    const command = str(args.command);
    if (command === undefined) return undefined;
    const target = bashRedirectTarget(command);
    return target === undefined ? undefined : { path: target };
  }
  return undefined;
}

/**
 * All file writes across the thread, oldest→newest, de-duplicated by absolute
 * path (the LAST write to a path wins so the tab reflects the newest state).
 * `running` is true until a tool result for that call id arrives.
 */
export function detectFileWrites(messages: ChatMsg[], cwd: string | undefined): FileWriteEvent[] {
  const completed = new Set<string>();
  const failed = new Set<string>();
  /** The absolute path the tool itself said it wrote, by call id. */
  const reported = new Map<string, string>();
  for (const m of messages) {
    if (m.kind === 'toolResult') {
      completed.add(m.toolCallId);
      if (m.isError === true) failed.add(m.toolCallId);
      const at = reportedWritePath(m.text);
      if (at !== undefined) reported.set(m.toolCallId, at);
    }
  }
  const byPath = new Map<string, FileWriteEvent>();
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    for (const block of m.blocks) {
      if (block.type !== 'toolCall') continue;
      const write = classifyWrite(block);
      if (write === undefined) continue;
      /*
       * A WRITE THAT WAS REFUSED WROTE NOTHING. SEEN (the user's screenshot): the
       * handmade-media guard refused `create_illustrations.py`, and the
       * Activity tab opened a file tab for it anyway — "Could not read this
       * file … It may have been written somewhere else, moved, or removed" —
       * about a file that never existed, while the thread's own row already
       * said why. A failed whole-file write is not a file; a failed EDIT still
       * names a file that exists, so that one stays.
       */
      if (failed.has(block.id) && write.edit === undefined && write.hunks === undefined) continue;
      /*
       * WHERE THE TOOL SAID IT WROTE, when it has said. The call's own path is
       * whatever the model typed, relative to a root only the tools know for
       * sure; the result names the absolute file. SEEN 2026-09-13: the model
       * wrote `hi-8/x.md` in a working folder that WAS `…/hi-8`, the tab was
       * keyed one folder up, and "Could not read this file" for every file of
       * the chat. The tool's own word is the truth of the disk.
       */
      const path = reported.get(block.id) ?? resolvePath(cwd, write.path);
      byPath.set(path, {
        callId: block.id,
        path,
        filename: basename(path),
        running: !completed.has(block.id),
        contentHint: write.contentHint,
        edit: write.edit,
        hunks: write.hunks,
      });
    }
  }
  return [...byPath.values()];
}
