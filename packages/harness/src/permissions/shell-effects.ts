/**
 * WHAT A SHELL LINE CAN TOUCH, READ FROM ITS TEXT.
 *
 * The reviewer asks a model about any bash command it cannot vouch for itself,
 * and the model is a poor judge of a path it does not recognise. MEASURED
 * (2026-10-01, Ling 3.0 Tiny, the visual-learner student run, reproduced
 * verbatim against the same model): three "Run this command?" cards for
 * commands that only listed or wrote the chat's own folder —
 *
 *   bash -c 'ls -la <chat>/ 2>&1'
 *     "lists the contents of a private system path … a restricted directory"
 *   bash -c 'cat > <chat>/area_circle_visual.svg << "EOF" …
 *     "DANGER - writes a large SVG file to a temporary directory with a
 *      suspicious name"
 *   ls -la <chat>/circle_area_explanation.svg 2>/dev/null && echo … || echo …
 *     "Checks if a specific SVG file exists in a temporary directory."
 *
 * The read-only shortcut in flag-bash.ts let none of them past, because each
 * carries shell syntax (`2>&1`, `<<`, `&&`) and the shortcut refused ANY.
 *
 * This reads that syntax instead of refusing it. It is a reader, not a shell:
 * quoting, redirections, heredocs, `&&` `||` `;` `|` `&`, `cd`, `bash -c '…'`,
 * and a short list of commands whose effects are known. Everything else — a
 * command not on the list, `$(…)`, a subshell, an assignment, a loop — makes
 * {@link shellEffects} answer null, and null means "ask the model", exactly as
 * before. It can only ever SKIP a review for a command it read all the way
 * through.
 *
 * What it reports is the WRITES: every path the line can create, change, move
 * or remove. Reads are not reported, on purpose — the reviewer never gated a
 * read (the `read` tool and a plain `cat` were always let through), so a read
 * behind `2>&1` is no different from one without it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** What a command can do to the filesystem, as far as its text tells. */
export interface ShellEffects {
  /**
   * Absolute paths the line can create, change, move or remove. Written as the
   * line names them, `~` and the working folder filled in — not yet resolved
   * through symlinks; {@link writesStayInside} does that.
   */
  readonly writes: readonly string[];
}

export interface ShellEffectsOptions {
  /** The directory the command starts in (the bash tool's own cwd). */
  readonly cwd: string;
  /** HOME, for `~`. */
  readonly home: string;
}

/**
 * Every path `command` can write, or null when the text holds anything this
 * reader cannot vouch for. Never throws.
 */
export function shellEffects(command: string, opts: ShellEffectsOptions): ShellEffects | null {
  const writes: string[] = [];
  try {
    readScript(command, { cwds: [opts.cwd], home: opts.home, writes }, 0);
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
  return { writes };
}

/**
 * Do all of `writes` land inside `roots`, through every symlink on the way?
 *
 * Both sides are resolved as the kernel would resolve them, which is what
 * makes the measured `/private/var/folders/…` path the same folder as the
 * `/var/folders/…` the app named it by — and what stops `<chat>/link/x` from
 * counting as the chat's when `link` points at /etc.
 *
 * A root that is HOME, or holds it, is not a chat's folder whatever the app
 * set: with such a root `~/.zshrc` would count as the chat's own file.
 */
export function writesStayInside(
  writes: readonly string[],
  roots: readonly string[],
  home: string,
): boolean {
  const homeReal = physicalPath(path.resolve(home));
  const own = roots
    .map((root) => physicalPath(path.resolve(root)))
    .filter((root) => !contains(root, homeReal));
  if (own.length === 0) return false;
  return writes.every((write) => {
    const real = physicalPath(write);
    return own.some((root) => contains(root, real)) && !sharedInode(real);
  });
}

/**
 * `abs` with every existing component resolved through its symlinks, `..`
 * taken from the resolved parent as the kernel does. Components that do not
 * exist yet — the file about to be written — are kept as written.
 */
export function physicalPath(abs: string): string {
  let current = path.parse(abs).root;
  for (const part of abs.split(path.sep)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    try {
      current = fs.realpathSync.native(next);
    } catch {
      current = next;
    }
  }
  return current;
}

function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * A file with more than one name. Writing it changes the other names too — a
 * hard link into the folder (pnpm's store links node_modules this way) is
 * not the chat's to rewrite without asking.
 */
function sharedInode(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() && stat.nlink > 1;
  } catch {
    return false;
  }
}

// --- reading the text -------------------------------------------------------

/** Raised inside the reader when the text holds something it cannot vouch for. */
class Unreadable extends Error {}

function unreadable(why: string): never {
  throw new Unreadable(why);
}

/** One word, quotes removed, with what the shell will still do to it. */
interface Word {
  readonly text: string;
  /** Holds `$NAME`, `${…}` or `$'…'`: what runs is not this text. */
  readonly expands: boolean;
  /** Holds an unquoted `*`, `?`, `[` or `{`: the shell may make it other words. */
  readonly pattern: boolean;
  /** Starts with an unquoted `~`. */
  readonly tilde: boolean;
  /** Any part of it was quoted or escaped (a heredoc tag so written is literal). */
  readonly quoted: boolean;
}

type Token =
  | { readonly kind: 'word'; readonly word: Word }
  | { readonly kind: 'op'; readonly op: string }
  | { readonly kind: 'redir'; readonly op: string };

/** Characters that end an unquoted word. */
const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);

