/**
 * Effort-gated REAL verify (harness fix #4).
 *
 * The reviewer pass (review/review.ts) is LLM self-critique only, and is skipped
 * entirely with no utility model — so high/max effort could ship untested code.
 * This module adds a BOUNDED, best-effort REAL verify for coding/file-ops turns:
 * after the model signals completion, run the project's OWN checks (test /
 * typecheck / lint) in the working dir via a bash seam, with a timeout; on
 * failure, feed the output back to the model as a fix steer, bounded to a small
 * effort-scaled iteration count. With no check infra, fall back to a lighter
 * syntax/does-it-parse sanity check on the files the turn touched.
 *
 * Everything that touches the outside world (running commands, reading the
 * project) is injected, so detection + the bounded loop are unit-testable with a
 * fake bash runner. The wiring (index.ts) owns the per-turn fix budget + gating;
 * this module owns detection and the single check run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A resolved check the verify pass can run. */
export interface ProjectCheck {
  /** Full shell command line, run via the bash seam (`sh -c`). */
  readonly command: string;
  readonly kind: 'test' | 'typecheck' | 'lint' | 'build' | 'syntax';
  /** Short human label for telemetry / notifications. */
  readonly label: string;
  /**
   * Treat a ZERO exit as a failure when the output matches this.
   *
   * Exit codes are the right default and are not universal: Godot prints
   * `ERROR: Error parsing 'project.godot' … File might be corrupted` and still
   * exits 0, so an exit-code-only verdict calls an unloadable project fine —
   * the precise trap this whole verify pass exists to close. A check that knows
   * its tool lies about its exit status says so here.
   */
  readonly failIfOutputMatches?: RegExp;
}

/** Outcome of running one check. */
export interface CheckOutcome {
  /** pass = exit 0; fail = ran to completion non-zero; inconclusive = timeout / runner error. */
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Combined stdout+stderr, tail-truncated. */
  readonly output: string;
  readonly command: string;
  readonly kind: ProjectCheck['kind'];
}

/** The bash seam. Returns raw process results; never throws for a non-zero exit. */
export type VerifyBashRunner = (
  command: string,
  opts: { readonly cwd: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}>;

/** Read-only project probe used by detection (repo-relative paths). */
export interface ProjectProbe {
  /** Read a repo-relative text file, or undefined if absent/unreadable. */
  readonly readText: (relPath: string) => string | undefined;
  /** True if a repo-relative path exists. */
  readonly exists: (relPath: string) => boolean;
}

/** Build a {@link ProjectProbe} rooted at a working dir, backed by node:fs. */
export function makeFsProbe(cwd: string): ProjectProbe {
  return {
    readText: (rel) => {
      try {
        return readFileSync(join(cwd, rel), 'utf8');
      } catch {
        return undefined;
      }
    },
    exists: (rel) => {
      try {
        return existsSync(join(cwd, rel));
      } catch {
        return false;
      }
    },
  };
}

/** Detect the package manager from a lockfile (defaults to npm). All support `run`. */
export function detectPackageManager(probe: ProjectProbe): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (probe.exists('pnpm-lock.yaml')) return 'pnpm';
  if (probe.exists('yarn.lock')) return 'yarn';
  if (probe.exists('bun.lockb')) return 'bun';
  return 'npm';
}

// package.json script preference: a real test first, then a typecheck, then lint,
// then build. First present wins.
const SCRIPT_PREFERENCE: readonly { script: string; kind: ProjectCheck['kind'] }[] = [
  { script: 'test', kind: 'test' },
  { script: 'typecheck', kind: 'typecheck' },
  { script: 'type-check', kind: 'typecheck' },
  { script: 'tsc', kind: 'typecheck' },
  { script: 'lint', kind: 'lint' },
  { script: 'build', kind: 'build' },
];

const MAKE_PREFERENCE: readonly { target: string; kind: ProjectCheck['kind'] }[] = [
  { target: 'test', kind: 'test' },
  { target: 'check', kind: 'typecheck' },
  { target: 'lint', kind: 'lint' },
];

function packageJsonCheck(probe: ProjectProbe): ProjectCheck | null {
  const raw = probe.readText('package.json');
  if (raw === undefined) return null;
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return null;
  }
  const pm = detectPackageManager(probe);
  for (const { script, kind } of SCRIPT_PREFERENCE) {
    if (typeof scripts[script] === 'string' && (scripts[script] as string).length > 0) {
      return { command: `${pm} run ${script}`, kind, label: `${pm} run ${script}` };
    }
  }
  return null;
}

