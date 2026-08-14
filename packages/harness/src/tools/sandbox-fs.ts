/**
 * Sandbox-fenced file tools (blind-test round-2 #2 — the FILE-SPILL root cause).
 *
 * ROOT CAUSE. Round-1 rooted the pi child's *process* cwd at the per-conversation
 * sandbox (`~/.pi/desktop/sandbox/<id>/`), verified with lsof. That is NOT enough:
 * pi's built-in `write`/`edit`/`read`/`ls` tools each bake in a `cwd` at
 * construction (`createXToolDefinition(cwd)`), then resolve a RELATIVE path
 * argument with `resolveToCwd(path, cwd)` — and in the desktop's RPC/`new_session`
 * flow that baked cwd can drift to the user's HOME, so a bare
 * `write {path:"file1.txt"}` lands in `/Users/<you>/file1.txt` instead of the
 * sandbox. Re-pointing the process cwd cannot fix a cwd that was captured
 * elsewhere.
 *
 * FIX. We register OUR OWN `write`/`edit`/`read`/`ls` tools with the SAME names.
 * pi's agent-session merges extension-registered tools OVER the built-ins by name
 * (`_refreshToolRegistry`: built-ins first, then extension tools `set()` on top),
 * so ours win. Each wrapper:
 *   1. resolves a relative path against a WORKSPACE ROOT we control — the
 *      env hint the desktop publishes at spawn, else pi's per-session `ctx.cwd`,
 *      else `process.cwd()` — and NEVER the bare HOME dir (a HOME candidate is
 *      skipped and, if nothing else is valid, a dedicated fallback sandbox dir is
 *      used), and
 *   2. for the MUTATING tools (`write`, `edit`) applies a write fence: the
 *      resolved absolute path must sit inside an allowed root (the workspace root
 *      or the sandbox base) — a `~/…`, `/etc/…`, or `../../…` escape is refused
 *      with an actionable error the model can recover from.
 * `read`/`ls` are only re-rooted (a read never spills a file), so the model can
 * still read an absolute path it was handed.
 *
 * The heavy lifting (actual fs writes, edit hunk matching, read truncation, ls
 * formatting + rendering) is delegated to pi's own tool `execute`, constructed
 * with our resolved root and handed an already-absolute path — so behavior +
 * UI stay identical to the built-ins, we only correct WHERE relative paths land
 * and fence escapes.
 *
 * Gated on `PI_DESKTOP_FS_FENCE=1` (the desktop sets it on every spawn) so a
 * plain CLI `pi` user of this extension keeps the unfenced built-ins.
 *
 * Electron-free (node fs/os/path only) so it stays unit-testable in the harness
 * package.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type { Static, TSchema } from '@sinclair/typebox';

/** Env gate: the desktop sets this on every pi spawn (pi-main buildPiEnv). */
export const FS_FENCE_ENV = 'PI_DESKTOP_FS_FENCE';
/** Env hint carrying the resolved sandbox/project cwd the desktop spawned pi at. */
export const WORKSPACE_ROOT_ENV = 'PI_DESKTOP_WORKSPACE_ROOT';

/** Root under which every conversation's private sandbox lives (mirrors
 * electron/sandbox.ts `sandboxBaseDir`; kept local so this stays electron-free). */
export function sandboxBaseDir(home: string = os.homedir()): string {
  return path.join(home, '.pi', 'desktop', 'sandbox');
}