/** Redirection operators, longest first. */
const REDIRECTIONS = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>|', '>&', '>'];

interface PendingHeredoc {
  readonly tag: string;
  readonly stripTabs: boolean;
  readonly literal: boolean;
}

/**
 * Split shell text into words, operators and redirections, reading heredoc
 * bodies as it passes them.
 *
 * AN UNFINISHED LINE IS READ AS IF IT WERE FINISHED. The measured heredoc was
 * cut off mid-attribute — no `EOF` line, no closing quote — and bash refused it
 * outright ("unexpected EOF while looking for matching `''"), running nothing.
 * Closing the quote at the end can only ADD to what the reader thinks runs:
 * bash runs the complete lines before an unclosed quote and nothing from the
 * line it opens on, and runs an unclosed heredoc with its body cut at the end
 * of the text. So the finished reading covers everything bash could do.
 */
function lex(src: string): Token[] {
  const out: Token[] = [];
  let pending: PendingHeredoc[] = [];
  let tagFor: { stripTabs: boolean } | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '\n') {
      if (tagFor !== null) unreadable('a heredoc with no tag');
      out.push({ kind: 'op', op: '\n' });
      i = readHeredocs(src, i + 1, pending);
      pending = [];
      continue;
    }
    if (c === '(' || c === ')') unreadable('a subshell or group');
    const redirection = readRedirection(src, i);
    if (redirection !== null) {
      if (tagFor !== null) unreadable('a heredoc with no tag');
      out.push({ kind: 'redir', op: redirection.op });
      if (redirection.op === '<<' || redirection.op === '<<-') {
        tagFor = { stripTabs: redirection.op === '<<-' };
      }
      i = redirection.next;
      continue;
    }
    const op = readOperator(src, i);
    if (op !== null) {
      if (tagFor !== null) unreadable('a heredoc with no tag');
      out.push({ kind: 'op', op });
      i += op.length;
      continue;
    }
    const { word, next } = readWord(src, i);
    if (tagFor !== null) {
      pending.push({ tag: word.text, stripTabs: tagFor.stripTabs, literal: word.quoted });
      tagFor = null;
    }
    out.push({ kind: 'word', word });
    i = next;
  }
  if (tagFor !== null) unreadable('a heredoc with no tag');
  return out;
}

/** A redirection at `i`, with the file-descriptor digits written before it. */
function readRedirection(src: string, i: number): { op: string; next: number } | null {
  for (const op of ['&>>', '&>']) {
    if (src.startsWith(op, i)) return { op, next: i + op.length };
  }
  let j = i;
  while (/[0-9]/.test(src[j] ?? '')) j += 1;
  for (const op of REDIRECTIONS) {
    if (src.startsWith(op, j)) return { op, next: j + op.length };
  }
  return null;
}

function readOperator(src: string, i: number): string | null {
  for (const op of ['&&', '||', '|&', ';;', ';&', '|', ';', '&']) {
    if (!src.startsWith(op, i)) continue;
    if (op === ';;' || op === ';&') unreadable('a case clause');
    return op;
  }
  return null;
}

