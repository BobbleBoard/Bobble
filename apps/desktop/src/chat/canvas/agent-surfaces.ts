/**
 * The ONE definition of how an agent's live work is shown on a canvas surface —
 * shared by the normal chat's routers and the corp (multi-agent) router.
 *
 * the user, having watched a run: "make sure first and foremost that these are
 * totally in sync, you can change something about one and it reflects on the
 * other ... use the regular chat thing, not the subagents thing, as the good
 * starting point." They were two implementations of the same idea that had
 * drifted — the chat mirrored a command one way, the corp another, and a fix to
 * either left the other exactly as wrong as before.
 *
 * So the primitives live here, and both routers import them. There is no corp
 * spelling of a terminal mirror any more; there is one spelling.
 */

/**
 * Patterns that mark a command as interactive or long-running enough to warrant
 * a live terminal of its own in the normal chat. Deliberately narrow so a
 * routine `ls` / `git status` never pops a terminal — only clearly persistent or
 * interactive processes do.
 */
const INTERACTIVE_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|watch|serve|preview)\b/,
  /\bvite\b/,
  /\bnodemon\b/,
  /\bwebpack(?:-dev-server)?\b/,
  /\bnext\s+(?:dev|start)\b/,
  /\b(?:tail|watch|top|htop|less|vim|nano|ssh|irb|psql)\b/,
  /\btail\s+-f\b/,
  /--watch\b/,
  /\bpython3?\s+-m\s+http\.server\b/,
  /\bhttp-server\b/,
  /\bjest\s+--watch\b/,
  /\bdocker\s+(?:run|compose\s+up)\b/,
  /&\s*$/,
];

/** True when a bash command is interactive / long-running (→ live terminal). */
export function isInteractiveCommand(command: string): boolean {
  const c = command.trim();
  if (c === '') return false;
  return INTERACTIVE_PATTERNS.some((re) => re.test(c));
}

/**
 * The xterm text for one command in a mirror terminal: the prompt line, then its
 * output, exactly as it looked in the shell.
 *
 * A RUNNING command is its prompt line and nothing else — which is what a real
 * terminal shows while a command is working, and, more usefully, means the text
 * only ever GROWS as output arrives. That is what lets the mirror append rather
 * than reset and rewrite itself (see native-surfaces' `#writeMirror`), so it
 * reads as typing instead of a screen rebuilding on every tick.
 *
 * A FINISHED command that printed nothing says so — a different fact from "still
 * going", and one the corp's own copy of this function used to get wrong: every
 * quiet `mkdir` sat there claiming to be running forever.
 */
/** ANSI SGR: the mirror is an xterm, so colour is a byte sequence, not CSS. */
const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
} as const;

/** Strip the colour the mirror adds (its own SGR sequences), for tests and titles. */
export function plainMirrorText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are control characters by definition
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export function mirrorCommandText(
  command: string,
  output: string,
  running: boolean,
  cwd?: string,
  opts: { failed?: boolean; executing?: boolean } = {},
): string {
  /*
   * A REAL PROMPT LINE, not a bare `$`. the user: "would be appreciated if you can
   * show in the terminal something like the user being 'bobble' and the
   * directory ... this removes confusion about the initial working directory."
   *
   * That confusion is real and has cost runs: the model is told its cwd is the
   * home directory while its tools resolve to the workspace, and a bare `$` in
   * the mirror gave the reader nothing to check it against. Showing where the
   * command actually ran makes the answer visible instead of inferred.
   */
  /*
   * COLOUR-CODED, like the shell it mirrors. the user (2026-09-12): "need color
   * coded text in the terminal in the canvas." The mirror is an xterm, but
   * what reached it was flat text: a plain prompt, the command, and output
   * from tools that saw a pipe and printed no colour. So the prompt is the
   * shell's own colouring (user green, folder blue, a dim `$`, the command
   * bold), a failed command's output is red, and a quiet one says so dimly.
   * Output that carries its own escapes (a tool that colours regardless)
   * passes through untouched — xterm renders it.
   */
  const where = cwd !== undefined && cwd.length > 0 ? shortCwd(cwd) : '';
  const prompt =
    where === ''
      ? `${SGR.dim}$${SGR.reset}`
      : `${SGR.bold}${SGR.green}bobble${SGR.reset} ${SGR.bold}${SGR.blue}${where}${SGR.reset} ${SGR.dim}$${SGR.reset}`;
  const line = `${prompt} ${SGR.bold}${command}`;
  /*
   * A command with nothing printed yet is left as an OPEN line — no reset, no
   * newline — because it may still be being typed: a bash call's `command`
   * streams in with its arguments, and each tick used to close the line
   * (`echo`⏎⏎, then `echo hello`⏎⏎, …), so the text was never an extension of
   * the previous one and the xterm rebuilt itself per keystroke — SEEN
   * 2026-09-13 as four half-typed `$ echo …` lines stacked up for one command.
   * Left open, the next characters append, exactly as typing does.
   */
  if (running && output.length === 0 && opts.executing !== true) return line;
  /*
   * ENTER, THE MOMENT THE COMMAND IS COMPLETE. the user (2026-09-17): "when the
   * model's command finishes streaming in the terminal move the cursor down a
   * line and stream in the response … as it would appear in a terminal, this
   * immediate moving down a line as if the user pressed enter is purely
   * aesthetic." So a command whose arguments have arrived and which is now
   * executing closes its line at once — the cursor sits at the start of the
   * next one while the output is still on its way — and the output, when it
   * comes, lands right under the prompt line the way a shell prints it (no
   * blank line in between; a terminal has none). While it is still coming
   * the text ends where the output ends, so each chunk extends the last.
   */
  const head = `${line}${SGR.reset}\n`;
  if (running && output.length === 0) return head;
  if (output.length > 0) {
    const body = opts.failed === true ? `${SGR.red}${output}${SGR.reset}` : output;
    return running ? `${head}${body}` : `${head}${body}\n`;
  }
  return `${head}${SGR.dim}(no output)${SGR.reset}\n`;
}

/** The tail of a path, the way a shell prompt shows it: `~` for home, else the
 * last segment. A full absolute path in a prompt is noise. */
export function shortCwd(cwd: string): string {
  const home = typeof process !== 'undefined' ? (process.env?.HOME ?? '') : '';
  if (home !== '' && cwd === home) return '~';
  const trimmed = cwd.replace(/\/+$/, '');
  const seg = trimmed.split('/').filter(Boolean).pop();
  return seg ?? trimmed;
}

/** First few words of a command, clipped — a terminal tab's short title. */
export function shortCommandTitle(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 3).join(' ');
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}
