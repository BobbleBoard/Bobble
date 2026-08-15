/**
 * Parse a file the way its language would, BEFORE it lands on disk.
 *
 * Extracted from sandbox-fs so the CORP ROLES can use it too. That is the whole
 * reason this file exists: the check lived inside the harness EXTENSION, which
 * only the main chat's pi child loads, so the four agents that write nearly all
 * of the code — the corp roles, built with `createAgentSession` — had pi's
 * unfenced built-in `write` and were never parsed. Run 15 shipped 4,709 lines
 * with five files that do not compile.
 *
 * ZERO DEPENDENCIES beyond node, deliberately: `role-agent.ts` must not
 * value-import the pi barrel, so anything it shares has to be importable on its
 * own. See the `./tools/syntax-check` subpath in package.json.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A node we can actually reach, rather than one we hope is on PATH.
 *
 * THE GAP THIS CLOSES, found in run 4 the hour after the check shipped. A pi
 * child inherits the GUI app's PATH, and a launchd-started macOS app gets
 * `/usr/bin:/bin:/usr/sbin:/sbin`. `python3` lives there. `node` does not — it is
 * in /usr/local/bin or a version manager. So `spawnSync('node', …)` failed to
 * launch, `status` came back null, the "parser not installed" skip fired, and
 * JavaScript was never checked at all.
 *
 * This process is ALREADY a node (pi runs on Electron-as-node), so
 * `process.execPath` is a runtime that exists by definition.
 */
function nodeBinary(): string {
  return process.execPath;
}

/** Reported-once set, so "no check ran" is never silent. */
const skipReported = new Set<string>();

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
 * The real runner. ELECTRON_RUN_AS_NODE is required because the binary being
 * spawned is `process.execPath` — our own runtime — and we want it to behave as
 * node rather than start an app. Harmless under a plain node, which ignores it.
 */
export const defaultRunSyntaxCheck: RunSyntaxCheck = (cmd, target) => {
  const res = spawnSync(cmd[0] ?? '', [...cmd.slice(1), target], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return { status: res.status, stderr: `${res.stderr ?? ''}${res.stdout ?? ''}` };
};