/** Read heredoc bodies starting at `i` (the line after their command). */
function readHeredocs(src: string, i: number, pending: readonly PendingHeredoc[]): number {
  let at = i;
  for (const heredoc of pending) {
    let body = '';
    while (at < src.length) {
      const end = src.indexOf('\n', at);
      const line = src.slice(at, end < 0 ? src.length : end);
      at = end < 0 ? src.length : end + 1;
      const compared = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (compared === heredoc.tag) break;
      body += `${line}\n`;
    }
    // An unquoted tag means the body is expanded as it is fed in, and a `$(…)`
    // or backtick there RUNS. Escaped or not, it is not this reader's to judge.
    if (!heredoc.literal && /\$\(|\$\[|`|\$\{[^}]*\[/.test(body)) {
      unreadable('a command substitution in a heredoc');
    }
  }
  return at;
}

function readWord(src: string, start: number): { word: Word; next: number } {
  let text = '';
  let expands = false;
  let pattern = false;
  let quoted = false;
  const tilde = src[start] === '~';
  let i = start;
  while (i < src.length && !META.has(src[i] ?? '')) {
    const c = src[i] ?? '';
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < src.length) text += src[i + 1];
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      text += src.slice(i + 1, stop);
      quoted = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      const inner = readDoubleQuoted(src, i + 1);
      text += inner.text;
      expands ||= inner.expands;
      quoted = true;
      i = inner.next;
      continue;
    }
    if (c === '`') unreadable('a command substitution');
    if (c === '$') {
      if (src[i + 1] === "'") {
        // $'…' — C-style escapes. Not decoded here, so its text is not trusted.
        let j = i + 2;
        while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
        text += src.slice(i, Math.min(j + 1, src.length));
        expands = true;
        quoted = true;
        i = j + 1;
        continue;
      }
      if (src[i + 1] === '"') {
        const inner = readDoubleQuoted(src, i + 2);
        text += inner.text;
        expands = true;
        quoted = true;
        i = inner.next;
        continue;
      }
      const after = skipExpansion(src, i);
      if (after !== null) {
        text += src.slice(i, after);
        expands = true;
        i = after;
        continue;
      }
    }
    if (c === '*' || c === '?' || c === '[' || c === '{') pattern = true;
    text += c;
    i += 1;
  }
  return { word: { text, expands, pattern, tilde, quoted }, next: i };
}

/** The inside of "…" from `i` (just past the opening quote). */
function readDoubleQuoted(
  src: string,
  start: number,
): { text: string; expands: boolean; next: number } {
  let text = '';
  let expands = false;
  let i = start;
  while (i < src.length && src[i] !== '"') {
    const c = src[i] ?? '';
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n') {
        i += 2;
        continue;
      }
      if (n === '$' || n === '`' || n === '"' || n === '\\') {
        text += n;
        i += 2;
        continue;
      }
      text += c;
      i += 1;
      continue;
    }
    if (c === '`') unreadable('a command substitution');
    if (c === '$') {
      const after = skipExpansion(src, i);
      if (after !== null) {
        text += src.slice(i, after);
        expands = true;
        i = after;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  return { text, expands, next: i + 1 };
}

/**
 * At a `$`: the index after the expansion it starts, or null for a `$` that is
 * just a character. A substitution — `$(…)`, `$((…))`, `$[…]` — runs code, so
 * it ends the reading; so does a `${…}` with a subscript, whose arithmetic can.
 *
 * A QUOTE INSIDE `${…}` ENDS IT TOO. bash nests quoting there
 * (`${x:-"}"}` is one expansion), and a reader that closed the expansion at
 * the quoted `}` would then open a string at the next `"` and swallow the rest
 * of the line as text — `; rm …` included. Not following it is the safe side.
 */
function skipExpansion(src: string, i: number): number | null {
  const n = src[i + 1] ?? '';
  if (n === '(' || n === '[') unreadable('a command or arithmetic substitution');
  if (n === '{') {
    let depth = 1;
    let j = i + 2;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === '`' || c === '[' || (c === '$' && src[j + 1] === '(')) {
        unreadable('a substitution inside a parameter expansion');
      }
      if (c === '"' || c === "'" || c === '\\') unreadable('quoting inside a parameter expansion');
      if (c === '{' && src[j - 1] === '$') depth += 1;
      if (c === '}') depth -= 1;
      j += 1;
    }
    if (depth > 0) unreadable('an unclosed parameter expansion');
    return j;
  }
  if (/[A-Za-z_]/.test(n)) {
    let j = i + 2;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j] ?? '')) j += 1;
    return j;
  }
  if (/[0-9@*#?$!-]/.test(n)) return i + 2;
  return null;
}

// --- what each command does -------------------------------------------------

interface Redirect {
  readonly op: string;
  readonly target: Word;
}

interface SimpleCommand {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  /** Alone in its pipeline and not sent to the background: a `cd` here sticks. */
  readonly standalone: boolean;
}

function parse(tokens: readonly Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let pipeline: { words: Word[]; redirects: Redirect[] }[] = [];
  let current: { words: Word[]; redirects: Redirect[] } = { words: [], redirects: [] };
  const endPipeline = (background: boolean): void => {
    pipeline.push(current);
    const standalone = pipeline.length === 1 && !background;
    for (const command of pipeline) {
      if (command.words.length > 0 || command.redirects.length > 0) {
        commands.push({ ...command, standalone });
      }
    }
    pipeline = [];
    current = { words: [], redirects: [] };
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token === undefined) break;
    if (token.kind === 'word') {
      current.words.push(token.word);
      continue;
    }
    if (token.kind === 'redir') {
      const target = tokens[k + 1];
      if (target?.kind !== 'word') unreadable('a redirection with no target');
      current.redirects.push({ op: token.op, target: target.word });
      k += 1;
      continue;
    }
    if (token.op === '|' || token.op === '|&') {
      pipeline.push(current);
      current = { words: [], redirects: [] };
      continue;
    }
    endPipeline(token.op === '&');
  }
  endPipeline(false);
  return commands;
}