/** Strip a trailing separator so root/prefix comparisons are exact. */
function normalizeRoot(p: string): string {
  const abs = path.resolve(p.trim());
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Expand a raw path argument the way pi's `resolveToCwd`/`expandPath` do — drop a
 * leading `@`, expand `~`/`~/…` to HOME — WITHOUT joining to a cwd yet, so the
 * caller can decide the base. Returns an absolute path unchanged.
 */
function expandUserPath(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * Resolve `raw` against `root`: absolute (or `~`-expanded to absolute) paths pass
 * through (still normalized so `..` segments collapse); a relative path is joined
 * to the workspace root — NEVER to HOME. This is the load-bearing fix for the
 * reported bug: `resolveWorkspacePath("file1.txt", sandbox)` → `<sandbox>/file1.txt`.
 */
export function resolveWorkspacePath(raw: string, root: string): string {
  const expanded = expandUserPath(raw);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  const repaired = repairDroppedRootSlash(expanded);
  if (repaired !== undefined) return repaired;
  return path.resolve(root, expanded);
}

/**
 * Top-level directories that only ever exist AT the filesystem root.
 *
 * Nobody keeps a relative folder called `Users/` or `Applications/` inside their
 * project, so a relative path starting with one of these is a dropped leading
 * slash, not a real relative path.
 */
const ROOT_LEVEL_DIRS = new Set([
  'Users',
  'Applications',
  'Library',
  'System',
  'Volumes',
  'home',
  'usr',
  'var',
  'etc',
  'opt',
  'tmp',
]);

/**
 * `Users/the user/Desktop/game` → `/Users/user/Desktop/game`.
 *
 * the user found the damage this does: "an earlier godot max effort run left a folder
 * on my desktop that is called 'users' and has a hilarious path in it:
 * /Users/user/Desktop/Users/user/Desktop/platformer_game".
 *
 * A single dropped character turns an absolute path into a relative one that
 * resolves happily against the working directory, so nothing errors — it just
 * builds an absurd tree somewhere real and reports success. Joining is the wrong
 * answer whenever the first segment is a directory that only exists at the root:
 * the user's home is not inside their Desktop.
 *
 * Returns undefined when the path is a genuine relative path, leaving the normal
 * join alone.
 */
export function repairDroppedRootSlash(relative: string): string | undefined {
  const first = relative.split(path.sep)[0] ?? '';
  if (!ROOT_LEVEL_DIRS.has(first)) return undefined;
  return path.resolve(path.sep + relative);
}

/**
 * PARSE IT BEFORE IT LANDS.
 *
 * MEASURED, run 3. Two central files were written corrupted and nothing noticed
 * for the rest of the run:
 *
 *   src/core/converter.py:456   `</parameter> </function> [END OF EDITS] {  try:`
 *   src/ui/main_window.py:327   `self._drag_zone QVBoxLayout = QVBoxLayout(...)`
 *
 * The first is the model's own tool-call markup written INTO the file — its
 * output format bleeding into content on a long generation. Both sat on disk,
 * settled, while five agents built around them. Every structural check passed
 * (all imports resolved, one tree, no duplicates) and the product was broken. The
 * CEO then listed the unparseable file under "Built Components", because nothing
 * between the write and the report had ever tried to parse it.
 *
 * The writer is the only agent with the context to fix it, and it is standing
 * right there. So the check happens AT the write and the complaint goes back in
 * the tool result — the same shape as the path refusal.
 *
 * GENERAL, NOT TASK-SPECIFIC: whatever parser the language already ships, and no
 * parser is a SKIP rather than a failure — the clean/broken/could-not-check
 * discipline learned in the project checker. A machine without python3 simply
 * does not get the Python check.
 */
const SYNTAX_CHECKS: ReadonlyArray<{ ext: readonly string[]; cmd: readonly string[] }> = [
  { ext: ['.py'], cmd: ['python3', '-m', 'py_compile'] },
  { ext: ['.js', '.cjs', '.mjs'], cmd: [nodeBinary(), '--check'] },
];

/**
 * A node we can actually reach, rather than one we hope is on PATH.
 *
 * THE GAP THIS CLOSES, found in run 4 the hour after the check shipped. A pi
 * child inherits the GUI app's PATH, and a launchd-started macOS app gets
 * `/usr/bin:/bin:/usr/sbin:/sbin`. `python3` lives there. `node` does not — it is
 * in /usr/local/bin or a version manager. So `spawnSync('node', …)` failed to
 * launch, `status` came back null, the "parser not installed" skip fired, and
 * JavaScript was never checked at all. Run 3 was Python and would have been
 * caught; run 4 was JavaScript and a `main.js` truncated mid-string sailed
 * through.
 *
 * The skip itself is right — our missing parser must never fail the model's
 * write. It was the reach that was wrong. This process is ALREADY a node (pi runs
 * on Electron-as-node), so `process.execPath` is a runtime that exists by
 * definition, which is the same trick resolve-pi.ts uses to run the bundled CLI
 * without a separate Node.
 */
function nodeBinary(): string {
  return process.execPath;
}

/** Parsers we have already reported as unavailable — one line each, not one per write. */
const skipReported = new Set<string>();

/** The parser command for this path, or undefined when none covers it. */
export function syntaxCheckFor(file: string): readonly string[] | undefined {
  const ext = path.extname(file).toLowerCase();
  return SYNTAX_CHECKS.find((c) => c.ext.includes(ext))?.cmd;
}

/** How a syntax check is actually run (injected so this stays unit-testable). */
export type RunSyntaxCheck = (
  cmd: readonly string[],
  target: string,
) => { status: number | null; stderr: string };

/**
 * Parse `content` the way `file` would be parsed. Returns the refusal text, or
 * null when it parses, when no parser covers this kind of file, or when the
 * parser is not installed — never a false alarm from our own environment.
 */
export function syntaxComplaint(file: string, content: string, run: RunSyntaxCheck): string | null {
  const cmd = syntaxCheckFor(file);
  if (cmd === undefined) return null;
  const tmp = path.join(os.tmpdir(), `pi-syntax-${process.pid}-${Date.now()}${path.extname(file)}`);
  try {
    fs.writeFileSync(tmp, content);
    const res = run(cmd, tmp);
    /*
     * A SKIP MUST NOT BE INVISIBLE. `status === null` is the parser failing to
     * launch, which correctly does not fail the write — but silence made a
     * half-working guard look like a working one for a whole run. Say it once, so
     * "no check ran" is never indistinguishable from "the check passed".
     */
    if (res.status === null && !skipReported.has(cmd[0] ?? '')) {
      skipReported.add(cmd[0] ?? '');
      process.stderr.write(
        `[harness] syntax check unavailable (${cmd.join(' ')}) — writes of this kind are NOT parsed\n`,
      );
    }
    // `status === null` is the parser failing to launch — not the file's fault.
    if (res.status === null || res.status === 0) return null;
    const detail = res.stderr.split(tmp).join(file).trim();
    return (
      `Refusing this write: ${path.basename(file)} does not parse.\n\n${detail}\n\n` +
      'Nothing was written. Fix the text and send it again — you are the only one who ' +
      'knows what this file was meant to say. Check the END of what you sent: a long ' +
      'file usually breaks where the generation ran out, and tool-call markup landing ' +
      'inside the content is the usual culprit.'
    );
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* a temp file we could not remove must never fail a write */
    }
  }
}

/**
 * Directories under HOME that are never a place to put a user's work, even when
 * something asks for them by name. `Library` is the OS's; a dot-directory is
 * application state.
 */
const HOME_DIRS_OFF_LIMITS = new Set(['Library']);

/**
 * True when `raw` NAMES a destination rather than merely spilling into one.
 *
 * THIS IS THE FIX FOR THE WORST BUG IN THE FILE TOOLS. The fence used to refuse
 * every path outside the workspace and tell the model to "use a relative path
 * like <basename>" — so a model asked for `~/bobble-testbed/corp-run` obediently
 * wrote `corp-run`, which resolved against the working folder and built the whole
 * project at `/Users/user/Desktop/corp-run` instead. Nothing errored. The model
 * reported the path it had been ASKED for, and the user went to that folder and found
 * nothing: "I can't as the user go and see the run even primitively following its
 * instructions going to the folder and the file and pressing f5, won't do
 * anything." The same mechanism built a duplicate tree at
 * `/Users/user/Desktop/bobble-testbed/platformer` and the absurd
 * `/Users/user/Desktop/Users/user/Desktop/platformer_game` he reported earlier.
 *
 * Silently relocating a user's files is worse than either writing them or
 * refusing. So an ABSOLUTE (or `~`-anchored) path under the user's home is
 * honoured: writing it out in full is what intent looks like, and it is how the
 * user's own instruction reaches the disk. A bare relative name is still fenced
 * to the workspace, which is what the containment was actually for.
 */
/**
 * The workspace-relative path a refused write almost certainly MEANT.
 *
 * Drops leading segments the root already accounts for, because duplicating them
 * is the mistake being corrected. Never drops the last segment — something has to
 * be written — and for a path that shares nothing with the root (`~/evil.txt`,
 * `/tmp/a/b/c.txt`) suggests the bare filename rather than replanting a stranger's
 * directory tree inside the workspace.
 */
export function suggestWorkspaceRelative(raw: string, root: string): string {
  const expanded = expandUserPath(raw);
  const segs = expanded.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
  if (segs.length === 0) return 'file';
  const rootSegs = new Set(
    normalizeRoot(root)
      .split(/[/\\]+/)
      .filter((s) => s !== ''),
  );
  let i = 0;
  while (i < segs.length - 1 && rootSegs.has(segs[i] ?? '')) i += 1;
  if (i === 0 && path.isAbsolute(expanded)) return segs.at(-1) ?? 'file';
  return segs.slice(i).join('/');
}

/**
 * WHAT A REFUSED PATH IS TOLD — the exact call to make instead, not a folder to
 * guess against.
 *
 * MEASURED, the localconvert run. The old text already named the root:
 *
 *   Refusing to write outside the workspace: "/localconvert/index.html" resolves
 *   to /localconvert/index.html. Write inside the working folder
 *   (/Users/user/bobble-testbed/localconvert). …
 *
 * The model's very next call was `write "localconvert/index.html"` — it read
 * "write inside the working folder (X)" as "put it under X's name" — and every
 * artifact of that run landed in `localconvert/localconvert/`. Naming the root
 * was not enough; the phrasing invited the duplicate. So say the answer: the
 * literal relative path to pass, and the trap not to fall into, with the wrong
 * result spelled out so there is nothing left to infer.
 *
 * This is the same lesson as the `use` tool's dead-end message and the
 * capability's "you now have" — a refusal the model cannot act on correctly is a
 * refusal that sends it somewhere worse.
 */
export function outsideWorkspaceRefusal(
  toolName: string,
  raw: string,
  abs: string,
  root: string,
): string {
  const suggestion = suggestWorkspaceRelative(raw, root);
  const trap = `${path.basename(normalizeRoot(root))}/${suggestion}`;
  return (
    `Refusing to ${toolName} outside the workspace: "${raw}" resolves to ${abs}. ` +
    `The working folder IS ${root}, and a relative path resolves against it — so pass ` +
    `path: "${suggestion}". Do NOT pass "${trap}": that would create ` +
    `${path.join(root, trap)}, one level too deep. If you genuinely mean to write ` +
    `somewhere else, SAY SO in your reply and give the real path — never let the user ` +
    `believe their files are at a location you did not use.`
  );
}

export function isNamedDestination(raw: string, abs: string, home: string): boolean {
  const expanded = expandUserPath(raw);
  if (!path.isAbsolute(expanded)) return false;
  const homeRoot = normalizeRoot(home);
  const target = normalizeRoot(abs);
  if (target === homeRoot) return false; // never root work at bare HOME
  if (!target.startsWith(homeRoot + path.sep)) return false;
  const rest = target.slice(homeRoot.length + 1);
  // A DIRECT child of HOME is a dump, not a destination: `~/notes.txt` is the
  // spill this fence exists to stop, while `~/projects/game/main.gd` is a place
  // someone chose. Naming a folder is the difference.
  if (!rest.includes(path.sep)) return false;
  const first = rest.split(path.sep)[0] ?? '';
  return !first.startsWith('.') && !HOME_DIRS_OFF_LIMITS.has(first);
}

/** True when `abs` is `root` itself or nested under it. Roots must be normalized. */
export function isInsideRoots(abs: string, roots: readonly string[]): boolean {
  const target = normalizeRoot(abs);
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

/**
 * Choose the workspace root a projectless/absolute-free file op resolves against.
 * Priority: the explicit env hint the desktop publishes, then pi's per-session
 * `ctx.cwd`, then the process cwd — each accepted only when it is an existing dir
 * that is NOT the bare HOME dir. When everything collapses to HOME (or nothing is
 * valid) a dedicated fallback sandbox dir is used, so a bare `write foo.txt` can
 * never land in HOME even if pi handed us a HOME cwd.
 */
export function resolveWorkspaceRoot(
  ctxCwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const homeRoot = normalizeRoot(home);
  const candidates = [env[WORKSPACE_ROOT_ENV], ctxCwd, process.cwd()];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const normalized = normalizeRoot(candidate);
    if (normalized === homeRoot) continue; // never root file ops at bare HOME
    if (isDir(normalized)) return normalized;
  }
  const fallback = path.join(sandboxBaseDir(home), '_fallback');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    // Best effort — if even this fails the caller still gets a non-HOME path.
  }
  return normalizeRoot(fallback);
}

