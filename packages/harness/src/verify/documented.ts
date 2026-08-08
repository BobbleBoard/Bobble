import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * THE DEFECT THAT SURVIVES EVERY RUN.
 *
 * Measured across three benches: the bugs that get fixed are the ones that
 * CRASH. A crash announces itself — run the thing, read the traceback, fix it.
 * A defect where working code quietly disagrees with the documented behaviour
 * has nothing to announce it, so it survives untouched.
 *
 *   run F — the two misses were the two needing the app to be RUN.
 *   run G — nothing was written at all.
 *   run H — 3 of 4 fixed. The survivor: the README says "Searching is
 *           case-insensitive"; `search MILK` still finds nothing.
 *
 * Run H is the instructive one. The model wrote itself a FOURTEEN step test
 * plan, ran it, and passed — because every search it tried used the exact
 * capitalisation already in the note. `search "First"` against a note
 * containing "First" passes whether or not the bug exists. It tested that the
 * code does what the code does.
 *
 * Asking it to "verify against the README" is the move that has never worked.
 * So the harness reads the README itself and hands over two lists it derived:
 * the promises the document makes, and the documented commands that were never
 * run. Extraction and comparison are the harness's job; only the demonstrating
 * is left to the model.
 */

/** Fenced (```) and 4-space-indented blocks — where a README puts its commands. */
function codeBlocks(readme: string): string[] {
  const out: string[] = [];
  for (const m of readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  /* Indented blocks: runs of lines starting with 4 spaces or a tab, outside a
   * fence (fences are stripped first so their inner indentation is not re-read). */
  const withoutFences = readme.replace(/```[\s\S]*?```/g, '');
  let run: string[] = [];
  for (const line of withoutFences.split('\n')) {
    if (/^(?: {4}|\t)\S/.test(line)) {
      run.push(line.trim());
      continue;
    }
    if (run.length > 0) {
      out.push(run.join('\n'));
      run = [];
    }
  }
  if (run.length > 0) out.push(run.join('\n'));
  return out;
}

/** Prose, not a command: sentence-shaped, or a comment/output line. */
function looksLikeProse(line: string): boolean {
  if (line.length === 0 || line.length > 120) return true;
  if (/^[#>$%]/.test(line)) return line.startsWith('$') || line.startsWith('%') ? false : true;
  if (/[.!?]$/.test(line)) return true;
  // A command has few words and no sentence capitalisation mid-line.
  return line.split(/\s+/).length > 8;
}

/**
 * The commands a README shows the reader. Leading `$`/`%` prompts are stripped
 * so a documented `$ notes list` matches a run of `notes list`.
 */
export function documentedCommands(readme: string): string[] {
  const seen = new Set<string>();
  for (const block of codeBlocks(readme)) {
    for (const raw of block.split('\n')) {
      const line = raw.trim().replace(/^[$%]\s*/, '');
      if (looksLikeProse(line)) continue;
      seen.add(line);
    }
  }
  return [...seen].slice(0, 12);
}

/**
 * The distinctive token of a command — its subcommand, or the script name when
 * there is no subcommand. `notes add "buy milk"` → `add`. Used to recognise a
 * documented command inside a real invocation, which is never spelled the same
 * (`python3 notes.py add "buy milk"`).
 */
function distinctiveToken(command: string): string | null {
  const words = command.split(/\s+/).filter((w) => w.length > 0 && !w.startsWith('-'));
  const [first, second] = words;
  if (second !== undefined && /^[a-z][\w-]*$/i.test(second)) return second;
  return first ?? null;
}

/** Documented commands with no matching invocation in what actually ran. */
export function unrunCommands(readme: string, ranCommands: readonly string[]): readonly string[] {
  const ran = ranCommands.join('\n').toLowerCase();
  if (ran.length === 0) return documentedCommands(readme);
  return documentedCommands(readme).filter((cmd) => {
    const token = distinctiveToken(cmd);
    return token !== null && !ran.includes(token.toLowerCase());
  });
}

/*
 * Words that turn a sentence into a PROMISE — something the code must do that
 * running it once will not reveal. "Searching is case-insensitive" is the whole
 * reason this list exists; the rest are the same shape.
 */
const PROMISE = new RegExp(
  [
    'case[- ]insensitive',
    'case[- ]sensitive',
    '\\bignores?\\b',
    '\\bsorted\\b',
    '\\bvalidates?\\b',
    '\\bmust\\b',
    '\\balways\\b',
    '\\bnever\\b',
    '\\bdefaults? to\\b',
    '\\bprints?\\b',
    '\\breturns?\\b',
    '\\bshould\\b',
    '\\bautomatically\\b',
    '\\bpreserv(?:e|es|ing)\\b',
    '\\bskips?\\b',
    '\\brejects?\\b',
  ].join('|'),
  'i',
);

/** Sentences in a README that assert behaviour rather than describe the project. */
export function documentedPromises(readme: string): readonly string[] {
  const prose = readme
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^(?: {4}|\t)\S.*$/gm, ' ')
    .replace(/^#+.*$/gm, ' ');
  const out: string[] = [];
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n{2,}/)) {
    const s = sentence.replace(/\s+/g, ' ').trim();
    if (s.length < 12 || s.length > 160) continue;
    if (!PROMISE.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 8);
}

/**
 * The steer, or null when the README promises nothing checkable and every
 * documented command was run. Silence is the common case and must stay cheap.
 */
export function undemonstrated(
  readme: string | null,
  ranCommands: readonly string[],
  touchedFiles: readonly string[] = ['x'],
): string | null {
  /* A turn that wrote nothing has no product to hold against the document —
   * asking it about README promises would be noise on a plain question. */
  if (touchedFiles.length === 0) return null;
  if (readme === null || readme.trim().length === 0) return null;
  const promises = documentedPromises(readme);
  const unrun = unrunCommands(readme, ranCommands);
  if (promises.length === 0 && unrun.length === 0) return null;

  const out: string[] = [
    'THE README IS PART OF THE SPEC, AND IT HAS NOT BEEN CHECKED.',
    '',
    'Working code that quietly disagrees with its own documentation looks exactly',
    'like working code. Running it once cannot tell the difference — you have to',
    'test the promise, with an input chosen to break it.',
  ];
  if (promises.length > 0) {
    out.push('', 'The README promises:');
    for (const p of promises) out.push(`  - ${p}`);
    out.push(
      '',
      'Demonstrate each one with a command whose output PROVES it, choosing input',
      'that would fail if the promise were broken — not input that passes either way.',
    );
  }
  if (unrun.length > 0) {
    out.push('', 'These documented commands were never run:');
    for (const c of unrun) out.push(`  ${c}`);
  }
  return out.join('\n');
}

/** The README of a workspace, or null. Case is not consistent across projects. */
export function readmeIn(
  root: string | null | undefined,
  read: (file: string) => string | null = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  list: (dir: string) => readonly string[] = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
): string | null {
  if (root === null || root === undefined || root.length === 0) return null;
  const name = list(root).find((f) => /^readme(\.(md|txt|rst))?$/i.test(f));
  return name === undefined ? null : read(path.join(root, name));
}

/**
 * WHERE THE WORK ACTUALLY IS.
 *
 * Three candidate roots, and two of them are wrong in the case that matters.
 * MEASURED from a real run's session log:
 *
 *   session cwd : /Users/user                          ← HOME
 *   touched     : ~/bobble-testbed/notesapp/notes.py   ← the project
 *
 * `runtime.workspaceRoot` is null unless someone issued `/harness workspace`,
 * and `ctx.cwd` is HOME (task #19 — the model is told its cwd is HOME while its
 * tools write elsewhere). Reading a README from either would find nothing, or
 * find the user's own HOME README and treat it as this project's spec.
 *
 * The files the turn EDITED cannot lie about where the work is. `~` is expanded
 * because the model writes tilde paths constantly and every layer that forgot
 * has cost a run.
 *
 * HOME is refused outright as a root: a README sitting there belongs to the
 * person, not to the thing being built.
 */
export function workRootOf(
  touchedFiles: readonly string[],
  workspaceRoot?: string | null,
  cwd?: string | null,
  home: string = os.homedir(),
): string | null {
  for (const file of touchedFiles) {
    if (typeof file !== 'string' || file.length === 0) continue;
    const expanded = file.startsWith('~') ? path.join(home, file.slice(1)) : file;
    const dir = path.dirname(path.resolve(expanded));
    if (dir !== home && dir !== '.' && dir !== '/') return dir;
  }
  for (const root of [workspaceRoot, cwd]) {
    if (root === null || root === undefined || root.length === 0) continue;
    const expanded = root.startsWith('~') ? path.join(home, root.slice(1)) : root;
    const resolved = path.resolve(expanded);
    if (resolved !== home) return resolved;
  }
  return null;
}