interface State {
  /** Every directory the shell can be in at this point (a `cd` can fail). */
  cwds: string[];
  readonly home: string;
  readonly writes: string[];
}

/** How deep `bash -c 'bash -c …'` is followed before the reader gives up. */
const MAX_SHELL_DEPTH = 3;

function readScript(src: string, state: State, depth: number): void {
  if (depth > MAX_SHELL_DEPTH) unreadable('shells nested too deep');
  for (const command of parse(lex(src))) runCommand(command, state, depth);
}

/** Words that open a compound command, or change what the next word means. */
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  'coproc',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

/**
 * Commands that read files, or nothing at all, and have no option that writes,
 * deletes or runs anything. Their arguments can be anything, `$VAR` included —
 * the worst an argument can do here is name another file to read.
 *
 * Deliberately short. `git` is absent (`git reset --hard`, `git push --force`),
 * so are `sed` (`-i`, and `w` writes a file) and `awk` (`system()`); `find` and
 * `sort` are below, read with the options that make them write refused.
 */
const READS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'du',
  'df',
  'grep',
  'egrep',
  'fgrep',
  'diff',
  'cmp',
  'realpath',
  'readlink',
  'md5',
  'md5sum',
  'shasum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'cut',
  'tr',
  'nl',
  'rev',
  'fold',
  'column',
  'paste',
  'comm',
  'od',
  'hexdump',
  'strings',
  'echo',
  'true',
  'false',
  ':',
  'test',
  '[',
  'pwd',
  'sleep',
  'date',
  'whoami',
  'uname',
  'id',
  'which',
  'type',
  'basename',
  'dirname',
  'printenv',
  'set',
  'exit',
  /*
   * `web search …` / `web fetch …` — the app's own web tools in CLI mode, and
   * both only READ. MEASURED on a real research turn (2026-09-24, qwen3.5-4b on
   * rapid-mlx, whose exact prefix cache keeps TWO entries): three `web` calls in
   * one message made three reviews, the conversation's entry was evicted, and
   * the next two requests re-read 4,036 and 5,181 tokens from cold. Research is
   * a run of these; none of them needs a second opinion.
   */
  'web',
]);

/**
 * Reads with an option that does not read. Any argument matching is enough to
 * send the command to the model, and so is any `$VAR`, glob or brace — each
 * can expand into one (`find . {-delete,}` is `find . -delete`).
 */
const READS_EXCEPT: Readonly<Record<string, RegExp>> = {
  // Actions that delete, run, or write a file of their own.
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  // An output file, a temp dir, a decompressor to run.
  sort: /^-[^-]*[oT]|^--(?:output|temporary-directory|compress-program)/,
  // A preprocessor command run on every file.
  rg: /^--pre/,
  // Compiles a magic file next to the one named.
  file: /^-[^-]*C|^--compile/,
};