function makefileCheck(probe: ProjectProbe): ProjectCheck | null {
  const raw = probe.readText('Makefile') ?? probe.readText('makefile');
  if (raw === undefined) return null;
  for (const { target, kind } of MAKE_PREFERENCE) {
    // A target definition is `name:` at the start of a line.
    if (new RegExp(`^${target}\\s*:`, 'm').test(raw)) {
      return { command: `make ${target}`, kind, label: `make ${target}` };
    }
  }
  return null;
}

function pythonPytestConfigured(probe: ProjectProbe): boolean {
  if (probe.exists('pytest.ini') || probe.exists('tox.ini')) return true;
  const pyproject = probe.readText('pyproject.toml');
  if (pyproject !== undefined && /\[tool\.pytest/.test(pyproject)) return true;
  const setupCfg = probe.readText('setup.cfg');
  if (setupCfg !== undefined && /\[tool:pytest\]/.test(setupCfg)) return true;
  return false;
}

/**
 * Detect the best available PROJECT check for the working dir, or null when no
 * check infrastructure is present. Ordered: JS/TS scripts → Makefile → Rust → Go
 * → Python(pytest). Pure over the injected {@link ProjectProbe}.
 */
export function detectProjectCheck(probe: ProjectProbe): ProjectCheck | null {
  return (
    packageJsonCheck(probe) ??
    makefileCheck(probe) ??
    (probe.exists('Cargo.toml')
      ? { command: 'cargo check', kind: 'typecheck', label: 'cargo check' }
      : null) ??
    (probe.exists('go.mod')
      ? { command: 'go build ./...', kind: 'build', label: 'go build ./...' }
      : null) ??
    (pythonPytestConfigured(probe)
      ? { command: 'python3 -m pytest -q', kind: 'test', label: 'pytest' }
      : null) ??
    godotCheck(probe)
  );
}

/**
 * A Godot project's own check: does the engine load it?
 *
 * MEASURED, from a corp run that built a Godot sample: no package.json, no
 * Makefile, no Cargo.toml — so nothing here matched, no check ran, and the only
 * "verification" in the record was the engineer's own shell line:
 *
 *   godot --headless --quit --path . > out.txt 2>&1 && grep -i error out.txt \
 *     || echo "No errors found in log."
 *
 * That parses as `(A && B) || C`, so it prints "No errors found in log." when
 * the check passes, when grep matches nothing, AND when godot itself fails or is
 * killed. Success and failure are the same string. The contract was discharged
 * on it while project.godot was still unparseable.
 *
 * Running it here instead means the OUTCOME is an exit code the harness read,
 * not a sentence an agent wrote about a command it chose.
 *
 * `2>&1` matters and is not decoration: Godot writes parse errors to stderr and
 * can still exit 0, so an exit code alone would call a broken project fine.
 */
function godotCheck(probe: ProjectProbe): ProjectCheck | null {
  if (!probe.exists('project.godot')) return null;
  return {
    // --quit exits after the first frame. It can still WEDGE on a malformed
    // project rather than erroring out — measured: a corrupt project.godot hung
    // past 180s — which is exactly why runCheck's timeout reports `inconclusive`
    // rather than letting a hang read as a pass.
    command: 'godot --headless --quit --path . 2>&1',
    kind: 'build',
    label: 'godot --headless --quit',
    // The two Godot emits for an unloadable project, both on stderr, both with
    // exit 0. Taken verbatim from the run's own log:
    //   ERROR: Error parsing '…/project.godot' at line 0: Unterminated string
    //   ERROR: Couldn't load file '…/project.godot', error code 43.
    failIfOutputMatches: /^\s*(ERROR|SCRIPT ERROR):/m,
  };
}

/** Single-quote a path for `sh -c` (escapes embedded quotes). */
function shQuote(p: string): string {
  /*
   * EXPAND ~ BEFORE QUOTING. Quoting is right — a path can contain spaces — but
   * a tilde inside single quotes is never expanded by the shell, so a path the
   * model wrote as `~/x/app.py` becomes a literal directory named "~".
   *
   * MEASURED: the syntax check ran
   *   python3 -m py_compile '~/bobble-testbed/buggyapp/app.py'
   * which failed with "No such file or directory", and the harness reported its
   * OWN broken command to the model as a code failure. The model diagnosed it
   * correctly — "I don't control the check's arguments, I control the file
   * content" — and was then sent to fix code that was not broken, burning the
   * verify budget on a phantom.
   *
   * Only a LEADING ~/ is a home reference; a tilde anywhere else is a literal
   * character in a filename and must survive untouched.
   */
  const expanded = p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p;
  return `'${expanded.replace(/'/g, `'\\''`)}'`;
}

/**
 * A lighter "does it parse" sanity check over the files a turn touched, used when
 * no project check infra exists. Handles Python (py_compile) and plain Node JS
 * (node --check); returns null for anything a bare parser can't sanity-check
 * (e.g. TS/JSX — those rely on the project's own typecheck, handled above).
 */
export function syntaxCheckCommand(touchedFiles: readonly string[]): ProjectCheck | null {
  const py = touchedFiles.filter((f) => /\.py$/i.test(f));
  if (py.length > 0) {
    return {
      command: `python3 -m py_compile ${py.map(shQuote).join(' ')}`,
      kind: 'syntax',
      label: `py_compile (${py.length} file${py.length === 1 ? '' : 's'})`,
    };
  }
  const js = touchedFiles.find((f) => /\.(c|m)?js$/i.test(f));
  if (js !== undefined) {
    return { command: `node --check ${shQuote(js)}`, kind: 'syntax', label: `node --check` };
  }
  return null;
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…(${text.length - maxChars} chars elided)…\n${text.slice(text.length - maxChars)}`;
}

/** Default verify timeout: generous enough for a real check, bounded so it can't wedge. */
export const VERIFY_TIMEOUT_MS = 60_000;

/** Run a single resolved check. Fail-open: a timeout or runner error is inconclusive. */
export async function runCheck(
  runBash: VerifyBashRunner,
  check: ProjectCheck,
  opts: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly maxOutputChars?: number;
  },
): Promise<CheckOutcome> {
  const maxOutputChars = opts.maxOutputChars ?? 4000;
  let res: Awaited<ReturnType<VerifyBashRunner>>;
  try {
    res = await runBash(check.command, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? VERIFY_TIMEOUT_MS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    return {
      status: 'inconclusive',
      exitCode: null,
      timedOut: false,
      output: truncateTail(`verify runner error: ${String(err)}`, maxOutputChars),
      command: check.command,
      kind: check.kind,
    };
  }
  const timedOut = res.timedOut === true;
  const output = truncateTail(`${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim(), maxOutputChars);
  // A zero exit is not proof for every tool. When a check declares the shape of
  // its own lie, an otherwise-passing run that matches it is a FAIL — checked
  // against the combined stdout+stderr, because the tools that do this are
  // exactly the ones that report on stderr while exiting 0.
  const lies = check.failIfOutputMatches !== undefined && check.failIfOutputMatches.test(output);
  const status: CheckOutcome['status'] = timedOut
    ? 'inconclusive'
    : res.exitCode === 0
      ? lies
        ? 'fail'
        : 'pass'
      : 'fail';
  return {
    status,
    exitCode: res.exitCode,
    timedOut,
    output,
    command: check.command,
    kind: check.kind,
  };
}

/** Inputs to one verify pass (detect + run). */
export interface VerifyPassDeps {
  readonly cwd: string;
  readonly runBash: VerifyBashRunner;
  /** Detect the project check for a working dir (injected so tests can stub it). */
  readonly detectCheck: (cwd: string) => ProjectCheck | null;
  /** Files the turn wrote/edited, used for the syntax fallback when no infra exists. */
  readonly touchedFiles?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputChars?: number;
}

/** Result of one verify pass. `check` is null when there was nothing to run. */
export interface VerifyPassResult {
  readonly check: ProjectCheck | null;
  readonly outcome: CheckOutcome | null;
}

/**
 * Run one verify pass: pick a project check (or a syntax fallback over the touched
 * files), run it, and return the outcome. No steering / budget logic here — the
 * caller decides what to do with a `fail`.
 */
/**
 * DID THIS TURN ACTUALLY RUN WHAT IT WROTE?
 *
 * Measured across five runs given "fix it and make sure it works": the model
 * edits code, reasons carefully about the edits, and never executes the result
 * — then reports success. Telling it to commission a tester did not change that
 * (the guidance is in the capability prompt and went unused every time), which
 * is the usual finding here: a check the model must DECIDE to run is a check
 * that does not get run.
 *
 * So state the fact instead. A turn that wrote executable code and issued no
 * command that mentions any of it has not been exercised, whatever the reply
 * says. Deliberately narrow — it asks only whether the written files were named
 * in something that ran, which is the weakest claim that is still worth making,
 * and it stays silent for prose, config, docs and data.
 */
const EXECUTABLE = /\.(py|js|mjs|cjs|ts|tsx|sh|rb|go|rs)$/i;

export function neverExercised(
  touchedFiles: readonly string[],
  ranCommands: readonly string[],
  delegated = false,
): string | null {
  const code = touchedFiles.filter((f) => EXECUTABLE.test(f));
  if (code.length === 0) return null;
  /*
   * A DELEGATE'S COMMANDS ARE STILL COMMANDS.
   *
   * MEASURED, and the irony is exact: this steer's own text recommends handing
   * the work to `spawn_subagent` with specialist:"tester". A run took that
   * advice — the subagent drove the app, captured seven output files to
   * `_testrun/`, and reported back — and because a subagent's bash calls never
   * touch the PARENT's `ranCommands`, the only command this saw was a lone
   * `chmod +x`. So the harness told the model it "never ran any of it" after it
   * did exactly what the harness asked, spent a fix from the turn's budget on a
   * false accusation, and shadowed the README check that would have run next.
   *
   * The parent cannot see inside a child, so delegation is treated as exercise.
   * That is deliberately generous: the failure mode of being wrong here is one
   * missed reminder, and the failure mode of the old behaviour was actively
   * punishing the right move.
   */
  if (delegated) return null;
  const ran = ranCommands.join('\n');
  const exercised = code.some((f) => {
    const base = f.split(/[\\/]/).pop() ?? f;
    const stem = base.replace(/\.[^.]+$/, '');
    return ran.includes(base) || (stem.length > 2 && ran.includes(stem));
  });
  if (exercised) return null;
  const names = code.slice(0, 4).map((f) => f.split(/[\\/]/).pop() ?? f);
  return (
    `You wrote ${names.join(', ')}${code.length > 4 ? ` and ${code.length - 4} more` : ''} ` +
    'and never ran any of it. Nothing here has been executed, so "it works" is a guess. ' +
    'Run it the way the user would — or hand it to spawn_subagent with specialist:"tester", ' +
    'which works out how to drive it and comes back with screenshots and the failures.'
  );
}

/**
 * OUTPUTS THAT ARE EMPTY.
 *
 * MEASURED, and it is the sharpest evidence in the whole cycle: a turn asked to
 * fix a converter RAN the conversions, produced sample.md, sample.txt and
 * sample.json — 0, 0 and 2 bytes — and reported success. One of the planted
 * bugs was literally "csv→md writes an empty file". It generated the proof and
 * never opened it.
 *
 * `neverExercised` cannot catch this: something DID run. The stronger property
 * is whether anything looked at what came back, and an empty artifact is
 * checkable without knowing the domain — a conversion, a render, a build or an
 * export that yields nothing is wrong in every one of them.
 *
 * Only files this turn actually WROTE, so a repo full of legitimately empty
 * placeholders is not dragged in, and only ones that are truly zero-length,
 * which is never a deliberate result of producing something.
 */
export function emptyOutputs(
  writtenFiles: readonly string[],
  sizeOf: (p: string) => number | null,
): string | null {
  const empty = writtenFiles.filter((f) => sizeOf(f) === 0);
  if (empty.length === 0) return null;
  const names = empty.slice(0, 4).map((f) => f.split(/[\\/]/).pop() ?? f);
  return (
    `${names.join(', ')}${empty.length > 4 ? ` and ${empty.length - 4} more` : ''} ` +
    `${empty.length === 1 ? 'is' : 'are'} EMPTY — zero bytes. Something produced ` +
    `${empty.length === 1 ? 'it' : 'them'} and nothing opened ` +
    `${empty.length === 1 ? 'it' : 'them'} afterwards. A file of the right name with no ` +
    'content is the cheapest way for work to look finished. Open each one, confirm what is ' +
    'actually inside, and fix whatever produced an empty result.'
  );
}

export async function runVerifyPass(deps: VerifyPassDeps): Promise<VerifyPassResult> {
  const check = deps.detectCheck(deps.cwd) ?? syntaxCheckCommand(deps.touchedFiles ?? []);
  if (check === null) return { check: null, outcome: null };
  const outcome = await runCheck(deps.runBash, check, {
    cwd: deps.cwd,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.maxOutputChars !== undefined ? { maxOutputChars: deps.maxOutputChars } : {}),
  });
  return { check, outcome };
}

/** Minimal `pi.exec`-shaped seam (command + argv + options → result). */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/** Build a {@link VerifyBashRunner} that runs a command string via `sh -c` through pi.exec. */
export function makeExecBashRunner(exec: ExecLike): VerifyBashRunner {
  return async (command, opts) => {
    const res = await exec('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return {
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      // pi.exec reports killed=true on timeout/abort → inconclusive, not a real fail.
      timedOut: res.killed,
    };
  };
}
