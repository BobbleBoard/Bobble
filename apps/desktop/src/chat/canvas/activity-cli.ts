/**
 * IS THIS LINE A SHELL COMMAND, OR IS IT ONE OF OUR TOOLS WEARING A COMMAND?
 *
 * In tool-CLI mode every tool is a command on PATH — `mac snapshot`, `media
 * generate image "a fox"`, `file write notes.md` — and they all arrive through
 * the SAME `bash` tool call as a genuine `ls -la`. the user, on the Activity tab:
 * "bash command? (once verified they aren't a special cli tool, so if they
 * don't start with any registered tools) shows up in a terminal".
 *
 * So this is the gate the terminal sits behind. A `media generate` line is the
 * media tool doing its job and belongs nowhere near a shell view; `ls -la` is a
 * shell command and belongs in one.
 *
 * THE LIST COMES FROM THE REGISTRY, never from a hand-written array here. The
 * harness writes one shim per capability GROUP into a directory it puts first on
 * PATH (`registerToolCli`), and `toolCliShimCommands` is the function that
 * decides that list — so what the terminal excludes is exactly what exists as a
 * shim, and a group added tomorrow is excluded without anyone remembering to
 * come back here.
 *
 * The group/tool distinction matters more than it looks: `ls` IS a registered
 * tool, but it lives inside the `file` group and is typed `file ls`. There is no
 * `ls` shim, precisely so the real one still works — which is what lets the user's
 * own example, `ls -la`, be a terminal command rather than a tool call.
 *
 * Deep source import of the PURE registry module (no runtime, no pi SDK) — the
 * same sanctioned seam `activity-mapping.ts` uses for connector-icons and
 * `auto-router.ts` uses for classify/tier.
 */
import { toolCliShimCommands } from '../../../../../packages/harness/src/tools/tool-cli-groups.ts';

/** Every command the tool-CLI installs on PATH (`tools`, plus one per group). */
export const REGISTERED_CLI_COMMANDS: ReadonlySet<string> = new Set(toolCliShimCommands());

/**
 * The program a command line actually runs, or undefined when there isn't one.
 *
 * Deliberately shallow: leading `VAR=value` assignments are skipped (they are
 * environment, not the program) and a path is reduced to its basename
 * (`/usr/bin/ls` is `ls`), but nothing here tries to parse a shell. A pipeline,
 * a subshell or a `cd x && …` reports its FIRST word, which is the right answer
 * for this question — a line that starts by changing directory is a shell line
 * no matter what it goes on to run.
 */
export function firstCommandWord(command: string): string | undefined {
  let rest = command.trim();
  if (rest === '') return undefined;
  // Skip leading environment assignments: `FOO=1 BAR=2 ls`.
  while (true) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(rest);
    if (m === null) break;
    rest = rest.slice(m[0].length);
  }
  const word = rest.split(/\s+/)[0];
  if (word === undefined || word === '') return undefined;
  // Strip a leading path and any quoting the model wrapped the program in.
  const bare = word.replace(/^['"]|['"]$/g, '');
  const seg = bare.split('/').filter(Boolean).pop();
  return seg === undefined || seg === '' ? undefined : seg;
}

/**
 * True when this bash line is really an invocation of a registered CLI tool.
 *
 * The set is injectable for the test; production always uses the registry's own
 * {@link REGISTERED_CLI_COMMANDS}.
 */
export function isRegisteredCliCommand(
  command: string,
  names: ReadonlySet<string> = REGISTERED_CLI_COMMANDS,
): boolean {
  const word = firstCommandWord(command);
  return word !== undefined && names.has(word);
}

/**
 * True when this bash line belongs in the Activity terminal — i.e. it is a real
 * shell command and not one of ours.
 *
 * An empty / whitespace-only command is nothing to show, so it is not a terminal
 * command either: a half-streamed `{"command": "` must not flash an empty prompt.
 */
export function isTerminalCommand(
  command: string,
  names: ReadonlySet<string> = REGISTERED_CLI_COMMANDS,
): boolean {
  if (command.trim() === '') return false;
  return !isRegisteredCliCommand(command, names);
}