/** Write targets that are not files. */
const SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** Shells whose `-c '…'` script is read in turn. Not zsh: its expansions differ. */
const SHELLS = new Set(['bash', 'sh']);
/** Single-letter shell options that change nothing about what the script does. */
const SHELL_FLAGS = new Set(['c', 'e', 'l', 'u', 'x', 'v']);

function runCommand(command: SimpleCommand, state: State, depth: number): void {
  for (const redirect of command.redirects) redirection(redirect, state);
  const [head, ...args] = command.words;
  // A bare redirection — `> file` — writes the file; that is all it does.
  if (head === undefined) return;
  const name = commandName(head);

  if (READS.has(name)) return;
  const except = READS_EXCEPT[name];
  if (except !== undefined) {
    for (const arg of args) {
      if (arg.expands || arg.pattern || except.test(arg.text)) unreadable(`${name} ${arg.text}`);
    }
    return;
  }

  switch (name) {
    case 'printf': {
      // `printf -v NAME` assigns a variable — `printf -v PATH …` would change
      // what every later command on the line runs. Options only come first.
      const first = args[0];
      if (first !== undefined && (first.expands || first.pattern || first.text.startsWith('-v'))) {
        unreadable('printf assigning a variable');
      }
      return;
    }
    case 'env':
      // Alone it prints the environment; with anything after it, it can RUN
      // that (`env cmd`, and `env -S'cmd'` too).
      if (args.length > 0) unreadable('env running a command');
      return;
    case 'mkdir':
    case 'touch':
    case 'tee':
    case 'uniq':
      // Every operand is taken as a write — for uniq the second one is
      // (`uniq in out`), and an option's value just lands in the folder too.
      for (const arg of args) if (arg.pattern) unreadable(`${name} ${arg.text}`);
      for (const arg of operands(args)) writeTarget(arg, state);
      return;
    case 'cp':
      copy(args, state);
      return;
    case 'mv':
      move(args, state);
      return;
    case 'cd':
      changeDirectory(args, state, command.standalone);
      return;
    default:
      if (!SHELLS.has(name)) unreadable(`an unknown command: ${name}`);
      readScript(shellScript(args), { ...state, cwds: [...state.cwds] }, depth + 1);
  }
}

function commandName(word: Word): string {
  // A lone `[` is `test`, not a glob: with no `]` after it, bash leaves it be.
  const glob = word.pattern && word.text !== '[';
  if (word.expands || glob || word.tilde) unreadable('a command name the shell rewrites');
  if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.text)) unreadable('a variable assignment');
  if (KEYWORDS.has(word.text)) unreadable(`the keyword ${word.text}`);
  const system = /^\/(?:usr\/)?bin\/([^/]+)$/.exec(word.text);
  if (system !== null) return system[1] ?? '';
  if (word.text.includes('/')) unreadable('a program named by its path');
  return word.text;
}

