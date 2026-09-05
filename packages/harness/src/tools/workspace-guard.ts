/**
 * A COMMAND THAT DELETES THE PLACE THE WORK LIVES.
 *
 * MEASURED on a long low-effort run: asked for 24 small files, the model got
 * all 24 written, then over the next six minutes the count went 24 → 0 → 13 →
 * 24 → 14 → 0, and at the end the working directory — and the home directory
 * containing it — did not exist. Ten minutes of work, gone, with the run still
 * going and reporting progress.
 *
 * Nothing was there to stop it. The checkpoint safety net (verify/checkpoints.ts)
 * copies a file before `write` or `edit` touches it, which is the whole "you
 * noticed a bad change three turns later and put it back" story — and `bash` is
 * outside it. A `rm -rf` through the shell is recorded in `ranCommands` and
 * otherwise unremarked.
 *
 * ## The rule, and why it is this narrow
 *
 * Refuse a command that removes or moves away the WORKSPACE ROOT ITSELF, or any
 * directory containing it. Not "destructive commands" in general: `rm -rf
 * node_modules`, `rm -rf build`, cleaning a temp dir — all of those are ordinary
 * work, and a guard that argued with them would be turned off within a day.
 *
 * The line is that deleting the directory you were told to work IN is never the
 * task. It cannot be: everything the request is about is inside it. So the rule
 * assumes nothing about what the work is, which is the only kind of rule worth
 * making here.
 *
 * `$HOME` and `/` are included on the same reasoning, one level up.
 */
import os from 'node:os';
import path from 'node:path';

/** `rm` with a recursive flag, in any of the ways it is written. */
const RM = /(?:^|[\s;&|(])rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|-[a-zA-Z]+\s+-[a-zA-Z]*[rR]\s+)/;
/** `mv <dir> <somewhere>` — moving the workspace away is deleting it, slowly. */
const MV = /(?:^|[\s;&|(])mv\s+/;

/**
 * Split a command into its arguments, honouring simple quoting. Not a shell
 * parser: enough to see which paths a `rm` names, which is all this needs.
 */
function args(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(command);
  while (m !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
    m = re.exec(command);
  }
  return out;
}

/** Absolute, `~` and `$HOME` expanded, trailing slash removed. */
function resolveArg(arg: string, cwd: string, home: string): string | null {
  if (arg.startsWith('-')) return null;
  let a = arg;
  if (a === '~' || a.startsWith('~/')) a = path.join(home, a.slice(1));
  a = a.replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
  if (a.length === 0) return null;
  const abs = path.resolve(cwd, a);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

/** Is `target` the workspace root itself, or a directory containing it? */
function coversWorkspace(target: string, workspace: string): boolean {
  return target === workspace || workspace.startsWith(`${target}${path.sep}`);
}

export interface WorkspaceGuardOptions {
  readonly home?: string;
}

/**
 * The reason to refuse this command, or null to let it run.
 *
 * `workspaceRoot` is the directory the agent was told to work in. With no
 * workspace there is nothing to protect and everything is allowed — this guard
 * has no opinion about a session that never named a working directory.
 */
export function wouldDestroyWorkspace(
  command: string,
  workspaceRoot: string | undefined,
  opts: WorkspaceGuardOptions = {},
): string | null {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) return null;
  const home = opts.home ?? os.homedir();
  const workspace = path.resolve(workspaceRoot).replace(/\/+$/, '');
  const c = command.trim();
  const removing = RM.test(c);
  const moving = MV.test(c);
  if (!removing && !moving) return null;

  /*
   * A `mv` names a DESTINATION last, and moving something INTO the workspace is
   * the opposite of the worry — so only the source arguments are considered.
   */
  const parsed = args(c).slice(1);
  const candidates = moving && !removing ? parsed.slice(0, -1) : parsed;

  for (const raw of candidates) {
    const target = resolveArg(raw, workspace, home);
    if (target === null) continue;
    /*
     * A glob is not resolved here — `rm -rf *` inside the workspace removes its
     * CONTENTS, not the directory, and that is a judgement call the agent is
     * allowed to make. What is refused is naming the directory itself.
     */
    if (target.includes('*') || target.includes('?')) continue;
    if (target === '/') {
      return refusal(command, '/', workspace);
    }
    if (target === home) {
      return refusal(command, 'your home directory', workspace);
    }
    if (coversWorkspace(target, workspace)) {
      return refusal(command, target === workspace ? 'the working directory' : target, workspace);
    }
  }
  return null;
}

function refusal(command: string, what: string, workspace: string): string {
  return (
    `that command would delete ${what}, which is where this task's work lives (${workspace}) — ` +
    'so it was not run. Everything you have made is in there, and nothing in the request ' +
    'is served by removing it. If you need to start a file over, write over that one file; ' +
    'if you need to clear something, name the thing inside the directory rather than the ' +
    'directory itself.'
  );
}