/** The allowed write roots for a resolved workspace root: the root itself plus the
 * per-conversation sandbox base (so a sandbox write is always permitted). */
export function allowedWriteRoots(root: string, home: string = os.homedir()): string[] {
  return [normalizeRoot(root), normalizeRoot(sandboxBaseDir(home))];
}

/** A ToolDefinition with the default (widest) generics — what `registerTool`
 * accepts, and what pi's `createXToolDefinition` factories widen to. */
type AnyToolDef = ToolDefinition;

/** Read the `path` field off raw tool args (write/edit/read use `path`, ls omits). */
function argPath(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const value = (params as { path?: unknown }).path;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Wrap one pi tool definition so its relative paths resolve against the live
 * workspace root and (when `fence`) escapes are refused. `getRoot` is evaluated
 * per-call from `ctx` so a resumed/switched session's cwd is honored — the tool
 * is registered once but the root is never stale.
 *
 * Only the model-facing fields are carried over (name/description/schema +
 * execute); pi's TUI `renderCall`/`renderResult` are intentionally dropped — the
 * desktop renders tool rows itself and RPC mode never invokes them, and keeping
 * them would fight TypeBox generic variance for no runtime benefit.
 */
/**
 * Strip a MARKDOWN code fence that a model wrapped its file content in.
 *
 * (Nothing to do with the sandbox fence above — this is ``` .)
 *
 * MEASURED: an engineer wrote `scenes/main.tscn` ending in a bare ``` line. Godot
 * cannot parse it, so a scene that was otherwise close to correct failed to load
 * and the run spent its remaining budget repairing the wrong thing. The model had
 * emitted a closing fence without an opening one — the tail of a habit, not a
 * decision — and no amount of prompting reliably suppresses that.
 *
 * Two unambiguous shapes are removed:
 *   - the WHOLE body wrapped: ```lang\n …\n``` → the middle.
 *   - a DANGLING closer: a body whose last non-empty line is exactly ``` with no
 *     opening fence anywhere → drop that line.
 *
 * Anything else is left alone, and `.md` files are skipped entirely: a fence in
 * markdown is content, not an artifact.
 */
/**
 * A REWRITE THAT GUTS AN EXISTING FILE IS ALMOST NEVER INTENDED.
 *
 * MEASURED: asked to fix a 56-line tkinter app, the model rewrote app.py, wrote
 * its own reasoning into the source as it went ("# Wait, it's value=\"Ready\"",
 * "# I'll just rewrite the whole thing carefully"), and abandoned mid-rewrite.
 * What landed was 21 lines with every method gone — handle_drop, convert and
 * main all deleted. It still PARSES, so py_compile is happy; the app is
 * destroyed. The user asked for five bugs fixed and got an empty shell.
 *
 * Generic on purpose: losing most of an existing file in a single write is a
 * mistake in any language and any project, and the model that does it has no
 * idea — it believes it wrote the whole file. Deleting code deliberately is
 * what `edit` is for, which is also more precise.
 *
 * Deliberately conservative, because a false refusal costs real work: it only
 * fires on a file that had real content to lose, and only when MOST of it would
 * go. Returns the refusal text, or null to allow.
 */
/** Definition-ish lines: `def x`, `class X`, `function x`, `export function x`,
 * `const x = (…) =>`. Language-agnostic enough to catch the shape that matters —
 * "this file used to declare things it no longer declares". */
function definitionsIn(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split('\n')) {
    const m =
      /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function)\s+([A-Za-z_][\w]*)/.exec(line) ??
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(/.exec(line);
    if (m?.[1] !== undefined) out.add(m[1]);
  }
  return out;
}