function redirection(redirect: Redirect, state: State): void {
  const { op, target } = redirect;
  // bash opens a network connection for these, whichever way the arrow points.
  if (/^\/dev\/(?:tcp|udp)\//.test(target.text)) unreadable('a network redirection');
  switch (op) {
    case '<':
    case '<<':
    case '<<-':
    case '<<<':
      // A read, a heredoc's tag (its body was checked as it was read), a string.
      return;
    case '<&':
    case '>&':
      // `2>&1`, `>&2`, `<&-`: descriptors, not files. `>&file` writes the file.
      if (!target.expands && /^(?:\d+|-)$/.test(target.text)) return;
      if (op === '<&') unreadable('a descriptor the shell rewrites');
      writeTarget(target, state);
      return;
    default:
      // > >> >| <> &> &>>
      writeTarget(target, state);
  }
}

/** Arguments that are not options (`--` ends the options; `-` alone is stdin). */
function operands(args: readonly Word[]): Word[] {
  const out: Word[] = [];
  let options = true;
  for (const arg of args) {
    if (arg.expands) unreadable('an argument the shell rewrites');
    if (options && arg.text === '--') {
      options = false;
      continue;
    }
    if (options && arg.text.startsWith('-') && arg.text !== '-') continue;
    out.push(arg);
  }
  return out;
}

/** Where a path argument lands: once per directory the shell may be in. */
function landings(word: Word, state: State): string[] {
  let text = word.text;
  if (word.tilde) {
    if (text === '~') text = state.home;
    else if (text.startsWith('~/')) text = `${state.home}/${text.slice(2)}`;
    else unreadable('another user’s home');
  }
  if (text.length === 0) return [];
  if (path.isAbsolute(text)) return [text];
  // Joined as text, not path.join: `..` must reach physicalPath unresolved.
  return state.cwds.map((cwd) => `${cwd}/${text}`);
}

function writeTarget(word: Word, state: State): void {
  if (word.expands || word.pattern) unreadable('a write the shell rewrites');
  if (SINKS.has(word.text)) return;
  state.writes.push(...landings(word, state));
}

/**
 * Options that make cp/mv link instead of copy, or write somewhere other than
 * the last operand. A pattern is refused outright for the same reason: a file
 * named `-l` turns `cp * out/` into `cp -l …`.
 */
const COPY_UNREADABLE = /^-[^-]*[lstS]|^--(?:link|symbolic-link|target-directory|suffix)/;
const MOVE_UNREADABLE = /^-[^-]*[tS]|^--(?:target-directory|suffix)/;

function fileArguments(name: string, args: readonly Word[], refused: RegExp): Word[] {
  for (const arg of args) {
    if (arg.pattern || refused.test(arg.text)) unreadable(`${name} ${arg.text}`);
  }
  const files = operands(args);
  if (files.length < 2) unreadable(`${name} without a destination`);
  return files;
}

/** `cp … DEST`: the sources are read, the last operand is written. */
function copy(args: readonly Word[], state: State): void {
  const dest = fileArguments('cp', args, COPY_UNREADABLE).at(-1);
  if (dest !== undefined) writeTarget(dest, state);
}

/** `mv … DEST`: every operand changes — the sources leave where they were. */
function move(args: readonly Word[], state: State): void {
  for (const file of fileArguments('mv', args, MOVE_UNREADABLE)) writeTarget(file, state);
}

/**
 * `cd DIR` moves what a relative path means for the rest of the line. It can
 * fail, so the directory before it stays possible too; inside a pipeline or in
 * the background it does not stick at all, and that is not followed.
 *
 * With CDPATH set, bash looks a bare `cd name` up there before the current
 * directory, so only an explicit path (`/…`, `./…`, `../…`, `~/…`) is followed.
 */
function changeDirectory(args: readonly Word[], state: State, standalone: boolean): void {
  if (!standalone) unreadable('a cd that does not stick');
  if (args.some((arg) => arg.text.startsWith('-'))) unreadable('cd with an option, or cd -');
  const dirs = operands(args);
  if (dirs.length > 1) unreadable('cd with more than one directory');
  const dir = dirs[0];
  if (dir?.pattern === true) unreadable('cd to a pattern');
  const searched = dir !== undefined && !dir.tilde && !/^\.{0,2}(?:\/|$)/.test(dir.text);
  if (searched && (process.env.CDPATH ?? '') !== '') unreadable('cd through CDPATH');
  const targets =
    dir === undefined ? [state.home] : landings(dir, state).map((landing) => path.resolve(landing));
  state.cwds = Array.from(new Set([...targets, ...state.cwds]));
}

/** The script of `bash -c '…'`, or unreadable for any other way to run a shell. */
function shellScript(args: readonly Word[]): string {
  let sawC = false;
  let k = 0;
  for (; k < args.length; k += 1) {
    const arg = args[k];
    if (arg === undefined || arg.expands || arg.pattern) break;
    if (['--login', '--noprofile', '--norc', '--posix'].includes(arg.text)) continue;
    if (!/^-[a-zA-Z]+$/.test(arg.text)) break;
    if (![...arg.text.slice(1)].every((flag) => SHELL_FLAGS.has(flag))) {
      unreadable(`a shell option: ${arg.text}`);
    }
    if (arg.text.includes('c')) sawC = true;
  }
  if (!sawC) unreadable('a shell reading a file or stdin');
  const script = args[k];
  if (script === undefined || script.expands || script.pattern) {
    unreadable('a script the outer shell rewrites');
  }
  return script.text;
}
