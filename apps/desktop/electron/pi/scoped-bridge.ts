/**
 * A PI CHILD THE APP OWNS, CONFIGURED ONCE.
 *
 * Every non-chat pi the app spawns — a subagent or corp role
 * (`createChildBridge`), a headless scheduled run (`createScheduledRunBridge`)
 * and, from BH-6, the scoped Bobble help pi — shares one base: sessionless,
 * our own `-e` extensions and nothing auto-discovered, its own process group,
 * the same kill grace, the bundled pi. Only the environment on top of the chat's
 * and, for help, the extension list differ. This is that base as a pure
 * function, so the three cannot drift apart and the shape is testable without
 * Electron (deliverables/research/PLAN.md §2.3: `createScopedPiBridge`,
 * extracted from `createChildBridge`).
 */
import type { PiBridgeOptions } from '@pi-desktop/engine/main';

/**
 * `--no-extensions`: only our bundled `-e` extensions, never pi's auto-discovered
 * `~/.pi/agent/extensions`. `--no-skills`: no global `~/.pi/agent/skills` leaking
 * into the prompt. Same discipline as the main chat bridge (pi-main.ts).
 */
export const SCOPED_PI_ARGS: readonly string[] = ['--no-extensions', '--no-skills'];

export interface ScopedPiBridgeOptions {
  /** Keys on top of the chat's environment (`buildPiEnv`), which they override. */
  readonly env?: Record<string, string | undefined>;
  /** The `-e` extensions; the app's full set when absent. */
  readonly extensionPaths?: readonly string[];
  /** Resume a session instead of running sessionless (`--no-session`, the default). */
  readonly sessionPath?: string;
}

export interface ScopedPiBase {
  /** The resolved working folder (undefined only when none could be made). */
  readonly cwd: string | undefined;
  /** The chat's environment for that folder (`buildPiEnv(cwd)`). */
  readonly env: Record<string, string | undefined>;
  readonly extensionPaths: readonly string[];
  readonly killGraceMs: number;
  readonly appRoot: string;
}

export function scopedPiBridgeOptions(
  base: ScopedPiBase,
  opts: ScopedPiBridgeOptions = {},
): PiBridgeOptions {
  return {
    cwd: base.cwd,
    env: { ...base.env, ...opts.env },
    ...(opts.sessionPath !== undefined ? { sessionPath: opts.sessionPath } : { noSession: true }),
    extensionPaths: [...(opts.extensionPaths ?? base.extensionPaths)],
    extraArgs: [...SCOPED_PI_ARGS],
    killGraceMs: base.killGraceMs,
    detached: true,
    appRoot: base.appRoot,
  };
}