export function guardDestructiveRewrite(
  absPath: string,
  next: string,
  readFile: (p: string) => string | null,
): string | null {
  const before = readFile(absPath);
  if (before === null) return null; // new file — nothing to lose
  const beforeLines = before.split('\n').filter((l) => l.trim() !== '').length;
  if (beforeLines < 25) return null; // too small to have structure worth guarding
  const afterLines = next.split('\n').filter((l) => l.trim() !== '').length;

  /*
   * DEFINITIONS ARE THE REAL SIGNAL, not line count.
   *
   * The first version of this guard only compared line counts at 50%, and a
   * measured rewrite slipped straight through: 38 lines to 29 — 76% retained,
   * comfortably "safe" — while `main()` and the `__main__` block vanished, a
   * method was left half-written ending in `# ...`, and the model's own thinking
   * was in the source as `# Wait, I used self.fmt in __init__`. The file was
   * ruined and the arithmetic said fine.
   *
   * What actually happened is that the file stopped declaring things it used to
   * declare. That is the property to check, and it holds in any language: losing
   * a function you did not mention is a rewrite that ran out, not an edit.
   */
  const lost = [...definitionsIn(before)].filter((d) => !definitionsIn(next).has(d));
  if (lost.length > 0) {
    return (
      `Refusing this write: ${path.basename(absPath)} currently defines ` +
      `${lost.map((d) => `\`${d}\``).join(', ')}, and the version you are writing does not. ` +
      'Dropping a definition you were not asked to remove is almost always a rewrite that ran ' +
      `out partway. NOTHING WAS WRITTEN — ${path.basename(absPath)} on disk is UNCHANGED and ` +
      'intact, exactly as it was before this call. Read it if you want to see it. Use `edit` to ' +
      'change the parts you mean to change; if you really are replacing the file, include every ' +
      'definition you intend to keep.'
    );
  }

  if (afterLines >= beforeLines * 0.5) return null;
  return (
    `Refusing this write: it would cut ${path.basename(absPath)} from ${beforeLines} lines to ` +
    `${afterLines}, deleting most of what is there. That is almost always a rewrite that ran ` +
    `out partway rather than a deliberate deletion. NOTHING WAS WRITTEN — ${path.basename(absPath)} ` +
    'on disk is UNCHANGED and intact, exactly as it was before this call. Read it if you want to ' +
    'see it. If you meant to change part of it, use `edit`, which touches only the lines you name. ' +
    'If you really do mean to replace the whole file, write the COMPLETE new contents in one ' +
    'go, including every function you intend to keep.'
  );
}

/**
 * MARKDOWN ESCAPES THAT LEAKED INTO CODE.
 *
 * MEASURED: a rewrite wrote `self.status\_var.set(...)` into a .py file — the
 * model escaped the underscore the way it would in prose, and the backslash went
 * to disk. The file stopped compiling, so three genuinely correct bug fixes in
 * the same write were worth nothing.
 *
 * Same shape as the code fence this file already strips: an artifact of the
 * model's OUTPUT format reaching a file that is not markdown.
 *
 * ONLY `\_`, deliberately. `\*` looks like the same mistake but is ordinary in
 * a regex (`r"\*"`), and stripping it would corrupt working code — the exact
 * kind of overcorrection this guard exists to prevent. A backslash-underscore
 * has no meaning in Python, JS or TS: it is an invalid string escape and a
 * syntax error outside one. Markdown and LaTeX keep theirs, where it is real.
 */
export function stripMarkdownEscapes(content: string, absPath: string): string {
  if (/\.(md|markdown|mdx|tex|latex)$/i.test(absPath)) return content;
  return content.replace(/\\_/g, '_');
}

export function stripCodeFence(content: string, absPath: string): string {
  if (/\.(md|markdown|mdx)$/i.test(absPath)) return content;
  const lines = content.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.trim() !== '') {
      lastIdx = i;
      break;
    }
  }
  if (firstIdx === -1 || lastIdx <= firstIdx) return content;
  const first = lines[firstIdx]?.trim() ?? '';
  const last = lines[lastIdx]?.trim() ?? '';
  const opens = /^```[\w+-]*$/.test(first);
  const closes = last === '```';
  // Whole body wrapped → keep the middle.
  if (opens && closes) return lines.slice(firstIdx + 1, lastIdx).join('\n');
  // Dangling closer with no opener anywhere → drop just that line.
  if (closes && !lines.some((l, i) => i < lastIdx && /^```[\w+-]*$/.test(l.trim()))) {
    return [...lines.slice(0, lastIdx), ...lines.slice(lastIdx + 1)].join('\n');
  }
  return content;
}

function fenceTool<S extends TSchema, D>(
  base: ToolDefinition<S, D>,
  fence: boolean,
  getRoot: (ctx: ExtensionContext) => string,
  home: string = os.homedir(),
): AnyToolDef {
  const wrapped: AnyToolDef = {
    name: base.name,
    label: base.label,
    description: base.description,
    ...(base.promptSnippet !== undefined ? { promptSnippet: base.promptSnippet } : {}),
    ...(base.promptGuidelines !== undefined ? { promptGuidelines: base.promptGuidelines } : {}),
    parameters: base.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const root = getRoot(ctx);
      const raw = argPath(params);
      // ls with no `path` → the built-in defaults to "."; make that "." resolve
      // against OUR root by passing the root explicitly.
      const abs = raw === undefined ? root : resolveWorkspacePath(raw, root);
      if (
        raw !== undefined &&
        fence &&
        !isInsideRoots(abs, allowedWriteRoots(root, home)) &&
        !isNamedDestination(raw, abs, home)
      ) {
        throw new Error(outsideWorkspaceRefusal(base.name, raw, abs, root));
      }
      // Hand pi an already-absolute path so its own resolveToCwd is a passthrough
      // and it writes/reads EXACTLY where we fenced.
      const next = { ...(params as Record<string, unknown>), path: abs } as unknown as Static<S>;
      // ...and never let a markdown code fence reach disk (see stripCodeFence).
      const body = (next as Record<string, unknown>).content;
      if (typeof body === 'string') {
        const cleaned = stripMarkdownEscapes(stripCodeFence(body, abs), abs);
        // ...and never let a rewrite silently gut an existing file.
        const destructive = guardDestructiveRewrite(abs, cleaned, (fp) => {
          try {
            return fs.readFileSync(fp, 'utf8');
          } catch {
            return null;
          }
        });
        if (destructive !== null) throw new Error(destructive);
        // ...and never let a file that does not parse reach disk (see syntaxComplaint).
        const unparseable = syntaxComplaint(abs, cleaned, (cmd, target) => {
          const res = spawnSync(cmd[0] ?? '', [...cmd.slice(1), target], {
            encoding: 'utf8',
            /*
             * ELECTRON_RUN_AS_NODE=1 here is the deliberate INVERSE of
             * cleanChildEnv, and for the opposite reason. The model's own
             * commands must not inherit it (it breaks any Electron they launch);
             * this one must have it, because the binary being spawned is
             * `process.execPath` — our own runtime — and we want it to behave as
             * node rather than start an app. Harmless under a plain node, which
             * ignores it.
             */
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          });
          return { status: res.status, stderr: `${res.stderr ?? ''}${res.stdout ?? ''}` };
        });
        if (unparseable !== null) throw new Error(unparseable);
        (next as Record<string, unknown>).content = cleaned;
      }
      const result = await base.execute(toolCallId, next, signal, onUpdate as never, ctx);
      if (base.name !== 'read') return result;
      const r = result as unknown as Record<string, unknown>;
      return { ...r, content: withReadPathHeader(abs, r.content) } as typeof result;
    },
  };
  return wrapped;
}

/**
 * Stamp a `read` result with the absolute path it came from.
 *
 * `write` and `edit` already name their target — "Successfully wrote N bytes to
 * <abs>", "Successfully replaced N block(s) in <abs>" — and those paths are
 * absolute precisely because we hand pi an already-resolved one (see the
 * `next` construction in the wrapper). `read` alone returns the file body and
 * nothing else, so a role that reads five files accumulates five unlabelled
 * blobs and has to infer which is which from the content. That inference is the
 * same class of bug as every other "the harness left it implicit" failure in
 * this file — and it is one line to remove.
 *
 * Also load-bearing for compaction: a stamped blob is provably recoverable from
 * disk, which is what makes it safe to evict first.
 */
export function withReadPathHeader(abs: string, content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const parts = content as Array<Record<string, unknown>>;
  const i = parts.findIndex((p) => p?.type === 'text' && typeof p.text === 'string');
  // An image read has no text part to prefix — give it its own.
  if (i === -1) return [{ type: 'text', text: abs }, ...parts];
  return parts.map((p, n) => (n === i ? { ...p, text: `${abs}\n${String(p.text)}` } : p));
}

export interface SandboxFsOptions {
  /** Override the workspace-root resolver (tests). Default: {@link resolveWorkspaceRoot}. */
  readonly getRoot?: (ctx: ExtensionContext) => string;
  /** Injected HOME (tests). */
  readonly home?: string;
}

/**
 * Build the four fenced tool definitions (`write`, `edit`, `read`, `ls`). `write`
 * and `edit` are fenced (mutations); `read` and `ls` are only re-rooted. Exposed
 * for unit tests, which pass a fixed `getRoot` + injected pi operations.
 */
export function createSandboxFileTools(options: SandboxFsOptions = {}): AnyToolDef[] {
  const home = options.home ?? os.homedir();
  const getRoot =
    options.getRoot ??
    ((ctx: ExtensionContext) => resolveWorkspaceRoot(ctx.cwd, process.env, home));
  // Each pi definition is constructed with a placeholder cwd — the wrapper always
  // passes an already-absolute path, so this cwd is never actually consulted.
  const placeholder = normalizeRoot(sandboxBaseDir(home));
  return [
    fenceTool(createWriteToolDefinition(placeholder), true, getRoot, home),
    fenceTool(createEditToolDefinition(placeholder), true, getRoot, home),
    fenceTool(createReadToolDefinition(placeholder), false, getRoot, home),
    fenceTool(createLsToolDefinition(placeholder), false, getRoot, home),
  ];
}

/**
 * Register the sandbox-fenced file tools, overriding pi's built-ins by name.
 * No-op unless `PI_DESKTOP_FS_FENCE=1` — a plain CLI `pi` user keeps the built-ins.
 * Returns true when the override was installed (for tests / telemetry).
 */
export function registerSandboxFileTools(
  pi: ExtensionAPI,
  options: SandboxFsOptions & { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env;
  if (env[FS_FENCE_ENV] !== '1') return false;
  for (const tool of createSandboxFileTools(options)) {
    pi.registerTool(tool);
  }
  return true;
}
